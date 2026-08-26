#!/usr/bin/env node
// Creates a READY-TO-WORK isolated folder for a new parallel Claude session,
// and reports whether the machine has room for it.
//
// WHY THIS EXISTS
// ---------------
// Two sessions in one folder has caused real incidents here: a session got
// git-detached by another session's checkout, a branch was auto-deleted
// mid-work by a second session reusing its name, a swarm of sessions dropped a
// staged file. The documented answer is "one worktree per session" — but on
// 2026-08-26 all three sibling worktrees had ZERO node_modules and two had no
// .env.local, so none of them could actually run anything. A worktree that
// cannot run a test or a dev server is not a place to work, so every session
// piled back into the primary folder and collided there.
//
// `git worktree add` is only step one of four. It never copies gitignored
// files, so the new folder has no .env.local (dev-auth and Supabase then fail
// silently) and no node_modules (nothing runs at all). This does all four
// steps, in order, and refuses to start when the machine has no headroom.
//
// node_modules is JUNCTIONED, never installed. `pnpm install` inside a worktree
// would duplicate ~1.9M path entries and, worse, `pnpm run <script>` tries to
// PURGE node_modules when it sees the lockfile has moved — destroying the
// primary's install. Invoke node directly inside a worktree; never pnpm.
//
// Usage:
//   node scripts/new-session.mjs <task-slug>           # create ../_wt-<task-slug>
//   node scripts/new-session.mjs --status              # headroom + folder occupancy
//   node scripts/new-session.mjs --repair              # fix worktrees that cannot run
//   node scripts/new-session.mjs --remove <slug>       # retire one, leaving no husk
//   node scripts/new-session.mjs <slug> --from <ref>   # branch off <ref>, not origin/main
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Commit charge, not RAM, is what freezes this machine — and a freeze leaves no
// dump. Below the floor a new session is refused; below the warn line it is
// allowed but called out. Sessions themselves are cheap (~0.5 GB each, measured
// 2026-08-26); what eats commit is a dev server, a build, or a stray script.
const FLOOR_GB = 6;
const WARN_GB = 12;
const SESSION_COST_GB = 0.5;
// A Turbopack dev server, a production build or a cold typecheck each sit in
// this range. This — not the session count — is what actually fills commit.
const HEAVY_JOB_GB = 3.5;

// execFileSync returns NULL, not a string, whenever stdio is inherited — the
// output went straight to the terminal and was never captured. Calling .trim()
// on that crashed the run AFTER the worktree had already been created, leaving
// a half-built folder with no node_modules and no env files.
function git(args, opts = {}) {
  const out = execFileSync("git", args, { encoding: "utf8", ...opts });
  return typeof out === "string" ? out.trim() : "";
}

function fail(message) {
  console.error("\nnew-session aborted — " + message + "\n");
  process.exit(1);
}

function powershell(command) {
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  }).trim();
}

// Win32_OperatingSystem reports the commit LIMIT and its free half, both in KB.
// VirtualSize must never be used for this — it is address-space reservation,
// and on this box Edge reserves 3,621 GB against 503 MB of real commit.
function readCommit() {
  try {
    const out = powershell(
      "$o=Get-CimInstance Win32_OperatingSystem; " +
        "'{0}|{1}' -f $o.TotalVirtualMemorySize,$o.FreeVirtualMemory",
    );
    const [limitKb, freeKb] = out.split("|").map(Number);
    if (!Number.isFinite(limitKb) || !Number.isFinite(freeKb)) return null;
    return { limitGb: limitKb / 1048576, freeGb: freeKb / 1048576 };
  } catch {
    return null;
  }
}

