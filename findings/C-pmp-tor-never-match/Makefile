REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
RUNNER := $(REPO_ROOT)/scripts/run_batch.py
OUT := build

# 预期: SELF_TEST_FAIL — 用例自检断言 "S-mode load 打进 TOR deny 区必须 trap",
# DUT 因 TOR 条目从不匹配而放行, CHECK 失败停在 FAIL 自环(看门狗认证, 无歧义)。
.PHONY: run control clean

run:
	mkdir -p $(OUT)
	ulimit -f 2097152; python3 $(RUNNER) -o $(OUT)/ f_s_tor_midregion_load.S
	@if grep -q "SELF_TEST_FAIL" $(OUT)/summary.tsv; then \
		echo "REPRODUCED: TOR deny 区 load DUT 放行(自检 FAIL, 见 $(OUT)/)"; \
	else \
		echo "NOT_REPRODUCED — 检查 $(OUT)/summary.tsv"; exit 1; \
	fi

# 对照: NAPOT 同构造 deny, DUT 正常 trap -> 用例按预期 GOODTRAP(证明失效是 TOR 特有)
control:
	mkdir -p $(OUT)
	ulimit -f 2097152; python3 $(RUNNER) -o $(OUT)/ c_prio_napot_e0_allow_e1_deny_s_load.S
	@grep -E "GOODTRAP|SELF_TEST_FAIL|ABORT" $(OUT)/summary.tsv || true

clean:
	rm -rf $(OUT)
