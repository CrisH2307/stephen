/** B6: `stephen data` lists every store of docs/DATA-STORES.md, with sizes from the real files. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dataLines, filesOf, formatBytes, STORES, storeSize, type DataPlaces } from '../../src/app/data-cli.js';

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

  it('never follows a link: a link loop or a link to a big outside folder counts as the link only', () => {
    const home = join(tmp, 'links');
    const p: DataPlaces = { home, jobsRoot: join(tmp, 'links-jobs') };
    const outside = join(tmp, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'big.bin'), 'x'.repeat(100_000));
    mkdirSync(join(home, 'history'), { recursive: true });
    writeFileSync(join(home, 'history', 'day.jsonl'), 'x'.repeat(10));
    symlinkSync(outside, join(home, 'history', 'to-outside'));
    symlinkSync(join(home, 'history'), join(home, 'history', 'loop'));

    const size = storeSize(STORES.find((s) => s.what === 'Conversations (history)')!, p)!;
    expect(size).toBeGreaterThanOrEqual(10);
    expect(size).toBeLessThan(10_000); // the 100 KB file behind the link is not counted, and the loop ends
  });

  it('counts the announced jobs file once, not also inside job state', () => {
    const home = join(tmp, 'jobs-home');
    const p: DataPlaces = { home, jobsRoot: join(tmp, 'jobs-out') };
    mkdirSync(join(home, 'jobs', 'j_1'), { recursive: true });
    writeFileSync(join(home, 'jobs', 'j_1', 'state.json'), 'x'.repeat(40));
    writeFileSync(join(home, 'jobs', '.announced.json'), 'x'.repeat(3));

    const by = (what: string) => storeSize(STORES.find((s) => s.what === what)!, p);
    expect(by('Job state and logs')).toBe(40);
    expect(by('Announced jobs')).toBe(3);
    expect(filesOf(STORES.find((s) => s.what === 'Announced jobs')!, p)).toEqual([join(home, 'jobs', '.announced.json')]);
    expect(filesOf(STORES.find((s) => s.what === 'Timers and reminders')!, p)).toEqual([]);
  });

  it('formats sizes for people', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
