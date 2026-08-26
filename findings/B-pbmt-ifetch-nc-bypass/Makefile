REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
RUNNER := $(REPO_ROOT)/scripts/run_batch.py
OUT := build

# 预期: ABORT — 经 pbmt=01(NC) 页取指, DUT 译码 illegal 而 REF 正常,
# 首分歧表现为 mepc/mode/mstatus different(wrong 侧 mepc=0x40000000 即被取指的 NC 页 VA)
.PHONY: run clean

run:
	mkdir -p $(OUT)
	ulimit -f 2097152; python3 $(RUNNER) -o $(OUT)/ min01.S
	@if grep -q "mepc different" $(OUT)/min01.log && grep -q "wrong = 0x0000000040000000" $(OUT)/min01.log; then \
		echo "REPRODUCED: PBMT-NC 页取指 DUT 误报 illegal(见 $(OUT)/min01.log)"; \
	else \
		echo "NOT_REPRODUCED — 检查 $(OUT)/min01.log 与 summary.tsv"; exit 1; \
	fi

clean:
	rm -rf $(OUT)
