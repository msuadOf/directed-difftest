# C — PMP TOR 条目从不匹配任何地址(锁定项对 M-mode 取指/访存全失效)

**定性**: RTL bug(波形+单侧判据定案)。**原创 1/3**(2026-08-26 gh 查重无同类: #6199 是 2 核且 NAPOT 同失效、#6161/#6162 是 grain 问题且 TOR 本身工作、#6139/#6141/#5872 是跨页 mtval 分歧, 现象均不同)。

## 现象
- TOR(top-of-range) 模式的 PMP 条目, 任意 L/deny/allow/索引/特权级/通路(load/store/取指)下**从不匹配任何地址**, 形同虚设; NAPOT/NA4 条目正常工作
- 表现形式: 配置锁定条目(L=1, X=0, TOR)覆盖代码区后, M-mode 取指穿过该区域 DUT 不产生 access fault(mepc/mcause 全 0), NEMU 按规范(Priv 1.12 §3.7, L=1 条目对 M-mode 同样生效)报 mcause=1 instruction access fault
- 确定性复现(seed=0), skeptic 复跑留档

## 证据
- `f_s_tor_midregion_load.S/.elf/.log` — S-mode TOR 中段区域 load, ABORT
- `d_e2_tor_4k_m_ifetch.*` — M-mode 4K TOR 取指用例(波形)
- 波形(VCD 未归档, 在 artifacts/T-mmode-pmp-locked-bypass/variant5/wave/ 与 variant2/wave*/): cycle2243/2297 frontend.inner_PMPChecker **res_pmp_is_match_2=0**(entry2 按 PMP.scala boundMatch 静态推演应命中 0x80001000)
- `variant5-summary.tsv` — 变体矩阵; `variant2/` — TOR/NAPOT 对照批(NAPOT 同 run 生效, TOR 全不匹配)

## 未闭合
源码-波形矛盾: PMP.scala 的 torMatch 静态推演应命中, 但波形 res_pmp_is_match=0 —— 需进一步定位是 boundMatch 逻辑还是上界寄存(pmpaddr[i-1])读取问题。关联: T-pmp-tor-na4-match-divergence(entry1 OFF 使 entry0 allow-all 失效、G=12 下 NA4 生效异常)与 T-itlb-pmp-stale-after-locked-pmpcfg-write(重定向取指仍不 fault), 可能同根因, 第四轮验证中。

复现 ELFs: 本目录 + artifacts/T-mmode-pmp-locked-bypass/、artifacts/F-nemu-mmode-pmp-window-load-store/。
