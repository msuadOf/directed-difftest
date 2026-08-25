#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""VCD 窗口抽取: 按信号名正则 + 时间窗口, 把大 VCD 蒸馏成紧凑 CSV。

动机(docs/workflow-detailed.md「分析层」): 让 agent 直接啃几十 MB 的原始 VCD 是最低效
的波形用法。本工具把"该看哪些信号、哪段窗口"的决定与"读波形"分开: agent 给出信号
正则和窗口, 得到一张只含变化行的 CSV, 在其上找预期 vs 实际的矛盾。

用法:
  scripts/vcd_extract.py wave.vcd -s 'io_commit' -s 'valid$' [--begin T] [--end T] [-o out.csv]
  scripts/vcd_extract.py wave.vcd --list [-s 正则]     # 只列匹配的信号名(先侦察再抽取)
说明: -s 可多次, 对完整层次名(scope.scope.sig)做 re.search; 匹配数超过 --max-signals
(默认 64) 时报错退出, 提示收窄正则 —— 防止 CSV 又变成一个没法读的大文件。
输出 CSV: 第一列 time(VCD 原始时间单位), 其余列每信号一列; 仅在任一选中信号变化时出行。
"""

import argparse, re, sys


def parse_header(f):
    """返回 {id: [完整层次名,...]}(一个 id 可对应多个别名)。读到 $enddefinitions 停。"""
    ids, scope = {}, []
    for line in f:
        t = line.split()
        if not t:
            continue
        if t[0] == "$scope":
            scope.append(t[2])
        elif t[0] == "$upscope":
            if scope:
                scope.pop()
        elif t[0] == "$var":
            # $var wire 1 !! signame [width] $end
            sid, name = t[3], t[4]
            full = ".".join(scope + [name])
            ids.setdefault(sid, []).append(full)
        elif t[0] == "$enddefinitions":
            return ids
    return ids


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("vcd")
    ap.add_argument("-s", "--signal", action="append", default=[],
                    help="信号完整层次名的正则, 可多次")
    ap.add_argument("--begin", type=int, default=0)
    ap.add_argument("--end", type=int, default=1 << 62)
    ap.add_argument("--list", action="store_true", help="只列出匹配的信号名")
    ap.add_argument("--max-signals", type=int, default=64)
    ap.add_argument("-o", "--out", help="输出 CSV 路径(默认 stdout)")
    args = ap.parse_args()
    if not args.signal:
        sys.exit("至少给一个 -s 正则(先用 --list 侦察可用信号名)")
    pats = [re.compile(p) for p in args.signal]

    with open(args.vcd, errors="replace") as f:
        ids = parse_header(f)
        sel = {}  # id -> 显示名
        for sid, names in ids.items():
            for n in names:
                if any(p.search(n) for p in pats):
                    sel[sid] = n
                    break
        if args.list:
            for n in sorted(sel.values()):
                print(n)
            print(f"({len(sel)} 个匹配 / 共 {len(ids)} 个信号)", file=sys.stderr)
            return
        if not sel:
            sys.exit("没有信号匹配; 用 --list 查看命名")
        if len(sel) > args.max_signals:
            sys.exit(f"匹配 {len(sel)} 个信号 > 上限 {args.max_signals}; 收窄 -s 正则")

        cols = sorted(sel.items(), key=lambda kv: kv[1])
        out = open(args.out, "w") if args.out else sys.stdout
        out.write("time," + ",".join(n for _, n in cols) + "\n")
        cur = {sid: "x" for sid, _ in cols}
        t, dirty, rows = 0, False, 0

        def flush():
            nonlocal dirty, rows
            if dirty and args.begin <= t <= args.end:
                out.write(str(t) + "," + ",".join(cur[sid] for sid, _ in cols) + "\n")
                rows += 1
            dirty = False

        for line in f:
            line = line.strip()
            if not line:
                continue
            c = line[0]
            if c == "#":
                flush()
                t = int(line[1:])
                if t > args.end:
                    break
            elif c in "01xzXZ":
                sid = line[1:]
                if sid in cur:
                    cur[sid] = c
                    dirty = True
            elif c in "bBrR":
                val, _, sid = line.partition(" ")
                if sid in cur:
                    v = val[1:] if c in "bB" else val
                    if c in "bB" and set(v) <= {"0", "1"}:
                        v = "0x%x" % int(v, 2)   # 纯 0/1 的多位值转 hex, 便于读
                    cur[sid] = v
                    dirty = True
        flush()
        if args.out:
            out.close()
        print(f"[vcd-extract] {len(sel)} 信号, {rows} 行变化, 窗口 [{args.begin},{args.end}]",
              file=sys.stderr)


if __name__ == "__main__":
    main()
