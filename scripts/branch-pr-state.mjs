// Is a worktree's branch RETIRABLE — is the work sitting on it NOW merged?
//
// WHY THIS IS ITS OWN FILE. Two callers answer that question and both used to answer it wrongly,
// in the same words, from the same one-line gh call:
//
//   scripts/repo-doctor.mjs                 the "RETIRABLE worktrees" section of the report
//   .claude/hooks/worktree-exit-guard.mjs   the SessionEnd "Worktree is RETIRABLE" line
//
// Each prints a `git branch -D` for whatever it calls retirable, and `git branch -D` is the
// irreversible step. A rule that decides that has to exist in exactly ONE place, for the same
// reason the --strip-idle gates do (tests/repo-doctor-strip-idle-offer.test.ts): a second copy is
// free to drift, and both copies stay internally consistent while disagreeing with each other.
//
// THE BUG THIS FIXES. Both callers ran
//
//     gh pr list --head <branch> --state merged --json number --jq '.[0].number'
//
// which answers "has this branch EVER had a merged PR", not "is this branch's CURRENT work
// merged". Those are the same question only for a branch used once. This repository reuses
// branches constantly — a session's worktree survives its own merge (AGENTS.md section 2.1), picks
// up the next task, and opens a second PR from the same head. From that moment the stale merged PR
// keeps answering for work that has not merged at all.
//
// Hit live 2026-09-03. `.claude/worktrees/vigorous-gould-7cdf82` on `claude/vigorous-gould-7cdf82`
// was reported as
//
//     PR #2952  claude/vigorous-gould-7cdf82  -- 7 uncommitted file(s), review before removing
//
// while `gh pr list --head claude/vigorous-gould-7cdf82 --state all` returned TWO rows: #2952
// MERGED at 23:49 on 2026-09-02, and #2965 OPEN. A live session was editing in that folder at scan
// time — its dev server had written `.next/dev` seconds earlier and its newest source edit was
// three minutes old.
//
// THAT ONE SURVIVED BY LUCK. The uncommitted-files check happened to fire and downgraded the
// printed command to "review before removing". The hole is the same branch a minute later:
// everything committed and pushed to the open PR, so dirty = 0 and unpushed = 0, and both callers
// print an unqualified `git branch -D` for a branch whose PR is open and whose work has never
// merged. Nothing downstream catches that — the unpushed check is a question about BACKUP, and
// commits pushed to an open PR ARE backed up. Only the PR state knows the work is not merged.
//
// THE RULE. Ask for `--state all`, take the NEWEST PR by number (PR numbers are a per-repository
// monotonic counter, so the highest number is the newest whatever order gh returns them in), and
// retire only on the narrowest possible answer:
//
//   newest is MERGED, and HEAD is exactly the commit that PR merged   -> retirable
//   anything else                                                     -> held back, with a reason
//
// WHY headRefOid AND NOT mergeCommit. "Does HEAD carry commits after that merge?" cannot be asked
// as `git rev-list <mergeCommit>..HEAD`: the merge commit lives on main and a squash-merged branch
// tip is not its descendant, so that range returns the branch's OWN commits — every retirable
// worktree would read as carrying extra work. `headRefOid` is the head SHA GitHub actually merged.
// If the local tip still equals it, the branch has not moved since; if it does not, the branch
// holds work that PR never saw, and the answer is to hold it back rather than to guess which
// direction it moved in.
//
// EVERY UNKNOWN IS HELD BACK, never retired. A failed gh call, unparseable output, a missing
// `headRefOid`, an unreadable HEAD — each returns a verdict that keeps the `git branch -D` line off
// the screen. This is the `?? null` discipline repo-doctor.mjs documents in four other places: git
// and gh both answer null when the command FAILED, and collapsing that into the clean answer
// renders a check that never ran as a check that passed. Not knowing must read LOUDER than clean.
//
// The safe direction here is one-way, and it is UNDER-reporting. A worktree wrongly held back
// costs a human thirty seconds; a worktree wrongly retired costs the branch.

import { execFileSync } from "node:child_process";

/**
 * The gh argv this module asks with.
 *
 * Exported so a test can pin `--state all` directly rather than slicing a byte window out of the
 * source — AGENTS.md section 2.1: source-pinning tests that slice fixed windows false-FAIL the
 * moment the file shifts.
 *
 * `--limit 100` because gh's default is 30 and this is a per-branch query: a long-lived worktree
 * branch can carry a handful of PRs, and silently truncating the list is how the newest one goes
 * missing and an older MERGED row answers in its place — the very failure this file exists for.
 */
