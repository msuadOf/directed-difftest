#meta: suspect=T-mmode-pmp-locked-bypass var=tor88-ifetch mode=M pmpcfg1=0x88(L|TOR,X=0) lo=0x80001000 hi=0x80002000
# 修正编码后 M-mode 取指进真锁定区
    .section .text.init
    .globl _start
_start:
    la      t0, HAND
    csrw    mtvec, t0
    csrr    t0, mstatus
    ori     t0, t0, 0x600
    csrw    mstatus, t0

    li      t1, 0x2000400
    csrw    pmpaddr0, t1
    li      t1, 0x2000800
    csrw    pmpaddr1, t1
    li      t2, 0x8800
    csrw    pmpcfg0, t2

    la      t3, RESBUF
    li      t4, 0x77
    sd      t4, 0(t3)

    la      t4, TARGET
    jalr    t4, 0(t4)
RESUME:
    la      t3, RESBUF
    ld      t4, 0(t3)
    li      t5, 1
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

    .section .text
    .balign 4
TARGET:
    li      t1, 0x70
    la      t2, RESUME
    jr      t2

    .section .data
    .balign 8
RESBUF:  .space 64
