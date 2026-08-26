# findings/ — 确认/记录的 bug 归档

每个 bug 一个自包含子目录, **从 .S 源码开始可复现**(make run 编译+跑 difftest+机检判定; 对照用例 make control)。目录内不放预编译 ELF, VCD 波形留在 artifacts/ 原地。

## 原创达标 (3/3, 2026-08-26)

| 目录 | bug | 定性 | 原创性 |
|---|---|---|---|
| C-pmp-tor-never-match | PMP TOR 条目从不匹配任何地址(锁定项对 M-mode 取指/访存全失效) | RTL bug, 波形定案 | **原创 1/3** |
| D-sstc-stce-clear-drops-pending-stip | 清 menvcfg.STCE 同拍撤销已 pending 的 STIP | RTL bug, Sstc 规范违例 | **原创 2/3** |
| E-nc-alias-store-invisibility | 已提交的 cached store 对同地址 NC 别名 load 不可见 | RTL bug, 同地址可见性违例 | **原创 3/3** |

## 记录点(不计原创)

| B-pbmt-ifetch-nc-bypass | PBMT(NC/IO) 页取指 InstrUncache 返回 0x0 → 误报 illegal | NC 非一致性语义 × NEMU 平坦内存, 非 RTL bug | 记录点 |

已排除未归档: 非对齐 MMIO load mcause 5-vs-4(同 #3829/#3844/#6265, 有意设计)、NC 页向量访存 fault(同 #6060 家族)、mnscratch 无复位垃圾(同 #3882)、satp 写后 TLB 陈旧(规范允许, NEMU 更严)、mip.VSSIP 写穿/NEMU mcounteren(双模型一致)、sie.STIE RO-0(mie 别名规避)、mtvec WARL(isLegal 门控同 NEMU)、NEMU REF 侧缺陷若干。详见 hypotheses/known-issues.json。
