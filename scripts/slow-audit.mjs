#!/usr/bin/env node
// slow-audit.mjs — answer "why is everything slow?" with numbers, in one command.
//
// WHY THIS EXISTS. On 2026-10-08 the owner said working in the Claude desktop app had become
// unacceptable — "everything takes hilarious time" — and could not tell whether the cause was
// settings, the repo, CI or the machine. Four separate layers were suspected and only one of
// them turned out to matter. Guessing between them had already produced two wrong answers in
// earlier sessions, both of which blamed the repo.
//
// THE MEASUREMENT THAT SETTLED IT, and the reason this script leads with it:
//
//     Memory\Pages Input/sec   avg 9,447   peak 38,885
//     Memory\Available MBytes  1,360 of 16,174
//     PhysicalDisk % Idle Time 95%
//     Processor % Total        50%
//
// 9,447 hard page faults a second is thrashing. Every one of them is a stall on disk for a
// page that should have been resident. It is why a file read, a keystroke, a hook and a UI
// repaint were ALL slow at once — the one symptom shape that no repo-side cause can produce.
//
// 🔴 AND THE DISK BEING 95% IDLE IS NOT EVIDENCE AGAINST IT. That inference is recorded in this
// repo's own machine-ceiling notes from 2026-09-17 ("disk sat 99.6-99.9% idle with a 0.00 queue
// while the box was slow"), and it is wrong. An NVMe serves ~9,400 random 4K faults a second at
// a queue depth near zero, so it reports idle while every fault still costs the faulting thread
// its timeslice. The fault RATE is the test; disk utilization and queue length cannot see it.
// `Pages Input/sec` is therefore the first counter this script reads, and
// tests/slow-audit.test.ts pins that choice so it is not "fixed" back to a disk reading.
//
// WHAT IT WILL NOT DO. It starts no dev server, no build, no typecheck and no test run: it is
// meant to be safe to run on a box that is already at the freeze line, which is exactly when
// someone wants to know why. It spawns hook scripts only to time them, with a read-only
// `git status --porcelain` payload, and it never spawns dev-server-reaper.mjs or
// scratchpad-guard's `sweep` mode, both of which act rather than report.
//
// DATING A CHANGE, which is the whole point of the log. A single reading proves nothing — it
// attributes itself to whatever happened to be open. Every run appends one record to
// ~/.claude/logs/slow-audit.jsonl and prints the delta against the previous one, so "it got
// slower on Tuesday" becomes answerable instead of arguable.
//
// Usage:
//   node scripts/slow-audit.mjs              full audit
//   node scripts/slow-audit.mjs --quick      skip hook timing and CI (machine layer only)
//   node scripts/slow-audit.mjs --json       machine-readable, no table
//   node scripts/slow-audit.mjs --history    print the log and exit
//   node scripts/slow-audit.mjs --transcripts [--since YYYY-MM-DD] [--until YYYY-MM-DD]
//                                            what sessions actually waited for, from their own
//                                            transcripts (Layer 6); --until is exclusive, Cairo days
//   node scripts/slow-audit.mjs --transcripts --check [--since …] [--until …]
//                                            the same record, then one plain sentence per limit in
//                                            TRANSCRIPT_LIMITS that it crossed (or "no limit crossed"),
//                                            also written to ~/.claude/logs/slow-audit-alarms.json.
//                                            Exit code stays 0 either way; it spawns nothing.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "slow-audit",
  entry: import.meta.url,
  known: ["--check", "--history", "--json", "--quick", "--since", "--transcripts", "--until"],
  hints: [
    "--since <day> and --until <day> bound the transcripts; --check exits non-zero on a regression",
  ],
});

const ARGS = new Set(process.argv.slice(2));
const QUICK = ARGS.has('--quick');
const AS_JSON = ARGS.has('--json');
const LOG = path.join(homedir(), '.claude', 'logs', 'slow-audit.jsonl');
// Layer 6 keeps its own log, so a machine snapshot's delta is never computed against a
// transcript record (they share no fields) and --history stays one kind of row.
const TRANSCRIPT_LOG = path.join(homedir(), '.claude', 'logs', 'slow-audit-transcripts.jsonl');
// 2026-10-09 (hook speed fixes): --check turns the transcript record into alarms. The verdict file
// is OVERWRITTEN each run (it answers "is anything over its limit now?"); the history stays in
// TRANSCRIPT_LOG, so nothing a before/after comparison reads moves.
const CHECK = ARGS.has('--check');
const ALARMS_FILE = path.join(homedir(), '.claude', 'logs', 'slow-audit-alarms.json');
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] ?? null : null;
};

// Cairo, via Intl. Never `TZ=Africa/Cairo` in a shell here: it silently returns UTC under MSYS.
const cairo = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(',', '');

const num = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? null : Number(n.toFixed(d)));
const MB = (bytes) => num(bytes / 1048576, 0);

function run(cmd, args, { stdin = '', cwd, timeout = 60_000, env } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let settled = false;
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, windowsHide: true });
    let out = '', err = '';
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err, ms: performance.now() - t0 });
    };
    const timer = setTimeout(() => { child.kill(); done(null); }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => done(null));
    child.on('close', done);
    child.stdin.end(stdin);
  });
}

const ps = (script, timeout = 90_000) =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout });

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — the machine. Pages Input/sec FIRST; it is the only counter that
// distinguishes "out of RAM" from "busy", and the one a disk reading hides.
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 `Memory\Pages Input/sec` IS FIRST AND IS THE TEST. It counts hard faults — the ones that
// go to disk — and it is the only counter here that separates "out of RAM" from "busy".
// `PhysicalDisk % Idle Time` is read ONLY so the report can say out loud that it proves nothing:
// an NVMe serves thousands of random 4K faults a second at a queue depth near zero and still
// reports idle, which is how a 2026-09-17 audit concluded from "99.6-99.9% idle, 0.00 queue"
// that paging was not involved. Pinned by tests/slow-audit.test.ts.
export const MACHINE_COUNTERS = [
  '\\Memory\\Pages Input/sec',
  '\\Memory\\Available MBytes',
  '\\Processor(_Total)\\% Processor Time',
  '\\PhysicalDisk(_Total)\\% Idle Time',
];

