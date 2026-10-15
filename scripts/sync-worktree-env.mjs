#!/usr/bin/env node
// Copies the gitignored local env files (.env.local, .env.*.rls.local,
// .env.analytics, etc.) from the primary worktree into the CURRENT worktree,
// junctions this worktree's node_modules to the primary's, and links this
// worktree's Claude Code memory + local settings back to the primary's.
//
// `git worktree add` never copies gitignored files — every new worktree starts
// with none of them, so dev-auth (PHOENIX_AUTH_SECRET), Supabase, and other
// local-only config silently break until someone copies .env.local by hand.
//
// A SIBLING worktree (this repo's own `_wt-<task>` convention, per AGENTS.md
// §5) is also a brand-new absolute path as far as Claude Code's own project
// identity is concerned, unlike a NESTED `.claude/worktrees/<name>` one (its
// own native worktree-isolation feature, which Claude Code recognizes as the
// same project automatically). So a session opened in a sibling worktree gets
// a fresh, empty auto-memory bucket and no `.claude/settings.local.json` —
// none of the accumulated MEMORY.md history or the personal Bash permission
// allow-list carries over, and it reads as a different repository entirely.
// This script closes that gap. The two halves are NOT treated the same way,
// on purpose:
//   * .env files and node_modules — copy what's missing, never touch what's
//     already there without --force. A worktree's env may legitimately differ.
//   * .claude/settings.local.json — the PRIMARY is the single source of truth
//     and this worktree's copy is refreshed from it on EVERY run, because a
//     permission allow-list that each worktree edits on its own does not
//     converge, it drifts (see the block that does it, below). A worktree that
//     genuinely needs its own opts out with .claude/settings.local.nosync.
//
// Never prints file contents — only filenames and byte counts, and for
// settings.local.json only key names, entry counts, and dropped permission
// grants that are plain quote-free command patterns — so a value carrying a
// secret never lands in a terminal transcript or log.
//
// Usage:
//   node scripts/sync-worktree-env.mjs            # copy files that are missing here
//   node scripts/sync-worktree-env.mjs --force     # also overwrite existing env files
//   node scripts/sync-worktree-env.mjs --dry-run   # print what would happen, change nothing
//   node scripts/sync-worktree-env.mjs --all       # ALSO sweep every OTHER worktree on the
//                                                   # machine (node_modules junction + missing env
//                                                   # only — never their settings), so node / pnpm /
//                                                   # npm run in all working trees, not just this one.
//                                                   # See scripts/lib/provision-worktree.mjs for why it
//                                                   # is safe to touch another session's worktree.
//   node scripts/sync-worktree-env.mjs --hook      # the no-flag run, but FAIL-OPEN: any failure prints
//                                                   # one line to stderr and exits 0. The BLOCKING
//                                                   # SessionStart entry runs this, with no shell.
//   node scripts/sync-worktree-env.mjs --sweep-only # ONLY the sweep of every OTHER worktree — never
//                                                   # this folder's env, node_modules or settings —
//                                                   # and fail-open the same way. The ASYNC
//                                                   # SessionStart entry runs this.
//
// 2026-10-09 (hook speed fixes): the SessionStart hook used to run `--all` through a bash
// one-liner, blocking every session start on a sweep of ~27 worktrees (p50 1.7 s, worst 17.6 s).
// It is now two entries: `--hook` (this folder only, blocking — the session needs its env before
// the first command) and `--sweep-only` (everything else, async — nobody waits on it). `--all`
// still does both in one run, unchanged, for a human at a terminal. `--hook` exists because the
// entry runs node with no shell, so the old `2>/dev/null || true` fail-open is gone; the no-flag
// run keeps exiting 1 on failure, because scripts/new-session.mjs reads that exit code.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { gitLayout } from "./lib/git-layout.mjs";
import { linkNodeModules } from "./lib/link-node-modules.mjs";
import { sweepWorktrees, wasChanged, linkedNodeModules } from "./lib/provision-worktree.mjs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "sync-worktree-env",
  entry: import.meta.url,
  known: ["--all", "--dry-run", "--force", "--hook", "--sweep-only"],
  hints: [
    "--dry-run prints what it would copy; --all covers every worktree; --hook is what the session hook passes",
  ],
});

