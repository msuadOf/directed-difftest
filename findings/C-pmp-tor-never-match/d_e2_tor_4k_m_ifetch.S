#meta: suspect=T-mmode-pmp-locked-bypass var=v5d-e2-tor-4k-m-ifetch priv=M A=TOR pmpcfg0e2=0x88 lo=0x80001000 hi=0x80002000 e0/e1=OFF acc=ifetch rvc=off
# 批次4: M-mode 旁路是否索引>=2 泛化(ifech 侧; v4 tor88_e2_m_load 已示 load 侧 e2 旁路)。
# 期望(spec): IAF mcause=1 mepc=TARGET; claim: 无 trap, TARGET 执行 marker=0x5A。
    .option norvc
    .section .text.init
    .globl _start
_start:
    la      t0, HAND
    csrw    mtvec, t0
    csrr    t0, mstatus
    ori     t0, t0, 0x600
    csrw    mstatus, t0

    csrw    pmpaddr0, zero
    li      t1, 0x2000400              # e2 base = 0x80001000
    csrw    pmpaddr1, t1
    li      t1, 0x2000800              # e2 top = 0x80002000
    csrw    pmpaddr2, t1
    li      t2, 0x880000               # e2 = L|TOR 全禁
    csrw    pmpcfg0, t2

    la      t3, RESBUF
    li      t4, 0x77
    sd      t4, 0(t3)
    li      t4, 0x66
    sd      t4, 8(t3)

    la      t4, TARGET
    jalr    x0, 0(t4)
RESUME:
    la      t3, RESBUF
    ld      t4, 0(t3)
    li      t5, 1
    bne     t4, t5, FAIL
    ld      t4, 8(t3)
    la      t5, TARGET
    bne     t4, t5, FAIL
    j       GOODTRAP
FAIL:
1:  addi    t6, t6, 0
    j       1b

    .align 2
GOODTRAP:
    .word 0x0000006b

    .balign 4
HAND:                                  # 区外 page0
    la      a0, RESBUF
    csrr    a1, mcause
    sd      a1, 0(a0)
    csrr    a1, mepc
    sd      a1, 8(a0)
    la      a1, RESUME
    csrw    mepc, a1
    mret

    .section .text
    .balign 4
TARGET:                                # 0x80001000 区内
    li      t1, 0x5A
    la      t2, RESBUF
    sd      t1, 8(t2)
    la      t3, FAIL
    jr      t3

    .section .data
    .balign 8
RESBUF:     .space 64
