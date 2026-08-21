# RTL 疑点定向 DiffTest 验证工作流（详细设计）

本文档是工作流的权威设计。Workflow 实现（`workflows/rtl-directed-difftest.js`）必须与本文一致；未来 agent 干活前必读本文。

## 动机

本工作流来自三个疑点的实测验证（恰好覆盖三分类结论，其中一例在掩盖路径中抓到真 bug），完整案例见 [motivation.md](motivation.md)。

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
  "max_variants": 5,
  "workspace": "/home/baiyifan/workplace-local/isla-runner"
}
```

- `max_variants` 是内层"变体轮"上限：Isolate 阶段每疑点每轮只改一个变量，建议 3-5。
- `max_sweeps` 是外层"扫荡轮"上限：每个 sweep 验证完当前疑点清单后，Synthesize 的 follow_ups 去重（跳过已验证 id、新 id 加 `w<N>-` 前缀）作为下一个 sweep 输入；默认 1 即不滚动。
- 疑点数量不设上限；每疑点一条独立流水线。

## 固定环境信息（写进每个需要跑仿真的 agent prompt）

- XiangShan 以 submodule 形式放在本仓库 `xiangshan/`（pin 7bf51a8，kunminghu-v3）；首次使用跑 `./scripts/setup-env.sh`（拷入预编译 emu 与 REF，免 Verilator 重编；`--check` 只自检）
- DUT emu：`xiangshan/build/emu`（MinimalConfig, VLEN=128, Verilator）
- REF：`xiangshan/ready-to-run/riscv64-nemu-interpreter-so`
- 交叉编译：`riscv64-unknown-elf-gcc -march=rv64gcv -mabi=lp64d -T templates/xiangshan.ld`（入口 `0x80000000`），结束放 GOODTRAP：`.word 0x0000006b`
- emu 运行：`./xiangshan/build/emu -b <s> -e <e> -i <elf> --diff xiangshan/ready-to-run/riscv64-nemu-interpreter-so`；GOODTRAP 判定串为 `HIT GOOD TRAP`
- emu 无波形支持（`--dump-wave` 会 SIGABRT）。取证用提交跟踪：emu 加 `-b/-e`（周期范围），提交跟踪日志含每退休指令的 pc/编码/dst/data。
- GOODTRAP 到达 = 双方一致且自检通过；DiffTest ABORT = DUT 与 REF 分歧（本身即 bug 证据，看日志 `data` 字段的双值）。
- 中间文件一律写 `artifacts/<suspicion.id>/variant<N>/`（相对本仓库根）。

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
  1. 轮数达到 `max_variants`；
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
- 每疑点 3-6 个 agent（Hypothesize 1 + Probe 1 + Isolate 每轮 1×max_variants（实际通常 1-2 轮收敛即停）+ Skeptic 1）。
- 10 个疑点约 40 个 agent；短路的 unreachable 疑点只用 2 个（Hypothesize + Skeptic）。

## 非目标

- 不自动修 RTL 代码、不开 PR。
- 不做随机 fuzz（本工作流是定向验证，输入必须是人给的疑点清单）。
- 不重建 emu/NEMU（环境已就绪）。
- 不直接写共享 findings 文件（只出草稿）。
