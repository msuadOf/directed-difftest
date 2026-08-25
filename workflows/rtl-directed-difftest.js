// RTL 疑点定向 DiffTest 验证工作流
// 设计文档: docs/workflow-detailed.md
// 用法: 在 Claude Code 会话中说"用 workflow 跑 rtl-directed-difftest, 疑点文件 hypotheses/xxx.json"
// (Workflow 工具以 scriptPath 加载本文件, 疑点 JSON 内容经 args 传入)
// filterlist(可选, args.filterlist): 已知问题清单, 见 hypotheses/known-issues.json 与下方 Phase 0 说明
//
// 架构(三层, 见文档「执行层与看门狗」「分析层」「异常池与 Triage」):
//   证据层: scripts/run_batch.py —— 并行槽位+三级看门狗+runs.jsonl, 所有仿真必经;
//   分析层: trace_diff / vcd_extract / runs_query 蒸馏工具, agent 读蒸馏结果不啃原始数据;
//   决策层: 本文件的各阶段 agent + 跨疑点异常池 + Triage 晋升。

export const meta = {
  name: "rtl-directed-difftest",
  description:
    "对 XiangShan RTL 疑点做定向 DiffTest 验证: 假设化 -> 首测探针 -> 变量隔离 -> 对抗复核 -> 异常池分诊 -> 汇总沉淀",
  phases: ["filter", "hypothesize", "probe", "isolate", "skeptic", "triage", "synthesize"],
};

// ---- 环境信息（写进所有需要跑仿真的 agent prompt） ----
// 所有路径相对本仓库(directed-difftest)根; xiangshan 是 submodule(pin 7bf51a8),
// 首次使用先跑 ./scripts/setup-env.sh 拷入预编译 emu 与 REF
function envBlock() {
  return `## 环境（勿重建; 若 xiangshan/build/emu 缺失, 提示用户跑 ./scripts/setup-env.sh）
- 【仿真必经 runner】所有 DiffTest 仿真一律走 scripts/run_batch.py, 禁止直接调 emu(取波形也走它的 --wave):
  python3 scripts/run_batch.py -o artifacts/<疑点id>/variant<N>/ a.S b.S c.S ...
  它自动完成: 交叉编译(toolchain.sh 特性探测, gcc 15.1 支持 RVV 助记符)、全局槽位并行(每 emu 实测占 1 核, 默认 8 槽跨 agent 共享, 12 核机器近线性加速)、-C 周期封顶、--dump-commit-trace、stdbuf 行缓冲、SIGINT 体面杀、看门狗止损、runs.jsonl 记录、summary.tsv 汇总。
  【批量思维】把首测/对照/变体一批 .S 一次交给它并行跑, 不要写一个跑一个 —— 串行等仿真是此前 workflow 最大的时间浪费。
- runner 终态: GOODTRAP | ABORT | SELF_TEST_FAIL(自检 FAIL 自环, 看门狗已认出, 无歧义) | CYCLE_CAP | WALL_TIMEOUT | KILLED_SPIN/STALL/RUNAWAY(看门狗击毙) | COMPILE_ERROR。KILLED_*/CYCLE_CAP/WALL_TIMEOUT 是机检初判, review=pending, 你必须一杀一审(见「看门狗复核」节)。
- 蒸馏工具(读蒸馏结果, 不要人肉啃原始日志/VCD):
  - scripts/trace_diff.py <log> --elf <elf>: DUT/REF 双跟踪对齐, 控制流首分歧±上下文+反汇编注解。ABORT 后必用: 先 run_batch.py --emu-args "--dump-ref-trace" 重跑该用例一次得到双跟踪日志。
  - scripts/vcd_extract.py <vcd> -s <信号正则> [--begin/--end]: 波形窗口抽成紧凑 CSV(先 --list 侦察信号名; 提交通道在 rob.difftest_commit_*)。
  - scripts/runs_query.py: runs.jsonl 运行数据库查询; --outliers 对同类 run 做 cycles 离群检测(自对照异常的廉价前置过滤器); --pending-review 列待复核。
- 用例模板 templates/case-template.S 三约定: #meta: 行写 ISA 参数(进 runs.jsonl 供跨 run 关联分析); 故意轮询循环标 POLL_ 前缀(看门狗符号白名单; 写回值每轮变化的延时循环不需要); FAIL 用独立标签+两条指令自环。模板另提供 STATE_FENCE 宏: 关键事件后全量向量状态快照(v0-v31+vstart/vl/vtype/vcsr 存 buffer), 是"一致性追问"的标准做法(注意宏会破坏 vtype/vl, 旧值已存入快照)。
- DUT emu: xiangshan/build/emu (MinimalConfig, VLEN=128, Verilator; 已验证完整支持 RVV 执行); REF: xiangshan/ready-to-run/riscv64-nemu-interpreter-so; 入口 0x80000000, 结束放 GOODTRAP: .word 0x0000006b
- 【重要】向量指令一律用 RVV 助记符让汇编器编码(如 vsetvli/vadd.vv), 严禁手工计算 .4byte 编码 —— 历史上手搓编码曾把 illegal 指令误判为"emu 不支持 RVV"。参考验证过的编码: vsetvli x0,x6,e32,m1,ta,ma = 0x0d037057
- 【重要】向量执行前必须使能 mstatus.VS 字段(bits 10:9, 值 0x600): csrr t0,mstatus; ori t0,t0,0x600; csrw mstatus,t0。写错位(如 1<<25)会挂死。且必须设 mtvec 指向 .balign 4 的 trap handler(mtvec.base 掩低 2 位, 未对齐会跳到掩码地址)。这两条挂死形态签名库已覆盖(WD-vs-disabled-vector-hang / WD-mtvec-misalign-spin), 看门狗会秒判, 但写对省一轮复核。
- 【判据陷阱】未设 mtvec 时 double-trap 会打印伪造 "HIT GOOD TRAP"+乱码 pc; j .(jal-to-self) 也终止为 GOODTRAP(所以自环一律两条指令); instrCnt/cycleCnt/--dump-db 均不可用作观测通道。唯一可靠判据: ABORT(DUT vs REF 分歧, 看 summary 的 first-div 与日志 "different at pc" 双值)+提交跟踪中确实提交了向量指令。
- 【判据陷阱·续】(1) 读回向量寄存器一律 vse 存内存再 load, 禁用 vmv.x.s —— 它有已知 F1 符号扩展 bug(ta 策略下高位污染), 用它读回会把已知 bug 的 ABORT 误归因到被测疑点; (2) 未写过的向量寄存器在 difftest 下随机初始化、非 0, 不得断言"未写 vN==0", 自对照要先 vse 存初值到 refbuf 末尾再比对; (3) 32bit 期望值比较用 lwu 而非 lw(lw 符号扩展使 0xdeadbeef 类高位为 1 的期望值永不相等)。
- XiangShan 源码在 submodule xiangshan/ (禁止修改其中任何文件)
- 【磁盘保护·必做】每次 shell 会话开头先执行 ulimit -f 2097152 (1GB, 512B 块计), 再编译/跑仿真 —— 超过 1G 内核直接拒绝写入并向进程发 SIGXFSZ 终止进程。spike -l / emu 重定向日志曾失控写满 3.4T /home。禁止用 /dev/shm 等内存盘, 一切中间文件写工作目录 artifacts/ 下。
- 中间文件一律写 artifacts/<疑点id>/variant<N>/ 下（相对本仓库根目录）`;
}

