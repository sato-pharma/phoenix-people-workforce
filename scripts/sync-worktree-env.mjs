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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { linkNodeModules } from "./lib/link-node-modules.mjs";

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
}

function fail(message) {
  console.error("sync-worktree-env aborted — " + message);
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");

// The common .git dir's parent is always the PRIMARY worktree (the original
// clone) — unlike `git worktree list`'s first entry, this is reliable
// regardless of which worktree the script is invoked from.
let commonDir;
try {
  commonDir = git(["rev-parse", "--git-common-dir"]);
} catch {
  fail("not inside a git repository.");
}
const primaryRoot = path.resolve(path.dirname(commonDir));

let currentRoot;
try {
  currentRoot = git(["rev-parse", "--show-toplevel"]);
} catch {
  fail("could not resolve the current worktree root.");
}
currentRoot = path.resolve(currentRoot);

if (primaryRoot === currentRoot) {
  console.log("sync-worktree-env: this IS the primary worktree — nothing to sync.");
  process.exit(0);
}

// Candidate files: anything in the primary worktree root matching /^\.env/,
// excluding tracked *.example templates (already present via checkout), and
// double-checked as actually gitignored so a tracked file can never be swept
// in by accident.
const entries = fs.readdirSync(primaryRoot, { withFileTypes: true });
const candidates = entries
  .filter((entry) => entry.isFile() && entry.name.startsWith(".env") && !entry.name.endsWith(".example"))
  .map((entry) => entry.name)
  .filter((name) => {
    try {
      git(["-C", primaryRoot, "check-ignore", "-q", name]);
      return true;
    } catch {
      return false; // not gitignored — leave tracked files alone
    }
  })
  .sort();

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

if (!dryRun) {
  console.log(`sync-worktree-env: done — ${copied} copied, ${skipped} skipped.`);
}
