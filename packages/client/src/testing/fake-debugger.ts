/**
 * A scripted stand-in for `Debugger`, for UI and adapter tests without hardware.
 * It models a tiny program: `main → step_a → step_b` with locals, statics and
 * registers, run/pause/step transitions and breakpoints. Every mutating call is
 * recorded in `calls`.
 */
import type {
  Breakpoint, Evaluation, Frame, Instruction, RegisterInfo, RegisterValue, RunState, Scope, SourceLocation, SteppingMode, StoppedDetail, Variable,
} from '../debugger.ts';
import type * as Wire from '../wire.ts';

const SRC = '/build/fw/src/main.rs';
const REGS: RegisterInfo[] = [
  ...Array.from({ length: 13 }, (_, i) => ({ id: i, name: `R${i}`, bits: 32, float: false, roles: [] as string[] })),
  { id: 13, name: 'R13', bits: 32, float: false, roles: ['StackPointer'] },
  { id: 14, name: 'R14', bits: 32, float: false, roles: ['ReturnAddress'] },
  { id: 15, name: 'R15', bits: 32, float: false, roles: ['ProgramCounter'] },
  { id: 16, name: 'XPSR', bits: 32, float: false, roles: ['ProcessorStatus'] },
  { id: 64, name: 'S0', bits: 32, float: true, roles: ['FloatingPoint'] },
];

export class FakeDebugger extends EventTarget {
  state: RunState = 'halted';
  lastStop: StoppedDetail | null = { reason: { Breakpoint: 'Hardware' }, pc: 0x978n, breakpoints: [] };
  epoch = 0;
  readonly calls: string[] = [];
  /** Program state the fake exposes. */
  n = 2;
  counter = 1;
  line = 40;
  registers = new Map<number, bigint>(REGS.map((r) => [r.id, BigInt(r.id)]));
  private bps: Breakpoint[] = [];
  private refs = new Map<number, Variable[]>();
  private nextRef = 100;

  constructor() {
    super();
    this.registers.set(15, 0x978n);
    this.registers.set(13, 0x2000_5fc8n);
    this.registers.set(16, 0x2100_0000n);
  }