// Only the MAIN electron process is a session. The renderer, gpu, utility and
// crashpad children are shared overhead and would inflate the count by ~2.5x.
function countSessions() {
  try {
    const filter = String.fromCharCode(34) + "Name='claude.exe'" + String.fromCharCode(34);
    const out = powershell(
      "@(Get-CimInstance Win32_Process -Filter " +
        filter +
        " | Where-Object { $_.CommandLine -notmatch '--type=' }).Count",
    );
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

let commonDir;
try {
  commonDir = git(["rev-parse", "--git-common-dir"]);
} catch {
  fail("not inside a git repository.");
}
// The common .git dir's parent is always the PRIMARY worktree, regardless of
// which worktree this is invoked from.
const primaryRoot = path.resolve(path.dirname(commonDir));
const siblingRoot = path.dirname(primaryRoot);

function worktrees() {
  const list = [];
  let cur = {};
  for (const line of git(["worktree", "list", "--porcelain"]).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("worktree ")) cur = { dir: trimmed.slice(9).trim() };
    else if (trimmed.startsWith("branch ")) {
      cur.branch = trimmed.slice(7).replace("refs/heads/", "").trim();
    } else if (trimmed === "detached") cur.branch = "(detached)";
    else if (trimmed === "") {
      if (cur.dir) list.push(cur);
      cur = {};
    }
  }
  if (cur.dir) list.push(cur);
  return list;
}

function ready(dir) {
  const hasEnv = fs.existsSync(path.join(dir, ".env.local"));
  const hasMods = fs.existsSync(path.join(dir, "node_modules"));
  return { hasEnv, hasMods, ok: hasEnv && hasMods };
}

function linkModules(dir) {
  const srcMods = path.join(primaryRoot, "node_modules");
  if (!fs.existsSync(srcMods)) return "the primary has no node_modules — run pnpm install THERE first";
  if (fs.existsSync(path.join(dir, "node_modules"))) return "already present";
  try {
    fs.symlinkSync(srcMods, path.join(dir, "node_modules"), "junction");
    return "junctioned";
  } catch (err) {
    return "could not link: " + err.message;
  }
}

function syncEnv(dir) {
  try {
    execFileSync(process.execPath, [path.join(primaryRoot, "scripts", "sync-worktree-env.mjs")], {
      cwd: dir,
      stdio: "inherit",
    });
    return true;
  } catch {
    return false;
  }
}

const args = process.argv.slice(2);

// ---------------------------------------------------------------- --status
if (args.includes("--status")) {
  const commit = readCommit();
  const sessions = countSessions();
  console.log("\nMachine headroom");
  if (commit) {
    const usedGb = commit.limitGb - commit.freeGb;
    const pct = ((usedGb / commit.limitGb) * 100).toFixed(0);
    console.log(
      "  commit   " +
        usedGb.toFixed(2) +
        " GB used of " +
        commit.limitGb.toFixed(2) +
        " GB (" +
        pct +
        "%) — " +
        commit.freeGb.toFixed(2) +
        " GB free",
    );
    // An IDLE session is ~0.5 GB, so session count is never the real ceiling —
    // a dev server, a build or a typecheck is 3-4 GB and that is what fills the
    // commit charge. Report the number that actually binds.
    const idleRoom = Math.max(0, Math.floor((commit.freeGb - FLOOR_GB) / SESSION_COST_GB));
    const heavyRoom = Math.max(0, Math.floor((commit.freeGb - FLOOR_GB) / HEAVY_JOB_GB));
    console.log("  idle sessions that fit    ~" + idleRoom + "  (a session on its own is only ~0.5 GB)");
    console.log(
      "  HEAVY jobs that fit       " +
        heavyRoom +
        "  <- this is the real limit (a dev server / build / typecheck is ~" +
        HEAVY_JOB_GB +
        " GB each)",
    );
  } else {
    console.log("  could not read the commit charge");
  }
  if (sessions !== null) console.log("  claude sessions running: " + sessions);

  console.log("\nFolders (one session each — never two in the same one)");
  // Column widths are measured, never fixed: a branch name here can run past 50
  // characters, and the owner's standing rule is that nothing truncates and
  // nothing wraps.
  const rows = worktrees().map((w) => {
    const r = ready(w.dir);
    const missing = [];
    if (!r.hasEnv) missing.push(".env.local");
    if (!r.hasMods) missing.push("node_modules");
    return {
      label: path.resolve(w.dir) === primaryRoot ? "PRIMARY" : path.basename(w.dir),
      branch: String(w.branch || "?"),
      state: r.ok ? "ready" : "NOT RUNNABLE — missing " + missing.join(" + "),
    };
  });
  const labelWidth = Math.max(...rows.map((r) => r.label.length)) + 2;
  const branchWidth = Math.max(...rows.map((r) => r.branch.length)) + 2;
  for (const row of rows) {
    console.log("  " + row.label.padEnd(labelWidth) + row.branch.padEnd(branchWidth) + row.state);
  }
  console.log(
    "\n  The primary folder is the control tower — reviews, merges, DB work.\n" +
      "  Feature edits belong in a _wt-* folder, one session per folder.\n",
  );
  process.exit(0);
}

// ---------------------------------------------------------------- --repair
if (args.includes("--repair")) {
  console.log("\nRepairing worktrees that cannot run\n");
  let fixed = 0;
  for (const w of worktrees()) {
    if (path.resolve(w.dir) === primaryRoot) continue;
    // Worktrees under .claude/worktrees/ belong to other LIVE sessions. Leave
    // them alone entirely — that folder is not ours to write into.
    if (path.resolve(w.dir).includes(path.join(".claude", "worktrees"))) {
      console.log("  " + path.basename(w.dir) + "  skipped — belongs to another live session");
      continue;
    }
    const before = ready(w.dir);
    if (before.ok) {
      console.log("  " + path.basename(w.dir).padEnd(34) + "already ready");
      continue;
    }
    console.log("  " + path.basename(w.dir));
    if (!before.hasMods) console.log("     node_modules: " + linkModules(w.dir));
    if (!before.hasEnv) {
      console.log("     env files:");
      syncEnv(w.dir);
    }
    const after = ready(w.dir);
    console.log("     -> " + (after.ok ? "READY" : "still incomplete"));
    if (after.ok) fixed += 1;
  }
  console.log("\n" + fixed + " worktree(s) made runnable.\n");
  process.exit(0);
}

// A junction must be unlinked BEFORE `git worktree remove` runs. Measured with
// a decoy target on 2026-08-26: git does NOT follow the junction (the target's
// files survive untouched, so there is no data-loss hazard) — but it also
// cannot delete it. It deregisters the worktree and removes every tracked file,
// then leaves the folder behind holding just the link, with no .git entry.
//
// That is precisely the HUSK condition: invisible to `git worktree prune`, and
// repo-doctor --fix refuses to clear it because the junction makes the folder
// look like it still holds 1.9M paths. Husks then accumulate forever.
//
// cmd's rmdir without /s removes only the reparse point. Remove-Item in Windows
// PowerShell 5.1 and fs.rmSync are both unreliable here — one can follow the
// link, the other EPERMs on a dangling pnpm junction.
function dropModulesJunction(dir) {
  const nm = path.join(dir, "node_modules");
  if (!fs.existsSync(nm)) return "absent";
  let stat;
  try {
    stat = fs.lstatSync(nm);
  } catch {
    return "unreadable — left alone";
  }
  if (!stat.isSymbolicLink()) return "a REAL folder, not a junction — left alone";
  try {
    execFileSync("cmd", ["/c", "rmdir", nm], { stdio: "ignore" });
  } catch {
    /* fall through to the existence check below */
  }
  return fs.existsSync(nm) ? "could not unlink" : "unlinked";
}

// Never delete a spreadsheet or a PDF, even a stray untracked one in a folder
// being cleaned up. Junctions are stepped over, never walked into — following
// one would scan the primary's whole node_modules.
function findSpreadsheets(dir) {
  const hits = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next") continue;
        walk(full);
      } else if (/\.(xlsx|xlsm|xls|pdf)$/i.test(entry.name)) {
        hits.push(full);
      }
    }
  };
  walk(dir);
  return hits;
}

