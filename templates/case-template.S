# 汇编自检用例模板（骨架）
# 编译与运行: 一律经 scripts/run_batch.py（并行槽位+看门狗+runs.jsonl 记录）,
#             禁止直接调 emu（唯一例外: 确定性重放取波形, 见 run_batch.py --wave）
# 自检原则: 不依赖人工看波形, check 阶段读回架构状态并分支判定
#
# ---- 三条 runner 约定 ----
# 1. #meta: 行会被 run_batch.py 解析进 runs.jsonl 的 meta 字段, 供 runs_query.py
#    跨 run 关联分析（哪类参数总在失败）。写上本用例的 ISA 级参数:
#meta: sew=8 lmul=1 vl=vlmax  # <- 按用例实际参数改
# 2. 故意的等待/轮询循环必须用 POLL_ 前缀标签（如 POLL_wait:）, 看门狗按符号表
#    白名单放行; 无进展又无 POLL_ 前缀的循环会被判 KILLED_SPIN 击毙。
#    （写回值每轮变化的延时循环如 addi t0,t0,-1 不需要标注, 进展检查会放行。）
# 3. FAIL 落点保持独立标签名 FAIL: 看门狗认出停驻在 FAIL 的自环后直接判
#    SELF_TEST_FAIL（区别于挂死）, 不再有"FAIL 命中还是挂死"的歧义。

# ---- STATE_FENCE 宏: 关键事件后的全量向量状态快照（"一致性追问"的基础设施） ----
# 在 trap 返回 / flushPipe / vsetvli 重配置等关键点后调用, 把 vstart/vl/vtype/vcsr
# 与 v0-v31 全部存进 buf。作用: (1) 全部向量状态经 store/load 变成架构可见, 任何
# DUT/REF 分歧可被 difftest 抓到; (2) 同一 buf 布局下多个快照点可自对照
# (fence1 vs fence2), 定位污染发生在哪个事件之后。
# 【注意】宏会破坏 vtype/vl/vstart（旧值已存入 buf 前 32B）; 若用例还要继续
# 向量运算, fence 后必须重新 vsetvli。buf 需 .balign 8 且 .space >= 544。
# 布局: +0 vstart, +8 vl, +16 vtype, +24 vcsr, +32 起 v0..v31（每寄存器 VLEN/8 B, m8 连续存）
    .macro STATE_FENCE buf, t=t5, u=t6
    la      \t, \buf
    csrr    \u, vstart
    sd      \u, 0(\t)
    csrr    \u, vl
    sd      \u, 8(\t)
    csrr    \u, vtype
    sd      \u, 16(\t)
    csrr    \u, vcsr
    sd      \u, 24(\t)
    addi    \t, \t, 32
    vsetvli \u, zero, e8, m8, ta, ma
    vse8.v  v0, (\t)
    addi    \t, \t, 128
    vse8.v  v8, (\t)
    addi    \t, \t, 128
    vse8.v  v16, (\t)
    addi    \t, \t, 128
    vse8.v  v24, (\t)
    .endm

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
    # 变体扫描: 每个变量值单独出一个 .S/ELF, 一组变体一次性交给
    #   scripts/run_batch.py -o <outdir> a.S b.S c.S ...   并行跑完读 summary.tsv

    # ---- check: 读回受影响状态到 GPR 并判定 ----
    # 【禁止用 vmv.x.s 读回】它有已知 F1 符号扩展 bug(ta 策略下高位污染,
    # 见 hypotheses/known-issues.json 的 XS-vmvxs-tail-pollution), 用它读回
    # 会把已知 bug 的 ABORT 误归因到被测疑点。一律 vse 存内存再 load:
    la      t5, BUF
    vse8.v  v0, (t5)            # 按 SEW 换 vse16/vse32/vse64
    lbu     t3, 0(t5)           # 32bit 比较用 lwu 而非 lw(lw 符号扩展致永不相等)
    li      t4, 0x5A            # <期望值> 按用例改
    bne     t3, t4, FAIL        # 值不对 -> 跳 FAIL(非 GOODTRAP 地址)
    # CSR 读回仍用 csrr(不经向量搬移路径, 无 F1 问题)

    # 一致性追问(无条件执行): trap 返回 / flushPipe / vsetvli 重配置之后
    # 打 STATE_FENCE 快照(如 STATE_FENCE FENCE1), 与触发前的快照(FENCE0)自对照,
    # 并读一个从未被写过的相邻寄存器, 判断污染是否经旁路/检查点扩散。
    # 快照差分可用: cmp 两段内存逐字节, 或 fence 后对关键字节 load+bne 硬判。

    # ---- 通过: 落到 GOODTRAP ----
    j       GOODTRAP

FAIL:
    # 失败路径: 停在非 GOODTRAP 地址, 用两条指令自环(单条 jal-to-self 会被 emu
    # 判 GOODTRAP)。看门狗认出 FAIL 自环 -> SELF_TEST_FAIL, 不会烧到 timeout。
1:  addi    t6, t6, 0
    j       1b

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
FENCE0:
    .space  544                 # STATE_FENCE 快照区(32B CSR + 512B v0-v31)
FENCE1:
    .space  544                 # 第二快照点(与 FENCE0 自对照)
