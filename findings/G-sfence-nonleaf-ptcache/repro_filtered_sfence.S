#meta: suspicion=W3-sfence-nonleaf-leak case=w3f1 stage=S_smode_sv39 asid=5 fence=rs1va_rs2x0 repoint=L1ptr_0x80305000_to_0x80306000 leafflags=0xCF_G0_A1D1 target_va=0x80401000 expect=ABORT_r2_0x5A_vs_0x70
# W3-sfence t1 (首测): 纯 S-stage (无虚拟化), satp=Sv39/ASID5。L1[2] 非叶指针重定向
# (0x200C1401->0x200C1801, 经 L1[1] 恒等自映射 VA 0x80304010 改写) + 过滤 sfence.vma
# rs1=VA rs2=x0 (PageTableCache.scala sfence_valid 块 .otherwise/.when(rs2) 分支: 只清
# l0v/spv, l1v/l2v 不动)。sfence 后 R2 load 应重走新表得 0x70; DUT 若 l1v 陈旧 -> 旧表
# -> PA 0x80401000 得 0x5A -> ABORT。叶 PTE 用 0x8F (G=0), rs2=x0 分支全 ASID 无 G 歧义。
    .section .text.init
    .globl _start
_start:
    la      t0, TRAPH
    csrw    mtvec, t0
    la      t0, STRAPH
    csrw    stvec, t0
    la      t0, RESUME_SLOT
    la      t1, SETUP_FAIL
    sd      t1, 0(t0)
    la      t0, TRAPCNT
    sd      zero, 0(t0)
    li      t0, 0x800               # mstatus.MPP = S
    csrw    mstatus, t0
    li      t0, -1                   # PMP: TOR [0,~all) RWX L=1
    srli    t0, t0, 8
    csrw    pmpaddr0, t0
    li      t0, 0x9F
    csrw    pmpcfg0, t0
    # tables @ PA 0x80300000
    li      t0, 0x80300000           # root[2] -> L1 0x80304000 (non-leaf)
    li      t1, 0x200C1001
    sd      t1, 16(t0)
    li      t0, 0x80304000           # L1[0] 2MB identity leaf (code+buffers 0x80000000-0x801FFFFF)
    li      t1, 0x200000CF
    sd      t1, 0(t0)
    li      t1, 0x200800CF           # L1[1] 2MB identity leaf (tables 0x80200000-0x803FFFFF, 自映射)
    sd      t1, 8(t0)
    li      t1, 0x200C1401           # L1[2] non-leaf -> OLD L0 0x80305000
    sd      t1, 16(t0)
    li      t0, 0x80305000           # OLD L0[1] 4K leaf -> PA 0x80401000 (0x5A), G=0 A=1 D=1 (0xCF)
    li      t1, 0x201004CF
    sd      t1, 8(t0)
    li      t0, 0x80306000           # NEW L0[1] 4K leaf -> PA 0x80601000 (0x70), G=0 A=1 D=1 (0xCF)
    li      t1, 0x201804CF
    sd      t1, 8(t0)
    li      t0, 0x80401000
    li      t1, 0x5A5A5A5A5A5A5A5A
    sd      t1, 0(t0)
    li      t0, 0x80601000
    li      t1, 0x7070707070707070
    sd      t1, 0(t0)
    li      t0, 0x8000500000080300   # satp = SV39, ASID 5, PPN 0x80300
    csrw    satp, t0
    sfence.vma zero, zero
    la      t0, SMAIN
    csrw    mepc, t0
    mret                            # -> S-mode
    .balign 4
SMAIN:
    li      a1, 0x80401000           # VA_A
    li      a0, 0x0BAD0010
    lwu     a0, 0(a1)               # R1 (fresh pc): warm PTW (l2v<-root[2], l1v<-L1[2]=old, L1-TLB leaf<-old)
S_AFTER_R1:
    li      t0, 0x5A5A5A5A
    bne     a0, t0, FAIL_R1
    # repoint S L1[2] via identity-mapped VA 0x80304010
    li      t0, 0x80304010
    li      t1, 0x200C1801          # L1[2] -> NEW L0 0x80306000
    sd      t1, 0(t0)
    sfence.vma a1, zero             # rs1-filtered: addr 0x80401000, rs2=x0 (all asid)
    la      t0, RESUME_SLOT
    la      t1, S_AFTER_R2
    sd      t1, 0(t0)
    li      a2, 0x0BAD0011
    lwu     a2, 0(a1)               # R2 (fresh pc): expect 0x70; DUT-stale l1v -> 0x5A -> ABORT
S_AFTER_R2:
    li      t0, 0x70707070
    bne     a2, t0, FAIL_R2
    j       GOODTRAP
FAIL_R2:
1:  addi    t6, t6, 0
    j       1b
FAIL_R1:
1:  addi    t6, t6, 0
    j       1b
SETUP_FAIL:
1:  addi    t6, t6, 0
    j       1b

    .balign 4
TRAPH:                              # medeleg=0: all traps -> M; record + resume
    la      t5, TRAPINFO
    csrr    t6, mcause
    sd      t6, 0(t5)
    csrr    t6, mtval
    sd      t6, 8(t5)
    la      t5, TRAPCNT
    ld      t6, 0(t5)
    addi    t6, t6, 1
    sd      t6, 0(t5)
    la      t5, RESUME_SLOT
    ld      t6, 0(t5)
    csrw    mepc, t6
    mret

    .balign 4
STRAPH:                             # unexpected (medeleg=0)
    la      t5, STRAPINFO
    csrr    t6, scause
    sd      t6, 0(t5)
    la      t5, TRAPCNT
    ld      t6, 0(t5)
    addi    t6, t6, 1
    sd      t6, 0(t5)
    la      t5, RESUME_SLOT
    ld      t6, 0(t5)
    csrw    sepc, t6
    sret

    .align 2
GOODTRAP:
    .word   0x0000006b

    .section .data
    .balign 8
TRAPINFO:
    .space  16
TRAPCNT:
    .space  8
RESUME_SLOT:
    .space  8
STRAPINFO:
    .space  16
