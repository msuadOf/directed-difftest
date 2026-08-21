// RTL 疑点定向 DiffTest 验证工作流
// 设计文档: docs/workflow-detailed.md
// 用法: 在 Claude Code 会话中说"用 workflow 跑 rtl-directed-difftest, 疑点文件 hypotheses/xxx.json"
// (Workflow 工具以 scriptPath 加载本文件, 疑点 JSON 内容经 args 传入)

export const meta = {
  name: "rtl-directed-difftest",
  description:
    "对 XiangShan RTL 疑点做定向 DiffTest 验证: 假设化 -> 首测探针 -> 变量隔离 -> 对抗复核 -> 汇总沉淀",
  phases: ["hypothesize", "probe", "isolate", "skeptic", "synthesize"],
};

// ---- 环境信息（写进所有需要跑仿真的 agent prompt） ----
function envBlock(workspace) {
  return `## 环境（已就绪，勿重建）
- DUT emu: ${workspace}/difftest-xiangshan/xiangshan/build/emu (MinimalConfig, VLEN=128, Verilator)
- REF: ${workspace}/difftest-xiangshan/xiangshan/ready-to-run/riscv64-nemu-interpreter-so
- 交叉编译: riscv64-linux-gnu-gcc; ELF 入口 0x80000000; 结束放 GOODTRAP: .word 0x0000006b
- emu 无波形支持(--dump-wave 会 SIGABRT); 取证用提交跟踪: emu 加 -b <开始> -e <结束>, 日志含每退休指令的 pc/编码/dst/data
- GOODTRAP 到达 = 双方一致且自检通过; DiffTest ABORT = DUT 与 REF 分歧(本身即 bug 证据, 看日志 data 字段的双值)
- XiangShan 源码根: ${workspace}/difftest-xiangshan/xiangshan (禁止修改其中任何文件)
- 中间文件一律写 artifacts/<疑点id>/variant<N>/ 下（相对本仓库根目录）`;
}

const reportHint =
  "报告务必简洁，只给 schema 要求的字段与关键证据路径，不要贴大段日志。";

const hypothesizeSchema = {
  type: "object",
  properties: {
    trigger: { type: "string" },
    expected: { type: "string" },
    masking: { type: "string" },
    testability: {
      type: "string",
      enum: ["reachable", "masked-reachable", "unreachable"],
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
        "not-reproducible",
      ],
    },
    repro_rate: { type: "number" },
    findings: { type: "string" },
    new_information: { type: "boolean" },
    next_var: { type: "string" },
  },
  required: ["attribution", "repro_rate", "findings", "new_information", "next_var"],
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

