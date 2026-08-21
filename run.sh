#!/usr/bin/env bash
# directed-difftest 入口: 按关注方向扫描 RTL 疑点并跑定向 DiffTest 验证工作流
#
# 用法:
#   ./run.sh --focus "V 扩展 vstart/trap 恢复语义"                      # 扫描+验证
#   ./run.sh --focus "V 扩展" --model claude-opus-4-7[1m]              # 指定模型
#   ./run.sh --focus "V 扩展" --max-sweeps 3                          # 外层扫荡轮 3 轮
#   ./run.sh --focus "V 扩展" --max-suspicions 5                     # 扫描阶段最多产出 5 条疑点
#   ./run.sh --suspicions hypotheses/examples/vstart-vxsat-vlen.json   # 跳过扫描, 直接验证
#   ./run.sh --focus "CSR 同拍写顺序" --scan-only                      # 只产出疑点清单
#
# 所有参数:
#   --focus <text>        关注方向(自然语言), 用于 scan 阶段; 与 --suspicions 二选一
#   --suspicions <file>   已有疑点 JSON(格式见 hypotheses/examples/), 跳过扫描
#   --model <id>          Claude 模型 id, 默认继承当前 claude 配置
#   --max-suspicions <n>  scan 阶段产出的疑点数量上限, 默认 8
#   --max-variants <n>    内层"变体轮": Isolate 阶段每疑点只改一个变量的轮数上限, 默认 4
#   --max-sweeps <n>      外层"扫荡轮": 疑点清单滚动验证轮数上限(每轮产出的新疑点
#                         去重后作为下轮输入, 直到无新疑点或达上限), 默认 1(不滚动)
#   --workspace <dir>     xiangshan submodule 目录, 默认 <本仓库>/xiangshan (一般无需指定)
#   --scan-only           只扫描产出疑点清单, 不跑验证
#   --dry-run             只打印将执行的 claude 命令, 不运行
#   -h | --help           本帮助

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FOCUS=""
SUSPICIONS=""
MODEL=""
MAX_SUSPICIONS=8
MAX_VARIANTS=4
MAX_SWEEPS=1
WORKSPACE="$REPO_ROOT/xiangshan"
SCAN_ONLY=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --focus)        FOCUS="$2"; shift 2 ;;
    --suspicions)   SUSPICIONS="$2"; shift 2 ;;
    --model)        MODEL="$2"; shift 2 ;;
    --max-suspicions) MAX_SUSPICIONS="$2"; shift 2 ;;
    --max-variants) MAX_VARIANTS="$2"; shift 2 ;;
    --max-sweeps)   MAX_SWEEPS="$2"; shift 2 ;;
    --max-rounds)   MAX_VARIANTS="$2"; shift 2 ;;   # 旧名兼容
    --max-cycles)   MAX_SWEEPS="$2"; shift 2 ;;     # 旧名兼容
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
  run_claude "你是 RTL 审查专家。仓库 $WORKSPACE (submodule, pin 7bf51a8, kunminghu-v3, MinimalConfig, VLEN=128)。
关注方向: $FOCUS

阅读本仓库 docs/workflow-detailed.md 了解疑点格式后, 静态审查相关 RTL, 产出最多 $MAX_SUSPICIONS 个高价值疑点(suspicion)(宁缺毋滥, 不足上限也可以):
- 每条含 id/file/line/claim(预期错误行为: 哪个信号/寄存器会错成什么)
- 只报你有具体触发设想的, 不报风格问题
- 写成 JSON 到 $OUT_JSON, 格式:
  {\"suspicions\": [{\"id\": \"S1\", \"file\": \"...\", \"line\": 123, \"claim\": \"...\"}], \"max_variants\": $MAX_VARIANTS}
禁止修改 XiangShan 源码。完成后回复文件路径即可。"
  [[ $SCAN_ONLY -eq 1 ]] && { echo "[run.sh] --scan-only, 结束。疑点清单: $OUT_JSON"; exit 0; }
  SUSPICIONS="$OUT_JSON"
  [[ $DRY_RUN -eq 1 ]] && { echo "[run.sh] --dry-run: (实际运行时此处会生成 $OUT_JSON 后再进入验证)"; exit 0; }
fi

if [[ ! -f "$SUSPICIONS" ]]; then
  echo "错误: 疑点文件不存在: $SUSPICIONS" >&2
  exit 1
fi

# ---------- 阶段 2: 跑验证工作流 ----------
echo "[run.sh] 提示: xiangshan/build/emu 缺失时先跑 ./scripts/setup-env.sh"
echo "[run.sh] verify: workflow=rtl-directed-difftest, 疑点=$SUSPICIONS, variants=$MAX_VARIANTS, sweeps=$MAX_SWEEPS"
ARGS_JSON="$(python3 -c "
import json,sys
d=json.load(open('$SUSPICIONS'))
d.setdefault('max_variants', $MAX_VARIANTS)
d.setdefault('max_sweeps', $MAX_SWEEPS)
print(json.dumps(d))")"

run_claude "用 workflow 跑 $REPO_ROOT/workflows/rtl-directed-difftest.js(scriptPath 加载), args 直接使用以下 JSON 内容:
$ARGS_JSON

工作流与运行要求的细节先读 $REPO_ROOT/AGENTS.md 和 docs/workflow-detailed.md。"