  private emit(type: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private halt(reason: Wire.WireHaltReason, pc: bigint) {
    this.state = 'halted';
    this.registers.set(15, pc);
    this.lastStop = { reason, pc, breakpoints: this.bps.filter((b) => b.address === pc).map((b) => b.id) };
    this.emit('state', 'halted');
    this.emit('stopped', this.lastStop);
  }

  private resume() {
    this.epoch++;
    this.refs.clear();
    this.state = 'running';
    this.lastStop = null;
    this.emit('state', 'running');
    this.emit('continued');
  }

  private need(halted = true) {
    if (halted && this.state !== 'halted') throw Object.assign(new Error('needs a halted core'), { kind: 'not-halted' });
  }

  start() {}
  dispose() {}
  async refresh() { return this.state; }
  async continue() { this.calls.push('continue'); this.resume(); }
  async pause() { this.calls.push('pause'); this.halt('Request', 0x900n); return this.lastStop!; }
  async step(mode: SteppingMode) {
    this.calls.push(`step ${mode}`);
    this.need();
    this.epoch++;
    this.refs.clear();
    this.line += 1;
    const pc = (this.registers.get(15) ?? 0n) + 2n;
    this.halt('Step', pc);
    return { pc, warning: null };
  }
  async reset() { this.calls.push('reset'); this.resume(); }
  async resetAndHalt() { this.calls.push('resetAndHalt'); this.epoch++; this.halt('Request', 0x7c0n); return this.lastStop!; }
  async enableVectorCatch(c: Wire.WireVectorCatchCondition) { this.calls.push(`catch ${c}`); }

  /** Simulate the firmware hitting a breakpoint (or any halt) while running. */
  hit(pc = 0x978n) {
    this.n += 1;
    this.counter += 1;
    this.line = 40;
    this.halt({ Breakpoint: 'Hardware' }, pc);
  }

  async registerTable() { return REGS; }
  async readRegisters(): Promise<RegisterValue[]> {
    this.need();
    return REGS.map((info) => ({ info, value: this.registers.get(info.id) ?? 0n }));
  }
  async writeRegister(register: string | number, value: bigint) {
    this.need();
    const info = REGS.find((r) => r.id === register || r.name === register);
    if (!info) throw Object.assign(new Error(`unknown register ${register}`), { kind: 'unknown-register' });
    this.calls.push(`writeRegister ${info.name}=${value.toString(16)}`);
    this.registers.set(info.id, value);
  }
  async readMemory(address: number | bigint, count: number) { return Uint8Array.from({ length: count }, (_, i) => (Number(address) + i) & 0xff); }
  async writeMemory(address: number | bigint, data: Uint8Array) { this.calls.push(`writeMemory ${address.toString(16)} ${data.length}`); }

  async loadDebugInfo() { this.calls.push('loadDebugInfo'); }
  svdLoaded = false;
  async loadSvd() { this.calls.push('loadSvd'); this.svdLoaded = true; }
  async clearSvd() {}

  async stackTrace(): Promise<Frame[]> {
    this.need();
    const loc = (line: number): SourceLocation => ({ path: SRC, line, column: 1 });
    return [
      { id: 1, functionName: 'i32::wrapping_mul', pc: this.registers.get(15)!, inlined: true, source: { path: '/rustc/core/src/num/mod.rs', line: 2261, column: 5 }, epoch: this.epoch },
      { id: 2, functionName: 'step_b', pc: this.registers.get(15)!, inlined: false, source: loc(this.line), epoch: this.epoch },
      { id: 4, functionName: 'step_a', pc: 0x96cn, inlined: false, source: loc(57), epoch: this.epoch },
      { id: 6, functionName: 'main', pc: 0x8den, inlined: false, source: loc(71), epoch: this.epoch },
    ];
  }

  private makeRef(children: Omit<Variable, 'parent'>[]): number {
    const ref = this.nextRef++;
    this.refs.set(ref, children.map((c) => ({ ...c, parent: ref })));
    return ref;
  }

  private v(name: string, value: string, type: string, reference = 0): Omit<Variable, 'parent'> {
    return { name, value, type, reference, evaluateName: name, memoryReference: null, namedChildren: null, indexedChildren: null };
  }

  async scopes(frameId: number): Promise<Scope[]> {
    this.need();
    const locals = frameId === 6
      ? [this.v('n', String(this.n), 'u32')]
      : frameId === 2
        ? [
            this.v('point', 'Point @ <composite value>', 'cm33_debug::Point', this.makeRef([this.v('x', String(this.n), 'i32'), this.v('y', String(2 * this.n), 'i32')])),
            this.v('mode', 'Mode @ <composite value>', 'cm33_debug::Mode', this.makeRef([this.v('Counting', 'Counting', 'cm33_debug::Counting')])),
          ]
        : [];
    const statics = this.makeRef([
      this.v('cm33_debug', '', 'namespace', this.makeRef([
        this.v('COUNTER', String(this.counter), 'u32'),
        this.v('TABLE', '[u16; 4] = [4369, 8738, 13107, 17476]', '[u16; 4]', this.makeRef([0, 1, 2, 3].map((i) => this.v(`__${i}`, String(0x1111 * (i + 1)), 'u16')))),
      ])),
    ]);
    const peripherals: Scope[] = this.svdLoaded
      ? [{ name: 'Peripherals', expensive: true, hint: 'peripherals', reference: this.makeRef([
          this.v('SCB', '', 'System Control Block', this.makeRef([
            this.v('SCB.CPUID', '0x411FD210', 'CPUID Base Register', this.makeRef([
              this.v('SCB.CPUID.IMPLEMENTER', '01000001 @ 0xE000ED00:24..32', 'IMPLEMENTER'),
            ])),
          ])),
          this.v('GPIO0', '', 'General-purpose I/O', this.makeRef([])),
        ]) }]
      : [];
    return [
      { name: 'Static', reference: statics, expensive: true, hint: 'statics' },
      ...peripherals,
      { name: 'Registers', reference: this.makeRef(REGS.slice(0, 4).map((r) => this.v(r.name, '0x' + (this.registers.get(r.id) ?? 0n).toString(16), 'Platform Register'))), expensive: false, hint: 'registers' },
      { name: 'Variables', reference: this.makeRef(locals), expensive: false, hint: 'locals' },
    ];
  }

  async variables(reference: number): Promise<Variable[]> {
    this.need();
    const vars = this.refs.get(reference);
    if (!vars) throw Object.assign(new Error(`variables reference ${reference} is not from the current stop`), { kind: 'stale-reference' });
    return vars;
  }

  async evaluate(expression: string): Promise<Evaluation> {
    this.need();
    if (expression === 'COUNTER') return { value: String(this.counter), type: 'u32', reference: 0, memoryReference: '0x20000000' };
    const reg = REGS.find((r) => r.name === expression);
    if (reg) return { value: '0x' + (this.registers.get(reg.id) ?? 0n).toString(16).padStart(8, '0'), type: 'Platform Register', reference: 0, memoryReference: null };
    return { value: `<invalid expression "${expression}">`, type: null, reference: 0, memoryReference: null };
  }

  async setVariable(variable: Pick<Variable, 'name' | 'parent'>, value: string): Promise<Evaluation> {
    this.need();
    this.calls.push(`setVariable ${variable.name}=${value}`);
    if (variable.name === 'COUNTER') this.counter = Number(value);
    if (variable.name === 'n') this.n = Number(value);
    return { value, type: null, reference: 0, memoryReference: null };
  }

  // Breakpoints, source and disassembly (used from slice 5 on).
  breakpoints(): Breakpoint[] { return this.bps; }
  async setSourceBreakpoints(path: string, specs: { line: number; column?: number }[]): Promise<Breakpoint[]> {
    this.calls.push(`setSourceBreakpoints ${path} ${specs.map((s) => s.line).join(',')}`);
    this.bps = this.bps.filter((b) => b.kind !== 'source' || b.path !== path);
    const placed = specs.map((s, i): Breakpoint => ({
      id: 1000 + this.bps.length + i, kind: 'source', path, line: s.line, column: s.column ?? null,
      verified: s.line !== 1, address: s.line === 1 ? null : 0x900n + BigInt(s.line * 2),
      source: s.line === 1 ? null : { path: SRC, line: s.line, column: 1 }, message: s.line === 1 ? 'no code at this location' : null,
    }));
    this.bps.push(...placed);
    this.emit('breakpoints', this.bps);
    return placed;
  }
  async setInstructionBreakpoints(addresses: (number | bigint)[]): Promise<Breakpoint[]> {
    this.calls.push(`setInstructionBreakpoints ${addresses.map((a) => a.toString(16)).join(',')}`);
    this.bps = this.bps.filter((b) => b.kind !== 'instruction');
    const placed = addresses.map((a, i): Breakpoint => ({ id: 2000 + i, kind: 'instruction', path: null, line: null, column: null, verified: true, address: BigInt(a), source: null, message: null }));
    this.bps.push(...placed);
    this.emit('breakpoints', this.bps);
    return placed;
  }
  async clearBreakpoints() { this.calls.push('clearBreakpoints'); this.bps = []; this.emit('breakpoints', []); }
  async reapplyBreakpoints() { return this.bps; }
  async resolveSourceLocations(addresses: (number | bigint)[]) { return addresses.map((a) => ({ path: SRC, line: 30 + (Number(a) % 50), column: 1 })); }
  async disassemble(address: number | bigint, count: number, instructionOffset = 0): Promise<Instruction[]> {
    const start = BigInt(address) + BigInt(instructionOffset * 2);
    return Array.from({ length: count }, (_, i) => ({ address: start + BigInt(2 * i), text: i % 2 ? 'mov r7, sp' : 'push {r7, lr}', bytes: '80b5', source: { path: SRC, line: 54 + i, column: 1 } }));
  }
}
