# R7 v3 variant F: same rdtime sequence but STCE never cleared; multiple time/mip samples
#meta: id=R7-v3F var=stce_clear varvalue=never_cleared samples=time+mip_x4
    .section .text
    .globl _start
_start:
    la      t0, TRAPH
    csrw    mtvec, t0
    li      t1, 1
    slli    t1, t1, 63
    csrw    menvcfg, t1          # STCE=1, stays
    csrw    stimecmp, zero       # pending
    csrr    t2, time
    csrr    t3, mip
    csrr    t2, time
    csrr    t3, mip
    csrr    t2, time
    csrr    t3, mip
    csrr    t2, time
    csrr    t4, mip
    la      t5, BUF
    sd      t4, 0(t5)
    j       GOODTRAP
    .align 2
GOODTRAP:
    .word 0x0000006b
    .balign 4
TRAPH:
    j       GOODTRAP
    .section .data
    .balign 8
BUF:
    .space  64
