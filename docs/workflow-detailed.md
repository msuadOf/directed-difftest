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
  "workspace": "/home/baiyifan/workplace-local/isla-runner",
  "filterlist": [
    {
      "id": "唯一 slug",
      "symptom": "【分类轴】可观测现象的一句话描述: 哪条(类)指令、哪个寄存器/CSR/内存位置、错成什么形态、在什么 ISA 级参数下复现与被掩盖、difftest 判据长什么样",
      "keywords": ["同样是现象级词汇: 指令名/CSR 名/ISA 术语/错值形态; 不要写 RTL 模块名与内部信号名"],
      "hint_file": "可选; 生成候选用的廉价线索(按文件名匹配, 目录前缀可不同), 不是分类依据",
      "internals": "可选备注; 内部实现细节(RTL 模块名、信号名、文件行号、根因链)只能放这里, 不参与匹配, 也不得作为判定理由",
      "upstream_issue": "可选; 有对应上游(如 XiangShan 官方 issue tracker)重复项时才填 { repo, number, url, state, labels }, 纯本地结论(如已被 Skeptic 确认'架构不可达'的 claim)可以完全不写这个字段",
      "duplicates": "可选; 同上",
      "local_finding_id": "本仓库内对应的疑点/follow-up id(如有)",
      "note": "补充说明: 结论依据(哪次 sweep/哪个 Skeptic 判定)、还有哪些子角度未覆盖",
      "added_date": "YYYY-MM-DD"
    }
  ]
}
```

- `max_variants` 是内层"变体轮"上限：Isolate 阶段每疑点每轮只改一个变量，建议 3-5。
- `max_sweeps` 是外层"扫荡轮"上限：每个 sweep 验证完当前疑点清单后，Synthesize 的 follow_ups 去重（跳过已验证 id、新 id 加 `w<N>-` 前缀）作为下一个 sweep 输入；默认 1 即不滚动。
- 疑点数量不设上限；每疑点一条独立流水线。
- `filterlist`（可选）：已知问题清单，见下方"Filter — 已知问题关卡"。仓库维护的常驻清单在 `hypotheses/known-issues.json`；调用方按需读取内容传入 `args.filterlist`（Workflow 脚本本身不能读文件系统）。

## 固定环境信息（写进每个需要跑仿真的 agent prompt）

- XiangShan 以 submodule 形式放在本仓库 `xiangshan/`（pin 7bf51a8，kunminghu-v3）；首次使用跑 `./scripts/setup-env.sh`（拷入预编译 emu 与 REF，免 Verilator 重编；`--check` 只自检）
- DUT emu：`xiangshan/build/emu`（MinimalConfig, VLEN=128, Verilator）
- REF：`xiangshan/ready-to-run/riscv64-nemu-interpreter-so`
- 交叉编译：`source scripts/toolchain.sh` 特性探测选出版本（注意 `/usr/bin` 的 gcc 10.2.0 **不支持** RVV 助记符，本机可用的是 `~/riscv/.../bin` 的 15.1.0），`$CROSS -march=rv64gcv -mabi=lp64d -T templates/xiangshan.ld`（入口 `0x80000000`），结束放 GOODTRAP：`.word 0x0000006b`
- emu 运行：`./xiangshan/build/emu -b <s> -e <e> -i <elf> --diff xiangshan/ready-to-run/riscv64-nemu-interpreter-so`；GOODTRAP 判定串为 `HIT GOOD TRAP`
- emu 已支持波形（2026-08-23 用 `EMU_TRACE=1` 重编，原无波形版备份为 `build/verilator-compile/emu.notrace.bak`）：加 `--dump-wave --wave-path=<文件.vcd>` 输出 VCD（已验证：标准 VerilatedVcd 格式，含 clock/reset/difftest 等信号）；文件可能很大，建议配 `-b/-e` 限定周期范围。取证仍优先用提交跟踪：emu 加 `--dump-commit-trace -b/-e`（当前构建只加 `-b/-e` 不输出 commit 行，见下方判据陷阱 (7)），日志含每退休指令的 pc/编码/dst/data；需要信号级细节再上波形。
- GOODTRAP 到达 = 双方一致且自检通过；DiffTest ABORT = DUT 与 REF 分歧（本身即 bug 证据，看日志 `data` 字段的双值）。
- 【判据陷阱·已踩坑】(1) **mtvec 目标必须 `.balign 4`**：`mtvec.base` 会掩掉低 2 位，TRAPH 标签落在非 4 字节对齐地址时 trap 跳到 base&~3 的掩码地址（通常是上一条指令中间），表现为挂死/timeout，极易被误判为"emu 不支持该指令"或"difftest 框架崩溃"（见 FU-ctrl2-difftest-coredump，2026-08-24）。(2) **FAIL 路径用 `j .` 自旋 + 外层 timeout 时**，日志只显示 `timeout: 核心转储`，无法区分"FAIL 命中"与"挂死/从未到达 CHECK"；复核此类结论必须结合提交跟踪确认 CHECK 确实执行过。(3) **外层 timeout 建议用 `timeout -s INT`**：emu 有 SIGINT 处理，会打印 PERF 与周期数，避免 SIGTERM 的"核心转储"字样误导。(4) **未写过的向量寄存器在 difftest 下随机初始化、非 0**（ABORT 时日志可见 v0-v31 全是随机值）：自检断言"从未写过的 vN == 0"必然 FAIL；正确写法是先 `vse64.v vN` 存到 refbuf 记录初值, 末尾再存一次与 refbuf 比对（自对照, 参考 artifacts/FU-ctrl2-difftest-coredump/variant4/case-min-no-vcompress-fix.S）。(5) **超时/挂死场景必须 `stdbuf -oL`**：emu 输出走块缓冲, 被超时杀死时缓冲区丢失, 日志只剩头部几行; 加 `stdbuf -oL` 才能看到真实进度（如 "Difftest enabled"）。(6) **读回自检值注意 `lw` 会符号扩展**：比较 `0xdeadbeef` 这类高位为 1 的 32bit 期望值时 `lw` 结果是 `0xffffffffdeadbeef`, 与 `li` 生成的零扩展立即数永远不等, 应改用 `lwu`（2026-08-25 踩坑, 见 variant4/dbg-pos-trace.log commit[35]）。(7) **提交跟踪在当前 emu 构建里需显式 `--dump-commit-trace`**：只加 `-b/-e` 不会输出 `commit pc ...` 行。(8) **`vmv.x.s` 存在已知 F1 符号扩展 bug**（如 v0=0x00000008 读回 0xffffffff00000008）: 读回向量寄存器内容一律走 `vse32/vse64` 存内存再 load, 不要用 `vmv.x.s`。
- 中间文件一律写 `artifacts/<suspicion.id>/variant<N>/`（相对本仓库根）。

## Filter — 已知问题关卡（贯穿各阶段，不是一次性前置检查）

**动机**：sweep 会不断把 follow_ups 滚入下一轮疑点清单；如果某个 follow_up 描述的其实是一个**已经有定论**的问题——无论是上游（如 XiangShan 官方 issue tracker）已确认/追踪的 bug，还是本仓库自己之前跑完整流水线、被 Skeptic 确认过的结论（真 bug / 机制天然规避 / 架构不可达，三者皆可）——每轮都重新花几十分钟仿真去"重新发现"同一个结论都是纯粹的浪费。Filter 用一份**已知问题清单**（`filterlist`）排除这些重复项。

**分类轴只能是现象。** filterlist 条目的身份由 `symptom`（可观测的架构状态与行为：哪条(类)指令、哪个寄存器/CSR/内存位置、错成什么形态、在什么 ISA 级参数下复现与被掩盖、difftest 判据长什么样）与 `keywords`（同样是现象级词汇：指令名、CSR 名、ISA 术语、错值形态）定义。内部实现细节——RTL 模块名、信号名、文件行号、根因链——**一律只能进 `internals`/`note` 备注字段**，不参与匹配，也不得作为"是同一个问题"的判定理由。两条原因：

- 同一个文件/模块里完全可能藏着两个不同的 bug，按模块名判会误杀新问题；
- 同一个现象在重构后可能换到另一个模块，按模块名判又会漏掉重复项。反过来，现象一致但落点在同一条链的上游 vs 下游，应当判为同一个（2026-08-24 的验证正是这个情形：疑点挂在 `Mgu.scala`，已知条目挂在 `VMove.scala`，判为同一个是对的）。

`hint_file` 只是生成候选用的廉价线索，不是分类依据。

**为什么是关卡而不是单一阶段**：疑点刚进来时只有一句 `claim`，信息量最少，常常看不出它跟清单里某条是同一个；而每跑完一个阶段，现象描述都会显著变具体——Hypothesize 说出涉及哪条指令与哪个架构状态、Probe 给出实测到的错值形态、Isolate 给出归因——往往到那时才认得出"这就是那个已知问题"。所以**每个阶段结束后都设一道关卡**，拿累积到的全部证据重新比对一次；一旦确认命中，后续阶段（尤其是昂贵的 difftest 仿真）立刻全部跳过。关卡位置：

| 关卡 | 判定时可用的信息 |
|---|---|
| `@claim` | 只有原始一句话 claim（这道关卡命中 = 零仿真成本跳过） |
| `@hypothesize` | + 触发条件、涉及的指令与架构状态、可达性判断 |
| `@probe` | + 首测实测结果、DUT/REF 分歧双值 |
| `@isolate-vN` | + 每轮归因与复现率 |

- **filterlist 条目不要求有上游 issue**：`upstream_issue`/`duplicates` 是可选字段，只在确实存在对应的外部 issue（且已核实现象一致）时才填；条目也可以是纯本地描述——比如某个 claim 已经被 Skeptic 三重独立机制确认"架构不可达"（见 `hypotheses/known-issues.json` 里的例子），本身没有、也不需要上游 issue，同样值得写进清单防止之后重复验证同一个已有定论的问题。
- 每道关卡的匹配都分两步，目的是绝大多数疑点零 token 成本地穿过所有关卡：
  1. **纯代码预筛**（不调用 agent）：**累积证据文本**命中某条已知问题 `keywords` 里的任一关键词，或疑点的 `file` 文件名与其 `hint_file` 文件名相同，才算候选。注意预筛用的是累积证据而非只有原始 `claim`——后期阶段才说得出口的现象描述（实测到的错值形态、涉及的指令名、架构状态名）正是命中关键词的主要来源，这也是关卡在后期才可能命中的机制来源。
  2. **只有出现候选时**才调用一次轻量 agent 做语义复核——允许措辞、复现参数、具体数值不同（比如上游 issue 用 `tu,mu` 复现、本仓库用 `ta,ma` 复现，现象同一个也算命中），只要**表现出来的现象**是同一个即可判定为同一问题。没有候选则完全不产生 agent 调用。
- **宁可漏判**：不确定就 `matched=false`，让疑点继续走后续阶段；错判掉一个可能是新问题的疑点，比多验证一次昂贵得多。特别地，如果疑点正落在某条已知问题 `note` 里写明的"尚未覆盖、值得继续深挖的子角度"上（如 F1 条目里的 `F1-sub-wrong-target-addr`），必须判 `matched=false` 放行。
- 每疑点的关卡 agent 调用数有上限（脚本中的 `MAX_GATE_CALLS`，当前 5）；触顶后不再复核，并 `log()` 出来，不静默截断。
- 命中已知问题（`matched=true`）：该疑点**跳过所有剩余阶段（含 Skeptic）**，标记 `filtered=true`，连同 `matched_known_id`、`filtered_at_phase`（在哪道关卡认出来的）、`filter_history`（各关卡的判定轨迹）进入 Synthesize 汇总（分类表单列一类，不占用真实可触发/机制规避/不可达三类之一）。**命中前已经跑出来的部分结果照常保留**在 `hypothesis`/`probe`/`isolate` 字段里——它们是对该已知问题的补充证据，Synthesize 应写进 evidence_chains，而不是丢弃。
- 清单维护：`hypotheses/known-issues.json` 是仓库常驻的已知问题清单，每条记录：现象描述（`symptom` + 现象级 `keywords`）、结论依据（对应的上游 issue，或本仓库哪一轮 Skeptic 的判定）、本仓库内对应的疑点 id、以及该问题是否还有未被覆盖的子角度（值得继续深挖而非直接跳过）；内部实现细节放 `internals`。调用 workflow 时按需读取该文件内容，作为 `args.filterlist` 传入（Workflow 脚本本身没有文件系统访问权限，不能自己读）。任何一个疑点走完完整流水线、拿到 CONFIRMED 定论后（无论结论是真 bug 还是不可达/机制规避），都应该把它补进这份清单，供后续 sweep 复用，不必区分是否有上游 issue。写 `keywords` 时的取舍：把**实测阶段才说得出口的现象词**（错值形态如 `0xff`、涉及的指令名、CSR 名）写进去，好让后期关卡有机会命中；但不要写模块名和内部信号名——那些属于 `internals`。

## Phase 1 — Hypothesize（假设化）

- **每疑点 1 个 agent**，只读代码，不跑仿真。
- 读疑点行及其完整调用链（±上游检查、下游消费方）。
- 产出 schema：

```json
{
  "trigger": "什么指令序列/参数组合能让坏路径被执行到",
  "expected": "哪个寄存器/CSR/内存会得到什么错值，正确值应是什么",
  "masking": "是否存在前置检查/机制拦截，使坏路径不可达或错误不可见",
  "testability": "reachable | masked-reachable | timing-only | unreachable",
  "sensitivity": "用什么初值/参数能区分'旧值保留'与'算错的新值'（如 0x5A vs 0x70）；timing-only 时改写成'用什么波形判据能区分正常与异常'"
}
```

- `timing-only` 的判据：坏路径可达，但**不改变任何架构状态**，只体现为时序/协议异常。difftest 对这类问题恒 PASS，抓不到，只能靠波形取证（见下方"波形取证方法论"）。通用自检：问一句"就算它真错了，有任何一个架构可见的寄存器/内存值会不同吗？"，答案否定就是 `timing-only`。哪些部分容易落在这一类**没有定式**——凡是正确性主要由时序/协议契约而非提交值定义的地方都可能（总线、存储层次只是常见例子，别只往那几处想）。
- 路由：`reachable` / `masked-reachable` / `timing-only` 进入 Phase 2（`timing-only` 的 Probe 重心从自检用例转到波形）；`unreachable` 跳过仿真，直接进 Phase 4 Skeptic（复核"不可达"判断本身）。

## 波形取证方法论（实验性，仍在使用中完善）

> 本节是有意留白的一节：判据大量依赖经验，目前只有骨架。每次用波形定位，都要把经验回填到 `wave_notes` / `wave_method_notes`，再由人工把稳定下来的判据升级进本节。**不要把这里的内容当成已经验证过的规程。**

**为什么需要它**：difftest 只能抓"架构状态分歧"——DUT 与 REF 提交的寄存器/内存值不同才 ABORT。有一整类问题它天然抓不到：不改变架构状态、只表现为时序/协议异常的问题。而且 REF（NEMU）根本没有微架构时序模型，无从对比。这类疑点在 Hypothesize 阶段应判为 `timing-only`，Probe 的重心直接从自检用例转到波形。

### 通用做法

波形判据本质上永远是"预期 vs 实际"的对照，所以：

1. **先把预期写下来，并注明预期的来源。** 来源只有两类，判据硬度不同，结论里必须写清是哪一类：
   - **成文规范**（协议标准、接口契约、文档化的时序约定）：判据硬，可逐条引用条款；
   - **对代码意图的推断**（读 RTL 推出"这里应该几拍完成、应该按什么顺序发生"）：判据软——推断本身可能就是错的，那样看到的"异常"其实是正常行为。必须把推断链写出来，让别人能推翻它。
2. **选观察窗口。** 这类问题的判据是"一整段序列"而不是"某一拍的电平"，窗口要长到覆盖一次完整交互（常在数十个时钟周期量级）。
3. **找矛盾**，三种形态：
   - 违反规范条款；
   - 与代码意图不符：该发生的没发生 / 不该发生的发生了 / 顺序反了 / 拍数远超预期；
   - **自对照不一致**：同一种交互这次 N 拍、那次 10N 拍，或同样条件下两次行为不同。这一类不需要任何外部规范或领域知识就能发现，成本最低，应该优先试。
4. **回报经验**（见下）。

**从哪里开始看**：不要从"某个子系统的检查清单"出发，从疑点自身出发——疑点涉及的模块，其**对外接口**是第一观察点，接口通常有契约、最容易建立预期；跨模块边界的信号比模块内部信号判据更硬。

**操作路径**：先用提交跟踪（`-b/-e`）定位大致时间点 → 用 `-b/-e` 圈定周期范围控制 VCD 体积 → `--dump-wave --wave-path=artifacts/<疑点id>/variant<N>/xxx.vcd` 导出 → 按信号名找到目标模块/通道的 scope → 沿时间轴读整段序列。

### 形态举例（**这是举例，不是待查清单**）

下面几条只用来说明上述三类矛盾具体长什么样。**换一个子系统就该换一组完全不同的例子**；不要把搜索范围限制在这几条上，也不要因为疑点跟这几条对不上就认为没问题。

- 握手类协议（如 AXI/TileLink）：`valid` 拉高后 `ready` 迟迟不来；`valid` 在握手完成前被撤销；响应乱序返回；传输越过边界；结束标志落在错误的拍上。
- 存储层次（如 cache）：某类访问的完成拍数远超同类访问的常态；资源表项占用与释放不配平。

以上任何一条都可能在你手上这个疑点里根本不适用——判据要从疑点自身的预期推出来，而不是从这张表里挑一条套上去。

### 必须回报的经验（写进 `wave_notes`）

看了哪些 scope/信号、窗口多长、预期来自规范还是推断（注明哪一类）、以及**哪些尝试是无效的**。无效经验同样有价值——它是缩小下次搜索范围的依据。

## Phase 2 — Probe（首测探针）

单个 agent（可读写、可跑仿真），做三件事：

1. **首测**：按 `templates/case-template.S` 骨架构造汇编自检用例——setup（vsetvli + 可辨识初值）→ trigger → check（向量寄存器用 `vse` 存内存再 load 读回，**禁 `vmv.x.s`**——已知 F1 bug 会污染读回，见判据陷阱 (8)；CSR 用 csrr + beq/bne 分支到 FAIL）→ GOODTRAP。变量各出几个变体（vstart/vl/sew/lmul/顺序），一个 ELF 一组。
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
| `protocol-timing-violation` | 波形上的时序/协议矛盾（实际与预期不符，预期来自规范或对代码意图的推断）；架构状态不变，difftest 抓不到 |
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
  1. **分类表**：每疑点 → 真实可触发（bug）/ 时序或协议异常（difftest 抓不到、靠波形定的那一类，必须写明预期是什么、预期来自成文规范还是对代码意图的推断）/ 被机制天然规避（写明哪条机制）/ 当前配置不可达（写明何时暴露）/ 已知问题-已跳过（命中 filterlist）。
  2. **证据链**：每条结论 → 对应的 ABORT 日志 / 提交跟踪 / VCD 波形 / ELF 路径。
  3. **复现清单**：最小复现 ELF 名单（必须保留在 artifacts 下，不删）。
  4. **覆盖面声明**：明确列出没测到的路径（如其他 VLEN、其他 sew/lmul 组合、多 harts）。
  5. **findings.md 条目草稿**：agent 只产出草稿文本，**不直接修改任何共享文件**（findings.md 由人工或主会话合入）。
  6. **wave_method_notes**：汇总本轮各阶段的 `wave_notes`——什么判据有效、什么无效、下次该怎么改。波形方法论仍在完善中，这一栏是它的迭代输入；本轮无人用波形则留空，不要编。

## 并行与规模

- 疑点间流水线**不互等**，各自 Hypothesize→Probe→Isolate→Skeptic（每阶段后过一道 Filter 关卡）独立推进，仅最后 barrier 到 Synthesize。
- 每疑点 3-6 个 agent（Hypothesize 1 + Probe 1 + Isolate 每轮 1×max_variants（实际通常 1-2 轮收敛即停）+ Skeptic 1）；filterlist 里没有同文件/同关键词的候选时，各道关卡全部零 agent 通过，不增加任何开销。命中 filterlist 的疑点在命中那一刻停止，成本取决于在哪道关卡命中：`@claim` 命中只花 1 个 Filter agent、零仿真；越晚命中省下的越少，但仍然省掉了剩余阶段。
- 10 个疑点约 40 个 agent；短路的 unreachable 疑点只用 2 个（Hypothesize + Skeptic）。

## 非目标

- 不自动修 RTL 代码、不开 PR。
- 不做随机 fuzz（本工作流是定向验证，输入必须是人给的疑点清单）。
- 不重建 emu/NEMU（环境已就绪）。
- 不直接写共享 findings 文件（只出草稿）。
