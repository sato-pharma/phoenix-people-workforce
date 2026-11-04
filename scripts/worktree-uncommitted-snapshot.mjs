#!/usr/bin/env node
// Hourly snapshot of work that exists ONLY on this disk: every uncommitted file and every unpushed
// commit, in every Phoenix worktree.
//
// WHY THIS EXISTS. Measured 2026-10-04: two sibling worktrees held 30 uncommitted files and one
// unpushed commit between them, none of it anywhere else. A `git clean`, `reset --hard`, `stash -u`,
// `checkout --` or a worktree removal takes that permanently, and those are the losses that actually
// happen here. A one-off copy is not enough — the count went 19 -> 30 inside the few minutes it took
// to measure and copy it, because the other sessions are live.
//
// 🔴 WHAT IT DOES NOT DO. `C:` and `F:` are two partitions of ONE physical NVMe (disk 0, PM981a
// Samsung 512GB), so this is NOT protection from losing the disk. The only off-machine copy is a
// push to GitHub, which for another session's branch is that session's own call. Never describe this
// as a disk-failure backup.
//
// 🔴 IT NEVER DELETES ANYTHING. The owner's standing rule protects .md/.html/.pdf/.xlsx/.docx/.svg
// in every folder, and a snapshot of this repo is full of `.md` — so there is no retention sweep and
// no pruning, ever. Growth is bounded instead by CONTENT ADDRESSING: every distinct file content is
// stored once under `_blobs/<ab>/<sha256>` and each snapshot links to it, so an hour in which
// nothing changed costs a manifest and nothing else.
//
// READ-ONLY on every worktree it reads. It never stages, commits, pushes, checks out, or writes a
// single byte inside a worktree. `git bundle create` is used for unpushed commits precisely because
// it creates no ref and moves no branch.
//
// USAGE
//   node worktree-uncommitted-snapshot.mjs [--quiet] [--dry-run] [--root <dir>] [--dest <dir>]
//
// Exit 0 when the snapshot is sound (including "nothing changed"). Exit 1 only on a real failure,
// which is what a failure alert should key on.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : d);

const QUIET = has("--quiet");
const DRY = has("--dry-run");
const PRIMARY = val("--root", "F:/Phoenix Workforce/phoenix-workforce");
const PARENT = path.dirname(PRIMARY);
const DEST_ROOT = val("--dest", "F:/PHX backup/08-worktree-uncommitted");
const BLOBS = path.join(DEST_ROOT, "_blobs");
const LOG = path.join(os.homedir(), ".claude", "scripts", "worktree-snapshot.log");
const ALIVE = path.join(os.homedir(), ".claude", "scripts", "worktree-snapshot.alive");
const LOG_MAX_LINES = 1500;

// A file this big is not somebody's source edit; it is a build artifact that wandered into a
// `git status`. Copying one hourly would fill the disk this is meant to protect.
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const problems = [];
const lines = [];
function say(text) {
  lines.push(text);
  if (!QUIET) console.log(text);
}

function stampNow() {
  // Cairo, because every report on this machine is Cairo local (owner rule).
  return new Date()
    .toLocaleString("sv-SE", { timeZone: "Africa/Cairo" })
    .replace(" ", "_")
    .replace(/:/g, "")
    .slice(0, 15);
}

function git(cwd, gitArgs) {
  const run = spawnSync("git", gitArgs, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { out: (run.stdout ?? "").trim(), err: (run.stderr ?? "").trim(), code: run.status ?? 1 };
}

/**
 * 🔴 `git status --porcelain` MUST NOT be read through `git()` above, because its `.trim()` eats the
 * LEADING STATUS SPACE of the first line only — ` M path` becomes `M path`, so `slice(3)` then
 * returns `ath` and that file is silently skipped. Measured on the first dry run: exactly one path
 * per worktree lost its first character (`.claude/…` -> `claude/…`, `app/…` -> `pp/…`), which is the
 * signature of a whole-output trim rather than a parsing mistake. Only trailing newlines may go.
 */
function gitPorcelain(cwd, gitArgs) {
  const run = spawnSync("git", gitArgs, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    lines: (run.stdout ?? "").replace(/\r?\n$/, "").split(/\r?\n/).filter((l) => l.length > 0),
    err: (run.stderr ?? "").trim(),
    code: run.status ?? 1,
  };
}

/**
 * The mobile app is FROZEN (AGENTS.md §4) and the repo's own automation excludes a frozen path from
 * anything it handles in bulk — `rollup-prs.mjs` holds such a PR out rather than touching it. An
 * hourly sweep is exactly that kind of bulk handling, so a frozen path is left alone here too.
 */
const FROZEN_PREFIXES = ["mobile/"];
const isFrozen = (rel) => FROZEN_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p));

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * Every worktree worth reading: the ones git itself registers, plus any sibling `_wt-*` folder that
 * holds a `.git` entry. Both, because `git worktree list` misses a folder git never registered and a
 * directory scan misses `.claude/worktrees/*` — and a stale husk belongs to neither.
 */
