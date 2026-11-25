/**
 * `stephen update`: `git pull --ff-only`, `npm install`, `npm run build`, `install-helper`.
 * It refuses a dirty tree, a branch with no upstream and a pull that is not a fast-forward. It never resets,
 * checks out or force-anything. It prints the version before and after, says when the helper was rebuilt (macOS
 * then asks for Input Monitoring again), and how to go back (docs/RELEASE-CHECKLIST.md, "Going back").
 *
 * Every program runs through `deps`, so the tests never touch git, npm or the helper.
 */

import { firstLine } from './lib/process.js';

export interface RunResult {
  /** Exit code; null when the program could not start. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface UpdateDeps {
  /** Run a program in the install folder. Never throws. */
  run: (cmd: string, args: string[]) => Promise<RunResult>;
  /** Version in package.json right now (read from disk, so after the pull it is the new one). */
  version: () => string;
  /** The built CLI, run with node for the helper step (a fresh process, so it is the new build). */
  cliPath: string;
  log: (line: string) => void;
}

const out = (r: RunResult) => r.stdout.trim();

export const GOING_BACK_DOC = 'docs/RELEASE-CHECKLIST.md, "Going back"';

/** One plain paragraph for a rebuilt helper. */
export const HELPER_REBUILT_LINES = [
  'The helper was rebuilt, so macOS may ask for Input Monitoring again:',
  '  System Settings > Privacy & Security > Input Monitoring.',
  '  Turn "Stephen Helper" on. If it shows on but F5 does nothing, remove it with (-) and add it again.',
];

/** The way back: the previous commit and the steps of "Going back". */
export function goBackLines(prev: string, branch: string): string[] {
  return [
    `To go back (${GOING_BACK_DOC}):`,
    `  git checkout ${prev}`,
    '  npm install && npm run build && node dist/cli.js install-helper',
    '  Click Input Monitoring again if install-helper rebuilt the helper. Restart Stephen. Then: node dist/cli.js mac-checks',
    `  To come back to the newest version later: git checkout ${branch}`,
  ];
}

/** Run the update. Returns the exit code: 0 done (or already up to date), 1 stopped. */
export async function runUpdate(deps: UpdateDeps): Promise<number> {
  const { log, run } = deps;
  const stop = (sentence: string, detail?: string): number => {
    if (detail) log(`  ${detail}`);
    log(`\nStopped. ${sentence}`);
    return 1;
  };

  const before = deps.version();
  const prevR = await run('git', ['rev-parse', '--short', 'HEAD']);
  if (prevR.code !== 0) return stop('This folder is not a git checkout, so it cannot update itself. Get Stephen again with git clone.');
  const prev = out(prevR);
  const branchR = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = out(branchR);
  log(`Stephen ${before} (${prev}) on ${branch}`);

  if (branch === 'HEAD' || branchR.code !== 0) {
    return stop('You are not on a branch. Run `git checkout main`, then `stephen update` again.');
  }
  const dirty = await run('git', ['status', '--porcelain', '--untracked-files=no']);
  if (dirty.code !== 0 || out(dirty)) {
    return stop('You changed files in this folder. Save or undo those changes first, then run `stephen update` again. Nothing was touched.');
  }

  log('[1/4] Get the newest version (git pull --ff-only)');
  const pull = await run('git', ['pull', '--ff-only']);
  if (pull.code !== 0) {
    return stop('Git could not move forward cleanly, so nothing was changed. Ask Cris, or check `git status`.', firstLine(pull.stderr || pull.stdout));
  }
  const nowR = await run('git', ['rev-parse', '--short', 'HEAD']);
  if (out(nowR) === prev) {
    log(`\nAlready up to date: Stephen ${before} (${prev}). Nothing to do.`);
    return 0;
  }

  log('[2/4] Install packages (npm install)');
  const npmI = await run('npm', ['install']);
  if (npmI.code !== 0) return stop(`The packages did not install. Fix the error, then run \`stephen update\` again. To go back: git checkout ${prev}`, firstLine(npmI.stderr || npmI.stdout));

  log('[3/4] Build (npm run build)');
  const build = await run('npm', ['run', 'build']);
  if (build.code !== 0) return stop(`The build failed. To go back: git checkout ${prev}, then npm install && npm run build.`, firstLine(build.stderr || build.stdout));

  log('[4/4] Helper (install-helper)');
  const helper = await run(process.execPath, [deps.cliPath, 'install-helper']);
  if (helper.code !== 0) {
    return stop(`The helper did not build. Run \`stephen install-helper\` and read the error. To go back: git checkout ${prev}`, firstLine(helper.stderr || helper.stdout));
  }
  const rebuilt = !/Nothing changed/.test(helper.stdout);

  const after = deps.version();
  log(`\nUpdated: Stephen ${before} (${prev}) to ${after} (${out(nowR)}).`);
  if (rebuilt) for (const l of HELPER_REBUILT_LINES) log(l);
  else log('The helper did not change, so your permissions are kept.');
  log('Quit and start Stephen again so the new version runs.\n');
  for (const l of goBackLines(prev, branch)) log(l);
  return 0;
}
