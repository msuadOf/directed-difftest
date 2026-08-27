# C — "PMP TOR 失效" 系列【最终判: 测试伪象, 双模型 PMP 实现均正确, 无 bug】

**三修终版(2026-08-27, 插桩 master NEMU 直证)**: 本目录历史结论("TOR 从不匹配"→"索引≥2 条目不生效"→"双模型共享偏离")全部为**测试方编码/语义误读**, 撤销。

## 两个连环误读
1. **pmpcfg 0x0F 不是 A=OFF**: bit3 属于 A 字段(bits[4:3]), 0x0F = A=01(TOR)+RWX, 即 "TOR RWX allow-all"——用它当 e0 会盖住全部地址
2. **PMP 优先级是最低编号匹配条元优先**(Priv 1.12 §3.7): e0 allow-all 匹配一切后, 高编号 deny 条目根本不会被查询。"deny@e2 不生效"正是 e0 盖住的正常表现; c_prio 之所以 deny 生效, 是其 e0 上界恰止于 0x80001000, DENY_DATA(0x80001040)落在界外

## 直证手段(可复用)
master NEMU(自编, kunminghu-v3-ref config)插桩 pmp_check 打印匹配条目:
`[PMPDBG] entry 0 matched addr=0x8000180 lower=0 tor=0x0000fffffffff000 cfg=0f ...` → e0 匹配并 allow, 循环 break, e2 从未被查询。NEMU 源码 mmu.c:158 mmu_refresh_pmp_cache 的 TOR lower 继承无条件、优先级首匹配即出——与规范一致; XiangShan PMP.scala 同语义。

## 结论
- XiangShan emu 与 NEMU(master 及随附二进制)的 PMP(TOR/NAPOT/优先级/锁定/粒度)在本构建行为一致且符合规范, **无原创 bug 可计**
- 历史上游维护者指出的 pmpaddr 丢位(0x2000400)也属实, 属同一系列用例质量事故
- 教训沉淀见 memory: pmpaddr>>2、A 字段位序、**优先级最低编号优先**、勿手搓编码、插桩 REF 是分歧判定的终极手段

## 复现(从源码)
```
make run       # f_s_tor_midregion_load.S: SELF_TEST_FAIL(含历史编码错误, 留档)
make control   # c_prio...: GOODTRAP(NAPOT deny 在 e0 未覆盖区生效)
```
