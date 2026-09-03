// Retirability is decided by the NEWEST pull request, never by the first merged one.
//
// WHY THIS EXISTS. `scripts/repo-doctor.mjs` and `.claude/hooks/worktree-exit-guard.mjs` both
// print a `git branch -D` for any worktree they call retirable, and both decided that with
//
//     gh pr list --head <branch> --state merged --json number --jq '.[0].number'
//
// That answers "has this branch EVER had a merged PR". The question they meant is "is the work on
// this branch NOW merged". The two are the same only for a branch used once, and worktrees here
// outlive their own merges routinely: the session keeps the folder, takes the next task, and opens
// a second PR from the same head.
//
// Hit live 2026-09-03. `.claude/worktrees/vigorous-gould-7cdf82` was reported as
//
//     PR #2952  claude/vigorous-gould-7cdf82  -- 7 uncommitted file(s), review before removing
//
// while `--state all` on that head returned TWO rows: #2952 MERGED and #2965 OPEN. A live session
// was editing in the folder — its dev server had written `.next/dev` seconds earlier.
//
// THE FIXTURE IN {@link INCIDENT} IS THAT EXACT gh RESPONSE, field for field.
//
// WHAT SAVED THAT ONE WAS LUCK, AND THE TESTS SAY SO. The uncommitted-files check happened to fire
// and downgraded the printed command. {@link runRepoDoctorNewestPrTests} therefore also drives the
// clean case — the same branch a minute later, everything committed and pushed to the OPEN PR —
// because that is the one nothing downstream catches: commits pushed to an open PR ARE backed up,
// so the unpushed check has no objection, and an unqualified `git branch -D` gets printed for a
// branch whose work never merged.
//
// EVERY CASE PINS THE OLD ANSWER TOO. {@link firstMergedPrNumber} below is the pre-fix rule,
// reproduced verbatim against the same fixture. Asserting that it still says "retirable off #2952"
// where the fixed function says "held" is what proves these tests discriminate rather than passing
// for free — the trap AGENTS.md section 2.1 records as "a pinning test can pin the ANTI-pattern".
//
// THE DANGEROUS DIRECTION IS ONE-WAY. This verdict gates an irreversible command, so every unknown
// — gh unreachable, unparseable output, no head SHA, an unreadable HEAD — must come back as "do not
// retire". The null cases below are the point of the file, not decoration: a check that answers
// "retirable" when it cannot tell is how a branch gets deleted.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { branchPrQueryArgs, classifyBranchPr, listBranchPrs } from "../scripts/branch-pr-state.mjs";
import { stripComments } from "./support/comment-strip.ts";

type PrRow = { number: number; state: string; headRefOid: string | null };

/** The live `gh pr list --head claude/vigorous-gould-7cdf82 --state all` answer, 2026-09-03. */
const INCIDENT: PrRow[] = [
  { number: 2965, state: "OPEN", headRefOid: "684eadf09ff0dfe3d57913f0dee0a0bf1f5e3016" },
  { number: 2952, state: "MERGED", headRefOid: "da0fdc7e256c4643400396b2143c9b26bda89dc2" },
];

/** The tip that worktree was actually sitting on — the OPEN PR's head, not the merged one's. */
const INCIDENT_TIP = "684eadf09ff0dfe3d57913f0dee0a0bf1f5e3016";

/** The rule exactly as it was before this fix, kept so every case can show what changed. */
function firstMergedPrNumber(rows: PrRow[]): number | null {
  const merged = rows.filter((row) => row.state === "MERGED");
  return merged.length ? merged[0].number : null;
}

/** A `run` that hands back a canned gh response, and records the argv it was asked with. */
function stubRunner(answer: string | null): { run: (args: string[]) => string | null; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args);
      return answer;
    },
  };
}

const CALLERS = [
  path.join("scripts", "repo-doctor.mjs"),
  path.join(".claude", "hooks", "worktree-exit-guard.mjs"),
];

