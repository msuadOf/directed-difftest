#meta: access=direct csr=mhpmevent11 value=illegal_optype2_3 min=1 exp=ABORT
# 最小复现核心: 无 mtvec/无 trap 依赖/无 store/无自检 —— csrw 非法 OPTYPE2 + csrr 读回。
    .section .text
    .globl _start
_start:
    li      t0, 0x000c000000000000
    csrw    mhpmevent11, t0
    csrr    t1, mhpmevent11
    .align 2
GOODTRAP:
    .word 0x0000006b