// ---- 看门狗复核职责(write-back 一杀一审, 写进所有跑仿真的 agent prompt) ----
// 设计: 绊线脚本先杀住让槽位继续流转(write-back 语义), 拥有该用例的 agent(就是你)
// 立即复核 —— 你在等这个结果, 你有全部上下文(用例是你写的), 复核零交接成本。
function watchdogBlock() {
  return `## 看门狗复核（一杀一审, 优先于其他分析）
summary.tsv 里出现 KILLED_*/CYCLE_CAP/WALL_TIMEOUT 时, 立即复核该用例(它们是机检初判, 不是定论):
1. 读 <outdir>/<case>.evidence.json: 触发原因、符号化停驻位置、最后 64 条提交、日志尾。对照用例源码与反汇编(交叉 objdump -d)判断, 三选一裁决:
   - TRUE_HANG: 真挂死/跑飞。记入 hang_reports(写清停驻位置、最后退休指令、根因判断); 若 known_hang 已标注已知签名, 按 hypotheses/hang-signatures.json 该条目的 verify 字段核实(标注只是提示不是定论); 若是新形态, 在 signature_draft 里给一条新签名条目草稿(id/symptom/match/verify)。
   - FALSE_KILL: 误杀(如漏标 POLL_ 的合法轮询、合法长运行触 CYCLE_CAP)。带修正立即重跑: 补 POLL_ 标签 / --stall-sec 60 / 提高 -C 或 --wall, 并加 --priority 插队(有下游工序在等)。同一用例最多重入队 2 次, 再触发必须转 TRUE_HANG 或 UNCLEAR, 不许无限乒乓。误杀原因写进 hang_reports —— 它是绊线阈值校准的回流输入。
   - UNCLEAR: 证据包解释不通。确定性重放取波形(Verilator 同 seed 必然同 cycle 复现): run_batch.py --wave 圈停驻 cycle 附近窗口, vcd_extract.py 抽疑点相关信号看停驻时序; 仍解释不通就留 UNCLEAR, 上层会派专门诊断 agent。
2. 同签名合并(MSHR 语义): 一批里多个 kill 的 sig_id 相同只审一次, 裁决套用到全部, hang_reports 里注明合并了哪些用例(签名 locus 已按符号名去偏移归一化, 同根因的不同变体会得到相同 sig_id)。
3. 每完成一例裁决, 立即销案: python3 scripts/runs_query.py --resolve <runs.jsonl 里的 case 字段值> --ruling <TRUE_HANG|FALSE_KILL|UNCLEAR> --note "<一句话结论>" —— 否则该 run 在 --pending-review 队列里永远挂着, 数据库层面不收敛。
4. SELF_TEST_FAIL 不需要复核(看门狗已确认停驻在 FAIL 自环, CHECK 确实执行过), 直接当自检失败分析。`;
}

const reportHint =
  "报告务必简洁，只给 schema 要求的字段与关键证据路径，不要贴大段日志。";

// ---- 异常上报纪律(喂给跨疑点异常池, 深挖机制的输入) ----
function anomalyBlock() {
  return `## 异常上报（不许丢弃"解释不了的观察"）
任何与当前假设无关、但你解释不了的观察 —— 意外的错值形态、意外 trap、runs_query --outliers 报的周期数离群、双跟踪里可疑但未定性的差异 —— 都必须记进 anomalies 数组(observation/expected/channel/strength/evidence)。它们进入跨疑点异常池, 由 Triage 聚类晋升为新疑点。历史教训: S1 的真 bug 就藏在"原假设被证伪后的一个顺手观察"里; 异常池就是把这种运气制度化。宁多勿漏, 弱信号也要报(strength=weak)。`;
}

