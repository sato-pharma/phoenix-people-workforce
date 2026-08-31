import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { dvRequirementMetForRole } from "../src/lib/probation/intelligence/dv-progress-lookup.ts";
import type { DvProgress } from "../src/lib/probation/intelligence/report-metrics.ts";
import type { ProbationEvaluatorRole } from "../src/lib/probation/intelligence/types.ts";

/**
 * The Double Visit probation watchlist reads the LIVE DV record, not the retired checkbox table.
 *
 * WHAT WAS WRONG. The watchlist's "DV" column answered from `employee_probation`'s four boolean
 * dv_done columns. That table has held ZERO rows in production since the Case model took over
 * provisioning, so `getProbationRows` returned `dv_state: null` for every row and the column read
 * `Boolean(null)` — a hard false. Every probationer showed "Pending" to their manager, forever,
 * including the ones whose DM had already done eighteen double visits.
 *
 * Measured on production 2026-09-01: employee_probation 0 rows, against 21 active probation cases
 * carrying 79 countable DM DV-Days, with 12 of the 21 already past a DM requirement of 2.
 *
 * IT WAS NOT ONLY A SCREEN. roster-summary.ts counts `probationDvDone === false` into
 * `probationDvPending`, which is a line in the weekly DV digest EMAIL ("On probation, DV pending").
 * A permanently-false column therefore mailed managers an inflated backlog every week.
 *
 * WHY A SOURCE PIN. The failure mode is silent by construction: both the dead and the live source
 * produce a well-formed boolean, and the dead one produces the *plausible* answer (a new hire
 * genuinely has no double visit yet). Nothing about the rendered page looks wrong, so only a check
 * on WHERE the value comes from can catch a regression here.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function read(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

/**
 * A DvProgress with one role's numbers filled in; the rest are zeroed.
 *
 * `byRole` is annotated rather than inferred on purpose. Inferred, each key carries its own literal
 * `role` type, so writing through a union-typed index narrows the write target to `never` and the
 * assignment below stops compiling — which the test suite cannot see, because it strips types.
 */
function progressWith(role: ProbationEvaluatorRole, required: number, validated: number): DvProgress {
  const byRole: DvProgress["byRole"] = {
    dm: { role: "dm", required: 0, validated: 0, feedbackCompleted: 0, complete: true },
    tm: { role: "tm", required: 0, validated: 0, feedbackCompleted: 0, complete: true },
    pm_gpm: { role: "pm_gpm", required: 0, validated: 0, feedbackCompleted: 0, complete: true },
    nsm: { role: "nsm", required: 0, validated: 0, feedbackCompleted: 0, complete: true },
  };
  byRole[role] = { role, required, validated, feedbackCompleted: 0, complete: false };
  return { byRole, totalRequired: required, totalValidated: validated, totalFeedbackCompleted: 0 };
}

