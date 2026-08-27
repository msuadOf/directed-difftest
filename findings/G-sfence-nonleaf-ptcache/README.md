# G — 过滤型 sfence.vma / hfence.vvma/gvma 漏清非叶 PTW 缓存(l1v/l2v)

**定性**: RTL bug, ISA 可见旧映射。**原创 2/3**(2026-08-28 查重无同类: #3077 系"多清"、#5114 系 L1TLB 叶表项漏刷、#6053 系 onlyPf 假 IPF, 均不同现象; master 代码至今仍只清 l0v/spv 未修)。

## 复现(从源码, 需 master NEMU REF)
```
make run       # repro_filtered_sfence.S: sv39 下访问填缓存 -> M 态改两级 PTE(leaf 指向换 0x70 数据页,
               #   同时换非叶指针) -> sfence.vma rs1=VA, rs2=x0(过滤型) -> 重访
               # 预期 ABORT: a2 different ref=0x70707070 dut=0x5a5a5a5a(陈旧非叶指针服务 post-fence walk)
make control   # ctrl_full_sfence.S: 同序列但全量 sfence(rs1=x0,rs2=x0) -> GOODTRAP(全刷有效)
```
【REF 依赖】随附旧 NEMU 二进制对带址 fence 同为 no-op(共享偏离), 复现必须用 master NEMU:
`git clone OpenXiangShan/NEMU && make riscv64-xs-kunminghu-v3-ref_defconfig && make -j` → build/riscv64-nemu-interpreter-so, Makefile 的 REFBIN 变量指向它。

## 机制与证据
- PageTableCache.scala 三处过滤分支(rs1≠x0): :1142-1152(sfence) / :1187-1197(hfence.vvma) / :1219-1239(hfence.gvma) 只清叶级 l0v/spv, **不清 l1v/l2v** —— 陈旧非叶 PTE 指针项继续命中后续 PTW walk, 跳级不重读页表
- 实测 12/12 cycle-exact; 纯 l1v 变体(w3f6)同机制; hfence.gvma 腿(W3/variant2 w3j/w3k)同构; L2 容量挤出隔离、叶失效对照(缺陷限定非叶)全闭环(第七轮 workflow W3, artifacts/W3*)
- 判据来源: 成文规范(priv spec sfence.vma 语义——对 rs1 指定地址的后续访问必须见到已修改的叶与非叶 PTE)

## 上报建议
XiangShan issue: 三个过滤分支补清 l1v/l2v(带 rs1 过滤地址匹配); 附 w3f1/w3f3/w3f6 与 hfence 变体矩阵。