// stderr is captured, not inherited (2026-10-09, hook speed fixes): a fail-open run must print ONE
// line, and git's own "fatal: not a git repository" would be a second one ahead of ours.
function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const all = args.includes("--all");
const sweepOnly = args.includes("--sweep-only");
const hook = args.includes("--hook");
// 2026-10-09 (hook speed fixes): a SessionStart entry must never fail the session start, and it
// now runs without the shell that used to swallow the exit code. So under --hook / --sweep-only
// every failure — a fail() below, or anything thrown — is one stderr line and exit 0.
const failOpen = hook || sweepOnly;

function fail(message) {
  console.error("sync-worktree-env aborted — " + message);
  process.exit(failOpen ? 0 : 1);
}

if (failOpen) {
  process.on("uncaughtException", (err) => {
    const first = String((err && err.message) || err).split(/\r?\n/)[0];
    console.error("sync-worktree-env skipped — " + first);
    process.exit(0);
  });
}

// The common .git dir's parent is always the PRIMARY worktree (the original
// clone) — unlike `git worktree list`'s first entry, this is reliable
// regardless of which worktree the script is invoked from.
//
// 2026-10-09 (hook speed fixes): read off disk with gitLayout() — the same `.git` folder / `.git`
// file + `commondir` pointer git itself reads — instead of two `git rev-parse` processes, so a
// session start in the PRIMARY now starts no process at all. gitLayout() returns null whenever the
// layout cannot be read off disk (or GIT_DIR and friends are set), and then git still answers.
const layout = gitLayout(process.cwd());
let commonDir;
let currentRoot;
if (layout) {
  commonDir = layout.commonDir;
  currentRoot = layout.toplevel;
} else {
  try {
    commonDir = git(["rev-parse", "--git-common-dir"]);
  } catch {
    fail("not inside a git repository.");
  }
  try {
    currentRoot = git(["rev-parse", "--show-toplevel"]);
  } catch {
    fail("could not resolve the current worktree root.");
  }
}
const primaryRoot = path.resolve(path.dirname(commonDir));
currentRoot = path.resolve(currentRoot);
// Off disk, "primary" is a `.git` FOLDER rather than a string comparison of two paths.
const isPrimary = layout ? !layout.linked : primaryRoot === currentRoot;

// Candidate files: anything in the primary worktree root matching /^\.env/,
// excluding tracked *.example templates (already present via checkout), and
// double-checked as actually gitignored so a tracked file can never be swept
// in by accident.
//
// 2026-10-09 (hook speed fixes): ONE `git check-ignore` for every candidate, not one per file —
// the primary has 7 of them, so that was 7 processes on every session start. `-z --stdin` takes
// the names on stdin and answers NUL-separated, so no name is ever quoted or length-limited.
// check-ignore exits 1 when NONE of the names is ignored: that is an answer, not an error, and
// any other failure is read the way the per-file loop read it — not provably ignored, so not copied.
function getEnvCandidates() {
  const names = fs
    .readdirSync(primaryRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(".env") && !entry.name.endsWith(".example"))
    .map((entry) => entry.name);
  if (names.length === 0) return [];
  let out = "";
  try {
    out = git(["-C", primaryRoot, "check-ignore", "-z", "--stdin"], { input: names.map((n) => n + "\0").join("") });
  } catch {
    out = ""; // exit 1 = none ignored; anything else = nothing provably ignored. Tracked files are left alone either way.
  }
  const ignored = new Set(out.split("\0").filter(Boolean));
  return names.filter((name) => ignored.has(name)).sort();
}

// Every worktree git knows about, as absolute paths — the primary plus every
// linked one. `--porcelain` is stable across git versions and quotes nothing here.
function listWorktreeDirs() {
  const dirs = [];
  for (const line of git(["worktree", "list", "--porcelain"]).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("worktree ")) dirs.push(path.resolve(trimmed.slice("worktree ".length).trim()));
  }
  return dirs;
}

