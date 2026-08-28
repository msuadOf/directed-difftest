# H — mhpmevent OPTYPE 字段 WARL 违约(非法值原样读回)

**定性**: RTL bug, ISA 指令可触发(csrw+csrr 即现)。**候选 3/3(2026-08-28 查重原创: 由 PR #5841(2026-05)引入, kunminghu-v3 至今未修未报; 最近 #6127 是 EVENT 字段另一现象)**。裁量注记: OPTYPE(bits 54:40)是香山 vendor 扩展位而非 RISC-V 标准字段, 违反的是**自身 WARL legalValues 声明**(自声明 {0,1,2,4})+ 与 NEMU 的契约分歧——是否计入"原创 ISA bug"由裁定方定夺。

## 复现(从源码, 需 master NEMU REF)
```
make run       # min.S: csrw mhpmevent3=非法 OPTYPE(0x000c000000000000) 后 csrr
               # 预期 ABORT: t1 different ref=0x0000000000000000 dut=0x000c000000000000
make control   # ctrl_legal.S: OPTYPE=4(合法)写读回 -> GOODTRAP
```
【REF 依赖】同 G 号: 需 master NEMU(旧随附二进制写路径行为不同), Makefile REFBIN 指向之。

## 机制
- MachineLevel.scala:231-237 mhpmevents 匿名模块体 `when(wen){reg:=wdata}` 整包连接, chisel last-connect 压过 CSRModule 基类(CSRModule.scala:43/54)字段级 wen&&isLegal 保旧门
- 两条写路径均中: 直接 csrw mhpmeventN / S 态 siselect=0x44+csrw sireg2(Smcdeleg 间接)
- 29 实例(mhpmevent3-31)共享; NEMU 两侧均 keep-old(priv.c:2614-2636/2372-2390)
- 三轴圈定: 字段轴(OPTYPE0/1/2)×值轴(3/5 非法 vs 4/2 合法对照)×实例轴(mhpmevent3/4/16/31), trace_diff 38/38 控制流一致纯数据分歧, 复现率 1

## 证据
artifacts/FU-mhpm-event-wmask-50-56/(第八轮 workflow Q2/Q3, variant1-3 矩阵 + skeptic 复核)。
