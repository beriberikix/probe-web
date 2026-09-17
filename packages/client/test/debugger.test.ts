import { describe, expect, it } from 'vitest';
import { Debugger, registerTable, type DebugSessionLike } from '../src/debugger.ts';
import type * as Wire from '../src/wire';

/** A scripted fake of the session/core surface the Debugger uses; records call order. */
function fakeSession(opts: { coreType?: Wire.WireCoreType; fpu?: boolean; fpCount?: bigint | null } = {}) {
  const calls: string[] = [];
  const onTarget = new Set<bigint>();
  let status: Wire.WireCoreStatus = 'Running';
  const regs = new Map<number, bigint>([[15, 0x1234n], [13, 0x2000_1000n], [0, 7n]]);
  const session: DebugSessionLike = {
    targetMetadata: async () => ({ target_name: 't', default_format: null, cores: [{ index: 0, core_type: opts.coreType ?? 'Armv8m' }], memory_map: [], flash_sectors: [] }),
    raw: {
      clearCoreDebugState: async () => { calls.push('clear'); },
      step: async () => { calls.push('step'); status = { Halted: 'Step' }; return { status, program_counter: 0x1238n, warning: null }; },
      loadDebugInfo: async () => { calls.push('loadDebugInfo'); },
      loadSvd: async () => {},
      clearSvd: async () => {},
      richStackTrace: async () => {
        calls.push('richStackTrace');
        return { cores: [{ core: 0, frames: [{ id: 5, function_name: 'leaf', program_counter: { U32: 0x1234 }, is_inlined: false, location: { file: '/b/src/main.rs', line: 9n, column: null }, frame_base: null, canonical_frame_address: null, registers: [] }] }] };
      },
      scopes: async () => [{ name: 'Variables', presentation_hint: null, variables_reference: 11n, expensive: false, line: null, column: null }],
      variables: async (_c: number, ref: number) => { calls.push(`variables ${ref}`); return ref === 11 ? [{ name: 'x', evaluate_name: null, memory_reference: null, indexed_variables: null, named_variables: null, type_: 'u32', value: '3', variables_reference: 0n }] : []; },
      evaluate: async () => ({ result: '3', type_: 'u32', variables_reference: 0n, named_variables: null, indexed_variables: null, memory_reference: null }),
      resolveSourceBreakpoints: async (locs: { path: string; line: bigint }[]) =>
        locs.map((l) => (l.line === 99n
          ? { breakpoint: null, error: 'no code' }
          : { breakpoint: { address: 0x1000n + l.line, source_location: { path: '/b/' + l.path, line: l.line, column: 'LeftEdge', address: 0x1000n + l.line } }, error: null })),
      resolveSourceLocations: async (a: BigUint64Array) => Array.from(a, () => null),
      disassemble: async () => [],
      setVariable: async (_c: number, parent: bigint, name: string, value: string) => { calls.push(`set ${parent} ${name}=${value}`); return { value, type_: 'u32', variables_reference: 0n, named_variables: null, indexed_variables: null, memory_reference: null }; },
    },
    core: () => ({
      raw: {
        status: async () => { calls.push('status'); return status; },
        halt: async () => { calls.push('halt'); status = { Halted: 'Request' }; return { pc: 0x1234n }; },
        run: async () => { calls.push('run'); status = 'Running'; },
        reset: async () => { calls.push('reset'); },
        resetAndHalt: async () => { calls.push('resetAndHalt'); status = { Halted: 'Request' }; return { pc: 0x100n }; },
        metadata: async () => ({ fpu_support: opts.fpu ?? false, floating_point_register_count: opts.fpCount ?? null, instruction_set: 'Thumb2' }),
        readRegisters: async (ids: Uint16Array) =>
          Array.from(ids, (id) => ({ id, result: regs.has(id) ? { Ok: { U32: Number(regs.get(id)) } } : { Err: 'no such register' } })),
        writeRegister: async (id: number, value: Wire.WireRegisterValue) => { calls.push(`write ${id}`); regs.set(id, BigInt('U32' in value ? value.U32 : 0)); },
        readBytes: async (_a: bigint, n: number) => new Uint8Array(n),
        writeMemory8: async () => {},
        enableVectorCatch: async () => {},
        setHwBreakpoints: async (a: BigUint64Array) => Array.from(a, (addr) => {
          if (onTarget.size >= 2) return { Err: 'No available hardware breakpoints' };
          onTarget.add(addr);
          calls.push(`set ${addr.toString(16)}`);
          return { Ok: null };
        }),
        clearHwBreakpoints: async (a: BigUint64Array) => { for (const addr of a) { onTarget.delete(addr); calls.push(`clear ${addr.toString(16)}`); } },
      },
    }),
  };
  return { session, calls, onTarget, setStatus: (s: Wire.WireCoreStatus) => { status = s; } };
}

