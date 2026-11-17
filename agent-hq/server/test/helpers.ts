import type { RuntimeAdapter, RunSpec, RuntimeEvent, RunHandle } from '../src/runtime/types.ts';

/**
 * Test double for the runtime boundary only (never used by the app).
 * Each start() returns a controllable run; tests decide when it emits and exits.
 */
export class ScriptedAdapter implements RuntimeAdapter {
  readonly name = 'scripted';
  runs: { spec: RunSpec; emit: (e: RuntimeEvent) => void; exit: (code: number | null) => void; stopped: boolean }[] = [];

  start(spec: RunSpec, onEvent: (e: RuntimeEvent) => void): RunHandle {
    let exit!: (c: number | null) => void;
    const done = new Promise<number | null>((r) => (exit = r));
    const run = { spec, emit: onEvent, exit, stopped: false };
    this.runs.push(run);
    return { pid: 1000 + this.runs.length, done, stop: () => { run.stopped = true; exit(null); } };
  }
}

export const tick = () => new Promise((r) => setImmediate(r));