// ---- 波形取证方法论（实验性, 尚在使用中完善） ----
// 动机: difftest 只能抓"架构状态分歧"—— DUT 与 REF 提交的寄存器/内存值不同才 ABORT。
// 有一整类问题它天然抓不到: 不改变架构状态、只表现为时序/协议异常的问题(协议违例、
// 握手异常、性能塌陷、活锁/死锁边缘)。而且 REF(NEMU)根本没有微架构时序模型, 无从对比。
// 【本方法论尚不成熟】判据大量依赖人的经验, 每次使用都要如实记录什么有效什么无效,
// 这些记录本身就是完善它的输入 —— 见各阶段 schema 的 wave_notes 字段。
function waveMethodBlock() {
  return `## 波形取证（实验性方法论, 用完请回报经验）
difftest 只抓架构状态分歧; 若疑点属于"不改变架构状态、只体现为时序/协议异常"那一类, difftest 会一路 PASS 而问题仍在, 必须看波形。
操作路径: 提交跟踪/trace_diff 定位大致周期 -> run_batch.py --wave 重放(确定性保证同 cycle 复现, 全程零波形开销只为出事窗口付费) -> vcd_extract.py --list 侦察信号名 -> -s 正则+--begin/--end 抽 CSV -> 在 CSV 上找矛盾。廉价前置: runs_query.py --outliers 先在周期数上找自对照离群, 再决定对哪个 run 取波形。

### 通用做法
波形判据本质上永远是"预期 vs 实际"的对照, 所以:
1. **先把预期写下来, 并注明预期的来源**。来源只有两类, 判据硬度不同, 结论里必须写清是哪一类:
   - **成文规范**(协议标准、接口契约、文档化的时序约定): 判据硬, 可逐条引用条款;
   - **对代码意图的推断**(读 RTL 推出"这里应该几拍完成、应该按什么顺序发生"): 判据软 —— 推断本身可能就是错的, 那样你看到的"异常"其实是正常行为。必须把推断链写出来, 让别人能推翻它。
2. **选观察窗口**: 这类问题的判据是"一整段序列"而不是"某一拍的电平", 窗口要长到覆盖一次完整交互(常在数十个时钟周期量级)。
3. **找矛盾**, 三种形态:
   - 违反规范条款;
   - 与代码意图不符: 该发生的没发生 / 不该发生的发生了 / 顺序反了 / 拍数远超预期;
   - **自对照不一致**: 同一种交互这次 N 拍、那次 10N 拍, 或同样条件下两次行为不同。这一类不需要任何外部规范或领域知识就能发现, 成本最低, 应该优先试。
4. **回报经验**(见下)。

### 从哪里开始看
不要从"某个子系统的检查清单"出发, 从疑点自身出发: 疑点涉及的模块, 其**对外接口**是第一观察点 —— 接口通常有契约, 最容易建立预期; 跨模块边界的信号比模块内部信号判据更硬。

### 形态举例（**这是举例, 不是待查清单**）
下面几条只用来说明上述三类矛盾具体长什么样。**换一个子系统就该换一组完全不同的例子**, 不要把搜索范围限制在这几条上, 也不要因为疑点跟这几条对不上就认为没问题:
- 握手类协议(如 AXI/TileLink): valid 拉高后 ready 迟迟不来; valid 在握手完成前被撤销; 响应乱序返回; 传输越过边界; 结束标志落在错误的拍上。
- 存储层次(如 cache): 某类访问的完成拍数远超同类访问的常态; 资源表项占用与释放不配平。
以上任何一条都可能在你这个疑点里根本不适用 —— 判据要从疑点自身的预期推出来, 而不是从这张表里挑一条套上去。

### 必须回报(写进 wave_notes)
看了哪些 scope/信号、窗口多长、预期来自规范还是推断(注明哪一类)、以及**哪些尝试是无效的**。无效经验同样有价值: 它是缩小下次搜索范围的依据。本方法论尚不成熟, 这些记录就是完善它的输入。`;
}

// ---- schemas ----
const anomaliesSchema = {
  type: "array",
  description: "解释不了的观察, 进跨疑点异常池; 没有则空数组",
  items: {
    type: "object",
    properties: {
      observation: { type: "string" },
      expected: { type: "string" },
      channel: {
        type: "string",
        enum: ["difftest", "commit-trace", "ref-trace-diff", "waveform", "perf-outlier", "watchdog", "other"],
      },
      strength: { type: "string", enum: ["strong", "medium", "weak"] },
      evidence: { type: "array", items: { type: "string" } },
    },
    required: ["observation", "expected", "channel", "strength"],
  },
};

const hangReportsSchema = {
  type: "array",
  description: "看门狗击毙用例的一杀一审裁决记录; 本批无 kill 则空数组",
  items: {
    type: "object",
    properties: {
      case: { type: "string" },
      verdict: { type: "string", description: "runner 给的机检初判, 如 KILLED_SPIN" },
      ruling: { type: "string", enum: ["TRUE_HANG", "FALSE_KILL", "UNCLEAR"] },
      detail: { type: "string" },
      sig_id: { type: ["string", "null"] },
      merged_cases: { type: "array", items: { type: "string" }, description: "同签名合并审理的其他用例" },
      signature_draft: { type: ["string", "null"], description: "新挂死形态的 hang-signatures.json 条目草稿" },
      requeues: { type: "number", description: "FALSE_KILL 重入队次数" },
    },
    required: ["case", "verdict", "ruling", "detail"],
  },
};

const hypothesizeSchema = {
  type: "object",
  properties: {
    trigger: { type: "string" },
    expected: { type: "string" },
    masking: { type: "string" },
    testability: {
      type: "string",
      enum: ["reachable", "masked-reachable", "timing-only", "unreachable"],
    },
    sensitivity: { type: "string" },
  },
  required: ["trigger", "expected", "masking", "testability", "sensitivity"],
};

const probeSchema = {
  type: "object",
  properties: {
    first_test: { type: "string", enum: ["PASS", "ABORT", "ERROR"] },
    consistency: { type: "string" },
    divergence: { type: ["string", "null"] },
    trace_diff: {
      type: ["string", "null"],
      description: "有 ABORT 时必填: trace_diff.py 结论(控制流首分歧在哪 / 控制流一致仅数据分歧)",
    },
    status: {
      type: "string",
      enum: ["reproduced", "masked", "not-reproduced", "env-error"],
    },
    artifacts: { type: "array", items: { type: "string" } },
    next_batch: {
      type: "array",
      items: { type: "string" },
      description: "下一轮 Isolate 的正交单变量变体清单(3-6 条, 每条只改一个变量); 无需隔离则空数组",
    },
    anomalies: anomaliesSchema,
    hang_reports: hangReportsSchema,
    wave_notes: {
      type: "string",
      description:
        "若用了波形取证: 看了哪些 scope/信号、窗口多长、判据是对照协议条款还是对代码意图的推断、哪些尝试无效。没用波形则留空。这些记录用于完善波形方法论。",
    },
  },
  required: [
    "first_test",
    "consistency",
    "divergence",
    "status",
    "artifacts",
    "next_batch",
    "anomalies",
    "hang_reports",
  ],
};

const isolateSchema = {
  type: "object",
  properties: {
    attribution: {
      type: "string",
      enum: [
        "wrong-target-write",
        "bypass-checkpoint-pollution",
        "commit-timing",
        "protocol-timing-violation",
        "not-reproducible",
      ],
    },
    variants_tested: {
      type: "array",
      description: "本轮批次每个变体一条: 改了什么变量、终态、发现",
      items: {
        type: "object",
        properties: {
          var: { type: "string" },
          verdict: { type: "string" },
          finding: { type: "string" },
        },
        required: ["var", "verdict"],
      },
    },
    repro_rate: { type: "number" },
    findings: { type: "string" },
    new_information: { type: "boolean" },
    next_batch: {
      type: "array",
      items: { type: "string" },
      description: "下一轮正交单变量变体清单; 已收敛则空数组",
    },
    anomalies: anomaliesSchema,
    hang_reports: hangReportsSchema,
    wave_notes: {
      type: "string",
      description: "同 probe: 本轮若用了波形取证, 记录 scope/信号/窗口长度/判据/无效尝试。",
    },
  },
  required: [
    "attribution",
    "variants_tested",
    "repro_rate",
    "findings",
    "new_information",
    "next_batch",
    "anomalies",
    "hang_reports",
  ],
};

