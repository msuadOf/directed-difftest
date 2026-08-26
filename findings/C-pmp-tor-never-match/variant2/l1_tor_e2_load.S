#meta: suspect=T-mmode-pmp-locked-bypass var=entry2 mode=M pmpcfg2=0x81(L|TOR) pmpaddr1=0x2000400 pmpaddr2=0x2000800 e0=e1=OFF
# 变体3: 仅改表项号 e1->e2, 排除低号表项特异
    .section .text.init
    .globl _start
_start:
    la      t0, HAND
    csrw    mtvec, t0
    csrr    t0, mstatus
    ori     t0, t0, 0x600
    csrw    mstatus, t0

    li      t1, 0x2000400
    csrw    pmpaddr1, t1
    li      t1, 0x2000800
    csrw    pmpaddr2, t1
    li      t2, 0x810000
    csrw    pmpcfg0, t2

    la      t3, RESBUF
    li      t4, 0x77
    sd      t4, 0(t3)

    li      t4, 0x80001000
    lwu     t5, 0(t4)
RESUME:
    la      t3, RESBUF
    ld      t4, 0(t3)
    li      t5, 5
    bne     t4, t5, FAIL
    j       GOODTRAP

FAIL:
1:  addi    t6, t6, 0
    j       1b

    .align 2
GOODTRAP:
    .word 0x0000006b

    .balign 4
HAND:
    la      a0, RESBUF
    csrr    a1, mcause
    sd      a1, 0(a0)
    la      a1, RESUME
    csrw    mepc, a1
    mret

    .section .data
    .balign 8
RESBUF:  .space 64
