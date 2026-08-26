#meta: suspect=T-mmode-pmp-locked-bypass var=v5c-prio-e0-napot-allow-e1-napot-L-deny-s-load priv=S e0=NAPOT-RWX-8K@[0x80000000,0x80003000) e1=NAPOT-L-noperm-64B@DENY acc=load rvc=off
# 批次3(重设计): 优先级反转纯 NAPOT 隔离(去掉 TOR 混杂变量): e0=NAPOT RWX 8K 覆盖代码+数据,
# e1=NAPOT L=1 R0W0X0 64B 只覆盖 DENY 数据。spec 3.7.4: 最高匹配索引(e1)优先 -> S-mode lw DENY 应 LAF
# mcause=5 mepc=TRIG; DUT ParallelPriorityMux 是低索引优先 -> 若放行 rd=0x5A5A5A5A 进 FAIL_NOTRAP。
# 同时观察 NEMU 是否同样放行(difftest 无 ABORT = 共享偏离)。
    .option norvc
    .section .text.init
    .globl _start
_start:
    la      t0, HAND
    csrw    mtvec, t0
    csrr    t0, mstatus
    ori     t0, t0, 0x600
    csrw    mstatus, t0

    li      t1, 0x200007FF             # e0: NAPOT 8KB [0x80000000,0x80003000) RWX
    csrw    pmpaddr0, t1
    la      t1, DENY_DATA              # e1: NAPOT 64B L=1 全禁
    srli    t1, t1, 2
    ori     t1, t1, 7
    csrw    pmpaddr1, t1
    li      t2, 0x980F                 # e0=NAPOT RWX, e1=L|NAPOT 全禁
    csrw    pmpcfg0, t2

    li      t4, 0x5A5A5A5A             # 预置载荷
    la      t5, DENY_DATA
    sw      t4, 0(t5)

    la      t3, RESBUF
    li      t4, 0x77
    sd      t4, 0(t3)

    la      t4, SENTRY
    csrw    mepc, t4
    li      t0, 0x800
    csrs    mstatus, t0
    mret
SENTRY:                                # S-mode, e0 放行区
    la      t4, DENY_DATA
    lw      t5, 0(t4)                  # trigger: S-mode load 命中 e0(allow)+e1(deny)
SRESUME:
    nop

CHECK:
    la      t3, RESBUF
    ld      t4, 0(t3)
    li      t5, 5                      # mcause==5 (LAF)
    bne     t4, t5, FAIL
    j       GOODTRAP
FAIL_NOTRAP:                           # 无 trap: t5=0x5A5A5A5A 被读出
1:  addi    t6, t6, 0
    j      1b
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
    la      a1, CHECK
    csrw    mepc, a1
    li      a1, 0x1800
    csrs    mstatus, a1
    mret

    .section .data
    .balign 8
DENY_DATA:
    .word 0x5A5A5A5A
    .word 0x5A5A5A5A
    .balign 64
RESBUF:     .space 64
