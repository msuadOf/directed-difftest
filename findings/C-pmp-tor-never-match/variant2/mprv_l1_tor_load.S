#meta: suspect=T-mmode-pmp-locked-bypass var=mprv1 mode=M MPRV=1(MPP=M) pmpcfg1=0x81(L|TOR,R=0) lo=0x80001000 hi=0x80002000
# 变体5: 仅改 mstatus.MPRV 0->1 (M-mode 下 load), 看 MPRV 两路 priv.dmode 交付是否都旁路 L
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
    li      t2, 0x8100
    csrw    pmpcfg0, t2

    la      t3, RESBUF
    li      t4, 0x77
    sd      t4, 0(t3)

    csrr    t0, mstatus
    li      t1, 0x20000             # MPRV=1, MPP 保持 M(11)
    or      t0, t0, t1
    csrw    mstatus, t0

    li      t4, 0x80001000
    lwu     t5, 0(t4)              # trigger
RESUME:
    csrr    t0, mstatus
    li      t1, 0x20000
    csrc    mstatus, t1            # 清 MPRV, 供 handler/后续
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
    csrr    t0, mstatus
    li      t1, 0x20000
    csrc    mstatus, t1
    la      a0, RESBUF
    csrr    a1, mcause
    sd      a1, 0(a0)
    la      a1, RESUME
    csrw    mepc, a1
    mret

    .section .data
    .balign 8
RESBUF:  .space 64