const diagnoseSchema = {
  type: "object",
  properties: {
    resolutions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          case: { type: "string" },
          ruling: { type: "string", enum: ["TRUE_HANG", "FALSE_KILL", "STILL_UNCLEAR"] },
          cause: { type: "string" },
          signature_draft: { type: ["string", "null"] },
        },
        required: ["case", "ruling", "cause"],
      },
    },
    wave_notes: { type: "string" },
  },
  required: ["resolutions"],
};

const filterSchema = {
  type: "object",
  properties: {
    matched: { type: "boolean" },
    matched_id: { type: ["string", "null"] },
    reason: { type: "string" },
  },
  required: ["matched", "matched_id", "reason"],
};

const skepticSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["CONFIRMED", "REFUTED", "DOWNGRADED"] },
    checks: { type: "string" },
    revised_conclusion: { type: "string" },
  },
  required: ["verdict", "checks", "revised_conclusion"],
};

const triageSchema = {
  type: "object",
  properties: {
    clusters: { type: "string", description: "异常池聚类结果概述: 哪些异常是同一现象、跨了哪些疑点" },
    promoted: {
      type: "array",
      description: "晋升为新疑点的簇(每轮上限 5 条), 带证据进入下一 sweep; 判据: 强度高/跨疑点重复/现有结论解释不了",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          file: { type: "string" },
          line: {},
          claim: { type: "string" },
          evidence: { type: "array", items: { type: "string" }, description: "支撑该疑点的 artifact 路径/run 记录/异常来源" },
        },
        required: ["id", "file", "claim", "evidence"],
      },
    },
    dropped: { type: "string", description: "未晋升异常及理由(已知问题/太弱/已被解释)" },
  },
  required: ["clusters", "promoted", "dropped"],
};

const synthSchema = {
  type: "object",
  properties: {
    summary_table: { type: "string" },
    evidence_chains: { type: "string" },
    repro_elufs: { type: "array", items: { type: "string" } },
    coverage_gaps: { type: "string" },
    findings_draft: { type: "string" },
    watchdog_notes: {
      type: "string",
      description:
        "看门狗回流: 本轮 kill/一杀一审统计(TRUE_HANG/FALSE_KILL/UNCLEAR 各几例)、FALSE_KILL 误杀原因与绊线阈值/白名单修正建议、新挂死签名草稿汇总(供人工合入 hang-signatures.json); 本轮无 kill 则留空",
    },
    wave_method_notes: {
      type: "string",
      description:
        "汇总各阶段 wave_notes 里的波形取证经验: 什么判据有效、什么无效、下次该怎么改。波形方法论仍在完善中, 这一栏是它的迭代输入; 本轮无人用波形则留空。",
    },
    follow_ups: {
      type: "array",
      description: "本扫荡轮(sweep)发现的新疑点(副产品/覆盖缺口), 作为下一个 sweep 的输入; id 若与已验证疑点重复会被跳过; 与 Triage 已晋升的不要重复",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          file: { type: "string" },
          line: {},
          claim: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
        },
        required: ["id", "file", "claim"],
      },
    },
  },
  required: [
    "summary_table",
    "evidence_chains",
    "repro_elufs",
    "coverage_gaps",
    "findings_draft",
  ],
};

// ---- pipeline ----
// agent 包装: 统一带 phase 归组与结构化 schema
const run = (ph, label, prompt, schema) =>
  agent(prompt, { label, phase: ph, schema });

const basename = (p) => String(p || "").split("/").pop();

// ---- filterlist 机制: 已知问题跳过, 以"贯穿各阶段的关卡"形式实现 ----
// 目的: 已知问题(上游已报告/已确认, 或本仓库之前已被 Skeptic 确认过的定论)不必再花
// 几十分钟仿真去"重新发现"一遍。
// 【分类轴只能是现象】filterlist 条目的身份由 symptom(可观测的架构状态/指令/行为/判据)
// 与 keywords(同样是现象级词汇: 指令名、CSR 名、ISA 术语、错值形态)定义。内部实现细节
// (RTL 模块名、信号名、文件行号)一律只能进 internals/note 备注字段, 不参与匹配, 也不得
// 作为"是同一个问题"的判定理由 —— 同一个文件/模块里完全可能藏着两个不同的 bug, 而同一个
// 现象也可能在重构后换到另一个模块。hint_file 只是生成候选用的廉价线索, 不是分类依据。
// 为什么不是一次性的前置检查: 疑点刚进来时只有一句 claim, 信息量最少, 常常看不出它跟
// 某条已知问题是同一个; 而每跑完一个阶段描述都会显著变具体(Hypothesize 给出完整根因链,
// Probe 给出实际观测到的错值形态, Isolate 给出归因), 往往到这时才认得出
// "这就是那个已知问题"。所以每个阶段结束后都拿累积到的全部证据重新比对一次, 一旦确认命中,
// 后续阶段(尤其是昂贵的 difftest 仿真)全部跳过, 已经跑出来的部分结果照常带进 Synthesize。
// 匹配两步走, 保证绝大多数疑点零 token 成本:
//   1. 纯代码预筛(不花 token): "累积证据文本"命中某条已知问题的任一 keyword(现象级词汇),
//      或疑点 file 的文件名与其 hint_file 相同, 才算候选。预筛用累积证据而不是只用原始
//      claim —— 后期阶段才说得出口的现象描述(实测到的错值形态、涉及的指令名、架构状态名)
//      正是命中关键词的主要来源。
//   2. 只有出现候选时才调用一次轻量 agent 做语义复核(允许措辞、复现参数、具体数值不同,
//      只要"表现出来的现象"是同一个就算同一个); 没有候选则完全不产生 agent 调用。
//   原则: 宁可漏判(继续走完整验证)也不错判掉一个可能是新问题的疑点。
// 每疑点的关卡 agent 调用数上限 MAX_GATE_CALLS, 触顶后不再复核并 log 出来(不静默截断)。
// filterlist 数据格式与维护方式见 hypotheses/known-issues.json 与 docs/workflow-detailed.md。
const MAX_GATE_CALLS = 5;

