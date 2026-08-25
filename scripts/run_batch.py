#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量并行 DiffTest runner + 三级看门狗。设计文档: docs/workflow-detailed.md「执行层与看门狗」。

职责(执行层, 两个问题共用的地基):
  1. 并行: 全局槽位(flock, 跨进程/跨 agent 共享, RB_SLOTS 默认 8)并发跑 emu,
     每 emu 实测占 1 核, 12 核机器并发 8-10 路近线性加速。
  2. 止损: 三级看门狗
     - 第 0 级: 每 run 强制 -C 周期上限 + 墙钟上限(兜底);
     - 第 1 级: 绊线(纯脚本, 8s 轮询) —— SPIN(重复 pc 且写回值无进展)/
       RUNAWAY(pc 越出可执行段)/ STALL(CPU 在烧但无新退休)。误判防线:
       POLL_ 标签白名单、写回值进展检查、两轮滞回、FAIL 自环单列为 SELF_TEST_FAIL。
       触发即 SIGINT 体面杀(write-back 语义: 先杀住, 槽位让给下一个),
       证据打包 + 挂死签名匹配, runs.jsonl 里标 review=pending 等复核(一杀一审,
       复核由调用方 agent 立即执行, 见 workflow prompt)。
  3. 证据: 每次运行追加一条结构化记录到 artifacts/runs.jsonl(运行数据库),
     并在输出目录写 summary.tsv。挂死签名库: hypotheses/hang-signatures.json。

用法:
  scripts/run_batch.py -o <outdir> case1.S case2.S ... [case3.elf]
  常用: -j 并行度(默认8) -C 周期上限(默认120000) --wall 墙钟秒(默认600)
        --priority(误杀重跑插队, 允许用保留槽位0) --meta k=v(打进记录)
        --wave --begin N --end N(重放取波形; 平时禁用波形)
  用例内嵌元数据(进 runs.jsonl 的 meta 字段): 汇编注释行 "#meta: sew=32 lmul=1 ..."
  终态语义(verdict): GOODTRAP | ABORT | SELF_TEST_FAIL | CYCLE_CAP | WALL_TIMEOUT
        | KILLED_SPIN | KILLED_STALL | KILLED_RUNAWAY | COMPILE_ERROR | UNKNOWN
  KILLED_*/CYCLE_CAP/WALL_TIMEOUT 是"机检初判", review=pending, 调用方必须一杀一审。