function discoverWorktrees() {
  const found = new Map();
  const listed = git(PRIMARY, ["worktree", "list", "--porcelain"]).out;
  for (const block of listed.split("\n\n")) {
    const m = /^worktree (.+)$/m.exec(block);
    if (m) found.set(path.resolve(m[1]), path.basename(m[1]));
  }
  try {
    for (const name of fs.readdirSync(PARENT)) {
      if (!name.startsWith("_wt-")) continue;
      const dir = path.join(PARENT, name);
      if (fs.existsSync(path.join(dir, ".git"))) found.set(path.resolve(dir), name);
    }
  } catch {
    // The parent directory is unreadable — the registered list above still stands.
  }
  // The primary itself is included deliberately: a session can leave uncommitted work there too.
  return [...found.entries()].map(([dir, label]) => ({ dir, label }));
}

/** Store one buffer once, and hard-link it into the snapshot so the snapshot stays browsable. */
function storeBlob(buf, linkTo) {
  const hash = sha256(buf);
  const blob = path.join(BLOBS, hash.slice(0, 2), hash);
  if (DRY) return { hash, reused: fs.existsSync(blob) };
  const reused = fs.existsSync(blob);
  if (!reused) {
    fs.mkdirSync(path.dirname(blob), { recursive: true });
    fs.writeFileSync(blob, buf);
  }
  fs.mkdirSync(path.dirname(linkTo), { recursive: true });
  try {
    fs.linkSync(blob, linkTo);
  } catch {
    // A hard link needs one volume and a filesystem that allows it; a plain copy is always correct.
    fs.writeFileSync(linkTo, buf);
  }
  if (sha256(fs.readFileSync(linkTo)) !== hash) problems.push(`${linkTo} — the stored copy does not match its source`);
  return { hash, reused };
}