export function runRepoDoctorNewestPrTests() {
  // ── The incident: a reused branch is NOT retirable off its stale merged PR ────────────────
  assert.equal(
    firstMergedPrNumber(INCIDENT),
    2952,
    "the OLD rule read #2952 off this branch — if this changed, the fixture stopped reproducing the bug",
  );
  const reused = classifyBranchPr(INCIDENT, INCIDENT_TIP);
  assert.equal(reused.verdict, "held", "a branch whose newest PR is OPEN is not retirable");
  assert.equal(reused.pr, 2965, "the verdict names the NEWEST PR, not the merged one");
  assert.match(
    reused.reason,
    /2952/,
    "the reason must say the branch was reused after a merge — otherwise the worktree just vanishes from the report",
  );

  // The hole the uncommitted-files check happened to cover on the day: the same branch a minute
  // later, clean and fully pushed to its open PR. Nothing else in either caller objects to that.
  const cleanReused = classifyBranchPr(INCIDENT, INCIDENT_TIP);
  assert.notEqual(
    cleanReused.verdict,
    "retirable",
    "a clean, fully-pushed worktree on an OPEN PR must still never be offered for `git branch -D`",
  );

  // ── The genuinely retirable shape: newest PR merged, HEAD still where it merged ───────────
  const mergedRows: PrRow[] = [{ number: 2966, state: "MERGED", headRefOid: "0ff0455e838d9f34" }];
  assert.equal(
    classifyBranchPr(mergedRows, "0ff0455e838d9f34").verdict,
    "retirable",
    "the report must still name the worktrees that really are done",
  );
  assert.equal(classifyBranchPr(mergedRows, "0ff0455e838d9f34").pr, 2966);

  // ── Merged, but the branch moved since: commits that PR never saw ─────────────────────────
  const moved = classifyBranchPr(mergedRows, "1111111111111111");
  assert.equal(moved.verdict, "held", "HEAD past the merged head means work the PR never carried");
  assert.match(moved.reason, /carries work that PR never saw/);

  // ── Newest PR closed without merging, over an older merged one ────────────────────────────
  const abandoned = classifyBranchPr(
    [
      { number: 3001, state: "CLOSED", headRefOid: "aaaaaaaaaaaaaaaa" },
      { number: 2900, state: "MERGED", headRefOid: "bbbbbbbbbbbbbbbb" },
    ],
    "aaaaaaaaaaaaaaaa",
  );
  assert.equal(abandoned.verdict, "held", "work closed unmerged is not work that merged");
  assert.equal(abandoned.pr, 3001);

  // ── Order is not part of gh's contract: the NEWEST is the highest number, not the first ───
  const outOfOrder = classifyBranchPr(
    [
      { number: 2952, state: "MERGED", headRefOid: "da0fdc7e256c4643" },
      { number: 2965, state: "OPEN", headRefOid: INCIDENT_TIP },
    ],
    INCIDENT_TIP,
  );
  assert.equal(outOfOrder.verdict, "held", "picking by position rather than by number is the same defect");
  assert.equal(outOfOrder.pr, 2965);

  // ── Every unknown holds the branch. None of these may read as retirable ───────────────────
  assert.equal(classifyBranchPr(null, "abc").verdict, "unknown", "a failed gh call is not 'no open PR'");
  assert.notEqual(classifyBranchPr(null, "abc").verdict, "none", "unknown must never collapse into none");
  assert.equal(
    classifyBranchPr(mergedRows, null).verdict,
    "held",
    "an unreadable HEAD cannot be compared against the merged head SHA",
  );
  assert.equal(
    classifyBranchPr([{ number: 2966, state: "MERGED", headRefOid: null }], "0ff0455e838d9f34").verdict,
    "held",
    "no head SHA from gh means we cannot tell whether the branch moved",
  );
  assert.equal(classifyBranchPr([], "abc").verdict, "none", "a branch with no PR at all is simply in flight");

  // ── listBranchPrs: what it asks, and what it refuses to guess ─────────────────────────────
  const asked = stubRunner(JSON.stringify(INCIDENT));
  const rows = listBranchPrs("claude/vigorous-gould-7cdf82", { run: asked.run });
  assert.equal(asked.calls.length, 1);
  const argv = asked.calls[0];
  const stateAt = argv.indexOf("--state");
  assert.ok(stateAt >= 0, "the query must pass --state explicitly");
  assert.equal(argv[stateAt + 1], "all", "--state merged is the defect; the query asks for all of them");
  assert.ok(argv.join(" ").includes("headRefOid"), "the head SHA is what proves the branch has not moved");
  assert.deepEqual(
    rows?.map((row) => row.number),
    [2965, 2952],
    "rows come back newest first",
  );

  assert.equal(listBranchPrs("b", { run: stubRunner(null).run }), null, "a failed gh call answers null");
  assert.equal(listBranchPrs("b", { run: stubRunner("not json").run }), null, "unparseable output answers null");
  assert.equal(listBranchPrs("b", { run: stubRunner("").run }), null, "silence is not an empty list");
  assert.equal(
    listBranchPrs("b", { run: stubRunner('[{"state":"MERGED"}]').run }),
    null,
    "a row with no number makes the whole answer untrustworthy, not merely incomplete",
  );
  assert.deepEqual(listBranchPrs("b", { run: stubRunner("[]").run }), [], "gh's empty list IS an empty list");

  // `branchPrQueryArgs` is exported precisely so this pin needs no byte window into the source —
  // AGENTS.md 2.1: source-pinning tests that slice fixed windows false-FAIL when the file shifts.
  const args = branchPrQueryArgs("some/branch");
  assert.ok(!args.includes("merged"), "no caller may ask gh for merged PRs only");
  assert.ok(args.includes("some/branch"), "the branch is passed through --head");

  // ── ONE implementation. Both callers print `git branch -D`; the rule behind it lives once ──
  //
  // Read through stripComments deliberately: scripts/repo-doctor.mjs is one of the 39 files the
  // naive block-comment regex mutilates, and both callers' prose QUOTES the old `--state merged`
  // query while explaining why it went. A negative assertion against raw source would fail on the
  // documentation; one against a mutilated strip would pass for the wrong reason. Hence the
  // baseline assertion on each file before the absence assertion.
  for (const caller of CALLERS) {
    const code = stripComments(fs.readFileSync(caller, "utf8"));
    assert.ok(
      code.includes("classifyBranchPr"),
      `${caller}: baseline — the strip must leave the code under test standing`,
    );
    assert.ok(
      code.includes("branch-pr-state.mjs"),
      `${caller}: retirability must come from the shared module, not a local gh call`,
    );
    assert.ok(
      !code.includes("--state"),
      `${caller}: the gh PR query belongs in scripts/branch-pr-state.mjs only — a second copy is free to drift back to --state merged`,
    );
  }
}
