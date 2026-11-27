/**
 * `stephen update`: `git pull --ff-only`, `npm install`, `npm run build`, `install-helper`.
 * It refuses a dirty tree, a branch with no upstream and a pull that is not a fast-forward. It never resets,
 * checks out or force-anything. It prints the version before and after, says when the helper was rebuilt (macOS
 * then asks for Input Monitoring again), and how to go back (docs/RELEASE-CHECKLIST.md, "Going back").
 * Running it again after a failed step finishes the update: steps 2 to 4 are safe to repeat.
 *
 * Every program runs through `deps`, so the tests never touch git, npm or the helper.
 */

import { HELPER_UNCHANGED } from './helper/install.js';
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

/** Run the update. Returns the exit code: 0 done (also when there was no new commit), 1 stopped. */
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
  const now = nowR.code === 0 ? out(nowR) : prev;
  // No new commit still runs the steps: a run that pulled and then failed at install, build or helper must finish
  // when it is run again. Every step below is safe to run twice.
  const moved = now !== prev;
  if (!moved) log('No new version. Running the other steps again, so an update that stopped before can finish.');

  // ponytail: on a rerun after a failure, the "To go back" lines below name the current commit, since the old one is
  // only known in the first run. Upgrade path if it matters: read it from `git reflog -1 HEAD@{1}`.
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
  const rebuilt = !helper.stdout.includes(HELPER_UNCHANGED);

  const after = deps.version();
  if (moved) log(`\nUpdated: Stephen ${before} (${prev}) to ${after} (${now}).`);
  else log(`\nAlready up to date: Stephen ${after} (${now}). Every step is done.`);
  if (rebuilt) for (const l of HELPER_REBUILT_LINES) log(l);
  else log('The helper did not change, so your permissions are kept.');
  log('Quit and start Stephen again so the new version runs.\n');
  if (moved) for (const l of goBackLines(prev, branch)) log(l);
  return 0;
}
