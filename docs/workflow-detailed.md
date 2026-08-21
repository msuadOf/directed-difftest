# RTL 疑点定向 DiffTest 验证工作流（详细设计）

本文档是工作流的权威设计。Workflow 实现（`workflows/rtl-directed-difftest.js`）必须与本文一致；未来 agent 干活前必读本文。

## 动机：2026-08-21 三个疑点的实测案例

本工作流直接来源于对 XiangShan（kunminghu-v3, commit 7bf51a8, MinimalConfig VLEN=128）三个 RTL 疑点的实测验证，三个疑点恰好覆盖三分类结论，其中 S1 演示了"原命题被掩盖但掩盖路径藏真 bug"的关键场景：

**S1（真实 bug，藏在掩盖路径里）**：疑点 `VIAluFix.scala:105` 把传给 MGU 的 vstart 硬编码为 `0.U`，预期恢复执行时重算 vstart 之前的元素。
- Hypothesize 发现掩盖机制：`VecExceptionGen.scala:280` 把 isVArith && vstart≠0 一律判 illegal instruction，指令不会带非零 vstart 进入 VIAluFix——原命题"被完全掩盖"。
- Probe 首测（`csrw vstart, 2` + vadd → mcause=2 → mret）GOODTRAP 无 diff，但**一致性追问**（本工作流 Phase 2 的第 2 步由此而来）在 trap 返回后执行 `vmv.x.s a0, v3` 抓到真 bug：DUT 提交 `0xffffffff00000055`，NEMU 为 `0x55`，高 32 位是 tail-agnostic 式全 1 污染，DiffTest 直接 ABORT。
- Isolate 决定性实验（t16）：trap 由 v4 上的指令触发、读**从未被写过**的 v3 仍失败 → 污染不是写错目标寄存器，而是经 trap flush/恢复路径扩散到向量读旁路/检查点（归因 bypass-checkpoint-pollution）；最小用例时通时不通（0<repro_rate<1，竞态特征）。
- 副产物：sew=64 + vsadd.vi + vstart=1 使 emu glibc 崩溃（疑 difftest 事件缓存溢出）。

**S2（机制天然规避）**：疑点 `NewCSR/Unprivileged.scala:106` 先处理 CSR 软件写 vxsat、再用 `robCommit.vxsat` OR 覆盖（Rob.scala:765 同组 OR），预期 `csrw vxsat, x0` 与饱和向量指令同组退休时清零失效。
- Hypothesize 找到规避机制：CSR 指令解码为 `noSpec+blockBack`（DecodeUnit.scala:210-216），csrw 只在成为 ROB 队头后发射，软件写落盘比 robCommit OR 至少晚一拍，时间上不重叠。
- Probe 36 个用例（0-8 nop 间距、正反序、压力循环，经 vcsr 0x00f 别名路径等价覆盖——直接访问 0x009 在 emu/NEMU 均抛 illegal）全部 GOODTRAP；灵敏度对照（不执行清零指令确认 vsadd 确实置位 vxsat）证明用例有效。
- 教训：`Unprivileged.scala:106` 的"旧值 OR"写法仍然脆弱，属"当前正确但依赖另一处机制"，Skeptic 对这类结论要逐行核对机制代码在所有路径成立。

**S3（当前配置不可达）**：疑点 `ByteMaskTailGen.scala` 把 maxVLMAX 硬编码为 8*16=128（带 TODO: parameterize）。
- Hypothesize 静态推导：VLEN=128 时元素数上限 = 128*8/8 = 128 恰好等于位图宽度，最坏组合 SEW=8/m8/vl=128 精确占满不溢出。
- Probe 极限用例（SEW=8/m8/vl=128 带 0x0F0F 掩码的 vadd、vl=100 的 ta/tu/mu 尾部、vstart=7）全过。
- VLEN=256 时 `Mgu/NewMgu` 实例化 `prestartEn((i+1)*32-1, i*32)` 在 i≥4 越界切片，Chisel elaboration 直接编译失败（非静默错误）；参数化方案 `8*(vlen/8)`。

