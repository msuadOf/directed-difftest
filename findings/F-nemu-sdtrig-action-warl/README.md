# F — NEMU tdata1 ACTION=1 WARL 缺口(DUT 对 / REF 错)【NEMU 侧原创候选, 待用户裁定计数】

**定性**: NEMU(master 源码)bug, XS 正确。2026-08-27 查重 NEMU 仓库无同类(最近 #1067 是 chain/优先级且被"don't support dmode"关闭; XiangShan #4574 是只读位区差异)——**判原创**(若计数标准接受 NEMU 侧)。
风险提示: 上报可能再遇 "NEMU don't support dmode" —— 应强调本现象无需 debug mode 支持: 非 dmode 下写 ACTION=1 的**读回值本身**就是 ISA 可观测分歧, 与 trigger firing 无关。

## 复现(从源码)
```
make run   # min.S 两句核心: li t0,0x6000000000001044; csrw 0x7a1,t0
           # 预期 ABORT: tdata1 different right(REF)=0x6000000000001044 wrong(XS)=0x6000000000000044
```

## 规范依据与根因
- Sdtrig 规范(Sdtrig.adoc:59-62, must 级): 非 debug mode(dmode=0)下 ACTION=1(exception)不可保留, WARL 归 0
- XS: NewCSR trigger WARL 归 0 ✓ 正确
- NEMU master trigger.c:220/277/325/379 四处谓词形如 `action<=DEBUG_MODE ? wdata : BKPT`, 无 dmode 前置 → 写 ACTION=1 被保留 ✗
- 覆盖面: mcontrol6/etrigger/itrigger/icount 四类 trigger 同缺口
- 实测 5/5 复跑, 15 次双值观测; 触发形式不敏感(csrrw/li+csrw 同), tselect slot 无关

## 证据
原始产物 artifacts/F2-sdtrig-action1-warl-ref-div/(variant1-3 矩阵: action=1/2、enable 位、tselect1、minimize 阶梯)。
