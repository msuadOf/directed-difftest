# RTL 疑点定向 DiffTest 验证工作流（详细设计）

本文档是工作流的权威设计。Workflow 实现（`workflows/rtl-directed-difftest.js`）与执行层脚本（`scripts/run_batch.py` 等）必须与本文一致；未来 agent 干活前必读本文。

## 动机

本工作流来自三个疑点的实测验证（恰好覆盖三分类结论，其中一例在掩盖路径中抓到真 bug），完整案例见 [motivation.md](motivation.md)。

2026-08-25 架构重构，针对两个实测痛点：

1. **慢**：历史 516 次仿真平均 25.3 s/次、最长 525 s（挂死烧满外层 timeout）；emu 实测每实例只占 **1 核**（虽以 `--threads 4` verilate，实际单线程热），12 核机器却在串行等仿真。
2. **浅**：每次仿真产出的丰富信号（提交跟踪、REF 跟踪、架构状态、周期数、波形）穿过 schema 只剩几句话；跨 run/跨疑点的模式没有任何机制能看见；"解释不了的观察"没有去处（S1 的真 bug 恰恰来自这种观察）。

## 架构总览（三层）

```
决策层(agent):   假设 -> 设计实验批次 -> 解读蒸馏证据 -> 追击异常
                 Hypothesize/Probe/Isolate/Skeptic + 跨疑点异常池 + Triage 晋升
                      ↑ 读                                ↓ 写
分析层(脚本):    trace_diff(双跟踪差分) / vcd_extract(波形窗口->CSV)
                 / runs_query(运行数据库查询+离群检测)
                      ↑ 读                                ↓ 写
证据层(脚本):    run_batch.py —— 并行槽位 + 三级看门狗 + runs.jsonl(每 run 一条
                 结构化记录) + summary.tsv + 证据包 + hang-signatures 秒判
```

原则：**检测与执行交给确定性脚本，判断交给 agent**；agent 读蒸馏结果，不人肉啃原始日志/VCD；每一次仿真都在 runs.jsonl 留下结构化记录，跨 run 模式（哪类参数总失败、哪个 run 周期数离群）变成可查询问题。

## 0. 输入格式

```json
{
  "suspicions": [
    {
      "id": "S1",
      "file": "src/main scala 相对路径或绝对路径",
      "line": 105,
      "claim": "预期错误行为的一句话描述（哪个信号/寄存器会错成什么）",
      "evidence": ["可选; Triage 晋升/follow_ups 携带的已有证据(artifact 路径), 让验证不必从零跑"]
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

- `max_variants` 是内层 **Isolate 批次轮数上限**：每轮测一批（3-6 个）正交单变量变体，建议 3-5 轮。
- `max_sweeps` 是外层"扫荡轮"上限：每个 sweep 结束后，**Triage 晋升的新疑点（带证据）+ Synthesize 的 follow_ups** 去重（跳过已验证 id）作为下一个 sweep 输入；默认 4。
- 疑点数量不设上限；每疑点一条独立流水线。
- `filterlist`（可选）：已知问题清单，见下方"Filter — 已知问题关卡"。仓库常驻清单在 `hypotheses/known-issues.json`；调用方按需读取内容传入 `args.filterlist`（Workflow 脚本本身不能读文件系统）。

## 执行层 — run_batch.py 与三级看门狗

**所有 DiffTest 仿真必经 `scripts/run_batch.py`，禁止直接调 emu**（取波形也走它的 `--wave`）。一次接一批 `.S`/`.elf`：

```
python3 scripts/run_batch.py -o artifacts/<疑点id>/variant<N>/ a.S b.S c.S ...
  常用: -j 并行度 | -C 周期上限(默认 120000) | --wall 墙钟上限(默认 600s)
        --priority 误杀重跑插队 | --wave --begin/--end 确定性重放取波形
        --emu-args "--dump-ref-trace" 追加双跟踪 | --meta k=v 打标
