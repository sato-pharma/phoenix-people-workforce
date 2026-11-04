#!/usr/bin/env node
/**
 * merge-checks-guard.mjs — bash-guard clause C21, MACHINE-WIDE (2026-11-04).
 *
 *   PreToolUse (Bash|PowerShell)   node merge-checks-guard.mjs
 *     - a `gh pr merge` of a PR whose checks are RED, STILL RUNNING or NOT REPORTED on its head commit
 *       is DENIED, in any repository.
 *   node merge-checks-guard.mjs selftest
 *     - the deny set and the allow set, driven through this hook as a real subprocess with a `gh` shim
 *       on PATH. Expect "0 failed" after editing this file.
 *
 * WHY. The owner's repositories live on a personal account on the free plan, where a private
 * repository's branch protection answers 403 — GitHub does NOT refuse a merge on red there. Measured
 * 2026-11-04 on phoenix-people-workforce: PR 18 red on `checks` and PR 20 with `validate` still
 * running were both one command from `main`. The owner's words that day: "make all the CI safe and
 * fast in all repos, all sessions".
 *
 * WHY AT THE USER LEVEL. The clause is phoenix-workforce `.claude/hooks/bash-guard.mjs` C21, pinned by
 * `tests/merge-checks-guard.test.ts`, with its verdict in `scripts/merge-checks-verdict.mjs`. It only
 * answers in sessions whose project is that repo. This copy answers everywhere else. When the
 * session's own project wires a bash-guard carrying C21, this hook stays silent — one refusal, not two.
 *
 * WHAT IT JUDGES. The required names from live protection when it answers. For phoenix-people-workforce
 * when it does not: `validate` and `checks` — AGENTS.md §2's declaration, copied here because a session
 * in another folder cannot read that file; if the declaration changes, change PHOENIX_REQUIRED too.
 * Any other repository with no readable protection: nothing failing and nothing still running; a
 * repository with no CI at all goes through.
 *
 * FAILS CLOSED on the read (a check it cannot read is a merge it cannot vouch for, and `gh pr merge`
 * needs the same network); FAILS OPEN on its own bugs (a parse error exits 0).
 *
 * STAND-DOWN, for the owner's own words only:  PHX_RED_MERGE_OK=1 <the same command>
 *                                               ($env:PHX_RED_MERGE_OK=1; … in PowerShell)
 */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

const mode = String(process.argv[2] ?? '');

const PHOENIX_REPO = 'omar-3-xx/phoenix-people-workforce';
const PHOENIX_REQUIRED = ['validate', 'checks'];

const GH_PR_MERGE = /(?:^|[\n|&;(])\s*(?:[A-Za-z_]\w*=\S+\s+)*gh(?:\.exe)?\s+pr\s+merge(?:\s|$)/i;
const MERGE_HELP = /(?:^|\s)(?:--help|-h)(?:\s|$)/;
const STAND_DOWN = /(?:^|[\s;&|(])\s*(?:\$env:)?PHX_RED_MERGE_OK\s*=\s*['"]?1['"]?(?![\w.])/i;

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }),
  );
  process.exit(0);
}

// ── the verdict (copied from phoenix-workforce scripts/merge-checks-verdict.mjs) ────────────────────

const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const FOREVER_QUEUED_APPS = new Set(['sentry', 'claude', 'vercel', 'railway-app']);

function stateOf(entry) {
  if (entry.kind === 'status') return entry.state === 'success' ? 'pass' : entry.state === 'pending' ? 'pending' : 'fail';
  if (entry.status !== 'completed') return 'pending';
  if (entry.conclusion === 'success') return 'pass';
  if (entry.conclusion === 'skipped' || entry.conclusion === 'neutral') return 'skipped';
  return FAILED.has(entry.conclusion) ? 'fail' : 'pending';
}

export function mergeChecksVerdict({ required, runs, statuses = [] }) {
  const entries = new Map();
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r || typeof r.name !== 'string') continue;
    const prev = entries.get(r.name);
    if (!prev || Number(r.id ?? 0) >= Number(prev.id ?? 0)) entries.set(r.name, { ...r, kind: 'run' });
  }
  for (const s of Array.isArray(statuses) ? statuses : []) {
    if (s && typeof s.context === 'string') entries.set(s.context, { name: s.context, state: s.state, kind: 'status' });
  }
  const red = [];
  const pending = [];
  const missing = [];
  if (Array.isArray(required) && required.length > 0) {
    for (const name of required) {
      const e = entries.get(name);
      if (!e) missing.push(name);
      else if (['fail', 'skipped'].includes(stateOf(e))) red.push(name);
      else if (stateOf(e) === 'pending') pending.push(name);
    }
    return { ok: !red.length && !pending.length && !missing.length, red, pending, missing, judged: `the required checks (${required.join(', ')})` };
  }
  for (const [name, e] of entries) {
    const s = stateOf(e);
    if (s === 'fail') red.push(name);
    else if (s === 'pending' && !(e.kind === 'run' && e.status === 'queued' && FOREVER_QUEUED_APPS.has(String(e?.app?.slug ?? '')))) {
      pending.push(name);
    }
  }
  return { ok: !red.length && !pending.length, red, pending, missing, judged: entries.size === 0 ? 'no checks at all' : 'every check on the commit' };
}

