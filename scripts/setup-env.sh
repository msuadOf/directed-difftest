#!/usr/bin/env bash
# 初始化/修复验证环境: submodule + 预编译产物拷贝(免 Verilator 重编) + 自检
#
# 用法:
#   ./scripts/setup-env.sh                       # 常规: 初始化 submodule, 从 SRC 拷贝 build/ 与 REF
#   SRC_XIANGSHAN=/path/to/xiangshan ./scripts/setup-env.sh   # 指定已有编译产物的 xiangshan 克隆
#   ./scripts/setup-env.sh --check               # 只做环境自检, 不改任何东西
#
# 环境变量:
#   SRC_XIANGSHAN   含预编译 build/ 的 xiangshan 克隆, 默认 isla-runner 工作区里的那份
#   SKIP_COPY=1     跳过拷贝(例如想自己从源码编译 emu: 见 xiangshan/README, make emu CONFIG=MinimalConfig)

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XS="$REPO_ROOT/xiangshan"
PINNED_COMMIT="7bf51a8"   # kunminghu-v3, 与 docs/motivation.md 实测时一致
SRC_XIANGSHAN="${SRC_XIANGSHAN:-/home/baiyifan/workplace-local/isla-runner/difftest-xiangshan/xiangshan}"

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

check() {
  local ok=1
  { [[ -d "$XS/.git" ]] || [[ -f "$XS/.git" ]]; } && echo "OK  submodule xiangshan" || { echo "MISS submodule xiangshan (git submodule update --init)"; ok=0; }
  local cur=""
  cur="$(git -C "$XS" rev-parse --short HEAD 2>/dev/null || true)"
  [[ "$cur" == "${PINNED_COMMIT:0:7}" ]] && echo "OK  commit $cur (== $PINNED_COMMIT)" \
    || echo "WARN commit ${cur:-none} != $PINNED_COMMIT (历史结论基于 $PINNED_COMMIT 验证)"
  [[ -x "$XS/build/emu" ]] && echo "OK  DUT emu: xiangshan/build/emu" || { echo "MISS DUT emu (运行带拷贝的 setup 或自编)"; ok=0; }
  [[ -e "$XS/ready-to-run/riscv64-nemu-interpreter-so" ]] && echo "OK  REF nemu-so" || { echo "MISS REF nemu-so"; ok=0; }
  source "$REPO_ROOT/scripts/toolchain.sh"
  [[ -n "$CROSS" ]] && echo "OK  RVV 编译器: $CROSS" || { echo "MISS 支持 RVV 助记符的编译器 (见 scripts/toolchain.sh)"; ok=0; }
  command -v python3 >/dev/null && echo "OK  python3" || { echo "MISS python3"; ok=0; }
  [[ $ok -eq 1 ]] && echo "== 环境就绪 ==" || { echo "== 环境不完整 =="; exit 1; }
}

if [[ $CHECK_ONLY -eq 1 ]]; then check; exit 0; fi

# ---- 1. submodule ----
if [[ ! -e "$XS/.git" ]]; then
  echo "[setup] 初始化 submodule xiangshan (pin $PINNED_COMMIT)..."
  git -C "$REPO_ROOT" submodule update --init --recursive
fi
git -C "$XS" checkout -q "$PINNED_COMMIT"

# ---- 2. 拷贝预编译产物(免 Verilator 重编) ----
if [[ "${SKIP_COPY:-0}" != "1" ]]; then
  if [[ -d "$SRC_XIANGSHAN/build" && -x "$SRC_XIANGSHAN/build/emu" ]]; then
    echo "[setup] rsync build/ (Verilator 产物) <- $SRC_XIANGSHAN ..."
    mkdir -p "$XS/build"
    rsync -a --delete "$SRC_XIANGSHAN/build/" "$XS/build/"
    # 拷贝产物内的绝对路径会被修正吗: Verilator emu 不依赖安装路径, 直接可用
  else
    echo "[setup] 未找到 $SRC_XIANGSHAN/build/emu, 跳过拷贝。"
    echo "        自编: cd xiangshan && make emu CONFIG=MinimalConfig EMU_THREADS=4 -j\$(nproc)"
  fi
  if [[ -e "$SRC_XIANGSHAN/ready-to-run/riscv64-nemu-interpreter-so" ]]; then
    echo "[setup] 拷贝 REF nemu-so..."
    mkdir -p "$XS/ready-to-run"
    rsync -a "$SRC_XIANGSHAN/ready-to-run/riscv64-nemu-interpreter-so" "$XS/ready-to-run/"
  fi
fi

# ---- 3. 自检 ----
check
