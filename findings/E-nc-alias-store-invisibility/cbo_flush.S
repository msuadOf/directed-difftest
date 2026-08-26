#meta: variant=cbo_flush var=cbo.flush change=sw(pbmt00)后对pbmt00别名VA做cbo.flush再NC lwu purpose=区分缺逐出vs逐出丢数据
# 注: 若 cbo 非法, S_TRAP_HANDLER 记录 scause 后跳过; CHECK_NO_TRAP 给原因码(scause=2 -> code 7)
    .include "common2.inc"
    .section .text
    .globl _start
_start:
    M2S_SETUP
s_start:
    la      t0, AMOPAGE
    li      t1, 0x11223344
    sw      t1, 0(t0)
    cbo.flush 0(t0)                  # 逐出/清刷 pbmt=00 别名 cache 行
    li      a4, 0x81000000
    lwu     a5, 0(a4)
    li      t4, 0x11223344
    FAILIF_NE a5, t4, 2
    CHECK_NO_TRAP
    j       GOODTRAP
FAIL:
1:  addi    t6, t6, 0
    j       1b
    .balign 4
GOODTRAP:
    .word 0x0000006b
    .balign 4
TRAPH:
    S_TRAP_HANDLER
    COMMON_DATA
