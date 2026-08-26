#meta: suspect=T-mmode-pmp-locked-bypass var=s-mode mode=S pmpcfg0=0x880f(e0=RWX-TOR[0,0x80001000),e1=L|TOR|R=0) lo=0x80001000 hi=0x80002000
# 变体4: 仅改特权级 M->S (mstatus.MPP=S, mret 进 S-mode 后同 load), 预期 S-mode 被 L=1 R=0 拦截
    .section .text.init
    .globl _start
_start:
    la      t0, HAND_M
    csrw    mtvec, t0
    la      t0, HAND_S
    csrw    stvec, t0
    csrr    t0, mstatus
    ori     t0, t0, 0x600
    csrw    mstatus, t0

    li      t1, 0x2000400
    csrw    pmpaddr0, t1
    li      t1, 0x2000800
    csrw    pmpaddr1, t1
    li      t2, 0x880f             # e0=TOR[0,0x80001000) RWX 给 S 代码页; e1=L|TOR R=0
    csrw    pmpcfg0, t2

    la      t3, RESBUF
    li      t4, 0x77
    sd      t4, 0(t3)

    li      t0, 0x800               # MPP=S
    la      t1, S_LOAD
    csrw    mepc, t1
    csrs    mstatus, t0             # MPP=S, 下一 mret 降 S
    mret

S_LOAD:                             # S-mode
    li      t4, 0x80001000
    lwu     t5, 0(t4)              # trigger: S-mode load L=1 R=0 区
S_RESUME:
    la      t3, RESBUF
    ld      t4, 0(t3)
    li      t5, 5
    bne     t4, t5, S_FAIL
    ecall                            # 回 M-mode 报告结果(标记已写 RESBUF)
S_FAIL:
    li      t6, 0xdead
    ecall

    .align 2
GOODTRAP:
    .word 0x0000006b

M_FINISH:
    la      t3, RESBUF
    ld      t4, 0(t3)
    li      t5, 5
    bne     t4, t5, FAIL
    j       GOODTRAP

    .balign 4
HAND_M:                             # trap from S (undelegated) or ecall from S
    csrr    a1, mcause
    li      a2, 11
    beq     a1, a2, EC
    la      a0, RESBUF              # access fault: 记 5 并回 S 续跑
    li      a1, 5
    sd      a1, 0(a0)
    la      a1, S_RESUME
    csrw    mepc, a1
    mret
EC:                                 # ecall from S: 结果已在 RESBUF
    la      a1, M_FINISH
    csrw    mepc, a1
    mret

FAIL:
1:  addi    t6, t6, 0
    j       1b

    .balign 4
HAND_S:                             # S-mode delegated access fault (若设了 medeleg)
    la      a0, RESBUF
    li      a1, 5
    sd      a1, 0(a0)
    la      a1, S_RESUME
    csrw    sepc, a1
    sret

    .section .data
    .balign 8
RESBUF:  .space 64
