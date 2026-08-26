# C — PMP TOR 条目从不匹配任何地址(锁定项对 M-mode 取指/访存全失效)

**定性**: RTL bug(波形+单侧判据定案)。**原创 1/3**(2026-08-26 gh 查重无同类: #6199 是 2 核且 NAPOT 同失效、#6161/#6162 是 grain 问题且 TOR 本身工作、#6139/#6141/#5872 是跨页 mtval 分歧, 现象均不同)。

## 复现(从源码)
```
make run       # 编译 f_s_tor_midregion_load.S 并跑 difftest
               # 预期 SELF_TEST_FAIL: S-mode load 打进 TOR deny 区 [0x80001000,0x80002000)
               # DUT 放行(用例自检断言应 trap 而没 trap, 看门狗认证 FAIL 自环)
make control   # 对照: 同构造换成 NAPOT deny(c_prio_..._s_load.S)
               # 预期 GOODTRAP: DUT 正常 trap, 证明失效是 TOR 特有, NAPOT 正常
```

## 现象
- TOR(top-of-range) 模式的 PMP 条目, 任意 L/deny/allow/索引/特权级/通路(load/store/取指)下**从不匹配任何地址**, 形同虚设; NAPOT/NA4 条目正常工作
- 表现形式: 配置锁定条目(L=1, X=0, TOR)覆盖代码区后, M-mode 取指穿过该区域 DUT 不产生 access fault(mepc/mcause 全 0), NEMU 按规范(Priv 1.12 §3.7, L=1 条目对 M-mode 同样生效)报 mcause=1 instruction access fault
- 确定性复现(seed=0)

## 证据(原始产物在 artifacts/T-mmode-pmp-locked-bypass/, VCD 波形未归档)
- 波形 variant5/wave/、variant2/wave88/: cycle2243/2297 frontend.inner_PMPChecker **res_pmp_is_match_2=0**(entry2 按 PMP.scala boundMatch 静态推演应命中 0x80001000)
- 变体矩阵: variant5/summary.tsv、variant2/summary.tsv(TOR 全不匹配, NAPOT 对照生效)
- 源码: xiangshan/src/main/scala/xiangshan/backend/fu/PMP.scala

## 未闭合
源码-波形矛盾: PMP.scala 的 torMatch 静态推演应命中, 但波形 res_pmp_is_match=0 —— 需进一步定位是 boundMatch 逻辑还是上界寄存(pmpaddr[i-1])读取问题。关联: T-pmp-tor-na4-match-divergence(entry1 OFF 使 entry0 allow-all 失效、G=12 下 NA4 生效异常)与 T-itlb-pmp-stale-after-locked-pmpcfg-write(重定向取指仍不 fault), 可能同根因, 第四轮验证中。

注意: `d_e2_tor_4k_m_ifetch.S`(M-mode 4K TOR 取指)是波形取证用例, 不在 make 目标里, 手动跑法同上。