function makeFilterGate(s, filterlist, suspicionDesc) {
  const list = filterlist || [];
  const evidence = [`原始 claim: ${s.claim}`];
  const history = [];
  let calls = 0;
  const gate = async function (phase, newEvidence) {
    if (newEvidence)
      evidence.push(`${phase} 阶段结果: ${JSON.stringify(newEvidence)}`);
    if (list.length === 0) return null;
    const blob = evidence.join("\n");
    const candidates = list.filter((k) => {
      const hb = basename(k.hint_file || k.file);
      return (
        (k.keywords || []).some((kw) => blob.includes(kw)) ||
        (hb !== "" && hb === basename(s.file))
      );
    });
    if (candidates.length === 0) return null;
    if (calls >= MAX_GATE_CALLS) {
      log(`${s.id}: 已知问题关卡调用已达上限 ${MAX_GATE_CALLS}, @${phase} 起不再复核`);
      return null;
    }
    calls += 1;
    const r = await run("filter", `Filter ${s.id} @${phase}`, `你是疑点去重判定专家。判断以下疑点与"已知问题清单"中的某一条, **表现出来的现象**是不是同一个。

【判定轴只能是现象】现象 = 可观测的架构状态与行为: 哪条(类)指令、哪个寄存器/CSR/内存位置、错成什么形态、在什么 ISA 级参数(SEW/LMUL/ta-tu/vstart 等)下复现与被掩盖、difftest 的判据长什么样。允许措辞、复现参数、具体数值不同, 只要现象是同一个就算同一个。
【不得据以判定 matched=true 的理由】"落在同一个文件/同一个 RTL 模块里"、"提到了同一个内部信号名"—— 同一个模块里完全可能藏着两个不同的 bug。候选条目里的 hint_file / internals 字段只是备注, 帮你理解背景, **不是**判定依据; 只有 symptom 描述的现象才是。反过来也一样: 现象一致但落点模块不同(比如同一条链的上游 vs 下游), 仍应判为同一个。

${suspicionDesc}

当前已跑完的阶段: ${phase}。以下是从原始 claim 到该阶段累积的全部证据(越靠后越是实测出来的现象, 判断权重越高):
${blob}

候选已知问题(已按关键词/文件名预筛, 非全量清单):
${JSON.stringify(candidates, null, 2)}

若现象确系同一个: matched=true, matched_id 取候选的 id 字段 —— 该疑点会立刻跳过后续所有阶段(包括昂贵的 difftest 仿真)。若不确定, 或现象明显不同, 或它正落在某条已知问题 note 里写明的"尚未覆盖、值得继续深挖的子角度"上: matched=false, matched_id=null, 疑点继续走完整验证流水线。宁可漏判也不要错判掉一个可能是新问题的疑点。reason 里要写清你比对的是哪两个现象。${reportHint}`,
      filterSchema);
    history.push({ phase, matched: r.matched, matched_id: r.matched_id, reason: r.reason });
    if (!r.matched) return null;
    return { phase, matched_id: r.matched_id, reason: r.reason, history };
  };
  gate.history = history;
  return gate;
}

// 疑点描述: Triage 晋升/follow_ups 带 evidence 时一并呈现(不再是一句话从零跑)
function describeSuspicion(s) {
  let d = `疑点 ${s.id}: ${s.file}:${s.line}
预期错误(claim): ${s.claim}`;
  if (s.evidence && s.evidence.length)
    d += `\n已有证据(来自上一轮异常池/汇总, 验证时先复用再补新):\n${s.evidence.map((e) => `- ${e}`).join("\n")}`;
  return d;
}

