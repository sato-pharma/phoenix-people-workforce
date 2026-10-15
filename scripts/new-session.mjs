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
//   node scripts/new-session.mjs --repair --nested     # ...and re-link node_modules (only) in .claude/worktrees/*
//   node scripts/new-session.mjs --remove <slug>       # retire one, leaving no husk
//   node scripts/new-session.mjs <slug> --from <ref>   # branch off <ref>, not origin/main
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { linkNodeModules } from "./lib/link-node-modules.mjs";
import { isShaLike, pickMergedPrForTip, removalVerdict } from "./lib/remove-gate.mjs";
import { countUnpushedCommits } from "./repo-doctor-unpushed.mjs";
import {
  directoriesLinkedThrough,
  isLoadBearing,
  linksThroughFolder,
} from "./repo-doctor-load-bearing.mjs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "new-session",
  entry: import.meta.url,
  known: ["--from", "--nested", "--remove", "--repair", "--status"],
  hints: [
    "node scripts/new-session.mjs <task> creates a worktree; --remove <task> retires one; --status and --repair read and mend",
  ],
});

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

/**
 * The commit a worktree is sitting on, or NULL when git could not say.
 *
 * The one thing a DETACHED HEAD still has: `worktrees()` reports its branch as the literal string
 * "(detached)", which is useless in a command, so anything advising the reader how to keep a tip has
 * to name the sha instead.
 *
 * 🔴 IT USED TO FALL BACK TO THE STRING `"HEAD"`, AND THAT IS A VALUE WHICH READS AS A SHA, PRINTS
 * AS A SHA AND IS NOT ONE. Measured 2026-10-02: `--remove` prints advice telling the reader to
 * compare the merged PR's `headRefOid` against this sha, and it prints AFTER `git worktree remove`,
 * so the call threw and the sentence came out as *"its headRefOid equal to HEAD"* — a check against
 * nothing in particular, in the one line whose whole job was to name a commit. #5119 fixed that call
 * site by reading the tip earlier; this removes the class, because the next caller to ask at a
 * moment git cannot answer would have got the same plausible-looking nonsense.
 *
 * `null` forces each caller to say what it does not know. Every one of them does now, and the two
 * that write a runnable command name something the reader can still run — the branch, or a
 * `rev-parse` against the folder, both of which exist at the moment that advice prints.
 */
