REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
RUNNER := $(REPO_ROOT)/scripts/run_batch.py
OUT := build
# 复现依赖 master NEMU REF(旧随附二进制会把同错镜像成无分歧):
#   /home/baiyifan/.claude/jobs/3a6294b1/tmp/NEMU/build/riscv64-nemu-interpreter-so
# 若该路径失效, 按 findings/G README 的方法自编 master NEMU(kunminghu-v3-ref)
REFBIN ?= /home/baiyifan/.claude/jobs/3a6294b1/tmp/NEMU/build/riscv64-nemu-interpreter-so

.PHONY: run control clean

run:
	mkdir -p $(OUT)
	ulimit -f 2097152; REF=$(REFBIN) python3 $(RUNNER) -o $(OUT)/ repro_filtered_sfence.S
	@if grep -q "a2 different" $(OUT)/repro_filtered_sfence.log; then \
		echo "REPRODUCED: 过滤 sfence 后非叶缓存陈旧(ref=0x70 dut=0x5a, 见 $(OUT)/)"; \
	else echo "NOT_REPRODUCED — 检查 REF 路径与 $(OUT)/"; exit 1; fi

control:
	mkdir -p $(OUT)
	ulimit -f 2097152; REF=$(REFBIN) python3 $(RUNNER) -o $(OUT)/ ctrl_full_sfence.S
	@grep -E "GOODTRAP|ABORT" $(OUT)/summary.tsv || true

clean:
	rm -rf $(OUT)
