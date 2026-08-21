#!/usr/bin/env bash
# 编译单个 .S 为 ELF 并跑 emu vs NEMU DiffTest（骨架）
# 用法: ./templates/run-one-case.sh <case.S> <artifacts_dir>
# 注意: 以下路径变量按本机环境调整。默认值相对 isla-runner 工作区,
#       WORKSPACE 可用环境变量覆盖。

set -euo pipefail

CASE="${1:?用法: run-one-case.sh <case.S> <artifacts_dir>}"
OUTDIR="${2:?用法: run-one-case.sh <case.S> <artifacts_dir>}"

# ---- 环境变量(按机器调整) ----
WORKSPACE="${WORKSPACE:-/home/baiyifan/workplace-local/isla-runner}"
EMU="${EMU:-$WORKSPACE/difftest-xiangshan/xiangshan/build/emu}"
REF="${REF:-$WORKSPACE/difftest-xiangshan/xiangshan/ready-to-run/riscv64-nemu-interpreter-so}"
CROSS="${CROSS:-riscv64-linux-gnu-gcc}"

# 提交跟踪取证窗口(-b/-e 为退休指令序号范围, 按需调整; emu 无波形支持)
TRACE_BEGIN="${TRACE_BEGIN:-0}"
TRACE_END="${TRACE_END:-100000}"

mkdir -p "$OUTDIR"
ELF="$OUTDIR/$(basename "${CASE%.S}").elf"
LOG="$OUTDIR/difftest.log"

# ---- 编译: 入口 0x80000000 ----
"$CROSS" -nostdlib -nostartfiles -Ttext=0x80000000 -o "$ELF" "$CASE"

# ---- 跑 DiffTest: GOODTRAP 到达 = 通过; ABORT = DUT/REF 分歧(bug 证据) ----
# NOOP= 是否派生 REF 状态、其余参数见 emu --help, 按需调整
"$EMU" -b "$TRACE_BEGIN" -e "$TRACE_END" \
       +REF="$REF" \
       "$ELF" 2>&1 | tee "$LOG"

# 粗判结果(骨架): 完整判定应结合 GOODTRAP 提交与自检分支
if grep -q "HIT GOODTRAP" "$LOG"; then
    echo "RESULT: PASS (GOODTRAP)"
elif grep -q "ABORT" "$LOG"; then
    echo "RESULT: ABORT — 查看 $LOG 中 data 字段的双值(DUT vs REF)"
    exit 1
else
    echo "RESULT: UNKNOWN — 人工检查 $LOG"
    exit 2
fi
