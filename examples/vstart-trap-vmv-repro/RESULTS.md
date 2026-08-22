# Captured result

Environment: XiangShan commit `7bf51a8805543878a74f817dd731efde40c30fd2`,
the existing VLEN=128 `MinimalConfig` `build/emu`, and the colocated NEMU
`riscv64-nemu-interpreter-so`.

The requested cases all reproduced on 2026-08-21. Each took an illegal
instruction trap at `0x80000038`, resumed at the `vmv.x.s` at `0x8000003c`, and
then produced the same differential result.

| Test | Trapping instruction | DUT `a0` | NEMU `a0` | Outcome |
| --- | --- | --- | --- | --- |
| `vadd-vstart1` | `02008257` | `ffffffff00000055` | `0000000000000055` | ABORT |
| `vadd-vstart2` | `02008257` | `ffffffff00000055` | `0000000000000055` | ABORT |
| `vsadd-vstart1` | `8600b257` | `ffffffff00000055` | `0000000000000055` | ABORT |
| `vsadd-vstart2` | `8600b257` | `ffffffff00000055` | `0000000000000055` | ABORT |

Representative trace lines are:

```text
exception pc 0000000080000038 inst 02008257 cause 0000000000000002
commit pc 000000008000003c inst 42302557 wen 1 dst 10 data ffffffff00000055
a0 different ... right = 0x0000000000000055, wrong = 0xffffffff00000055
```

The two controls establish that the same output is not unique to the trap
sequence:

| Control | Vector context | Result |
| --- | --- | --- |
| `vmv-only-ta-ma` | `vstart=0`, no vector ALU, `e32,m1,ta,ma` | Same ABORT |
| `vadd-vstart1-tu-mu` | Requested trap sequence, `e32,m1,tu,mu` | GOODTRAP |

Thus the evidence supports an agnostic-policy-related e32 scalar-read defect
in this `emu`; the non-zero-`vstart` illegal-instruction path is a sufficient
trigger but not a necessary one.