// One spelling per folder, for the sweep's skip test: the real path (junctions and 8.3 names
// resolved), case-folded on Windows. A folder that is gone keeps its resolved spelling.
function dirKey(dir) {
  let real = path.resolve(dir);
  try {
    real = fs.realpathSync.native(real);
  } catch {
    // a husk — sweepWorktrees marks it not-present anyway
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

// `--all`: provision node_modules + missing env in every OTHER worktree, so node /
// pnpm / npm run in ALL working trees, not just the one this session opened. The
// current worktree (already fully synced above, settings and all) and the primary
// are skipped. Stays quiet for worktrees that needed nothing, so a healthy machine
// prints one short line and a broken one prints exactly what it fixed.
function runSweep(candidates, skip) {
  let dirs;
  try {
    dirs = listWorktreeDirs();
  } catch {
    if (sweepOnly) fail("could not list the worktrees."); // the sweep IS the whole run — say why it did nothing
    return; // no git / no worktrees — nothing to sweep
  }
  // 2026-10-09 (hook speed fixes): the skip test now compares real, case-folded paths. The roots
  // come off disk from the session's own folder, `git worktree list` prints git's spelling, and on
  // Windows those can differ in drive-letter case or through a junction — and `--sweep-only`
  // promises never to touch the folder it runs in.
  const skipKeys = new Set([primaryRoot, ...skip].map(dirKey));
  dirs = dirs.filter((d) => !skipKeys.has(dirKey(d)));
  const results = sweepWorktrees(primaryRoot, dirs, candidates, { dryRun, skip });
  let changed = 0;
  for (const r of results) {
    if (!wasChanged(r)) continue;
    changed++;
    const bits = [];
    if (r.copied.length) bits.push(`${r.copied.length} env file(s)`);
    if (linkedNodeModules(r.modulesStatus)) bits.push("node_modules " + r.modulesStatus);
    console.log(`  sweep ${path.basename(r.dir)}: ${bits.join(", ")}${dryRun ? " [dry-run]" : ""}`);
  }
  const considered = results.filter((r) => r.present).length;
  console.log(
    changed === 0
      ? `  sweep: all ${considered} other worktree(s) already had node_modules + env`
      : `  sweep: ${changed} of ${considered} other worktree(s) provisioned`,
  );
}

// --sweep-only (2026-10-09, hook speed fixes): the async half of the SessionStart work. Provision
// every OTHER worktree and stop — this folder's env files, node_modules link and
// settings.local.json are the blocking `--hook` run's job, and rewriting a permission file under
// the session that is already running in it is exactly what the sweep must never do.
if (sweepOnly) {
  console.log("sync-worktree-env: primary=" + primaryRoot + " — sweeping every other worktree");
  runSweep(getEnvCandidates(), [currentRoot]);
  process.exit(0);
}

if (isPrimary) {
  // A control-tower (primary) session has nothing of its OWN to sync, but it is the
  // ideal place to provision every worktree, so `--all` still sweeps from here.
  if (all) {
    console.log("sync-worktree-env: primary=" + primaryRoot + " — sweeping all worktrees");
    runSweep(getEnvCandidates(), [currentRoot]);
    process.exit(0);
  }
  console.log("sync-worktree-env: this IS the primary worktree — nothing to sync.");
  process.exit(0);
}

const candidates = getEnvCandidates();

console.log("sync-worktree-env: primary=" + primaryRoot);
console.log("sync-worktree-env: target =" + currentRoot);

let copied = 0;
let skipped = 0;
if (candidates.length === 0) {
  console.log("  (no local env files found in the primary worktree)");
} else {
  for (const name of candidates) {
    const src = path.join(primaryRoot, name);
    const dest = path.join(currentRoot, name);
    const exists = fs.existsSync(dest);

    if (exists && !force) {
      console.log(`  skip   ${name} (already exists here; pass --force to overwrite)`);
      skipped++;
      continue;
    }

    const size = fs.statSync(src).size;
    if (dryRun) {
      console.log(`  would-copy ${name} (${size} bytes)${exists ? " [overwrite]" : ""}`);
      continue;
    }

    fs.copyFileSync(src, dest);
    console.log(`  copied ${name} (${size} bytes)${exists ? " [overwritten]" : ""}`);
    copied++;
  }
}

// ------------------------------------------------------- node_modules junction
//
// The other half of what `git worktree add` never gives a new worktree.
// `.claude/worktrees/<name>` worktrees (Claude Code's native feature) are
// created without new-session.mjs's junction step, so a nested worktree starts
// with no node_modules and every local `tsc`/`eslint`/`next dev`/`node scripts/…`
// there fails MODULE_NOT_FOUND. This hook runs at every SessionStart, so linking
// what is missing here self-heals such a worktree the moment a session opens in
// it. Shared with new-session.mjs so both create the junction identically; it
// never touches an existing node_modules, junction or real.
const modulesStatus = linkNodeModules(currentRoot, primaryRoot, { dryRun });
console.log(`  node_modules ${modulesStatus}`);

// ---------------------------------------------------------- Claude Code link
//
// Sanitizes an absolute project path into Claude Code's own memory-directory
// key: reverse-engineered from this repo's own observed mapping
// (F:\Phoenix Workforce\phoenix-workforce -> F--Phoenix-Workforce-phoenix-workforce),
// which is exactly ":", "\", "/" and " " each replaced with "-", with no
// collapsing of the resulting run of dashes. Not documented publicly, so this
// is verified against a real directory below rather than trusted blindly —
// if the guess is wrong for some future path shape, the memory link is
// skipped with a clear message instead of writing a directory that doesn't
// exist.
function memoryDirFor(root) {
  const home = os.homedir();
  if (!home) return null;
  const sanitized = root.replace(/[:\\/ ]/g, "-");
  const dir = path.join(home, ".claude", "projects", sanitized, "memory");
  return fs.existsSync(dir) ? dir : null;
}

function readJsonIfValid(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined; // exists but unreadable/invalid JSON — caller must not touch it
  }
}

const claudeSettingsRelPath = path.join(".claude", "settings.local.json");
const targetClaudeSettings = path.join(currentRoot, claudeSettingsRelPath);
const primaryClaudeSettings = path.join(primaryRoot, claudeSettingsRelPath);
// Matches .gitignore's `.claude/settings.local.json.bak-*`. Deliberately ONE rolling
// file and not a dated one: this runs at every SessionStart, so a dated backup would
// leave a 31 KB copy per day per worktree forever.
const backupPath = targetClaudeSettings + ".bak-prev";
// Escape hatch for a worktree that genuinely needs its own permission set. A CLI flag
// cannot serve here — the hook, not a human, is what runs this — so the opt-out has to
// be a file that survives between sessions.
const optOutRelPath = path.join(".claude", "settings.local.nosync");
const optOutPath = path.join(currentRoot, optOutRelPath);

const memoryDir = memoryDirFor(primaryRoot);
const memoryKeys = memoryDir ? { autoMemoryEnabled: true, autoMemoryDirectory: memoryDir } : {};
const targetExisting = readJsonIfValid(targetClaudeSettings);
const primaryExisting = readJsonIfValid(primaryClaudeSettings);
const primaryUsable =
  primaryExisting && typeof primaryExisting === "object" && !Array.isArray(primaryExisting);

const allowOf = (o) =>
  o && o.permissions && Array.isArray(o.permissions.allow) ? o.permissions.allow.map(String) : [];

// A dropped grant is echoed verbatim only when it is a plain Bash/PowerShell command
// pattern — no quotes, no `=`, no URL — so a grant carrying a token or a connection
// string can never be printed by accident. Everything else is counted, and the full
// list is in the backup file either way.
const printableGrant = (s) => /^(?:Bash|PowerShell)\([A-Za-z0-9 ._:*/\\-]+\)$/.test(s);

if (targetExisting === undefined) {
  console.log(`  claude config: ${claudeSettingsRelPath} exists but is not valid JSON here — leaving it untouched.`);
} else if (fs.existsSync(optOutPath)) {
  console.log(`  claude config: ${optOutRelPath} present — this worktree keeps its own settings, not syncing.`);
} else if (!primaryUsable) {
  // The primary's file is missing or unreadable. NEVER read that as "the primary grants
  // nothing" and wipe this worktree — fall back to the old behaviour of just making sure
  // the memory pointer is there, and say why.
  const settings = targetExisting ? { ...targetExisting, ...memoryKeys } : { ...memoryKeys };
  const text = JSON.stringify(settings, null, 2) + "\n";
  const raw = fs.existsSync(targetClaudeSettings) ? fs.readFileSync(targetClaudeSettings, "utf8") : null;
  console.log("  claude config: the primary's settings.local.json is missing or invalid — not syncing grants.");
  if (raw === text) {
    console.log(`    ${claudeSettingsRelPath} already linked — nothing to do.`);
  } else if (dryRun) {
    console.log(`    would-write ${claudeSettingsRelPath} (memory pointer only)`);
  } else {
    fs.mkdirSync(path.dirname(targetClaudeSettings), { recursive: true });
    fs.writeFileSync(targetClaudeSettings, text);
    console.log(`    wrote ${claudeSettingsRelPath} (memory pointer only)`);
  }
} else {
  // ---- the fix for settings drift (2026-09-12) --------------------------------------
  // This block used to stop at "the file exists, leave it alone", which is precisely how
  // 26 worktrees ended up with five different versions of it. A worktree's file is only
  // ever written by the permission prompts answered inside THAT worktree, so each one
  // drifts independently and never converges — by 2026-09-12, 22 of them had accumulated
  // a `Bash(git push *)` grant that the primary has never had, silently auto-approving
  // pushes in exactly the folders where parallel sessions do the risky work, against the
  // owner's standing "always ask before commit/push/PR/merge" rule. So the primary is now
  // the single source of truth and a worktree copy is refreshed from it every session.
  //
  // Primary-wins, not a union: a union would re-accumulate those same grants forever,
  // which is the bug. Anything dropped is recoverable from the backup, and a grant that
  // was deliberate belongs in the PRIMARY's file so all worktrees inherit it.
  const desired = { ...primaryExisting, ...memoryKeys };
  const desiredText = JSON.stringify(desired, null, 2) + "\n";
  const rawText = fs.existsSync(targetClaudeSettings) ? fs.readFileSync(targetClaudeSettings, "utf8") : null;

  if (!memoryDir) {
    console.log("  claude config: could not resolve the primary's auto-memory directory — memory will not be linked.");
  }

  if (rawText === desiredText) {
    console.log(`  claude config: ${claudeSettingsRelPath} matches the primary — nothing to do.`);
  } else {
    const before = allowOf(targetExisting);
    const after = allowOf(desired);
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const dropped = before.filter((x) => !afterSet.has(x));
    const gained = after.filter((x) => !beforeSet.has(x));
    const verb = rawText === null ? "created from primary" : "refreshed from primary";
    const counts = `allow ${before.length} -> ${after.length} (+${gained.length}, -${dropped.length})`;

    if (dryRun) {
      console.log(`  claude config: would-write ${claudeSettingsRelPath} — ${verb}, ${counts}`);
    } else {
      fs.mkdirSync(path.dirname(targetClaudeSettings), { recursive: true });
      if (rawText !== null) fs.writeFileSync(backupPath, rawText);
      fs.writeFileSync(targetClaudeSettings, desiredText);
      console.log(
        `  claude config: ${verb} — ${counts}${rawText !== null ? `, previous copy kept as ${path.basename(backupPath)}` : ""}`,
      );
    }

    if (dropped.length) {
      const named = dropped.filter(printableGrant);
      const shown = named.slice(0, 12);
      for (const g of shown) console.log(`    dropped grant: ${g}`);
      const rest = dropped.length - shown.length;
      if (rest > 0) console.log(`    ...and ${rest} more dropped (full list in ${path.basename(backupPath)})`);
      console.log("    if any of those were deliberate, add them to the PRIMARY's settings.local.json so every worktree inherits them.");
    }
  }
}

// --all: now that THIS worktree is fully synced (env + node_modules + settings),
// provision every OTHER worktree so node / pnpm / npm run across all working trees.
if (all) {
  runSweep(candidates, [currentRoot]);
}

if (!dryRun) {
  console.log(`sync-worktree-env: done — ${copied} copied, ${skipped} skipped.`);
}