export function runDvProbationWatchlistLiveSourceTests() {
  // ── The verdict itself ──────────────────────────────────────────────────────
  assert.equal(
    dvRequirementMetForRole(progressWith("dm", 2, 2), "dm", "Pedia"),
    true,
    "a DM who has met the configured requirement of 2 must read Done — this is the exact case that " +
      "read Pending for months while the column was fed by the empty employee_probation table",
  );
  assert.equal(
    dvRequirementMetForRole(progressWith("dm", 2, 18), "dm", "Pedia"),
    true,
    "well past the requirement is still Done, not a count comparison that only matches on equality",
  );
  assert.equal(
    dvRequirementMetForRole(progressWith("dm", 2, 1), "dm", "Pedia"),
    false,
    "one of two required double visits is genuinely still Pending — the fix must not turn every " +
      "probationer green, only the ones who have actually been visited enough",
  );
  assert.equal(
    dvRequirementMetForRole(progressWith("dm", 2, 0), "dm", "Pedia"),
    false,
    "a brand-new probationer with no double visit at all is Pending, which is the one thing the " +
      "broken column happened to get right and must keep getting right",
  );

  // ── "Not applicable" must never be dressed up as "Pending" ──────────────────
  // A red status a manager cannot clear is worse than no status: it trains them to ignore the column.
  assert.equal(
    dvRequirementMetForRole(progressWith("tm", 0, 0), "tm", "Pedia"),
    null,
    "a tier whose requirement is configured to 0 (today: tm) owes no double visit, so it is N/A",
  );
  assert.equal(
    dvRequirementMetForRole(progressWith("pm_gpm", 1, 0), "pm_gpm", "CNS"),
    null,
    "PM/GPM is not applicable on CNS — resolveEvaluatorRole refuses that pairing with " +
      "pm_gpm_not_applicable_cns, so the watchlist must not bill a PM for a visit the Case model " +
      "would reject",
  );
  assert.equal(
    dvRequirementMetForRole(progressWith("pm_gpm", 1, 0), "pm_gpm", "cns"),
    null,
    "the CNS exemption is decided on a normalized line name, not on an exact-case string match",
  );
  assert.equal(
    dvRequirementMetForRole(progressWith("pm_gpm", 1, 1), "pm_gpm", "Anti Infective"),
    true,
    "the CNS exemption must be narrow — a PM on any other line is still measured normally",
  );
  assert.equal(
    dvRequirementMetForRole(undefined, "dm", "Pedia"),
    null,
    "no progress for this employee (no active case, or the read failed) is UNKNOWN, never 'not " +
      "done'. Rendering a failed read as a red Pending is precisely the bug being fixed here.",
  );

  // ── The watchlist is wired to the live source, and not to the dead one ──────
  const service = read("src/lib/double-visit-analytics/service.ts");
  assert.ok(
    !/dv_state/.test(service),
    "the DV probation watchlist is reading dv_state again. That is projected from employee_probation, " +
      "which has held zero rows in production since the Case model took over provisioning, so it " +
      "renders every probationer as Pending forever. Read probation_dv_days through " +
      "getActiveProbationDvProgressByEmployee instead.",
  );
  assert.ok(
    !/ProbationDvState/.test(service),
    "the checkbox-state type is back in the DV analytics service — the same dead employee_probation " +
      "source under another name",
  );
  assert.ok(
    service.includes("getActiveProbationDvProgressByEmployee"),
    "the DV analytics service no longer loads probation DV progress from the live Case model",
  );
  // Both watchlist builders must be fixed: the portal focus widget AND the DV Planner builder that
  // the weekly digest email reuses. Fixing only the page would leave the email quietly wrong.
  assert.equal(
    service.split("resolveProbationDvDone(").length - 1,
    3, // one definition + the two call sites
    "both probation watchlist builders (getDoubleVisitPortalFocus and buildDvPlannerProbationEntries) " +
      "must resolve dvDone the same way — the weekly digest reuses the second one, so a divergence " +
      "makes the email disagree with the page it links to",
  );

  // ── The rollup has ONE authority ────────────────────────────────────────────
  const lookup = read("src/lib/probation/intelligence/dv-progress-lookup.ts");
  assert.ok(
    lookup.includes("computeDvProgress"),
    "dv-progress-lookup must roll up through computeDvProgress, the same function the probation " +
      "dashboard and the consolidated report use. A second opinion about what counts as a completed " +
      "DV is how two screens end up disagreeing about the same rep.",
  );
  assert.ok(
    /\.eq\("status", "active"\)/.test(lookup),
    "DV progress must be scoped to ACTIVE probation cases — otherwise a rehired employee's DV-Days " +
      "from an earlier closed case count toward the current one",
  );

  // ── The dead projection is gone, and stays gone ─────────────────────────────
  // Deleted 2026-09-01 once its last readers went (#2844 the feedback panels, #2846 this
  // watchlist). Pinned rather than merely deleted because an unread field that still LOOKS like
  // live probation DV state is a loaded gun: the next reader to reach for it inherits a value that
  // has been null on every row since the Case model took over provisioning, and gets no error.
  // The DATABASE columns are deliberately left in place — nothing reads them, dropping them is a
  // production migration, and they are the only record of what the checkbox era captured.
  const probationTypes = read("src/lib/probation/types.ts");
  const probationService = read("src/lib/probation/service.ts");
  for (const [name, source] of [
    ["src/lib/probation/types.ts", probationTypes],
    ["src/lib/probation/service.ts", probationService],
  ] as const) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(
      !/dv_state/.test(code),
      `${name} projects dv_state again. It is built from employee_probation's DV checkbox columns, ` +
        "which nothing has written since the Case model took over provisioning — so it is null on " +
        "every row and any reader of it silently reports 'no double visit' for everyone. Read " +
        "probation_dv_days through intelligence/dv-progress-lookup.ts instead.",
    );
    assert.ok(
      !/ProbationDvState/.test(code),
      `${name} declares ProbationDvState again — the same dead checkbox shape under its type name`,
    );
  }
  // Comments are stripped above, so the removal notes explaining WHY cannot fail this. Confirm one
  // survives: a bare deletion is what invites the next session to rebuild exactly this.
  assert.ok(
    /dv_state/.test(probationService) && /dv_state/.test(probationTypes),
    "the removal notes naming dv_state were deleted from probation service.ts / types.ts. They are " +
      "the only thing telling the next reader that this field existed, answered null for its whole " +
      "life, and was replaced by probation_dv_days.",
  );
}
