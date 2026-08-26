# C — PMP 高索引(≥2)条目 deny 不被执行(emu 与随附 NEMU 二进制共享)【记录点, 不计原创】

**定性(2026-08-26 三次修正后的终版)**: 最初判"TOR 从不匹配"为原创 bug → 上游指出上报用例 pmpaddr 编码丢位(0x2000400 应为 0x20000400) → 本地复核 agent 矩阵重测定性: **deny 条目放在 entry 索引≥2 时不被执行(TOR/NAPOT 皆然), 放 entry 0/1 时正常拦截; emu 与随附 NEMU REF 二进制共享此行为**。另发现 **pmpcfg0 byte≥3 写入: DUT 接受(规范正确) vs NEMU 二进制丢弃 → difftest ABORT**, DUT 对 REF 错, NEMU 侧 bug 候选。

## 复现(从源码)
```
make run       # f_s_tor_midregion_load.S: deny@e2 → 双模型放行 → SELF_TEST_FAIL(无 trap)
               # 注意: 该用例 pmpaddr 亦含历史编码丢位, 保留原样; 判定以下述矩阵为准
make control   # c_prio_napot_e0_allow_e1_deny_s_load.S: deny@e1 → 双模型拦截 → GOODTRAP
```
干净复验矩阵(编码修正+CSR 写回校验+--dump-ref-trace 直证 NEMU 行为, 不依赖 ABORT 推断): artifacts/T-tor-shared-deviation-audit/(n1 TOR@e2 放行 / n5 TOR@e1 拦截 / n6 NAPOT@e2 放行 / n7 NAPOT@e1 拦截 / d3-d4 byte3 写入分歧)。

## 关键证据
- n5 vs n1: 同一 S-mode lw 0x80001800, deny 条目同区域同权限, 仅差 entry 索引(e1 拦/e2 放行); pmpcfg0 回读 0x88000F 确认写入
- n1 的 REF 侧直证: NEMU trace 显示 S-mode(mode:1)实际读出载荷 0x5a5a5a5a, 全程 0 条 "isa pmp check failed"; n5 的 REF 侧同路径报 paddr.c:305 拒绝
- NEMU master 源码(OpenXiangShan/NEMU)静态读正确(TOR 无条件用 pmpaddr[i-1], 最低索引优先)——**随附二进制旧于 #1012, 与源码不符**; 上报 NEMU 须注明二进制版本
- 探针特权级已三重验证为 S-mode(M-only csrr 触发 cause=2、ecall cause=9、MPP=1)

## 上报建议
- 报 XiangShan: n5/n1/n6 矩阵(deny@e2 不生效; RTL 静态读 PMP.scala 正确, 运行时不生效根因未定位, 候选 checker 接线/构建参数)
- 报 NEMU: 同矩阵 REF 侧行为 + d3/d4 byte≥3 写入丢失(二进制, 非源码)

## 教训(pmpaddr/pmpcfg 编码陷阱)
- pmpaddr 单位 4 字节: 物理地址 >>2, 十六进制字面量易丢位(0x80001000>>2=0x20000400 不是 0x2000400)
- pmpcfg A 字段在 bits[4:3]: 0x0F=A=OFF 非 TOR RWX; TOR=0x08/NA4=0x10/NAPOT=0x18
- "无 ABORT ⇒ NEMU 同意"不可靠(trap 事件豁免比对、GOODTRAP 伪阴性先例); NEMU 行为要 --dump-ref-trace 直证
