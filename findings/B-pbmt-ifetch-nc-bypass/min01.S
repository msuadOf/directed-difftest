#meta: var=min-jump1 pbmt=01 bits=0x2000000000000000 expect_pf=0 mode=S access=ifetch jumps=1
# 最小化: 代码页 pbmt=01(bit61), S-mode 单次 jalr, 页内仅 nop+jalr
    .equ PBMT_A, 0x2000000000000000
    .equ PG_CUSTOM, 1
    .equ EXPECT_PF, 0
    .include "common5.inc"
    .equ PG_CUSTOM, 1
PAGE_CODE:
    nop
    jalr    x0, 0(ra)
PAGE_CODE_END:
    .section .text
    .globl _start
_start:
    la      t0, TRAPH
    csrw    mtvec, t0
    SETUP5
SMAIN:
    li      t1, VA_A
    jalr    ra, 0(t1)
    j       GOODTRAP
    .align 2
GOODTRAP:
    .word 0x0000006b
    TRAPH5
