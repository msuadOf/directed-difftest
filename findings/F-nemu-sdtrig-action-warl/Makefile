REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
RUNNER := $(REPO_ROOT)/scripts/run_batch.py
OUT := build

# 预期: ABORT — csrw tdata1(0x7a1) 写 mcontrol6 ACTION=1(0x6000000000001044):
# XiangShan 按 Sdtrig 规范 WARL 归 0(非 dmode 下 ACTION=1 不可保留, 读回 0x...0044)
# NEMU(trigger.c)谓词缺 dmode 前置保留 ACTION=1(读回 0x...1044) → tdata1 different
.PHONY: run clean

run:
	mkdir -p $(OUT)
	ulimit -f 2097152; python3 $(RUNNER) -o $(OUT)/ min.S
	@if grep -q "tdata1 different" $(OUT)/min.log; then \
		echo "REPRODUCED: NEMU 保留 ACTION=1 / XS WARL 归 0(见 $(OUT)/min.log)"; \
	else echo "NOT_REPRODUCED"; exit 1; fi

clean:
	rm -rf $(OUT)
