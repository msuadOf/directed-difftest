// RTL 疑点定向 DiffTest 验证工作流
// 设计文档: docs/workflow-detailed.md
// 用法: 在 Claude Code 会话中说"用 workflow 跑 rtl-directed-difftest, 疑点文件 hypotheses/xxx.json"
// (Workflow 工具以 scriptPath 加载本文件, 疑点 JSON 内容经 args 传入)
// filterlist(可选, args.filterlist): 已知问题清单, 见 hypotheses/known-issues.json 与下方 Phase 0 说明

export const meta = {
  name: "rtl-directed-difftest",
  description:
    "对 XiangShan RTL 疑点做定向 DiffTest 验证: 假设化 -> 首测探针 -> 变量隔离 -> 对抗复核 -> 汇总沉淀",
  phases: ["filter", "hypothesize", "probe", "isolate", "skeptic", "synthesize"],
};

// ---- 环境信息（写进所有需要跑仿真的 agent prompt） ----
// 所有路径相对本仓库(directed-difftest)根; xiangshan 是 submodule(pin 7bf51a8),
// 首次使用先跑 ./scripts/setup-env.sh 拷入预编译 emu 与 REF
function envBlock() {
  return `## 环境（勿重建; 若 xiangshan/build/emu 缺失, 提示用户跑 ./scripts/setup-env.sh）
- DUT emu: xiangshan/build/emu (MinimalConfig, VLEN=128, Verilator; 已验证完整支持 RVV 执行)
- REF: xiangshan/ready-to-run/riscv64-nemu-interpreter-so
- 交叉编译: 先 source scripts/toolchain.sh 得到 $CROSS(gcc 15.1, 支持 RVV 助记符), 再 $CROSS -march=rv64gcv_zicsr -mabi=lp64d -T templates/xiangshan.ld (入口 0x80000000); 结束放 GOODTRAP: .word 0x0000006b
- 【重要】向量指令一律用 RVV 助记符让汇编器编码(如 vsetvli/vadd.vv/vmv.x.s), 严禁手工计算 .4byte 编码 —— 历史上手搓编码曾把 illegal 指令误判为"emu 不支持 RVV"。参考验证过的编码: vsetvli x0,x6,e32,m1,ta,ma = 0x0d037057
- 【重要】向量执行前必须使能 mstatus.VS 字段(bits 10:11, 0x600): csrr t0,mstatus; ori t0,t0,0x600; csrw mstatus,t0。写错位(如 1<<25)会导致挂死。且必须设置 mtvec 指向合法 trap handler
- 【判据陷阱】未设 mtvec 时 double-trap 会打印伪造 "HIT GOOD TRAP"+乱码 pc; j .(jal-to-self) 也终止为 GOODTRAP; instrCnt/cycleCnt/--dump-db 均不可用作观测通道。唯一可靠判据: ABORT(DUT vs REF 分歧)+提交跟踪中确实提交了向量指令
- emu 已支持波形(2026-08-23 用 EMU_TRACE=1 重编, 原无波形版备份为 build/verilator-compile/emu.notrace.bak): 加 --dump-wave --wave-path=<文件.vcd> 输出 VCD; 大用例文件会很大(几十~上百 MB), 优先仍用提交跟踪定位再按需 dump 小窗口(配 -b/-e 限定周期范围, 减小 VCD 体积)
- 取证首选提交跟踪: emu 加 -b <开始> -e <结束>, 日志含每退休指令的 pc/编码/dst/data; 需要信号级细节再上 --dump-wave
- GOODTRAP 到达 = 双方一致且自检通过; ABORT = DUT 与 REF 分歧(本身即 bug 证据, 看日志 data 字段的双值)
- XiangShan 源码在 submodule xiangshan/ (禁止修改其中任何文件)
- 中间文件一律写 artifacts/<疑点id>/variant<N>/ 下（相对本仓库根目录）`;
}

const reportHint =
  "报告务必简洁，只给 schema 要求的字段与关键证据路径，不要贴大段日志。";

