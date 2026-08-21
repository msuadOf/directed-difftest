# claudefuzz — RTL 疑点定向 DiffTest 验证工作流

本仓库把"RTL 疑点定向 DiffTest 验证工作流"固化为可复用的文档 + 脚手架：给定一批 RTL 疑点（文件:行号 + 预期错误行为），按 5 阶段流程（Hypothesize → Probe → Isolate → Skeptic → Synthesize）构造汇编自检用例，跑真实 emu vs NEMU DiffTest，迭代收敛根因，并以三分类结论沉淀。

该方法已在 XiangShan kunminghu-v3（MinimalConfig, VLEN=128）上实测，抓到过真 bug（illegal trap 后向量寄存器被 tail-agnostic 值污染，emu 读到 `0xffffffff00000055` 而 NEMU 为 `0x55`）。

## 怎么用

1. 准备疑点清单 JSON，放到 `hypotheses/` 下，格式见 `hypotheses/examples/vstart-vxsat-vlen.json`：

```json
{
  "suspicions": [
    {"id": "S1", "file": "...", "line": 123, "claim": "预期错误行为描述"}
  ],
  "max_rounds": 5,
  "workspace": "/home/baiyifan/workplace-local/isla-runner"
}
```

2. 在 Claude Code 会话中运行（Workflow 无独立 CLI，由会话内的 Workflow 工具加载脚本并把疑点 JSON 内容作为 args 传入）：

```
用 workflow 跑 workflows/rtl-directed-difftest.js，args 用 hypotheses/examples/vstart-vxsat-vlen.json 的内容
```

（也可按 `docs/workflow-detailed.md` 手动逐阶段执行；单条用例可用 `templates/run-one-case.sh` 编译并跑 DiffTest。）

3. 中间产物在 `artifacts/<疑点id>/round<N>/`，最终汇总结论由 Synthesize 阶段输出（三分类 + 证据链 + findings.md 草稿）。

## 目录导航

- `docs/workflow-simple.md` — 一页纸流程简版
- `docs/workflow-detailed.md` — 详细设计文档（各阶段输入/输出/agent 职责）
- `workflows/rtl-directed-difftest.js` — 可执行的 Workflow 脚本
- `hypotheses/` — 疑点清单输入（含示例）
- `templates/` — 汇编自检用例模板 + 单用例编译/运行脚本骨架
- `artifacts/` — 每疑点每轮的中间产物（用例源码、ELF、日志）
- `AGENTS.md` — 给未来 agent 的规则，干活前必读

## 与 isla-runner 工作区的关系

- DUT/REF/工具链均位于 `isla-runner` 工作区：emu 为 `difftest-xiangshan/xiangshan/build/emu`，REF 为 `difftest-xiangshan/xiangshan/ready-to-run/riscv64-nemu-interpreter-so`，交叉编译器 `riscv64-linux-gnu-gcc`。
- 方法论源自 isla-runner 的 `.claude/skills/rtl-difftest/SKILL.md` 与 `agents/findings.md` 中的实测记录；本仓库是其"多疑点、多 agent、带对抗复核"的工程化版本。
- 本仓库只做验证与沉淀，**不修改任何 XiangShan RTL 源码**，不自动开 PR。
