#!/usr/bin/env node
/**
 * claude-scripts-backup.mjs — push this laptop's ~/.claude SOURCE off the machine.
 *
 * WHY. Measured 2026-10-04: C: and F: are two partitions of ONE physical NVMe, so
 * `F:\PHX backup`, the scratchpad archive and every hourly snapshot sit on the same
 * device as the thing they protect. The ONLY off-machine copy of anything here is a
 * push to GitHub. The watchdogs that guard the owner's backups — mem-watchdog.ps1,
 * xlsx-tripwire.ps1, the two snapshot watchers, every hook — existed nowhere else.
 *
 * WHERE IT GOES, AND WHY IT COSTS NOTHING. A branch of phoenix-people-workforce that
 * never merges: `laptop/claude-scripts`. Read live 2026-10-04, `ci.yml` triggers on
 * `pull_request` and `push: branches: [main]` only, and every other workflow is
 * schedule/dispatch or path-filtered on main — so a push to this branch runs NO
 * workflow and bills NO Actions minutes. It also keeps 737 KB of laptop-only
 * PowerShell out of `main`, out of every worktree and out of every cloud clone,
 * which is where it would otherwise land.
 *
 * 🔴 NEVER MERGE THIS BRANCH, AND NEVER OPEN A PR FROM IT. It is a backup, not a
 * change. A PR would run the full gate on 53 files that are not part of the product.
 *
 * 🔴 IT TOUCHES NO WORKING TREE, NO BRANCH AND NO INDEX. It is pure git plumbing —
 * hash-object into the object store, a TEMPORARY index via GIT_INDEX_FILE,
 * write-tree, commit-tree, then a push of the resulting commit sha straight to the
 * remote ref. Eight sessions share the primary checkout; a script that ran
 * `checkout`, `add` or `commit` there would destroy another session's work. No
 * `git init`, no `git clone`.
 *
 * WHAT TRAVELS: source under scripts/ and hooks/ — .mjs .js .cjs .ps1 .py .sh .bat .cmd
 * — plus the four files in FILES below, each named one by one.
 * WHAT NEVER TRAVELS, deliberately:
 *   - .log and the xlsx-tripwire-procs-*.txt dumps. Those hold FULL PROCESS COMMAND
 *     LINES, which is exactly where a token ends up quoted on a command line.
 *   - .json BY GLOB. `.credentials.json` and the MCP caches live under ~/.claude and a
 *     glob is a bad place to be approximately right. `settings.json` travels because it
 *     is NAMED, and because it was read field by field on 2026-10-09: no key, no token,
 *     no password, no connection string. `hooks/dispatch.json` travels for the same
 *     reason from 2026-10-15 — it is the WIRING of every blocking user-level guard. The
 *     gate below still reads both on every run, so the day one gains a secret the whole
 *     backup aborts instead of leaking it.
 *   - the memory folder — it is business data, and the cloud mirror carries it.
 *
 * FAILS CLOSED. A literal-secret match or a NUL byte in any candidate file aborts the
 * whole run and pushes nothing. A backup that leaks a key is worse than no backup.
 *
 * Flags: --dry-run (report, push nothing) · --repo <dir> · --branch <name> · --quiet
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DRY = has("--dry-run");
const QUIET = has("--quiet");
const REPO = val("--repo", "F:/Phoenix Workforce/phoenix-workforce");
const BRANCH = val("--branch", "laptop/claude-scripts");
const HOME = path.join(os.homedir(), ".claude");
const ROOTS = ["scripts", "hooks"];
/**
 * Files carried one by one, by name (owner, 2026-10-09: "add CLAUDE.md, settings.json and
 * standing-rules-account.md to the hourly scripts backup").
 *
 * 🔴 CLAUDE.md USED TO BE EXCLUDED HERE because `sync-cloud-context.mjs` copies it into the repo
 * as `.claude/cloud-context/global-standing-rules.md`. That mechanism is real but it is NOT a
 * backup: NOTHING schedules it, it only lands when a session remembers to run it, and the copy on
 * `main` is only as fresh as its last MERGED refresh. Measured the day this changed — the mirrored
 * rules on `origin/main` were 606 bytes behind the live file and still carried an archive path that
 * had been corrected hours earlier, and `tests/cloud-mirror-drift.test.ts` did not catch it because
 * it measures the MEMORY mirror and only asserts the SHAPE of the standing-rules copy. An hourly
 * push that needs nobody to remember is the second line this file is for.
 *
 * 🔴 `hooks/dispatch.json` ADDED 2026-10-15 at the owner's instruction ("back up hooks/dispatch.json
 * too"), because until that day the hooks travelled and the WIRING did not. Every blocking
 * user-level PreToolUse guard — the delete guard, the risky-allow guard, the python-REPL guard — is
 * reached only through that one table: `~/.claude/settings.json` calls `hook-dispatch.mjs` and
 * nothing else, so a restore from this branch without it brings back every guard DISARMED, with no
 * error and nothing on screen to say so. It is read field by field like `settings.json`: matchers,
 * hook paths and timeouts, no key, no token, no path outside `~/.claude/hooks`. The gate below reads
 * it on every run, so the day it gains a secret the whole backup aborts instead of leaking it.
 *
 * Paths are relative to ~/.claude and use forward slashes, matching `rel` from collect().
 */