"""

import argparse, fcntl, hashlib, json, os, re, shlex, signal, subprocess, sys, time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EMU = os.environ.get("EMU", os.path.join(REPO, "xiangshan/build/emu"))
REF = os.environ.get("REF", os.path.join(REPO, "xiangshan/ready-to-run/riscv64-nemu-interpreter-so"))
LINKER = os.environ.get("LINKER", os.path.join(REPO, "templates/xiangshan.ld"))
RUNS_DB = os.path.join(REPO, "artifacts/runs.jsonl")
SIG_DB = os.path.join(REPO, "hypotheses/hang-signatures.json")
SLOT_DIR = os.path.join(REPO, "artifacts/.slots")
N_SLOTS = int(os.environ.get("RB_SLOTS", "8"))
# bootrom 阶段(跳到 0x80000000 之前)的合法执行区间
BOOTROM = (0x10000000, 0x10010000)

ANSI = re.compile(r"\x1b\[[0-9;]*m")
COMMIT_RE = re.compile(
    r"\[\s*\d+\]\s+commit pc\s+([0-9a-f]+)\s+inst\s+([0-9a-f]+)\s+wen\s+([01])"
    r"\s+dst\s+([0-9a-f]+)\s+data\s+([0-9a-f]+)")
DIVERGE_RE = re.compile(
    r"(\S+)\s+different at pc\s*=\s*0x([0-9a-f]+),\s*right\s*=\s*0x([0-9a-f]+),"
    r"\s*wrong\s*=\s*0x([0-9a-f]+)")
STAT_RE = re.compile(r"instrCnt\s*=\s*([\d,]+),\s*cycleCnt\s*=\s*([\d,]+)")
HOSTMS_RE = re.compile(r"Host time spent:\s*([\d,]+)ms")


def log(msg):
    print(f"[run-batch] {msg}", flush=True)


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def find_cross():
    r = sh(["bash", "-c",
            f'TOOLCHAIN_QUIET=1 source "{REPO}/scripts/toolchain.sh"; printf %s "$CROSS"'])
    cross = r.stdout.strip()
    if not cross:
        sys.exit("[run-batch] 未找到 RVV 交叉编译器(scripts/toolchain.sh)")
    return cross


def tool_from_cross(cross, name):
    cand = re.sub(r"gcc$", name, cross)
    return cand if os.path.exists(cand) else None


class Elf:
    """ELF 侧的静态信息: 可执行段范围 + 符号表(pc->符号, POLL_ 白名单, FAIL 定位)"""

    def __init__(self, path, cross):
        self.path = path
        self.exec_ranges: list = [BOOTROM]
        self.symbols = []  # (addr, name) 升序
        readelf = tool_from_cross(cross, "readelf") or "readelf"
        r = sh([readelf, "-S", "-W", path])
        for m in re.finditer(
                r"\]\s+(\S+)\s+\S+\s+([0-9a-f]+)\s+[0-9a-f]+\s+([0-9a-f]+)\s+\S+\s+(\S+)",
                r.stdout):
            _name, addr, size, flags = m.groups()
            if "X" in flags:
                a = int(addr, 16)
                self.exec_ranges.append((a, a + int(size, 16)))
        nm = tool_from_cross(cross, "nm")
        if nm:
            r = sh([nm, path])
            for line in r.stdout.splitlines():
                p = line.split()
                if len(p) == 3 and re.fullmatch(r"[0-9a-f]+", p[0]):
                    self.symbols.append((int(p[0], 16), p[2]))
            self.symbols.sort()

    def in_exec(self, pc):
        return any(lo <= pc < hi for lo, hi in self.exec_ranges)

    def sym(self, pc):
        best = None
        for addr, name in self.symbols:
            if addr <= pc:
                best = (addr, name)
            else:
                break
        if best is None:
            return f"0x{pc:x}"
        off = pc - best[0]
        return best[1] if off == 0 else f"{best[1]}+0x{off:x}"


class Slots:
    """全局仿真槽位: artifacts/.slots/slot<i>.lock 上 flock, 跨进程共享。
    槽位 0 保留给 --priority(误杀重跑插队), 普通请求用 1..N-1。"""

    def __init__(self):
        os.makedirs(SLOT_DIR, exist_ok=True)

    def acquire(self, priority=False):
        ids = list(range(0, N_SLOTS)) if priority else list(range(1, N_SLOTS))
        while True:
            for i in ids:
                fd = os.open(os.path.join(SLOT_DIR, f"slot{i}.lock"),
                             os.O_CREAT | os.O_RDWR, 0o644)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return fd
                except OSError:
                    os.close(fd)
            time.sleep(0.5)

    @staticmethod
    def release(fd):
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def load_signatures():
    try:
        with open(SIG_DB) as f:
            return json.load(f)
    except Exception:
        return []


def match_signature(sigs, verdict, locus):
    """签名匹配: verdict_re 匹配终态, locus_re 匹配符号化停驻位置串。命中返回 id。"""
    for s in sigs:
        m = s.get("match", {})
        try:
            if re.search(m.get("verdict_re", ""), verdict) and \
               re.search(m.get("locus_re", ""), locus):
                return s["id"]
        except re.error:
            continue
    return None


def parse_meta(src_path):
    meta = {}
    try:
        with open(src_path, errors="replace") as f:
            for line in f:
                m = re.match(r"\s*#\s*meta:\s*(.+)", line)
                if m:
                    for tok in shlex.split(m.group(1)):
                        if "=" in tok:
                            k, v = tok.split("=", 1)
                            meta[k] = v
    except OSError:
        pass
    return meta


def append_db(record):
    os.makedirs(os.path.dirname(RUNS_DB), exist_ok=True)
    with open(RUNS_DB, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
        fcntl.flock(f, fcntl.LOCK_UN)


def proc_cpu_seconds(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            fields = f.read().rsplit(")", 1)[1].split()
        return (int(fields[11]) + int(fields[12])) / os.sysconf("SC_CLK_TCK")
    except (OSError, IndexError, ValueError):
        return None


class Watchdog:
    """第 1 级绊线。轮询日志增量 + /proc CPU 时间, 机械分类, 两轮滞回。"""

    def __init__(self, args, elf):
        self.args, self.elf = args, elf
        self.commits = deque(maxlen=96)
        self.total_commits = 0
        self.last_commit_wall = time.monotonic()
        self.last_cpu = 0.0
        self.cpu_busy_nocommit = 0.0   # 无新提交期间累积的 CPU 秒
        self.trips = {"spin": 0, "stall": 0}
        self.terminal_seen = False

    def feed(self, chunk):
        n_new = 0
        for line in chunk.splitlines():
            m = COMMIT_RE.search(line)
            if m:
                pc, inst, wen, dst, data = m.groups()
                self.commits.append((int(pc, 16), inst, wen, dst, data))
                n_new += 1
            elif ("HIT GOOD TRAP" in line or "ABORT at pc" in line
                  or "EXCEEDING CYCLE/INSTR LIMIT" in line):
                self.terminal_seen = True
        if n_new:
            self.total_commits += n_new
            self.last_commit_wall = time.monotonic()
        return n_new

    def check(self, pid, n_new):
        """返回 (reason, stop_pc) 或 None。reason: spin|runaway|stall|self_test_fail"""
        if self.terminal_seen:
            return None
        # RUNAWAY: 单轮即判(合法用例不会执行到可执行段之外)
        for pc, *_ in list(self.commits)[-max(n_new, 1):]:
            if not self.elf.in_exec(pc):
                return ("runaway", pc)
        # SPIN: 窗口内 pc 种类少且写回值无进展
        if len(self.commits) >= 48 and n_new > 0:
            window = list(self.commits)[-64:]
            pcs = {c[0] for c in window}
            if len(pcs) <= 8:
                data_per_pc = {}
                for pc, _i, wen, _d, data in window:
                    if wen == "1":
                        data_per_pc.setdefault(pc, set()).add(data)
                progressing = any(len(v) > 1 for v in data_per_pc.values())
                syms = {self.elf.sym(pc).split("+")[0] for pc in pcs}
                if not progressing and not any(s.startswith("POLL_") for s in syms):
                    self.trips["spin"] += 1
                    if self.trips["spin"] >= 2:
                        stop = window[-1][0]
                        if "FAIL" in syms:
                            return ("self_test_fail", stop)
                        return ("spin", stop)
                else:
                    self.trips["spin"] = 0
            else:
                self.trips["spin"] = 0
        # STALL: CPU 在烧但无新退休
        cpu = proc_cpu_seconds(pid)
        if cpu is not None:
            dcpu = cpu - self.last_cpu
            self.last_cpu = cpu
            if n_new == 0 and self.total_commits > 0 and dcpu > 0.5 * self.args.poll:
                self.cpu_busy_nocommit += dcpu
                if self.cpu_busy_nocommit >= self.args.stall_sec:
                    self.trips["stall"] += 1
                    if self.trips["stall"] >= 2:
                        stop = self.commits[-1][0] if self.commits else 0
                        return ("stall", stop)
            else:
                self.cpu_busy_nocommit = 0.0
                self.trips["stall"] = 0
        return None


def run_one(case, args, cross, slots, signatures):
    name = os.path.splitext(os.path.basename(case))[0]
    outdir = args.outdir
    os.makedirs(outdir, exist_ok=True)
    rec = {"ts": datetime.now().isoformat(timespec="seconds"), "case": os.path.relpath(case, REPO),
           "out": os.path.relpath(outdir, REPO), "verdict": "UNKNOWN", "cycles": None,
           "instrs": None, "host_ms": None, "stop_pc": None, "stop_sym": None,
           "divergence": [], "sig": None, "sig_id": None, "known_hang": None,
           "meta": dict(args.meta), "watchdog": None, "review": None, "log": None}

    # ---- 编译(.S)或直接使用(.elf) ----
    if case.endswith(".elf"):
        elf_path = case
    else:
        rec["meta"].update(parse_meta(case))
        elf_path = os.path.join(outdir, name + ".elf")
        r = sh([cross, "-nostdlib", "-nostartfiles", "-static", "-fno-pic",
                f"-march={args.march}", "-mabi=lp64d", "-T", LINKER,
                "-o", elf_path, case])
        if r.returncode != 0:
            rec["verdict"] = "COMPILE_ERROR"
            rec["log"] = os.path.relpath(os.path.join(outdir, name + ".compile.log"), REPO)
            with open(os.path.join(REPO, rec["log"]), "w") as f:
                f.write(r.stderr)
            append_db(rec)
            return rec
    rec["elf"] = os.path.relpath(elf_path, REPO)
    elf = Elf(elf_path, cross)

    log_path = os.path.join(outdir, name + ".log")
    rec["log"] = os.path.relpath(log_path, REPO)
    cmd = ["stdbuf", "-oL", EMU, "-b", str(args.begin), "-e", str(args.end),
           "--dump-commit-trace", "-C", str(args.max_cycles),
           "-i", elf_path, "--diff", REF]
    if args.wave:
        cmd += ["--dump-wave", "--wave-path", os.path.join(outdir, name + ".vcd")]
    if args.emu_args:
        cmd += shlex.split(args.emu_args)

    slot = slots.acquire(priority=args.priority)
    killed = None
    t0 = time.monotonic()
    try:
        wd = Watchdog(args, elf)
        with open(log_path, "wb") as logf:
            proc = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT, cwd=REPO)
            rf = open(log_path, "r", errors="replace")
            try:
                while proc.poll() is None:
                    time.sleep(args.poll)
                    n_new = wd.feed(rf.read())
                    if time.monotonic() - t0 > args.wall:
                        killed = ("wall_timeout", wd.commits[-1][0] if wd.commits else 0)
                    elif not args.no_watchdog:
                        killed = wd.check(proc.pid, n_new)
                    if killed:
                        proc.send_signal(signal.SIGINT)
                        try:
                            proc.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                            proc.wait()
                        break
                wd.feed(rf.read())
            finally:
                rf.close()
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
    finally:
        slots.release(slot)

    # ---- 终态判定 ----
    with open(log_path, errors="replace") as f:
        text = ANSI.sub("", f.read())
    m = STAT_RE.search(text)
    if m:
        rec["instrs"] = int(m.group(1).replace(",", ""))
        rec["cycles"] = int(m.group(2).replace(",", ""))
    m = HOSTMS_RE.search(text)
    if m:
        rec["host_ms"] = int(m.group(1).replace(",", ""))
    for dm in DIVERGE_RE.finditer(text):
        rec["divergence"].append({"reg": dm.group(1), "pc": "0x" + dm.group(2),
                                  "ref": "0x" + dm.group(3), "dut": "0x" + dm.group(4)})
    if wd.commits:
        stop_pc = wd.commits[-1][0]
        rec["stop_pc"], rec["stop_sym"] = f"0x{stop_pc:x}", elf.sym(stop_pc)

    # 证据打包 + 签名(review=pending 终态与 SELF_TEST_FAIL 共用; 后者虽免复核,
    # 证据包仍是分析自检失败的现成输入)。
    # 签名 locus 用符号名去偏移 —— 同根因的不同变体停驻偏移常不同(代码长度不同),
    # 去偏移后才能同签名合并审理(MSHR 语义); 精确偏移仍在 evidence 的 last_commits 里。
    def attach_evidence(reason):
        locus = ",".join(sorted({elf.sym(c[0]).split("+")[0]
                                 for c in list(wd.commits)[-16:]}))
        rec["sig"] = f"{rec['verdict']}@{locus}"
        rec["sig_id"] = hashlib.sha1(rec["sig"].encode()).hexdigest()[:8]
        rec["known_hang"] = match_signature(signatures, rec["verdict"], rec["sig"])
        rec["review"] = "pending"
        rec["watchdog"] = {"reason": reason, "poll_s": args.poll,
                           "stall_sec": args.stall_sec, "total_commits": wd.total_commits}
        ev = {"reason": reason, "sig": rec["sig"], "known_hang": rec["known_hang"],
              "stop_pc": rec["stop_pc"], "stop_sym": rec["stop_sym"],
              "last_commits": [
                  {"pc": f"0x{c[0]:x}", "sym": elf.sym(c[0]), "inst": c[1],
                   "wen": c[2], "dst": c[3], "data": c[4]} for c in list(wd.commits)[-64:]],
              "log_tail": text.splitlines()[-120:]}
        with open(os.path.join(outdir, name + ".evidence.json"), "w") as f:
            json.dump(ev, f, ensure_ascii=False, indent=1)

    if "HIT GOOD TRAP" in text:
        rec["verdict"] = "GOODTRAP"
    elif "ABORT at pc" in text:
        rec["verdict"] = "ABORT"
    elif "EXCEEDING CYCLE/INSTR LIMIT" in text:
        rec["verdict"] = "CYCLE_CAP"
        attach_evidence("cycle_cap")
    elif killed:
        reason, stop = killed
        rec["verdict"] = {"spin": "KILLED_SPIN", "stall": "KILLED_STALL",
                          "runaway": "KILLED_RUNAWAY", "wall_timeout": "WALL_TIMEOUT",
                          "self_test_fail": "SELF_TEST_FAIL"}[reason]
        if rec["stop_pc"] is None:
            # 优先保留杀后 flush 出的最新提交算出的停驻点(比杀决时刻的快照更新)
            rec["stop_pc"], rec["stop_sym"] = f"0x{stop:x}", elf.sym(stop)
        attach_evidence(reason)
        if rec["verdict"] == "SELF_TEST_FAIL":
            rec["review"] = None  # FAIL 自环是确定结论, 无需复核
    append_db(rec)
    return rec


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cases", nargs="+", help=".S 或 .elf 文件列表")
    ap.add_argument("-o", "--outdir", required=True)
    ap.add_argument("-j", "--jobs", type=int, default=8)
    ap.add_argument("-C", "--max-cycles", type=int, default=120000)
    ap.add_argument("--wall", type=int, default=600, help="单 run 墙钟上限(秒)")
    ap.add_argument("--poll", type=float, default=8.0, help="看门狗轮询间隔(秒)")
    ap.add_argument("--stall-sec", type=float, default=20.0,
                    help="无新退休但 CPU 忙的累计秒数阈值")
    ap.add_argument("--priority", action="store_true", help="误杀重跑插队(可用保留槽位)")
    ap.add_argument("--no-watchdog", action="store_true")
    ap.add_argument("--wave", action="store_true", help="重放取波形(配 --begin/--end)")
    ap.add_argument("--begin", type=int, default=0)
    ap.add_argument("--end", type=int, default=1 << 30)
    ap.add_argument("--march", default="rv64gcv")
    ap.add_argument("--emu-args", default="")
    ap.add_argument("--meta", action="append", default=[],
                    help="k=v, 打进每条 runs.jsonl 记录")
    args = ap.parse_args()
    args.meta = dict(kv.split("=", 1) for kv in args.meta)
    args.outdir = os.path.abspath(args.outdir)

    cross = find_cross()
    slots = Slots()
    signatures = load_signatures()
    cases = [os.path.abspath(c) for c in args.cases]
    for c in cases:
        if not os.path.exists(c):
            sys.exit(f"[run-batch] 找不到用例: {c}")
    log(f"{len(cases)} 个用例, 本地并行 {args.jobs}, 全局槽位 {N_SLOTS}(RB_SLOTS), "
        f"-C {args.max_cycles}, wall {args.wall}s")

    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        results = list(ex.map(lambda c: run_one(c, args, cross, slots, signatures), cases))

    # ---- summary ----
    cols = ["case", "verdict", "cycles", "instrs", "host_ms", "stop_sym", "known_hang", "review"]
    tsv = os.path.join(args.outdir, "summary.tsv")
    with open(tsv, "w") as f:
        f.write("\t".join(cols) + "\n")
        for r in results:
            f.write("\t".join(str(r.get(k) if r.get(k) is not None else "-") for k in cols) + "\n")
    log(f"summary: {tsv}; 运行数据库: {os.path.relpath(RUNS_DB, os.getcwd())}")
    w = max(len(os.path.basename(r["case"])) for r in results) + 2
    for r in results:
        div = f" first-div: {r['divergence'][0]['reg']} ref={r['divergence'][0]['ref']} dut={r['divergence'][0]['dut']}" if r["divergence"] else ""
        extra = f" [{r['known_hang']}]" if r.get("known_hang") else ""
        rev = " review=pending" if r.get("review") == "pending" else ""
        print(f"  {os.path.basename(r['case']):<{w}} {r['verdict']:<16} "
              f"cyc={r.get('cycles') or '-':<8} stop={r.get('stop_sym') or '-'}{div}{extra}{rev}",
              flush=True)


if __name__ == "__main__":
    main()
