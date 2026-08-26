# findings/ — 确认/记录的 bug 归档

每个 bug 一个自包含子目录: 结论说明(README.md) + 最小复现 ELF/.S + 关键证据(日志/波形/波形抽取 CSV)。
原始全量中间产物在 artifacts/<疑点id>/,这里只留结论级证据。

| 目录 | bug | 定性 | 原创性 |
|---|---|---|---|
| B-pbmt-ifetch-nc-bypass | PBMT(NC/IO) 页取指 InstrUncache 返回 0x0 → 误报 illegal | NC 非一致性语义 × NEMU 平坦内存, 非 RTL bug | 不计原创(记录点) |
| C-pmp-tor-never-match | PMP TOR 条目从不匹配任何地址(锁定项对 M-mode 取指/访存全失效) | RTL bug, 波形定案 | **原创 1/3** |

已排除未归档: 非对齐 MMIO load mcause 5-vs-4(同 #3829/#3844/#6265, 官方定性有意设计)、NC 页向量访存 fault(同 #6060 家族)、mnscratch 无复位垃圾(同 #3882)、NEMU REF 侧缺陷若干。详见 hypotheses/known-issues.json。
