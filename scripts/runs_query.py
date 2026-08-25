#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""运行数据库(artifacts/runs.jsonl)查询与离群检测。

动机(docs/workflow-detailed.md「证据层」): 每次仿真的结构化记录攒在 runs.jsonl 里,
跨 run/跨疑点的模式(哪类参数总在失败、哪个用例的周期数远超同类)才看得见。
离群检测是波形方法论"自对照不一致"判据的廉价前置过滤器: 先在 cycles/IPC 上找
离群 run, 再决定对哪个 run dump 波形。

用法:
  scripts/runs_query.py                          # 全库 verdict 统计
  scripts/runs_query.py --case-re S1 --verdict ABORT      # 过滤, 输出每条记录一行
  scripts/runs_query.py --case-re variant1 --outliers     # cycles 离群检测(MAD 法)
  scripts/runs_query.py --pending-review                  # 待复核(一杀一审队列, 已销案的不列)
  scripts/runs_query.py --resolve <case路径> --ruling TRUE_HANG --note "..."
      # 一杀一审销案: 追加一条 review_resolution 记录(append-only, 不改写历史行),
      # 同 case 的 pending run 即视为已复核; ruling: TRUE_HANG|FALSE_KILL|UNCLEAR
  过滤: --case-re 正则 / --verdict / --meta k=v / --since YYYY-MM-DD; --json 出原始记录
"""

import argparse, fcntl, json, os, sys
from datetime import datetime

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DB = os.path.join(REPO, "artifacts/runs.jsonl")


def load(args):
    if not os.path.exists(DB):
        sys.exit(f"运行数据库不存在: {DB}(由 scripts/run_batch.py 生成)")
    # 两遍: 先收全部销案记录(它们总在对应 run 之后追加), 再过滤 run
    records, resolved = [], {}
    with open(DB) as f:
        for line in f:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("type") == "review_resolution":
                # 同 case 多次销案取最新 ts; 销案只压制"当时已存在"的 pending
                c = r.get("case")
                if c not in resolved or r.get("ts", "") > resolved[c]:
                    resolved[c] = r.get("ts", "")
            else:
                records.append(r)
    out = []
    for r in records:
        if args.case_re and not __import__("re").search(args.case_re, r.get("case", "")):
            continue
        if args.verdict and r.get("verdict") != args.verdict:
            continue
        if args.since and r.get("ts", "") < args.since:
            continue
        if args.pending_review and r.get("review") != "pending":
            continue
        if args.pending_review and r.get("ts", "") <= resolved.get(r.get("case"), ""):
            # 仅压制销案时刻之前的 run —— FALSE_KILL 重跑复用同一 .S 路径,
            # 重跑再被杀属新事件, 不能被旧销案永久隐藏
            continue
        skip = False
        for kv in args.meta:
            k, v = kv.split("=", 1)
            if str(r.get("meta", {}).get(k)) != v:
                skip = True
        if not skip:
            out.append(r)
    return out


def fmt(r):
    div = r.get("divergence") or []
    d = f" div:{div[0]['reg']} ref={div[0]['ref']} dut={div[0]['dut']}" if div else ""
    kh = f" [{r['known_hang']}]" if r.get("known_hang") else ""
    rv = " review=pending" if r.get("review") == "pending" else ""
    return (f"{r.get('ts','-'):<20} {r.get('verdict','-'):<15} cyc={r.get('cycles') or '-':<8} "
            f"stop={r.get('stop_sym') or '-':<20} {r.get('case','-')}{d}{kh}{rv}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--case-re")
    ap.add_argument("--verdict")
    ap.add_argument("--since")
    ap.add_argument("--meta", action="append", default=[])
    ap.add_argument("--pending-review", action="store_true")
    ap.add_argument("--outliers", action="store_true",
                    help="对过滤结果做 cycles 离群检测(中位数绝对偏差, |dev|>4*MAD)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--resolve", metavar="CASE",
                    help="一杀一审销案: 该 case(runs.jsonl 里的 case 字段值)的 pending 复核已完成")
    ap.add_argument("--ruling", choices=["TRUE_HANG", "FALSE_KILL", "UNCLEAR"])
    ap.add_argument("--note", default="")
    args = ap.parse_args()

    if args.resolve:
        if not args.ruling:
            sys.exit("--resolve 必须配 --ruling TRUE_HANG|FALSE_KILL|UNCLEAR")
        rec = {"type": "review_resolution", "ts": datetime.now().isoformat(timespec="seconds"),
               "case": args.resolve, "ruling": args.ruling, "note": args.note}
        with open(DB, "a") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fcntl.flock(f, fcntl.LOCK_UN)
        print(f"已销案: {args.resolve} -> {args.ruling}")
        return

    rows = load(args)

    if args.outliers:
        vals = [(r, r["cycles"]) for r in rows if isinstance(r.get("cycles"), int)]
        if len(vals) < 4:
            sys.exit(f"样本太少({len(vals)}), 离群检测至少要 4 条有 cycles 的记录")
        cs = sorted(v for _, v in vals)
        med = cs[len(cs) // 2]
        mad = sorted(abs(v - med) for v in cs)[len(cs) // 2] or 1
        print(f"样本 {len(vals)} 条, cycles 中位数 {med}, MAD {mad}; 离群(|dev|>4*MAD):")
        hit = [(r, v) for r, v in vals if abs(v - med) > 4 * mad]
        for r, v in hit:
            print(f"  dev={v - med:+8d}  {fmt(r)}")
        if not hit:
            print("  (无 —— 自对照未见异常)")
        return

    if args.json:
        for r in rows:
            print(json.dumps(r, ensure_ascii=False))
        return
    if not (args.case_re or args.verdict or args.since or args.meta or args.pending_review):
        stats = {}
        for r in rows:
            stats[r.get("verdict", "?")] = stats.get(r.get("verdict", "?"), 0) + 1
        print(f"runs.jsonl 共 {len(rows)} 条:")
        for k, v in sorted(stats.items(), key=lambda kv: -kv[1]):
            print(f"  {k:<16} {v}")
        return
    for r in rows:
        print(fmt(r))
    print(f"({len(rows)} 条)", file=sys.stderr)


if __name__ == "__main__":
    main()
