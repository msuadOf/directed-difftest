.option norvc
.section .text.init
.globl _start
_start:
    # Enable vector state and arrange for an illegal-instruction trap to resume
    # after the trapping instruction.
    csrr t0, mstatus
    li t1, 0x600
    or t0, t0, t1
    csrw mstatus, t0
    la t0, trap_handler
    csrw mtvec, t0

    # AVL=4, SEW=32, LMUL=1, tail/mask agnostic.
    li t1, 4
    .4byte VSET       # vsetvli zero, t1, e32, m1, ta, ma

    # Keep v3 independent of the instruction expected to trap.  A whole
    # register load avoids a vector-move initialization dependency; only the
    # first e32 element is 0x55, so vmv.x.s must return zero-extended 0x55.
    la t0, vector_initial_v3
    .4byte 0x0282e187 # vl1re32.v v3, (t0)

    li t0, VSTART
    .4byte 0x00829073 # csrw vstart, t0
    .4byte VEC_OP     # vadd.vv v4, v0, v1 (or vsadd.vi v4, v0, 1)

    .4byte 0x42302557 # vmv.x.s a0, v3
    li t0, 0x55
    bne a0, t0, fail
    .4byte 0x0000006b # XiangShan DiffTest GOODTRAP

fail:
    j fail

trap_handler:
    csrr t0, mcause
    li t1, 2
    bne t0, t1, fail
    csrr t0, mepc
    addi t0, t0, 4
    csrw mepc, t0
    # The illegal instruction does not itself clear vstart in NEMU.  Clear it
    # explicitly so the post-trap vector read is architecturally executable.
    .4byte 0x00801073 # csrw vstart, zero
    mret

.section .data
.align 4
vector_initial_v3:
    .word 0x00000055, 0, 0, 0
