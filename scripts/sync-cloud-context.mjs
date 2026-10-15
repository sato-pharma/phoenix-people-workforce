#!/usr/bin/env node
// sync-cloud-context.mjs
// ---------------------------------------------------------------------------
// Mirror the laptop-only knowledge layers INTO the repo so a CLOUD session —
// which is an isolated git clone and never sees ~/.claude — wakes up knowing
// Phoenix. A local session ignores the mirror; it has the live originals.
//
// Copies, into <repo>/.claude/cloud-context/ :
//   memory-mirror/           <- ~/.claude/projects/<slug>/memory/   (index + every file)
//   global-standing-rules.md <- ~/.claude/CLAUDE.md                 (verbatim, but LF)
//   laptop-hooks/            <- the ~/.claude/hooks/*.mjs a REPO TEST pins (see below)
//   README.md                <- generated metadata (counts, bytes, when)
//
// 🔴 `laptop-hooks/` IS NOT FOR CLOUD TO READ — it is here so CI can test a guard that does not live
// in this repository. `~/.claude/hooks/scratchpad-guard.mjs` enforces the owner's never-delete rule in
// EVERY folder on the laptop, so it cannot move into one repo; but that also meant nothing anywhere
// could go red when it weakened, and on 2026-10-06 it gained its first stand-down
// (`PHX_DELETE_OK=<filename>`), which is exactly the kind of code that must not quietly loosen.
// `tests/delete-guard-stand-down.test.ts` imports THIS COPY and pins its decision table.
// 🔴 So the copy is only worth what its freshness is worth: a weakening of the LIVE hook that is
// never mirrored leaves CI green about a file nobody runs. The laptop side is what closes that —
// `claude-scripts-backup.mjs` runs the hook's own `selftest` hourly where the real hook lives.
//
// Every file is written with LF line endings (crlfToLf), whatever the laptop holds: git commits the
// mirror as LF anyway, and a CRLF working copy lists as modified in `git status`, which made
// `new-session.mjs --remove` refuse a worktree whose refresh had already merged.
//
// NOTE: the subdir is memory-mirror/, NOT memory/, on purpose — .gitignore has a
// bare `memory/` rule (protects against committing a real auto-memory dir), so a
// folder literally named `memory` here would be silently ignored and never ship.
//
// The output always lands in the checkout THIS script lives in (resolved from
// import.meta.url), so running it from the control-tower primary refreshes the
// primary's mirror and running it from a worktree refreshes that worktree's.
//
// Refresh + ship: run this, then commit the mirror through the normal PR flow.
// Cloud sees the mirror as of the last commit on the branch it clones (usually
// main), so the mirror is only as fresh as its last merged refresh.
//
// Env overrides: PHX_MEMORY_DIR, PHX_GLOBAL_RULES, PHX_HOOKS_DIR (absolute paths).
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { crlfToLf } from './cloud-mirror-drift.mjs';
import { refuseArguments } from './lib/refuse-arguments.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(REPO_ROOT, '.claude', 'cloud-context');
const OUT_MEMORY = path.join(OUT_DIR, 'memory-mirror');
const OUT_HOOKS = path.join(OUT_DIR, 'laptop-hooks');

// The laptop hooks a repo test pins. Only hooks that live OUTSIDE this repo belong here — a hook in
// `.claude/hooks/` is already testable where it sits and must never be duplicated into this folder.
const PINNED_HOOKS = [
  'scratchpad-guard.mjs',
  'next-step-capture.mjs',
  'risky-allow-guard.mjs',
  'memory-guard.mjs',
  // The fifth, and the one with the most teeth: it STOPS processes. Added 2026-10-06 at the owner's
  // instruction, after a sweep found it already carried a 68-case suite that nothing anywhere ran —
  // not this list, not `claude-scripts-backup.mjs`, not a repo test. It had been invisible for the
  // identical reason the risky-allow guard's suite was: it dispatches on `--selftest`, so the bare
  // word `selftest` prints nothing and exits 0, which is indistinguishable from a file that has no
  // selftest at all. Its own suite is pure functions only — it starts and ends no process — so it is
  // safe for CI to run.
  'dev-server-reaper.mjs',
  // The sixth, found by the same sweep that turned up the fifth, and the only one here that guards an
  // UNATTENDED run rather than a session: a PreToolUse guard that holds the weekly config review to
  // the read-only rule its own skill states in capitals. It exists because on 2026-09-21 that run
  // rewrote a script and re-registered a scheduled task anyway, at 01:41-02:21 Cairo with nobody
  // watching. Its 45-case suite was in neither list. Note the flag is `--selftest`, like the reaper's.
  'weekly-review-readonly.mjs',
  // NOT a hook, and mirrored for one reason: memory-guard.mjs's own selftest loads it with
  // --import to prove the hook starts NO subprocess on a session start. It resolves as a sibling,
  // so on a CI runner - which has no ~/.claude at all - the mirrored guard found nothing and that
  // one case failed, taking the required validate job down on the memory-fold PR of 2026-10-09
  // 09:00 Cairo. A spawn probe added beside a pinned hook has to be pinned with it. It is inert
  // unless SPAWN_PROBE_OUT is set, so it starts and records nothing in CI.
  'spawn-probe.mjs',
];
const HOOKS_DIR = process.env.PHX_HOOKS_DIR || path.join(os.homedir(), '.claude', 'hooks');

