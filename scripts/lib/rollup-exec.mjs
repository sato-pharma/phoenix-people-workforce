// The two child-process doors `scripts/rollup-prs.mjs` reads GitHub and git through.
//
// WHY A MODULE OF ITS OWN. rollup-prs.mjs runs its whole report at import time, so a test cannot reach
// a helper defined inside it. Here, the very `git()` the roll-up calls can be driven against a real blob
// larger than Node's default output limit — the only reading that proves the ceiling below is applied,
// rather than spelled.
'use strict';

import { execFileSync } from 'node:child_process';

/**
 * The most output any one `gh` or `git` call here may return: 64 MiB.
 *
 * 🔴 NODE'S DEFAULT IS 1 MiB, AND THE SUITE REGISTRY OUTGREW IT. `execFileSync` with no `maxBuffer`
 * kills the child at 1,048,576 bytes and throws `spawnSync git ENOBUFS`. Measured 29 Oct 2026, about
 * 02:55 Cairo: `tests/run-tests.ts` on `main` was 1,053,835 bytes, so `registryLandedOnMain()`'s
 * `git show origin/main:tests/run-tests.ts` died, `allowFail` turned the error into `null`, and a null
 * reads as "not landed". `--settle` then left PR 6643 open twice although all 8 of its files were
 * byte-identical on `main` after roll-up 6645, and it was closed by hand. Nothing printed — failing
 * closed is right for a file that truly cannot be read, which is exactly why a buffer too small to read
 * it could hide there.
 *
 * `gh` shares the ceiling because `gh pr list --json … statusCheckRollup` grows with every open PR and
 * every check run on it. 64 MiB is the figure `repo-doctor.mjs` already gives its own `git show`.
 * Pinned by `tests/rollup-exec-buffer.test.ts`, which reads a blob past the default limit through `git()`.
 */
export const ROLLUP_MAX_BUFFER = 64 * 1024 * 1024;

/** Every child read in this module goes through here, so neither door can miss the ceiling. */
function capture(command, argv, options) {
  return execFileSync(command, argv, { encoding: 'utf8', ...options, maxBuffer: ROLLUP_MAX_BUFFER });
}

/**
 * Run `gh`. A failure ends the run with the first line of its reason, unless `allowFail` asks for ''.
 *
 * @param {string[]} argv
 * @param {{ allowFail?: boolean }} [options]
 * @returns {string}
 */
export function gh(argv, { allowFail = false } = {}) {
  try {
    return capture('gh', argv, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  } catch (err) {
    if (allowFail) return '';
    const detail = String(err?.stderr || err?.message || err).split('\n')[0];
    console.error(`[rollup] could not reach GitHub: ${detail}`);
    process.exit(1);
  }
}

/**
 * Run `git`, trimmed unless `raw`. A failure throws, unless `allowFail` asks for `null`.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, allowFail?: boolean, env?: Record<string, string>, input?: string, raw?: boolean }} [options]
 * @returns {string | null}
 */
export function git(argv, { cwd = process.cwd(), allowFail = false, env, input, raw = false } = {}) {
  try {
    const out = capture('git', argv, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: 120000,
    });
    // A patch must keep its trailing newline or `git apply` refuses it, so `raw` skips the trim.
    return raw ? out : out.trim();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}
