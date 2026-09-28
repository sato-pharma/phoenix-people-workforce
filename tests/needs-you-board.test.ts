import assert from "node:assert/strict";

// The real decision core, not a restatement of it. `scripts/needs-you.mjs` keeps its sorting rules
// in exported pure functions for exactly this reason — the same split, for the same reason, as
// `scripts/branch-pr-state.mjs`: a rule whose wrong answer costs something has to be drivable
// without a live machine.
import { buildBoard, classifyPr, explainBlocked, normalizeRollup, render, wrap } from "../scripts/needs-you.mjs";

/**
 * The tier-1 board must never under-report.
 *
 * WHY THIS EXISTS. `scripts/needs-you.mjs` answers one question — what is waiting on the owner
 * right now — and its whole value is that he can stop checking for himself. That is also the shape
 * of its only serious failure: if it prints "Nothing is waiting on a decision only you can make"
 * while a PR sits green, or while it simply failed to read GitHub, it has cost him the merge more
 * surely than no board at all would have, because he has delegated the looking.
 *
 * So every assertion here defends ONE direction: an unknown must never be rendered as clean, and a
 * state this file does not model must never be rendered as green. Over-reporting is allowed and is
 * deliberately untested — a row he glances at and dismisses costs him two seconds; a row that never
 * appeared costs him a deploy.
 *
 * The three rules of AGENTS.md this board is most able to break, each pinned below:
 *   §2      never count to a required-check number a doc gave you — GitHub's `mergeStateStatus` is
 *           the verdict here, and live protection contexts only supply the words. A regression that
 *           made this file decide from a counted list would reintroduce the failure that has now
 *           rotted four times (4 → 5 → 6 → 4).
 *   §2.3    a withheld production deploy is carried forward by the next green merge BY ITSELF, so
 *           the board must never suggest a redeploy or a re-merge to chase one.
 *   §4      no ellipsis, ever. Long lines wrap; they are never truncated.
 */