async function machine() {
  // Single-quoted in PowerShell, so the backslashes are literal and must NOT be escaped.
  const counters = MACHINE_COUNTERS.map((c) => `'${c}'`).join(',');
  const script = `
$ErrorActionPreference='SilentlyContinue'
$c = Get-Counter -Counter ${counters} -SampleInterval 1 -MaxSamples 5
$o = @{}
foreach ($g in ($c.CounterSamples | Group-Object Path)) {
  $v = $g.Group | ForEach-Object { $_.CookedValue }
  $key = ($g.Name -split '\\\\')[-1]
  $o[$key] = @{ avg = [math]::Round((($v | Measure-Object -Average).Average),1); max = [math]::Round((($v | Measure-Object -Maximum).Maximum),1) }
}
$os = Get-CimInstance Win32_OperatingSystem
$o['totalMB'] = [math]::Round($os.TotalVisibleMemorySize/1024)
$o['commitPct'] = [math]::Round(100*($os.TotalVirtualMemorySize-$os.FreeVirtualMemory)/$os.TotalVirtualMemorySize)
$o | ConvertTo-Json -Depth 4 -Compress
`;
  const r = await ps(script);
  let j = {};
  try { j = JSON.parse(r.out.trim()); } catch { /* fails open: reported as nulls */ }
  const pick = (k) => j[k] ?? {};
  return {
    pagesInPerSec: num(pick('pages input/sec').avg, 0),
    pagesInPeak: num(pick('pages input/sec').max, 0),
    availableMB: num(pick('available mbytes').avg, 0),
    totalMB: j.totalMB ?? null,
    commitPct: j.commitPct ?? null,
    cpuPct: num(pick('% processor time').avg, 1),
    diskIdlePct: num(pick('% idle time').avg, 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — the Claude app. Its renderer grows with open transcript, and on a
// 16 GB box it is the largest single consumer long before any session's work is.
// ─────────────────────────────────────────────────────────────────────────────
async function app() {
  const script = `
$ErrorActionPreference='SilentlyContinue'
$p = Get-Process claude
if (-not $p) { '{}'; exit }
$ids = ($p | Sort-Object WorkingSet64 -Descending | Select-Object -First 6).Id
$s1 = @{}; foreach ($i in $ids) { $q = Get-Process -Id $i; if ($q) { $s1[[string]$i] = $q.CPU } }
Start-Sleep -Seconds 6
$top = @()
foreach ($i in $ids) {
  $q = Get-Process -Id $i; if (-not $q -or -not $s1.ContainsKey([string]$i)) { continue }
  $top += @{
    pid = $i
    corePct = [math]::Round(100*($q.CPU - $s1[[string]$i])/6,1)
    wsMB = [math]::Round($q.WorkingSet64/1MB)
    upH = [math]::Round(((Get-Date)-$q.StartTime).TotalHours,1)
  }
}
$engines = (Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -match 'serverName' }).Count
@{
  procCount = $p.Count
  totalWsMB = [math]::Round((($p | Measure-Object WorkingSet64 -Sum).Sum)/1MB)
  engines   = $engines
  top       = $top
} | ConvertTo-Json -Depth 4 -Compress
`;
  const r = await ps(script);
  try {
    const j = JSON.parse(r.out.trim());
    const top = [].concat(j.top ?? []);
    return {
      procCount: j.procCount ?? null,
      totalWsMB: j.totalWsMB ?? null,
      engines: j.engines ?? null,
      busiest: top.sort((a, b) => (b.corePct ?? 0) - (a.corePct ?? 0))[0] ?? null,
      top,
    };
  } catch {
    return { procCount: null, totalWsMB: null, engines: null, busiest: null, top: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — transcripts. What the renderer is actually holding. A session's cost
// to the app scales with its transcript, which is why a long session is not free
// to leave open even when it is idle.
// ─────────────────────────────────────────────────────────────────────────────
function transcripts() {
  const root = path.join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return { projects: [], totalMB: null, hot: [] };
  const projects = [];
  let total = 0;
  const hot = [];
  const dayAgo = Date.now() - 86_400_000;
  for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    let bytes = 0, files = 0;
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const st = statSync(path.join(dir, f));
        bytes += st.size; files += 1;
        if (st.mtimeMs > dayAgo) hot.push({ project: name, file: f, mb: MB(st.size), mtime: cairo(st.mtime) });
      }
    } catch { continue; }
    if (files) { projects.push({ project: name, files, mb: MB(bytes) }); total += bytes; }
  }
  projects.sort((a, b) => b.mb - a.mb);
  hot.sort((a, b) => b.mb - a.mb);
  return { projects: projects.slice(0, 6), totalMB: MB(total), hot: hot.slice(0, 8) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 4 — hooks. Every PreToolUse hook is a separate node process, and they
// block the tool call — but Claude Code starts every matching hook AT ONCE, so the
// call waits for the SLOWEST one, not for the sum. The sum is CPU the box pays.
// Same split as the CI layer below: the wait and the cost are reported apart,
// and quoting one as the other is how a ~250ms wait got read as a 1,008ms one.
// The slowest hook timed ALONE is a floor on the wait: ten spawns at once contend
// for the same cores and RAM, so a starved box waits longer than any one of them.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The DECLARED probe list, before any existence filter.
 *
 * 🔴 The declaration and the filter are separate on purpose. tests/slow-audit.test.ts asserts
 * that no acting hook is listed here, and if it inspected the FILTERED list instead, the
 * assertion would quietly stop being able to fire on any machine where that hook's file happens
 * to be missing — a test that can only see what exists is a test that fails open. That is not
 * hypothetical: the first version of this pair passed a deliberate break for exactly that
 * reason, because the break named a path `existsSync` then removed.
 *
 * `fires` lists the tool kinds whose settings.json matcher this hook is registered under.
 * dev-server-reaper.mjs and scratchpad-guard's `sweep` are deliberately ABSENT: they stop
 * processes and archive files. An audit must not act.
 *
 * @typedef {[label: string, script: string, args: string[], fires: string[]]} HookProbe
 *
 * @param {string} projectDir
 * @returns {HookProbe[]}
 */
export const HOOK_PROBES = (projectDir) => {
  const g = path.join(homedir(), '.claude', 'hooks');
  const p = path.join(projectDir, '.claude', 'hooks');
  return [
    ['weekly-review-readonly', path.join(g, 'weekly-review-readonly.mjs'), [], ['bash', 'edit']],
    ['scratchpad-guard pre', path.join(g, 'scratchpad-guard.mjs'), ['pre'], ['bash']],
    ['bash-guard', path.join(p, 'bash-guard.mjs'), [], ['bash']],
    ['push-typecheck-guard', path.join(p, 'push-typecheck-guard.mjs'), [], ['bash']],
    ['module-memory-injector', path.join(p, 'module-memory-injector.mjs'), [], ['bash', 'edit', 'grep', 'read']],
    ['trap-injector', path.join(p, 'trap-injector.mjs'), [], ['bash', 'edit', 'grep']],
    ['session-lock beat', path.join(p, 'session-lock.mjs'), ['beat'], ['bash', 'edit']],
    ['mobile-freeze-guard', path.join(p, 'mobile-freeze-guard.mjs'), [], ['bash', 'edit']],
    ['protected-file-guard', path.join(p, 'protected-file-guard.mjs'), [], ['bash', 'edit']],
    ['primary-write-guard', path.join(p, 'primary-write-guard.mjs'), [], ['edit']],
    ['risky-allow-guard', path.join(p, 'risky-allow-guard.mjs'), [], ['edit']],
  ];
};

/**
 * The probes actually timed on this machine: the declaration, minus anything not installed.
 *
 * @param {string} projectDir
 * @returns {HookProbe[]}
 */
export const HOOKS = (projectDir) => HOOK_PROBES(projectDir).filter(([, script]) => existsSync(script));

/**
 * The per-tool-call cost of a set of timed hooks, split the way they are paid.
 *
 * `wait*` is the SLOWEST hook registered for that tool kind — matching hooks run in parallel, so
 * that is how long the call is held. `cpu*` is the SUM — every one of them is still a process the
 * box has to create. Never report the sum as the wait (the 2026-10-08 audit did: 1,008ms "per Bash
 * call" was CPU across ten processes, not time the call stood still).
 *
 * @param {{label: string, ms: number, fires: string[]}[]} rows
 */
export function hookCost(rows) {
  const of = (kind) => rows.filter((r) => r.fires.includes(kind));
  const wait = (kind) => (of(kind).length ? num(Math.max(...of(kind).map((r) => r.ms)), 0) : 0);
  const cpu = (kind) => num(of(kind).reduce((a, r) => a + r.ms, 0), 0);
  const slowest = (kind) => of(kind).reduce((best, r) => (best === null || r.ms > best.ms ? r : best), null)?.label ?? null;
  return {
    rows: [...rows].sort((a, b) => b.ms - a.ms),
    waitPerBashCallMs: wait('bash'),
    waitPerEditCallMs: wait('edit'),
    waitPerGrepCallMs: wait('grep'),
    waitPerReadCallMs: wait('read'),
    slowestBashHook: slowest('bash'),
    cpuPerBashCallMs: cpu('bash'),
    cpuPerEditCallMs: cpu('edit'),
    spawnsPerBashCall: of('bash').length,
  };
}

async function hooks(projectDir) {
  const payload = JSON.stringify({
    session_id: 'slow-audit-probe',
    transcript_path: '',
    cwd: projectDir,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git status --porcelain', description: 'slow-audit read-only probe' },
  });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };

  // Bare node startup is the floor every hook pays; without it the per-hook figures
  // read as if the script were slow when the cost is process creation.
  const base = [];
  for (let i = 0; i < 3; i++) base.push((await run(process.execPath, ['-e', '0'], { cwd: projectDir, env, timeout: 20_000 })).ms);
  const baseline = num(Math.min(...base), 0);

  const rows = [];
  for (const [label, script, args, fires] of HOOKS(projectDir)) {
    const times = [];
    for (let i = 0; i < 3; i++) {
      const r = await run(process.execPath, [script, ...args], { stdin: payload, cwd: projectDir, env, timeout: 30_000 });
      times.push(r.ms);
    }
    rows.push({ label, ms: num(Math.min(...times), 0), fires });
  }
  return { baselineMs: baseline, ...hookCost(rows) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 5 — CI. The critical path is the SLOWEST job, not the sum; the sum is
// what is billed. Reporting one as the other is how a wait gets blamed on a bill.
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 A SKIPPED job or step carries `startedAt: "0001-01-01T00:00:00Z"`, NOT null. Subtracting
// that sentinel from a real `completedAt` yields about 63 billion seconds, so a plain max-by-
// duration reports the one step that never ran as the step that dominated the job. It is the
// fail-open shape this repo already names elsewhere — an ABSENT answer arriving in the shape of
// a very large one — and it is not hypothetical here: the first version of this script reported
// main's `validate` as 719s of "Test" when that run had built for 246s and skipped Test
// entirely, which would have sent someone to optimise a step that does not run on that event.
//
// The arithmetic is deliberately in Node rather than in a `gh --jq` expression so it can be
// exercised against a fixture; tests/slow-audit.test.ts feeds it exactly that sentinel.
const SENTINEL_YEAR = '0001';

/**
 * Seconds between two ISO timestamps, or null when the span is not a real duration — which
 * includes GitHub's skipped-step sentinel, a missing value and a negative span.
 *
 * @param {unknown} startedAt
 * @param {unknown} completedAt
 * @returns {number | null}
 */
export function spanSeconds(startedAt, completedAt) {
  if (typeof startedAt !== 'string' || typeof completedAt !== 'string') return null;
  if (startedAt.startsWith(SENTINEL_YEAR) || completedAt.startsWith(SENTINEL_YEAR)) return null;
  const a = Date.parse(startedAt), b = Date.parse(completedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const secs = (b - a) / 1000;
  return secs < 0 ? null : secs;
}

/**
 * Reduce one `gh run view --json jobs` payload to the two figures that must never be confused:
 * the CRITICAL PATH (the slowest job — what the wait actually is, because jobs run in parallel)
 * and the BILLED minutes (the sum, with every job rounded UP to a whole minute, which is how
 * Actions charges). Quoting either as the other is how a wait gets blamed on a bill.
 *
 * @typedef {{ name: string, secs: number, dominant: string | null, dominantSecs: number | null }} JobSummary
 * @typedef {{ criticalPathSecs: number, billedSecs: number, billedMinutesRounded: number, jobs: JobSummary[] }} RunSummary
 *
 * @param {unknown} payload
 * @returns {RunSummary | null}
 */
export function summarizeRun(payload) {
  const all = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const jobs = [];
  for (const j of all) {
    if (j?.conclusion !== 'success') continue;          // skipped / cancelled / failed
    const secs = spanSeconds(j.startedAt, j.completedAt);
    if (secs === null) continue;
    const steps = (Array.isArray(j.steps) ? j.steps : [])
      .map((s) => ({ name: s?.name, secs: s?.conclusion === 'success' ? spanSeconds(s.startedAt, s.completedAt) : null }))
      .filter((s) => s.secs !== null);
    const dominant = steps.sort((a, b) => b.secs - a.secs)[0] ?? null;
    jobs.push({
      name: j.name,
      secs: Math.round(secs),
      dominant: dominant?.name ?? null,
      dominantSecs: dominant ? Math.round(dominant.secs) : null,
    });
  }
  if (!jobs.length) return null;
  return {
    criticalPathSecs: Math.max(...jobs.map((j) => j.secs)),
    billedSecs: jobs.reduce((a, j) => a + j.secs, 0),
    billedMinutesRounded: jobs.reduce((a, j) => a + Math.ceil(j.secs / 60), 0),
    jobs,
  };
}

async function ci(projectDir) {
  const out = {};
  for (const [key, ev, extra] of [['pr', 'pull_request', []], ['main', 'push', ['--branch', 'main']]]) {
    const list = await run('gh', [
      'run', 'list', '--workflow', 'ci.yml', '--event', ev, '--status', 'success',
      '--limit', '4', ...extra, '--json', 'databaseId,headBranch',
    ], { cwd: projectDir, timeout: 60_000 });
    let runs = [];
    try { runs = JSON.parse(list.out.trim() || '[]'); } catch { runs = []; }
    const samples = [];
    for (const r of runs.slice(0, 3)) {
      const v = await run('gh', ['run', 'view', String(r.databaseId), '--json', 'jobs'], { cwd: projectDir, timeout: 60_000 });
      let s = null;
      try { s = summarizeRun(JSON.parse(v.out.trim() || '{}')); } catch { s = null; }
      if (s) samples.push({ id: r.databaseId, branch: r.headBranch, ...s });
    }
    const med = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
    out[key] = {
      samples,
      medianCriticalPathSecs: med(samples.map((s) => s.criticalPathSecs)),
      medianBilledMinutes: med(samples.map((s) => s.billedMinutesRounded)),
    };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 6 — what the sessions actually WAITED for, read back from their own
// transcripts. Layers 1-4 are a snapshot of this minute; this is the record of
// every turn, for EVERY account on this laptop — all of them write to the same
// ~/.claude/projects, keyed by folder, never by account.
// ─────────────────────────────────────────────────────────────────────────────
// WHY (measured 2026-10-08). A snapshot cannot see the two costs that dominated that day: 77
// auto-compactions at a median 131s each (2.5 hours of frozen sessions), and every compaction
// re-running ALL SessionStart hooks — 1,520 `SessionStart:compact` hook runs against 743 at startup
// since 5 Oct, the worktree provisioning sweep among them (worst 17.5s). Both live only in the
// transcripts, and a before/after comparison needs the same numbers computed the same way on both
// sides, so the arithmetic is a pure fold that tests/slow-audit.test.ts feeds a fixture.
// It reads files only; it starts no process.

/**
 * Context-size buckets, in tokens: a turn's wait grows with the context it is sent with.
 *
 * @type {[number, string][]}
 */
export const CONTEXT_BUCKETS = [
  [100_000, '<100k'],
  [150_000, '100-150k'],
  [200_000, '150-200k'],
  [300_000, '200-300k'],
  [400_000, '300-400k'],
  [Infinity, '400k+'],
];

/** @param {number} tokens */
export const contextBucket = (tokens) => CONTEXT_BUCKETS.find(([max]) => tokens < max)[1];

/** @param {number[]} xs @param {number} q */
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

const CAIRO_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
/** @param {number} ms */
export const cairoDay = (ms) => CAIRO_DAY.format(new Date(ms));

/**
 * Midnight in Cairo on `day` (YYYY-MM-DD), as epoch ms — DST-correct, never `TZ=Africa/Cairo`.
 *
 * @param {string} day
 * @returns {number | null}
 */
export function cairoMidnightMs(day) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(guess)) return null;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Africa/Cairo', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(guess)).map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return guess - (wall - guess);
}

/**
 * A hook's name from its command line: `node "C:/…/hooks/relay-capture.mjs"` → `relay-capture`,
 * keeping a mode word (`session-lock start`, `scratchpad-guard sweep`) but never a `--flag`.
 * A hook that declares a `statusMessage` is recorded with THAT in `command` ("Checking memory
 * index budget"), so the text itself is the best name left — never the bare `hookName`
 * (`SessionStart:compact`), which would fold every such hook into one row.
 *
 * @param {unknown} command
 * @param {unknown} [fallback]
 */
export function hookLabel(command, fallback = '') {
  const m = /([\w.-]+)\.mjs"?((?:\s+[a-z][\w-]*)?)/i.exec(String(command ?? ''));
  if (m) return `${m[1]}${m[2] ? ` ${m[2].trim()}` : ''}`;
  return String(command || fallback || '?').slice(0, 48);
}

// 2026-10-09 (hook speed fixes). The tools whose wall time a hook can stretch: every one of them is
// held by its PreToolUse/PostToolUse hooks, and a Read or Grep is otherwise near-instant, so its
// wall time is close to pure hook overhead. Bash and PowerShell count only in the foreground — a
// `run_in_background` call returns at once, and counting it would drag the median DOWN.
/** @type {Set<string>} */
const TIMED_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'PowerShell']);
const BACKGROUNDABLE_TOOLS = new Set(['Bash', 'PowerShell']);
// Claude Code's own nine-section summary template, which the owner's Compact Instructions replace
// with four headings. Either heading is enough: both are unique to that template. Only as a heading
// at the start of a line ("1. Primary Request and Intent:", "## 1. …", "1. **…:**"): a four-heading
// summary that quotes the phrase mid-sentence (one did, 2026-10-09 08:19) is not the template, and
// this limit is zero, so one such quote would alarm every morning.
const DEFAULT_SUMMARY_TEMPLATE =
  /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?(?:\d+\.[ \t]*)?(?:\*\*)?(?:Primary Request and Intent|Key Technical Concepts)\b/m;

/**
 * @typedef {'phoenix' | 'other'} ProjectKind
 * @typedef {{ n: number, p50Ms: number | null, p90Ms: number | null }} ToolWallRow
 */

/**
 * The fold. `begin()` once per transcript file, `line(raw)` for each of its lines, `finish()` for
 * the summary. Only lines timestamped inside [sinceMs, untilMs) count.
 *
 * - a compaction is a `system/compact_boundary` line; its `compactMetadata.durationMs` is the stall;
 * - the context it leaves behind is the FIRST assistant usage after it (the floor every later turn
 *   starts from);
 * - a turn's wait runs from a user line (a prompt or a tool result) to the next assistant line
 *   carrying usage, bucketed by that assistant line's context;
 * - a hook run is any attachment carrying `durationMs`, or one entry of a `stop_hook_summary`;
 *   Stop hooks run in parallel, so the turn-end WAIT is the slowest of them, not the sum;
 * - a SessionStart hook run's source (startup, resume, clear, compact) is after the colon in its
 *   `hookName`.
 *
 * Added 2026-10-09 (hook speed fixes), so a fix to the hooks can be proved by the sessions' own
 * records rather than by a probe timed on an idle box:
 * - `toolWall`: a tool call's wall time, `tool_use` (assistant line) to its `tool_result` (user
 *   line), matched by id inside one file, grouped by project kind (`begin(folderName)`: a folder
 *   named like phoenix is 'phoenix', anything else — or no name — is 'other') and by tool;
 * - `sessionStartWait`: one start = every SessionStart row sharing a `toolUseID` in one file; its
 *   wait is the SLOWEST row (they run in parallel), never the sum;
 * - `repeatedHookText`: `hook_additional_context` text only — module memory (`nested_memory`) and
 *   rules files (`instructions`) are never measured against a limit — counted as repeated when the
 *   same text already arrived in this file since the last compaction;
 * - `compactSummaries`: the size of each compaction summary, and how many used the default
 *   nine-section template.
 *
 * @param {{ sinceMs?: number, untilMs?: number }} [window]
 */
export function createTranscriptStats({ sinceMs = 0, untilMs = Infinity } = {}) {
  let sessions = 0;
  /** @type {{ day: string, secs: number, preTokens: number | null }[]} */
  const compactions = [];
  /** @type {number[]} */
  const floors = [];
  /** @type {Map<string, number[]>} */
  const latency = new Map();
  /** @type {Map<string, number[]>} */
  const hooks = new Map();
  /** @type {number[]} */
  const stopWaits = [];
  /** @type {Record<string, number>} */
  const startRuns = {};
  const injected = { instructions: 0, moduleMemory: 0, /** @type {Record<string, number>} */ hookContext: {} };
  const push = (/** @type {Map<string, number[]>} */ map, /** @type {string} */ key, /** @type {number} */ v) => {
    const list = map.get(key);
    if (list) list.push(v);
    else map.set(key, [v]);
  };

  let counted = false;
  /** @type {number | null} */
  let pendingUserMs = null;
  let afterCompact = false;

  // 2026-10-09 (hook speed fixes) — state for the four added measurements (see the doc above).
  /** @type {Record<ProjectKind, Map<string, number[]>>} */
  const toolWall = { phoenix: new Map(), other: new Map() };
  /** @type {ProjectKind} */
  let kind = 'other';
  // Open tool calls of THIS file only: a tool_use id is never closed by a result in another file.
  /** @type {Map<string, { tool: string, ts: number }>} */
  let openTools = new Map();
  // Files seen so far; scopes a start's toolUseID to its own file (a resumed session's file can
  // carry a copy of the same ids).
  let fileSeq = 0;
  /** @type {Map<string, number>} */
  const startWait = new Map();
  /** @type {Set<string>} */
  let seenHookText = new Set();
  const hookText = { chars: 0, repeatedChars: 0 };
  /** @type {number[]} */
  const summaryChars = [];
  let summariesInDefaultNine = 0;

  /**
   * Hook-added text: reset the seen-set at a compaction (the context really was emptied, so a
   * re-injection after it is new), otherwise hash each text and count it as repeated when this
   * file already received it in this compaction cycle. `inWindow` false only SEEDS the set, so
   * a session that spans the window's start does not read its first in-window repeat as new.
   *
   * @param {any} o
   * @param {boolean} inWindow
   */
  const noteHookText = (o, inWindow) => {
    if (o?.type === 'system' && o.subtype === 'compact_boundary') { seenHookText = new Set(); return; }
    const a = o?.attachment;
    if (a?.type !== 'hook_additional_context') return;
    for (const piece of Array.isArray(a.content) ? a.content : [a.content]) {
      const text = typeof piece === 'string' ? piece : String(piece ?? '');
      if (!text) continue;
      const hash = createHash('sha1').update(text).digest('hex');
      const repeated = seenHookText.has(hash);
      seenHookText.add(hash);
      if (!inWindow) continue;
      hookText.chars += text.length;
      if (repeated) hookText.repeatedChars += text.length;
    }
  };

  return {
    /** @param {string} [folderName] the transcript's project folder; absent counts as 'other' */
    begin(folderName) {
      counted = false;
      pendingUserMs = null;
      afterCompact = false;
      kind = /phoenix/i.test(String(folderName ?? '')) ? 'phoenix' : 'other';
      openTools = new Map();
      seenHookText = new Set();
      fileSeq += 1;
    },
    /** @param {string} raw */
    line(raw) {
      let o;
      try { o = JSON.parse(raw); } catch { return; }
      const ts = Date.parse(o?.timestamp ?? '');
      if (Number.isNaN(ts) || ts < sinceMs || ts >= untilMs) {
        if (ts < sinceMs) noteHookText(o, false);
        return;
      }
      if (!counted) { counted = true; sessions += 1; }
      noteHookText(o, true);

      const a = o.attachment;
      if (a) {
        if (typeof a.durationMs === 'number' && a.hookEvent) {
          push(hooks, `${a.hookEvent} ${hookLabel(a.command, a.hookName)}`, a.durationMs);
          if (a.hookEvent === 'SessionStart') {
            const source = String(a.hookName ?? '').split(':')[1] || 'unlabelled';
            startRuns[source] = (startRuns[source] ?? 0) + 1;
            if (typeof a.toolUseID === 'string' && a.toolUseID) {
              const key = `${fileSeq}\u0000${a.toolUseID}`;
              startWait.set(key, Math.max(startWait.get(key) ?? 0, a.durationMs));
            }
          }
        }
        if (a.type === 'instructions') {
          for (const f of Array.isArray(a.files) ? a.files : []) injected.instructions += String(f?.content ?? '').length;
        } else if (a.type === 'nested_memory') {
          injected.moduleMemory += (typeof a.content === 'string' ? a.content : JSON.stringify(a.content ?? '')).length;
        } else if (a.type === 'hook_additional_context') {
          const event = String(a.hookName ?? a.hookEvent ?? 'other').split(':')[0];
          const body = Array.isArray(a.content) ? a.content.join('\n') : String(a.content ?? '');
          injected.hookContext[event] = (injected.hookContext[event] ?? 0) + body.length;
        }
        return;
      }
      if (o.type === 'system' && o.subtype === 'compact_boundary') {
        const m = o.compactMetadata ?? {};
        compactions.push({ day: cairoDay(ts), secs: (Number(m.durationMs) || 0) / 1000, preTokens: Number.isFinite(m.preTokens) ? m.preTokens : null });
        afterCompact = true;
        pendingUserMs = null;
        return;
      }
      if (o.type === 'system' && o.subtype === 'stop_hook_summary') {
        const timed = (Array.isArray(o.hookInfos) ? o.hookInfos : []).filter((h) => typeof h?.durationMs === 'number');
        for (const h of timed) push(hooks, `Stop ${hookLabel(h.command)}`, h.durationMs);
        if (timed.length) stopWaits.push(Math.max(...timed.map((h) => h.durationMs)));
        return;
      }
      // 2026-10-09 (hook speed fixes): tool results close the calls opened below, and compaction
      // summaries are sized. Neither returns, so the turn-wait arithmetic after it is unchanged.
      if (o.type === 'user') {
        const content = o.message?.content;
        for (const b of Array.isArray(content) ? content : []) {
          if (b?.type !== 'tool_result') continue;
          const open = openTools.get(b.tool_use_id);
          if (!open) continue;
          openTools.delete(b.tool_use_id);
          if (ts >= open.ts) push(toolWall[kind], open.tool, ts - open.ts);
        }
        if (o.isCompactSummary === true) {
          const text = typeof content === 'string'
            ? content
            : (Array.isArray(content) ? content : []).filter((b) => typeof b?.text === 'string').map((b) => b.text).join('\n');
          summaryChars.push(text.length);
          if (DEFAULT_SUMMARY_TEMPLATE.test(text)) summariesInDefaultNine += 1;
        }
      }
      if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
        for (const b of o.message.content) {
          if (b?.type !== 'tool_use' || typeof b.id !== 'string' || !TIMED_TOOLS.has(b.name)) continue;
          if (BACKGROUNDABLE_TOOLS.has(b.name) && b.input?.run_in_background === true) continue;
          openTools.set(b.id, { tool: b.name, ts });
        }
      }
      if (o.type === 'user' && !o.isMeta) {
        pendingUserMs = ts;
        return;
      }
      if (o.type === 'assistant' && o.message?.usage) {
        const u = o.message.usage;
        const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (afterCompact) { floors.push(ctx); afterCompact = false; }
        if (pendingUserMs !== null) {
          const secs = (ts - pendingUserMs) / 1000;
          if (secs > 0 && secs < 600) push(latency, contextBucket(ctx), secs);
          pendingUserMs = null;
        }
      }
    },
    finish() {
      /** @type {Map<string, { count: number, secs: number }>} */
      const days = new Map();
      for (const c of compactions) {
        const d = days.get(c.day) ?? { count: 0, secs: 0 };
        d.count += 1;
        d.secs += c.secs;
        days.set(c.day, d);
      }
      const secs = compactions.map((c) => c.secs);
      const perSessionKB = (/** @type {number} */ chars) => (sessions ? num(chars / sessions / 1024, 0) : null);
      // 2026-10-09 (hook speed fixes). A reduce, not Math.max(...xs): a long window can hold more
      // samples than a spread can pass as arguments.
      const maxOf = (/** @type {number[]} */ xs) => (xs.length ? xs.reduce((x, y) => (y > x ? y : x)) : null);
      /** @returns {Record<string, ToolWallRow>} */
      const wallOf = (/** @type {Map<string, number[]>} */ byTool) => {
        /** @type {Record<string, ToolWallRow>} */
        const out = {};
        for (const tool of TIMED_TOOLS) {
          const xs = byTool.get(tool);
          if (xs) out[tool] = { n: xs.length, p50Ms: quantile(xs, 0.5), p90Ms: quantile(xs, 0.9) };
        }
        return out;
      };
      const waits = [...startWait.values()];
      return {
        sessions,
        compactions: {
          count: compactions.length,
          hours: num(secs.reduce((x, y) => x + y, 0) / 3600, 1),
          p50Secs: num(quantile(secs, 0.5), 0),
          p90Secs: num(quantile(secs, 0.9), 0),
          medianPreTokens: quantile(/** @type {number[]} */ (compactions.map((c) => c.preTokens).filter((t) => t !== null)), 0.5),
          medianFloorTokens: quantile(floors, 0.5),
          byDay: [...days].sort(([x], [y]) => (x < y ? -1 : 1)).map(([day, d]) => ({ day, count: d.count, hours: num(d.secs / 3600, 1) })),
        },
        turnLatency: CONTEXT_BUCKETS.map(([, b]) => b)
          .filter((b) => latency.has(b))
          .map((b) => {
            const xs = /** @type {number[]} */ (latency.get(b));
            return { bucket: b, turns: xs.length, p50Secs: num(quantile(xs, 0.5), 1), p90Secs: num(quantile(xs, 0.9), 1) };
          }),
        hooks: [...hooks]
          .map(([hook, ms]) => ({ hook, n: ms.length, p50Ms: quantile(ms, 0.5), p90Ms: quantile(ms, 0.9), maxMs: Math.max(...ms) }))
          .sort((x, y) => y.n - x.n),
        stopWait: { turns: stopWaits.length, p50Ms: quantile(stopWaits, 0.5), p90Ms: quantile(stopWaits, 0.9) },
        sessionStartRuns: startRuns,
        injectedPerSessionKB: {
          instructions: perSessionKB(injected.instructions),
          moduleMemory: perSessionKB(injected.moduleMemory),
          hookContext: Object.fromEntries(Object.entries(injected.hookContext).map(([k, v]) => [k, perSessionKB(v)])),
        },
        // 2026-10-09 (hook speed fixes) — added after every existing field, which keep their shape.
        toolWall: { phoenix: wallOf(toolWall.phoenix), other: wallOf(toolWall.other) },
        sessionStartWait: { starts: waits.length, p50Ms: quantile(waits, 0.5), p90Ms: quantile(waits, 0.9), maxMs: maxOf(waits) },
        repeatedHookText: {
          chars: hookText.chars,
          repeatedChars: hookText.repeatedChars,
          share: hookText.chars ? num(hookText.repeatedChars / hookText.chars, 4) : null,
        },
        compactSummaries: {
          n: summaryChars.length,
          p50Chars: quantile(summaryChars, 0.5),
          maxChars: maxOf(summaryChars),
          defaultNine: summariesInDefaultNine,
        },
      };
    },
  };
}

/** Stream every top-level transcript touched since `sinceMs` through the fold. */
async function readTranscripts({ sinceMs, untilMs }) {
  const stats = createTranscriptStats({ sinceMs, untilMs });
  const root = path.join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return stats.finish();
  for (const project of readdirSync(root)) {
    const dir = path.join(root, project);
    let names = [];
    try {
      if (!statSync(dir).isDirectory()) continue;
      names = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch { continue; }
    for (const f of names) {
      const file = path.join(dir, f);
      try { if (statSync(file).mtimeMs < sinceMs) continue; } catch { continue; } // untouched since: nothing in the window
      stats.begin(project); // the folder name says whether this is a Phoenix session (toolWall)
      const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const l of rl) stats.line(l);
    }
  }
  return stats.finish();
}

/** The figures a before/after comparison reads, per day so windows of different length compare. */
export function transcriptRates(rec) {
  const days = rec?.days || 1;
  const dispatcher = (rec?.hooks ?? []).find((h) => /^PreToolUse hook-dispatch/.test(h.hook));
  return {
    compactionsPerDay: num((rec?.compactions?.count ?? 0) / days, 1),
    hoursCompactingPerDay: num((rec?.compactions?.hours ?? 0) / days, 1),
    startHookRunsOnCompactPerDay: num((rec?.sessionStartRuns?.compact ?? 0) / days, 0),
    stopWaitP50Ms: rec?.stopWait?.p50Ms ?? null,
    dispatcherP50Ms: dispatcher?.p50Ms ?? null,
    promptHookKBPerSession: rec?.injectedPerSessionKB?.hookContext?.UserPromptSubmit ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-09 (hook speed fixes) — the limits a transcript record is checked against, so a slowdown
// is caught the day it lands instead of when the owner next says "everything is slow". Each limit
// carries a MINIMUM SAMPLE: a quiet day with three Read calls must not alarm on one slow one.
// A value alarms only when it is strictly ABOVE its limit; at the limit is still clean.
// Module memory and rules files are deliberately absent — they are never measured against a limit.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @typedef {{ limit: number, minSample: number }} TranscriptLimit
 * @typedef {{ key: string, value: number, limit: number, hook?: string, say: string }} TranscriptAlarm
 */
export const TRANSCRIPT_LIMITS = {
  phoenixReadP50Ms: { limit: 400, minSample: 50 },          // toolWall.phoenix.Read, over n Read calls
  preToolUseP90Ms: { limit: 3000, minSample: 20 },          // each "PreToolUse …" hooks row, over its n
  preToolUseMaxMs: { limit: 60_000, minSample: 1 },         // each "PreToolUse …" hooks row, its worst run
  sessionStartP90Ms: { limit: 2500, minSample: 10 },        // sessionStartWait, over its starts
  userPromptSubmitP50Ms: { limit: 800, minSample: 20 },     // each "UserPromptSubmit …" hooks row
  stopWaitP50Ms: { limit: 800, minSample: 20 },             // stopWait, over its turns
  repeatedHookTextShare: { limit: 0.15, minSample: 50_000 }, // repeatedHookText.share, over its chars
  compactSummaryP50Chars: { limit: 10_000, minSample: 3 },  // compactSummaries, over n summaries
  compactDefaultNine: { limit: 0, minSample: 1 },           // any summary in the default template
  compactP50Secs: { limit: 90, minSample: 3 },              // compactions.p50Secs, over their count
};

const en = (/** @type {number} */ n) => n.toLocaleString('en-US');
// One plain sentence per limit, for the owner: no file names, and never a hook's name — that goes
// in the alarm's separate `hook` field, so the sentence reads the same whichever check was slow.
/** @type {Record<string, (value: number, limit: number) => string>} */
const ALARM_SAY = {
  phoenixReadP50Ms: (v, l) => `Opening a file in a Phoenix session took ${en(v)} ms in a typical case, above the ${en(l)} ms limit.`,
  preToolUseP90Ms: (v, l) => `One of the checks that run before each session action took ${en(v)} ms or more on its slowest tenth of runs, above the ${en(l)} ms limit.`,
  preToolUseMaxMs: (v, l) => `One of the checks that run before each session action held a session for ${en(num(v / 1000, 1))} seconds at its worst, above the ${en(num(l / 1000, 1))}-second limit.`,
  sessionStartP90Ms: (v, l) => `Opening or resuming a session, or carrying on after it summarised itself, kept it waiting ${en(v)} ms on the slowest tenth of starts, above the ${en(l)} ms limit.`,
  userPromptSubmitP50Ms: (v, l) => `Each message sent to a session waited ${en(v)} ms in a typical case for a check before work began, above the ${en(l)} ms limit.`,
  stopWaitP50Ms: (v, l) => `At the end of each reply, sessions waited ${en(v)} ms in a typical case for their closing checks, above the ${en(l)} ms limit.`,
  repeatedHookTextShare: (v, l) => `${en(num(v * 100, 1))}% of the text the checks add to sessions was a repeat of text the session already had, above the ${en(num(l * 100, 1))}% limit, so sessions fill up and freeze to summarise sooner.`,
  compactSummaryP50Chars: (v, l) => `When a session ran out of room, its typical summary ran to ${en(v)} characters, above the ${en(l)} limit, and a longer summary keeps the session frozen longer while it is written.`,
  compactDefaultNine: (v) => `${en(v)} session ${v === 1 ? 'summary' : 'summaries'} used the long default layout instead of the four-heading format you set.`,
  compactP50Secs: (v, l) => `When a session ran out of room and summarised itself, it froze for ${en(v)} seconds in a typical case, above the ${en(l)}-second limit.`,
};

/**
 * The limits a transcript record crossed. Pure: no file, no clock, no process — `--check` writes
 * what this returns, and tests/slow-audit.test.ts feeds it synthetic records.
 *
 * @param {any} rec a record as `--transcripts` builds it
 * @param {typeof TRANSCRIPT_LIMITS} [limits]
 * @returns {TranscriptAlarm[]}
 */
export function transcriptAlarms(rec, limits = TRANSCRIPT_LIMITS) {
  /** @type {TranscriptAlarm[]} */
  const alarms = [];
  /** @param {keyof typeof TRANSCRIPT_LIMITS} key @param {unknown} value @param {unknown} sample @param {string} [hook] */
  const over = (key, value, sample, hook) => {
    const L = limits[key];
    if (!L || typeof value !== 'number' || !Number.isFinite(value)) return;
    if (!(typeof sample === 'number' && sample >= L.minSample)) return; // a quiet day cannot alarm
    if (!(value > L.limit)) return;
    alarms.push({ key, value, limit: L.limit, ...(hook ? { hook } : {}), say: ALARM_SAY[key](value, L.limit) });
  };
  const read = rec?.toolWall?.phoenix?.Read;
  over('phoenixReadP50Ms', read?.p50Ms, read?.n);
  for (const h of Array.isArray(rec?.hooks) ? rec.hooks : []) {
    const label = typeof h?.hook === 'string' ? h.hook : '';
    if (label.startsWith('PreToolUse ')) {
      over('preToolUseP90Ms', h.p90Ms, h.n, label);
      over('preToolUseMaxMs', h.maxMs, h.n, label);
    } else if (label.startsWith('UserPromptSubmit ')) {
      over('userPromptSubmitP50Ms', h.p50Ms, h.n, label);
    }
  }
  over('sessionStartP90Ms', rec?.sessionStartWait?.p90Ms, rec?.sessionStartWait?.starts);
  over('stopWaitP50Ms', rec?.stopWait?.p50Ms, rec?.stopWait?.turns);
  over('repeatedHookTextShare', rec?.repeatedHookText?.share, rec?.repeatedHookText?.chars);
  over('compactSummaryP50Chars', rec?.compactSummaries?.p50Chars, rec?.compactSummaries?.n);
  over('compactDefaultNine', rec?.compactSummaries?.defaultNine, rec?.compactSummaries?.n);
  over('compactP50Secs', rec?.compactions?.p50Secs, rec?.compactions?.count);
  return alarms;
}

function transcriptTable(r, prev) {
  const L = [];
  L.push('');
  L.push(`PHOENIX SLOW AUDIT — TRANSCRIPTS  ${r.since} → ${r.until} Cairo  (${r.days} days, ${r.sessions} sessions, every account on this laptop)`);
  L.push('='.repeat(78));
  L.push('');
  const c = r.compactions;
  L.push(`COMPACTIONS  ${c.count}, ${c.hours} hours frozen   each p50 ${c.p50Secs}s, p90 ${c.p90Secs}s`);
  L.push(`  context when it fired ${c.medianPreTokens ?? '-'} tokens (median)   context right after ${c.medianFloorTokens ?? '-'}  <- the floor every later turn starts from`);
  for (const d of c.byDay.slice(-7)) L.push(`    ${d.day}  ${String(d.count).padStart(4)}  ${d.hours} h`);
  L.push('');
  L.push('TURN WAIT BY CONTEXT SIZE  (user line -> next assistant line)');
  for (const t of r.turnLatency) L.push(`  ${t.bucket.padEnd(10)} ${String(t.turns).padStart(7)} turns   p50 ${t.p50Secs}s   p90 ${t.p90Secs}s`);
  L.push('');
  L.push(`TURN END  slowest blocking Stop hook p50 ${r.stopWait.p50Ms ?? '-'}ms, p90 ${r.stopWait.p90Ms ?? '-'}ms over ${r.stopWait.turns} turns`);
  L.push('HOOKS  (as recorded in the transcripts, under real load)');
  for (const h of r.hooks.slice(0, 14)) L.push(`  ${h.hook.padEnd(48)} n ${String(h.n).padStart(6)}   p50 ${String(h.p50Ms).padStart(6)}ms   p90 ${String(h.p90Ms).padStart(6)}ms   max ${h.maxMs}ms`);
  L.push('');
  L.push(`SESSIONSTART HOOK RUNS BY SOURCE  ${Object.entries(r.sessionStartRuns).map(([k, v]) => `${k} ${v}`).join('   ')}`);
  const inj = r.injectedPerSessionKB;
  L.push(`TEXT LOADED PER SESSION  rules files ${inj.instructions} KB (incl. reloads after compaction)   module memory ${inj.moduleMemory} KB   hooks ${Object.entries(inj.hookContext).map(([k, v]) => `${k} ${v} KB`).join(', ')}`);
  L.push('');
  if (prev) {
    const a = transcriptRates(prev), b = transcriptRates(r);
    const row = (label, k, unit = '') => `  ${label.padEnd(34)} ${String(a[k] ?? '-').padStart(7)}${unit} -> ${String(b[k] ?? '-').padStart(7)}${unit}`;
    L.push(`AGAINST THE PREVIOUS TRANSCRIPT AUDIT (${prev.since} → ${prev.until})`);
    L.push(row('compactions per day', 'compactionsPerDay'));
    L.push(row('hours compacting per day', 'hoursCompactingPerDay', 'h'));
    L.push(row('startup hooks re-run on compact/day', 'startHookRunsOnCompactPerDay'));
    L.push(row('turn-end wait p50', 'stopWaitP50Ms', 'ms'));
    L.push(row('hook dispatcher p50', 'dispatcherP50Ms', 'ms'));
    L.push(row('prompt-hook text per session', 'promptHookKBPerSession', 'KB'));
  } else {
    L.push('AGAINST THE PREVIOUS TRANSCRIPT AUDIT   none yet — this one is the baseline.');
  }
  L.push('');
  L.push(`log: ${TRANSCRIPT_LOG}`);
  L.push('');
  return L.join('\n');
}

async function transcriptAudit() {
  const sinceArg = argValue('--since');
  const untilArg = argValue('--until');
  const sinceMs = sinceArg ? cairoMidnightMs(sinceArg) : Date.now() - 3 * 86_400_000;
  const untilMs = untilArg ? cairoMidnightMs(untilArg) : Date.now();
  if (sinceMs === null || untilMs === null || untilMs <= sinceMs) {
    console.error('usage: --transcripts [--since YYYY-MM-DD] [--until YYYY-MM-DD]  (Cairo days; --until is exclusive)');
    process.exitCode = 2;
    return;
  }
  const summary = await readTranscripts({ sinceMs, untilMs });
  const rec = {
    at: cairo(),
    atISO: new Date().toISOString(),
    since: cairo(new Date(sinceMs)),
    until: cairo(new Date(Math.min(untilMs, Date.now()))),
    days: num((Math.min(untilMs, Date.now()) - sinceMs) / 86_400_000, 2),
    ...summary,
  };
  let prev = null;
  try {
    prev = readFileSync(TRANSCRIPT_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).at(-1) ?? null;
  } catch { prev = null; }
  try {
    mkdirSync(path.dirname(TRANSCRIPT_LOG), { recursive: true });
    appendFileSync(TRANSCRIPT_LOG, JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* still useful without its log */ }
  console.log(AS_JSON ? JSON.stringify(rec, null, 2) : transcriptTable(rec, prev));

  // 2026-10-09 (hook speed fixes): --check. The record above is built and logged exactly as
  // without it; this only reads it. The exit code stays 0 whatever crossed — a scheduled run must
  // not read a crossed limit as a failed audit — and with --json the sentences go to stderr so
  // stdout stays one parseable document.
  if (CHECK) {
    const alarms = transcriptAlarms(rec);
    const say = AS_JSON ? console.error : console.log;
    if (alarms.length) for (const alarm of alarms) say(alarm.say);
    else say('no limit crossed');
    try {
      mkdirSync(path.dirname(ALARMS_FILE), { recursive: true });
      writeFileSync(ALARMS_FILE, JSON.stringify({ at: rec.at, since: rec.since, until: rec.until, alarms }, null, 2) + '\n', 'utf8');
    } catch { /* the printed sentences still stand */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The verdict. Ranked, with the threshold that fired, so it says WHY and not just
// "slow". Thresholds are pinned by tests/slow-audit.test.ts.
// ─────────────────────────────────────────────────────────────────────────────
export const THRESHOLDS = {
  pagesInThrashing: 5000,   // hard faults/sec — sustained above this, everything stalls
  pagesInPressure: 1000,
  availableFreezeMB: 1000,  // below this, this box has bluescreened with no dump
  availableFloorMB: 1800,   // mem-watchdog.ps1's reap floor
  rendererHotCorePct: 50,   // one Claude process burning half a core or more
  hookBudgetMs: 400,        // per tool call: the SLOWEST blocking PreToolUse hook (they run in parallel)
};

function verdict(m, a, h) {
  const found = [];
  if (m.pagesInPerSec !== null && m.pagesInPerSec >= THRESHOLDS.pagesInThrashing) {
    found.push({
      rank: 1, layer: 'machine', severity: 'critical',
      what: `The box is thrashing: ${m.pagesInPerSec} hard page faults/sec (peak ${m.pagesInPeak}), ${m.availableMB} MB free of ${m.totalMB}.`,
      why: 'Every fault is a stall on disk for a page that should be resident. This slows file reads, hooks, typing and UI repaint simultaneously — a shape no repo-side cause can produce.',
      lever: 'Fewer open sessions is the only free lever; more physical RAM is the durable one.',
    });
  } else if (m.availableMB !== null && m.availableMB < THRESHOLDS.availableFloorMB) {
    found.push({
      rank: 1, layer: 'machine', severity: 'warning',
      what: `${m.availableMB} MB free of ${m.totalMB}, under the ${THRESHOLDS.availableFloorMB} MB watchdog floor, but faulting only ${m.pagesInPerSec}/sec.`,
      why: 'Low headroom without a high fault rate is not yet costing wall clock. It is one heavy job away from doing so.',
      lever: 'Do not start a build, typecheck or test run locally.',
    });
  }
  if (a.busiest && a.busiest.corePct >= THRESHOLDS.rendererHotCorePct) {
    found.push({
      rank: found.length + 1, layer: 'claude app', severity: 'warning',
      what: `Claude process ${a.busiest.pid} is at ${a.busiest.corePct}% of one core, holding ${a.busiest.wsMB} MB after ${a.busiest.upH}h up.`,
      why: 'The app window\'s cost grows with the transcript it is displaying, so a long-running window gets slower by itself even when idle.',
      lever: 'Archiving finished sessions releases it. Never stop or restart the app from a session.',
    });
  }
  if (h && h.waitPerBashCallMs !== null && h.waitPerBashCallMs > THRESHOLDS.hookBudgetMs) {
    found.push({
      rank: found.length + 1, layer: 'settings', severity: 'note',
      what: `PreToolUse hooks hold each Bash call at least ${h.waitPerBashCallMs}ms (the slowest, ${h.slowestBashHook}) and each Edit ${h.waitPerEditCallMs}ms; together the ${h.spawnsPerBashCall} processes per Bash call cost ${h.cpuPerBashCallMs}ms of CPU, against a ${h.baselineMs}ms floor for one.`,
      why: 'Matching hooks start together, so the call waits for the slowest one; the rest is CPU, and on a starved box ten spawns at once contend and stretch that wait. The guards themselves are cheap; process creation is the cost.',
      lever: 'One dispatcher process instead of N would return most of it. Do not simply delete guards — each was built after a real incident.',
    });
  }
  if (a.engines && a.engines > 3) {
    found.push({
      rank: found.length + 1, layer: 'sessions', severity: 'note',
      what: `${a.engines} session engines alive, ${a.procCount} Claude processes, ${a.totalWsMB} MB resident.`,
      why: 'Session count is the multiplier on every figure above it.',
      lever: 'Route new work to a cloud session; archive the ones whose PR has merged.',
    });
  }
  if (!found.length) {
    found.push({
      rank: 1, layer: 'none', severity: 'ok',
      what: 'No threshold fired. The machine layer is healthy.',
      why: 'If work still feels slow, the cause is the session\'s effort level or the model picker, not this box.',
      lever: 'Compare against the previous record below before changing anything.',
    });
  }
  return found;
}

function history() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function record(snapshot) {
  try {
    mkdirSync(path.dirname(LOG), { recursive: true });
    appendFileSync(LOG, JSON.stringify(snapshot) + '\n', 'utf8');
  } catch { /* the audit is still useful without its log */ }
}

function delta(prev, now) {
  if (!prev) return null;
  const f = (a, b) => (a === null || b === null || a === undefined || b === undefined ? null : num(b - a, 0));
  return {
    since: prev.at,
    pagesInPerSec: f(prev.machine?.pagesInPerSec, now.machine.pagesInPerSec),
    availableMB: f(prev.machine?.availableMB, now.machine.availableMB),
    engines: f(prev.app?.engines, now.app.engines),
    totalWsMB: f(prev.app?.totalWsMB, now.app.totalWsMB),
    // A record from before 2026-10-08's fix holds only the old SUM (perBashCallMs). Comparing it
    // with the new wait would print a fall that never happened, so an old record yields no delta.
    waitPerBashCallMs: f(prev.hooks?.waitPerBashCallMs, now.hooks?.waitPerBashCallMs),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function table(s) {
  const L = [];
  const sign = (n, unit = '') => (n === null ? '' : `${n > 0 ? '+' : ''}${n}${unit}`);
  L.push('');
  L.push(`PHOENIX SLOW AUDIT — ${s.at} Cairo`);
  L.push('='.repeat(78));
  L.push('');
  L.push('MACHINE  (read this first — it is the only layer that slows everything at once)');
  L.push(`  hard page faults/sec   ${String(s.machine.pagesInPerSec).padEnd(10)} peak ${s.machine.pagesInPeak}`);
  L.push(`  available RAM          ${String(s.machine.availableMB).padEnd(10)} MB of ${s.machine.totalMB}   (watchdog floor ${THRESHOLDS.availableFloorMB}, freeze line ${THRESHOLDS.availableFreezeMB})`);
  L.push(`  CPU total              ${String(s.machine.cpuPct).padEnd(10)} %`);
  L.push(`  disk idle              ${String(s.machine.diskIdlePct).padEnd(10)} %   <- NOT evidence about paging, see the header`);
  L.push(`  commit charge          ${String(s.machine.commitPct).padEnd(10)} %   <- pagefile is fixed at 64 GB, so this stays green while RAM runs out`);
  L.push('');
  L.push('CLAUDE APP');
  L.push(`  processes ${s.app.procCount}, resident ${s.app.totalWsMB} MB, session engines ${s.app.engines}`);
  for (const t of s.app.top.slice(0, 3)) {
    L.push(`    pid ${String(t.pid).padEnd(7)} ${String(t.corePct).padStart(5)}% of one core   ${String(t.wsMB).padStart(5)} MB   up ${t.upH}h`);
  }
  L.push('');
  L.push(`TRANSCRIPTS   ${s.transcripts.totalMB} MB total`);
  for (const p of s.transcripts.projects.slice(0, 3)) {
    L.push(`    ${String(p.mb).padStart(6)} MB  ${String(p.files).padStart(4)} files  ${p.project}`);
  }
  if (s.transcripts.hot.length) {
    L.push(`  largest touched in the last 24h: ${s.transcripts.hot.slice(0, 3).map((x) => `${x.mb} MB`).join(', ')}`);
  }
  L.push('');
  if (s.hooks) {
    L.push('HOOKS  (wait = the slowest hook, they run in parallel; CPU = the sum; never quote one as the other)');
    L.push(`  wait  Bash ${s.hooks.waitPerBashCallMs}ms (${s.hooks.slowestBashHook})   Edit ${s.hooks.waitPerEditCallMs}ms   Grep ${s.hooks.waitPerGrepCallMs}ms   Read ${s.hooks.waitPerReadCallMs}ms`);
    L.push(`  CPU   Bash ${s.hooks.cpuPerBashCallMs}ms over ${s.hooks.spawnsPerBashCall} processes   Edit ${s.hooks.cpuPerEditCallMs}ms`);
    L.push(`  one bare node spawn on this box: ${s.hooks.baselineMs}ms  <- the floor each hook pays before running a line`);
    for (const r of s.hooks.rows.slice(0, 4)) L.push(`    ${String(r.ms).padStart(5)}ms  ${r.label}`);
    L.push('');
  }
  if (s.ci) {
    L.push('CI  (critical path = the wait; billed minutes = the bill; never quote one as the other)');
    for (const [k, label] of [['pr', 'pull request'], ['main', 'push to main']]) {
      const c = s.ci[k];
      if (!c || !c.samples.length) { L.push(`  ${label.padEnd(14)} no readable runs`); continue; }
      L.push(`  ${label.padEnd(14)} wait ${c.medianCriticalPathSecs}s   billed ~${c.medianBilledMinutes} min/run`);
      for (const j of c.samples[0].jobs) {
        L.push(`      ${String(j.secs).padStart(4)}s  ${j.name.padEnd(10)} dominated by ${j.dominant} (${j.dominantSecs}s)`);
      }
    }
    L.push('');
  }
  L.push('VERDICT');
  for (const v of s.verdict) {
    L.push(`  ${v.rank}. [${v.severity.toUpperCase()}] ${v.layer} — ${v.what}`);
    L.push(`     why:   ${v.why}`);
    L.push(`     lever: ${v.lever}`);
  }
  L.push('');
  if (s.delta) {
    L.push(`SINCE THE LAST AUDIT (${s.delta.since} Cairo)`);
    L.push(`  faults/sec ${sign(s.delta.pagesInPerSec)}   available RAM ${sign(s.delta.availableMB, ' MB')}   engines ${sign(s.delta.engines)}   app resident ${sign(s.delta.totalWsMB, ' MB')}   hook wait/Bash ${s.delta.waitPerBashCallMs === null ? 'n/a' : sign(s.delta.waitPerBashCallMs, 'ms')}`);
  } else {
    L.push('SINCE THE LAST AUDIT   no previous record — this one is the baseline.');
  }
  L.push('');
  L.push(`log: ${LOG}`);
  L.push('');
  return L.join('\n');
}

async function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (ARGS.has('--history')) {
    const h = history();
    if (!h.length) { console.log('no records yet'); return; }
    for (const r of h) {
      console.log(`${r.at}  faults/sec ${String(r.machine?.pagesInPerSec).padStart(6)}  freeMB ${String(r.machine?.availableMB).padStart(6)}  engines ${String(r.app?.engines).padStart(3)}  appMB ${String(r.app?.totalWsMB).padStart(6)}  ${!r.hooks ? 'hook wait/Bash     -' : r.hooks.waitPerBashCallMs !== undefined ? `hook wait/Bash ${String(r.hooks.waitPerBashCallMs).padStart(5)}ms` : `hook CPU/Bash ${String(r.hooks.perBashCallMs ?? '-').padStart(5)}ms (old record: sum only)`}`);
    }
    return;
  }

  if (ARGS.has('--transcripts')) {
    await transcriptAudit();
    return;
  }

  const [m, a] = await Promise.all([machine(), app()]);
  const t = transcripts();
  const h = QUICK ? null : await hooks(projectDir);
  const c = QUICK ? null : await ci(projectDir);

  const snapshot = {
    at: cairo(),
    atISO: new Date().toISOString(),
    machine: m, app: a, transcripts: t, hooks: h, ci: c,
  };
  snapshot.verdict = verdict(m, a, h);
  snapshot.delta = delta(history().at(-1), snapshot);

  record(snapshot);
  console.log(AS_JSON ? JSON.stringify(snapshot, null, 2) : table(snapshot));
}

// Run only when invoked directly, so tests/slow-audit.test.ts can import THRESHOLDS
// without launching an audit (which would spawn PowerShell and every hook).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
