# common5.inc — F-pbmt-ifetch-uncache-path variant5: S-mode 取指自 PBMT 页(单变量参数化)
# 用法: .S 里 .equ PBMT_A / EXPECT_PF 后 .include 本文件, 写 _start 调 SETUP5。
# 变量: VA_A(0x40000000) -> DPG_A, PTE R+W+X, pbmt=PBMT_A。其余页 pbmt=00。
# 观察: 取指是否 fault(mcause 分类), 成功时的 cycles 时序签名。
#   PBMT_A: 0 / 0x2000...(bit61,spec IO|XS NC) / 0x4000...(bit62,spec NC|XS IO) / 0x6000...(rsvd)
#   EXPECT_PF: 1 时 mcause=12 视为预期结果直接 GOODTRAP
    .equ VA_A, 0x40000000
    .equ VA_CNT, 0x40002100
    .equ PTE_RWX, 0x0CF
    .ifndef PTE_A_LEAF
    .equ PTE_A_LEAF, 0x0CB
    .endif

    .macro SETUP5
    # 拷贝 PAGE_CODE -> DPG_A (物理直达)
    la      t0, PAGE_CODE
    la      t1, PAGE_CODE_END
    la      t2, DPG_A
1:
    bgeu    t0, t1, 2f
    lw      a0, 0(t0)
    sw      a0, 0(t2)
    addi    t0, t0, 4
    addi    t2, t2, 4
    j       1b
2:
    la      t0, PGT_L0
    la      t1, DPG_A
    srli    t1, t1, 2
    ori     t1, t1, PTE_A_LEAF        # V|R|X 可执行只读叶
    li      t2, PBMT_A
    or      t1, t1, t2
    sd      t1, 0(t0)             # L0[0] VA_A (被测 pbmt)
    la      t1, DPG_C
    srli    t1, t1, 2
    ori     t1, t1, PTE_RWX
    sd      t1, 16(t0)            # L0[2] VA_C 计数页 pbmt=00
    la      t0, PGT_L1
    la      t1, PGT_L0
    srli    t1, t1, 2
    ori     t1, t1, 0x001
    sd      t1, 0(t0)
    la      t0, PGT_ROOT
    la      t1, PGT_L1
    srli    t1, t1, 2
    ori     t1, t1, 0x001
    sd      t1, 8(t0)             # ROOT[1] VPN2=1 -> L1
    li      t1, 0x80000000
    srli    t1, t1, 2
    ori     t1, t1, PTE_RWX
    sd      t1, 16(t0)            # ROOT[2] 1GB 恒等

    li      t0, 8
    slli    t0, t0, 60
    la      t1, PGT_ROOT
    srli    t1, t1, 12
    or      t0, t0, t1
    csrw    satp, t0
    sfence.vma
    fence.i
    csrr    t0, menvcfg
    li      t1, 0x4000000000000000
    or      t0, t0, t1
    csrw    menvcfg, t0           # PBMTE
    li      t0, 0x0F
    csrw    pmpcfg0, t0
    li      t0, -1
    csrw    pmpaddr0, t0
    csrr    t0, mstatus
    li      t1, 0x800             # MPP=S
    or      t0, t0, t1
    csrw    mstatus, t0
    la      t0, SMAIN
    csrw    mepc, t0
    mret
    .endm

    # 页内代码: 计数器 +1 经 VA_CNT, 返回。PIC, 无外部符号。
    .section .rodata
    .ifndef PG_CUSTOM
PAGE_CODE:
    li      t0, VA_CNT
1:
    lwu     t1, 0(t0)
    addi    t1, t1, 1
    sw      t1, 0(t0)
    jalr    x0, 0(ra)
PAGE_CODE_END:
    .endif

    # trap handler: mcause 分类落点(独立 FAIL 标签, 供 stop_sym 区分)
    .macro TRAPH5
TRAPH:
    csrr    t1, mcause
    li      t2, 12
    beq     t1, t2, TR_12
    li      t2, 13
    beq     t1, t2, TR_13
    li      t2, 1
    beq     t1, t2, TR_ILL
    li      t2, 8
    beq     t1, t2, TR_ECALL
    li      t2, 15
    beq     t1, t2, TR_15
FAIL_OTHER:
    j       FAIL_OTHER
    nop
TR_ILL:
FAIL_ILL:
    j       FAIL_ILL
    nop
TR_13:
FAIL_LF:
    j       FAIL_LF
    nop
TR_15:
FAIL_15:
    j       FAIL_15
    nop
TR_ECALL:
FAIL_ECALL:
    j       FAIL_ECALL
    nop
TR_12:
    .if EXPECT_PF
    j       GOODTRAP              # 预期取指 page fault, 一次即收
    .else
FAIL_IPF:
    j       FAIL_IPF
    nop
    .endif
    .endm

    .section .data
    .balign 4096
PGT_ROOT:
    .space 4096
    .balign 4096
PGT_L1:
    .space 4096
    .balign 4096
PGT_L0:
    .space 4096
    .balign 4096
DPG_A:
    .space 4096
    .balign 4096
DPG_C:
    .space 4096
