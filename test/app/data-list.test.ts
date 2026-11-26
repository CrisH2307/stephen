/** B6: `stephen data` lists every store of docs/DATA-STORES.md, with sizes from the real files. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dataLines, formatBytes, STORES, storeSize, type DataPlaces } from '../../src/app/data-cli.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-data-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The "What" column of the first table in docs/DATA-STORES.md (the stores, not the "leaves the Mac" table). */
function docStores(): string[] {
  const md = readFileSync(resolve(__dirname, '../../docs/DATA-STORES.md'), 'utf8');
  const table = md.split('# Everything that leaves the Mac')[0]!;
  return table
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| What ') && !l.startsWith('|---'))
    .map((l) => l.split('|')[1]!.trim());
}

describe('stephen data (B6)', () => {
  it('lists every store of docs/DATA-STORES.md, and nothing the doc does not have', () => {
    const doc = docStores();
    expect(doc.length).toBeGreaterThan(15);
    expect(STORES.map((s) => s.what)).toEqual(doc);
  });

  it('sizes come from the real files; missing ones say not created yet', () => {
    const home = join(tmp, 'home');
    const p: DataPlaces = { home, jobsRoot: join(tmp, 'Stephen Jobs') };
    mkdirSync(join(home, 'history'), { recursive: true });
    mkdirSync(join(home, 'telemetry'), { recursive: true });
    writeFileSync(join(home, 'memory.json'), 'x'.repeat(100));
    writeFileSync(join(home, 'history', '2026-11-25.jsonl'), 'x'.repeat(2048));
    writeFileSync(join(home, 'history', '2026-11-26.jsonl'), 'x'.repeat(1024));
    writeFileSync(join(home, 'telemetry', 'latency-2026-11-25.jsonl'), 'x'.repeat(10));
    writeFileSync(join(home, 'telemetry', 'other.txt'), 'x'.repeat(999));
    writeFileSync(join(home, 'audit.log'), 'x'.repeat(5));
    writeFileSync(join(home, 'audit.log.1'), 'x'.repeat(7));

    const by = (what: string) => storeSize(STORES.find((s) => s.what === what)!, p);
    expect(by('Memory')).toBe(100);
    expect(by('Conversations (history)')).toBe(3072);
    expect(by('Latency records')).toBe(10);
    expect(by('Safety audit log')).toBe(12);
    expect(by('Timers and reminders')).toBeNull();

    const out = dataLines(p, tmp).join('\n');
    expect(out).toContain('Memory\n  where:  ~/home/memory.json\n  size:   100 B');
    expect(out).toContain('Conversations (history)\n  where:  ~/home/history/\n  size:   3.0 KB');
    expect(out).toContain('Timers and reminders\n  where:  ~/home/timers.json\n  size:   not created yet');
    expect(out).toContain('Account secrets\n  where:  macOS Keychain');
    expect(out).not.toContain('xxxxx'); // sizes only, never contents
    expect(out).not.toContain('`');
  });

  it('formats sizes for people', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