function snapshotWorktree(wt, snapDir) {
  const status = gitPorcelain(wt.dir, ["status", "--porcelain"]);
  if (status.code !== 0) {
    problems.push(`${wt.label} — git status failed: ${status.err.split("\n")[0]}`);
    return null;
  }
  const porcelain = status.lines;
  const unpushed = Number(git(wt.dir, ["rev-list", "--count", "origin/main..HEAD"]).out || 0);
  if (porcelain.length === 0 && unpushed === 0) return null; // nothing exists only here

  const entry = {
    worktree: wt.label,
    dir: wt.dir,
    branch: git(wt.dir, ["branch", "--show-current"]).out,
    head: git(wt.dir, ["log", "-1", "--format=%H %s"]).out,
    unpushedCommits: unpushed,
    unpushedLog: unpushed > 0 ? git(wt.dir, ["log", "--oneline", "origin/main..HEAD"]).out.split("\n") : [],
    porcelain,
    files: [],
    skipped: [],
    blobsNew: 0,
    blobsReused: 0,
  };

  for (const line of porcelain) {
    const state = line.slice(0, 2).trim();
    // A rename reads "R  old -> new"; the new path is the one that exists on disk.
    const rel = line.slice(3).split(" -> ").pop().replace(/^"|"$/g, "");
    if (isFrozen(rel)) {
      entry.skipped.push({ path: rel, state, why: "a frozen path (AGENTS.md §4) — left alone" });
      continue;
    }
    const src = path.join(wt.dir, rel);
    let stat;
    try {
      stat = fs.statSync(src);
    } catch {
      // A deletion (` D`) has no file to copy, and the patch below carries it anyway.
      entry.skipped.push({ path: rel, state, why: "not on disk (a deletion, or already moved)" });
      continue;
    }
    if (stat.isDirectory()) {
      entry.skipped.push({ path: rel, state, why: "a directory, not a file" });
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      entry.skipped.push({ path: rel, state, why: `${stat.size} bytes, over the ${MAX_FILE_BYTES} cap` });
      continue;
    }
    const before = stat.mtimeMs;
    let buf;
    try {
      buf = fs.readFileSync(src);
    } catch (error) {
      problems.push(`${wt.label}: ${rel} — unreadable: ${String(error.message || error)}`);
      continue;
    }
    const after = fs.statSync(src).mtimeMs;
    const { hash, reused } = storeBlob(buf, path.join(snapDir, wt.label, rel));
    if (reused) entry.blobsReused += 1;
    else entry.blobsNew += 1;
    entry.files.push({ path: rel, state, bytes: buf.length, sha256: hash, editedDuringRead: before !== after });
    if (before !== after) {
      // Not a failure: a live session saved while we read. Said out loud so the next run is trusted.
      entry.skipped.push({ path: rel, state, why: "the session saved it mid-read; this hour's copy may be torn" });
    }
  }

  const patch = git(wt.dir, ["diff"]).out;
  if (patch.length > 0) {
    const { hash } = storeBlob(Buffer.from(patch + "\n", "utf8"), path.join(snapDir, wt.label, "_tracked-changes.patch"));
    entry.patch = { bytes: patch.length, sha256: hash };
  }

  if (unpushed > 0) {
    const out = path.join(snapDir, wt.label, "_unpushed-commits.bundle");
    if (!DRY) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const made = git(wt.dir, ["bundle", "create", out, "origin/main..HEAD"]);
      if (made.code !== 0 || !fs.existsSync(out)) {
        problems.push(`${wt.label} — git bundle failed: ${made.err.split("\n").slice(-1)[0]}`);
      } else {
        entry.bundle = { bytes: fs.statSync(out).size, verified: git(wt.dir, ["bundle", "verify", out]).code === 0 };
        if (!entry.bundle.verified) problems.push(`${wt.label} — the commit bundle does not verify`);
      }
    }
  }
  return entry;
}

/** The fingerprint of everything that exists only on this disk, so an unchanged hour writes nothing. */
const fingerprintOf = (worktrees) =>
  sha256(
    Buffer.from(
      JSON.stringify(
        worktrees.map((w) => [w.worktree, w.branch, w.head, w.unpushedCommits, w.files.map((f) => [f.path, f.sha256])]),
      ),
      "utf8",
    ),
  );

function appendLog(text) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    let existing = "";
    try {
      existing = fs.readFileSync(LOG, "utf8");
    } catch {
      existing = "";
    }
    const kept = (existing + text + "\n").split("\n");
    // Trimming its OWN log is not a protected-file delete; the cap keeps it readable.
    fs.writeFileSync(LOG, kept.slice(Math.max(0, kept.length - LOG_MAX_LINES)).join("\n"), "utf8");
  } catch {
    // A log that cannot be written must never fail the snapshot it is logging.
  }
}

// ── run ───────────────────────────────────────────────────────────────────────────────────────────
const startedAt = Date.now();
const stamp = stampNow();
const snapDir = path.join(DEST_ROOT, stamp);
const worktrees = [];

for (const wt of discoverWorktrees()) {
  const entry = snapshotWorktree(wt, snapDir);
  if (entry) worktrees.push(entry);
}

const fingerprint = fingerprintOf(worktrees);
const statePath = path.join(DEST_ROOT, "_last-fingerprint.txt");
let previous = "";
try {
  previous = fs.readFileSync(statePath, "utf8").trim();
} catch {
  previous = "";
}
const unchanged = previous === fingerprint && worktrees.length > 0;

const totals = {
  worktreesWithWork: worktrees.length,
  files: worktrees.reduce((n, w) => n + w.files.length, 0),
  blobsNew: worktrees.reduce((n, w) => n + w.blobsNew, 0),
  blobsReused: worktrees.reduce((n, w) => n + w.blobsReused, 0),
  unpushedCommits: worktrees.reduce((n, w) => n + w.unpushedCommits, 0),
  skipped: worktrees.reduce((n, w) => n + w.skipped.length, 0),
};

