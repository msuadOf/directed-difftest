# 汇编自检用例模板（骨架）
# 编译与运行见 templates/run-one-case.sh
# 自检原则: 不依赖人工看波形, check 阶段读回架构状态并分支判定

    .section .text
    .globl _start
_start:
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
    # 失败路径: 也可在此打印/写内存取证, 但必须停在非 GOODTRAP 地址
    j       .

    .align 2
GOODTRAP:
    .word 0x0000006b            # GOODTRAP: DiffTest 双方一致即在此提交
