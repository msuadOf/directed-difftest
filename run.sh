#!/usr/bin/env bash
# claudefuzz 入口: 按关注方向扫描 RTL 疑点并跑定向 DiffTest 验证工作流
#
# 用法:
#   ./run.sh --focus "V 扩展 vstart/trap 恢复语义"                      # 扫描+验证
#   ./run.sh --focus "V 扩展" --model claude-opus-4-7[1m]              # 指定模型
#   ./run.sh --suspicions hypotheses/examples/vstart-vxsat-vlen.json   # 跳过扫描, 直接验证
#   ./run.sh --focus "CSR 同拍写顺序" --scan-only                      # 只产出疑点清单
#
# 所有参数:
#   --focus <text>        关注方向(自然语言), 用于 scan 阶段; 与 --suspicions 二选一
#   --suspicions <file>   已有疑点 JSON(格式见 hypotheses/examples/), 跳过扫描
#   --model <id>          Claude 模型 id, 默认继承当前 claude 配置
#   --max-rounds <n>      Isolate 阶段每疑点轮数上限, 默认 4
#   --workspace <dir>     isla-runner 工作区根, 默认 /home/baiyifan/workplace-local/isla-runner
#   --scan-only           只扫描产出疑点清单, 不跑验证
#   --dry-run             只打印将执行的 claude 命令, 不运行
#   -h | --help           本帮助

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FOCUS=""
SUSPICIONS=""
MODEL=""
MAX_ROUNDS=4
WORKSPACE="/home/baiyifan/workplace-local/isla-runner"
SCAN_ONLY=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --focus)        FOCUS="$2"; shift 2 ;;
    --suspicions)   SUSPICIONS="$2"; shift 2 ;;
    --model)        MODEL="$2"; shift 2 ;;
    --max-rounds)   MAX_ROUNDS="$2"; shift 2 ;;
    --workspace)    WORKSPACE="$2"; shift 2 ;;
    --scan-only)    SCAN_ONLY=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1 (见 --help)" >&2; exit 1 ;;
  esac
done

if [[ -z "$FOCUS" && -z "$SUSPICIONS" ]]; then
  echo "错误: 必须提供 --focus <方向> 或 --suspicions <疑点JSON> 之一" >&2
  exit 1
fi

MODEL_ARGS=()
[[ -n "$MODEL" ]] && MODEL_ARGS=(--model "$MODEL")

run_claude() {  # $1=prompt
  # 权限说明: 验证阶段要跑 bash(emu/gcc/riscv64-linux-gnu-gcc)。
  # acceptEdits 只放行文件编辑; 请在运行前于 settings.json 或启动交互中
  # 预放行所需命令, 否则 headless 会话会在权限点失败。
  local cmd=(claude -p "$1" "${MODEL_ARGS[@]}"
             --permission-mode acceptEdits
             --add-dir "$WORKSPACE")
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '%q\n' "${cmd[@]}"
  else
    "${cmd[@]}"
  fi
}

STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$REPO_ROOT/hypotheses" "$REPO_ROOT/artifacts"

# ---------- 阶段 1: 扫描产出疑点清单(除非已提供) ----------
if [[ -z "$SUSPICIONS" ]]; then
  OUT_JSON="$REPO_ROOT/hypotheses/scan-${STAMP}.json"
  echo "[run.sh] scan: 关注方向=「$FOCUS」 -> $OUT_JSON"
  run_claude "你是 RTL 审查专家。仓库 $WORKSPACE/difftest-xiangshan/xiangshan (kunminghu-v3, MinimalConfig, VLEN=128)。
关注方向: $FOCUS

阅读本仓库 docs/workflow-detailed.md 了解疑点格式后, 静态审查相关 RTL, 产出 3-8 个高价值疑点(suspicion):
- 每条含 id/file/line/claim(预期错误行为: 哪个信号/寄存器会错成什么)
- 只报你有具体触发设想的, 不报风格问题
- 写成 JSON 到 $OUT_JSON, 格式:
  {\"suspicions\": [{\"id\": \"S1\", \"file\": \"...\", \"line\": 123, \"claim\": \"...\"}], \"max_rounds\": $MAX_ROUNDS, \"workspace\": \"$WORKSPACE\"}
禁止修改 XiangShan 源码。完成后回复文件路径即可。"
  [[ $SCAN_ONLY -eq 1 ]] && { echo "[run.sh] --scan-only, 结束。疑点清单: $OUT_JSON"; exit 0; }
  SUSPICIONS="$OUT_JSON"
fi

if [[ ! -f "$SUSPICIONS" ]]; then
  echo "错误: 疑点文件不存在: $SUSPICIONS" >&2
  exit 1
fi

# ---------- 阶段 2: 跑验证工作流 ----------
echo "[run.sh] verify: workflow=rtl-directed-difftest, 疑点=$SUSPICIONS, max_rounds=$MAX_ROUNDS"
ARGS_JSON="$(python3 -c "
import json,sys
d=json.load(open('$SUSPICIONS'))
d.setdefault('max_rounds', $MAX_ROUNDS)
d.setdefault('workspace', '$WORKSPACE')
print(json.dumps(d))")"

run_claude "用 workflow 跑 $REPO_ROOT/workflows/rtl-directed-difftest.js(scriptPath 加载), args 直接使用以下 JSON 内容:
$ARGS_JSON

工作流与运行要求的细节先读 $REPO_ROOT/AGENTS.md 和 docs/workflow-detailed.md。"