export function branchPrQueryArgs(branch) {
  return [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "100",
    "--json",
    "number,state,headRefOid,mergedAt",
  ];
}

/** gh, never throwing. null means the command FAILED — it never means "no pull requests". */
function runGh(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Every pull request ever opened from `branch`, newest first.
 *
 * @param {string} branch
 * @param {{ run?: (args: string[]) => string | null }} [options] `run` is the gh invoker; tests
 *   substitute it.
 * @returns {Array<{ number: number, state: string, headRefOid: string | null }> | null} null when
 *   gh could not be asked or its answer could not be read. Callers must treat that as UNKNOWN and
 *   refuse to retire anything, never as an empty list.
 */
export function listBranchPrs(branch, { run = runGh } = {}) {
  const raw = run(branchPrQueryArgs(branch));
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === "") return null; // gh prints `[]` for an empty list; blank means it said nothing
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows = [];
  for (const row of parsed) {
    // A row we cannot identify makes the whole answer untrustworthy, not merely incomplete: the
    // one we failed to read could be the newest, which is the only one that decides anything.
    if (!row || typeof row !== "object") return null;
    if (!Number.isFinite(row.number)) return null;
    rows.push({
      number: row.number,
      state: typeof row.state === "string" ? row.state.toUpperCase() : "",
      headRefOid: typeof row.headRefOid === "string" && row.headRefOid ? row.headRefOid : null,
    });
  }
  rows.sort((a, b) => b.number - a.number);
  return rows;
}

/**
 * Whether a worktree on this branch can be retired, judged from the NEWEST pull request.
 *
 * @param {Array<{ number: number, state: string, headRefOid: string | null }> | null} prs From
 *   {@link listBranchPrs}. null = could not be determined.
 * @param {string | null} tip The worktree's current HEAD SHA. null = could not be read.
 * @returns {{ verdict: "retirable" | "held" | "none" | "unknown", pr: number | null, reason: string }}
 *   `retirable` is the ONLY verdict a caller may print a `git branch -D` for. `none` means the
 *   branch has never had a PR — ordinary in-flight work, and nobody's business to report. `held`
 *   and `unknown` both mean do not retire; they differ only in whether we know why.
 */
export function classifyBranchPr(prs, tip) {
  if (prs === null || prs === undefined) {
    return { verdict: "unknown", pr: null, reason: "gh could not be asked for this branch's PRs" };
  }
  if (prs.length === 0) return { verdict: "none", pr: null, reason: "" };

  // Highest number, not first row: gh's ordering is not part of its contract, and trusting a
  // position in the list is half of the defect this file exists to fix.
  const newest = prs.reduce((best, row) => (row.number > best.number ? row : best), prs[0]);

  if (newest.state !== "MERGED") {
    const merged = prs.filter((row) => row.state === "MERGED").map((row) => row.number);
    const history = merged.length
      ? ` (PR #${merged[0]} on this branch DID merge — the branch was reused after it)`
      : "";
    const what = newest.state === "OPEN" ? "is OPEN" : `is ${newest.state || "in an unknown state"}`;
    return {
      verdict: "held",
      pr: newest.number,
      reason: `newest PR #${newest.number} ${what}, so this branch's current work is not merged${history}`,
    };
  }

  if (tip === null || tip === undefined || tip === "") {
    return {
      verdict: "held",
      pr: newest.number,
      reason:
        `PR #${newest.number} merged, but this worktree's HEAD could not be read, so whether the ` +
        "branch moved since is unknown",
    };
  }
  if (!newest.headRefOid) {
    return {
      verdict: "held",
      pr: newest.number,
      reason:
        `PR #${newest.number} merged, but gh returned no head SHA for it, so whether the branch ` +
        "moved since is unknown",
    };
  }
  if (newest.headRefOid !== tip) {
    return {
      verdict: "held",
      pr: newest.number,
      reason:
        `HEAD ${tip.slice(0, 9)} is not the commit PR #${newest.number} merged ` +
        `(${newest.headRefOid.slice(0, 9)}) — the branch carries work that PR never saw`,
    };
  }
  return { verdict: "retirable", pr: newest.number, reason: "" };
}
