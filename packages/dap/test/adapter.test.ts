import { describe, expect, it } from 'vitest';
import type { DebugProtocol as DP } from '@vscode/debugprotocol';
import { FakeDebugger } from '@probe-web/client/testing';
import { ProbeDebugAdapter, type DebuggerLike } from '../src/adapter.ts';

/** Minimal DAP client over the inline adapter: request() resolves with the response; events are recorded. */
function harness(fake = new FakeDebugger()) {
  const adapter = new ProbeDebugAdapter({
    connect: async () => ({ debugger: fake as unknown as DebuggerLike, close: () => { fake.calls.push('close'); } }),
    sources: { read: async (p) => (p.endsWith('main.rs') ? 'fn main() {}' : null), resolve: async () => null },
  });
  const events: DP.Event[] = [];
  const pending = new Map<number, (r: DP.Response) => void>();
  const waiters: { event: string; resolve: (e: DP.Event) => void }[] = [];
  adapter.onDidSendMessage((m) => {
    if (m.type === 'response') pending.get((m as DP.Response).request_seq)?.((m as DP.Response));
    if (m.type === 'event') {
      const e = m as DP.Event;
      events.push(e);
      const i = waiters.findIndex((w) => w.event === e.event);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(e);
    }
  });
  let seq = 1;
  const request = <T extends DP.Response>(command: string, args?: unknown) =>
    new Promise<T>((resolve) => {
      const s = seq++;
      pending.set(s, resolve as (r: DP.Response) => void);
      adapter.handleMessage({ seq: s, type: 'request', command, arguments: args } as DP.Request);
    });
  const nextEvent = (event: string) => {
    const seen = events.find((e) => e.event === event && !(e as { _taken?: boolean })._taken);
    if (seen) { (seen as { _taken?: boolean })._taken = true; return Promise.resolve(seen); }
    return new Promise<DP.Event>((resolve) => waiters.push({ event, resolve: (e) => { (e as { _taken?: boolean })._taken = true; resolve(e); } }));
  };
  return { adapter, fake, events, request, nextEvent };
}

