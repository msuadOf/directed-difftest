# C — PMP TOR deny 条目不被执行(DUT 与 NEMU 共享偏离, 非计数 bug)

**定性: 证伪为"原创 DUT bug", 改判共享偏离记录点。** 上游维护者指出原上报文件 pmpaddr 编码错误(`0x2000400` 少一位, 实际区域 ×16 偏移)。本地复验(2026-08-26, 全部经 pmpcfg0 写回校验 0x88000F + mcause 槽取证 0x77=无 trap):
- 正确编码下 NAPOT deny(L=1, R0W0X0)对 S-mode load 生效(双模型一致 trap, GOODTRAP)
- 正确编码下 TOR deny(L=1, [0x80001000,0x80002000))对 S-mode load **不生效** —— 且 difftest 全程无 ABORT ⇒ **NEMU 同样不执行 TOR deny**(规范 Priv 1.12 §3.7 要求 TOR 生效)
- 结论: 双模型共享偏离, difftest 结构性不可见, 不计原创; 值得分别报 XS 与 NEMU

## 复现(从源码)
```
make run       # f_s_tor_midregion_load.S: SELF_TEST_FAIL(无 trap; 注意此用例 pmpaddr
               # 亦含 0x2000400 编码问题, 保留原样作历史; 判定以 verify 矩阵为准)
make control   # c_prio_napot_e0_allow_e1_deny_s_load.S: GOODTRAP(NAPOT deny 生效对照)
```
干净复验矩阵(编码修正+写回校验): artifacts 路径见 hypotheses/known-issues.json 条目。

## 教训(pmpaddr 编码陷阱)
- pmpaddr 单位是 4 字节: 物理地址必须 >>2 后写入, 十六进制字面量极易丢位(0x80001000>>2 = 0x20000400, 不是 0x2000400)
- pmpcfg A 字段是 bits[4:3]: 0x0F = A=OFF(RWX 位无效), TOR=0x08, NA4=0x10, NAPOT=0x18
- 本仓库历史用例中两种错误都出现过, 复用 PMP 用例前先核对这两点
