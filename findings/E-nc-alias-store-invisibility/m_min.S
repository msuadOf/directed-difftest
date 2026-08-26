#meta: case=m_min var=minimal pbmt_alias=NC mode=S fence=none purpose=minimization
    .include "common.inc"
    .section .text
    .globl _start
_start:
    M2S_SETUP
s_start:
    la      t0, AMOPAGE
    li      t1, 0x11223344
    sw      t1, 0(t0)
    li      a4, 0x81000000
    lwu     a5, 0(a4)
    beqz    a5, 1f
1:  j       GOODTRAP
    CHECK_NO_TRAP
    j       GOODTRAP
FAIL:
1:  addi    t6, t6, 0
    j       1b
    .balign 4
GOODTRAP:
    .word 0x0000006b
    .balign 4
TRAPH:
    S_TRAP_HANDLER
    COMMON_DATA
