# VLEN=128 RVV `vstart` trap 后 `vmv.x.s` DiffTest 触发报告

## 1. 结论摘要

在当前 XiangShan `MinimalConfig`（VLEN=128）和 NEMU DiffTest 组合中，下面的目标序列可以稳定触发 DiffTest ABORT：

1. 把 `vtype` 设置为 `e32,m1,ta,ma`，并设置 `vl=4`。
2. 精确初始化 `v3[0] = 0x00000055`，其余 96 位为零。
3. 写 `vstart=1` 或 `vstart=2`。
4. 执行写 `v4` 的 `vadd.vv` 或 `vsadd.vi`；当前 DUT 把它作为非法指令，陷入机器态 handler。
5. handler 验证 `mcause=2`、跳过该指令、清零 `vstart`，随后 `mret`。
6. 执行 `vmv.x.s a0,v3`。

目标指令不写 `v3`，因此这条 scalar move 应读取原先的 `0x55`。NEMU 的确给出 `a0=0x55`，而 DUT 提交 `a0=0xffffffff00000055`，使 DiffTest 终止。

四种组合全部复现：`vadd.vv` / `vsadd.vi`，各自配 `vstart=1` / `2`。

但隔离对照表明：在这个 `emu` 中，该污染**不以非零 `vstart` 或 trap 为必要条件**。只要保留 `e32,m1,ta,ma`，即使没有向量算术且 `vstart=0`，同一 `vmv.x.s` 也会产生同样的错误值；反之，把策略改为 `tu,mu` 后，保留完整的 trap 路径会 GOODTRAP。因此已验证的强关联条件是 `ta,ma`，不能仅凭本测试把根因归结为 trap flush/恢复。

## 2. 验证环境

| 项目 | 值 |
| --- | --- |
| DUT | XiangShan commit `7bf51a8805543878a74f817dd731efde40c30fd2` 的已有 `build/emu` |
| DUT 配置 | `MinimalConfig`，VLEN=128 |
| 参考模型 | 同一源码树的 `ready-to-run/riscv64-nemu-interpreter-so` |
| 汇编器/链接器 | `riscv64-unknown-elf-gcc` 10.2.0 |
| 日志模式 | `--dump-commit-trace` |
| 单例上限 | `-C 5000` cycles |

所有可重跑的源、ELF 和日志均位于本报告同目录。

## 3. 测试用例

源文件是 [`vstart_trap_vmv.S`](vstart_trap_vmv.S)。`Makefile` 为下列四个目标实例化同一源码：

| ELF | `vstart` | 算术指令 | 编码 |
| --- | ---: | --- | --- |
| `build/vadd-vstart1.elf` | 1 | `vadd.vv v4,v0,v1` | `0x02008257` |
| `build/vadd-vstart2.elf` | 2 | `vadd.vv v4,v0,v1` | `0x02008257` |
| `build/vsadd-vstart1.elf` | 1 | `vsadd.vi v4,v0,1` | `0x8600b257` |
| `build/vsadd-vstart2.elf` | 2 | `vsadd.vi v4,v0,1` | `0x8600b257` |

目标序列的等价伪汇编如下；每条向量指令在实际源码中使用 `.4byte` 编码，以兼容当前较旧的 GNU RISC-V 汇编器。

```asm
# 允许机器态使用 RVV，并设置异常入口。
set mstatus.VS = Dirty
mtvec = trap_handler

# AVL=4, SEW=32, LMUL=1, tail agnostic, mask agnostic。
vsetvli zero, t1, e32, m1, ta, ma

# 从内存加载完整 128-bit v3：{ element[3..1]=0, element[0]=0x55 }。
vl1re32.v v3, (vector_initial_v3)

csrw vstart, n                 # n = 1 或 2
vadd.vv  v4, v0, v1            # 或 vsadd.vi v4, v0, 1

vmv.x.s a0, v3
assert a0 == 0x55
GOODTRAP
```

异常 handler 的逻辑为：

```asm
assert mcause == 2             # illegal instruction
mepc = mepc + 4                # 跳过算术指令
csrw vstart, zero
mret
```

handler 中显式清零 `vstart` 是测试必要的控制步骤：若不清零，NEMU 也会把后继的 `vmv.x.s` 视作非法指令，无法观察目标 scalar-read 比较。

## 4. 指令和状态语义

### `vsetvli zero,t1,e32,m1,ta,ma`，且 `t1=4`

- `SEW=32`：每个向量元素为 32 位。
- `LMUL=1` 且 VLEN=128：`VLMAX = 128 / 32 = 4` 个元素。
- `vl=4`：四个元素均位于 active body 内；从架构语义看，本例没有实际 tail 元素。
- `ta,ma`：tail/mask-agnostic 策略允许**不活动**元素写为全 1；本用例未使用 mask，且 `vl=VLMAX`，所以该策略不应改变 `v3[0]`。

### `vl1re32.v v3,(addr)`

这是 whole-register load。测试内存按小端保存 128 位：

```text
v3 = 0x00000000_00000000_00000000_00000055
```

因此 `v3[0]` 是 32-bit 的 `0x00000055`；本测试避免用另一条 vector move 初始化 `v3`，以排除初始化指令对结果的干扰。

### 非零 `vstart` 与算术指令

本 DUT 的 `VecExceptionGen.scala` 中存在：

