#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""双跟踪差分: DUT 提交跟踪 vs REF(NEMU) 指令跟踪, 找首个控制流分歧点。

动机(docs/workflow-detailed.md「分析层」): difftest 的 ABORT 只报"首个架构状态分歧",
而控制流分歧(DUT 与 REF 走上不同路径: 一方进 trap 一方没进、分支方向不同)往往
发生得更早、更接近根因。本工具把两条指令流对齐, 给出:
  1. 控制流首分歧点 ±N 条上下文(DUT 侧带 wen/dst/data, 双侧带反汇编注解);
  2. 架构状态分歧行(difftest 的 "different at pc" 双值);
  3. 若控制流完全一致仅数据分歧 —— 这本身就是重要结论(错在数据通路而非控制流)。

输入日志须由 emu 同时开 --dump-commit-trace 与 --dump-ref-trace 生成
(用 run_batch.py 时加 --emu-args "--dump-ref-trace")。

用法:
  scripts/trace_diff.py <difftest.log> [--elf case.elf] [-n 上下文条数] [--json]
"""

import argparse, json, os, re, subprocess, sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ANSI = re.compile(r"\x1b\[[0-9;]*m")
DUT_RE = re.compile(
    r"\[\s*\d+\]\s+commit pc\s+([0-9a-f]+)\s+inst\s+([0-9a-f]+)\s+wen\s+([01])"
    r"\s+dst\s+([0-9a-f]+)\s+data\s+([0-9a-f]+)")
REF_RE = re.compile(r"\[NEMU\]\[\d+\]\s+pc\s*=\s*0x([0-9a-f]+)\s+inst\s+([0-9a-f]+)")
DIVERGE_RE = re.compile(
    r"(\S+)\s+different at pc\s*=\s*0x([0-9a-f]+),\s*right\s*=\s*0x([0-9a-f]+),"
    r"\s*wrong\s*=\s*0x([0-9a-f]+)")


def load_disasm(elf):
    """pc -> 'insn  operands' 反汇编映射(交叉 objdump)。失败则返回空映射。"""
    dis = {}
    if not elf:
        return dis
    r = subprocess.run(["bash", "-c",
                        f'TOOLCHAIN_QUIET=1 source "{REPO}/scripts/toolchain.sh"; printf %s "$CROSS"'],
                       capture_output=True, text=True)
    objdump = re.sub(r"gcc$", "objdump", r.stdout.strip() or "")
    if not objdump or not os.path.exists(objdump):
        return dis
    r = subprocess.run([objdump, "-d", elf], capture_output=True, text=True)
    for m in re.finditer(r"^\s*([0-9a-f]+):\s+[0-9a-f]+\s+(.+)$", r.stdout, re.M):
        dis[int(m.group(1), 16)] = m.group(2).strip()
    return dis


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("log")
    ap.add_argument("--elf", help="用于反汇编注解")
    ap.add_argument("-n", "--context", type=int, default=15)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    with open(args.log, errors="replace") as f:
        text = ANSI.sub("", f.read())
    # ABORT 时 difftest 会把最近提交历史重放打印一遍("== Commit Group Trace =="起),
    # 只取分隔符之前的实时流, 避免把重放段误判成控制流分歧
    live = re.split(r"=+ Commit (?:Group|Instr) Trace", text)[0]
    dut = [(int(m.group(1), 16),) + m.groups()[1:] for m in DUT_RE.finditer(live)]
    if not dut:  # -b 设得晚导致实时流为空时, 回退用重放段
        dut = [(int(m.group(1), 16),) + m.groups()[1:] for m in DUT_RE.finditer(text)]
    ref = [(int(m.group(1), 16), m.group(2)) for m in REF_RE.finditer(text)]
    arch_div = [{"reg": m.group(1), "pc": "0x" + m.group(2), "ref": "0x" + m.group(3),
                 "dut": "0x" + m.group(4)} for m in DIVERGE_RE.finditer(text)]
    dis = load_disasm(args.elf)
    note = lambda pc: dis.get(pc, "(bootrom)" if 0x10000000 <= pc < 0x10010000 else "?")

    if not dut:
        sys.exit("日志中无提交跟踪(需要 --dump-commit-trace; 见踩坑清单: 须显式加该 flag)")
    if not ref:
        sys.exit("日志中无 REF 跟踪(需要 --dump-ref-trace, run_batch.py 加 --emu-args)")

    n = min(len(dut), len(ref))
    div_idx = next((i for i in range(n) if dut[i][0] != ref[i][0]), None)

    out = {"dut_commits": len(dut), "ref_commits": len(ref),
           "cf_divergence_index": div_idx, "arch_divergence": arch_div, "context": []}
    if div_idx is None:
        out["conclusion"] = ("控制流完全一致(前 %d 条)%s" % (
            n, ", 但存在架构状态分歧 -> 错误在数据通路而非控制流" if arch_div
            else ", 且无架构分歧"))
        ctx_lo, ctx_hi = max(0, n - args.context), n
    else:
        out["conclusion"] = "控制流首分歧@指令#%d: DUT pc=0x%x REF pc=0x%x" % (
            div_idx, dut[div_idx][0], ref[div_idx][0])
        ctx_lo, ctx_hi = max(0, div_idx - args.context), min(n, div_idx + args.context + 1)
    for i in range(ctx_lo, ctx_hi):
        d, r = dut[i], ref[i]
        out["context"].append({
            "i": i, "match": d[0] == r[0],
            "dut": {"pc": "0x%x" % d[0], "inst": d[1], "wen": d[2], "dst": d[3],
                    "data": d[4], "asm": note(d[0])},
            "ref": {"pc": "0x%x" % r[0], "inst": r[1], "asm": note(r[0])}})

    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return
    print(f"DUT 提交 {out['dut_commits']} 条, REF {out['ref_commits']} 条")
    print(out["conclusion"])
    for c in out["context"]:
        mark = "  " if c["match"] else "->"
        d, r = c["dut"], c["ref"]
        line = f"{mark} #{c['i']:<4} DUT {d['pc']} {d['asm']:<36}"
        if d["wen"] == "1":
            line += f" x{int(d['dst'], 10)}<={d['data']}"  # dst 字段为十进制寄存器号
        if not c["match"]:
            line += f"   | REF {r['pc']} {r['asm']}"
        print(line)
    for a in arch_div:
        print(f"架构分歧: {a['reg']} @ {a['pc']}  REF(right)={a['ref']}  DUT(wrong)={a['dut']}")


if __name__ == "__main__":
    main()