function describeVerdict(v) {
  const parts = [];
  if (v.red.length) parts.push(`red: ${v.red.join(', ')}`);
  if (v.pending.length) parts.push(`still running: ${v.pending.join(', ')}`);
  if (v.missing.length) parts.push(`not reported on this commit yet: ${v.missing.join(', ')}`);
  return parts.join(' · ');
}

// ── reading the command ─────────────────────────────────────────────────────────────────────────────

/** `--repo`/`-R` as `owner/name`, lower-cased, or null. `-r` is `--rebase`, so `-R` is case-sensitive. */
function repoFlag(text) {
  const words = text.split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, ''));
  let value = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^[;&|]/.test(w)) break;
    if (w === '--repo' || w === '-R') value = words[++i] ?? null;
    else if (w.startsWith('--repo=')) value = w.slice(7);
    else if (/^-R./.test(w)) value = w.slice(2).replace(/^=/, '');
  }
  if (!value) return null;
  const parts = value.replace(/^[a-z]+:\/\//i, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return null;
  return parts.slice(-2).join('/').toLowerCase();
}

// ── is a repo-level bash-guard already going to answer this call? ───────────────────────────────────

function head(file) {
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(24576);
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) try { closeSync(fd); } catch {}
  }
}
const mentionsBashGuard = (f) => {
  try {
    return existsSync(f) && readFileSync(f, 'utf8').includes('bash-guard');
  } catch {
    return false;
  }
};
export function repoGuardAnswers(startDirs) {
  for (const start of startDirs) {
    if (!start) continue;
    let dir = String(start).replace(/[\\/]+$/, '');
    for (let up = 0; up < 12 && dir; up++) {
      const guard = join(dir, '.claude', 'hooks', 'bash-guard.mjs');
      // C21 by its own header line — never the bare number: C20 is the cloud-mirror push clause, which
      // main's bash-guard already carried before this one, and matching it stood this hook aside there.
      if (existsSync(guard) && /^\/\/ +C21 a `gh pr merge`/m.test(head(guard))) {
        if (['dispatch.json', '../settings.json', '../settings.local.json'].some((f) => mentionsBashGuard(join(dir, '.claude', 'hooks', f)))) {
          return true;
        }
      }
      const parent = join(dir, '..').replace(/[\\/]+$/, '');
      if (parent === dir) break;
      dir = parent;
    }
  }
  return false;
}

// ── the hook ────────────────────────────────────────────────────────────────────────────────────────

