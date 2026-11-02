/** `stephen doctor` lines for Stephen Helper (push-to-talk, Esc, "is the Mac playing sound"). */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRun, type RunFn } from '../zen-launcher.js';
import { type HelperHello, probeHelper } from './client.js';
import { XCODE_TOOLS_FIX, findSwiftCompiler } from './install.js';
import { HELPER_APP_NAME, HELPER_EXECUTABLE, helperAppPath, helperLogPath, helperSocketPath } from './paths.js';

/** Same shape as doctor's Check in cli.ts. */
export interface HelperCheck {
  ok: boolean;
  label: string;
  detail?: string;
  fix?: string;
  info?: boolean;
}

export interface HelperDoctorDeps {
  platform: NodeJS.Platform;
  appPath: string;
  exists: (p: string) => boolean;
  run: RunFn;
  probe: (socketPath: string) => Promise<{ running: true; hello: HelperHello } | { running: false; reason: string }>;
}

export function defaultHelperDoctorDeps(): HelperDoctorDeps {
  return { platform: process.platform, appPath: helperAppPath(), exists: existsSync, run: defaultRun, probe: (s) => probeHelper(s) };
}

export async function helperDoctorChecks(stephenHome: string, deps: HelperDoctorDeps = defaultHelperDoctorDeps()): Promise<HelperCheck[]> {
  if (deps.platform !== 'darwin') {
    return [{ ok: true, info: true, label: `${HELPER_APP_NAME} (push-to-talk)`, detail: 'macOS only' }];
  }
  const checks: HelperCheck[] = [];
  const installed = deps.exists(join(deps.appPath, 'Contents', 'MacOS', HELPER_EXECUTABLE));
  checks.push({
    ok: installed,
    label: `${HELPER_APP_NAME} installed (push-to-talk: hold F5 or Fn+Option)`,
    detail: installed ? deps.appPath : `not found at ${deps.appPath}`,
    fix: 'Run `stephen install-helper` (builds it with Xcode\'s Swift compiler).',
  });

  const swift = await findSwiftCompiler(deps.run);
  checks.push({
    ok: swift.ok,
    label: 'Xcode command line tools (Swift compiler, to build the helper)',
    detail: swift.ok ? `${swift.compiler.swiftc} (via ${swift.compiler.via})` : swift.reason,
    fix: XCODE_TOOLS_FIX,
    ...(installed && !swift.ok ? { info: true } : {}),
  });

  if (!installed) return checks;
  const sock = helperSocketPath(stephenHome);
  const probe = deps.exists(sock) ? await deps.probe(sock) : ({ running: false, reason: 'no socket' } as const);
  if (!probe.running) {
    checks.push({
      ok: true,
      info: true,
      label: `${HELPER_APP_NAME} running`,
      detail: `no (${probe.reason}) — \`stephen listen\` starts it; Input Monitoring can only be checked while it runs`,
    });
    return checks;
  }
  checks.push({ ok: true, label: `${HELPER_APP_NAME} running`, detail: `protocol ${probe.hello.version}, ${sock}` });
  checks.push({
    ok: probe.hello.inputMonitoring,
    label: 'Input Monitoring granted to Stephen Helper',
    detail: probe.hello.inputMonitoring ? 'yes' : 'no — F5, Fn+Option and Esc do nothing',
    fix:
      'System Settings › Privacy & Security › Input Monitoring → turn on "Stephen Helper" (or use its menu-bar item → ' +
      `"Open Settings…"). After a rebuild, remove it (−) and add it again. Log: ${helperLogPath(stephenHome)}`,
  });
  return checks;
}
