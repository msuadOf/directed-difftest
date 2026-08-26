# B — PBMT(NC/IO) 页取指 InstrUncache 返回 0x0, 误报 illegal instruction

**定性**: 非 RTL bug、非 difftest 伪影 —— NC 非一致性语义与 NEMU 平坦内存模型的固有分歧。有意思的记录点, 不计原创 ISA bug。

## 复现(从源码)
```
make run   # 编译 min01.S 并跑 difftest
           # 预期 ABORT: 经 pbmt=01(bit61, NC) 页取指, DUT 译码 illegal 落 trap,
           # 首分歧 mode/mepc different(wrong 侧 mepc=0x40000000 即 NC 页 VA), REF 正常执行
```

## 现象与根因链(注入点定位, 2026-08-26)
- 页表项 pbmt≠0(NC), 页内指令是运行时拷贝进去的; 经该页取指: emu 的 InstrUncache D 通道返回 0x0 → illegal(mcause=2); NEMU 返回真实指令 → ABORT, 100%
1. 指令数据在 PTE 改 NC **之前**经普通 cached store 写入, 脏行停留 L2, 从未写回 DRAM(全时间窗 L2 无 AW)
2. NC 取指走旁路: AR 经 chi_llcBridge 到 **DRAM 通路**(非 mmioBridge 外设口), 读回 DRAM 复位值 0 —— RTL 返回了"真实"内容
3. ISA(Svpbmt)不保证 C 与 NC 访问间一致性, 软件需 fence/cbo.flush; NEMU 单一平坦内存天然"一致" → 必然分歧

## 鉴别证据(injection-point-analysis/, 原始 VCD 在 artifacts/F-l2-membacktype-mm-read-zero-injection-point/)
- `llc_wb.csv`: 全窗口无 L2 写回 → DRAM 中该处确为 0
- `nc_store_wb.csv` / `axi_periph.csv`: 对照 NC 页 store+load 都走 uncache, store 直写 DRAM, load 读回真值 —— 排除"后端对不同事务返回不同"的伪影解释
- 未测后续方向: 拷贝后先 cbo.flush 再取指, 若仍返 0 才是通路 bug

上游关联: #6134(PBMT-IO 取指投机串行化, 现象不同)、#6393(X=0 页 PC 报告, 无关)。
原始产物: artifacts/F-pbmt-ifetch-uncache-path/。
