# E — 已提交的 cached store 对同地址 NC 别名 load 不可见

**定性**: RTL bug, 同地址存储可见性违例(difftest ABORT)。**原创 3/3**(2026-08-26 查重无同类: #5851 是 LSU 跨页转发缺陷且 fence 可恢复; #6060 是 NC 页 cbo 误 fault 指令级异常; NEMU #1180 是同根因的取指姊妹篇, 当日自报且明示不主张 RTL bug)。

## 复现(从源码)
```
make run       # m_min.S: 同一物理地址双别名(cached 页 + NC 页), S-mode
               # cached 页 sw 0x11223344(已提交) → NC 页 lwu 读同物理地址
               # 预期 ABORT first-div: a5 ref=0x11223344 dut=0x0(DUT 读回旧值)
make control   # 对照 cbo_flush.S: store 后先 cbo.flush 逐出 dirty 行再 NC 读
               # → GOODTRAP(证明缺逐出/侦听, 非丢数据)
```

## 现象与规范依据
- dirty 行驻留 DCache 未写回, NC load 走 Uncache 直读主存, 读回旧值 0; 10+ 例同 cyc 确定性复现
- 单向: 只有"cached 写 → NC 读"不可见; fence/长延迟/预读均不恢复; cbo.flush 逐出后恢复
- 判据(成文规范): Svpbmt 中 NC 仍是主存属性; RVWMO/PPO 要求同地址 store→load 有序可见, NC 旁路不能跳过未写回的 dirty 行 —— 这是同地址可见性违例, 不是跨地址 C/NC 非一致性(后者才需软件 fence, 见 findings/B 的记录)

## 证据
原始产物 artifacts/T-nc-alias-store-invisibility/(variant1-6: 方向矩阵/延时/fence/cbo 系列, summary.tsv); 波形在 variant6。