if (mode !== 'selftest') {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') process.exit(0);
    const cmd = String(input?.tool_input?.command ?? '');
    if (!GH_PR_MERGE.test(cmd) || MERGE_HELP.test(cmd)) process.exit(0);
    if (STAND_DOWN.test(cmd) || process.env.PHX_RED_MERGE_OK === '1') process.exit(0);
    if (repoGuardAnswers([input?.cwd, process.env.CLAUDE_PROJECT_DIR])) process.exit(0);

    const after = cmd.slice(cmd.search(/gh(?:\.exe)?\s+pr\s+merge/i));
    const prNumber = (after.match(/(?:^|\s)(\d{1,7})(?=\s|$)/) || [])[1] ?? null;
    const named = repoFlag(after);
    const cwd = input?.cwd && existsSync(String(input.cwd)) ? String(input.cwd) : process.cwd();
    const gh = (args) =>
      String(
        execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, shell: process.platform === 'win32' }),
      ).trim();
    const standDown = String(input.tool_name).toLowerCase().includes('powershell')
      ? '$env:PHX_RED_MERGE_OK=1; <the same command>'
      : 'PHX_RED_MERGE_OK=1 <the same command>';
    const target = prNumber ? `PR #${prNumber}` : 'this branch’s PR';

    let repo = null;
    let verdict = null;
    let why = '';
    try {
      repo = named ?? gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).toLowerCase();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`a repository name this guard will not pass to gh: ${repo}`);
      const pr = JSON.parse(gh(['pr', 'view', ...(prNumber ? [prNumber] : []), '--json', 'headRefOid,baseRefName', '--repo', repo]) || '{}');
      const sha = String(pr.headRefOid ?? '');
      const base = String(pr.baseRefName ?? '');
      if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('no head commit came back for the PR');
      let required = null;
      if (/^[\w./-]+$/.test(base)) {
        try {
          const contexts = JSON.parse(gh(['api', `repos/${repo}/branches/${base}/protection/required_status_checks`, '--jq', '.contexts']) || '[]');
          if (Array.isArray(contexts) && contexts.length > 0) required = contexts.map(String);
        } catch {}
      }
      if (!required && repo === PHOENIX_REPO) required = PHOENIX_REQUIRED;
      const runs = JSON.parse(gh(['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '--jq', '.check_runs']) || '[]');
      const statuses = JSON.parse(gh(['api', `repos/${repo}/commits/${sha}/status`, '--jq', '.statuses']) || '[]');
      verdict = mergeChecksVerdict({ required, runs, statuses });
    } catch (e) {
      if (e?.[Symbol.for('phx.hook-exit')]) throw e;
      why = String(e?.message ?? e).split('\n')[0].slice(0, 200);
    }

    if (!verdict) {
      deny(
        `C21 — could not read the checks on ${target}${repo ? ` in ${repo}` : ''}, so this merge is refused rather than waved ` +
          `through (${why || 'no answer from gh'}). GitHub does not enforce required checks on this plan, so this read is ` +
          `the only thing between a red PR and main. Run the same merge again in a moment; if it keeps failing, read the ` +
          `checks with \`gh pr checks\`.\n\nOnly if the owner said in his own words to merge it anyway: ${standDown}`,
      );
    }
    if (!verdict.ok) {
      deny(
        `C21 — ${target}${repo ? ` in ${repo}` : ''} is not green on its head commit: ${describeVerdict(verdict)}. Judged on ` +
          `${verdict.judged}.\n\n🔴 GITHUB WOULD LET THIS MERGE THROUGH — this plan does not enforce required checks.\n\n` +
          'Still running: merge once it is green (wait in the BACKGROUND and act on the notification — never poll). Red: fix ' +
          `it on the branch and push.\n\nOnly if the owner said in his own words to merge it red: ${standDown}`,
      );
    }
    process.exit(0);
  } catch (e) {
    if (e?.[Symbol.for('phx.hook-exit')]) throw e; // a deny above ended this hook (hook-dispatch.mjs)
    process.exit(0); // fail open on the hook's own bugs
  }
}

// ── selftest ────────────────────────────────────────────────────────────────────────────────────────