```scala
vstartIllegal = isVArith && (vstart != 0)
```

故上述 `vadd.vv` / `vsadd.vi` 均提交 illegal-instruction exception（`mcause=2`）。它们的目的只是制造报告所述的 vector exception → handler → `mret` 路径；目的寄存器为 `v4`，不应写到 `v3`。

### `vmv.x.s a0,v3`

该指令把 `v3` 的第 0 个元素移入整型寄存器。对于 `SEW=32 < XLEN=64`，`0x00000055` 经符号扩展或零扩展的结果都应为：

```text
a0 = 0x0000000000000055
```

这也是 NEMU 的结果和测试中 `a0 == 0x55` 的断言依据。

## 5. 预期结果

若实现符合本测试的状态隔离要求，四个目标案例都应满足：

1. 算术指令在 `0x80000038` 产生一次 illegal-instruction trap。
2. handler 跳过该指令，清零 `vstart`，正常 `mret` 到 `0x8000003c`。
3. `vmv.x.s a0,v3` 读取从未被目标算术指令修改的 `v3[0]`。
4. `a0 = 0x0000000000000055`，与 NEMU 一致。
5. 程序到达 custom `GOODTRAP`；DiffTest 无 ABORT。

## 6. 实际结果

四个案例全都产生相同的差异：

| 测试 | trap 指令 | DUT 在 `vmv.x.s` 的提交值 | NEMU 值 | 最终结果 |
| --- | --- | --- | --- | --- |
| `vadd-vstart1` | `02008257` | `ffffffff00000055` | `0000000000000055` | DiffTest ABORT |
| `vadd-vstart2` | `02008257` | `ffffffff00000055` | `0000000000000055` | DiffTest ABORT |
| `vsadd-vstart1` | `8600b257` | `ffffffff00000055` | `0000000000000055` | DiffTest ABORT |
| `vsadd-vstart2` | `8600b257` | `ffffffff00000055` | `0000000000000055` | DiffTest ABORT |

`vadd-vstart1.log` 的代表性提交证据为：

```text
[20] exception pc 0000000080000038 inst 02008257 cause 0000000000000002
...
[29] commit pc 000000008000003c inst 42302557 wen 1 dst 10 data ffffffff00000055
...
a0 different ... right = 0x0000000000000055, wrong = 0xffffffff00000055
Core 0: ABORT
```

其中 `42302557` 是 `vmv.x.s a0,v3`，`dst 10` 是整数寄存器 `a0`。

## 7. 隔离对照和发现

### 对照 A：去掉非零 `vstart`、去掉 trap、去掉向量 ALU

`build/vmv-only-ta-ma.elf` 保留 `e32,m1,ta,ma` 和 `v3[0]=0x55`，但设置 `vstart=0`，将原算术指令替换为 `nop`。

结果仍为：

```text
NEMU a0 = 0x0000000000000055
DUT  a0 = 0xffffffff00000055
DiffTest ABORT
```

**含义：** 非零 `vstart`、illegal trap、`mret` 和目标 vector arithmetic 都不是产生该特定高 32 位污染的必要条件。

### 对照 B：保留完整 trap 路径，改 `ta,ma` 为 `tu,mu`

`build/vadd-vstart1-tu-mu.elf` 保留 `vstart=1`、`vadd.vv v4,v0,v1`、trap handler 和 `vmv.x.s`，仅将 `vsetvli` 改为：

```asm
vsetvli zero, t1, e32, m1, tu, mu
```

提交变为：

```text
exception pc 0000000080000038 inst 02008257 cause 0000000000000002
commit pc 000000008000003c inst 42302557 wen 1 dst 10 data 0000000000000055
HIT GOOD TRAP
```

**含义：** tail/mask agnostic 策略是本版本 `emu` 复现该错误的必要观察条件；`tu,mu` 会阻断该现象，即使完整保留非零 `vstart` trap 路径。

## 8. 可作出的结论与不能作出的结论

已验证：

- 用户给出的四种 `vstart`/算术指令组合都能复现完全相同的 GPR DiffTest 差异。
- DUT 的错误提交值精确为 `0xffffffff00000055`，参考端精确为 `0x55`。
- 改用 whole-register load 初始化的 `v3` 后现象仍存在，故不是 `v3` 初始化 vector move 的伪影。
- `ta,ma` 与该错误有直接可重复的相关性；在 `tu,mu` 中，目标 trap 路径通过。

尚未由本报告证明：

- 不能仅凭此测试断言污染具体发生在 trap flush、恢复 checkpoint、旁路，还是 `vmv.x.s` 的数据格式/符号扩展路径。
- 不能断言 `vstartIllegal` 本身是标量读污染的根因；对照 A 表明无需触发该异常，错误也会发生。
- 未测试用户额外报告的 `SEW=64 + vsadd.vi + vstart=1` 的 emu/glibc 崩溃。
- 未测试 `csrw vstart` 位于 `vsetvli` 之前导致 masked `vadd` 被吞的独立问题。

## 9. 复跑命令

```sh
cd /tmp/xs-vstart-vmv-repro.ErPjyV

# 用户报告的四种触发组合；预期全部显示 REPRODUCED。
make run

# 两个隔离对照；预期分别显示 REPRODUCED 和 GOODTRAP。
make controls
```

构建产物和对应的完整 commit trace 位于 `build/`。
