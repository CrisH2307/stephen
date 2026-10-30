/**
 * A fake Mac for the desktop tests: in-memory /Applications etc., Info.plists, and a fake execFile that
 * answers plutil / osascript / ioreg / open and records every call. Nothing here spawns a process.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, type UserConfig } from '../../src/config.js';
import type { DesktopDeps, DirEntry } from '../../src/desktop/system.js';
import { plistString } from '../../src/drivers/macos.js';
import { SafetyGate } from '../../src/safety/gate.js';
import { buildServer, type ServerDeps } from '../../src/server/index.js';
import { FakeAudit, FakeConfirmer, FakeManager, makeEngine } from '../server/fakes.js';

export const HOME = '/Users/tester';
export const REPO = '/Users/tester/code/stephen';

export interface ExecCall {
  file: string;
  args: string[];
}

export interface StatusJson {
  frontmost?: { name: string; bundleId: string | null } | null;
  apps?: { name: string; bundleId: string | null }[];
  displays?: number | null;
  locked?: boolean | null;
  secureInput?: boolean | null;
}

export function infoPlist(bundleId: string, extra = '', bundleName?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>app</string>
	${bundleName !== undefined ? `<key>CFBundleName</key>\n\t<string>${bundleName}</string>` : ''}
	${extra}
	<key>CFBundleIdentifier</key>
	<string>${bundleId}</string>
</dict>
</plist>`;
}

export function ioregXml(opts: { locked?: boolean; securePid?: number; onConsole?: boolean }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>IOConsoleLocked</key>
	<false/>
	<key>IOConsoleUsers</key>
	<array>
		<dict>
			<key>kCGSSessionOnConsoleKey</key>
			<${opts.onConsole === false ? 'false' : 'true'}/>
			${opts.locked ? '<key>CGSSessionScreenIsLocked</key>\n\t\t\t<true/>' : ''}
			${opts.securePid ? `<key>kCGSSessionSecureInputPID</key>\n\t\t\t<integer>${opts.securePid}</integer>` : ''}
			<key>kCGSSessionUserNameKey</key>
			<string>tester</string>
		</dict>
	</array>
	<key>IORegistryEntryName</key>
	<string>Root</string>
</dict>
</plist>`;
}

export class FakeMac {
  platform: NodeJS.Platform = 'darwin';
  readonly dirs = new Map<string, DirEntry[]>();
  readonly files = new Map<string, Buffer>();
  /** Bundle ids of apps with a binary Info.plist (only plutil can read them). */
  readonly binaryIds = new Map<string, string>();
  readonly realpaths = new Map<string, string>();
  /** What plutil reports for a plist (the real top-level key), when it differs from the first XML match. */
  readonly plutilIds = new Map<string, string>();
  calls: ExecCall[] = [];
  status: StatusJson = {
    frontmost: { name: 'Finder', bundleId: 'com.apple.finder' },
    apps: [{ name: 'Finder', bundleId: 'com.apple.finder' }],
    displays: 1,
    locked: false,
    secureInput: false,
  };
  /** Raw osascript stdout override. */
  statusRaw: string | null = null;
  osascriptFails = false;
  /** ioreg output; null → ioreg fails. */
  ioreg: string | null = ioregXml({});
  plutilWorks = true;
  /** stderr of a failing `open`, or null. */
  openFails: string | null = null;
  /** .app paths whose `codesign --verify` fails (stderr), e.g. tampered or unsigned bundles. */
  readonly codesignFails = new Map<string, string>();

  constructor() {
    for (const d of ['/Applications', '/System/Applications', '/System/Applications/Utilities', '/Applications/Utilities', `${HOME}/Applications`]) {
      this.dirs.set(d, []);
    }
  }

  /**
   * Adds `<dir>/<name>.app` with an Info.plist. Returns its path. The plist's CFBundleName is the file name
   * unless `bundleName` says otherwise (null = no CFBundleName key).
   */
  addApp(dir: string, name: string, bundleId: string, opts: { binary?: boolean; plist?: string; bundleName?: string | null } = {}): string {
    if (!this.dirs.has(dir)) this.dirs.set(dir, []);
    this.dirs.get(dir)!.push({ name: `${name}.app`, isDir: true });
    const path = join(dir, `${name}.app`);
    const plist = join(path, 'Contents', 'Info.plist');
    if (opts.binary) {
      this.files.set(plist, Buffer.from('bplist00\u0000\u0001binary'));
      this.binaryIds.set(plist, bundleId);
    } else {
      const bundleName = opts.bundleName === null ? undefined : (opts.bundleName ?? name);
      this.files.set(plist, Buffer.from(opts.plist ?? infoPlist(bundleId, '', bundleName)));
    }
    return path;
  }

  /** A plain (vendor) sub-folder of an Applications dir. */
  addFolder(dir: string, name: string): string {
    this.dirs.get(dir)!.push({ name, isDir: true });
    const path = join(dir, name);
    this.dirs.set(path, []);
    return path;
  }

  opens(): string[][] {
    return this.calls.filter((c) => c.file === '/usr/bin/open').map((c) => c.args);
  }

  private exec = async (file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
    this.calls.push({ file, args: [...args] });
    const fail = (stderr: string) => Object.assign(new Error(`Command failed: ${file}`), { stderr, stdout: '', code: 1 });
    switch (file) {
      case '/usr/bin/plutil': {
        if (!this.plutilWorks) throw fail('plutil: not available');
        const plist = args[args.length - 1]!;
        const key = args[1]!;
        if (key === 'CFBundleIdentifier') {
          const bin = this.plutilIds.get(plist) ?? this.binaryIds.get(plist);
          if (bin) return { stdout: `${bin}\n`, stderr: '' };
        }
        const buf = this.files.get(plist);
        const v = buf && !this.binaryIds.has(plist) ? plistString(buf.toString('utf8'), key) : null;
        if (!v) throw fail(`${plist}: Could not extract value`);
        return { stdout: `${v}\n`, stderr: '' };
      }
      case '/usr/bin/codesign': {
        const path = args[args.length - 1]!;
        const err = this.codesignFails.get(path);
        if (err !== undefined) throw fail(err);
        return { stdout: '', stderr: '' };
      }
      case '/usr/bin/osascript':
        if (this.osascriptFails) throw fail('execution error: -2700');
        return { stdout: `${this.statusRaw ?? JSON.stringify(this.status)}\n`, stderr: '' };
      case '/usr/sbin/ioreg':
        if (this.ioreg === null) throw fail('ioreg: failed');
        return { stdout: this.ioreg, stderr: '' };
      case '/usr/bin/open':
        if (this.openFails) throw fail(this.openFails);
        return { stdout: '', stderr: '' };
      default:
        throw fail(`unexpected binary ${file}`);
    }
  };

  deps(): DesktopDeps {
    return {
      platform: this.platform,
      homeDir: HOME,
      repoDir: REPO,
      execFile: (file, args) => this.exec(file, args),
      fs: {
        list: async (dir) => [...(this.dirs.get(dir) ?? [])],
        read: async (p) => this.files.get(p) ?? null,
        realpath: async (p) => this.realpaths.get(p) ?? p,
        isDir: async (p) => this.dirs.has(p) || [...this.files.keys()].some((f) => f.startsWith(`${p}/Contents/`)),
      },
    };
  }
}

