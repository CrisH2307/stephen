// Build every helper source for the oldest macOS Stephen supports (LSMinimumSystemVersion in helper/Info.plist), so an
// API newer than that, used without #available, fails here. Run after `npm run build`:
//   node scripts/helper-min-macos.mjs [sdk path]   (default: xcrun's macOS SDK)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swiftcArgs } from '../dist/helper/install.js';

const min = /<key>LSMinimumSystemVersion<\/key>\s*<string>([\d.]+)<\/string>/.exec(readFileSync('helper/Info.plist', 'utf8'))?.[1];
if (!min) {
  console.error('LSMinimumSystemVersion not found in helper/Info.plist');
  process.exit(1);
}
const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos${min}`;
const sdk = process.argv[2] ?? execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
const dir = mkdtempSync(join(tmpdir(), 'helper-min-'));
console.log(`Building the helper for ${target} (SDK ${sdk})`);
const r = spawnSync('xcrun', ['swiftc', '-target', target, ...swiftcArgs('helper', join(dir, 'Stephen Helper'), sdk)], { stdio: 'inherit', timeout: 600_000 });
rmSync(dir, { recursive: true, force: true });
process.exit(r.status ?? 1);