const events = (d: Debugger) => {
  const seen: string[] = [];
  for (const t of ['stopped', 'continued']) d.addEventListener(t, (e) => seen.push(t + (t === 'stopped' ? ':' + JSON.stringify((e as CustomEvent).detail.reason) : '')));
  return seen;
};

describe('Debugger', () => {
  it('turns status polling into stopped/continued transitions', async () => {
    const f = fakeSession();
    const d = new Debugger(f.session);
    const seen = events(d);
    await d.refresh();
    await d.refresh(); // no change, no event
    f.setStatus({ Halted: { Breakpoint: 'Hardware' } });
    await d.refresh();
    expect(d.lastStop?.pc).toBe(0x1234n);
    f.setStatus('Running');
    await d.refresh();
    expect(seen).toEqual(['continued', 'stopped:{"Breakpoint":"Hardware"}', 'continued']);
  });

  it('clears server debug state before resuming or stepping, and bumps the epoch', async () => {
    const f = fakeSession();
    const d = new Debugger(f.session);
    const seen = events(d);
    await d.pause();
    await d.step('over');
    await d.continue();
    expect(f.calls.filter((c) => c !== 'status')).toEqual(['halt', 'clear', 'step', 'clear', 'run']);
    expect(d.epoch).toBe(2);
    expect(seen).toEqual(['stopped:"Request"', 'stopped:"Step"', 'continued']);
  });

  it('serialises concurrent calls in submission order', async () => {
    const f = fakeSession();
    const d = new Debugger(f.session);
    await Promise.all([d.pause(), d.continue(), d.pause()]);
    expect(f.calls).toEqual(['halt', 'clear', 'run', 'halt']);
  });

  it('reads registers by table, dropping ones the core lacks, and writes by name', async () => {
    const f = fakeSession();
    const d = new Debugger(f.session);
    const values = await d.readRegisters();
    expect(values.map((v) => [v.info.name, v.value])).toEqual([['R0', 7n], ['R13', 0x2000_1000n], ['R15', 0x1234n]]);
    await d.writeRegister('r0', 42n);
    expect(f.calls).toContain('write 0');
    expect((await d.readRegisters()).find((v) => v.info.name === 'R0')?.value).toBe(42n);
    await expect(d.writeRegister('nope', 1n)).rejects.toMatchObject({ kind: 'unknown-register' });
  });

  it('limits floating-point registers to the count the core reports', async () => {
    const f = fakeSession({ fpu: true, fpCount: 4n });
    const d = new Debugger(f.session);
    const table = await d.registerTable();
    expect(table.filter((r) => r.roles.includes('FloatingPoint')).map((r) => r.name)).toEqual(['S0', 'S1', 'S2', 'S3']);
    expect(registerTable('Armv6m', true).some((r) => r.float)).toBe(false);
  });

  it('needs debug info, takes one stack trace per stop, and refuses stale handles', async () => {
    const f = fakeSession();
    const d = new Debugger(f.session);
    await d.pause();
    await expect(d.scopes(5)).rejects.toMatchObject({ kind: 'no-debug-info' });
    await d.loadDebugInfo(new Uint8Array([1]));
    const frames = await d.stackTrace();
    expect(frames[0]).toMatchObject({ id: 5, functionName: 'leaf', pc: 0x1234n, source: { path: '/b/src/main.rs', line: 9, column: null } });
    await d.stackTrace();
    expect(f.calls.filter((c) => c === 'richStackTrace')).toHaveLength(1);
    const [scope] = await d.scopes(5);
    const [x] = await d.variables(scope.reference);
    expect(x).toMatchObject({ name: 'x', value: '3', parent: 11 });
    await d.setVariable(x, '7');
    expect(f.calls).toContain('set 11 x=7');
    await expect(d.variables(999)).rejects.toMatchObject({ kind: 'stale-reference' });
    await d.continue();
    await expect(d.variables(scope.reference)).rejects.toMatchObject({ kind: 'stale-reference' });
    await expect(d.stackTrace()).rejects.toMatchObject({ kind: 'not-halted' });
    await d.pause();
    await expect(d.scopes(5)).resolves.toHaveLength(1); // new stop, fresh stack trace
    expect(f.calls.filter((c) => c === 'richStackTrace')).toHaveLength(2);
  });

  it('tracks hardware breakpoints: replace per file, share addresses, report budget and bad lines', async () => {
    const f = fakeSession();
    const d = new Debugger(f.session);
    await d.loadDebugInfo(new Uint8Array([1]));
    const a = await d.setSourceBreakpoints('src/a.rs', [{ line: 10 }, { line: 99 }]);
    expect(a.map((b) => [b.verified, b.address, b.message])).toEqual([[true, 0x100an, null], [false, null, 'no code']]);
    // Same address from an instruction breakpoint: shared, no second comparator.
    await d.setInstructionBreakpoints([0x100an, 0x2000n]);
    expect([...f.onTarget]).toEqual([0x100an, 0x2000n]);
    // A third address exceeds the fake's two comparators.
    const b = await d.setSourceBreakpoints('src/b.rs', [{ line: 20 }]);
    expect(b[0]).toMatchObject({ verified: false, message: 'No available hardware breakpoints' });
    // Removing a.rs keeps 0x100a (still used by the instruction breakpoint).
    await d.setSourceBreakpoints('src/a.rs', []);
    expect(f.onTarget.has(0x100an)).toBe(true);
    await d.setInstructionBreakpoints([]);
    expect(f.onTarget.size).toBe(0);
    // Stops at a breakpoint name it.
    const [c] = await d.setSourceBreakpoints('src/c.rs', [{ line: 5 }]);
    f.setStatus({ Halted: { Breakpoint: 'Hardware' } });
    await d.refresh();
    expect(d.lastStop?.breakpoints).toEqual([]); // pc 0x1234 (from the fake) is not 0x1005
    await d.clearBreakpoints();
    expect(f.onTarget.size).toBe(0);
    expect(d.breakpoints()).toEqual([]);
    expect(c.address).toBe(0x1005n);
  });

  it('arms breakpoints again after a reset (targets that clear comparators on reset)', async () => {
    const f = fakeSession();
    const d = new Debugger(f.session);
    await d.loadDebugInfo(new Uint8Array([1]));
    await d.setSourceBreakpoints('src/a.rs', [{ line: 10 }]);
    await d.setInstructionBreakpoints([0x2000n]);
    const lose = () => f.onTarget.clear(); // what the MCX family and the ESP32-S3 do on reset

    lose();
    const stop = await d.resetAndHalt();
    expect(stop.reason).toEqual('Request');
    expect([...f.onTarget].sort()).toEqual([0x100an, 0x2000n]);
    expect(d.breakpoints().every((b) => b.verified)).toBe(true);

    // reset(): halts through the reset, arms, then runs, so the firmware cannot pass a breakpoint first.
    lose();
    f.calls.length = 0;
    await d.reset();
    expect([...f.onTarget].sort()).toEqual([0x100an, 0x2000n]);
    const order = f.calls.filter((c) => /^(resetAndHalt|reset|run|set )/.test(c));
    expect(order[0]).toBe('resetAndHalt');
    expect(order.at(-1)).toBe('run');
    expect(order.filter((c) => c.startsWith('set '))).toHaveLength(2);

    // Without breakpoints a reset is a plain reset.
    await d.clearBreakpoints();
    f.calls.length = 0;
    await d.reset();
    expect(f.calls.filter((c) => /^(resetAndHalt|reset|run)$/.test(c))).toEqual(['reset']);
  });

  it('lifts its own hardware breakpoint at the PC for a statement step, and not for an instruction step', async () => {
    const f = fakeSession();
    const d = new Debugger(f.session);
    await d.loadDebugInfo(new Uint8Array([1]));
    await d.setInstructionBreakpoints([0x1234n]);
    await d.pause(); // pc 0x1234 in the fake
    f.calls.length = 0;
    await d.step('out');
    expect(f.calls.filter((c) => c !== 'status')).toEqual(['clear', 'clear 1234', 'step', 'set 1234']);
    expect(f.onTarget.has(0x1234n)).toBe(true);
    f.calls.length = 0;
    await d.setInstructionBreakpoints([0x1238n]); // the fake's step lands on 0x1238
    f.calls.length = 0;
    await d.step('instruction');
    expect(f.calls.filter((c) => c !== 'status')).toEqual(['clear', 'step']);
  });

  it('polls RTT while running and services semihosting halts as output', async () => {
    const f = fakeSession();
    // First poll: an error; second: an empty channel list (freshly flashed, RAM holds no control
    // block yet); from the third on the firmware has set it up.
    let queries = 0;
    const polled: string[] = [];
    const raw = f.session.raw as Record<string, unknown>;
    raw.rttChannels = async () => {
      queries++;
      if (queries === 1) throw new Error('control block not found');
      if (queries === 2) return { up: [], down: [] };
      return { up: [{ number: 0, name: 'Terminal' }], down: [] };
    };
    raw.pollRtt = async (ch: Uint32Array) => { polled.push(Array.from(ch).join(',')); return [{ kind: 'text', channel: 0, text: 'n=1 result=3\n' }]; };
    (f.session as { createRttClient?: unknown }).createRttClient = async () => ({});
    const core = f.session.core(0).raw as Record<string, unknown>;
    let semihosting = false;
    const origStatus = core.status as () => Promise<unknown>;
    core.status = async () => (semihosting ? { Halted: { Breakpoint: { Semihosting: 'Other' } } } : origStatus());
    core.handleSemihosting = async () => { semihosting = false; return { status: 'Running', events: [{ LogToConsole: 'hello from semihosting' }] }; };
    f.session.core = () => ({ raw: core }) as never;

    const d = new Debugger(f.session);
    const outputs: string[] = [];
    const stops: unknown[] = [];
    d.addEventListener('output', (e) => { const o = (e as CustomEvent).detail; outputs.push(`${o.source}:${o.text}`); });
    d.addEventListener('stopped', (e) => stops.push((e as CustomEvent).detail));
    await d.enableRtt();
    await d.pollRtt(); // not attached yet: nothing
    await d.pollRtt(); // no channels yet: nothing, and not remembered
    expect(polled).toEqual([]);
    await d.pollRtt();
    expect(polled).toEqual(['0']);
    semihosting = true;
    await d.refresh();
    expect(outputs).toEqual(['rtt:n=1 result=3\n', 'semihosting:hello from semihosting\n']);
    expect(stops).toEqual([]); // a serviced semihosting call is not a stop
    expect(d.state).toBe('running');
  });
});