/** A Mac with the usual apps installed. */
export function standardMac(): FakeMac {
  const m = new FakeMac();
  m.addApp('/Applications', 'Spotify', 'com.spotify.client');
  m.addApp('/Applications', 'Google Chrome', 'com.google.Chrome');
  m.addApp('/Applications', 'Zen Browser', 'app.zen-browser.zen');
  m.addApp('/Applications', 'Steam', 'com.valvesoftware.steam');
  m.addApp('/Applications', 'iTerm', 'com.googlecode.iterm2');
  m.addApp('/Applications', 'Visual Studio Code', 'com.microsoft.VSCode');
  m.addApp('/Applications', '1Password', 'com.1password.1password');
  m.addApp('/System/Applications', 'Music', 'com.apple.Music');
  m.addApp('/System/Applications', 'Calendar', 'com.apple.iCal');
  m.addApp('/System/Applications', 'System Settings', 'com.apple.systempreferences');
  m.addApp('/System/Applications/Utilities', 'Terminal', 'com.apple.Terminal');
  m.addApp('/System/Applications/Utilities', 'Activity Monitor', 'com.apple.ActivityMonitor');
  m.addApp(`${HOME}/Applications`, 'Zen for Stephen', 'com.apple.ScriptEditor.id.zen-for-stephen');
  return m;
}

export interface DesktopSetupOptions {
  /** UserConfig plus the raw "desktop" section (validated by src/desktop, not typed in UserConfig). */
  overrides?: UserConfig & { desktop?: Record<string, unknown> };
  mac?: FakeMac;
}

/** The full MCP server (browser + desktop tools) with fakes, a REAL SafetyGate, and an MCP client. */
export async function setupDesktop(opts: DesktopSetupOptions = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'stephen-desktop-'));
  const cfg = loadConfig(
    {
      ...opts.overrides,
      chrome: { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ...opts.overrides?.chrome }, zen: { executablePath: '/Applications/Zen Browser.app/Contents/MacOS/zen', ...opts.overrides?.zen },
    } as UserConfig,
    { HOME: tmp, BROWSER_HUB_HOME: join(tmp, 'hub') },
  );
  const mac = opts.mac ?? standardMac();
  const manager = new FakeManager();
  manager.connected.zen = false; // nothing attached unless a test says so
  const audit = new FakeAudit();
  const confirmer = new FakeConfirmer();
  const gate = new SafetyGate({ safety: cfg.safety, confirmer, audit });
  const deps: ServerDeps & { desktop: DesktopDeps } = {
    cfg,
    manager,
    engine: makeEngine(),
    safetyFactory: (() => ({ gate, audit })) as unknown as ServerDeps['safetyFactory'],
    confirmerFactory: () => confirmer,
    orphanWaitMs: 500,
    desktop: mac.deps(),
  };
  const server = buildServer(deps);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { tmp, cfg, mac, manager, audit, confirmer, gate, server, client, call };
}

export function textOf(res: CallToolResult): string {
  return res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}