const FILES = ["CLAUDE.md", "settings.json", "docs/standing-rules-account.md", "hooks/dispatch.json"];
const EXTS = new Set([".mjs", ".js", ".cjs", ".ps1", ".py", ".sh", ".bat", ".cmd"]);
const LOG = path.join(HOME, "scripts", "claude-scripts-backup.log");
const LOG_MAX_LINES = 800;

/**
 * Hooks that carry their own `selftest` and are RUN here, hourly, after the push.
 *
 * WHY THIS LIVES IN THE BACKUP. `~/.claude/hooks/scratchpad-guard.mjs` enforces the owner's
 * never-delete rule in every folder on this laptop, so it cannot live inside one repository and no
 * CI job can execute it. On 2026-10-06 it gained its first stand-down (`PHX_DELETE_OK=<filename>`,
 * deliberately not the `=1` shape the other guards use), and a guard that can be loosened with
 * nothing watching is the whole problem. `tests/delete-guard-stand-down.test.ts` in
 * phoenix-people-workforce pins the MIRRORED copy, which is worth exactly its freshness — this is
 * the half that runs the REAL file, on the machine where it sits.
 *
 * It runs AFTER the push on purpose: a weakened hook should reach the off-machine branch first, so
 * the bad version is preserved for reading rather than lost to the next edit. Then this fails the
 * task, and `claude-scripts-backup-watch.ps1` turns that into one de-duplicated Telegram message
 * with a RECOVERED follow-up — no new alert plumbing, because that watcher already does all of it.
 */