// ---------------------------------------------------------------- --remove
if (args.includes("--remove")) {
  const target = args[args.indexOf("--remove") + 1];
  if (!target) fail("name the folder to remove, e.g. `--remove payroll-rounding`.");
  const dir = fs.existsSync(target)
    ? path.resolve(target)
    : path.join(siblingRoot, "_wt-" + target.replace(/^_wt-/, ""));

  if (!fs.existsSync(dir)) fail(dir + " does not exist.");
  if (path.resolve(dir) === primaryRoot) fail("that is the PRIMARY checkout. It is never removed.");
  if (path.resolve(dir).includes(path.join(".claude", "worktrees"))) {
    fail("that worktree belongs to another live session. Leave it alone.");
  }

  const entry = worktrees().find((w) => path.resolve(w.dir) === path.resolve(dir));
  if (!entry) fail(dir + " is not a registered worktree.");

  console.log("\nRemoving " + dir + "  (" + entry.branch + ")\n");

  // Three refusals, in the order that a mistake would hurt most.
  const strays = findSpreadsheets(dir).filter((f) => {
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", path.relative(dir, f)], {
        cwd: dir,
        stdio: "ignore",
      });
      return false; // tracked — an identical copy is already in the repo
    } catch {
      return true; // untracked — this is the only copy there is
    }
  });
  if (strays.length) {
    console.error("  REFUSED — untracked spreadsheets/PDFs live here and are the only copy:");
    for (const f of strays) console.error("    " + f);
    fail("move them into the repo's xlsx/ folder first, then remove this worktree.");
  }

  const dirty = execFileSync("git", ["status", "--porcelain", "-uall"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  if (dirty) {
    console.error("  REFUSED — uncommitted work here:");
    for (const line of dirty.split("\n").slice(0, 20)) console.error("    " + line);
    fail("commit or stash it first — this may be another session's work.");
  }

  const unpushed = execFileSync("git", ["log", "origin/main..HEAD", "--oneline"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  const pushed = (() => {
    if (!entry.branch || entry.branch === "(detached)") return false;
    try {
      return git(["ls-remote", "--heads", "origin", entry.branch]).length > 0;
    } catch {
      return false;
    }
  })();
  if (unpushed && !pushed) {
    console.error("  REFUSED — commits here are on no remote branch:");
    for (const line of unpushed.split("\n").slice(0, 10)) console.error("    " + line);
    fail(
      "push the branch, or keep the tip with `git branch rescue/" +
        (entry.branch || "tip") +
        " " +
        entry.branch +
        "` — that costs nothing and loses nothing.",
    );
  }

  console.log("  spreadsheets/PDFs   none untracked");
  console.log("  uncommitted work    none");
  console.log("  unpushed commits    " + (unpushed ? "present, but the branch is on origin" : "none"));
  console.log("  node_modules        " + dropModulesJunction(dir));

  git(["worktree", "remove", dir]);
  const husk = fs.existsSync(dir);
  console.log("  worktree removed    " + (husk ? "folder REMAINS — a husk" : "yes, no husk left"));
  if (husk) {
    console.log("    clear it by hand:  rmdir /s /q " + JSON.stringify(dir));
  }
  console.log(
    "\nThe branch " +
      entry.branch +
      " still exists locally. Delete it only once `gh pr list --head " +
      entry.branch +
      " --state merged` confirms the work landed.\n",
  );
  process.exit(0);
}

// ---------------------------------------------------------------- create
const slug = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--from");
if (!slug) fail("give the task a short name, e.g. `node scripts/new-session.mjs payroll-rounding`.");
if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(slug)) {
  fail('"' + slug + '" is not a usable name — lowercase letters, digits and dashes only.');
}

const fromIdx = args.indexOf("--from");
const baseRef = fromIdx !== -1 ? args[fromIdx + 1] : "origin/main";
const dir = path.join(siblingRoot, "_wt-" + slug);
const branch = "codex/" + slug;

const commit = readCommit();
if (commit) {
  console.log(
    "commit: " + commit.freeGb.toFixed(2) + " GB free of " + commit.limitGb.toFixed(2) + " GB",
  );
  if (commit.freeGb < FLOOR_GB) {
    fail(
      "only " +
        commit.freeGb.toFixed(2) +
        " GB of commit is free (the floor is " +
        FLOOR_GB +
        " GB). Close a session or stop a dev server first — running out of commit " +
        "freezes the box with no crash dump.",
    );
  }
  if (commit.freeGb < WARN_GB) {
    console.log(
      "  warning: under " +
        WARN_GB +
        " GB free. Fine for editing, but do not start a dev server or a build in parallel.",
    );
  }
}

if (fs.existsSync(dir)) fail(dir + " already exists. Pick another name, or work in that folder.");

let branchExists = false;
try {
  git(["rev-parse", "--verify", "--quiet", "refs/heads/" + branch]);
  branchExists = true;
} catch {
  branchExists = false;
}
// Reusing a squash-merged branch name makes a conflicting PR, and a conflicted
// PR runs no CI at all — which reads as "checks not started", not as a failure.
if (branchExists) fail("branch " + branch + " already exists locally. Pick a different task name.");

console.log("\n1/4  fetching origin/main");
try {
  git(["fetch", "origin", "main", "--quiet"]);
} catch {
  console.log("     fetch failed — falling back to the local ref you already have.");
}

console.log("2/4  creating " + dir + " on " + branch);
// -q suppresses the per-file "Updating files: 41% (2075/5059)" progress, which
// on a 5,000-file checkout floods the transcript with hundreds of lines.
git(["worktree", "add", "-q", dir, "-b", branch, baseRef]);

console.log("3/4  junctioning node_modules from the primary (never installing)");
console.log("     " + linkModules(dir));

console.log("4/4  copying the gitignored env files");
if (!syncEnv(dir)) console.log("     env sync failed — copy .env.local by hand before using dev-auth.");

const result = ready(dir);
console.log("\n" + (result.ok ? "READY" : "INCOMPLETE") + "   " + dir);
console.log("  branch        " + branch + "  (from " + baseRef + ")");
console.log("  .env.local    " + (result.hasEnv ? "yes" : "MISSING"));
console.log("  node_modules  " + (result.hasMods ? "junctioned" : "MISSING"));
console.log("\nOpen a session there — point the new session at this folder:");
console.log('  cd "' + dir + '"');
console.log("\nInside that folder invoke node directly (node scripts/…).");
console.log("Never run pnpm there — it purges the primary's node_modules when the lockfile moved.\n");
