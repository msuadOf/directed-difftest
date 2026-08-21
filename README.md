# claudefuzz — RTL 疑点定向 DiffTest 验证工作流

本仓库把"RTL 疑点定向 DiffTest 验证工作流"固化为可复用的文档 + 脚手架：给定一批 RTL 疑点（文件:行号 + 预期错误行为），按 5 阶段流程（Hypothesize → Probe → Isolate → Skeptic → Synthesize）构造汇编自检用例，跑真实 emu vs NEMU DiffTest，迭代收敛根因，并以三分类结论沉淀。

该方法已在 XiangShan kunminghu-v3（MinimalConfig, VLEN=128）上实测，抓到过真 bug（illegal trap 后向量寄存器被 tail-agnostic 值污染，emu 读到 `0xffffffff00000055` 而 NEMU 为 `0x55`）。

## 怎么用

### 方式一：CLI 一键入口（headless）

`run.sh` 封装 `claude -p` 无头调用，两个阶段：按方向扫 RTL 产出疑点清单 → 跑验证工作流。

```
./run.sh --focus "V 扩展 vstart/trap 恢复语义"                        # 扫描+验证
./run.sh --focus "V 扩展" --model claude-opus-4-7[1m]                 # 指定模型
./run.sh --focus "V 扩展" --max-cycles 3                              # 外层大迭代 3 轮
./run.sh --suspicions hypotheses/examples/vstart-vxsat-vlen.json      # 跳过扫描直接验证
./run.sh --focus "CSR 同拍写顺序" --scan-only                         # 只产出疑点清单
./run.sh ... --dry-run                                                # 只看将执行的命令
```

全部参数见 `./run.sh --help`（--focus/--suspicions/--model/--max-rounds/--max-cycles/--workspace/--scan-only/--dry-run）。

注意：headless 验证阶段需要执行 bash（emu/gcc），请先在 settings.json 预放行相关命令，否则会在权限点失败。

### 方式二：Claude Code 会话内对话运行

在 claudefuzz 目录（或 `--add-dir` 加入本仓库）启动 Claude Code，直接用自然语言驱动。Workflow 由会话内的 Workflow 工具加载脚本、疑点 JSON 内容作为 args 传入：

```
用 workflow 跑 workflows/rtl-directed-difftest.js，args 用 hypotheses/examples/vstart-vxsat-vlen.json 的内容，max_cycles 设为 2
```

也可以不跑完整 workflow，按 `docs/workflow-detailed.md` 手动逐阶段对话执行；单条用例可用 `templates/run-one-case.sh` 编译并跑 DiffTest。对话方式的好处是可以中途介入（改用例、看证据、跳过某疑点）。

### 疑点清单格式

```json
{
  "suspicions": [
    {"id": "S1", "file": "...", "line": 123, "claim": "预期错误行为描述"}
  ],
  "max_rounds": 4,
  "max_cycles": 1,
  "workspace": "/home/baiyifan/workplace-local/isla-runner"
}
```

### 两层迭代参数

工作流里有两个独立的迭代次数参数（另有第三层不受参数控制，见下）：

| 参数 | 层级 | 含义 | 默认 |
|---|---|---|---|
| `max_rounds` / `--max-rounds` | **内层**（单疑点收敛迭代） | Isolate 阶段每疑点"只改一个变量重跑"的轮数上限；另有"连续一轮无新信息"提前终止 | 4 |
| `max_cycles` / `--max-cycles` | **外层**（疑点清单滚动大迭代） | 每轮 Synthesize 产出的新疑点（副产品分歧、覆盖缺口）作为下一轮输入，直到无新疑点或达上限 | 1（不滚动） |

第三层是 Probe agent 内部的自迭代（构造→跑→再构造在单次 agent 调用内自发进行），刻意**不设参数**——它是探索性的，上限会掐死"一致性追问"这类发现（真 bug 正是从这层冒出来的）。

中间产物在 `artifacts/<疑点id>/round<N>/`，最终汇总结论由 Synthesize 阶段输出（三分类 + 证据链 + findings.md 草稿 + 供大迭代用的 follow_ups）。

## 目录导航

- `docs/workflow-simple.md` — 一页纸流程简版
- `docs/workflow-detailed.md` — 详细设计文档（各阶段输入/输出/agent 职责）
- `docs/motivation.md` — 动机实例：三个实测疑点，含 S1 真 bug 的完整发现过程
- `workflows/rtl-directed-difftest.js` — 可执行的 Workflow 脚本
- `hypotheses/` — 疑点清单输入（含示例）
- `templates/` — 汇编自检用例模板 + 单用例编译/运行脚本骨架
- `artifacts/` — 每疑点每轮的中间产物（用例源码、ELF、日志）
- `AGENTS.md` — 给未来 agent 的规则，干活前必读

## 与 isla-runner 工作区的关系

- DUT/REF/工具链均位于 `isla-runner` 工作区：emu 为 `difftest-xiangshan/xiangshan/build/emu`，REF 为 `difftest-xiangshan/xiangshan/ready-to-run/riscv64-nemu-interpreter-so`，交叉编译器 `riscv64-linux-gnu-gcc`。
- 方法论源自 isla-runner 的 `.claude/skills/rtl-difftest/SKILL.md` 与 `agents/findings.md` 中的实测记录；本仓库是其"多疑点、多 agent、带对抗复核"的工程化版本。
- 本仓库只做验证与沉淀，**不修改任何 XiangShan RTL 源码**，不自动开 PR。
