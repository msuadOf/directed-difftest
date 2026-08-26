# R7 v2 minimization: N rdtime reads between stimecmp write and STCE clear
#meta: id=R7-v2M1 var=rdtime_count varvalue=1
    .section .text
    .globl _start
_start:
    la      t0, TRAPH
    csrw    mtvec, t0
    li      t1, 1
    slli    t1, t1, 63
    csrw    menvcfg, t1
    csrw    stimecmp, zero
    csrr    t2, time
    csrw    menvcfg, zero
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