// Workflow 引擎自动提供全局 args; 由调用方把疑点 JSON 内容直接作为 args 传入
// verifyOneBatch: 跑一批疑点, 返回 { synthesis, per_suspicion, triage }
async function verifyOneBatch(suspicions, max_rounds, filterlist) {
  // 每疑点一条独立流水线，互不等待
  const perSuspicion = suspicions.map(async (s) => {
    const suspicionDesc = describeSuspicion(s);

    // 已知问题关卡: 每跑完一个阶段就拿累积证据重新比对一次(见上方 makeFilterGate 说明)
    const gate = makeFilterGate(s, filterlist, suspicionDesc);
    const filtered = (hit, partial) => ({
      id: s.id,
      filtered: true,
      filtered_at_phase: hit.phase,
      matched_known_id: hit.matched_id,
      filter_reason: hit.reason,
      filter_history: hit.history,
      hypothesis: partial.hypothesis || null,
      probe: partial.probe || null,
      isolate: partial.isolate || null,
      skeptic: null,
      skipped_simulation: !partial.probe,
    });

    // 关卡 @claim: 只凭一句 claim 就认得出的已知问题, 零仿真直接跳过
    let hit = await gate("claim");
    if (hit) return filtered(hit, {});

    // Phase 1: Hypothesize — 只读代码
    const hypothesis = await run("hypothesize", `Hypothesize ${s.id}`, `你是 RTL 阅读专家。${envBlock()}

${suspicionDesc}

只读代码，不跑任何仿真（也不得修改任何文件）。读疑点行及其完整调用链（上游检查、下游消费方），把疑点翻译成可判定假设，写清：
1. trigger: 什么指令序列/参数组合能让坏路径被执行到
2. expected: 哪个寄存器/CSR/内存会得到什么错值，正确值应是什么
3. masking: 是否存在前置检查/机制拦截，使坏路径不可达或错误不可见
4. testability: reachable | masked-reachable | timing-only | unreachable
   - timing-only: 坏路径可达, 但**不改变任何架构状态**, 只体现为时序/协议异常。difftest 对这类问题恒 PASS, 抓不到 —— 只能靠波形取证。通用自检: 问一句"就算它真错了, 有任何一个架构可见的寄存器/内存值会不同吗?", 答案否定就是 timing-only。哪些部分容易落在这一类没有定式 —— 凡是正确性主要由时序/协议契约而非提交值定义的地方都可能(总线、存储层次只是常见例子, 别只往那几处想)。
5. sensitivity: 用什么初值/参数能区分"旧值保留"与"算错的新值"（如 0x5A vs 0x70）；若是 timing-only, 改写成"用什么波形判据能区分正常与异常"(对照的是哪条协议条款、或哪个预期拍数)

${reportHint}`,
      hypothesizeSchema);

    // 关卡 @hypothesize: 假设化产出了完整根因链, 信息量远大于原始 claim
    hit = await gate("hypothesize", hypothesis);
    if (hit) return filtered(hit, { hypothesis });

    let results = {
      id: s.id,
      filtered: false,
      hypothesis,
      probe: null,
      isolate: null,
      diagnosis: null,
      skeptic: null,
      skipped_simulation: false,
      filter_history: gate.history,
    };

    if (hypothesis.testability === "unreachable") {
      // 短路: 跳过仿真，直接复核"不可达"判断
      results.skipped_simulation = true;
    } else {
      // Phase 2: Probe — 首测批次(首测+对照+一致性追问+决定性实验, 一次并行)
      const probe = await run("probe", `Probe ${s.id}`, `你是验证工程师。${envBlock()}

${suspicionDesc}

假设(来自上一阶段):
- trigger: ${hypothesis.trigger}
- expected: ${hypothesis.expected}
- masking: ${hypothesis.masking}
- sensitivity: ${hypothesis.sensitivity}

按 templates/case-template.S 骨架构造**一批**汇编自检用例, 一次交给 run_batch.py 并行跑(不要写一个跑一个), 批次至少含:
1. 首测用例: setup(vsetvli+可辨识初值) -> trigger -> check(vse 存内存 load 读回+beq/bne 到 FAIL; 禁 vmv.x.s, CSR 用 csrr) -> GOODTRAP。
2. 灵敏度对照(无条件): "已知应有差异"的对照用例(如不执行清零指令、确认目标状态真的被改变), 证明用例不是恒真。
3. 一致性追问(无条件): trap 返回 / flushPipe / vsetvli 重配置之后打 STATE_FENCE 快照与触发前快照自对照, 再 csrr 读回 CSR 对比。真 bug 常藏在掩盖原疑点的路径里。
4. 决定性实验: 读一个从未被写过的相邻向量寄存器(经 refbuf 自对照), 判断污染是否经旁路/检查点扩散。
每个用例带 #meta: 行(sew/lmul/vl/变量取值), 供 runs_query.py 跨 run 关联。

结果处理:
- 任何 ABORT 都是强证据: 用 run_batch.py --emu-args "--dump-ref-trace" 重跑该用例一次, 再 trace_diff.py <log> --elf <elf> 拿控制流首分歧±上下文, 结论写进 trace_diff 字段("控制流一致仅数据分歧"本身也是重要结论——错在数据通路)。
- next_batch: 给出下一轮 Isolate 的 3-6 个正交单变量变体(每条只改一个变量: vstart/vl/sew/lmul/ta-tu/指令间距/目标寄存器等)。

所有源码/ELF/日志存 artifacts/${s.id}/variant1/。

${watchdogBlock()}
${anomalyBlock()}
${waveMethodBlock()}
${hypothesis.testability === "timing-only"
  ? "【本疑点被判为 timing-only】difftest 对它恒 PASS, PASS 不构成「疑点被证伪」的证据。首测的重心直接放在波形上: 构造能把目标通道/模块驱动起来的激励(而不是自检用例的 beq/bne 判据), run_batch.py --wave 重放取足够长窗口, vcd_extract.py 抽信号按两类锚点找异常。status 字段: 波形上看到与协议条款/预期拍数不符 = reproduced; 看完确认时序正常 = not-reproduced。first_test 填 PASS 即可(difftest 本就抓不到), 结论以 wave_notes 为准。"
  : "本疑点可用 difftest 判定, 波形是补充手段: 先用提交跟踪/trace_diff 定位, 只在需要信号级细节时再 --wave 重放小窗口。"}${reportHint}`,
        probeSchema);
      results.probe = probe;

      // 关卡 @probe: 首测拿到了实际观测到的分歧现象, 比静态分析更容易认出已知问题
      hit = await gate("probe", probe);
      if (hit) return filtered(hit, results);

      // Phase 3: Isolate — 批次轮循环: 每轮一个 agent 测一批正交单变量变体。
      // "一次只改一个变量"是归因纪律, 不是执行顺序约束 —— 变体彼此正交可并行跑;
      // 串行单变量轮改成并行批次轮是本 workflow 提速的第二大来源(第一是 runner 并行)。
      let round = 1;
      let nextBatch = probe.next_batch || [];
      let repros = 0;
      let attempts = 0;
      let idleRounds = 0;
      const maxIdle = 1; // 连续 maxIdle 轮无新信息即停(与文档一致: 一轮即停)
      const finalizeIsolate = () => {
        if (results.isolate) {
          results.isolate.rounds_used = round - 1;
          // 轮级复现率单独存, 不覆写 agent 上报的用例级 repro_rate
          // (后者才承载"时通时不通判竞态"的判据)
          results.isolate.rounds_repro_rate = attempts > 0 ? repros / attempts : 0;
        }
      };

      while (round <= max_rounds && idleRounds < maxIdle && nextBatch.length > 0) {
        const r = await run("isolate", `Isolate ${s.id} round ${round}`, `你是验证工程师。${envBlock()}

${suspicionDesc}

上一轮给出的本轮变体批次(每条相对基线只改一个变量, 彼此正交):
${nextBatch.map((v, i) => `${i + 1}. ${v}`).join("\n")}

执行纪律:
- 每个变体独立一个 .S(带 #meta: 标注改了哪个变量取什么值), **一次全部交给 run_batch.py 并行跑**, 读 summary.tsv 逐个归因, 填 variants_tested。
- 觉得批次里某条设计不合理可以替换, 但要在 findings 里说明换成了什么、为什么。
- 时通时不通的变体多跑几次记录复现率(0<repro_rate<1 判竞态特征)。
- 若已拿到确定性 ABORT 复现, 本轮批次必须额外包含**深挖动作**: (a) --emu-args "--dump-ref-trace" 重跑 + trace_diff.py 首分歧上下文; (b) 最小化 —— 从复现用例删减出 3-5 个候选精简版并行跑, 保住 ABORT 的最小版本路径写进 findings(它就是 repro ELF)。
- new_information: 本轮是否提供了上一轮没有的新信息。next_batch: 下一轮变体清单, 已收敛则空数组。
产物存 artifacts/${s.id}/variant${round + 1}/。

${watchdogBlock()}
${anomalyBlock()}
${waveMethodBlock()}
attribution 若是波形上看到的时序/协议矛盾(架构状态不变、difftest 抓不到那一类), 选 protocol-timing-violation, 并把预期、预期的来源(规范条款还是对代码意图的推断)、实际观测一起写进 wave_notes。${reportHint}`,
          isolateSchema);
        round += 1;
        if (r.attribution !== "not-reproducible") {
          repros += 1;
        }
        attempts += 1;
        if (r.new_information) {
          idleRounds = 0;
        } else {
          idleRounds += 1;
        }
        nextBatch = r.next_batch || [];
        results.isolate = r;

        // 关卡 @isolate: 归因结论(具体信号/寄存器/时序特征)是最接近已知问题描述的一层
        hit = await gate(`isolate-r${round - 1}`, r);
        if (hit) {
          finalizeIsolate();
          return filtered(hit, results);
        }
      }
      finalizeIsolate();

      // 挂死悬案: 一杀一审后仍 UNCLEAR 的 kill, 派专门诊断(确定性重放+波形)再进 Skeptic
      const unclear = [
        ...((results.probe && results.probe.hang_reports) || []),
        ...((results.isolate && results.isolate.hang_reports) || []),
      ].filter((h) => h.ruling === "UNCLEAR");
      if (unclear.length > 0) {
        results.diagnosis = await run("isolate", `Diagnose ${s.id}`, `你是挂死诊断专家。${envBlock()}

${suspicionDesc}

以下用例被看门狗击毙, 拥有者一杀一审后仍 UNCLEAR(证据包解释不通):
${JSON.stringify(unclear, null, 2)}

对每个用例做确定性重放诊断:
1. 读对应 evidence.json 与提交跟踪, 定位停驻 cycle;
2. run_batch.py --wave 重放, --begin/--end 圈停驻前约 2000 周期窗口, vcd_extract.py 先 --list 侦察, 再抽疑点模块对外接口信号与提交通道信号(rob.difftest_commit_*);
3. 判断: 流水线哪一级停了、在等什么、该来的信号为什么没来。
每用例裁决: TRUE_HANG(给根因+签名草稿) / FALSE_KILL(说明绊线该怎么改) / STILL_UNCLEAR(如实说卡在哪, 别编)。
${waveMethodBlock()}
${reportHint}`,
          diagnoseSchema);
      }
    }

    // Phase 4: Skeptic — 专门推翻结论
    // timing-only 类结论 difftest 恒 PASS, 重跑 difftest 不构成复核, 三件事换成波形版
    const timingOnly =
      hypothesis.testability === "timing-only" ||
      (results.isolate &&
        results.isolate.attribution === "protocol-timing-violation");
    const skepticInput = results.skipped_simulation
      ? `该疑点被 Hypothesize 判为 unreachable（跳过了仿真）。你的任务是逐行读代码复核这个"不可达"判断本身是否成立。`
      : `现有结论摘要: probe=${JSON.stringify(results.probe)}; isolate=${JSON.stringify(results.isolate)}${results.diagnosis ? `; 挂死诊断=${JSON.stringify(results.diagnosis)}` : ""}`;
    const skepticChecks = timingOnly
      ? `本疑点的结论属于时序/协议类: difftest 对它恒 PASS, 重跑 difftest 确认 PASS 不构成任何复核。必做三件事:
1. 重现异常序列: 用 artifacts/${s.id}/ 下留下的用例经 run_batch.py --wave 重跑并 dump 同一窗口的波形, vcd_extract.py 抽同一组信号, 确认 wave_notes 描述的异常序列原样可见; dump 不出来或看不到, 结论即不成立。
2. 复核"预期"本身: 预期来自成文规范则核对条款原文是否真的这么规定; 来自代码意图推断则逐行重走推断链并尝试推翻 —— 推断若立不住, 看到的"异常"其实是正常行为, verdict 应给 REFUTED 或 DOWNGRADED。
3. 自对照: 在同一波形(或另跑一份)里找同类交互的其他实例, 确认"异常"不是该设计的常态行为。

${waveMethodBlock()}`
      : `必做三件事:
1. 重跑最小复现: 用 artifacts/${s.id}/ 下已留下的用例经 run_batch.py 原样重跑，确认 ABORT（或 PASS）可复现(runs.jsonl 自动留档, 可与历史 run 比对)。
2. 验证灵敏度对照真实性: 检查对照用例确实"已知应有差异"，否则整条证据链作废。
3. 逐行核对"机制规避"结论: 若结论是被某机制规避，逐行读该机制代码确认它在所有路径上都成立。

${watchdogBlock()}`;
    results.skeptic = await run("skeptic", `Skeptic ${s.id}`, `你是专门的"推翻者"，任务不是验证而是推翻现有结论。${envBlock()}

${suspicionDesc}

假设: ${JSON.stringify(hypothesis)}
${skepticInput}

${skepticChecks}

verdict: CONFIRMED（结论成立）/ REFUTED（结论被推翻，不回环，标人工复核）/ DOWNGRADED（改写为更弱表述）。${reportHint}`,
      skepticSchema);

    return results;
  });

  // barrier 1: 全部疑点结束后, 先分诊异常池再汇总
  const all = await Promise.all(perSuspicion);

  // ---- 跨疑点异常池: 收集各阶段 anomalies + 看门狗确认的真挂死(纯代码, 不花 token) ----
  const pool = [];
  for (const r of all) {
    for (const src of ["probe", "isolate"]) {
      const stage = r[src];
      for (const a of (stage && stage.anomalies) || [])
        pool.push({ suspicion: r.id, from: src, ...a });
      for (const h of (stage && stage.hang_reports) || [])
        if (h.ruling === "TRUE_HANG")
          pool.push({
            suspicion: r.id,
            from: "watchdog",
            observation: `真挂死: ${h.case} (${h.verdict}) ${h.detail}`,
            expected: "用例正常终止",
            channel: "watchdog",
            strength: "strong",
            evidence: [h.case],
          });
    }
    // Diagnose 把 UNCLEAR 改判成 TRUE_HANG 的确诊结果同样进池(否则最难诊的反而漏掉)
    for (const d of (r.diagnosis && r.diagnosis.resolutions) || [])
      if (d.ruling === "TRUE_HANG")
        pool.push({
          suspicion: r.id,
          from: "diagnose",
          observation: `真挂死(重放诊断确诊): ${d.case} ${d.cause}`,
          expected: "用例正常终止",
          channel: "watchdog",
          strength: "strong",
          evidence: [d.case],
        });
  }

  // Phase 5: Triage — 异常池聚类, 当轮晋升新疑点(带证据进下一 sweep)
  let triage = null;
  if (pool.length > 0) {
    triage = await run("triage", "Triage anomaly pool", `你是异常分诊专家。以下是本轮所有疑点流水线上报的异常池(${pool.length} 条, 含看门狗确认的真挂死):

${JSON.stringify(pool, null, 2)}

本轮已验证的疑点 id: ${suspicions.map((x) => x.id).join(", ")}

任务:
1. clusters: 聚类 —— 哪些异常表现为同一现象(错值形态/涉及指令/参数条件相同)? **跨疑点重复出现的簇是强信号**。
2. promoted: 晋升值得定向验证的簇为新疑点(上限 5 条)。判据: 现有结论解释不了 + 强度够(strong, 或跨疑点重复的 medium) + 能写出可检验的 claim。每条带 evidence(异常来源的 artifact 路径/run 记录), 让下一轮不必从一句话从零跑。file/line 给最可能的 RTL 落点(读代码定位, 不确定就给子系统目录)。id 用 "T-" 前缀加现象 slug。
3. dropped: 未晋升的异常逐条给理由(与已知问题现象一致/太弱且孤立/已被现有结论解释)。
不要晋升与本轮已验证疑点现象相同的条目。${reportHint}`,
      triageSchema);
  }

  const synthesis = await run("synthesize", "Synthesize all suspicions", `你是汇总报告作者。以下是全部疑点的验证结果（JSON）:

${JSON.stringify(all, null, 2)}

异常池分诊结果: ${triage ? JSON.stringify(triage, null, 2) : "(本轮异常池为空)"}

产出:
1. summary_table: 分类表，每疑点 -> 真实可触发(bug) / 时序或协议异常(difftest 抓不到、靠波形定的那一类, 必须写明预期是什么、预期来自成文规范还是对代码意图的推断) / 被机制天然规避(写明哪条机制) / 当前配置不可达(写明何时暴露) / 已知问题-已跳过(filtered=true 的疑点, 写明 matched_known_id 与 filtered_at_phase, 即在哪个阶段被认出来的; 若 filtered_at_phase 不是 claim, 说明它在被认出前已经跑了部分阶段, 这些部分结果仍在 hypothesis/probe/isolate 字段里, 属于对已知问题的补充证据, 该写进 evidence_chains)。
2. evidence_chains: 每条结论 -> 对应的 ABORT 日志 / trace_diff 首分歧结论 / 提交跟踪 / VCD 波形 / ELF 路径。
3. repro_elufs: 最小复现 ELF 名单（artifacts 下的路径, 含 Isolate 深挖最小化产出的精简版）。
4. coverage_gaps: 覆盖面声明，明确列出没测到的路径（其他 VLEN、其他 sew/lmul 组合、多 harts 等）。
5. findings_draft: findings.md 条目草稿（带日期标题）。只出草稿文本，禁止修改任何共享文件。
6. follow_ups: 未被 Triage 晋升但值得记录的新疑点(覆盖缺口中值得定向验证的点), 每条含 id/file/line/claim, 有支撑材料就带 evidence; 与 Triage 的 promoted 重复的不要再列; 没有则空数组。
7. watchdog_notes: 看门狗回流 —— 本轮 kill/一杀一审统计(TRUE_HANG/FALSE_KILL/UNCLEAR 各几例)、FALSE_KILL 误杀原因与绊线阈值/白名单修正建议、hang_reports/diagnosis 里的新签名草稿汇总(供人工合入 hypotheses/hang-signatures.json); 本轮无 kill 则留空。
8. wave_method_notes: 汇总各阶段 wave_notes。波形取证方法论仍在完善中，这一栏是它的迭代输入：如实写清哪些判据有效、哪些无效、下次该怎么改；本轮无人用波形就留空，不要编。

${reportHint}`,
    synthSchema);

  return { synthesis, per_suspicion: all, triage };
}