const HOOK_SELFTESTS = [
  { file: path.join(HOME, "hooks", "scratchpad-guard.mjs"), args: ["selftest"], label: "delete guard" },
  // Added 2026-10-06, at the owner's instruction, for the same reason as the delete guard: it is a
  // GLOBAL hook, so it is in no repository and no CI job can ever see it weaken. Every clause in it
  // was added after a measured failure reached his input box, and a regression just lets that
  // failure through again — silently, on every reply, with a correct-looking line on screen.
  // 2.4s for 31 cases, well inside the 120s timeout below.
  { file: path.join(HOME, "hooks", "next-step-capture.mjs"), args: ["selftest"], label: "next-step guard" },
  // Added 2026-10-06 at the owner's instruction. This one ALREADY had a 12-case selftest and it was
  // pinned nowhere — not here, not in any repo test — so it had never run except when somebody typed
  // it. Note the flag: `--selftest`, not the bare `selftest` the other two take. A sweep for the bare
  // word is exactly how its existing suite stayed invisible.
  { file: path.join(HOME, "hooks", "risky-allow-guard.mjs"), args: ["--selftest"], label: "risky-allow guard" },
  // Added 2026-10-06 at the owner's instruction — the fourth global hook with no cover. (It read
  // "and last" until the sweep below found a fifth; it was never last.)
  // This one had NO selftest at all, so it was built rather than wired: a SessionStart hook that
  // decides, from the commit charge and free RAM, whether to tell a new session not to start a
  // build on a 16 GB box. It fails open and ALWAYS exits 0 by design, so a regression produces no
  // error and no output — the only symptom is a session being told nothing while the machine is at
  // its ceiling, which is indistinguishable from a healthy machine. Its decision table is now a
  // pure function (`decideMessage`) so the branch taken no longer depends on the machine the test
  // runs on. 19 cases, counted by the runner, ~2s. 2026-10-09: 25 — six more prove the blocking run
  // starts no process and the async `refresh` mode still reads commit; ~4s, one real PowerShell call.
  { file: path.join(HOME, "hooks", "memory-guard.mjs"), args: ["selftest"], label: "memory guard" },
  // Added 2026-10-06 at the owner's instruction — the FIFTH global hook, found by sweeping
  // ~/.claude/hooks/ after the fourth landed, and the one with the most teeth: the other four refuse,
  // warn or rewrite, and this one ENDS A RUNNING PROCESS. Like the risky-allow guard it already
  // carried a selftest — 68 cases, the largest of the five — and like that one it had never run,
  // because it dispatches on `--selftest` and the bare word prints nothing and exits 0. That is
  // evidence identical to a file with no selftest at all, which is how a sweep for the bare word
  // concluded there was nothing here to find.
  //
  // WHAT A REGRESSION COSTS: the owner's rule is "NEVER CLOSE THE DEV UNTIL I TELL U" (2026-09-21,
  // scoped 2026-09-28 so a session may stop one it started itself). This hook is what makes that
  // mechanical — it stops a server only when an unbroken parent chain proves the ending session
  // started it, and hands the port to another open session still using it. Every path exits 0 by
  // design, so a weakening is silent: the symptom is the owner's dev server disappearing mid-use.
  // Its suite is pure functions — it starts and ends no process — so running it hourly is free of
  // side effects. ~1s for 68 cases.
  { file: path.join(HOME, "hooks", "dev-server-reaper.mjs"), args: ["--selftest"], label: "dev-server reaper" },
  // Added 2026-10-06 at the owner's instruction — the SIXTH, and the only one of the six that guards
  // an UNATTENDED run rather than a session. The weekly config review's own skill says READ-ONLY in
  // capitals; on 2026-09-21, between 01:41 and 02:21 Cairo, the automated run rewrote
  // xlsx-snapshot.cmd and re-registered the hourly snapshot task anyway, with nobody watching. This
  // PreToolUse guard is what stops that, and its 45-case suite was in neither list.
  //
  // 🔴 ITS SUMMARY LINE HAD TO CHANGE TO BE WIRED HERE. It printed "all checks passed", which
  // `runHookSelftests` below rejects: that function accepts a hook only on exit 0 AND a line matching
  // `0 failed`, so adding the entry without touching the hook would have reported a perfectly healthy
  // guard as BROKEN every hour. It now prints `N cases, N failed` like the other five. The fix went
  // into the HOOK, not into a sixth spelling here — one shape across every hook is what makes a
  // single `0 failed` test worth trusting. ~0.3s for 45 cases.
  { file: path.join(HOME, "hooks", "weekly-review-readonly.mjs"), args: ["--selftest"], label: "weekly-review guard" },
  // 2026-10-08: sends the TASK RULES at session start, after compaction and on every 10th prompt (was:
  // every prompt). Its selftest also fails if task-rules.txt is gone or lost the Next step rule.
  { file: path.join(HOME, "hooks", "task-rules-reminder.mjs"), args: ["--selftest"], label: "task-rules reminder" },
  // 2026-10-09 (hook speed fixes): the session-start machine census. It stopped starting
  // powershell.exe that day — memory-guard's async `refresh` entry now keeps the count fresh — and
  // its first selftest pins that: 15 cases, two of which run the real hook under spawn-probe.mjs and
  // fail if it starts ANY process. ~1s. memory-guard's suite gained the same kind of checks.
  { file: path.join(HOME, "hooks", "session-census.mjs"), args: ["selftest"], label: "session census" },
  // Added 2026-10-09 (owner: "combine the laptop's start hooks into one process"). relay-inject,
  // suggestion-context, task-rules-reminder, memory-guard and session-census now run inside ONE
  // process (session-start-dispatch.mjs). A later edit that breaks running in a shared process — a
  // floating main(), a catch that swallows the exit — would drop the start-up rules from every
  // session with no error. This compares one process with five separate ones for every start
  // source and fails on any difference. ~3 s.
  { file: path.join(HOME, "hooks", "session-start-dispatch.mjs"), args: ["--selftest"], label: "start-hook runner" },
  // Added 2026-10-15: phoenix-workforce's bash-guard clause C19 (a command that would land in
  // Python's INTERACTIVE REPL), carried at the USER level so it also answers in a session with no
  // project folder or in another repository. The repo half is pinned by its own CI test; this copy
  // is in no repository, and what it prevents is machine-wide — a bare `python` in a background
  // task writes ~640 KB/s of `OSError: [WinError 123]` into its own tasks/<id>.output, 2.2 GB an
  // hour. Three of them left 20.3 GB on C: on 9, 10 and 15 Oct 2026. A regression here is silent:
  // the command simply runs. 246 checks over 50 commands, each driven through the real hook as a
  // subprocess with the real stdin payload (the deny set is asserted no softer than the allow set —
  // a guard that refuses `python script.py` is switched off within a day). ~5 s.
  { file: path.join(HOME, "hooks", "python-repl-guard.mjs"), args: ["selftest"], label: "python REPL guard" },
];