另有两个测试副产品疑点（待后续跑本工作流验证）：`csrw vstart` 位于 vsetvli 之前疑被 flushPipe 吞掉；`vsetvli zero, zero, ...`（AVL=vl 形式）触发 vtype 比对 abort。

## 0. 输入格式

```json
{
  "suspicions": [
    {
      "id": "S1",
      "file": "src/main scala 相对路径或绝对路径",
      "line": 105,
      "claim": "预期错误行为的一句话描述（哪个信号/寄存器会错成什么）"
    }
  ],
  "max_rounds": 5,
  "workspace": "/home/baiyifan/workplace-local/isla-runner"
}
```

- `workspace` 是 isla-runner 工作区根目录，DUT/REF/XiangShan 源码都在其下。
- `max_rounds` 是 Isolate 阶段每疑点的轮数上限（建议 3-5）。
- 疑点数量不设上限；每疑点一条独立流水线。

## 固定环境信息（写进每个需要跑仿真的 agent prompt）

- DUT emu：`<workspace>/difftest-xiangshan/xiangshan/build/emu`（MinimalConfig, VLEN=128, Verilator）
- REF：`<workspace>/difftest-xiangshan/xiangshan/ready-to-run/riscv64-nemu-interpreter-so`
- 交叉编译：`riscv64-linux-gnu-gcc`，ELF 入口 `0x80000000`，结束放 GOODTRAP：`.word 0x0000006b`
- emu 无波形支持（`--dump-wave` 会 SIGABRT）。取证用提交跟踪：emu 加 `-b <开始> -e <结束>`，日志含每退休指令的 pc/编码/dst/data。
- GOODTRAP 到达 = 双方一致且自检通过；DiffTest ABORT = DUT 与 REF 分歧（本身即 bug 证据，看日志 `data` 字段的双值）。
- 中间文件一律写 `artifacts/<suspicion.id>/round<N>/`（相对本仓库根）。

## Phase 1 — Hypothesize（假设化）

- **每疑点 1 个 agent**，只读代码，不跑仿真。
- 读疑点行及其完整调用链（±上游检查、下游消费方）。
- 产出 schema：

```json
{
  "trigger": "什么指令序列/参数组合能让坏路径被执行到",
  "expected": "哪个寄存器/CSR/内存会得到什么错值，正确值应是什么",
  "masking": "是否存在前置检查/机制拦截，使坏路径不可达或错误不可见",
  "testability": "reachable | masked-reachable | unreachable",
  "sensitivity": "用什么初值/参数能区分'旧值保留'与'算错的新值'（如 0x5A vs 0x70）"
}
```

- 路由：`reachable` / `masked-reachable` 进入 Phase 2；`unreachable` 跳过仿真，直接进 Phase 4 Skeptic（复核"不可达"判断本身）。

## Phase 2 — Probe（首测探针）

单个 agent（可读写、可跑仿真），做三件事：

1. **首测**：按 `templates/case-template.S` 骨架构造汇编自检用例——setup（vsetvli + 可辨识初值）→ trigger → check（vmv.x.s / csrr 读回 + beq/bne 分支到 FAIL）→ GOODTRAP。变量各出几个变体（vstart/vl/sew/lmul/顺序），一个 ELF 一组。
2. **灵敏度对照（无条件执行）**：先跑一个"已知应有差异"的对照（如不执行清零指令、确认目标状态真的会被改变），证明用例不是恒真。
3. **一致性追问（无条件执行）**：疑点即使被证伪，也必须在异常/trap 返回、flushPipe、vsetvli 重配置之后再次读回架构状态（向量寄存器、CSR），对比 emu 与 NEMU。另做决定性实验：**读一个从未被写过的相邻向量寄存器**，判断污染是否经旁路/检查点扩散。

产出 schema：

