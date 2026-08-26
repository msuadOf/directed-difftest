# 真 S 模式公共环境(基座 F-amo variant1 common.inc), PBMT_PTE 参数化: 默认 NC(bit61); IO 用 .equ PBMT_PTE, 0x4000000000000000
.ifndef PBMT_PTE
.equ PBMT_PTE, 0x2000000000000000
.endif
# F-amo-on-nc-page-fault 公共环境: Sv39 + Svpbmt 分页, 进 S 模式
# 页表布局(VA=PA 恒等映射基座):
#   L2TAB[2]  -> L1TAB            (0x80000000 落在 VPN[2]=2)
#   L1TAB[0]  = 2MB leaf V|R|W|X|A|D (0xCF), pbmt=00, PA=0x80000000
#               覆盖 VA 0x80000000..0x801FFFFF (代码/数据全在内)
#   L1TAB[8]  -> L0TAB            (VA 0x81000000 的 VPN[1]=8)
#   L0TAB[0]  = 4KB leaf V|R|W|A|D | bit61(pbmt=01=NC), PA=AMOPAGE
# => NC 虚地址 0x81000000 与 AMOPAGE 恒等地址是同一物理页的两个别名,
#    唯一差分变量 = PTE pbmt 字段。
# trap: M 模式意外 trap -> TRAPH -> FAIL(code 11); S 模式 trap -> SH 记录
#       scause/sepc/stval 后 sepc+=4, sret 跳过触发指令继续跑 check。

    .macro M2S_SETUP
    la      t0, TRAPH
    csrw    mtvec, t0
    csrr    t0, mstatus
    ori     t0, t0, 0x600           # mstatus.VS 使能
    csrw    mstatus, t0

    # ---- 页表构造(M 模式物理寻址) ----
    la      t0, L2TAB
    la      t1, L1TAB
    srli    t1, t1, 2               # 指针 PTE = ppn<<10 = addr>>2
    ori     t1, t1, 1               # V=1
    sd      t1, 16(t0)              # L2[2] -> L1TAB
    li      t4, 0x200000cf          # 2MB leaf PTE: (0x80000000>>2)|0xCF, pbmt=00
    la      t1, L1TAB
    sd      t4, 0(t1)               # L1[0]
    la      t2, L0TAB
    srli    t2, t2, 2
    ori     t2, t2, 1
    la      t1, L1TAB
    addi    t1, t1, 64
    sd      t2, 0(t1)               # L1[8] -> L0TAB
    la      t2, L0TAB
    la      t3, AMOPAGE
    srli    t3, t3, 2               # ppn<<10 = PA>>2
    li      t4, PBMT_PTE
    or      t4, t4, t3
    ori     t4, t4, 0xcf            # V|R|W|A|D
    sd      t4, 0(t2)               # L0[0]: NC 别名 -> AMOPAGE 物理页

    # ---- 开启 Sv39 ----
    la      t4, L2TAB
    srli    t4, t4, 12
    li      t5, 0x8000000000000000  # satp.mode = Sv39(8)
    or      t4, t4, t5
    csrw    satp, t4
    sfence.vma x0, x0

    # ---- Svpbmt 使能: menvcfg.PBMTE(bit15) ----
    li      t4, 0x4000000000000000  # menvcfg.PBMTE = bit62
    csrs    menvcfg, t4
    csrr    a3, menvcfg             # 回读进 a3, commit trace 可见

    # ---- PMP 放行 S 模式(默认 PMP 拒绝 S 访问, PTW 读 PTE 都会 fault) ----
    li      t4, 0x0f               # TOR, R|W|X
    csrw    pmpcfg0, t4
    li      t4, 0x100000000        # pmpaddr0 = 0x400000000>>2, 允许 0..16GB(勿越 2^40)
    csrw    pmpaddr0, t4

    # ---- 进 S 模式 ----
    la      t4, TRAPH
    csrw    stvec, t4
    la      t4, s_start
    csrw    mepc, t4
    csrr    t5, mstatus
    li      t6, 0xffffffffffffe7ff  # 清 MPP(bits12:11)
    and     t5, t5, t6
    li      t6, 0x800
    or      t5, t5, t6              # MPP = S
    csrw    mstatus, t5
    mret
    .endm

# FAIL 原因码先写进 a0(commit trace 可见 data), 再进 FAIL 自环(看门狗按
# 精确符号 "FAIL" 认 SELF_TEST_FAIL, 变体标签统一收敛到 FAIL)
#   1=mem值错 2=rd值错 3=scause=5 4=scause=7 5=scause=13 6=scause=15
#   7=其他scause 8=CSR一致性 9=向量区污染 10=未写vN被改 11=M模式意外trap
    .macro FAILC code
    li      a0, \code
    j       FAIL
    .endm

    .macro FAILIF_NE a, b, code
    beq     \a, \b, 90f
    li      a0, \code
    j       FAIL
90:
    .endm

# trap handler: S 模式触发的 trap 无委托, 进 M 模式 mtvec。
# 记录 mcause/mepc/mtval 到 SCAUSE, mepc+=4 跳过触发指令, mret 返回
    .macro S_TRAP_HANDLER
    csrr    t3, mcause
    la      t4, SCAUSE
    sd      t3, 0(t4)
    csrr    t5, mepc
    sd      t5, 8(t4)
    csrr    t5, mtval
    sd      t5, 16(t4)
    csrr    t3, mepc
    addi    t3, t3, 4
    csrw    mepc, t3
    mret
    .endm

# 检查 SCAUSE==0(未 trap); 否则按 scause 分发到对应原因码
    .macro CHECK_NO_TRAP
    la      t0, SCAUSE
    ld      t3, 0(t0)
    beqz    t3, 90f
    li      t4, 5
    beq     t3, t4, 91f
    li      t4, 7
    beq     t3, t4, 92f
    li      t4, 13
    beq     t3, t4, 93f
    li      t4, 15
    beq     t3, t4, 94f
    li      a0, 7
    j       FAIL
91: li      a0, 3
    j       FAIL
92: li      a0, 4
    j       FAIL
93: li      a0, 5
    j       FAIL
94: li      a0, 6
    j       FAIL
90:
    .endm

    .macro COMMON_DATA
    .section .data
    .balign 4096
L2TAB:  .space 4096
    .balign 4096
L1TAB:  .space 4096
    .balign 4096
L0TAB:  .space 4096
    .balign 4096
AMOPAGE: .space 4096
    .balign 8
SCAUSE: .space 32
    .endm
