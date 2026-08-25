# directed-difftest — RTL 疑点定向 DiffTest 验证工作流

本仓库把"RTL 疑点定向 DiffTest 验证工作流"固化为可复用的文档 + 脚手架：给定一批 RTL 疑点（文件:行号 + 预期错误行为），按 5 阶段流程（Hypothesize → Probe → Isolate → Skeptic → Synthesize）构造汇编自检用例，跑真实 emu vs NEMU DiffTest，迭代收敛根因，并以三分类结论沉淀。

该方法已在 XiangShan kunminghu-v3（MinimalConfig, VLEN=128）上实测，抓到过真 bug（illegal trap 后向量寄存器被 tail-agnostic 值污染，emu 读到 `0xffffffff00000055` 而 NEMU 为 `0x55`）。

## 怎么用

### 方式一：CLI 一键入口（headless）

`run.sh` 封装 `claude -p` 无头调用，两个阶段：按方向扫 RTL 产出疑点清单 → 跑验证工作流。

```
./run.sh --focus "V 扩展 vstart/trap 恢复语义"                        # 扫描+验证
./run.sh --focus "V 扩展" --model claude-opus-4-7[1m]                 # 指定模型
./run.sh --focus "V 扩展" --max-sweeps 3                              # 外层扫荡轮(sweep) 3 轮
./run.sh --suspicions hypotheses/examples/vstart-vxsat-vlen.json      # 跳过扫描直接验证
./run.sh --focus "CSR 同拍写顺序" --scan-only                         # 只产出疑点清单
./run.sh ... --dry-run                                                # 只看将执行的命令
```

全部参数见 `./run.sh --help`（--focus/--suspicions/--model/--max-suspicions/--max-variants/--max-sweeps/--workspace/--scan-only/--dry-run）。`--max-suspicions` 控制扫描阶段产出的疑点数量上限（默认 8），间接控制总 agent 数与耗时（每疑点约 3-6 个 agent）。

注意：headless 验证阶段需要执行 bash（emu/gcc），请先在 settings.json 预放行相关命令，否则会在权限点失败。

### 方式二：Claude Code 会话内对话运行

在 directed-difftest 目录（或 `--add-dir` 加入本仓库）启动 Claude Code，直接用自然语言驱动。Workflow 由会话内的 Workflow 工具加载脚本、疑点 JSON 内容作为 args 传入：

```
用 workflow 跑 workflows/rtl-directed-difftest.js，args 用 hypotheses/examples/vstart-vxsat-vlen.json 的内容，max_sweeps 设为 2
```

也可以不跑完整 workflow，按 `docs/workflow-detailed.md` 手动逐阶段对话执行；单条用例可用 `templates/run-one-case.sh` 编译并跑 DiffTest。对话方式的好处是可以中途介入（改用例、看证据、跳过某疑点）。

【args 传递纪律】args 里的疑点内容必须先用 `python3 -c "import json;print(json.dumps(json.load(open('<file>')),ensure_ascii=False))"` 之类的命令产出紧凑 JSON 后**整体粘贴**，禁止手工重打/摘抄 —— 历史上转录曾把某条 claim 截成半句、跑到中途才发现。workflow 入口已加校验（缺字段/claim 过短/以非终结符号结尾会直接报错），但校验不能证明内容完整，源头还是要靠整体粘贴。

### 疑点清单格式

```json
{
  "suspicions": [
    {"id": "S1", "file": "...", "line": 123, "claim": "预期错误行为描述"}
  ],
  "max_variants": 4,
  "max_sweeps": 1,
  "workspace": "/home/baiyifan/workplace-local/isla-runner"
}
```

### 迭代层级命名（variant / sweep）

工作流里有两个独立的迭代次数参数（另有第三层不受参数控制，见下）：

| 名字 | 层级 | 含义 | 参数 | 默认 |
|---|---|---|---|---|
| **变体轮 variant** | 内层，单疑点 | Isolate 阶段每疑点"只改一个变量重跑"一轮；另有"连续一轮无新信息"提前终止 | `max_variants` / `--max-variants` | 4 |
| **扫荡轮 sweep** | 外层，疑点清单滚动 | 每个 sweep 把当前疑点清单全部验证一遍，Synthesize 产出的新疑点（副产品分歧、覆盖缺口）**去重后**（跳过已验证 id，新 id 加 `w<N>-` 前缀）作为下一个 sweep 的输入，直到无新疑点或达上限 | `max_sweeps` / `--max-sweeps` | 1（不滚动） |

第三层是 Probe agent 内部的自迭代（构造→跑→再构造在单次 agent 调用内自发进行），刻意**不设参数**——它是探索性的，上限会掐死"一致性追问"这类发现（真 bug 正是从这层冒出来的）。

中间产物在 `artifacts/<疑点id>/variant<N>/`，最终汇总结论由 Synthesize 阶段输出（三分类 + 证据链 + findings.md 草稿 + 供大迭代用的 follow_ups）。

## 目录导航

- `docs/workflow-simple.md` — 一页纸流程简版
- `docs/workflow-detailed.md` — 详细设计文档（各阶段输入/输出/agent 职责）
- `docs/motivation.md` — 动机实例：三个实测疑点，含 S1 真 bug 的完整发现过程
- `workflows/rtl-directed-difftest.js` — 可执行的 Workflow 脚本
- `hypotheses/` — 疑点清单输入（含示例）
- `examples/vstart-trap-vmv-repro/` — S1 真 bug（trap 后 vmv.x.s 读回 tail-agnostic 污染）的完整自包含复现包：`make run` 四组全 REPRODUCED，`make controls` 隔离对照（结论：ta,ma 策略是必要条件，非零 vstart/trap 不是）
- `templates/` — 汇编自检用例模板 + 单用例编译/运行脚本骨架
- `artifacts/` — 每疑点每轮的中间产物（用例源码、ELF、日志）
- `AGENTS.md` — 给未来 agent 的规则，干活前必读
- `xiangshan/` — XiangShan submodule（pin 7bf51a8）；`scripts/setup-env.sh` — 环境初始化/拷贝预编译产物/自检

## 与 isla-runner 工作区的关系

- XiangShan 以 submodule 固定在本仓库 `xiangshan/`（pin 7bf51a8）。首次使用：`./scripts/setup-env.sh`——从已有编译产物 rsync `build/emu` 与 REF（免 Verilator 重编，约 4GB），并自检工具链；`./scripts/setup-env.sh --check` 仅自检；`SRC_XIANGSHAN=... ` 可指定拷贝源，`SKIP_COPY=1` 跳过拷贝自编。
- 交叉编译器 `riscv64-unknown-elf-gcc` 需本机可用（setup 自检会查）。
- 方法论源自 isla-runner 工作区 `.claude/skills/rtl-difftest` 与 `agents/findings.md` 的实测记录；本仓库是其"多疑点、多 agent、带对抗复核"的工程化版本。
- 本仓库只做验证与沉淀，**不修改任何 XiangShan RTL 源码**，不自动开 PR。
- `xiangshan/` 内的 `build/`、`ready-to-run/` 产物不入库（体积大），由 setup-env.sh 恢复。
