# XiangShan `vstart` trap followed by `vmv.x.s`

This directory is intentionally self-contained and uses the repo's VLEN=128
`MinimalConfig` emulator (submodule `xiangshan/`, run `scripts/setup-env.sh`
once) with the colocated NEMU shared object.

向量指令在本例中以 `.4byte` 立即数编码（兼容旧 gcc），改用 RVV 助记符时需要
`scripts/toolchain.sh` 选出的新工具链。

`vstart_trap_vmv.S` loads an exact 128-bit `v3` image with only `v3[0]=0x55`,
writes a non-zero `vstart`, executes a vector ALU instruction into `v4`, skips the
expected illegal-instruction exception in the machine-mode trap handler,
clears `vstart` so the following vector instruction is executable, and then
reads `v3[0]` with `vmv.x.s a0, v3`.  The program reaches the custom
GOODTRAP only when `a0 == 0x55`.

Run all four reported trigger combinations with:

```sh
make run
```

Each `build/*.log` includes the commit trace. A DiffTest mismatch is a
reproduction even before the in-program check can reach GOODTRAP. The expected
summary is `REPRODUCED` for all four files.

Run the two isolation controls with:

```sh
make controls
```

The controls show that the `ta,ma` policy is also essential in this emulator:
with `e32,m1,ta,ma`, the exact scalar-read mismatch occurs even with `vstart=0`
and no preceding vector ALU instruction. Switching the same trap path to
`tu,mu` reaches GOODTRAP. Therefore, this directory faithfully reproduces the
reported non-zero-`vstart` sequence, but it also demonstrates that, for the
current `emu`, neither the trap nor non-zero `vstart` is a necessary condition
for this particular `vmv.x.s` mismatch.

See [TRIGGER_REPORT.md](TRIGGER_REPORT.md) for the full trigger report, and
[RESULTS.md](RESULTS.md) for the short captured-result summary.
