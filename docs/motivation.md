# 动机：2026-08-21 三个疑点的实测案例

本工作流直接来源于对 XiangShan（kunminghu-v3, commit 7bf51a8, MinimalConfig VLEN=128）三个 RTL 疑点的实测验证。三个疑点恰好各落三分类结论之一；其中 **S1 的发现过程**（原命题被证伪后继续追问异常路径状态一致性，结果在掩盖路径里抓到真 bug）直接塑造了本工作流的流程设计——"一致性追问"因此成为无条件步骤。完整发现过程见下文 S1 一节。

对应输入示例见 `hypotheses/examples/vstart-vxsat-vlen.json`。

## S1（真实 bug，藏在掩盖路径里）

疑点 `VIAluFix.scala:105` 把传给 MGU 的 vstart 硬编码为 `0.U`，预期恢复执行时重算 vstart 之前的元素。

### 发现过程（本工作流 Phase 1-3 的原型）

1. **从疑点构造用例（假设演绎）**：按原疑点写 `csrw vstart, 2` + 向量算术指令的汇编自检用例，预期"元素 0 被重算"会在 emu 与 NEMU 间产生向量寄存器分歧。跑了真实 emu vs NEMU DiffTest。
2. **首测证伪原假设，但没停在这里**：全部 GOODTRAP 无 diff。原因随后由静态阅读确认——掩盖机制 `VecExceptionGen.scala:280` 把 isVArith && vstart≠0 一律判 illegal instruction，指令在提交前被 flush，根本不会带非零 vstart 进入 VIAluFix。原命题"被完全掩盖"。**关键选择：测试通过后继续追问"异常路径之后架构状态是否一致"，而不是收工。**
3. **一致性追问抓到分歧（真 bug 现形）**：在 illegal trap 返回（mret）之后再执行 `vmv.x.s a0, v3` 读回向量寄存器——DUT 提交 `0xffffffff00000055`，NEMU 为 `0x55`，高 32 位是典型的 tail-agnostic 式全 1 污染，DiffTest 直接 ABORT。证据取自 emu 提交跟踪日志（`-b/-e`，直接记录了污染的写回 data）。
4. **变量控制循环收敛根因**：
   - 换 vstart=1/2、换 vadd.vv/vsadd.vi 均复现 → 排除单指令偶然；
   - 决定性实验（t16）：trap 由 v4 上的指令触发，读**从未被写过的 v3** 仍失败 → 污染不是写错目标寄存器，而是经 trap flush/恢复路径扩散到向量读旁路/检查点（归因 bypass-checkpoint-pollution）；
   - 最小用例时通时不通 → 竞态特征（0<repro_rate<1）。

### 结论与副产物

- 原 bug（VIAluFix 重算元素 0）在架构层面不可达；真 bug 在掩盖它的异常路径里（trap 后向量状态污染）。
- 副产物：sew=64 + vsadd.vi + vstart=1 使 emu glibc 崩溃（疑 difftest 事件缓存溢出）；emu 编译未含波形支持，取证只能靠提交跟踪。（**更新 2026-08-23**：emu 已用 `EMU_TRACE=1` 重编支持波形，见 `docs/workflow-detailed.md` 环境信息一节；此条历史记录保留原状描述当时约束。）
- **根因修正（2026-08-21 后续隔离对照）**：独立复现包（`examples/vstart-trap-vmv-repro/`，`make controls`）证明 **ta,ma 策略才是必要条件**——`e32,m1,ta,ma` 下即使 vstart=0 且无任何前置向量 ALU 指令，`vmv.x.s` 读回同样错值；同路径换 `tu,mu` 则 GOODTRAP。即非零 vstart 和 trap 都不是必要条件，本例展示的是 MinimalConfig emu 的 ta,ma tail 填充与 NEMU 分歧。

## S2（机制天然规避）

疑点 `NewCSR/Unprivileged.scala:106` 先处理 CSR 软件写 vxsat、再用 `robCommit.vxsat` OR 覆盖（Rob.scala:765 同组 OR），预期 `csrw vxsat, x0` 与饱和向量指令同组退休时清零失效。

- **规避机制**：CSR 指令解码为 `noSpec+blockBack`（DecodeUnit.scala:210-216），csrw 只在成为 ROB 队头后发射，软件写落盘比 robCommit OR 至少晚一拍，时间上不重叠。
- **验证**：36 个用例（0-8 nop 间距、正反序、压力循环，经 vcsr 0x00f 别名路径等价覆盖——直接访问 0x009 在 emu/NEMU 均抛 illegal）全部 GOODTRAP；灵敏度对照（不执行清零指令确认 vsadd 确实置位 vxsat）证明用例有效。
- **教训**：`Unprivileged.scala:106` 的"旧值 OR"写法仍然脆弱，属"当前正确但依赖另一处机制"，Skeptic 对这类结论要逐行核对机制代码在所有路径上成立。

## S3（当前配置不可达）

疑点 `ByteMaskTailGen.scala` 把 maxVLMAX 硬编码为 8*16=128（带 TODO: parameterize）。

- **静态推导**：VLEN=128 时元素数上限 = 128*8/8 = 128 恰好等于位图宽度，最坏组合 SEW=8/m8/vl=128 精确占满不溢出。
- **动态验证**：极限用例（SEW=8/m8/vl=128 带 0x0F0F 掩码的 vadd、vl=100 的 ta/tu/mu 尾部、vstart=7）emu vs NEMU 全过。
- **何时暴露**：VLEN=256 时 `Mgu/NewMgu` 实例化 `prestartEn((i+1)*32-1, i*32)` 在 i≥4 越界切片，Chisel elaboration 直接编译失败（非静默错误）；参数化方案 `8*(vlen/8)`。

## 待验证的副产品疑点

- `csrw vstart` 位于 vsetvli 之前时，emu 把后续 masked vadd 当作 vstart≥vl（寄存器保持旧值），NEMU 正常写——疑 vsetvli 的 flushPipe 吞掉前一条 vstart CSR 写。
- `vsetvli zero, zero, ...`（AVL=vl 形式）触发 vtype 比对 abort（NEMU 侧显示 vill）。

（两例均可作为本工作流的输入直接复跑。）
