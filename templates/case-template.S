# 汇编自检用例模板（骨架）
# 编译与运行见 templates/run-one-case.sh
# 自检原则: 不依赖人工看波形, check 阶段读回架构状态并分支判定

    .section .text
    .globl _start
_start:
    # ---- setup: trap 基础设施(涉及 trap 的用例必填) ----
    # 【硬性要求】TRAPH 标签前必须显式 .balign 4:
    # mtvec.base 会把低 2 位掩掉, 若 TRAPH 落在非 4 字节对齐地址,
    # trap 会跳到 base&~3 的掩码地址(通常是上一条指令中间), 表现为
    # 挂死/乱码伪 GOODTRAP/timeout, 极易误判成"emu 不支持该指令"。
    la      t0, TRAPH
    csrw    mtvec, t0               # 未设 mtvec 时 double-trap 会打印伪 "HIT GOOD TRAP"
    csrr    t0, mstatus
    ori     t0, t0, 0x600           # 使能 mstatus.VS(bits 10:11); 写错位会挂死
    csrw    mstatus, t0

    .balign 4
TRAPH:
    # trap handler: 读 mcause 判定后可改 mepc + mret 跳到 CHECK
    # (具体逻辑按用例填写)
    j       FAIL                    # 占位, 按用例替换

    # ---- setup: 配置向量上下文 + 可辨识初值 ----
    # 初值必须"可辨识": 旧值与算错的新值能区分(如 0x5A vs 0x70),
    # 以掩盖"保留旧值"类 bug。按疑点调整 sew/lmul/vl。
    li      t0, 0x5A            # 可辨识初值 1
    li      t1, 0x70            # 可辨识初值 2
    vsetvli t2, zero, e8, m1, ta, ma   # vl = VLMAX(e8,m1); 按疑点改 sew/lmul/vl

    # ---- trigger: 触发疑点的指令序列(按假设的 trigger 填写) ----
    # 例: 先写 vstart (csrw vstart, ...) 再执行向量指令, 观察 vstart>0 行为
    # 例: 触发饱和指令后再触发同拍清零语义指令, 观察 vxsat
    # 变体扫描: 每个变量值单独出一个 ELF, 一组变体一起比较

    # ---- check: 读回受影响状态到 GPR 并判定 ----
    # vmv.x.s 读向量寄存器首元素 / csrr 读 CSR
    vmv.x.s t3, v0              # 读回目标向量寄存器
    li      t4, <期望值>
    bne     t3, t4, FAIL        # 值不对 -> 跳 FAIL(非 GOODTRAP 地址)

    # 一致性追问(无条件执行): trap 返回 / flushPipe / vsetvli 重配置之后
    # 再次读回向量寄存器和 CSR; 并读一个从未被写过的相邻寄存器,
    # 判断污染是否经旁路/检查点扩散。
    # (按需补充 csrr vxsat / 二次 vsetvli 后再 vmv.x.s 等)

    # ---- 通过: 落到 GOODTRAP ----
    j       GOODTRAP

FAIL:
    # 失败路径: 停在非 GOODTRAP 地址。
    # 【注意】j .(自旋)+外层 timeout 会以 SIGTERM 杀 emu, 日志显示
    # "timeout: 核心转储", 且无法区分"FAIL 命中"与"挂死/从未到 CHECK"。
    # 更可辨识的写法: 故意执行 illegal 指令(如 .word 0) 或跳到一个
    # 从未定义的地址; 复核时应结合提交跟踪确认 CHECK 确实执行过。
    j       .                       # 外层建议用 timeout -s INT, emu 会打 PERF/周期数

    .align 2
GOODTRAP:
    .word 0x0000006b            # GOODTRAP: DiffTest 双方一致即在此提交
