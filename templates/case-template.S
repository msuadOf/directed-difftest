# 汇编自检用例模板（骨架）
# 编译与运行见 templates/run-one-case.sh
# 自检原则: 不依赖人工看波形, check 阶段读回架构状态并分支判定

    .section .text
    .globl _start
_start:
    # ---- setup: trap 基础设施(涉及 trap 的用例必填) ----
    # TRAPH 本体放在文件末尾 GOODTRAP 之后, 不在直线执行流上
    # (若插在 setup 与 trigger 之间, csrw mstatus 后会 fall-through 误入 handler)
    la      t0, TRAPH
    csrw    mtvec, t0               # 未设 mtvec 时 double-trap 会打印伪 "HIT GOOD TRAP"
    csrr    t0, mstatus
    ori     t0, t0, 0x600           # 使能 mstatus.VS(bits 10:9, 值 0x600); 写错位会挂死
    csrw    mstatus, t0

    # ---- setup: 配置向量上下文 + 可辨识初值 ----
    # 初值必须"可辨识": 旧值与算错的新值能区分(如 0x5A vs 0x70),
    # 以掩盖"保留旧值"类 bug。按疑点调整 sew/lmul/vl。
    # 【注意】未写过的向量寄存器在 difftest 下随机初始化、非 0,
    # 不得断言"未写 vN == 0"; 自对照要先 vse 存初值到 refbuf, 末尾再存一次比对。
    li      t0, 0x5A            # 可辨识初值 1
    li      t1, 0x70            # 可辨识初值 2
    vsetvli t2, zero, e8, m1, ta, ma   # vl = VLMAX(e8,m1); 按疑点改 sew/lmul/vl

    # ---- trigger: 触发疑点的指令序列(按假设的 trigger 填写) ----
    # 例: 先写 vstart (csrw vstart, ...) 再执行向量指令, 观察 vstart>0 行为
    # 例: 触发饱和指令后再触发同拍清零语义指令, 观察 vxsat
    # 变体扫描: 每个变量值单独出一个 ELF, 一组变体一起比较

    # ---- check: 读回受影响状态到 GPR 并判定 ----
    # 【禁止用 vmv.x.s 读回】它有已知 F1 符号扩展 bug(ta 策略下高位污染,
    # 见 hypotheses/known-issues.json 的 XS-vmvxs-tail-pollution), 用它读回
    # 会把已知 bug 的 ABORT 误归因到被测疑点。一律 vse 存内存再 load:
    la      t5, BUF
    vse8.v  v0, (t5)            # 按 SEW 换 vse16/vse32/vse64
    lbu     t3, 0(t5)           # 32bit 比较用 lwu 而非 lw(lw 符号扩展致永不相等)
    li      t4, <期望值>
    bne     t3, t4, FAIL        # 值不对 -> 跳 FAIL(非 GOODTRAP 地址)
    # CSR 读回仍用 csrr(不经向量搬移路径, 无 F1 问题)

    # 一致性追问(无条件执行): trap 返回 / flushPipe / vsetvli 重配置之后
    # 再次 vse 读回向量寄存器和 csrr 读 CSR; 并读一个从未被写过的相邻寄存器,
    # 判断污染是否经旁路/检查点扩散(与 refbuf 里的初值自对照, 见 setup 注意)。

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

    # ---- trap handler(直线执行流之外, 仅经 mtvec 进入) ----
    # 【硬性要求】TRAPH 标签前必须显式 .balign 4:
    # mtvec.base 会把低 2 位掩掉, 若 TRAPH 落在非 4 字节对齐地址,
    # trap 会跳到 base&~3 的掩码地址(通常是上一条指令中间), 表现为
    # 挂死/乱码伪 GOODTRAP/timeout, 极易误判成"emu 不支持该指令"。
    .balign 4
TRAPH:
    # trap handler: 读 mcause 判定后可改 mepc + mret 跳回 check
    # (具体逻辑按用例填写)
    j       FAIL                    # 占位, 按用例替换

    # ---- 读回/自对照缓冲区 ----
    .section .data
    .balign 8
BUF:
    .space  64                  # >= VLEN/8 字节(VLEN=128 即 16B, 留余量)
refbuf:
    .space  64                  # 自对照初值快照(见 setup 注意)
