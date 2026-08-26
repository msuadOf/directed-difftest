#meta: suspect=T-mmode-pmp-locked-bypass var=v5f-s-tor-midregion-load priv=S e0=NAPOT-RWX-allowall e2=TOR-L-noperm lo=0x80001000 hi=0x80002000 acc=load@DENY(0x80001800 区中) rvc=off
# 判别: TOR deny 在 load 通路是否生效(S-mode, e0 allow-all 排除默认拒绝混杂)。
# 若 LAF(mcause=5) -> TOR 匹配 load 侧正常, 失效限于 frontend ifetch; 若放行 -> TOR deny 全通路失效。
    .option norvc
    .section .text.init
    .globl _start
_start:
    la      t0, HAND
    csrw    mtvec, t0
    csrr    t0, mstatus
    ori     t0, t0, 0x600
    csrw    mstatus, t0

    li      t1, -1                     # e0: NAPOT RWX 全地址放行
    csrw    pmpaddr0, t1
    li      t1, 0x2000400              # e2 base = 0x80001000
    csrw    pmpaddr1, t1
    li      t1, 0x2000800              # e2 top = 0x80002000
    csrw    pmpaddr2, t1
    li      t2, 0x88000F               # e0=NAPOT RWX, e1=OFF, e2=L|TOR 全禁
    csrw    pmpcfg0, t2

    li      t4, 0x5A5A5A5A             # 预置载荷到 DENY(0x80001800)
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
SENTRY:                                # 区外, e0 放行
    la      t4, DENY_DATA
    lw      t5, 0(t4)                  # trigger: S-mode load 0x80001800 区中段
SRESUME:
    nop

CHECK:
    la      t3, RESBUF
    ld      t4, 0(t3)
    li      t5, 5                      # mcause==5 (LAF)
    bne     t4, t5, FAIL
    j       GOODTRAP
FAIL_NOTRAP:
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

    .section .text
    .org 0x1800
DENY_IFMARK:
    nop

    .section .data
    .org 0x1800
DENY_DATA:                             # 0x80001800 区中段
    .word 0x5A5A5A5A
    .word 0x5A5A5A5A
    .balign 8
RESBUF:     .space 64
