// The per-commit record `scripts/check-contracts.mjs` writes when every gate passes, and
// `.claude/hooks/push-typecheck-guard.mjs` reads before a push.
//
// WHY IT EXISTS (owner, 2026-10-23, choosing "warn on every push"): the pre-push reminder used to fire
// only on a push that ADDED a test file. He widened it to every push — still a note, never a refusal,
// because the 2026-10-04 ruling *"keep the pre-push test as a rule, no guard"* stands. A reminder that
// fires on every push with no way to be satisfied is noise, and noise is ignored, so `check-contracts`
// now leaves a record and the reminder goes quiet for the commit it proved.
//
// 🔴 THE RECORD IS ABOUT A COMMIT, AND CONTRACTS RUN ON THE WORKING TREE — so a run with ANY
// uncommitted change writes NOTHING, and every run first clears whatever HEAD held: a record written
// before an edit no longer describes the tree that passed. The quiet push is therefore the honest
// order — commit first, then run the gates, then push.
//
// It lives in `<git-common-dir>/<CONTRACTS_DIR_NAME>/<sha>.json`, beside remote-check's verdict records:
// shared by every worktree of this repository, never tracked, and safe to delete at any time.
//
// Every function here FAILS SOFT. This is bookkeeping around an optional, never-gating script: it may
// not break a run, and a missing or unreadable record simply means "not proved", which only reminds.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Pinned against the hook's own copy by `tests/push-typecheck-guard.test.ts`. */
export const CONTRACTS_DIR_NAME = 'phx-check-contracts';

const SHA_RE = /^[0-9a-f]{40}$/;

const gitOut = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();

/** Where this repository's records live, or null when git cannot say. */
export function contractsRecordDir(root) {
  try {
    return join(gitOut(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']), CONTRACTS_DIR_NAME);
  } catch {
    return null;
  }
}

/**
 * `{ sha, clean }` for the checkout at `root`, or null when git cannot say. `clean` is false when ANY
 * tracked file differs from HEAD — untracked files are not counted, since a gate reads what is tracked.
 */
export function headState(root) {
  try {
    const sha = gitOut(root, ['rev-parse', 'HEAD']);
    if (!SHA_RE.test(sha)) return null;
    const dirty = gitOut(root, ['status', '--porcelain', '--untracked-files=no']);
    return { sha, clean: dirty === '' };
  } catch {
    return null;
  }
}

/** Drop the record for `sha` — what passed earlier cannot speak for a tree that has moved since. */
export function clearContractsRecord(root, sha) {
  const dir = contractsRecordDir(root);
  if (!dir || !SHA_RE.test(String(sha))) return;
  try {
    rmSync(join(dir, `${sha}.json`), { force: true });
  } catch {
    // bookkeeping only
  }
}

/**
 * Record a full pass for a CLEAN checkout. Returns the record written, or null when nothing was —
 * a dirty tree, an unreadable repository, or an unwritable directory.
 */
export function writeContractsPass(root, { gates, seconds } = {}) {
  const dir = contractsRecordDir(root);
  const head = headState(root);
  if (!dir || !head) return null;
  clearContractsRecord(root, head.sha);
  if (!head.clean) return null;
  const record = {
    sha: head.sha,
    clean: true,
    gates: Number.isFinite(gates) ? gates : null,
    seconds: Number.isFinite(seconds) ? seconds : null,
    at: new Date().toISOString(),
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${head.sha}.json`), `${JSON.stringify(record)}\n`);
    return record;
  } catch {
    return null;
  }
}

/** The pass recorded for exactly this sha, or null. A record naming another sha is not read. */
export function readContractsPass(root, sha) {
  const dir = contractsRecordDir(root);
  if (!dir || !SHA_RE.test(String(sha))) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, `${sha}.json`), 'utf8'));
    return parsed && parsed.sha === sha && parsed.clean === true ? parsed : null;
  } catch {
    return null;
  }
}