if (!DRY) {
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(
    path.join(snapDir, "manifest.json"),
    JSON.stringify(
      {
        generatedAtCairo: new Date().toLocaleString("en-GB", { timeZone: "Africa/Cairo" }),
        stamp,
        fingerprint,
        unchangedSinceLastRun: unchanged,
        totals,
        problems,
        worktrees,
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(DEST_ROOT, "README.md"),
    "# Uncommitted worktree work — hourly snapshot\n\n" +
      "Every uncommitted file and every unpushed commit in every Phoenix worktree, taken hourly by\n" +
      "`~/.claude/scripts/worktree-uncommitted-snapshot.mjs` (scheduled task **Phoenix Worktree\n" +
      "Snapshot - Hourly**). Read-only: nothing is ever staged, committed, pushed or changed inside a\n" +
      "worktree.\n\n" +
      "## What it protects against, and what it does NOT\n\n" +
      "Guards a `git clean`, `reset --hard`, `stash -u`, `checkout --` or a worktree removal from\n" +
      "taking work that exists nowhere else. It does **NOT** survive losing the disk: `C:` and `F:`\n" +
      "are partitions of ONE physical NVMe (disk 0, PM981a Samsung 512GB). The only off-machine copy\n" +
      "is a push to GitHub.\n\n" +
      "## Layout\n\n" +
      "- `<YYYY-MM-DD_HHmm>/<worktree>/<original path>` — the files, hard-linked to `_blobs/`\n" +
      "- `<stamp>/<worktree>/_tracked-changes.patch` — the modified tracked files, as one patch\n" +
      "- `<stamp>/<worktree>/_unpushed-commits.bundle` — `git bundle` of `origin/main..HEAD`\n" +
      "- `<stamp>/manifest.json` — per file: git state, size, sha256; per worktree: branch, HEAD,\n" +
      "  unpushed commits, and anything skipped with the reason\n" +
      "- `_blobs/<ab>/<sha256>` — each distinct content stored ONCE; snapshots hard-link to it, so an\n" +
      "  hour with no change costs a manifest\n\n" +
      "**Nothing here is ever deleted.** The owner's standing rule protects `.md`/`.html`/`.pdf`/\n" +
      "`.xlsx`/`.docx`/`.svg` in every folder and these snapshots are full of `.md`, so there is no\n" +
      "retention sweep. Content addressing is what bounds the growth.\n\n" +
      "## Restoring\n\n" +
      "    git apply \"<stamp>/<worktree>/_tracked-changes.patch\"      # the modified tracked files\n" +
      "    git fetch \"<stamp>/<worktree>/_unpushed-commits.bundle\"    # the unpushed commits\n\n" +
      "Untracked files (`??` in `manifest.json`) exist only as the copies here — copy those back over\n" +
      "the same relative paths.\n",
    "utf8",
  );
  fs.writeFileSync(statePath, fingerprint + "\n", "utf8");
  fs.writeFileSync(ALIVE, new Date().toISOString() + "\n", "utf8");
}

say(`destination : ${snapDir}${DRY ? "  (dry run, nothing written)" : ""}`);
for (const w of worktrees) {
  say(
    `  ${w.worktree}  [${w.branch}]  ${w.files.length} file(s), ${w.unpushedCommits} unpushed` +
      `${w.bundle ? ` (bundled ${w.bundle.bytes}B, verified ${w.bundle.verified})` : ""}` +
      `  new ${w.blobsNew} / reused ${w.blobsReused}`,
  );
  for (const s of w.skipped) say(`      skipped ${s.path} — ${s.why}`);
}
const verdict = problems.length > 0 ? "FAIL" : unchanged ? "OK (nothing changed this hour)" : "OK";
say(
  `${verdict} — ${totals.worktreesWithWork} worktree(s), ${totals.files} file(s) ` +
    `(${totals.blobsNew} new / ${totals.blobsReused} already stored), ` +
    `${totals.unpushedCommits} unpushed commit(s), ${totals.skipped} skipped, ${Date.now() - startedAt}ms`,
);
if (problems.length > 0) for (const p of problems) say(`  PROBLEM ${p}`);

appendLog(`[${new Date().toISOString()}] ${verdict} ${JSON.stringify(totals)}${problems.length ? " PROBLEMS: " + problems.join(" | ") : ""}`);
process.exit(problems.length > 0 ? 1 : 0);