describe('ProbeDebugAdapter', () => {
  it('runs a launch session: breakpoints, stop on entry, stack/scopes/variables, step, continue, hit, memory, disassembly', async () => {
    const { fake, request, nextEvent, events } = harness();
    const init = await request<DP.InitializeResponse>('initialize', { adapterID: 'probe-rs', linesStartAt1: true, columnsStartAt1: true });
    expect(init.success).toBe(true);
    expect(init.body).toMatchObject({ supportsConfigurationDoneRequest: true, supportsDisassembleRequest: true, supportsSteppingGranularity: true });

    expect((await request('launch', { stopOnEntry: true })).success).toBe(true);
    await nextEvent('initialized');

    const bps = await request<DP.SetBreakpointsResponse>('setBreakpoints', { source: { path: 'src/main.rs' }, breakpoints: [{ line: 40 }, { line: 1 }] });
    expect(bps.body.breakpoints).toEqual([
      expect.objectContaining({ verified: true, line: 40, instructionReference: '0x00000950' }),
      expect.objectContaining({ verified: false, message: 'no code at this location' }),
    ]);

    await request('configurationDone');
    expect((await nextEvent('stopped')).body).toMatchObject({ reason: 'entry', threadId: 1, allThreadsStopped: true });
    expect(fake.calls).toContain('resetAndHalt');
    // The reset's own halt was not reported separately.
    expect(events.filter((e) => e.event === 'stopped')).toHaveLength(1);

    expect((await request<DP.ThreadsResponse>('threads')).body.threads).toEqual([{ id: 1, name: 'core 0' }]);
    const st = await request<DP.StackTraceResponse>('stackTrace', { threadId: 1, startFrame: 1, levels: 2 });
    expect(st.body.totalFrames).toBe(4);
    expect(st.body.stackFrames.map((f) => [f.name, f.line, f.source?.name])).toEqual([['step_b', 40, 'main.rs'], ['step_a', 57, 'main.rs']]);

    const scopes = await request<DP.ScopesResponse>('scopes', { frameId: 2 });
    const locals = scopes.body.scopes.find((s) => s.presentationHint === 'locals')!;
    const vars = await request<DP.VariablesResponse>('variables', { variablesReference: locals.variablesReference });
    const point = vars.body.variables.find((v) => v.name === 'point')!;
    const kids = await request<DP.VariablesResponse>('variables', { variablesReference: point.variablesReference });
    expect(kids.body.variables.map((v) => `${v.name}=${v.value}`)).toEqual(['x=2', 'y=4']);

    // Register writes route to writeRegister; other variables to setVariable.
    const regScope = scopes.body.scopes.find((s) => s.presentationHint === 'registers')!;
    await request('variables', { variablesReference: regScope.variablesReference });
    const setReg = await request<DP.SetVariableResponse>('setVariable', { variablesReference: regScope.variablesReference, name: 'R1', value: '0x10' });
    expect(setReg.success).toBe(true);
    await request('setVariable', { variablesReference: locals.variablesReference, name: 'n', value: '9' });
    expect(fake.calls).toEqual(expect.arrayContaining(['writeRegister R1=10', 'setVariable n=9']));

    expect((await request<DP.EvaluateResponse>('evaluate', { expression: 'COUNTER', frameId: 2 })).body.result).toBe('1');

    await request('next', { threadId: 1, granularity: 'instruction' });
    expect((await nextEvent('stopped')).body).toMatchObject({ reason: 'step' });
    expect(fake.calls).toContain('step instruction');

    await request('continue', { threadId: 1 });
    await nextEvent('continued');
    fake.hit(0x950n);
    expect((await nextEvent('stopped')).body).toMatchObject({ reason: 'breakpoint', hitBreakpointIds: [bps.body.breakpoints[0].id] });

    const mem = await request<DP.ReadMemoryResponse>('readMemory', { memoryReference: '0x20000030', count: 4 });
    expect(mem.body).toMatchObject({ address: '0x20000030', data: btoa('0123') });
    const wr = await request<DP.WriteMemoryResponse>('writeMemory', { memoryReference: '0x20000000', offset: 4, data: btoa('\x01\x02') });
    expect(wr.body?.bytesWritten).toBe(2);
    expect((await nextEvent('memory')).body).toMatchObject({ memoryReference: '0x20000000', offset: 4, count: 2 });

    const dis = await request<DP.DisassembleResponse>('disassemble', { memoryReference: '0x938', instructionOffset: -1, instructionCount: 3 });
    expect(dis.body!.instructions.map((i) => i.address)).toEqual(['0x00000936', '0x00000938', '0x0000093a']);

    expect((await request<DP.SourceResponse>('source', { source: { path: '/build/fw/src/main.rs' }, sourceReference: 0 })).body.content).toBe('fn main() {}');

    await request('disconnect', { terminateDebuggee: true });
    await nextEvent('terminated');
    expect(fake.calls.at(-1)).toBe('close');
  });

  it('answers errors as failed responses, not exceptions', async () => {
    const { request } = harness();
    const before = await request('stackTrace', { threadId: 1 });
    expect(before).toMatchObject({ success: false, message: expect.stringContaining('launch or attach') });
    expect(await request('flyToTheMoon')).toMatchObject({ success: false, message: 'unsupported request: flyToTheMoon' });
    await request('launch', {});
    await request('configurationDone'); // launches running
    const running = await request('stackTrace', { threadId: 1 });
    expect(running).toMatchObject({ success: false, message: 'the core is running' });
    await request('pause', { threadId: 1 });
    const stale = await request('variables', { variablesReference: 12345 });
    expect(stale).toMatchObject({ success: false, message: expect.stringContaining('not from the current stop') });
  });

  it('attach reports the current stop after configurationDone and does not reset', async () => {
    const { fake, request, nextEvent } = harness();
    await request('initialize', { adapterID: 'probe-rs' });
    await request('attach', {});
    await nextEvent('initialized');
    await request('configurationDone');
    expect((await nextEvent('stopped')).body).toMatchObject({ reason: 'breakpoint' });
    expect(fake.calls).not.toContain('resetAndHalt');
  });
  it('reports Debugger poller errors as stderr output, once per distinct message', async () => {
    const { fake, request, nextEvent, events } = harness();
    await request('initialize', { adapterID: 'probe-rs', linesStartAt1: true, columnsStartAt1: true });
    await request('launch', {});
    await nextEvent('initialized');
    await request('configurationDone');
    const fail = (message: string) => fake.dispatchEvent(new CustomEvent('error', { detail: new Error(message) }));
    fail('No debug state for session');
    fail('No debug state for session');
    fail('probe disconnected');
    const stderr = () => events.filter((e) => e.event === 'output' && (e.body as DP.OutputEvent['body']).category === 'stderr').map((e) => (e.body as DP.OutputEvent['body']).output);
    expect(stderr()).toEqual(['probe-rs: No debug state for session\n', 'probe-rs: probe disconnected\n']);
    // After a stop the same message is reported again.
    fake.hit();
    await nextEvent('stopped');
    fail('probe disconnected');
    expect(stderr()).toHaveLength(3);
  });
  it('announces that disassembly is unavailable on connections without a disassembler', async () => {
    const fake = new FakeDebugger();
    (fake as unknown as { canDisassemble: boolean }).canDisassemble = false;
    const { request, nextEvent } = harness(fake);
    const init = await request<DP.InitializeResponse>('initialize', { adapterID: 'probe-rs' });
    expect(init.body?.supportsDisassembleRequest).toBe(true);
    await request('launch', {});
    const caps = await nextEvent('capabilities');
    expect(caps.body).toEqual({ capabilities: { supportsDisassembleRequest: false } });
    await nextEvent('initialized');
    const dis = await request<DP.DisassembleResponse>('disassemble', { memoryReference: '0x1000', instructionCount: 4 });
    expect(dis.success).toBe(false);
    expect(dis.message).toContain('not available');
  });
});
