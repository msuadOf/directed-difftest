# F2 最小化阶梯 m4 (裸最小): 连 tselect 写也去掉 (复位 tselect=0), 两句核心: li + csrw
#meta: case=min4_no_tselect var=minimize step=4 mtvec=none readback=none tselect=reset-default action=1 dmode=0 tdata1_wdata=0x6000000000001044

    .section .text
    .globl _start
_start:
    li      t0, 0x6000000000001044
    csrw    0x7a1, t0                     # tdata1 write (slot0) -> 预期写拍 ABORT
    j       GOODTRAP

    .align 2
GOODTRAP:
    .word 0x0000006b
