/** Job inputs through `<jobs root>/inbox/` (owner, 2026-11-05): listed in the dialog, moved into input/ on start. */
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { inboxFiles, MAX_INBOX_FILES, type JobPlan } from '../../src/jobs/manager.js';
import { startPrompt } from '../../src/jobs/router.js';
import { harness, tempRoot } from './helpers.js';

const { tmp, cleanup } = tempRoot('jobs-inbox');
afterAll(cleanup);

describe('jobs inbox', () => {
  it('plan lists regular files only; start moves them into input/ and empties the inbox', async () => {
    const h = harness(tmp);
    const inbox = join(h.root, 'inbox');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'lab4.pdf'), 'pdf');
    writeFileSync(join(inbox, 'data.csv'), 'a,b');
    writeFileSync(join(inbox, '.DS_Store'), 'x');
    mkdirSync(join(inbox, 'folder'));
    writeFileSync(join(tmp, 'secret.txt'), 'top secret');
    symlinkSync(join(tmp, 'secret.txt'), join(inbox, 'link.txt'));
    const p = (await h.manager.plan('write my lab report draft')) as JobPlan;
    expect(p.inputs).toEqual(['data.csv', 'lab4.pdf']);
    expect(startPrompt(p, 'voice-ptt').body).toMatch(/Input files \(moved from your jobs inbox\): .*data\.csv.*lab4\.pdf/);
    const s = await h.manager.start(p, 'voice-ptt');
    expect('refused' in s).toBe(false);
    expect(readdirSync(join(p.folder, 'input')).sort()).toEqual(['data.csv', 'lab4.pdf']);
    expect(readdirSync(inbox).sort()).toEqual(['.DS_Store', 'folder', 'link.txt']); // the rest stays
  });

  it('empty or missing inbox: dialog says how to add files; the inbox folder is created for next time', async () => {
    const h = harness(tmp);
    const p = (await h.manager.plan('write my lab report draft')) as JobPlan;
    expect(p.inputs).toBeUndefined();
    expect(startPrompt(p, 'voice-ptt').body).toMatch(/Input files: none \(put files in the inbox folder/);
    await h.manager.start(p, 'voice-ptt');
    expect(existsSync(join(h.root, 'inbox'))).toBe(true);
  });

  it('a file that became a symlink after the dialog is not moved', async () => {
    const h = harness(tmp);
    const inbox = join(h.root, 'inbox');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'a.txt'), 'a');
    const p = (await h.manager.plan('write my lab report draft')) as JobPlan;
    expect(p.inputs).toEqual(['a.txt']);
    const fs = await import('node:fs');
    fs.rmSync(join(inbox, 'a.txt'));
    writeFileSync(join(tmp, 'other.txt'), 'other');
    symlinkSync(join(tmp, 'other.txt'), join(inbox, 'a.txt'));
    await h.manager.start(p, 'voice-ptt');
    expect(readdirSync(join(p.folder, 'input'))).toEqual([]);
  });

  it('caps and a symlinked inbox are refused', () => {
    const dir = join(tmp, 'many');
    mkdirSync(dir);
    for (let i = 0; i <= MAX_INBOX_FILES; i++) writeFileSync(join(dir, `f${i}`), 'x');
    expect(inboxFiles(dir)).toMatchObject({ error: /at most/ });
    symlinkSync(dir, join(tmp, 'linked'));
    expect(inboxFiles(join(tmp, 'linked'))).toMatchObject({ error: /symlink/ });
    expect(inboxFiles(join(tmp, 'nope'))).toEqual([]);
  });
});
