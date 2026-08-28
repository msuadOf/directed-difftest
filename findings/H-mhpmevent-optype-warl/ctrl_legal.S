#meta: H-control OPTYPE=4(合法值) 写读回应保持
    .option norvc
    .section .text
    .globl _start
_start:
    li      t0, 0x0010000000800021   # OPTYPE0=4(合法)|EVENT0=0x21
    csrw    0x323, t0                # mhpmevent3
    csrr    t1, 0x323
    .rept 24
    nop
    .endr
    j       GOODTRAP
    .align 2
GOODTRAP:
    .word 0x0000006b
