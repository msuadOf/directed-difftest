REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
RUNNER := $(REPO_ROOT)/scripts/run_batch.py
OUT := build
# 同 G 号: 复现需 master NEMU REF(旧随附二进制对 mhpmevent 写路径行为不同)
REFBIN ?= /home/baiyifan/.claude/jobs/3a6294b1/tmp/NEMU/build/riscv64-nemu-interpreter-so

.PHONY: run control clean

run:
	mkdir -p $(OUT)
	ulimit -f 2097152; REF=$(REFBIN) python3 $(RUNNER) -o $(OUT)/ min.S
	@if grep -q "t1 different" $(OUT)/min.log; then \
		echo "REPRODUCED: OPTYPE 非法值原样读回(ref=0 dut=0x000c000000000000)"; \
	else echo "NOT_REPRODUCED"; exit 1; fi

control:
	mkdir -p $(OUT)
	ulimit -f 2097152; REF=$(REFBIN) python3 $(RUNNER) -o $(OUT)/ ctrl_legal.S
	@grep -E "GOODTRAP|ABORT" $(OUT)/summary.tsv || true

clean:
	rm -rf $(OUT)
