REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
RUNNER := $(REPO_ROOT)/scripts/run_batch.py
OUT := build

# 预期: ABORT — stimecmp 写过去时间使 STIP pending 后, 清 menvcfg.STCE,
# DUT 同拍把 pending STIP 撤销(SstcInterruptGen 把 STCE 直接与进 o.STIP),
# REF 保留 → 首分歧 mip different (right=0x20 wrong=0x0)
.PHONY: run control clean

run:
	mkdir -p $(OUT)
	ulimit -f 2097152; python3 $(RUNNER) -o $(OUT)/ r7v3_M1.S
	@if grep -q "mip different" $(OUT)/r7v3_M1.log; then \
		echo "REPRODUCED: 清 STCE 撤销 pending STIP(见 $(OUT)/r7v3_M1.log)"; \
	else echo "NOT_REPRODUCED"; exit 1; fi

# 对照: 同序列但不写 menvcfg 清 STCE(r7v3_F_no_clear_timescan) — pending 不应消失
control:
	mkdir -p $(OUT)
	ulimit -f 2097152; python3 $(RUNNER) -o $(OUT)/ r7v3_F_no_clear_timescan.S
	@grep -E "GOODTRAP|ABORT|SELF_TEST_FAIL" $(OUT)/summary.tsv || true

clean:
	rm -rf $(OUT)