// ---- 波形取证方法论（实验性, 尚在使用中完善） ----
// 动机: difftest 只能抓"架构状态分歧"—— DUT 与 REF 提交的寄存器/内存值不同才 ABORT。
// 有一整类问题它天然抓不到: 不改变架构状态、只表现为时序/协议异常的问题(协议违例、
// 握手异常、性能塌陷、活锁/死锁边缘)。而且 REF(NEMU)根本没有微架构时序模型, 无从对比。
// 这类现象要从波形入手, 找与"代码意图"和"常规时序"不符的地方。
// 【本方法论尚不成熟】判据大量依赖人的经验, 每次使用都要如实记录什么有效什么无效,
// 这些记录本身就是完善它的输入 —— 见各阶段 schema 的 wave_notes 字段。
function waveMethodBlock() {
  return `## 波形取证（实验性方法论, 用完请回报经验）
difftest 只抓架构状态分歧; 若疑点属于"不改变架构状态、只体现为时序/协议异常"那一类, difftest 会一路 PASS 而问题仍在, 必须看波形。

### 通用做法
波形判据本质上永远是"预期 vs 实际"的对照, 所以:
1. **先把预期写下来, 并注明预期的来源**。来源只有两类, 判据硬度不同, 结论里必须写清是哪一类:
   - **成文规范**(协议标准、接口契约、文档化的时序约定): 判据硬, 可逐条引用条款;
   - **对代码意图的推断**(读 RTL 推出"这里应该几拍完成、应该按什么顺序发生"): 判据软 —— 推断本身可能就是错的, 那样你看到的"异常"其实是正常行为。必须把推断链写出来, 让别人能推翻它。
2. **选观察窗口**: 这类问题的判据是"一整段序列"而不是"某一拍的电平", 窗口要长到覆盖一次完整交互(常在数十个时钟周期量级)。先用提交跟踪定位大致时间点, 再用 -b/-e 圈定周期范围控制 VCD 体积, --dump-wave --wave-path=artifacts/<疑点id>/variant<N>/xxx.vcd 导出。
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
    status: {
      type: "string",
      enum: ["reproduced", "masked", "not-reproduced", "env-error"],
    },
    artifacts: { type: "array", items: { type: "string" } },
    next_var: { type: "string" },
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
    "next_var",
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
    repro_rate: { type: "number" },
    findings: { type: "string" },
    new_information: { type: "boolean" },
    next_var: { type: "string" },
    wave_notes: {
      type: "string",
      description: "同 probe: 本轮若用了波形取证, 记录 scope/信号/窗口长度/判据/无效尝试。",
    },
  },
  required: ["attribution", "repro_rate", "findings", "new_information", "next_var"],
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

const synthSchema = {
  type: "object",
  properties: {
    summary_table: { type: "string" },
    evidence_chains: { type: "string" },
    repro_elufs: { type: "array", items: { type: "string" } },
    coverage_gaps: { type: "string" },
    findings_draft: { type: "string" },
    wave_method_notes: {
      type: "string",
      description:
        "汇总各阶段 wave_notes 里的波形取证经验: 什么判据有效、什么无效、下次该怎么改。波形方法论仍在完善中, 这一栏是它的迭代输入; 本轮无人用波形则留空。",
    },
    follow_ups: {
      type: "array",
      description: "本扫荡轮(sweep)发现的新疑点(副产品/覆盖缺口), 作为下一个 sweep 的输入; id 若与已验证疑点重复会被跳过",
      items: { type: "object", properties: { id: {type:"string"}, file: {type:"string"}, line: {}, claim: {type:"string"} }, required: ["id","file","claim"] },
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
    const candidates = list.filter(
      (k) =>
        (k.keywords || []).some((kw) => blob.includes(kw)) ||
        basename(k.hint_file || k.file) === basename(s.file)
    );
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

// Workflow 引擎自动提供全局 args; 由调用方把疑点 JSON 内容直接作为 args 传入
// verifyOneBatch: 跑一批疑点, 返回 { synthesis, per_suspicion }
async function verifyOneBatch(suspicions, max_variants, filterlist) {
  // 每疑点一条独立流水线，互不等待
  const perSuspicion = suspicions.map(async (s) => {
    const suspicionDesc = `疑点 ${s.id}: ${s.file}:${s.line}
预期错误(claim): ${s.claim}`;

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
      skeptic: null,
      skipped_simulation: false,
      filter_history: gate.history,
    };

    if (hypothesis.testability === "unreachable") {
      // 短路: 跳过仿真，直接复核"不可达"判断
      results.skipped_simulation = true;
    } else {
      // Phase 2: Probe — 首测 + 灵敏度对照 + 一致性追问
      const probe = await run("probe", `Probe ${s.id}`, `你是验证工程师。${envBlock()}

${suspicionDesc}

假设(来自上一阶段):
- trigger: ${hypothesis.trigger}
- expected: ${hypothesis.expected}
- masking: ${hypothesis.masking}
- sensitivity: ${hypothesis.sensitivity}

按本仓库 templates/case-template.S 骨架构造汇编自检用例（setup 设 vsetvli + 可辨识初值 -> trigger -> check 用 vmv.x.s/csrr 读回并 beq/bne 分支到 FAIL -> GOODTRAP .word 0x0000006b），用 riscv64-unknown-elf-gcc 编译成 ELF（入口 0x80000000），跑 emu vs NEMU DiffTest。同时无条件做三件事：
1. 灵敏度对照: 先跑一个"已知应有差异"的对照用例（如不执行清零指令、确认目标状态真的被改变），证明用例不是恒真。
2. 一致性追问: 即使疑点被证伪，也必须在 trap 返回 / flushPipe / vsetvli 重配置之后再次读回向量寄存器和 CSR，对比 emu 与 NEMU。真 bug 常藏在掩盖原疑点的路径里。
3. 决定性实验: 读一个从未被写过的相邻向量寄存器，判断污染是否经旁路/检查点扩散。

取证据: emu 加 -b <开始> -e <结束> 提交跟踪。所有源码/ELF/日志存到 artifacts/${s.id}/variant1/。

${waveMethodBlock()}
${hypothesis.testability === "timing-only"
  ? "【本疑点被判为 timing-only】difftest 对它恒 PASS, PASS 不构成「疑点被证伪」的证据。首测的重心直接放在波形上: 构造能把目标通道/模块驱动起来的激励(而不是自检用例的 beq/bne 判据), dump 出足够长的窗口, 按上面两类锚点找异常。status 字段: 波形上看到与协议条款/预期拍数不符 = reproduced; 看完确认时序正常 = not-reproduced。first_test 填 PASS 即可(difftest 本就抓不到), 结论以 wave_notes 为准。"
  : "本疑点可用 difftest 判定, 波形是补充手段: 先用提交跟踪定位, 只在需要信号级细节时再 dump 小窗口。"}${reportHint}`,
        probeSchema);
      results.probe = probe;

      // 关卡 @probe: 首测拿到了实际观测到的分歧现象, 比静态分析更容易认出已知问题
      hit = await gate("probe", probe);
      if (hit) return filtered(hit, results);

      // Phase 3: Isolate — 变体轮(variant)循环, 每轮只改一个变量; 终止由代码判
      let variant = 1;
      let nextVar = probe.next_var;
      const attributions = [];
      let repros = 0;
      let attempts = 0;
      let idleRounds = 0;
      const maxIdle = 1; // 连续 maxIdle 轮无新信息即停(与文档一致: 一轮即停)
      const finalizeIsolate = () => {
        if (results.isolate) {
          results.isolate.variants_used = variant;
          results.isolate.repro_rate = attempts > 0 ? repros / attempts : 0;
        }
      };

      while (variant <= max_variants && idleRounds < maxIdle) {
        const r = await run("isolate", `Isolate ${s.id} variant ${variant + 1}`, `你是验证工程师。${envBlock()}

${suspicionDesc}

上一轮结果后，本轮只改变一个变量并重跑: ${nextVar}
其余一切保持不变。变量类型举例: 换指令/换参数(vstart/vl/sew/lmul)、换目标寄存器(读从未被写过的寄存器)、调整指令顺序/间距。
- 时通时不通则多跑几次记录复现率 repro_rate = 复现次数/尝试次数 (0<r<1 判竞态特征)。
- new_information: 本轮结论是否提供了上一轮没有的新信息。
产物存到 artifacts/${s.id}/variant${variant + 1}/。

${waveMethodBlock()}
attribution 若是波形上看到的时序/协议矛盾(架构状态不变、difftest 抓不到那一类), 选 protocol-timing-violation, 并把预期、预期的来源(规范条款还是对代码意图的推断)、实际观测一起写进 wave_notes。${reportHint}`,
          isolateSchema);
        variant += 1;
        attributions.push(r.attribution);
        if (r.attribution !== "not-reproducible") {
          repros += 1;
        }
        attempts += 1;
        if (r.new_information) {
          idleRounds = 0;
        } else {
          idleRounds += 1;
        }
        nextVar = r.next_var;
        results.isolate = r;

        // 关卡 @isolate: 归因结论(具体信号/寄存器/时序特征)是最接近已知问题描述的一层
        hit = await gate(`isolate-v${variant}`, r);
        if (hit) {
          finalizeIsolate();
          return filtered(hit, results);
        }
      }
      finalizeIsolate();
    }

    // Phase 4: Skeptic — 专门推翻结论
    const skepticInput = results.skipped_simulation
      ? `该疑点被 Hypothesize 判为 unreachable（跳过了仿真）。你的任务是逐行读代码复核这个"不可达"判断本身是否成立。`
      : `现有结论摘要: probe=${JSON.stringify(results.probe)}; isolate=${JSON.stringify(results.isolate)}`;
    results.skeptic = await run("skeptic", `Skeptic ${s.id}`, `你是专门的"推翻者"，任务不是验证而是推翻现有结论。${envBlock()}

${suspicionDesc}

假设: ${JSON.stringify(hypothesis)}
${skepticInput}

必做三件事:
1. 重跑最小复现: 用 artifacts/${s.id}/ 下已留下的 ELF 原样重跑，确认 ABORT（或 PASS）可复现。
2. 验证灵敏度对照真实性: 检查对照用例确实"已知应有差异"，否则整条证据链作废。
3. 逐行核对"机制规避"结论: 若结论是被某机制规避，逐行读该机制代码确认它在所有路径上都成立。

verdict: CONFIRMED（结论成立）/ REFUTED（结论被推翻，不回环，标人工复核）/ DOWNGRADED（改写为更弱表述）。${reportHint}`,
      skepticSchema);

    return results;
  });

  // 唯一的 barrier: 全部疑点结束后汇总
  const all = await Promise.all(perSuspicion);

  const synthesis = await run("synthesize", "Synthesize all suspicions", `你是汇总报告作者。以下是全部疑点的验证结果（JSON）:

${JSON.stringify(all, null, 2)}

产出:
1. summary_table: 分类表，每疑点 -> 真实可触发(bug) / 时序或协议异常(difftest 抓不到、靠波形定的那一类, 必须写明预期是什么、预期来自成文规范还是对代码意图的推断) / 被机制天然规避(写明哪条机制) / 当前配置不可达(写明何时暴露) / 已知问题-已跳过(filtered=true 的疑点, 写明 matched_known_id 与 filtered_at_phase, 即在哪个阶段被认出来的; 若 filtered_at_phase 不是 claim, 说明它在被认出前已经跑了部分阶段, 这些部分结果仍在 hypothesis/probe/isolate 字段里, 属于对已知问题的补充证据, 该写进 evidence_chains)。
2. evidence_chains: 每条结论 -> 对应的 ABORT 日志 / 提交跟踪 / ELF 路径。
3. repro_elufs: 最小复现 ELF 名单（artifacts 下的路径）。
4. coverage_gaps: 覆盖面声明，明确列出没测到的路径（其他 VLEN、其他 sew/lmul、多 harts 等）。
5. findings_draft: findings.md 条目草稿（带日期标题）。只出草稿文本，禁止修改任何共享文件。
6. follow_ups: 本轮验证过程中发现的新疑点(副产品分歧、覆盖缺口中值得定向验证的点)，每条含 id/file/line/claim；没有则给空数组。
7. wave_method_notes: 汇总各阶段 wave_notes。波形取证方法论仍在完善中，这一栏是它的迭代输入：如实写清哪些判据有效、哪些无效、下次该怎么改；本轮无人用波形就留空，不要编。

${reportHint}`,
    synthSchema);

  return { synthesis, per_suspicion: all };
}

// ---- 外层大迭代(loop-until-dry) ----
// 每轮 Synthesize 的 follow_ups 作为下一轮疑点输入;
// 终止: 轮数达 max_sweeps 或 follow_ups 为空
async function main(rawArgs) {
  // args 可能以 JSON 字符串形式传入
  const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
  const maxSweeps = args.max_sweeps || 4;
  const filterlist = args.filterlist || [];
  if (filterlist.length > 0) log(`filterlist: ${filterlist.length} 条已知问题`);
  const batchResults = [];
  let queue = args.suspicions;
  for (let cycle = 1; cycle <= maxSweeps && queue.length > 0; cycle++) {
    log(`cycle ${cycle}/${maxSweeps}: ${queue.length} 个疑点`);
    const r = await verifyOneBatch(queue, args.max_variants || 4, filterlist);
    r.cycle = cycle;
    batchResults.push(r);
    queue = (r.synthesis && r.synthesis.follow_ups) || [];
  }
  if (queue.length > 0)
    log(`已达 max_sweeps=${maxSweeps}, 剩余未验证疑点 ${queue.length} 条(见最后一轮 follow_ups)`);
  return { batches: batchResults, unfinished: queue };
}

await main(args);
