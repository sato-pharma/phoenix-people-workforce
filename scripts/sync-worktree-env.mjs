#!/usr/bin/env node
// Copies the gitignored local env files (.env.local, .env.*.rls.local,
// .env.analytics, etc.) from the primary worktree into the CURRENT worktree.
//
// `git worktree add` never copies gitignored files — every new worktree starts
// with none of them, so dev-auth (PHOENIX_AUTH_SECRET), Supabase, and other
// local-only config silently break until someone copies .env.local by hand.
//
// Never prints file contents — only filenames and byte counts — so secrets
// never land in a terminal transcript or log.
//
// Usage:
//   node scripts/sync-worktree-env.mjs            # copy files that are missing here
//   node scripts/sync-worktree-env.mjs --force     # also overwrite existing files
//   node scripts/sync-worktree-env.mjs --dry-run   # print what would happen, change nothing
import { execFileSync } from "node:child_process";
import fs from "node:fs";
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

if (candidates.length === 0) {
  console.log("sync-worktree-env: no local env files found in the primary worktree (" + primaryRoot + ").");
  process.exit(0);
}

console.log("sync-worktree-env: primary=" + primaryRoot);
console.log("sync-worktree-env: target =" + currentRoot);

let copied = 0;
let skipped = 0;
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

if (!dryRun) {
  console.log(`sync-worktree-env: done — ${copied} copied, ${skipped} skipped.`);
}
