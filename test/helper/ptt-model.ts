/**
 * Executable specification of the helper's push-to-talk logic (mirrors `PushToTalk` in helper/Core.swift).
 * logic.test.ts runs SCENARIOS against this model; swift.int.test.ts runs the same SCENARIOS against the real
 * Swift code (through test/helper/swift/main.swift) when a Swift toolchain is available.
 */
export interface Mods {
  fn?: boolean;
  opt?: boolean;
  cmd?: boolean;
  ctrl?: boolean;
  shift?: boolean;
}

export type Out = { type: 'ptt_down'; at: number } | { type: 'ptt_up'; at: number; heldMs: number } | { type: 'esc'; at: number };

export class PttModel {
  isDown = false;
  latched = false;
  byF5 = false;
  private downAt = 0;
  constructor(readonly maxHoldMs: number) {}

  static comboActive(m: Mods): boolean {
    return !!m.fn && !!m.opt && !m.cmd && !m.ctrl;
  }

  flags(m: Mods, now: number): Out[] {
    if (this.latched && !(m.fn && m.opt)) this.latched = false;
    if (this.isDown && this.byF5) return [];
    const active = PttModel.comboActive(m);
    if (!this.isDown) {
      if (active && !this.latched) {
        this.isDown = true;
        this.downAt = now;
        return [{ type: 'ptt_down', at: now }];
      }
      return [];
    }
    return active ? [] : this.release(now, !!m.fn && !!m.opt);
  }

  tick(now: number): Out[] {
    return this.isDown && now - this.downAt >= this.maxHoldMs ? this.release(now, true) : [];
  }

  interrupt(now: number): Out[] {
    return this.isDown ? this.release(now, true) : [];
  }

  key(code: number, isRepeat: boolean, now: number): Out[] {
    if (isRepeat) return [];
    if (code === 96) {
      if (this.isDown) return [];
      this.isDown = true;
      this.byF5 = true;
      this.downAt = now;
      return [{ type: 'ptt_down', at: now }];
    }
    if (code !== 53) return [];
    // Esc also ends a press (after the esc): the listener dropped that recording, so the next F5 must not be swallowed.
    return [{ type: 'esc', at: now }, ...(this.isDown ? this.release(now, !this.byF5) : [])];
  }

  keyUp(code: number, now: number): Out[] {
    return code === 96 && this.isDown && this.byF5 ? this.release(now, false) : [];
  }

  private release(now: number, stillHeld: boolean): Out[] {
    this.isDown = false;
    this.byF5 = false;
    this.latched = stillHeld;
    return [{ type: 'ptt_up', at: now, heldMs: Math.max(0, now - this.downAt) }];
  }
}

export type Step =
  | { flags: Mods }
  | { key: number; repeat?: boolean }
  | { keyup: number }
  | { interrupt: true }
  /** Let time pass (the model ticks; the Swift harness really waits — keep these short there). */
  | { wait: number };

export interface Scenario {
  name: string;
  steps: Step[];
  /** Expected event types, in order. */
  expect: Out['type'][];
}

/** Max hold used by the scenarios (the Swift harness is started with --max-hold-ms 400). */
export const SCENARIO_MAX_HOLD_MS = 400;

