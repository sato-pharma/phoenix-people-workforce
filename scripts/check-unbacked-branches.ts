// Finds work that exists ONLY on this disk: local branches whose commits are on no remote.
//
// WHY THIS EXISTS. A sweep on 2026-08-01 found 82 commits across 12 branches with no remote, no PR
// and no CI — one disk failure from gone. The session-end worktree guard
// (.claude/hooks/worktree-exit-guard.mjs) now reports this when a session ends, but it has a
// structural blind spot: it fires per WORKTREE, so a branch nobody has a worktree for never
// triggers it. That is not hypothetical — two such branches were missed by a worktree-scoped audit
// the same night and only surfaced when the scan was widened to every local ref. This is the wide
// version, meant to be run on demand.
//
// Report-only, on purpose, exactly like the guard: it prints paste-ready push commands and pushes
// nothing. A push waits for the owner's say-so, and no prompt enforces it: `permissions.ask` in
// .claude/settings.json has been empty since 2026-08-14. A tool that pushed on its own would skip
// the only check left — a session asking the owner first.
//
// TWO MEASUREMENT TRAPS THIS DELIBERATELY AVOIDS — both were hit for real before it existed:
//
//   1. Counting REFS over-reports. Two branch names can point at the identical commit; naive
//      counting called the same 12 commits "12 more commits at risk" twice in one evening. Findings
//      are grouped by SHA, so duplicate names collapse into one entry.
//   2. Matching by NAME over-reports. A branch can be absent from the remote under its own name
//      while its exact commit is on the remote under a DIFFERENT name — that work is backed up and
//      flagging it is a false alarm. The test here is whether the SHA is reachable from any remote
//      head, not whether the name matches.
//
// NOT A CI GATE. It describes the state of one developer's laptop; CI has no local branches, so it
// would be vacuously green there. Do not wire it into `ci.yml` or the `ci` script.
//
// Read-only: ls-remote, rev-list and a gh query. Nothing is written, pushed or deleted.

import { execFileSync } from "node:child_process";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "check-unbacked-branches",
  entry: import.meta.url,
  known: ["--no-fetch"],
});

const args = new Set(process.argv.slice(2));
const skipFetch = args.has("--no-fetch");

function run(cmd: string, cmdArgs: string[], timeout = 60000): string | null {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout }).trim();
  } catch {
    return null;
  }
}

const git = (a: string[], t?: number) => run("git", a, t);

/** Branch names that are never "at risk" — trunk, and anything already on the remote by definition. */
const TRUNK = new Set(["main", "master"]);

function main() {
  if (git(["rev-parse", "--git-dir"]) === null) {
    console.error("[unbacked] not a git repository");
    process.exitCode = 1;
    return;
  }

  // Correctness first: without this, origin/main can be stale and the "ahead" counts drift. Opt out
  // with --no-fetch when offline or when you have just fetched.
  if (!skipFetch) git(["fetch", "origin", "--quiet"], 120000);

  // ONE ls-remote for the whole repo. Doing this per branch is what made the ad-hoc version of this
  // check take minutes across ~20 branches.
  const remoteRaw = git(["ls-remote", "--heads", "origin"], 120000);
  if (remoteRaw === null) {
    console.error("[unbacked] could not reach origin — cannot tell what is backed up. Not reporting a false all-clear.");
    process.exitCode = 1;
    return;
  }
  const remoteShas = new Set<string>();
  const remoteNames = new Map<string, string>();
  for (const line of remoteRaw.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split(/\s+/);
    if (!sha || !ref) continue;
    remoteShas.add(sha);
    remoteNames.set(ref.replace(/^refs\/heads\//, ""), sha);
  }

  // Merged branches are not at risk: the work is on main. Squash-aware by construction — asking
  // GitHub which heads merged, never `git branch --merged`, which is always wrong under squash.
  const mergedRaw = run("gh", ["pr", "list", "--state", "merged", "--limit", "400", "--json", "headRefName", "--jq", ".[].headRefName"], 120000);
  const merged = new Set((mergedRaw ?? "").split("\n").filter(Boolean));
  if (mergedRaw === null) console.log("[unbacked] note: gh unavailable — merged branches cannot be excluded, so this may over-report.");

  const localRaw = git(["for-each-ref", "--format=%(refname:short)\t%(objectname)", "refs/heads"]) ?? "";

  // Group by SHA so two names for the same history are one finding, not two.
  const bySha = new Map<string, { names: string[]; ahead: number; mergedAs: string[] }>();

  for (const line of localRaw.split("\n").filter(Boolean)) {
    const [name, sha] = line.split("\t");
    if (!name || !sha || TRUNK.has(name)) continue;

    // Trap 2: backed up if this exact commit is on ANY remote head, regardless of branch name.
    if (remoteShas.has(sha)) continue;

    const ahead = Number(git(["rev-list", "--count", `origin/main..${sha}`]) ?? "0");
    if (!Number.isFinite(ahead) || ahead === 0) continue; // nothing of its own to lose

    const entry = bySha.get(sha) ?? { ahead, mergedAs: [], names: [] };
    entry.names.push(name);
    if (merged.has(name)) entry.mergedAs.push(name);
    bySha.set(sha, entry);
  }

  // A merged branch is NOT automatically safe. Matching by name only says "a PR for this head
  // merged at some point" — it says nothing about commits added AFTERWARDS. That is not theoretical:
  // codex/retire-sentry had its PR merged and then received a further commit, so a name-only check
  // called 131 lines of unbacked work "safe". Since separating "this is the merged content" from
  // "this postdates the merge" needs a content comparison this check deliberately does not do,
  // merged branches are DOWNGRADED, never excluded — reported with their count and the caveat.
  const atRisk = [...bySha.entries()].filter(([, e]) => e.mergedAs.length === 0);
  const mergedButAhead = [...bySha.entries()].filter(([, e]) => e.mergedAs.length > 0);

  if (mergedButAhead.length > 0) {
    console.log(`[unbacked] ${mergedButAhead.length} branch group(s) had a PR merge but are absent from origin and still carry commits:`);
    for (const [sha, e] of mergedButAhead) {
      console.log(`    ${e.names.join(", ")}  — ${e.ahead} commit(s) ahead  [${sha.slice(0, 8)}]  (merged as ${e.mergedAs.join(", ")})`);
      console.log(`      Usually just the squash artifact. But verify before deleting — commits added AFTER the merge look identical here:`);
      console.log(`      git log --oneline origin/main..${e.names[0]}`);
    }
    console.log("");
  }

  if (atRisk.length === 0) {
    console.log("[unbacked] OK — every local branch with commits of its own is on origin.");
    return;
  }

  const commits = atRisk.reduce((sum, [, e]) => sum + e.ahead, 0);
  console.log(`[unbacked] ${commits} commit(s) across ${atRisk.length} branch group(s) exist ONLY on this disk — no remote copy:\n`);
  for (const [sha, e] of atRisk.sort((a, b) => b[1].ahead - a[1].ahead)) {
    const alias = e.names.length > 1 ? `  (also: ${e.names.slice(1).join(", ")} — same commit)` : "";
    console.log(`  ${e.names[0]}  — ${e.ahead} commit(s) ahead of main  [${sha.slice(0, 8)}]${alias}`);
    console.log(`      git push -u origin ${e.names[0]}`);
  }
  console.log("\n[unbacked] Nothing was pushed — that stays your call.");
  // Non-zero so it can gate a deliberate hygiene step. Do NOT add to CI: see the header.
  process.exitCode = 1;
}

main();