export function runNeedsYouBoardTests() {
  const NOW = Date.parse("2026-09-28T09:00:00Z");

  const pr = (over: Record<string, unknown> = {}) => ({
    number: 4600,
    title: "fix(payroll): a held row keeps its note",
    headRefName: "codex/held-row-note",
    isDraft: false,
    updatedAt: "2026-09-28T08:00:00Z",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [],
    __now: NOW,
    ...over,
  });

  const check = (name: string, conclusion: string | null, status = "COMPLETED") => ({
    __typename: "CheckRun",
    name,
    status,
    conclusion,
  });

  const REQUIRED = ["validate", "checks", "mobile", "secret-scan"];

  // -------------------------------------------------------------------------------------------
  // 1. The one direction that costs a merge: an unmodelled or uncomputed state is NEVER his row.
  // -------------------------------------------------------------------------------------------
  for (const state of ["UNKNOWN", "", null, undefined, "SOMETHING_GITHUB_ADDED_LATER"]) {
    const row = classifyPr(pr({ mergeStateStatus: state }), REQUIRED);
    assert.equal(
      row.bucket,
      "unknown",
      `mergeStateStatus ${JSON.stringify(state)} was sorted as "${row.bucket}". Anything this file does not ` +
        'model must land in "unknown" and be printed loudly. Sorting it as "yours" invites a merge GitHub ' +
        'has not cleared; sorting it as "claude" hides it from him entirely, which is the failure this ' +
        "whole file exists to prevent.",
    );
  }

  // A green PR is his, and it is the ONLY thing that is his.
  assert.equal(classifyPr(pr({ mergeStateStatus: "CLEAN" }), REQUIRED).bucket, "yours");

  // Mergeable-but-red is a session's job, not a decision to put in front of him, and the red check
  // has to be NAMED — an unexplained demotion is how a PR gets merged anyway.
  const unstable = classifyPr(
    pr({ mergeStateStatus: "UNSTABLE", statusCheckRollup: [check("validate", "SUCCESS"), check("synthetic", "FAILURE")] }),
    REQUIRED,
  );
  assert.equal(unstable.bucket, "claude");
  assert.match(unstable.reason, /synthetic/, "a red check must be named, not summarised away");

  for (const [state, pattern] of [
    ["DIRTY", /conflict/i],
    ["BEHIND", /behind main/i],
  ] as const) {
    const row = classifyPr(pr({ mergeStateStatus: state }), REQUIRED);
    assert.equal(row.bucket, "claude", `${state} is a session's work, never his click`);
    assert.match(row.reason, pattern);
  }

  assert.equal(classifyPr(pr({ isDraft: true, mergeStateStatus: "CLEAN" }), REQUIRED).bucket, "claude", "a draft is never offered for merge, whatever its merge state says");

  // -------------------------------------------------------------------------------------------
  // 2. A blocked PR is explained from the LIVE protection contexts — and a required check that has
  //    not reported at all is named. That is the `mobile` shape: it runs only when `mobile/`
  //    changed, so "absent from the rollup" is a real, routine state and must read as waiting
  //    rather than vanish.
  // -------------------------------------------------------------------------------------------
  const blockedWaiting = explainBlocked(
    normalizeRollup([check("validate", "SUCCESS"), check("checks", null, "IN_PROGRESS"), check("secret-scan", "SUCCESS")]),
    REQUIRED,
  );
  assert.match(blockedWaiting, /checks/, "the running required check must be named");
  assert.match(blockedWaiting, /mobile/, "a required check that has not reported at all must be named, not dropped — that is the `mobile` case");
  assert.match(blockedWaiting, /no report yet/, "an absent required check reads differently from a running one, and the words have to say which");

  const blockedRed = explainBlocked(normalizeRollup([check("checks", "FAILURE")]), REQUIRED);
  assert.match(blockedRed, /red on checks/, "a failed required check outranks every other explanation");

  // Every required check passed and GitHub still blocks: say so plainly rather than guessing green.
  const blockedByRule = explainBlocked(normalizeRollup(REQUIRED.map((n) => check(n, "SUCCESS"))), REQUIRED);
  assert.match(blockedByRule, /still blocks/i);
  assert.doesNotMatch(blockedByRule, /ready|green on every/i, "a blocked PR must never be described in the words used for a mergeable one");

  // With protection unreadable the verdict is untouched and only the words degrade. A regression
  // that let a missing context list turn a BLOCKED PR into his row would be the §2 failure exactly.
  const degraded = classifyPr(pr({ mergeStateStatus: "BLOCKED", statusCheckRollup: [] }), null);
  assert.equal(degraded.bucket, "claude", "an unreadable protection list must never promote a blocked PR to his section");

  // -------------------------------------------------------------------------------------------
  // 3. Unknowns reach the board, and reach the rendered output.
  // -------------------------------------------------------------------------------------------
  const blind = buildBoard({
    prs: { unknown: "`gh` is not authenticated here" },
    protection: { unknown: "`gh` is not authenticated here" },
    production: { unknown: "healthz did not answer (fetch failed)" },
    now: NOW,
  });
  assert.equal(blind.yours.length, 0);
  assert.ok(blind.unknown.length >= 2, "three dead reads must not produce a quiet, empty, clean-looking board");

  const blindText = render(blind, { collectedAt: NOW, fromCache: false });
  assert.match(blindText, /COULD NOT READ/, "when nothing could be read, the screen must say so — this is the assertion that stops a blind board reading as an all-clear");
  assert.match(blindText, /not authenticated/, "the reason has to travel to the screen; an unexplained unknown sends him looking in the wrong place");
  assert.match(blindText, /never the clean answer/, "the heading itself carries the rule, because the person reading it at 4am is tired");

  // -------------------------------------------------------------------------------------------
  // 4. Production: behind is reported, and the two forbidden remedies are named as forbidden.
  // -------------------------------------------------------------------------------------------
  const behind = buildBoard({
    prs: { value: [] },
    protection: { value: REQUIRED },
    production: { value: { liveRevision: "a".repeat(40), mainTip: "b".repeat(40), behindBy: 3 } },
    now: NOW,
  });
  const behindLine = behind.knowing.join(" ");
  assert.match(behindLine, /3 commits behind main/);
  assert.match(behindLine, /never redeploy or re-merge/i, "AGENTS.md §2.3: the next green merge carries a skipped deploy forward by itself. A board that hinted at a redeploy would walk him into the one remedy the rule forbids.");

  const level = buildBoard({
    prs: { value: [] },
    protection: { value: REQUIRED },
    production: { value: { liveRevision: "c".repeat(40), mainTip: "c".repeat(40), behindBy: 0 } },
    now: NOW,
  });
  assert.match(level.knowing.join(" "), /serving main's tip/);

  // -------------------------------------------------------------------------------------------
  // 5. Owner rules that apply to anything this repository prints.
  // -------------------------------------------------------------------------------------------
  const full = buildBoard({
    prs: {
      value: [
        pr({ number: 4601, mergeStateStatus: "CLEAN", updatedAt: "2026-09-20T09:00:00Z" }),
        pr({ number: 4602, mergeStateStatus: "BLOCKED", statusCheckRollup: [check("checks", "FAILURE")] }),
      ],
    },
    protection: { value: REQUIRED },
    production: { value: { liveRevision: "d".repeat(40), mainTip: "e".repeat(40), behindBy: 1 } },
    now: NOW,
  });
  const text = render(full, { collectedAt: NOW, fromCache: false });

  assert.doesNotMatch(text, /…|\.\.\./, "no ellipsis anywhere — AGENTS.md §4. Long text wraps; it is never truncated.");
  assert.match(text, /Cairo/, "every time this repository prints is Cairo local, and the screen has to say so");
  assert.match(text, /merge 4601/, "his row is printed as the exact words he would type");
  assert.match(text, /CLAUDE'S WORK, NOT YOURS/, "the red PR has to be visibly NOT his, or the board just moves the pile rather than sorting it");
  assert.match(text, /no movement for 8 days/, "a PR he has left sitting is still his decision — the words say how long, so it is a decision rather than a mystery");

  for (const line of text.split("\n")) {
    assert.ok(line.length <= 100, `a rendered line is ${line.length} characters wide, which wraps in his terminal and breaks the board. AGENTS.md §4, the fits-the-screen rule.\n  ${line}`);
  }

  // `wrap` is what keeps the long §2.3 sentence readable without an ellipsis: every word survives.
  const long = "Railway holds a deploy until that commit's CI finishes and a red or cancelled run makes it SKIP";
  const wrapped = wrap(long, 40, "  ");
  assert.equal(wrapped.split("\n").map((l) => l.trim()).join(" "), long, "wrapping must be lossless — not one word may be dropped");
  assert.ok(wrapped.split("\n").every((l) => l.length <= 42));
}
