# findings/ — 确认/记录的 bug 归档

每个 bug 一个自包含子目录, **从 .S 源码开始可复现**(make run 编译+跑 difftest+机检判定; 对照用例 make control)。目录内不放预编译 ELF, VCD 波形留在 artifacts/ 原地。

| 目录 | bug | 定性 | 原创性 |
|---|---|---|---|
| B-pbmt-ifetch-nc-bypass | PBMT(NC/IO) 页取指 InstrUncache 返回 0x0 → 误报 illegal | NC 非一致性语义 × NEMU 平坦内存, 非 RTL bug | 不计原创(记录点) |
| C-pmp-tor-never-match | PMP TOR 条目从不匹配任何地址(锁定项对 M-mode 取指/访存全失效) | RTL bug, 波形定案 | **原创 1/3** |

已排除未归档: 非对齐 MMIO load mcause 5-vs-4(同 #3829/#3844/#6265, 官方定性有意设计)、NC 页向量访存 fault(同 #6060 家族)、mnscratch 无复位垃圾(同 #3882)、NEMU REF 侧缺陷若干。详见 hypotheses/known-issues.json。
