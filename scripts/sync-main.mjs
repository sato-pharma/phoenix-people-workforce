// scripts/sync-main.mjs
//
// Safely fast-forward the local `main` branch to match origin/main (production).
//
// Design goals (never lose work):
//   - Refuses if `main` has any commit not on origin/main (would need a real merge).
//   - Refuses if the main worktree has uncommitted changes (could lose edits).
//   - Only ever fast-forwards (`merge --ff-only`) — never creates a merge commit.
//
// Usage:  pnpm run sync:main
import { execFileSync } from "node:child_process";

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
}

function fail(message) {
  console.error("sync:main aborted — " + message);
  process.exit(1);
}

// 1. Pull the latest production ref.
git(["fetch", "origin", "main", "--quiet"]);

// 2. Find which worktree currently has `main` checked out.
let mainWt = null;
let cur = {};
for (const line of git(["worktree", "list", "--porcelain"]).split("\n")) {
  if (line.startsWith("worktree ")) cur = { path: line.slice("worktree ".length) };
  else if (line.startsWith("branch ")) cur.branch = line.slice("branch ".length);
  else if (line === "") {
    if (cur.branch === "refs/heads/main") mainWt = cur.path;
    cur = {};
  }
}
if (cur.branch === "refs/heads/main") mainWt = cur.path;
if (!mainWt) fail("no worktree has `main` checked out.");

// 3. Safety: main must have ZERO unique local commits.
if (git(["-C", mainWt, "rev-list", "origin/main..main"])) {
  fail("local main has commits not on origin/main. Resolve manually — refusing to touch it.");
}

// 4. Safety: the main worktree must be clean.
const dirty = git(["-C", mainWt, "status", "--porcelain"]);
if (dirty) fail("the main worktree has uncommitted changes:\n" + dirty);

// 5. Fast-forward only.
const before = git(["-C", mainWt, "rev-parse", "--short", "HEAD"]);
git(["-C", mainWt, "merge", "--ff-only", "origin/main"]);
const after = git(["-C", mainWt, "rev-parse", "--short", "HEAD"]);

if (before === after) {
  console.log("main already in sync with production (" + after + ").");
} else {
  console.log("main fast-forwarded " + before + " -> " + after + " (now matches production).");
}
