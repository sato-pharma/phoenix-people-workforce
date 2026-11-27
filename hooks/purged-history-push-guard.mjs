#!/usr/bin/env node
/**
 * purged-history-push-guard.mjs — MACHINE-WIDE (2026-11-27, the history purge).
 *
 *   PreToolUse (Bash|PowerShell)   node purged-history-push-guard.mjs
 *     - a `git push` from a clone of sato-pharma/phoenix-people-workforce whose HEAD (or a local
 *       branch the command names) still descends from the OLD root commit 23e3b9db1 is DENIED.
 *
 * WHY. On 27 Nov 2026, on the owner's word, the repository's history was rewritten (git filter-repo):
 * the filled April payroll copy and 39 old data files were removed and every commit id changed.
 * Every clone and worktree made before about 11:45 Cairo still holds the OLD history, and one push
 * of a branch from it puts those files back on public GitHub. The new history has a different root
 * commit, so "descends from 23e3b9db1" is an exact test for "made before the purge".
 *
 * THE FIX IT NAMES. git fetch origin, then
 *   git rebase --onto origin/main 2369952b0d60f657fed65eb73aca30e40c0fe708 <branch>
 * (old main 2369952b0 maps to new main bff23828c; a branch cut from an earlier main needs that
 * commit from the commit map in "C:/Users/satoh/Phoenix History Purge 2026-11-27 - kept map/
 * commit-map"; the 1.3 GB backup itself was deleted on 27 Nov 13:19 on the owner's word).
 *
 * FAILS OPEN on its own bugs and on a clone that does not hold the old root (a fresh clone).
 * Stand-down, the owner's own words only:  PHX_OLD_HISTORY_PUSH_OK=1 <the same command>
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const OLD_ROOT = '23e3b9db14a1b04c99776a3554c9d196bd9bd3fe';
const GIT_PUSH = /(?:^|[\n|&;(])\s*(?:[A-Za-z_]\w*=\S+\s+)*git(?:\.exe)?((?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+)|\s+-c\s+\S+)*)\s+push\b([^\n|&;]*)/gi;
const STAND_DOWN = /(?:^|[\s;&|(])\s*(?:\$env:)?PHX_OLD_HISTORY_PUSH_OK\s*=\s*['"]?1['"]?(?![\w.])/i;

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(0);
}

const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', timeout: 15000, windowsHide: true });

function unquote(s) { return s.replace(/^["']|["']$/g, ''); }

function main(raw) {
  let input; try { input = JSON.parse(raw || '{}'); } catch { return; }
  const cmd = String(input?.tool_input?.command ?? '');
  if (!/\bpush\b/i.test(cmd) || STAND_DOWN.test(cmd)) return;
  const cwd = String(input?.cwd || process.cwd());
  for (const m of cmd.matchAll(GIT_PUSH)) {
    let dir = cwd;
    const c = [...String(m[1] || '').matchAll(/-C\s+("[^"]*"|'[^']*'|\S+)/g)];
    if (c.length) dir = unquote(c[c.length - 1][1]);
    const remotes = git(dir, 'remote', '-v');
    const args = String(m[2] || '').trim().split(/\s+/).filter(Boolean);
    const urlInCmd = args.some((a) => /phoenix-people-workforce/i.test(a));
    if (!urlInCmd && !(remotes.status === 0 && /phoenix-people-workforce/i.test(remotes.stdout))) continue;
    if (git(dir, 'cat-file', '-e', `${OLD_ROOT}^{commit}`).status !== 0) continue; // fresh clone: no old history here
    const sources = new Set(['HEAD']);
    for (const a of args) {
      if (a.startsWith('-')) continue;
      const src = a.replace(/^\+/, '').split(':')[0];
      if (src && git(dir, 'rev-parse', '--verify', '--quiet', `${src}^{commit}`).status === 0) sources.add(src);
    }
    if (args.some((a) => a === '--all' || a === '--mirror')) sources.add('--all');
    for (const s of sources) {
      const refs = s === '--all'
        ? git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads').stdout.split('\n').filter(Boolean)
        : [s];
      for (const r of refs) {
        if (git(dir, 'merge-base', '--is-ancestor', OLD_ROOT, r).status === 0) {
          deny(`Refused: \`${r}\` in ${dir} is on the OLD history of phoenix-people-workforce, the history purged on 27 Nov 2026 (the payroll copy and 39 data files). Pushing it would put those files back on public GitHub.\n\nMove it onto the new history first:\n  git -C "${dir}" fetch origin\n  git -C "${dir}" rebase --onto origin/main 2369952b0d60f657fed65eb73aca30e40c0fe708 <branch>\n(2369952b0 is the old main, and it maps to the new main bff23828c. A branch cut from an earlier main needs that commit's new id from C:/Users/satoh/Phoenix History Purge 2026-11-27 - kept map/commit-map.)\nThen check that \`git merge-base --is-ancestor ${OLD_ROOT} HEAD\` FAILS before pushing.`);
        }
      }
    }
  }
}

let buf = '';
try { buf = readFileSync(0, 'utf8'); } catch { /* fail open */ }
try { main(buf); } catch { /* fail open */ }
process.exit(0);
