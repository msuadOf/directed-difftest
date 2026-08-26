REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
RUNNER := $(REPO_ROOT)/scripts/run_batch.py
OUT := build

# 预期: ABORT — 同一物理地址双别名: cached 页 sw 0x11223344(已提交),
# NC 页 lwu 读同一物理地址, DUT dirty 行驻留 DCache 未写回、Uncache 直读主存
# 得旧值 0 → 首分歧 a5 different (right=0x11223344 wrong=0x0)
.PHONY: run control clean

run:
	mkdir -p $(OUT)
	ulimit -f 2097152; python3 $(RUNNER) -o $(OUT)/ m_min.S
	@if grep -q "a5 different" $(OUT)/m_min.log; then \
		echo "REPRODUCED: 已提交 store 对 NC 别名 load 不可见(见 $(OUT)/m_min.log)"; \
	else echo "NOT_REPRODUCED"; exit 1; fi

# 对照: store 后先 cbo.flush 逐出 dirty 行, NC 读回新值 → GOODTRAP(证明缺逐出/侦听)
control:
	mkdir -p $(OUT)
	ulimit -f 2097152; python3 $(RUNNER) --march rv64gcv_zicbom -o $(OUT)/ cbo_flush.S
	@grep -E "GOODTRAP|ABORT|SELF_TEST_FAIL" $(OUT)/summary.tsv || true

clean:
	rm -rf $(OUT)
