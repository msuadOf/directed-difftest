#!/usr/bin/env bash
# 选择支持 RVV 1.0 汇编助记符(vsetvli 等)的 riscv 交叉编译器并导出 CROSS。
# 特性探测式: 逐个候选者试编一条 vsetvli, 编过才算可用。
# 注意: /usr/bin 的 riscv64-unknown-elf-gcc 10.2.0 不支持 RVV 助记符,
#       只能用 .4byte 手工编码——本脚本就是为了避开它。
# 用法: source scripts/toolchain.sh   (之后 $CROSS 可用; 无可用编译器时 CROSS 为空)

__probe_rvv() {  # $1=gcc 路径; 支持则返回 0
  "$1" -nostdlib -nostartfiles -march=rv64gcv_zicsr -mabi=lp64d \
    -x assembler -o /dev/null - <<< $'vsetvli t2, zero, e8, m1, ta, ma\ncsrw vstart, zero' >/dev/null 2>&1
}

__cross_candidates=(
  "${CROSS:-}"
  "${HOME:-/root}/riscv/riscv64-unknown-elf/bin/riscv64-unknown-elf-gcc"
  "/opt/riscv/bin/riscv64-unknown-elf-gcc"
  "$(command -v riscv64-unknown-elf-gcc 2>/dev/null || true)"
  "$(command -v riscv64-linux-gnu-gcc 2>/dev/null || true)"
)

CROSS=""
for c in "${__cross_candidates[@]}"; do
  [[ -z "$c" ]] && continue
  [[ -x "$c" ]] || continue
  if __probe_rvv "$c"; then CROSS="$c"; break; fi
done

if [[ -n "$CROSS" ]]; then
  [[ -z "${TOOLCHAIN_QUIET:-}" ]] && echo "[toolchain] CROSS=$CROSS ($("$CROSS" --version | head -1))"
else
  echo "[toolchain] 未找到支持 RVV 助记符的 riscv 交叉编译器。" >&2
  echo "            装新版 XiangShan 工具链(gcc>=12), 或设 CROSS= 指向; 旧 gcc 只能用 .4byte 手工编码。" >&2
fi
unset -f __probe_rvv; unset __cross_candidates c