// ---- 外层大迭代(loop-until-dry) ----
// 每轮队列 = Triage 晋升的新疑点(带证据, 优先) + Synthesize 的 follow_ups;
// 已验证过的 id 去重跳过。终止: 轮数达 max_sweeps 或队列为空。
async function main(rawArgs) {
  // args 可能以 JSON 字符串形式传入
  const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
  const maxSweeps = args.max_sweeps || 4;
  const filterlist = args.filterlist || [];
  if (filterlist.length > 0) log(`filterlist: ${filterlist.length} 条已知问题`);
  const batchResults = [];
  let queue = args.suspicions;
  const seen = new Set();
  for (let cycle = 1; cycle <= maxSweeps && queue.length > 0; cycle++) {
    queue.forEach((s) => seen.add(s.id));
    log(`cycle ${cycle}/${maxSweeps}: ${queue.length} 个疑点`);
    const r = await verifyOneBatch(queue, args.max_variants || 4, filterlist);
    r.cycle = cycle;
    batchResults.push(r);
    const promoted = (r.triage && r.triage.promoted) || [];
    const followUps = (r.synthesis && r.synthesis.follow_ups) || [];
    // 去重: 对全历史(seen) + 本轮内部(promoted 与 follow_ups 报了同一个 id 只留前者)
    const local = new Set();
    queue = [...promoted, ...followUps].filter((s) => {
      if (!s.id || seen.has(s.id) || local.has(s.id)) return false;
      local.add(s.id);
      return true;
    });
    if (promoted.length > 0)
      log(`Triage 晋升 ${promoted.length} 条新疑点进下一轮(带证据)`);
  }
  if (queue.length > 0)
    log(`已达 max_sweeps=${maxSweeps}, 剩余未验证疑点 ${queue.length} 条(见最后一轮 triage.promoted/follow_ups)`);
  return { batches: batchResults, unfinished: queue };
}

await main(args);
