# AGENTS.md — directed-difftest 项目规则（未来 agent 必读）
- 所有的回答、书写的文档都必须使用中文

## 硬规则

1. **先读 `docs/workflow-detailed.md` 再干活**。所有阶段定义、schema、终止条件以该文档为准；简版只作速览。
2. **中间文件一律放 `artifacts/<疑点id>/variant<N>/`**（源码、ELF、编译产物、日志、提交跟踪）。不要写到仓库其他位置或系统 /tmp。
3. **所有结论必须三分类**：真实可触发（bug）/ 被机制天然规避（写明哪条机制）/ 当前配置不可达（写明何时暴露）。不允许二值"有/无 bug"。
4. **复现用例必须留 ELF**：每个"真实可触发"结论对应的最小复现 ELF 不许删除，路径写入汇总的复现清单。
5. **不修改 XiangShan 源码**（`workspace` 下的 difftest-xiangshan/xiangshan 等）。本仓库只读 RTL、只写本仓库文件；也不自动修 RTL、不开 PR。

## 工作约定

- 环境信息（emu/REF/编译器/GOODTRAP/-b/-e）见 `docs/workflow-detailed.md` 的"固定环境信息"一节，直接抄进 prompt，勿自行重建环境。
- Isolate 迭代的终止由 Workflow JS 代码判定（轮数上限 + 连续一轮无新信息），agent 不要自行决定"差不多了"。
- 测试通过 ≠ 无 bug：必须做灵敏度对照和 trap/flushPipe/vsetvli 后的一致性追问。
- Skeptic 的 REFUTED 结论不回环重做，标人工复核。
- Synthesize 的 findings.md 条目只出草稿，不直接改任何共享文件。