// Workflow 引擎自动提供全局 args; 由调用方把疑点 JSON 内容直接作为 args 传入
// verifyOneBatch: 跑一批疑点, 返回 { synthesis, per_suspicion }
async function verifyOneBatch(suspicions, max_variants, workspace) {
  // 每疑点一条独立流水线，互不等待
  const perSuspicion = suspicions.map(async (s) => {
    const suspicionDesc = `疑点 ${s.id}: ${s.file}:${s.line}
预期错误(claim): ${s.claim}`;

    // Phase 1: Hypothesize — 只读代码
    const hypothesis = await run("hypothesize", `Hypothesize ${s.id}`, `你是 RTL 阅读专家。${envBlock(workspace)}

${suspicionDesc}

只读代码，不跑任何仿真（也不得修改任何文件）。读疑点行及其完整调用链（上游检查、下游消费方），把疑点翻译成可判定假设，写清：
1. trigger: 什么指令序列/参数组合能让坏路径被执行到
2. expected: 哪个寄存器/CSR/内存会得到什么错值，正确值应是什么
3. masking: 是否存在前置检查/机制拦截，使坏路径不可达或错误不可见
4. testability: reachable | masked-reachable | unreachable
5. sensitivity: 用什么初值/参数能区分"旧值保留"与"算错的新值"（如 0x5A vs 0x70）

${reportHint}`,
      schema: hypothesizeSchema });

    let results = {
      id: s.id,
      hypothesis,
      isolate: null,
      skeptic: null,
      skipped_simulation: false,
    };

    if (hypothesis.testability === "unreachable") {
      // 短路: 跳过仿真，直接复核"不可达"判断
      results.skipped_simulation = true;
    } else {
      // Phase 2: Probe — 首测 + 灵敏度对照 + 一致性追问
      const probe = await run("probe", `Probe ${s.id}`, `你是验证工程师。${envBlock(workspace)}

${suspicionDesc}

假设(来自上一阶段):
- trigger: ${hypothesis.trigger}
- expected: ${hypothesis.expected}
- masking: ${hypothesis.masking}
- sensitivity: ${hypothesis.sensitivity}

按本仓库 templates/case-template.S 骨架构造汇编自检用例（setup 设 vsetvli + 可辨识初值 -> trigger -> check 用 vmv.x.s/csrr 读回并 beq/bne 分支到 FAIL -> GOODTRAP .word 0x0000006b），用 riscv64-linux-gnu-gcc 编译成 ELF（入口 0x80000000），跑 emu vs NEMU DiffTest。同时无条件做三件事：
1. 灵敏度对照: 先跑一个"已知应有差异"的对照用例（如不执行清零指令、确认目标状态真的被改变），证明用例不是恒真。
2. 一致性追问: 即使疑点被证伪，也必须在 trap 返回 / flushPipe / vsetvli 重配置之后再次读回向量寄存器和 CSR，对比 emu 与 NEMU。真 bug 常藏在掩盖原疑点的路径里。
3. 决定性实验: 读一个从未被写过的相邻向量寄存器，判断污染是否经旁路/检查点扩散。

取证据: emu 加 -b <开始> -e <结束> 提交跟踪。所有源码/ELF/日志存到 artifacts/${s.id}/variant1/。${reportHint}`,
        schema: probeSchema });
      results.probe = probe;

      // Phase 3: Isolate — 变体轮(variant)循环, 每轮只改一个变量; 终止由代码判
      let variant = 1;
      let nextVar = probe.next_var;
      const attributions = [];
      let repros = 0;
      let attempts = 0;
      let idleRounds = 0;
      const maxIdle = 1; // 连续一轮无新信息即停

      while (variant < max_variants && idleRounds <= maxIdle) {
        const r = await run("isolate", `Isolate ${s.id} variant ${variant + 1}`, `你是验证工程师。${envBlock(workspace)}

${suspicionDesc}

上一轮结果后，本轮只改变一个变量并重跑: ${nextVar}
其余一切保持不变。变量类型举例: 换指令/换参数(vstart/vl/sew/lmul)、换目标寄存器(读从未被写过的寄存器)、调整指令顺序/间距。
- 时通时不通则多跑几次记录复现率 repro_rate = 复现次数/尝试次数 (0<r<1 判竞态特征)。
- new_information: 本轮结论是否提供了上一轮没有的新信息。
产物存到 artifacts/${s.id}/variant${variant + 1}/。${reportHint}`,
          schema: isolateSchema });
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
      }
      if (results.isolate) {
        results.isolate.variants_used = variant;
        results.isolate.repro_rate = attempts > 0 ? repros / attempts : 0;
      }
    }

    // Phase 4: Skeptic — 专门推翻结论
    const skepticInput = results.skipped_simulation
      ? `该疑点被 Hypothesize 判为 unreachable（跳过了仿真）。你的任务是逐行读代码复核这个"不可达"判断本身是否成立。`
      : `现有结论摘要: probe=${JSON.stringify(results.probe)}; isolate=${JSON.stringify(results.isolate)}`;
    results.skeptic = await run("skeptic", `Skeptic ${s.id}`, `你是专门的"推翻者"，任务不是验证而是推翻现有结论。${envBlock(workspace)}

${suspicionDesc}

假设: ${JSON.stringify(hypothesis)}
${skepticInput}

必做三件事:
1. 重跑最小复现: 用 artifacts/${s.id}/ 下已留下的 ELF 原样重跑，确认 ABORT（或 PASS）可复现。
2. 验证灵敏度对照真实性: 检查对照用例确实"已知应有差异"，否则整条证据链作废。
3. 逐行核对"机制规避"结论: 若结论是被某机制规避，逐行读该机制代码确认它在所有路径上都成立。

verdict: CONFIRMED（结论成立）/ REFUTED（结论被推翻，不回环，标人工复核）/ DOWNGRADED（改写为更弱表述）。${reportHint}`,
      schema: skepticSchema });

    return results;
  });

  // 唯一的 barrier: 全部疑点结束后汇总
  const all = await Promise.all(perSuspicion);

  const synthesis = await run("synthesize", "Synthesize all suspicions", `你是汇总报告作者。以下是全部疑点的验证结果（JSON）:

${JSON.stringify(all, null, 2)}

产出:
1. summary_table: 三分类表，每疑点 -> 真实可触发(bug) / 被机制天然规避(写明哪条机制) / 当前配置不可达(写明何时暴露)。
2. evidence_chains: 每条结论 -> 对应的 ABORT 日志 / 提交跟踪 / ELF 路径。
3. repro_elufs: 最小复现 ELF 名单（artifacts 下的路径）。
4. coverage_gaps: 覆盖面声明，明确列出没测到的路径（其他 VLEN、其他 sew/lmul、多 harts 等）。
5. findings_draft: findings.md 条目草稿（带日期标题）。只出草稿文本，禁止修改任何共享文件。
6. follow_ups: 本轮验证过程中发现的新疑点(副产品分歧、覆盖缺口中值得定向验证的点)，每条含 id/file/line/claim；没有则给空数组。

${reportHint}`,
    schema: synthSchema });

  return { synthesis, per_suspicion: all };
}

// ---- 外层大迭代(loop-until-dry) ----
// 每轮 Synthesize 的 follow_ups 作为下一轮疑点输入;
// 终止: 轮数达 max_sweeps 或 follow_ups 为空
async function main(args) {
  const maxSweeps = args.max_sweeps || 1;
  const batchResults = [];
  let queue = args.suspicions;
  for (let cycle = 1; cycle <= maxSweeps && queue.length > 0; cycle++) {
    log(`cycle ${cycle}/${maxSweeps}: ${queue.length} 个疑点`);
    const r = await verifyOneBatch(queue, args.max_variants || 5, args.workspace);
    r.cycle = cycle;
    batchResults.push(r);
    queue = (r.synthesis && r.synthesis.follow_ups) || [];
  }
  if (queue.length > 0)
    log(`已达 max_sweeps=${maxSweeps}, 剩余未验证疑点 ${queue.length} 条(见最后一轮 follow_ups)`);
  return { batches: batchResults, unfinished: queue };
}

await main(args);