const say = (m) => { if (!QUIET) console.log(m); };

function note(line) {
  try {
    let prev = [];
    if (fs.existsSync(LOG)) prev = fs.readFileSync(LOG, "utf8").split(/\r?\n/).filter((l) => l.length > 0);
    prev.push(`[${new Date().toISOString()}] ${line}`);
    fs.writeFileSync(LOG, prev.slice(-LOG_MAX_LINES).join("\n") + "\n");
  } catch { /* a backup must not die because its own log would not write */ }
}

function git(args, extraEnv = {}) {
  const r = spawnSync("git", args, {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout || `exit ${r.status}`).trim();
    throw new Error(`git ${args.slice(0, 3).join(" ")} failed — ${why}`);
  }
  // Only trailing newlines go. Leading whitespace is meaningful in some git output
  // (porcelain's status column), and trimming it has silently dropped a character here before.
  return (r.stdout ?? "").replace(/\r?\n$/, "");
}

/**
 * 🔴 THE PATTERNS A SECRET ACTUALLY WEARS. Not a generic /key|token/, which matches
 * every variable name in these scripts and would abort every run — the shapes of the
 * real thing, plus a connection string with a password in it.
 */
const SECRET_SHAPES = [
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, "a JWT (Supabase anon/service-role key)"],
  [/\bsk-[A-Za-z0-9]{20,}\b/, "an OpenAI-style key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/, "a GitHub fine-grained token"],
  [/\bsbp_[a-f0-9]{40,}\b/, "a Supabase access token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, "a Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}\b/, "a Resend key"],
  [/postgres(?:ql)?:\/\/[^\s'"]+:[^\s'"@]+@/, "a connection string carrying a password"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, "a private key"],
];

function collect() {
  const out = [];
  for (const root of ROOTS) {
    const base = path.join(HOME, root);
    if (!fs.existsSync(base)) continue;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { walk(abs); continue; }
        if (!e.isFile()) continue;
        if (!EXTS.has(path.extname(e.name).toLowerCase())) continue;
        out.push({ abs, rel: (root + "/" + path.relative(base, abs)).split(path.sep).join("/") });
      }
    };
    walk(base);
  }
  for (const rel of FILES) {
    const abs = path.join(HOME, ...rel.split("/"));
    if (!fs.existsSync(abs)) continue;
    out.push({ abs, rel });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function main() {
  const files = collect();
  if (files.length === 0) throw new Error("no source files found — refusing to push an empty backup");

  // Gate first, on bytes, before a single object is written.
  const refusals = [];
  let bytes = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f.abs);
    bytes += buf.length;
    if (buf.includes(0)) { refusals.push(`${f.rel}: contains a NUL byte`); continue; }
    const text = buf.toString("utf8");
    for (const [re, what] of SECRET_SHAPES) {
      const m = text.match(re);
      if (m) {
        // The finding names the FILE and the SHAPE, never the value.
        const line = text.slice(0, m.index).split("\n").length;
        refusals.push(`${f.rel}:${line}: looks like ${what}`);
        break;
      }
    }
    f.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  }
  if (refusals.length > 0) {
    for (const r of refusals) say(`  REFUSED  ${r}`);
    note(`REFUSED ${refusals.length} file(s): ${refusals.join("; ")}`);
    throw new Error(`${refusals.length} file(s) failed the gate — nothing was pushed`);
  }

  say(`${files.length} source file(s), ${(bytes / 1024).toFixed(1)} KB, gate clean`);

  const cairo = new Date().toLocaleString("en-GB", { timeZone: "Africa/Cairo" });

  /**
   * 🔴 NO TIMESTAMP GOES INSIDE THE TREE. The first version printed "Taken <time>" into
   * README.md and MANIFEST.md, which made the tree a function of the CLOCK rather than of
   * the source — so the "unchanged since the last backup" check below could never fire and
   * it committed every hour forever, whether a script had changed or not. The time belongs
   * in the COMMIT MESSAGE, where git already keeps it, and `git log` shows it.
   */
  const manifest = [
    "# Manifest",
    "",
    "The time this was taken is the commit's own date — deliberately not written in here, so",
    "the tree stays a function of the source and an unchanged hour pushes nothing.",
    "",
    "| file | bytes | sha256 |",
    "| --- | --- | --- |",
    ...files.map((f) => `| \`${f.rel}\` | ${fs.statSync(f.abs).size} | \`${f.sha256.slice(0, 16)}\` |`),
    "",
  ].join("\n");

  const readme = [
    "# ~/.claude source, backed up off the machine",
    "",
    "**This branch is a BACKUP, not a change. Never merge it and never open a pull request from it.**",
    "",
    "It holds the scripts and hooks that live in `~/.claude/` on the owner's laptop — the memory",
    "watchdog, the xlsx tripwire, the two snapshot watchers, the dev-server reaper, the status line,",
    "every PreToolUse guard. None of them is part of the product and none of them runs from this",
    "repository; they are here because of one measured fact: **C: and F: are two partitions of one",
    "physical NVMe**, so every local backup path sits on the same device as the work it protects, and",
    "a push to GitHub is the only off-machine copy that exists.",
    "",
    "## Why it is a branch and not a folder on `main`",
    "",
    "`ci.yml` triggers on `pull_request` and `push: branches: [main]` only, so a push here runs no",
    "workflow and bills no Actions minutes. It also keeps laptop-only PowerShell out of `main`, out of",
    "every worktree and out of every cloud clone.",
    "",
    "## What is deliberately NOT here",
    "",
    "- `.log` files and the `xlsx-tripwire-procs-*.txt` dumps — those carry full process command",
    "  lines, which is exactly where a token ends up.",
    "- `.json` by GLOB — `.credentials.json` and the MCP caches live under `~/.claude`, and a glob is",
    "  a bad place to be approximately right. Two travel because they are NAMED and were read field",
    "  by field: `settings.json` (2026-10-09) and `hooks/dispatch.json` (2026-10-15), the table every",
    "  blocking user-level PreToolUse guard is reached through — without it a restore brings the",
    "  guards back DISARMED, silently.",
    "- the memory folder — it is business data, and `scripts/sync-cloud-context.mjs` mirrors it into",
    "  `main`. `~/.claude/CLAUDE.md` used to be left to that mirror too and is now carried here as",
    "  well: nothing schedules the mirror, so it is only as fresh as the last session that ran it.",
    "",
    "Every file is gated before it is written: a literal-secret shape or a NUL byte in any candidate",
    "aborts the whole run and pushes nothing.",
    "",
    "## Restoring",
    "",
    "```",
    "git fetch origin laptop/claude-scripts",
    "git show origin/laptop/claude-scripts:scripts/mem-watchdog.ps1 > mem-watchdog.ps1",
    "```",
    "",
    "Written by `~/.claude/scripts/claude-scripts-backup.mjs`, which is itself in here.",
    "",
    "`git log -1 --date=local origin/laptop/claude-scripts` says when this was last taken; no",
    "timestamp is written into these files on purpose, so an hour with no change pushes nothing.",
    "",
  ].join("\n");

  if (DRY) {
    say(`dry run — would push ${files.length} file(s) + README.md + MANIFEST.md to ${BRANCH}`);
    for (const f of files.slice(0, 8)) say(`  ${f.rel}`);
    if (files.length > 8) say(`  … and ${files.length - 8} more`);
    return 0;
  }

  // --- pure plumbing from here: object store + a temporary index only -------------
  const idx = path.join(os.tmpdir(), `claude-scripts-backup-${process.pid}.index`);
  try { fs.rmSync(idx, { force: true }); } catch { /* fresh index */ }
  const env = { GIT_INDEX_FILE: idx };

  const entries = [];
  for (const f of files) {
    const blob = git(["hash-object", "-w", "--path", f.rel, "--", f.abs]);
    entries.push([blob, f.rel]);
  }
  for (const [name, body] of [["README.md", readme], ["MANIFEST.md", manifest]]) {
    const tmp = path.join(os.tmpdir(), `csb-${process.pid}-${name}`);
    fs.writeFileSync(tmp, body);
    entries.push([git(["hash-object", "-w", "--path", name, "--", tmp]), name]);
    try { fs.rmSync(tmp, { force: true }); } catch { /* temp */ }
  }

  for (const [blob, rel] of entries) {
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${rel}`], env);
  }
  const tree = git(["write-tree"], env);
  try { fs.rmSync(idx, { force: true }); } catch { /* temp index */ }

  // Parent = whatever is already on the remote branch, so history accumulates.
  let parent = null;
  const ls = spawnSync("git", ["ls-remote", "origin", `refs/heads/${BRANCH}`], { cwd: REPO, encoding: "utf8" });
  if (ls.status === 0 && (ls.stdout || "").trim()) {
    parent = ls.stdout.trim().split(/\s+/)[0];
    // Unchanged tree -> nothing to say. Reported, not silent, so a quiet hour is legible.
    const prevTree = spawnSync("git", ["rev-parse", `${parent}^{tree}`], { cwd: REPO, encoding: "utf8" });
    if (prevTree.status === 0 && prevTree.stdout.trim() === tree) {
      say(`unchanged since the last backup (tree ${tree.slice(0, 9)}) — nothing pushed`);
      note(`OK unchanged tree=${tree.slice(0, 9)} files=${files.length}`);
      return 0;
    }
  }

  const msg = `backup(~/.claude): ${files.length} source file(s), ${cairo} Cairo`;

  /**
   * 🔴 RETRY A REJECTED PUSH ONCE, RE-READING THE PARENT FIRST. Measured 2026-10-04, the
   * first scheduled run: `! [remote rejected] <sha> -> laptop/claude-scripts (failed)` with
   * NO reason line at all, between two manual pushes of identical content that both
   * succeeded. An unexplained server-side refusal is not a reason to lose an hour's backup,
   * but a BLIND retry is wrong too — if the ref moved, the second push must be built on the
   * new tip, so the parent is re-read and the commit rebuilt rather than resent.
   */
  const buildAndPush = (parentSha) => {
    const args = ["commit-tree", tree, "-m", msg];
    if (parentSha) args.push("-p", parentSha);
    const c = git(args);
    git(["push", "origin", `${c}:refs/heads/${BRANCH}`]);
    return c;
  };

  let commit;
  try {
    commit = buildAndPush(parent);
  } catch (first) {
    note(`RETRY after a rejected push — ${first.message.split("\n")[0]}`);
    say("the push was rejected with no reason given; re-reading the remote tip and trying once more");
    const again = spawnSync("git", ["ls-remote", "origin", `refs/heads/${BRANCH}`], { cwd: REPO, encoding: "utf8" });
    const nowParent = again.status === 0 && (again.stdout || "").trim() ? again.stdout.trim().split(/\s+/)[0] : null;
    commit = buildAndPush(nowParent);
  }

  // Read it back from the REMOTE, not from here — the whole point is that it left.
  const after = git(["ls-remote", "origin", `refs/heads/${BRANCH}`]).split(/\s+/)[0];
  if (after !== commit) throw new Error(`pushed ${commit.slice(0, 9)} but the remote reads ${after.slice(0, 9)}`);

  say(`pushed ${files.length} file(s) to ${BRANCH} as ${commit.slice(0, 9)} (tree ${tree.slice(0, 9)})`);

  // The guard selftests, now that the source is safely off the machine (see HOOK_SELFTESTS).
  const broken = runHookSelftests();
  if (broken.length > 0) {
    note(`FAIL hook selftest: ${broken.join("; ")} — pushed=${commit.slice(0, 9)}, the source IS backed up`);
    throw new Error(
      `${broken.length} hook selftest(s) failed: ${broken.join("; ")}. The backup itself succeeded ` +
        `(${commit.slice(0, 9)}), so the current version of the hook is on ${BRANCH} to read.`,
    );
  }

  note(`OK pushed=${commit.slice(0, 9)} tree=${tree.slice(0, 9)} files=${files.length} bytes=${bytes} selftests=${HOOK_SELFTESTS.length}`);
  return 0;
}

/**
 * Run each hook's own `selftest` and return a list of one-line failures.
 *
 * A MISSING hook counts as a failure, not a skip: these are hooks the owner relies on in every
 * folder, so one that has vanished is the loudest thing this script could find — and a silent skip
 * is how a guard comes to be absent for weeks. Every other error is reported rather than thrown,
 * because the backup's own verdict is what the watcher reads.
 */
function runHookSelftests() {
  const broken = [];
  for (const t of HOOK_SELFTESTS) {
    if (!fs.existsSync(t.file)) { broken.push(`${t.label}: ${path.basename(t.file)} is MISSING`); continue; }
    const r = spawnSync(process.execPath, [t.file, ...t.args], { encoding: "utf8", timeout: 120_000 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const failedLine = out.split(/\r?\n/).find((l) => /^\s*FAIL\b/.test(l));
    if (r.status === 0 && /\b0 failed\b/.test(out)) { say(`  selftest ok   ${t.label}`); continue; }
    broken.push(`${t.label}: ${(failedLine ?? `exit ${r.status}`).trim().slice(0, 200)}`);
    say(`  selftest FAIL ${t.label}`);
  }
  return broken;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`claude-scripts-backup: FAILED — ${e.message}`);
  note(`FAIL ${e.message}`);
  process.exit(1);
}