```json
{
  "first_test": "首测结果: PASS | ABORT | ERROR(环境问题)",
  "consistency": "一致性追问结果及发现的任何分歧(双值)",
  "divergence": "发现的 DUT/REF 分歧详情，无则 null",
  "status": "reproduced | masked | not-reproduced | env-error",
  "artifacts": ["artifacts/S1/round1/..."],
  "next_var": "下一轮最该单独改变的一个变量"
}
```

## Phase 3 — Isolate（变量控制隔离）

- **由 Workflow 的 JS 循环驱动**，不是 agent 自己决定何时停。终止条件（代码判定）：
  1. 轮数达到 `max_rounds`；
  2. 连续一轮"无新信息"（新结论 ⊆ 已有结论集合）。
- 每轮 agent 只做一件事：**改变一个变量**并重跑，变量来源是上一轮的 `next_var`。
- 每轮产出归因到四选一：

| 归因 | 含义 |
|---|---|
| `wrong-target-write` | 目标寄存器/CSR 被写错值 |
| `bypass-checkpoint-pollution` | 污染经旁路/检查点扩散（换目标寄存器仍复现） |
| `commit-timing` | 提交时序问题（同拍顺序、写回时序） |
| `not-reproducible` | 本轮未能复现 |

- 记录 `repro_rate`（复现次数/尝试次数）；`0 < repro_rate < 1` 判为竞态特征，写入结论。
- 循环退出时输出累计的 `{ attribution, repro_rate, rounds_used, evidence[] }`。

## Phase 4 — Skeptic（对抗复核）

专门雇一个"推翻者"agent，任务不是验证而是推翻：

1. **重跑最小复现**：用留下的 ELF 原样重跑，确认 ABORT 可复现。
2. **验证灵敏度对照真实性**：检查 Probe 阶段的对照用例确实"已知应有差异"，否则整条证据链作废。
3. **逐行核对"机制规避"结论**：对分类为"被机制天然规避"的疑点，逐行读其依赖的机制代码，确认该机制在所有路径上都成立。

产出 verdict 三选一：

- `CONFIRMED`：结论成立，进入汇总。
- `REFUTED`：结论被推翻。**不回环重做**，标记"人工复核"，原结论与推翻理由一并呈现。
- `DOWNGRADED`：结论部分成立，改写为更弱的表述（如"bug"降为"竞态特征"）。

## Phase 5 — Synthesize（汇总沉淀）

- **barrier**：所有疑点的流水线（含 unreachable 短路路径）全部结束后才执行，单 agent 汇总。
- 产出：
  1. **三分类表**：每疑点 → 真实可触发（bug）/ 被机制天然规避（写明哪条机制）/ 当前配置不可达（写明何时暴露）。
  2. **证据链**：每条结论 → 对应的 ABORT 日志 / 提交跟踪 / ELF 路径。
  3. **复现清单**：最小复现 ELF 名单（必须保留在 artifacts 下，不删）。
  4. **覆盖面声明**：明确列出没测到的路径（如其他 VLEN、其他 sew/lmul 组合、多 harts）。
  5. **findings.md 条目草稿**：agent 只产出草稿文本，**不直接修改任何共享文件**（findings.md 由人工或主会话合入）。

## 并行与规模

- 疑点间流水线**不互等**，各自 Hypothesize→…→Skeptic 独立推进，仅最后 barrier 到 Synthesize。
- 每疑点 3-6 个 agent（Hypothesize 1 + Probe 1 + Isolate 每轮 1×max_rounds（实际通常 1-2 轮收敛即停）+ Skeptic 1）。
- 10 个疑点约 40 个 agent；短路的 unreachable 疑点只用 2 个（Hypothesize + Skeptic）。

## 非目标

- 不自动修 RTL 代码、不开 PR。
- 不做随机 fuzz（本工作流是定向验证，输入必须是人给的疑点清单）。
- 不重建 emu/NEMU（环境已就绪）。
- 不直接写共享 findings 文件（只出草稿）。
