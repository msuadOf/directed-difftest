#meta: suspect=T-mmode-pmp-locked-bypass var=napot mode=M pmpcfg1=0x98(L|NAPOT,R=W=X=0) pmpaddr1=0x20005ff([0x80001000,0x80002000))
# 变体2: 仅改 A 字段 TOR->NAPOT
    .section .text.init
    .globl _start
_start:
    la      t0, HAND
    csrw    mtvec, t0
    csrr    t0, mstatus
    ori     t0, t0, 0x600
    csrw    mstatus, t0

    li      t1, 0x20005ff
    csrw    pmpaddr1, t1
    li      t2, 0x9800
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