const MEMORY_SLUG = 'F--Phoenix-Workforce-phoenix-workforce';
const MEMORY_DIR =
  process.env.PHX_MEMORY_DIR ||
  path.join(os.homedir(), '.claude', 'projects', MEMORY_SLUG, 'memory');
const GLOBAL_RULES =
  process.env.PHX_GLOBAL_RULES || path.join(os.homedir(), '.claude', 'CLAUDE.md');

function fail(msg) {
  console.error(`sync-cloud-context: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ARGUMENTS — there is no dry run here, and a flag is never ignored.
//
// 🔴 Until 2026-10-15 this script parsed NO arguments at all, so `--check` — the flag a session
// reaches for to ASK whether the mirror has drifted — was silently ignored and the script did its
// one job: it rewrote the whole mirror into whatever checkout the caller happened to be standing in
// and exited 0, which reads exactly like a clean check. Measured that day in a worktree another live
// session shared: 7 modified tracked files and 1 untracked mirror note, byte-for-byte what an open
// fold PR already carried. The `git restore` to undo it is then refused by the auto-mode classifier
// as irreversible local destruction — correctly, since it cannot tell a script's own output from the
// owner's uncommitted work — so the price of the ignored flag was a dirty shared worktree only the
// owner could authorise cleaning.
//
// The gate is `scripts/lib/refuse-arguments.mjs`, shared with every other generator here that takes
// no arguments, and it runs BEFORE the memory-source check below on purpose: a cloud runner has no
// ~/.claude, so in the other order a refused flag would exit 1 there and 2 here, and
// `tests/sync-cloud-context-args.test.ts` would pass on the laptop and fail on the box.
// Account: docs/agents-session-traps.md, "`--check` on the cloud-context mirror was a full write".
// ---------------------------------------------------------------------------
refuseArguments({
  name: 'sync-cloud-context',
  usage: `sync-cloud-context: mirror the laptop knowledge layers into this checkout.

  node scripts/sync-cloud-context.mjs      refresh the mirror HERE, then commit it in a PR
  node scripts/sync-cloud-context.mjs -h   this text

It takes no other arguments, and it has NO dry run — running it IS the write.
  to ASK whether the mirror has drifted: the SessionStart banner, or
                                         node scripts/module-memory/build.mjs --check
  to FIX drift:                          node scripts/module-memory/fold.mjs --apply`,
  hints: [
    'running this script at all REWRITES the whole mirror into the checkout you are standing in',
    'to ASK whether the mirror has drifted: the SessionStart banner already counts it, or',
    '                                       node scripts/module-memory/build.mjs --check',
    'to FIX drift:                          node scripts/module-memory/fold.mjs --apply',
    '                                       (its own temporary worktree — never yours)',
  ],
});

if (!fs.existsSync(MEMORY_DIR)) {
  fail(
    `memory source not found: ${MEMORY_DIR}\n` +
      `  (a cloud session HAS no local memory — run this from the laptop, not the cloud.)`,
  );
}

// 1) Mirror the memory directory faithfully: wipe the old mirror so a memory
//    file deleted upstream does not linger, then copy every .md across.
fs.rmSync(OUT_MEMORY, { recursive: true, force: true });
fs.mkdirSync(OUT_MEMORY, { recursive: true });

const memFiles = fs
  .readdirSync(MEMORY_DIR, { withFileTypes: true })
  .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md'))
  .map((d) => d.name)
  .sort();

let bytes = 0;
for (const name of memFiles) {
  const buf = crlfToLf(fs.readFileSync(path.join(MEMORY_DIR, name)));
  fs.writeFileSync(path.join(OUT_MEMORY, name), buf);
  bytes += buf.length;
}

// 2) The global standing rules, verbatim. Missing is a warning, not fatal —
//    the memory mirror is still worth shipping on its own.
let rulesBytes = 0;
if (fs.existsSync(GLOBAL_RULES)) {
  const buf = crlfToLf(fs.readFileSync(GLOBAL_RULES));
  fs.writeFileSync(path.join(OUT_DIR, 'global-standing-rules.md'), buf);
  rulesBytes = buf.length;
} else {
  console.warn(`sync-cloud-context: WARN global rules not found: ${GLOBAL_RULES}`);
}

// 2b) The laptop hooks a repo test pins. A MISSING one is FATAL, unlike the rules above: the test
//     imports this copy, so a refresh that silently stopped producing it is exactly how CI would come
//     to test a file that is no longer there — and a guard nobody tests is the shape of the problem
//     this folder exists to fix. Mirrored whether or not the rules were found: the two are unrelated.
let hookBytes = 0;
for (const name of PINNED_HOOKS) {
  const src = path.join(HOOKS_DIR, name);
  if (!fs.existsSync(src)) fail(`pinned hook not found: ${src} (set PHX_HOOKS_DIR, or drop it from PINNED_HOOKS)`);
  fs.mkdirSync(OUT_HOOKS, { recursive: true });
  const buf = crlfToLf(fs.readFileSync(src));
  fs.writeFileSync(path.join(OUT_HOOKS, name), buf);
  hookBytes += buf.length;
}

// 3) A generated README so the mirror is self-explaining and reproducible.
const whenCairo = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Cairo',
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date());
const hasIndex = memFiles.some((n) => n === 'MEMORY.md');

const readme = `# Cloud context mirror — generated, do not hand-edit

A **cloud** session is an isolated git clone of this repo. It never sees the laptop's
\`~/.claude/\` — so the two knowledge layers a **local** session wakes up with are missing:
the global standing rules and the entire auto-memory. This directory mirrors both INTO the
repo so a cloud session can read them, giving it the same two-tier recall a local session has.

**A cloud session, before its first substantive answer, should read:**
- \`memory-mirror/${hasIndex ? 'MEMORY.md' : '(index missing — read the files directly)'}\` — the memory index (the map of every known fact)
- \`global-standing-rules.md\` — the owner's global standing rules (the machine/RAM sections are laptop-only; ignore them in cloud)
- then grep \`memory-mirror/\` for any specific fact, exactly as local recall does on demand.

**Local sessions ignore this mirror** — they have the live originals under \`~/.claude/\`.

## What is here (generated ${whenCairo} Cairo)
- Memory files: **${memFiles.length}** (${(bytes / 1024 / 1024).toFixed(2)} MB)
- Global standing rules: ${rulesBytes ? `${(rulesBytes / 1024).toFixed(1)} KB` : 'MISSING at generation time'}
- Pinned laptop hooks: **${PINNED_HOOKS.length}** in \`laptop-hooks/\` (${(hookBytes / 1024).toFixed(1)} KB) — ${PINNED_HOOKS.join(', ')}

\`laptop-hooks/\` is **not for a cloud session to read or run.** Those hooks guard every folder on the
laptop, so they cannot live in one repository — which also meant nothing could go red when one
weakened. \`tests/delete-guard-stand-down.test.ts\` imports the pinned copy and pins its decision
table in the required \`validate\` job. The copy is only worth its freshness, so the live hook also
runs its own \`selftest\` hourly on the laptop, where the real file is.

## Refreshing
Run from a **local** checkout (it needs \`~/.claude/\`):

    node scripts/sync-cloud-context.mjs

then commit the change through the normal PR flow. Cloud sees the mirror as of the last commit
on the branch it clones (usually \`main\`), so it is only as fresh as its last merged refresh.
Source: \`~/.claude/projects/${MEMORY_SLUG}/memory/\` and \`~/.claude/CLAUDE.md\`.
`;
fs.writeFileSync(path.join(OUT_DIR, 'README.md'), readme);

console.log(
  `sync-cloud-context: mirrored ${memFiles.length} memory files ` +
    `(${(bytes / 1024 / 1024).toFixed(2)} MB) + ` +
    `${rulesBytes ? 'global rules' : 'NO global rules'} + ` +
    `${PINNED_HOOKS.length} pinned hook(s) -> ${path.relative(REPO_ROOT, OUT_DIR)}`,
);

// 4) Module memory moves WITH the mirror (docs/module-memory.md): file any note the refresh brought
//    in, drop any that vanished, and rebuild the module files from the fresh descriptions. Without
//    this, a refresh left `tests/module-memory.test.ts` red with an ORPHAN or a stale notes block.
const moduleBuild = path.join(REPO_ROOT, 'scripts', 'module-memory', 'build.mjs');
if (fs.existsSync(moduleBuild)) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [moduleBuild, '--file-new'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (r.status !== 0) fail('module memory rebuild failed — run node scripts/module-memory/build.mjs --file-new');
}