```

它自动完成：交叉编译（toolchain.sh 特性探测）、**全局槽位并行**（`artifacts/.slots/` 上 flock，默认 `RB_SLOTS=8`，其中槽位 0 保留给 `--priority`，普通批次 7 路并行；跨进程/跨 agent 共享；每 emu 实测 1 核，并行近线性）、`--dump-commit-trace`、`stdbuf -oL`、SIGINT 体面杀、`summary.tsv` 汇总、**runs.jsonl 记录**（见下）、挂死签名匹配。

**终态语义**（每个用例最终恰好收敛到一个终态，对上层透明）：

| 终态 | 含义 | review |
|---|---|---|
| `GOODTRAP` | 双方一致且自检通过 | - |
| `ABORT` | DUT/REF 分歧（bug 证据；summary 带 first-div 双值） | - |
| `SELF_TEST_FAIL` | 看门狗认出停驻在 `FAIL` 自环（CHECK 确实执行过，与挂死无歧义） | - |
| `KILLED_SPIN/STALL/RUNAWAY` | 绊线击毙（机检初判） | **pending，一杀一审** |
| `CYCLE_CAP` / `WALL_TIMEOUT` | 第 0 级兜底触发（默认值下约 8-10 分钟量级，只兜绊线漏网；主力止损是绊线的 20-30 s） | **pending，一杀一审** |

所有 `review=pending` 终态（含 CYCLE_CAP/WALL_TIMEOUT）都会生成 `<case>.evidence.json` 证据包并计算签名——复核输入统一。
| `COMPILE_ERROR` | 编译失败（compile.log 留档） | - |

### 三级看门狗

- **第 0 级（预防，兜底）**：每 run 强制 `-C` 周期上限 + 墙钟上限。历史 525 s 的挂死尾巴由此封顶。
- **第 1 级（绊线，纯脚本，8 s 轮询）**：机械判据分类，**误判防线内建**：
  - `SPIN`：窗口内 pc 种类 ≤8 **且写回值无进展**（延时循环 `addi t0,t0,-1` 因数据每轮变化被放行）**且**无 `POLL_` 前缀符号（故意轮询的白名单，从符号表读）。停驻在 `FAIL` 符号 → 判 `SELF_TEST_FAIL` 而非挂死。两轮滞回。
  - `RUNAWAY`：commit pc 越出 ELF 可执行段（bootrom 区间豁免）。单轮即判。
  - `STALL`：进程 CPU 在烧（/proc 实测）但无新退休累计超阈值（`--stall-sec`，默认 20 s）。两轮滞回。emu 无周期性心跳输出，故用 CPU 时间做 cycle 域代理。
  - 触发即 SIGINT 杀（emu 会吐 PERF/周期数），**槽位立刻让给下一个用例（write-back 语义：先止损，裁决异步）**；写证据包 `<case>.evidence.json`（触发原因、符号化停驻位置、最后 64 条提交、日志尾 120 行、签名）。
- **第 2 级（复核，一杀一审）**：`review=pending` 的 run 由**拥有该用例的 agent 立即复核**（它在等这个结果、有全部上下文，零交接成本；不做攒批——下游工序在等）。三选一裁决：
  - `TRUE_HANG`：真挂死。进 hang_reports + 异常池；新形态给签名条目草稿。
  - `FALSE_KILL`：误杀。**带修正**重跑（补 `POLL_` 标签 / `--stall-sec 60` / 提高 `-C`/`--wall`），`--priority` 插队（槽位 0 为优先保留槽）；同一用例最多重入队 2 次，再触发强制转 TRUE_HANG/UNCLEAR，不许乒乓。
  - `UNCLEAR`：证据包解释不通。确定性重放取波形（Verilator 同 seed 必然同 cycle 复现，平时零波形开销、只为出事窗口付费）；仍解释不通 → workflow 派专门 Diagnose agent。
  - **同签名合并（MSHR 语义）**：同批多个 kill 的 `sig_id` 相同只审一次，裁决套用到全部。签名 locus 按**符号名去偏移**归一化（不同变体停驻偏移常不同，带偏移会让同根因变体各成一签、合并失效；精确偏移在证据包 `last_commits` 里）。
  - **销案**：每完成一例裁决，复核 agent 执行 `runs_query.py --resolve <case> --ruling <裁决> --note "..."` 追加销案记录（append-only 不改写历史行），`--pending-review` 队列据此收敛。
- **裁决双向回流**：TRUE_HANG 的新签名草稿 → 人工合入 `hypotheses/hang-signatures.json`（下次同形态秒判，runner 自动标 `known_hang`——它是**提示**不是定论，按条目 `verify` 字段核实）；FALSE_KILL 的误杀原因 → Synthesize 的 `watchdog_notes`，作为绊线阈值/白名单校准输入。种子签名：`WD-mtvec-misalign-spin`、`WD-vs-disabled-vector-hang`。

> 设计取舍记录：为什么不用"每 5 分钟一个 subagent 轮询"——检测环节的信号完全机械（脚本 8 s 粒度 vs subagent 5 min 粒度），LLM 只在"为什么挂"上有价值；持续开波形代价太高，确定性重放让波形可以事后按需取。误判的杀伤力靠四层拆掉：无损/低损止损（`-C` 兜底 + 可重放）、判据机械化（进展检查/白名单/滞回/CPU 域测量）、稀疏升级到 agent（一杀一审）、误判可审计（runs.jsonl 全记录）。

### runs.jsonl（运行数据库）

每次运行追加一条 JSON：`ts / case / elf / out / verdict / cycles / instrs / host_ms / stop_pc / stop_sym / divergence[{reg,pc,ref,dut}] / sig / sig_id / known_hang / meta{来自 .S 内 #meta: 行与 --meta} / watchdog / review / log`；另有 `type=review_resolution` 的销案记录（`--resolve` 追加）。它是"深挖"的地基：跨 run 关联（`runs_query.py --meta sew=32`）、离群检测（`--outliers`）、待复核队列（`--pending-review`，已销案不列）都在它之上。artifacts/ 已 gitignore——**注意这意味着历史运行记录清理后不可重建**，重要 run 的结论必须及时沉淀进 findings/known-issues。

## 分析层 — 蒸馏工具

| 工具 | 用途 | 何时必用 |
|---|---|---|
| `scripts/trace_diff.py <log> --elf <elf>` | DUT 提交跟踪 vs REF(NEMU) 指令跟踪对齐；控制流首分歧 ±N 条上下文（带反汇编注解与写回值）；自动跳过 ABORT 时的重放转储段 | **每个 ABORT**：先 `run_batch.py --emu-args "--dump-ref-trace"` 重跑一次得双跟踪日志。"控制流完全一致仅数据分歧"本身就是重要结论（错在数据通路） |
| `scripts/vcd_extract.py <vcd> -s <正则> [--begin/--end]` | 波形窗口按信号名正则抽成紧凑 CSV（>64 个匹配报错，防 CSV 变成新的大文件）；`--list` 先侦察信号名（提交通道在 `rob.difftest_commit_*`，lane 0 不带编号） | 一切波形取证；agent 不得直接啃原始 VCD |
| `scripts/runs_query.py` | runs.jsonl 查询/统计；`--outliers` 用 MAD 法找 cycles 离群 | 波形方法论"自对照不一致"判据的廉价前置过滤器：先在周期数上找离群 run，再决定对哪个 run 取波形 |

## 固定环境信息（写进每个需要跑仿真的 agent prompt）

- XiangShan 以 submodule 形式放在本仓库 `xiangshan/`（pin 7bf51a8，kunminghu-v3）；首次使用跑 `./scripts/setup-env.sh`（拷入预编译 emu 与 REF，免 Verilator 重编；`--check` 只自检）
- DUT emu：`xiangshan/build/emu`（MinimalConfig, VLEN=128, Verilator）；REF：`xiangshan/ready-to-run/riscv64-nemu-interpreter-so`。**调用一律经 run_batch.py**（编译、并行、封顶、跟踪、记录全自动）。
- 交叉编译：runner 内部走 `scripts/toolchain.sh` 特性探测（`/usr/bin` 的 gcc 10.2.0 **不支持** RVV 助记符，本机可用 `~/riscv/.../bin` 的 15.1.0）；入口 `0x80000000`，结束放 GOODTRAP：`.word 0x0000006b`。
- emu 已支持波形（2026-08-23 用 `EMU_TRACE=1` 重编，原无波形版备份为 `build/verilator-compile/emu.notrace.bak`）：取波形走 `run_batch.py --wave`（确定性重放，配 `--begin/--end` 控制 VCD 体积）。取证仍优先提交跟踪与 trace_diff；需要信号级细节再上波形。
- 模板 `templates/case-template.S` 三约定：`#meta:` 行写 ISA 参数（进 runs.jsonl）；故意轮询循环标 `POLL_` 前缀；FAIL 用独立标签+两条指令自环。模板另提供 `STATE_FENCE` 宏（全量向量状态快照，注意宏会破坏 vtype/vl——旧值已存入快照前 32B，继续向量运算需重新 vsetvli）。
- 【判据陷阱·已踩坑】(1) **mtvec 目标必须 `.balign 4`**：`mtvec.base` 掩低 2 位，未对齐表现为挂死/跑飞（看门狗签名 `WD-mtvec-misalign-spin` 可秒判，见 FU-ctrl2-difftest-coredump，2026-08-24）。(2) ~~FAIL 用 `j .` 自旋无法与挂死区分~~ → 已由看门狗解决：FAIL 两条指令自环会被判 `SELF_TEST_FAIL`，与挂死无歧义；但**单条 jal-to-self 会被 emu 判 GOODTRAP**，自环必须两条指令。(3) ~~外层 timeout 用 `timeout -s INT`~~、(5) ~~`stdbuf -oL` 防丢日志~~、(7) ~~显式 `--dump-commit-trace`~~ → 均已由 runner 自动化，仅在绕过 runner 手工调试时需要记得。(4) **未写过的向量寄存器在 difftest 下随机初始化、非 0**：不得断言"未写 vN == 0"；自对照先 `vse` 存初值到 refbuf，末尾再存一次比对。(6) **32bit 期望值比较用 `lwu` 而非 `lw`**（lw 符号扩展使高位为 1 的期望值永不相等，2026-08-25 踩坑）。(8) **`vmv.x.s` 有已知 F1 符号扩展 bug**：读回向量寄存器一律 `vse` 存内存再 load。
- GOODTRAP 到达 = 双方一致且自检通过；DiffTest ABORT = DUT 与 REF 分歧（本身即 bug 证据，看 summary first-div 与日志 `different at pc` 双值）。
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
| `@isolate-rN` | + 每轮归因与复现率 |

- **filterlist 条目不要求有上游 issue**：`upstream_issue`/`duplicates` 是可选字段，只在确实存在对应的外部 issue（且已核实现象一致）时才填；条目也可以是纯本地描述——比如某个 claim 已经被 Skeptic 三重独立机制确认"架构不可达"（见 `hypotheses/known-issues.json` 里的例子），本身没有、也不需要上游 issue，同样值得写进清单防止之后重复验证同一个已有定论的问题。
- 每道关卡的匹配都分两步，目的是绝大多数疑点零 token 成本地穿过所有关卡：
  1. **纯代码预筛**（不调用 agent）：**累积证据文本**命中某条已知问题 `keywords` 里的任一关键词，或疑点的 `file` 文件名与其 `hint_file` 文件名相同，才算候选。注意预筛用的是累积证据而非只有原始 `claim`——后期阶段才说得出口的现象描述（实测到的错值形态、涉及的指令名、架构状态名）正是命中关键词的主要来源，这也是关卡在后期才可能命中的机制来源。
  2. **只有出现候选时**才调用一次轻量 agent 做语义复核——允许措辞、复现参数、具体数值不同（比如上游 issue 用 `tu,mu` 复现、本仓库用 `ta,ma` 复现，现象同一个也算命中），只要**表现出来的现象**是同一个即可判定为同一问题。没有候选则完全不产生 agent 调用。
- **宁可漏判**：不确定就 `matched=false`，让疑点继续走后续阶段；错判掉一个可能是新问题的疑点，比多验证一次昂贵得多。特别地，如果疑点正落在某条已知问题 `note` 里写明的"尚未覆盖、值得继续深挖的子角度"上（如 F1 条目里的 `F1-sub-wrong-target-addr`），必须判 `matched=false` 放行。
- 每疑点的关卡 agent 调用数有上限（脚本中的 `MAX_GATE_CALLS`，当前 5）；触顶后不再复核，并 `log()` 出来，不静默截断。
- 命中已知问题（`matched=true`）：该疑点**跳过所有剩余阶段（含 Skeptic）**，标记 `filtered=true`，连同 `matched_known_id`、`filtered_at_phase`（在哪道关卡认出来的）、`filter_history`（各关卡的判定轨迹）进入 Synthesize 汇总（分类表单列一类，不占用真实可触发/机制规避/不可达三类之一）。**命中前已经跑出来的部分结果照常保留**在 `hypothesis`/`probe`/`isolate` 字段里——它们是对该已知问题的补充证据，Synthesize 应写进 evidence_chains，而不是丢弃。
- 清单维护：`hypotheses/known-issues.json` 是仓库常驻的已知问题清单，每条记录：现象描述（`symptom` + 现象级 `keywords`）、结论依据（对应的上游 issue，或本仓库哪一轮 Skeptic 的判定）、本仓库内对应的疑点 id、以及该问题是否还有未被覆盖的子角度（值得继续深挖而非直接跳过）；内部实现细节放 `internals`。调用 workflow 时按需读取该文件内容，作为 `args.filterlist` 传入（Workflow 脚本本身没有文件系统访问权限，不能自己读）。任何一个疑点走完完整流水线、拿到 CONFIRMED 定论后（无论结论是真 bug 还是不可达/机制规避），都应该把它补进这份清单，供后续 sweep 复用，不必区分是否有上游 issue。写 `keywords` 时的取舍：把**实测阶段才说得出口的现象词**（错值形态如 `0xff`、涉及的指令名、CSR 名）写进去，好让后期关卡有机会命中；但不要写模块名和内部信号名——那些属于 `internals`。
- 与 `hypotheses/hang-signatures.json` 的分工：known-issues 是**验证结论**的去重（现象级），hang-signatures 是**挂死形态**的秒判（执行层，runner 自动匹配）；两者独立维护。

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
   - **自对照不一致**：同一种交互这次 N 拍、那次 10N 拍，或同样条件下两次行为不同。这一类不需要任何外部规范或领域知识就能发现，成本最低，应该优先试。**廉价前置**：`runs_query.py --outliers` 先在周期数上做跨 run 自对照，离群 run 就是取波形的第一候选。
4. **回报经验**（见下）。

**从哪里开始看**：不要从"某个子系统的检查清单"出发，从疑点自身出发——疑点涉及的模块，其**对外接口**是第一观察点，接口通常有契约、最容易建立预期；跨模块边界的信号比模块内部信号判据更硬。

**操作路径**：提交跟踪/trace_diff 定位大致周期 → `run_batch.py --wave` 确定性重放（同 seed 同 cycle 复现；平时零波形开销）→ `vcd_extract.py --list` 侦察信号名 → `-s` 正则 + `--begin/--end` 抽成 CSV → 在 CSV 上沿时间轴读整段序列。

### 形态举例（**这是举例，不是待查清单**）

下面几条只用来说明上述三类矛盾具体长什么样。**换一个子系统就该换一组完全不同的例子**；不要把搜索范围限制在这几条上，也不要因为疑点跟这几条对不上就认为没问题。

- 握手类协议（如 AXI/TileLink）：`valid` 拉高后 `ready` 迟迟不来；`valid` 在握手完成前被撤销；响应乱序返回；传输越过边界；结束标志落在错误的拍上。
- 存储层次（如 cache）：某类访问的完成拍数远超同类访问的常态；资源表项占用与释放不配平。

以上任何一条都可能在你手上这个疑点里根本不适用——判据要从疑点自身的预期推出来，而不是从这张表里挑一条套上去。

### 必须回报的经验（写进 `wave_notes`）

看了哪些 scope/信号、窗口多长、预期来自规范还是推断（注明哪一类）、以及**哪些尝试是无效的**。无效经验同样有价值——它是缩小下次搜索范围的依据。

## Phase 2 — Probe（首测探针）

单个 agent（可读写、可跑仿真）。**批量思维：把下面四类用例写成一批独立 `.S`，一次交给 run_batch.py 并行跑**（串行等仿真是旧版最大的时间浪费）：

1. **首测**：按 `templates/case-template.S` 骨架——setup（vsetvli + 可辨识初值）→ trigger → check（向量寄存器用 `vse` 存内存再 load 读回，**禁 `vmv.x.s`**；CSR 用 csrr + beq/bne 分支到 FAIL）→ GOODTRAP。
2. **灵敏度对照（无条件执行）**："已知应有差异"的对照（如不执行清零指令、确认目标状态真的会被改变），证明用例不是恒真。
3. **一致性追问（无条件执行）**：异常/trap 返回、flushPipe、vsetvli 重配置之后打 `STATE_FENCE` 快照，与触发前快照自对照；再 csrr 读回 CSR 对比。
4. **决定性实验**：读一个从未被写过的相邻向量寄存器（经 refbuf 自对照），判断污染是否经旁路/检查点扩散。

每个用例带 `#meta:` 行（sew/lmul/vl/变量取值）。结果处理纪律：

- **任何 ABORT** → `--emu-args "--dump-ref-trace"` 重跑一次 + `trace_diff.py` 拿控制流首分歧上下文，结论进 `trace_diff` 字段。
- **看门狗复核**（一杀一审，见执行层）→ `hang_reports`。
- **异常上报**：解释不了的观察一律进 `anomalies`（喂异常池），宁多勿漏。

产出 schema：

```json
{
  "first_test": "PASS | ABORT | ERROR(环境问题)",
  "consistency": "一致性追问结果及发现的任何分歧(双值)",
  "divergence": "发现的 DUT/REF 分歧详情，无则 null",
  "trace_diff": "有 ABORT 时必填: 控制流首分歧在哪 / 控制流一致仅数据分歧",
  "status": "reproduced | masked | not-reproduced | env-error",
  "artifacts": ["artifacts/S1/variant1/..."],
  "next_batch": ["下一轮 Isolate 的 3-6 个正交单变量变体, 每条只改一个变量"],
  "anomalies": [{"observation": "...", "expected": "...", "channel": "difftest|commit-trace|ref-trace-diff|waveform|perf-outlier|watchdog|other", "strength": "strong|medium|weak", "evidence": ["路径"]}],
  "hang_reports": [{"case": "...", "verdict": "KILLED_SPIN", "ruling": "TRUE_HANG|FALSE_KILL|UNCLEAR", "detail": "...", "sig_id": "...", "merged_cases": [], "signature_draft": null, "requeues": 0}],
  "wave_notes": "若用了波形取证的经验记录"
}
```

## Phase 3 — Isolate（变量控制隔离，批次轮）

- **由 Workflow 的 JS 循环驱动**，不是 agent 自己决定何时停。终止条件（代码判定）：
  1. 轮数达到 `max_variants`（批次轮上限）；
  2. 连续一轮"无新信息"；
  3. `next_batch` 为空（已收敛）。
- **每轮 agent 测一批（3-6 个）正交单变量变体**——"一次只改一个变量"是**归因纪律，不是执行顺序约束**：每个变体相对基线只改一个变量，变体之间彼此正交，一次交给 run_batch.py 并行跑完，读 summary.tsv 逐个归因（`variants_tested`）。旧版"每轮一个变量、4-8 轮串行"收敛的内容，现在 1-2 轮批次完成。
- **深挖解锁**：一旦拿到确定性 ABORT 复现，本轮批次必须额外包含：(a) 双跟踪重跑 + trace_diff 首分歧上下文；(b) **最小化**——从复现用例删减出 3-5 个候选精简版并行跑，保住 ABORT 的最小版本即 repro ELF。
- 每轮产出归因五选一：

| 归因 | 含义 |
|---|---|
| `wrong-target-write` | 目标寄存器/CSR 被写错值 |
| `bypass-checkpoint-pollution` | 污染经旁路/检查点扩散（换目标寄存器仍复现） |
| `commit-timing` | 提交时序问题（同拍顺序、写回时序） |
| `protocol-timing-violation` | 波形上的时序/协议矛盾（实际与预期不符，预期来自规范或对代码意图的推断）；架构状态不变，difftest 抓不到 |
| `not-reproducible` | 本轮未能复现 |

- 记录 `repro_rate`（复现次数/尝试次数）；`0 < repro_rate < 1` 判为竞态特征，写入结论。
- schema 同 Probe 增加 `variants_tested` / `anomalies` / `hang_reports` / `next_batch`；循环退出时 JS 补 `rounds_used` 与 `rounds_repro_rate`（轮级复现比，**不覆写** agent 上报的用例级 `repro_rate`——竞态判据在后者上）。

### Diagnose（挂死悬案诊断，按需插入）

Probe/Isolate 的 hang_reports 里仍有 `UNCLEAR` 的，进 Skeptic 前由 JS 插入一个专门诊断 agent：读证据包定位停驻 cycle → `--wave` 确定性重放圈窗口 → `vcd_extract.py` 抽疑点模块接口信号与提交通道信号 → 判断流水线哪一级停了、在等什么。裁决 `TRUE_HANG`（根因+签名草稿）/ `FALSE_KILL`（绊线修正建议）/ `STILL_UNCLEAR`（如实说卡在哪）。

## Phase 4 — Skeptic（对抗复核）

专门雇一个"推翻者"agent，任务不是验证而是推翻。**difftest 可判型**结论必做三件事：

1. **重跑最小复现**：用留下的用例经 run_batch.py 原样重跑，确认 ABORT 可复现（runs.jsonl 自动留档，可与历史 run 比对）。
2. **验证灵敏度对照真实性**：检查 Probe 阶段的对照用例确实"已知应有差异"，否则整条证据链作废。
3. **逐行核对"机制规避"结论**：对分类为"被机制天然规避"的疑点，逐行读其依赖的机制代码，确认该机制在所有路径上都成立。

**timing-only / protocol-timing-violation 型**结论重跑 difftest 恒 PASS、不构成复核，三件事换成波形版：重现异常序列（同窗口重放 + 同信号抽取，dump 不出来结论即不成立）/ 复核"预期"本身（规范核条款原文；推断重走推断链并尝试推翻）/ 自对照（同类交互的其他实例确认"异常"不是常态行为）。

产出 verdict 三选一：

- `CONFIRMED`：结论成立，进入汇总。
- `REFUTED`：结论被推翻。**不回环重做**，标记"人工复核"，原结论与推翻理由一并呈现。
- `DOWNGRADED`：结论部分成立，改写为更弱的表述（如"bug"降为"竞态特征"）。

## Phase 5a — Triage（跨疑点异常池分诊）

**动机**：深挖不足的根源之一是"解释不了的观察"没有去处——它们死在单个 agent 的上下文里。S1 的真 bug 来自"原假设被证伪后的一个顺手观察"；异常池把这种运气制度化。

- **异常池收集（纯代码，零 token）**：所有疑点流水线结束后，JS 汇集 Probe/Isolate 两阶段的 `anomalies` + 一杀一审确认的 `TRUE_HANG` + **Diagnose 重放诊断确诊的 TRUE_HANG**（`resolutions` 里改判的也进池——最难诊的不能反而漏掉），自动转为 strong 异常。
- **Triage agent**（池非空才起）：
  1. `clusters`：聚类——哪些异常是同一现象？**跨疑点重复出现的簇是强信号**（单个 agent 看不见这种重复，这正是池存在的意义）。
  2. `promoted`：晋升为新疑点（**每轮上限 5 条**防爆炸）。判据：现有结论解释不了 + 强度够（strong，或跨疑点重复的 medium）+ 能写出可检验 claim。**每条带 `evidence`（artifact 路径/run 记录）**——晋升的疑点进下一 sweep 时不再是一句话从零跑，`describeSuspicion` 会把证据一并写进各阶段 prompt。id 用 `T-` 前缀。
  3. `dropped`：未晋升异常逐条给理由（与已知问题一致/太弱且孤立/已被解释）。
- 晋升条目与 follow_ups 合并、按 id 去重后进入下一 sweep 队列（见外层大迭代）。

## Phase 5b — Synthesize（汇总沉淀）

- **barrier**：所有疑点的流水线（含 unreachable 短路路径）+ Triage 全部结束后才执行，单 agent 汇总（Triage 结果作为输入之一）。
- 产出：
  1. **分类表**：每疑点 → 真实可触发（bug）/ 时序或协议异常（difftest 抓不到、靠波形定的那一类，必须写明预期是什么、预期来自成文规范还是对代码意图的推断）/ 被机制天然规避（写明哪条机制）/ 当前配置不可达（写明何时暴露）/ 已知问题-已跳过（命中 filterlist，写明 matched_known_id 与 filtered_at_phase；命中前已跑的部分结果是补充证据，写进证据链）。
  2. **证据链**：每条结论 → 对应的 ABORT 日志 / trace_diff 首分歧结论 / 提交跟踪 / VCD 波形 / ELF 路径。
  3. **复现清单**：最小复现 ELF 名单（含 Isolate 深挖最小化产出的精简版；必须保留在 artifacts 下，不删）。
  4. **覆盖面声明**：明确列出没测到的路径（如其他 VLEN、其他 sew/lmul 组合、多 harts）。
  5. **findings.md 条目草稿**：agent 只产出草稿文本，**不直接修改任何共享文件**（findings.md 由人工或主会话合入）。
  6. **watchdog_notes（看门狗回流）**：kill/一杀一审统计（TRUE_HANG/FALSE_KILL/UNCLEAR 各几例）、FALSE_KILL 误杀原因与绊线阈值/白名单修正建议、新挂死签名草稿汇总（供人工合入 `hypotheses/hang-signatures.json`）。这是绊线持续校准的闭环。
  7. **wave_method_notes**：汇总本轮各阶段的 `wave_notes`——什么判据有效、什么无效、下次该怎么改；本轮无人用波形则留空，不要编。
  8. **follow_ups**：未被 Triage 晋升但值得记录的新疑点，有支撑材料就带 `evidence`；与 promoted 不重复。

## 外层大迭代（loop-until-dry）

每轮 sweep 结束后：下一轮队列 = **Triage `promoted`（带证据，优先）+ Synthesize `follow_ups`**，按 id 对全历史去重（`seen` 集合）。终止：轮数达 `max_sweeps` 或队列为空。剩余未验证疑点在返回值 `unfinished` 里，不静默丢弃。

## 并行与规模

- **实测基线（2026-08-25）**：单次仿真平均 25.3 s（历史 516 次），emu 每实例 1 核（99% 单核，NLWP=12 但 11 个线程 idle），启动开销仅 ~1.1 s（合并用例不划算，隔离性优先），稳态 ~250-300 cycles/s。
- **两级并行**：疑点间流水线不互等（Workflow 层）；疑点内一批用例经 runner 全局槽位并行（默认 8 槽 = 7 普通 + 1 优先保留，`RB_SLOTS` 调节；跨 agent 共享，防止 N 个 agent 各开 M 个 emu 压垮 12 核）。实测 5 用例批 26 s 跑完（含看门狗击毙 3 例），CPU 329%。
- 每疑点 3-7 个 agent（Hypothesize 1 + Probe 1 + Isolate 批次轮 1-2 + Diagnose 0-1 + Skeptic 1）；批次轮取代旧的串行变体轮后，agent 数量与轮次同时下降。Filter 关卡与旧版一致：无候选零开销。
- 挂死不再烧 timeout：绊线 ~20-30 s 击毙（旧版最长 525 s），FAIL 自环秒判 `SELF_TEST_FAIL`。

## 非目标

- 不自动修 RTL 代码、不开 PR。
- 不做随机 fuzz（本工作流是定向验证，输入必须是人给的疑点清单）。
- 不重建 emu/NEMU（环境已就绪）。
- 不直接写共享 findings 文件（只出草稿）。
- 不做定时轮询的看门狗 subagent：检测交给绊线脚本（8 s 粒度、机械判据），LLM 只做事件触发的复核/诊断（一杀一审）。
