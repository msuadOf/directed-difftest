#!/usr/bin/env bash
# 【已弃用】请改用 scripts/run_batch.py —— 批量并行(全局槽位)、-C 封顶、看门狗止损、
# runs.jsonl 记录、summary.tsv 一应俱全; 本脚本无看门狗、无记录、串行, 仅作历史参考。
# 编译单个 .S 为 ELF 并跑 emu vs NEMU DiffTest（骨架）
# 用法: ./templates/run-one-case.sh <case.S> <artifacts_dir>
# 环境变量可覆盖: CROSS / EMU / REF / LINKER / TRACE_BEGIN / TRACE_END

set -euo pipefail

CASE="${1:?用法: run-one-case.sh <case.S> <artifacts_dir>}"
OUTDIR="${2:?用法: run-one-case.sh <case.S> <artifacts_dir>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- 环境(默认指向本仓库 submodule, 首次使用先跑 ./scripts/setup-env.sh) ----
EMU="${EMU:-$REPO_ROOT/xiangshan/build/emu}"
REF="${REF:-$REPO_ROOT/xiangshan/ready-to-run/riscv64-nemu-interpreter-so}"
# 交叉编译器: 特性探测式选择(旧 gcc 10.2 不支持 RVV 助记符)
source "$REPO_ROOT/scripts/toolchain.sh"
CROSS="${CROSS:?未找到 RVV 编译器}"
test -n "$EMU"
LINKER="${LINKER:-$REPO_ROOT/templates/xiangshan.ld}"

# 提交跟踪取证窗口(-b/-e 为周期范围, 按需调整; emu 无波形支持)
TRACE_BEGIN="${TRACE_BEGIN:-0}"
TRACE_END="${TRACE_END:-100000}"

mkdir -p "$OUTDIR"
ELF="$OUTDIR/$(basename "${CASE%.S}").elf"
LOG="$OUTDIR/difftest.log"

# ---- 编译: 入口 0x80000000 (链接脚本 xiangshan.ld) ----
"$CROSS" -nostdlib -nostartfiles -static -fno-pic \
  -march=rv64gcv -mabi=lp64d -T "$LINKER" -o "$ELF" "$CASE"

# ---- 跑 DiffTest: -i 加载镜像, --diff 挂 REF ----
timeout 600 "$EMU" -b "$TRACE_BEGIN" -e "$TRACE_END" \
       -i "$ELF" --diff "$REF" 2>&1 | tee "$LOG"

# 粗判结果(骨架): 完整判定应结合 GOODTRAP 提交与自检分支
if grep -q "HIT GOOD TRAP" "$LOG"; then
    echo "RESULT: PASS (GOODTRAP)"
elif grep -q "ABORT" "$LOG"; then
    echo "RESULT: ABORT — 查看 $LOG 中 data 字段的双值(DUT vs REF)"
    exit 1
else
    echo "RESULT: UNKNOWN — 人工检查 $LOG"
    exit 2
fi
