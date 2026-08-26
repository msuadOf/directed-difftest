# D — 清 menvcfg.STCE 同拍撤销已 pending 的 STIP

**定性**: RTL bug, ISA 可见中断丢失。**原创 2/3**(2026-08-26 查重无同类: 最近 #3937 是"stimecmp 写过去值 STIP 置不起"且定性为 Spike ref bug, 方向/触发/机理均不同)。

## 复现(从源码)
```
make run       # r7v3_M1.S: menvcfg 置 STCE → stimecmp 写 0(过去值, STIP pending)
               # → 读一次 time → 清 menvcfg.STCE → csrr mip
               # 预期 ABORT first-div: mip ref=0x20(STIP 保留) dut=0x0(被撤销)
make control   # 对照 r7v3_F_no_clear_timescan.S(不清 STCE) → GOODTRAP
```

## 现象与规范依据
- SstcInterruptGen.scala:34 把 `menvcfg.STCE` 直接与进 `o.STIP := stime>=stimecmp && STCE`
- 清 STCE 的同一拍, 已 pending 的 STIP 被强制拉低(波形 o_STIP 同拍翻转), pending 中断丢失; NEMU 保留 → ABORT 100%(r7v3_M1 确定性)
- 判据(成文规范, Sstc): STCE=0 只是把 S-mode timer 中断控制权交回 M-mode, mip.STIP 此后由执行环境决定; 已 pending 的中断不应因清 STCE 而撤销
- r7v3_M1.S 流程: STCE=1 → stimecmp=0 → csrr time(保证 pending 建立并可见) → menvcfg=0 → csrr mip 比较

## 证据
原始产物 artifacts/R7/(variant3 波形 wave/, verify_rerun skeptic 复跑, summary.tsv); 源码 xiangshan/src/main/scala/xiangshan/backend/fu/NewCSR/SstcInterruptGen.scala:34。
