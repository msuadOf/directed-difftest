REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
# 交叉编译器: 用仓库的特性探测选择(旧 gcc 10.2 不支持 RVV 助记符; 本例用 .4byte 编码, 旧 gcc 也能编)
RISCV_GCC ?= $(shell bash -c "TOOLCHAIN_QUIET=1 source $(REPO_ROOT)/scripts/toolchain.sh && echo \$$CROSS")
EMU ?= $(REPO_ROOT)/xiangshan/build/emu
DIFF ?= $(REPO_ROOT)/xiangshan/ready-to-run/riscv64-nemu-interpreter-so

VSTARTS := 1 2
OPS := vadd vsadd
ELFS := $(foreach op,$(OPS),$(foreach vstart,$(VSTARTS),build/$(op)-vstart$(vstart).elf))
CONTROL_ELFS := build/vmv-only-ta-ma.elf build/vadd-vstart1-tu-mu.elf

.PHONY: all run controls clean

all: $(ELFS)

define rule_template
build/$(1)-vstart$(2).elf: vstart_trap_vmv.S xiangshan.ld | build
	$(RISCV_GCC) -nostdlib -nostartfiles -static -fno-pic -march=rv64gc -mabi=lp64d \
		-DVSET=0x0d037057 -DVSTART=$(2) -DVEC_OP=$(3) -Wl,-T,xiangshan.ld -Wl,-e,_start -o $$@ $$<
endef

$(eval $(call rule_template,vadd,1,0x02008257))
$(eval $(call rule_template,vadd,2,0x02008257))
$(eval $(call rule_template,vsadd,1,0x8600b257))
$(eval $(call rule_template,vsadd,2,0x8600b257))

build:
	mkdir -p $@

run: all
	@set -e; for elf in $(ELFS); do \
		name=$${elf##*/}; name=$${name%.elf}; \
		$(EMU) -i $$elf --diff $(DIFF) -C 5000 --dump-commit-trace >build/$$name.log 2>&1 || true; \
		if grep -Eq 'a0 different.*right = 0x0000000000000055, wrong = 0xffffffff00000055' build/$$name.log; then result=REPRODUCED; else result=NOT_REPRODUCED; fi; \
		printf '%s %s\n' "$$name" "$$result"; \
	done

build/vmv-only-ta-ma.elf: vstart_trap_vmv.S xiangshan.ld | build
	$(RISCV_GCC) -nostdlib -nostartfiles -static -fno-pic -march=rv64gc -mabi=lp64d \
		-DVSET=0x0d037057 -DVSTART=0 -DVEC_OP=0x00000013 -Wl,-T,xiangshan.ld -Wl,-e,_start -o $@ $<

build/vadd-vstart1-tu-mu.elf: vstart_trap_vmv.S xiangshan.ld | build
	$(RISCV_GCC) -nostdlib -nostartfiles -static -fno-pic -march=rv64gc -mabi=lp64d \
		-DVSET=0x01037057 -DVSTART=1 -DVEC_OP=0x02008257 -Wl,-T,xiangshan.ld -Wl,-e,_start -o $@ $<

controls: $(CONTROL_ELFS)
	@$(EMU) -i build/vmv-only-ta-ma.elf --diff $(DIFF) -C 5000 --dump-commit-trace >build/vmv-only-ta-ma.log 2>&1 || true
	@grep -Eq 'a0 different.*right = 0x0000000000000055, wrong = 0xffffffff00000055' build/vmv-only-ta-ma.log
	@printf '%s\n' 'vmv-only-ta-ma REPRODUCED'
	@$(EMU) -i build/vadd-vstart1-tu-mu.elf --diff $(DIFF) -C 5000 --dump-commit-trace >build/vadd-vstart1-tu-mu.log 2>&1
	@grep -q 'HIT GOOD TRAP' build/vadd-vstart1-tu-mu.log
	@printf '%s\n' 'vadd-vstart1-tu-mu GOODTRAP'

clean:
	rm -rf build
