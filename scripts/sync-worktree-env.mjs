#!/usr/bin/env node
// Copies the gitignored local env files (.env.local, .env.*.rls.local,
// .env.analytics, etc.) from the primary worktree into the CURRENT worktree,
// and links this worktree's Claude Code memory + local settings back to the
// primary's.
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
// This script closes that gap for the ENV/memory/settings triad the same
// way: copy what's missing, never touch what's already there without
// --force.
//
// Never prints file contents — only filenames and byte counts, and only the
// KEYS touched in settings.local.json, never its values — so secrets never
// land in a terminal transcript or log.
//
// Usage:
//   node scripts/sync-worktree-env.mjs            # copy files that are missing here
//   node scripts/sync-worktree-env.mjs --force     # also overwrite existing files
//   node scripts/sync-worktree-env.mjs --dry-run   # print what would happen, change nothing
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const memoryDir = memoryDirFor(primaryRoot);
const targetExisting = readJsonIfValid(targetClaudeSettings);

if (targetExisting === undefined) {
  console.log(`  claude config: ${claudeSettingsRelPath} exists but is not valid JSON here — leaving it untouched.`);
} else {
  const usingExisting = targetExisting !== null && !force;
  let settings;
  let sourceLabel;
  if (usingExisting) {
    settings = targetExisting;
    sourceLabel = "already present";
  } else {
    const primaryExisting = readJsonIfValid(primaryClaudeSettings);
    settings =
      primaryExisting && typeof primaryExisting === "object" && !Array.isArray(primaryExisting)
        ? JSON.parse(JSON.stringify(primaryExisting))
        : {};
    sourceLabel = primaryExisting ? "copied from primary" : "created new";
  }

  let changed = !usingExisting;
  if (memoryDir) {
    if (settings.autoMemoryDirectory !== memoryDir) {
      settings.autoMemoryDirectory = memoryDir;
      changed = true;
    }
    if (settings.autoMemoryEnabled !== true) {
      settings.autoMemoryEnabled = true;
      changed = true;
    }
  }

  if (!memoryDir && !fs.existsSync(targetClaudeSettings)) {
    console.log("  claude config: could not resolve the primary's auto-memory directory — memory will not be linked.");
  }

  if (dryRun) {
    console.log(
      `  claude config: would-write ${claudeSettingsRelPath} (${sourceLabel}${memoryDir ? ", memory linked" : ""})`,
    );
  } else if (!changed) {
    console.log(`  claude config: ${claudeSettingsRelPath} already linked — nothing to do.`);
  } else {
    fs.mkdirSync(path.dirname(targetClaudeSettings), { recursive: true });
    fs.writeFileSync(targetClaudeSettings, JSON.stringify(settings, null, 2) + "\n");
    console.log(
      `  claude config: wrote ${claudeSettingsRelPath} (${sourceLabel}${memoryDir ? ", memory linked" : ""})`,
    );
  }
}

if (!dryRun) {
  console.log(`sync-worktree-env: done — ${copied} copied, ${skipped} skipped.`);
}