export const SCENARIOS: Scenario[] = [
  { name: 'Fn then Option, release Option', steps: [{ flags: { fn: true } }, { flags: { fn: true, opt: true } }, { flags: { fn: true } }], expect: ['ptt_down', 'ptt_up'] },
  { name: 'Option then Fn, release Fn', steps: [{ flags: { opt: true } }, { flags: { fn: true, opt: true } }, { flags: { opt: true } }, { flags: {} }], expect: ['ptt_down', 'ptt_up'] },
  { name: 'Fn alone or Option alone does nothing', steps: [{ flags: { fn: true } }, { flags: {} }, { flags: { opt: true } }, { flags: {} }], expect: [] },
  { name: 'Shift is allowed', steps: [{ flags: { fn: true, opt: true, shift: true } }, { flags: { shift: true } }], expect: ['ptt_down', 'ptt_up'] },
  { name: 'Cmd held → ignored', steps: [{ flags: { cmd: true } }, { flags: { cmd: true, fn: true, opt: true } }, { flags: { cmd: true } }], expect: [] },
  { name: 'Ctrl held → ignored', steps: [{ flags: { ctrl: true, fn: true, opt: true } }, { flags: {} }], expect: [] },
  {
    name: 'Cmd added mid-press ends it; releasing Cmd does not restart it',
    steps: [{ flags: { fn: true, opt: true } }, { flags: { fn: true, opt: true, cmd: true } }, { flags: { fn: true, opt: true } }, { flags: { fn: true } }],
    expect: ['ptt_down', 'ptt_up'],
  },
  {
    name: 'after release of one key, pressing it again starts a new press',
    steps: [{ flags: { fn: true, opt: true } }, { flags: { fn: true } }, { flags: { fn: true, opt: true } }, { flags: {} }],
    expect: ['ptt_down', 'ptt_up', 'ptt_down', 'ptt_up'],
  },
  {
    name: 'max hold sends ptt_up; still held does not restart until a key is released',
    steps: [{ flags: { fn: true, opt: true } }, { wait: SCENARIO_MAX_HOLD_MS + 250 }, { flags: { fn: true, opt: true, shift: true } }, { flags: { fn: true } }, { flags: { fn: true, opt: true } }, { flags: {} }],
    expect: ['ptt_down', 'ptt_up', 'ptt_down', 'ptt_up'],
  },
  {
    name: 'tap disabled mid-press sends ptt_up and latches',
    steps: [{ flags: { fn: true, opt: true } }, { interrupt: true }, { flags: { fn: true, opt: true, shift: true } }, { flags: {} }],
    expect: ['ptt_down', 'ptt_up'],
  },
  { name: 'interrupt while idle does nothing', steps: [{ interrupt: true }], expect: [] },
  { name: 'Esc (53) is reported, auto-repeat and other keys are not', steps: [{ key: 53 }, { key: 53, repeat: true }, { key: 0 }, { key: 36 }], expect: ['esc'] },
  { name: 'Esc during a press', steps: [{ flags: { fn: true, opt: true } }, { key: 53 }, { flags: {} }], expect: ['ptt_down', 'esc', 'ptt_up'] },
  // Hold F5 to talk (kVK_F5 = 96).
  { name: 'F5 down/up is one press; auto-repeat ignored', steps: [{ key: 96 }, { key: 96, repeat: true }, { key: 96, repeat: true }, { keyup: 96 }], expect: ['ptt_down', 'ptt_up'] },
  { name: 'Fn+F5 (function keys as media keys): releasing Fn first does not end it', steps: [{ flags: { fn: true } }, { key: 96 }, { flags: {} }, { keyup: 96 }], expect: ['ptt_down', 'ptt_up'] },
  { name: 'F5 key-up with no press, other key-ups: nothing', steps: [{ keyup: 96 }, { keyup: 53 }, { keyup: 0 }], expect: [] },
  { name: 'F5 during a Fn+Option press does nothing extra', steps: [{ flags: { fn: true, opt: true } }, { key: 96 }, { keyup: 96 }, { flags: {} }], expect: ['ptt_down', 'ptt_up'] },
  { name: 'F5 max hold sends ptt_up; repeats while still held do not restart', steps: [{ key: 96 }, { wait: SCENARIO_MAX_HOLD_MS + 250 }, { key: 96, repeat: true }, { keyup: 96 }], expect: ['ptt_down', 'ptt_up'] },
  { name: 'Esc during an F5 press', steps: [{ key: 96 }, { key: 53 }, { keyup: 96 }], expect: ['ptt_down', 'esc', 'ptt_up'] },
  // #86: the window's mic (Ask box, Home's Talk) starts a press through the same F5 key-down (main.swift box.ptt).
  {
    name: 'started from the app, then F5: the F5 release ends it, and the next F5 is a new press',
    steps: [{ key: 96 }, { key: 96 }, { keyup: 96 }, { key: 96 }, { keyup: 96 }],
    expect: ['ptt_down', 'ptt_up', 'ptt_down', 'ptt_up'],
  },
  {
    name: 'started from the app, then Esc, then F5: Esc ends the press, so F5 is not swallowed',
    steps: [{ key: 96 }, { key: 53 }, { key: 96 }, { keyup: 96 }],
    expect: ['ptt_down', 'esc', 'ptt_up', 'ptt_down', 'ptt_up'],
  },
  {
    name: 'Esc during a Fn+Option press latches: still holding the keys does not restart it',
    steps: [{ flags: { fn: true, opt: true } }, { key: 53 }, { flags: { fn: true, opt: true, shift: true } }, { flags: {} }, { flags: { fn: true, opt: true } }, { flags: {} }],
    expect: ['ptt_down', 'esc', 'ptt_up', 'ptt_down', 'ptt_up'],
  },
];

/** Run a scenario against the model with a fake clock (ticks every 10 ms while waiting). */
export function runModel(s: Scenario, maxHoldMs = SCENARIO_MAX_HOLD_MS): Out[] {
  const m = new PttModel(maxHoldMs);
  let now = 1_000;
  const out: Out[] = [];
  for (const step of s.steps) {
    if ('flags' in step) out.push(...m.flags(step.flags, now));
    else if ('key' in step) out.push(...m.key(step.key, !!step.repeat, now));
    else if ('keyup' in step) out.push(...m.keyUp(step.keyup, now));
    else if ('interrupt' in step) out.push(...m.interrupt(now));
    else {
      const end = now + step.wait;
      while (now < end) {
        now += 10;
        out.push(...m.tick(now));
      }
    }
    now += 5;
  }
  return out;
}

/** The harness's stdin line for a step (wait/tick steps are handled by the caller). */
export function harnessLine(step: Exclude<Step, { wait: number }>): string {
  if ('flags' in step) {
    const f = step.flags;
    return ['flags', f.fn && 'fn', f.opt && 'opt', f.cmd && 'cmd', f.ctrl && 'ctrl', f.shift && 'shift'].filter(Boolean).join(' ');
  }
  if ('key' in step) return `key ${step.key}${step.repeat ? ' repeat' : ''}`;
  if ('keyup' in step) return `keyup ${step.keyup}`;
  return 'interrupt';
}