function headSha(dir) {
  try {
    const sha = git(["rev-parse", "HEAD"], { cwd: dir });
    // A truthy-but-empty answer is not a sha either. `git rev-parse` has no business returning one,
    // and the point of this change is that nothing here may hand back a value that merely looks ok.
    return isShaLike(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** The short form for a message, or null when there is no sha to shorten. */
function shortSha(sha) {
  return typeof sha === "string" ? sha.slice(0, 9) : null;
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
  // Shared with sync-worktree-env.mjs so both create the junction identically —
  // see scripts/lib/link-node-modules.mjs for why a worktree is junctioned and
  // never installed.
  return linkNodeModules(dir, primaryRoot);
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

// CLAIM THE NEW WORKTREE FOR THE SESSION THAT ASKED FOR IT. A desktop-app session is pinned to the
// `.claude/worktrees/<name>` folder it started in, so it keeps working from there — and until
// 2026-09-18 `.claude/hooks/primary-write-guard.mjs` denied its Edit and Write tools on every file
// of the worktree it had just made here, as "another session worktree". The guard now lets in the
// session this claim names, while no other session is working in the worktree.
//
// The id is CLAUDE_CODE_SESSION_ID: the harness sets it for every Bash child, and it is the value
// hooks receive as `session_id` (session-lock.mjs stores it in every lock). CLAUDE_PROJECT_DIR is
// NOT set here — only hooks get it. Run from a plain terminal there is no session to name, so
// nothing is claimed and the folder stays open only to a session started inside it, as before.
//
// The claim goes in the worktree's git ADMIN folder (<common .git>/worktrees/<name>/), never in the
// folder itself: nothing there can be staged, committed or copied into another tree, and
// `git worktree remove`/`prune` delete it with the registration. Only a folder THIS run created is
// claimed — --repair never claims, since the worktree it touches may be another session's.
const CLAIM_FILE = "phx-session-owner.json";

function claimForThisSession(dir, branch) {
  const sessionId = String(process.env.CLAUDE_CODE_SESSION_ID || "").trim();
  if (!sessionId) {
    return { claimed: false, note: "unclaimed — no Claude session ran this, so only a session opened there may edit it" };
  }
  try {
    const adminDir = git(["-C", dir, "rev-parse", "--path-format=absolute", "--git-dir"]);
    // A linked worktree's admin folder is <common>/worktrees/<name>. Anything else means `dir` is
    // not the worktree just created, and a claim there would name the wrong tree.
    if (path.basename(path.dirname(adminDir)) !== "worktrees") {
      return { claimed: false, note: "unclaimed — " + adminDir + " is not a worktree admin folder" };
    }
    const claim = { sessionId, worktree: dir, branch, claimedAt: new Date().toISOString(), by: "scripts/new-session.mjs" };
    fs.writeFileSync(path.join(adminDir, CLAIM_FILE), JSON.stringify(claim, null, 2) + "\n");
    return { claimed: true, note: "claimed for this Claude session — its Edit and Write tools may write here" };
  } catch (error) {
    return { claimed: false, note: "unclaimed — " + (error instanceof Error ? error.message : String(error)) };
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
    //
    // ONE EXCEPTION, ASKED FOR BY NAME: `--nested` re-links a MISSING node_modules in them and does
    // nothing else (no env files, no claim, no git). It exists because `repo-doctor --strip-idle`
    // tells whoever lost a node_modules to run this, and a live session never fires SessionStart
    // again, so sync-worktree-env's self-heal cannot reach it. A link is the whole repair: the
    // junction is written beside the tree's files, never into them, and is exactly what the
    // session had before.
    if (path.resolve(w.dir).includes(path.join(".claude", "worktrees"))) {
      if (!args.includes("--nested")) {
        console.log(
          "  " + path.basename(w.dir) + "  skipped — belongs to another live session (--nested re-links its node_modules)",
        );
        continue;
      }
      const nested = ready(w.dir);
      if (nested.hasMods) {
        console.log("  " + path.basename(w.dir).padEnd(34) + "node_modules present");
        continue;
      }
      console.log("  " + path.basename(w.dir));
      console.log("     node_modules: " + linkModules(w.dir));
      if (ready(w.dir).hasMods) fixed += 1;
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
  // 🔴 THE JUNCTION CAN BE CARRYING THE PRIMARY'S OWN DEPENDENCIES. A stray `pnpm run` inside a
  // worktree rewrites the PRIMARY's top-level package links to absolute paths routed through
  // `<this worktree>\node_modules\.pnpm\…`, which resolve only while this junction stands. Unlink
  // it and the primary cannot import anything — ERR_MODULE_NOT_FOUND everywhere, which is what
  // happened three times on 2026-10-09 (see scripts/repo-doctor-load-bearing.mjs). Retiring the
  // folder is not what breaks it; removing THIS LINK is, so the refusal belongs here.
  if (isLoadBearing(dir, directoriesLinkedThrough(primaryRoot))) {
    const { count } = linksThroughFolder(primaryRoot, dir);
    return (
      `LEFT ALONE — ${count} of the PRIMARY's package links resolve through it. Unlinking it ` +
      "breaks every session on this machine. The PRIMARY's own dependency links have to be " +
      "re-pointed first, which is the owner's call and his timing, never a session's"
    );
  }
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

  // A worktree branched from ANOTHER branch's tip (`--from origin/<their-branch>`) carries that
  // branch's commits, and `pushed` above asks only whether a remote branch of THIS worktree's own
  // name exists. It never does for that shape — so the gate refused, naming the SOURCE branch's
  // own commits as stranded while they sat safely on origin under a different name. There was no
  // way past it either: the rescue ref it advises does not satisfy the check, and the only thing
  // that would is pushing the branch, which AGENTS.md forbids because it opens a conflicting PR.
  //
  // Measured 2026-09-08 on _wt-pharmacy-guard: refused over ca2b5445a and ff1b6f2c8, both of which
  // answered `git branch -r --contains` with origin/claude/zealous-dewdney-7afb5e.
  //
  // Containment of the TIP is the whole question — every ancestor of a commit that sits on a remote
  // ref sits on that ref too. But `git fetch` never prunes, so a remote-tracking ref outlives the
  // branch GitHub deleted on merge; the candidates are therefore confirmed against the REMOTE in
  // one `ls-remote`, so a stale local ref cannot answer this. Fails CLOSED: any error here leaves
  // the strict refusal exactly as it was.
  const onAnotherRemoteBranch = (() => {
    try {
      const candidates = execFileSync(
        "git",
        ["branch", "-r", "--contains", "HEAD", "--format=%(refname:short)"],
        { cwd: dir, encoding: "utf8" },
      )
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name.startsWith("origin/") && name !== "origin/HEAD")
        .map((name) => name.slice("origin/".length));
      if (candidates.length === 0) return null;
      const live = git(["ls-remote", "--heads", "origin", ...candidates]);
      return live.length > 0 ? candidates[0] : null;
    } catch {
      return null;
    }
  })();

  // delete_branch_on_merge is ON, so GitHub deletes a branch's remote ref the
  // moment its PR merges — and `git fetch` never prunes, so a stale
  // refs/remotes/origin/<branch> lingers and makes the branch look tracked.
  // Pure reachability therefore reports every SUCCESSFULLY merged branch as
  // "on no origin ref": backed up, not stranded. Asking about the merged PR is
  // what separates the two, and a squash merge is never an ancestor of main, so
  // `git branch --merged` can never answer this.
  //
  // 🔴 AND IT MUST BE THE PR FOR *THESE* COMMITS, NOT FOR THIS NAME. `gh pr list --head <branch>`
  // asks a question about a STRING. Branch names here are derived from task slugs, and a recurring
  // task reuses one — so the first merged PR it returns can be months old and about different work.
  // Measured 2026-10-02: removing `codex/agents-trim` printed "PR #3588 merged them", and #3588 had
  // used that name on 2026-09-09; the branch in hand was `ef184cc84`, whose work had landed through
  // a roll-up. The gate vouched, correctly by accident. The same shape on `codex/agents-footprint`
  // named #3734 from 2026-09-12 while that night's #5089 was still OPEN — deleting on that answer
  // would have closed #5089 and thrown the work away.
  //
  // So the merged PR vouches only when its own `headRefOid` IS this worktree's tip. Anything else
  // falls through to the content tests below, which do not care what the branch is called.
  const mergedPr = (() => {
    if (!entry.branch || entry.branch === "(detached)") return null;
    try {
      const out = execFileSync(
        "gh",
        [
          "pr",
          "list",
          "--head",
          entry.branch,
          "--state",
          "merged",
          "--json",
          "number,headRefOid",
          "--jq",
          ".[] | [.number, .headRefOid] | @tsv",
        ],
        { encoding: "utf8" },
      ).trim();
      if (!out) return null;
      const rows = out.split("\n").map((line) => {
        const [number, headRefOid] = line.split("\t");
        return { headRefOid: (headRefOid || "").trim(), number: (number || "").trim() };
      });
      return pickMergedPrForTip(rows, headSha(dir));
    } catch {
      return null; // gh missing or offline — fall through to the strict refusal
    }
  })();

  // 🔴 AN OPEN PR ON THIS HEAD IS A HARD REFUSAL, WHATEVER ELSE PASSES. Deleting the branch closes
  // that PR and discards the work, and no other signal here can see it: a reused name makes the
  // merged-PR test answer about older work, and the content tests answer about commits rather than
  // about whether somebody is still waiting on them. Null means gh could not be asked, which is not
  // "no open PR" — it leaves the strict refusal in place rather than clearing it.
  const openPrOnHead = (() => {
    if (!entry.branch || entry.branch === "(detached)") return null;
    try {
      const out = execFileSync(
        "gh",
        ["pr", "list", "--head", entry.branch, "--state", "open", "--json", "number", "--jq", ".[0].number"],
        { encoding: "utf8" },
      ).trim();
      return out && out !== "null" ? out : null;
    } catch {
      return null;
    }
  })();

  // 🔴 THE ONE TEST THAT HOLDS FOR A PR THAT LANDED **CLOSED** — which every roll-up member does.
  // `rollup-prs.mjs` squashes several PRs into one branch, so when that roll-up merges, each member
  // is CLOSED rather than merged and its commits are a SUBSET of one larger squash. The merged-PR
  // test answers null (no PR on this head merged) and `countUnpushedCommits` answers no (a patch-id
  // for one member can never equal the combined squash's), so without this the normal end state of
  // a batched merge is a worktree the gate refuses to retire.
  //
  // Content is what actually settles it: every file these commits touched, byte-identical at
  // `origin/main`. The path list is DERIVED from the branch's own commits rather than picked, for
  // the reason the stranded-work trap gives — hand-picking a subset under-reports to "safe". A file
  // the branch deleted must be absent on main too, which the null-equals-null case covers.
  //
  // It fails CLOSED in both directions that matter: a path git cannot answer for leaves `null`, and
  // a later commit on main touching the same file makes it `false`. Refusing is the cheap direction.
  const filesIdenticalOnMain = (() => {
    if (!unpushed) return true;
    try {
      const paths = [
        ...new Set(
          execFileSync("git", ["log", "origin/main..HEAD", "--name-only", "--pretty=format:"], {
            cwd: dir,
            encoding: "utf8",
          })
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      ];
      if (paths.length === 0) return null;
      for (const file of paths) {
        const onMain = (() => {
          try {
            return git(["rev-parse", "origin/main:" + file]).trim();
          } catch {
            return null; // not on main at all — a file the branch added, or one it deleted
          }
        })();
        const here = fs.existsSync(path.join(dir, file))
          ? execFileSync("git", ["hash-object", file], { cwd: dir, encoding: "utf8" }).trim()
          : null;
        if (here !== onMain) return false;
      }
      return true;
    } catch {
      return null;
    }
  })();

  // 🔴 EVERY ANSWER ABOVE IS NAME-BASED OR REACHABILITY-BASED, AND A DETACHED HEAD DEFEATS ALL OF
  // THEM AT ONCE. `pushed` and `mergedPr` both return early on the literal string "(detached)"
  // (there is no branch name to ask `ls-remote` or `gh pr list` about), and `onAnotherRemoteBranch`
  // asks reachability, which a squash merge never satisfies. So the gate collapsed to `unpushed`
  // alone and refused unconditionally — ANY commit ahead of origin/main, with no way past it.
  //
  // That is not an edge case, it is the normal end state of shipping here: squash-merge plus
  // delete_branch_on_merge leaves the work on main under a DIFFERENT sha and the branch's own remote
  // ref deleted. Measured 2026-09-30 on _wt-next-16-3-8, whose two commits had merged as #4961
  // (eb8b2c247) and were serving in production while this gate called them stranded.
  //
  // `countUnpushedCommits` is the answer already written for exactly this, in repo-doctor: it asks by
  // PATCH-ID, keyed on HEAD rather than on a branch name, so it works detached — and it catches a
  // MULTI-COMMIT squash (via the cumulative-diff prefix walk) as well as individual cherry-picks (via
  // `git cherry`), which no single comparison does. Reused rather than reimplemented so the two
  // cannot drift apart.
  //
  // Its contract is three-valued and the null matters: `null` means git could not answer, and the
  // caller must then REFUSE rather than assume. Erring toward the refusal is the cheap direction.
  const contentBackedUp = (() => {
    if (!unpushed) return true;
    const stranded = countUnpushedCommits(dir);
    return stranded === 0;
  })();

  // 🔴 THIS ONE REFUSES ON ITS OWN, BEFORE THE OTHER SIGNALS ARE WEIGHED. Every other answer here is
  // about whether the commits are SAFE; this is about whether anybody is still waiting on them, and
  // a branch can be both backed up and in use. Removing the worktree is harmless, but the branch
  // delete that follows closes the PR.
  // The decision itself lives in `scripts/lib/remove-gate.mjs`, with fixtures: the ORDER matters
  // (an open PR overrides every safety signal) and an order is exactly what a source-reading test
  // cannot check.
  const verdict = removalVerdict({
    contentBackedUp,
    filesIdenticalOnMain,
    mergedPr,
    onAnotherRemoteBranch,
    openPrOnHead,
    pushed,
    unpushed,
  });

  if (verdict.reason === "open-pr") {
    console.error("  REFUSED — PR #" + openPrOnHead + " is OPEN on " + entry.branch + ".");
    fail(
      "deleting that branch would close #" +
        openPrOnHead +
        " and discard its work. Land it or close it deliberately first — and note that no other " +
        "check here can see it: a reused branch name makes the merged-PR test answer about older work.",
    );
  }

  if (verdict.reason === "stranded") {
    console.error("  REFUSED — commits here are on no remote branch and no merged PR:");
    for (const line of unpushed.split("\n").slice(0, 10)) console.error("    " + line);
    // A detached HEAD has no branch name to put in a rescue command, and the old advice interpolated
    // the literal "(detached)" twice — printing `git branch rescue/(detached) (detached)`, which is
    // not a runnable command. Name the sha instead, which is what a detached HEAD actually has.
    const detached = !entry.branch || entry.branch === "(detached)";
    // 🔴 WHEN DETACHED AND THE SHA CANNOT BE READ, THERE IS NOTHING TO NAME — so say that, rather
    // than build `git branch rescue/detached-null null`. The folder still exists here (this refusal
    // runs before the removal), so the reader has a command that works: ask it for its own HEAD.
    const detachedSha = detached ? shortSha(headSha(dir)) : null;
    if (detached && detachedSha === null) {
      fail(
        "that worktree is on a DETACHED HEAD and git could not read its tip here, so there is no sha " +
          "to put in a rescue command. Read it yourself with `git -C " +
          JSON.stringify(dir) +
          " rev-parse HEAD` and keep it with `git branch rescue/<name> <that sha>` before removing " +
          "anything. Never PUSH a possibly-merged branch to rescue it: that opens a conflicting PR, " +
          "and a conflicted PR runs no CI at all.",
      );
    }
    const rescueName = detached ? "detached-" + detachedSha : String(entry.branch).replace(/^codex\//, "");
    const rescueAt = detached ? detachedSha : entry.branch;
    fail(
      "keep the tip with `git branch rescue/" +
        rescueName +
        " " +
        rescueAt +
        "` — that costs nothing and loses nothing. Never PUSH a possibly-merged " +
        "branch to rescue it: that opens a conflicting PR, and a conflicted PR runs no CI at all.",
    );
  }

  console.log("  spreadsheets/PDFs   none untracked");
  console.log("  uncommitted work    none");
  console.log(
    "  commits vs main     " +
      (!unpushed
        ? "none"
        : mergedPr
          // Named only when that PR's own head sha IS this tip, so the number printed is about
          // these commits and not about an older PR that reused the branch name.
          ? "present, but PR #" + mergedPr + " merged this exact tip — squash residue, not stranded work"
          : pushed
            ? "present, and the branch is on origin"
            : onAnotherRemoteBranch
              ? "present, and on origin as " + onAnotherRemoteBranch + " — not this branch's name"
              : contentBackedUp
                // The detached-HEAD case, and the reason this line exists: without it the chain fell
                // through and printed "on origin as null", which reads as a bug in the very check that
                // just cleared the removal.
                ? "present, but their CONTENT is upstream already (patch-id match) — squash residue, not stranded work"
                : "present, and every file they touch is byte-identical on origin/main — landed inside a larger squash (a roll-up member)"),
  );
  console.log("  node_modules        " + dropModulesJunction(dir));

  // 🔴 READ THE TIP BEFORE THE FOLDER GOES. The advice printed after the removal tells the reader to
  // compare the merged PR's `headRefOid` against this sha — that IS the advice, and the sha is the
  // only part of it they cannot look up from the message. `headSha(dir)` asks git with `cwd: dir`,
  // so once `worktree remove` has run it threw and returned its old "HEAD" fallback, which landed in
  // the sentence as the literal word: "its headRefOid equal to HEAD". Observed on the first real run
  // of that advice, 2026-10-02, retiring `_wt-banner-behind-main`.
  //
  // That fallback is now gone — `headSha` answers null — so the remaining question is what the
  // advice says when the read genuinely fails while the folder still exists. The branch is still
  // here at that point, so there is always a command that works: `git rev-parse <branch>`.
  const retiredTip = shortSha(headSha(dir));

  git(["worktree", "remove", dir]);
  const husk = fs.existsSync(dir);
  console.log("  worktree removed    " + (husk ? "folder REMAINS — a husk" : "yes, no husk left"));
  if (husk) {
    // The advice is a deletion command, so it must ask the load-bearing question before printing
    // one. A folder whose junction was LEFT ALONE above is exactly the folder this `rmdir /s /q`
    // would take the primary's dependencies down with — the advice was the last way left to break
    // the machine once repo-doctor stopped offering it.
    if (isLoadBearing(dir, directoriesLinkedThrough(primaryRoot))) {
      console.log(
        "    DO NOT clear it — the PRIMARY's package links resolve through this folder. " +
          "`rmdir /s /q` here breaks every session on the machine.",
      );
    } else {
      console.log("    clear it by hand:  rmdir /s /q " + JSON.stringify(dir));
    }
  }
  // A detached HEAD leaves no branch behind, so the old wording printed "The branch (detached) still
  // exists locally" and then advised `gh pr list --head (detached)` — advice for a branch that does
  // not exist, about a command that cannot run.
  if (!entry.branch || entry.branch === "(detached)") {
    console.log(
      "\nThat worktree was on a DETACHED HEAD, so no branch was left behind and there is nothing to delete.\n",
    );
  } else {
    // 🔴 THE OLD ADVICE HERE WAS THE DEFECT THIS FILE NOW GUARDS AGAINST. It said to confirm with
    // `gh pr list --head <branch> --state merged`, which is a question about a NAME: a recurring
    // task reuses a slug, so that command can answer with a PR from weeks ago about different work.
    // Three things settle it, and the gate above has already asked all three — so the advice names
    // them rather than sending the reader back to the query that misleads.
    console.log(
      "\nThe branch " +
        entry.branch +
        " still exists locally. Before deleting it, confirm all three:\n" +
        "  1. the merged PR by NUMBER, and its headRefOid equal to " +
        // Null says the tip could not be read — so name the command that still answers rather than
        // print a word that reads as a sha. The branch is right there; this is never a dead end.
        (retiredTip ?? "the output of `git rev-parse " + entry.branch + "` (its tip could not be read here)") +
        " — never `--head " +
        entry.branch +
        "`, which answers about the name\n" +
        "  2. `gh pr list --head " +
        entry.branch +
        " --state open` is empty\n" +
        "  3. every file the branch changed is byte-identical on origin/main (the only test that\n" +
        "     also holds for a roll-up member, which lands CLOSED rather than merged)\n",
    );
  }
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
const claim = claimForThisSession(dir, branch);
console.log("     " + claim.note);

console.log("3/4  junctioning node_modules from the primary (never installing)");
console.log("     " + linkModules(dir));

console.log("4/4  copying the gitignored env files");
if (!syncEnv(dir)) console.log("     env sync failed — copy .env.local by hand before using dev-auth.");

const result = ready(dir);
console.log("\n" + (result.ok ? "READY" : "INCOMPLETE") + "   " + dir);
console.log("  branch        " + branch + "  (from " + baseRef + ")");
console.log("  .env.local    " + (result.hasEnv ? "yes" : "MISSING"));
console.log("  node_modules  " + (result.hasMods ? "junctioned" : "MISSING"));
console.log("  claimed by    " + (claim.claimed ? "this Claude session" : "no session"));
console.log(
  claim.claimed
    ? "\nThis session may edit it directly with Edit and Write, and run commands there:"
    : "\nOpen a session there — point the new session at this folder:",
);
console.log('  cd "' + dir + '"');
console.log("\nInside that folder invoke node directly (node scripts/…).");
console.log("Never run pnpm there — it purges the primary's node_modules when the lockfile moved.\n");
