/**
 * The Stephen window's control actions (ROADMAP P2), run by `stephen listen` for app.sock requests:
 *  - phone.on / phone.off: the same runPhoneCli as `stephen phone on|off` (src/phone/cli.ts), in this process, so the
 *    lock-down check, the sign-in check, the "already on" refusal and the kill switch marker behave exactly as in
 *    Terminal. Remote Control's output goes to this listener's log.
 *  - zen.open: `stephen zen-launch` (what the "Zen for Stephen" app runs).
 *  - doctor.run: `stephen doctor --json`.
 * Plus `<home>/run/launch.json`: how Stephen Helper starts `stephen listen` (node, cli.js, PATH) without a Terminal.
 *
 * Owner-only: reached from app.sock (same-user socket, 0600), never from Claude (boundary test: src/app is not
 * Claude-reachable).
 */
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writePrivateJsonFileSync } from '../lib/fs.js';
import type { PhoneCliEnv } from '../phone/cli.js';
import { phoneFolderTrusted, readPhoneMarker } from '../phone/setup.js';
import { clean } from '../safety/text.js';

/** Lines kept from a phone command's output (each cleaned, at most LINE_MAX characters). */
export const CONTROL_MAX_LINES = 40;
const LINE_MAX = 300;
export const PHONE_UNTRUSTED =
  "The phone folder isn't trusted yet. Run `stephen phone on` once in Terminal (type y to trust the folder), then `stephen phone off`, then turn it on here.";
/** zen-launch and doctor are killed after this long. */
export const CONTROL_RUN_TIMEOUT_MS = 90_000;

export interface PhoneResult {
  /** The phone link is on (this listener's `phone on` started Remote Control). */
  on: boolean;
  /** What `stephen phone on|off` printed (lock-down check, refusals). */
  lines: string[];
}
export interface DoctorCheck {
  ok: boolean;
  label: string;
  detail?: string;
  fix?: string;
  blocking?: boolean;
  info?: boolean;
}
export interface DoctorResult {
  checks: DoctorCheck[];
  problems: number;
  blocking: number;
}
export interface ZenResult {
  ok: boolean;
  message: string;
}

/** R7: the plain sentence for a failed zen.open. The launcher's own output goes to the log only. */
export const ZEN_OPEN_FAILED = "Couldn't open Zen for Stephen. If Zen is already open, quit it, then try again.";

/** What AppServer calls for phone.on, phone.off, zen.open and doctor.run. */
export interface AppControl {
  phoneOn(): Promise<PhoneResult>;
  phoneOff(): Promise<PhoneResult>;
  openZen(): Promise<ZenResult>;
  doctor(): Promise<DoctorResult>;
}

export type RunCli = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface AppControlOptions {
  home: string;
  /** dist/cli.js of this install. */
  cliPath: string;
  /** Runs `stephen <args>` (tests: a fake). */
  run?: RunCli;
  /** runPhoneCli (tests: a fake). */
  phone?: (argv: string[], e: PhoneCliEnv) => Promise<number>;
  /** This process's pid: the phone marker's `pid` once our `phone on` started Remote Control. */
  pid?: number;
  log?: (line: string) => void;
}

/** `node <cli> <args>` as a child, output captured, killed after CONTROL_RUN_TIMEOUT_MS. */
export function cliRunner(cliPath: string): RunCli {
  return (args) =>
    new Promise((resolve) => {
      execFile(process.execPath, [cliPath, ...args], { timeout: CONTROL_RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (e, stdout, stderr) => {
        const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? ((e as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}

const keep = (lines: string[]) => lines.slice(-CONTROL_MAX_LINES).map((l) => clean(l, LINE_MAX));

export function appControl(o: AppControlOptions): AppControl {
  const run = o.run ?? cliRunner(o.cliPath);
  const phone = o.phone ?? (async (argv, e) => (await import('../phone/cli.js')).runPhoneCli(argv, e));
  const pid = o.pid ?? process.pid;
  const log = o.log ?? (() => undefined);
  let turningOn = false;

  return {
    async phoneOn() {
      if (turningOn) throw new Error('The phone link is already turning on.');
      // R9-13: Remote Control gets this listener's stdio, so its first-run trust prompt can't be answered from here.
      if (phoneFolderTrusted(o.home) === false) return { on: false, lines: [PHONE_UNTRUSTED] };
      turningOn = true;
      try {
        return await new Promise<PhoneResult>((resolve) => {
          const lines: string[] = [];
          // Answer as soon as our `phone on` wrote the kill switch marker (Remote Control started); it keeps running.
          const add = (l: string) => {
            lines.push(l);
            log(`phone: ${l}`);
            if (readPhoneMarker(o.home)?.pid === pid) resolve({ on: true, lines: keep(lines) });
          };
          phone(['on'], { home: o.home, out: add, err: add }).then(
            () => resolve({ on: false, lines: keep(lines) }),
            (e: unknown) => resolve({ on: false, lines: keep([...lines, `Couldn't turn the phone link on: ${(e as Error).message}`]) }),
          );
        });
      } finally {
        turningOn = false;
      }
    },

    async phoneOff() {
      const lines: string[] = [];
      await phone(['off'], { home: o.home, out: (l) => lines.push(l), err: (l) => lines.push(l) });
      return { on: false, lines: keep(lines) };
    },

    async openZen() {
      const r = await run(['zen-launch']);
      const out = clean(`${r.stdout}\n${r.stderr}`.trim(), 2000);
      if (r.code === 0) return { ok: true, message: out };
      log(`zen-launch: exit ${r.code}: ${out}`); // R7: the launcher's raw words go to the log only
      return { ok: false, message: ZEN_OPEN_FAILED };
    },

    async doctor() {
      const r = await run(['doctor', '--json']);
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        throw new Error(`doctor failed: ${clean(r.stderr || r.stdout, 300) || `exit ${r.code}`}`);
      }
      const p = parsed as Partial<DoctorResult>;
      if (!Array.isArray(p.checks)) throw new Error('doctor returned no checks');
      return { checks: p.checks, problems: Number(p.problems) || 0, blocking: Number(p.blocking) || 0 };
    },
  };
}

/** `<home>/run/launch.json` */
export const launchInfoPath = (home: string): string => join(home, 'run', 'launch.json');

/**
 * Record how to start `stephen listen` for Stephen Helper (helper/StephenControl.swift, StephenControl): this node, this
 * install's cli.js and this shell's PATH (so `claude` is found when the helper, started by launchd, runs it). 0600.
 */
export function writeLaunchInfo(home: string, cliPath: string, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(dirname(launchInfoPath(home)), { recursive: true, mode: 0o700 });
  writePrivateJsonFileSync(launchInfoPath(home), { node: process.execPath, cli: cliPath, path: env.PATH ?? '' });
}
