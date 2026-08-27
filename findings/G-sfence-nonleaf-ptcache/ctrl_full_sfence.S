#meta: suspicion=W3-sfence-nonleaf-leak case=w3f3 stage=S_smode_sv39 asid=5 fence=full_rs1x0_rs2x0 repoint=L1ptr_0x80305000_to_0x80306000 leafflags=0xCF_G0_A1D1 target_va=0x80401000 expect=GOODTRAP_r2_0x70_plus_consistency
# W3-sfence t3 (灵敏度对照+一致性追问): 同 t1 搭建, 但 sfence.vma zero,zero (全量)。
# 全量路径 (bits.rs1=1) 会清 l1v/l2v -> 两侧都重走新表 -> R2=0x70 -> GOODTRAP。
# 若本用例 ABORT/FAIL: 页表搭建错误或另有 bug, t1 的 ABORT 不能归因 l1v。
# 一致性: satp 写后读回一致、TRAPCNT==0、R1(0x5A)与R2(0x70)不同证映射确实切换。
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
    li      t0, 0x800
    csrw    mstatus, t0
    li      t0, -1
    srli    t0, t0, 8
    csrw    pmpaddr0, t0
    li      t0, 0x9F
    csrw    pmpcfg0, t0
    li      t0, 0x80300000           # root[2] -> L1 0x80304000
    li      t1, 0x200C1001
    sd      t1, 16(t0)
    li      t0, 0x80304000
    li      t1, 0x200000CF           # L1[0] identity leaf (code)
    sd      t1, 0(t0)
    li      t1, 0x200800CF           # L1[1] identity leaf (tables)
    sd      t1, 8(t0)
    li      t1, 0x200C1401           # L1[2] -> OLD L0
    sd      t1, 16(t0)
    li      t0, 0x80305000           # OLD L0[1] -> PA 0x80401000 (0x5A)
    li      t1, 0x201004CF
    sd      t1, 8(t0)
    li      t0, 0x80306000           # NEW L0[1] -> PA 0x80601000 (0x70)
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
    mret
    .balign 4
SMAIN:
    li      a1, 0x80401000
    li      a0, 0x0BAD0010
    lwu     a0, 0(a1)               # R1: warm -> old path 0x5A
S_AFTER_R1:
    li      t0, 0x5A5A5A5A
    bne     a0, t0, FAIL_R1
    li      t0, 0x80304010           # repoint L1[2]
    li      t1, 0x200C1801
    sd      t1, 0(t0)
    sfence.vma zero, zero            # FULL: l1v/l2v 也清 -> 必然重走新表
    la      t0, RESUME_SLOT
    la      t1, S_AFTER_R2
    sd      t1, 0(t0)
    li      a2, 0x0BAD0011
    lwu     a2, 0(a1)               # R2: both -> 0x70
S_AFTER_R2:
    li      t0, 0x70707070
    bne     a2, t0, FAIL_R2
    li      t0, 0x5A5A5A5A          # 一致性: R1 仍是旧值 (映射确实在 R1/R2 之间切换)
    bne     a0, t0, FAIL_R1VAL
    csrr    t2, satp                # 一致性: satp 读回
    li      t3, 0x8000500000080300
    bne     t2, t3, FAIL_CSR
    la      t2, TRAPCNT             # 一致性: 全程无意外 trap
    ld      t2, 0(t2)
    bnez    t2, FAIL_TRAP
    j       GOODTRAP
FAIL_R2:
1:  addi    t6, t6, 0
    j       1b
FAIL_R1:
1:  addi    t6, t6, 0
    j       1b
FAIL_R1VAL:
1:  addi    t6, t6, 0
    j       1b
FAIL_CSR:
1:  addi    t6, t6, 0
    j       1b
FAIL_TRAP:
1:  addi    t6, t6, 0
    j       1b
SETUP_FAIL:
1:  addi    t6, t6, 0
    j       1b

    .balign 4
TRAPH:
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
STRAPH:
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