if (mode === 'selftest') {
  const { spawnSync } = await import('node:child_process');
  const { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { delimiter } = await import('node:path');

  let failed = 0;
  let checks = 0;
  const ok = (name, cond, detail = '') => {
    checks++;
    if (cond) console.log(`  pass  ${name}`);
    else {
      failed++;
      console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
  };
  const dir = mkdtempSync(join(tmpdir(), 'phx-merge-checks-'));
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  let n = 0;
  const shim = (answers) => {
    const bin = join(dir, `bin-${n++}`);
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'answers.json'), JSON.stringify(answers));
    writeFileSync(
      join(bin, 'gh.mjs'),
      'import{readFileSync}from"node:fs";import{dirname,join}from"node:path";import{fileURLToPath}from"node:url";' +
        'const t=JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),"answers.json"),"utf8"));' +
        'const a=process.argv.slice(2).join(" ");const h=t.find(([k])=>a.includes(k));if(!h||h[1]===null)process.exit(1);process.stdout.write(h[1]);',
    );
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, '/')}" "$(dirname "$0")/gh.mjs" "$@"\n`);
    try { chmodSync(join(bin, 'gh'), 0o755); } catch {}
    writeFileSync(join(bin, 'gh.cmd'), `@"${process.execPath}" "%~dp0gh.mjs" %*\r\n`);
    return bin;
  };
  const answers = (repo, runs, protection = null) => [
    ['nameWithOwner', repo],
    ['required_status_checks', protection],
    ['headRefOid,baseRefName', JSON.stringify({ headRefOid: SHA, baseRefName: 'main' })],
    ['check-runs', JSON.stringify(runs)],
    [`commits/${SHA}/status`, '[]'],
  ];
  const r = (name, status, conclusion) => ({ id: 1, name, status, conclusion, app: { slug: 'github-actions' } });
  const decide = (command, bin, tool = 'Bash') => {
    const env = { ...process.env, PATH: bin + delimiter + (process.env.PATH ?? '') };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.PHX_RED_MERGE_OK;
    const res = spawnSync(process.execPath, [process.argv[1]], {
      cwd: dir,
      env,
      input: JSON.stringify({ tool_name: tool, cwd: dir, tool_input: { command } }),
      encoding: 'utf8',
    });
    const i = String(res.stdout).indexOf('{"hookSpecificOutput"');
    if (i < 0) return { decision: 'allow', reason: '' };
    const o = JSON.parse(String(res.stdout).slice(i)).hookSpecificOutput;
    return { decision: o.permissionDecision, reason: String(o.permissionDecisionReason) };
  };
  const PX = 'Omar-3-xx/phoenix-people-workforce';
  const green = [r('validate', 'completed', 'success'), r('checks', 'completed', 'success')];

  let d = decide('gh pr merge 17 --squash', shim(answers(PX, green)));
  ok('a green Phoenix PR merges', d.decision === 'allow', d.reason.slice(0, 120));
  d = decide('gh pr merge 18 --squash', shim(answers(PX, [r('validate', 'completed', 'success'), r('checks', 'completed', 'failure')])));
  ok('a Phoenix PR red on `checks` is refused', d.decision === 'deny' && /red: checks/.test(d.reason), d.reason.slice(0, 120));
  ok('  and judged on the declared pair when protection answers 403', /\(validate, checks\)/.test(d.reason));
  d = decide('gh pr merge 20', shim(answers(PX, [r('validate', 'in_progress', null)])));
  ok('a Phoenix PR still running is refused', d.decision === 'deny' && /still running: validate/.test(d.reason), d.reason.slice(0, 120));
  d = decide('gh pr merge 21', shim(answers(PX, [...green, r('mobile', 'completed', 'failure')])));
  ok('a red NON-required `mobile` does not hold a Phoenix merge', d.decision === 'allow', d.reason.slice(0, 120));
  d = decide('gh pr merge 7 --repo Omar-3-xx/FTP-Portal', shim(answers('x', [r('build', 'completed', 'failure')])));
  ok('another repo, no protection: a red check is refused', d.decision === 'deny' && /ftp-portal/.test(d.reason), d.reason.slice(0, 120));
  d = decide('gh pr merge 7 -R Omar-3-xx/FTP-Portal', shim(answers('x', [])));
  ok('another repo with no CI at all merges', d.decision === 'allow', d.reason.slice(0, 120));
  d = decide('gh pr merge 7', shim(answers('omar-3-xx/sato-anti-infective-app', [r('lint', 'completed', 'success')], '["build"]')));
  ok('live protection names win: a required check never reported is refused', d.decision === 'deny' && /not reported.*build/.test(d.reason), d.reason.slice(0, 120));
  d = decide('gh pr merge 9 --squash', shim([]));
  ok('an unreadable read FAILS CLOSED', d.decision === 'deny' && /could not read/.test(d.reason), d.reason.slice(0, 120));
  d = decide('gh pr merge 18', shim(answers(PX, [r('validate', 'completed', 'failure')])), 'PowerShell');
  ok('PowerShell gets its own stand-down spelling', /\$env:PHX_RED_MERGE_OK=1; /.test(d.reason));
  for (const c of ['PHX_RED_MERGE_OK=1 gh pr merge 18', '$env:PHX_RED_MERGE_OK=1; gh pr merge 18', 'gh pr merge --help', 'gh pr view 18', 'gh pr checks 18', 'git merge origin/main']) {
    ok(`allowed: ${c}`, decide(c, shim([])).decision === 'allow');
  }
  d = decide('PHX_MERGE_OK=1 gh pr merge 18', shim(answers(PX, [r('validate', 'completed', 'failure')])));
  ok("C10's PHX_MERGE_OK does NOT stand C21 down", d.decision === 'deny');

  // Stand-aside: a project wiring a bash-guard that carries C21 answers for itself; one that carries
  // only C20 (the cloud-mirror push clause, on main before C21 existed) does not, and this hook must.
  const project = (header) => {
    const root = mkdtempSync(join(dir, 'proj-'));
    mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.claude', 'hooks', 'bash-guard.mjs'), `${header}\nprocess.exit(0);\n`);
    writeFileSync(join(root, '.claude', 'settings.json'), '{"hooks":"bash-guard"}');
    return root;
  };
  const at = (root, bin) => {
    const env = { ...process.env, PATH: bin + delimiter + (process.env.PATH ?? '') };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.PHX_RED_MERGE_OK;
    const res = spawnSync(process.execPath, [process.argv[1]], {
      cwd: root,
      env,
      input: JSON.stringify({ tool_name: 'Bash', cwd: root, tool_input: { command: 'gh pr merge 18' } }),
      encoding: 'utf8',
    });
    return String(res.stdout).includes('"deny"') ? 'deny' : 'allow';
  };
  const redBin = shim(answers(PX, [r('validate', 'completed', 'failure')]));
  ok('stands aside where the project wires a bash-guard carrying C21', at(project('//   C21 a `gh pr merge` of a PR'), redBin) === 'allow');
  ok('answers where the project bash-guard carries only C20', at(project('//   C20 a push that touches .claude'), redBin) === 'deny');

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${checks} checks, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
