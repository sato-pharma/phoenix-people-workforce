import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The legacy probation feedback path is RETIRED (2026-09-01) and must not come back.
 *
 * WHAT IT WAS. A second, older feedback system: a per-cycle free-text form
 * (feedback-form-panel.tsx) writing `probation_feedback_submissions`, an always-empty "Probation
 * Feedback Report" (aggregate-feedback-report.tsx), a DV-checkbox strip (dv-checkbox-panel.tsx)
 * over four boolean columns, and an hourly cron tick (tickDvCheckboxesFromSync). All of it hung off
 * `employee_probation`.
 *
 * WHY IT COULD NEVER WORK. `employee_probation` has held ZERO rows in production since the Case
 * model took over provisioning — the DB hire trigger writes `probation_cases`, and only the
 * recruitment offer path ever wrote the legacy table. So:
 *
 *   resolveProbationRecord()  -> null for every employee, always
 *   checkFeedbackEligibility() -> { eligible: false } for every role, always
 *   submitFeedback()          -> throws "Forbidden: you are not eligible…"
 *
 * and `probation_feedback_submissions.probation_id` is a NOT NULL FK to that empty table, so a row
 * was physically unwritable. Measured on production 2026-09-01: employee_probation 0 rows,
 * probation_feedback_submissions 0 rows, against probation_cases 21 and probation_feedback 9.
 *
 * THE TRAP THIS PINS. The path had already survived one revival attempt. A previous session found
 * three real blockers (a coarse gate on probation:update no submitter held, FK columns written from
 * a lowercased hr_id, and the HR seats missing from resolveSubmitterRole), fixed all three, shipped
 * them, and pinned them in tests/probation-feedback-revival.test.ts — and the row count stayed at
 * zero, because the fourth and fatal blocker was the empty table underneath. Three green fixes on a
 * path nobody can exercise still reads exactly like "adoption is slow". That is why this asserts
 * the path is GONE rather than asserting it works: the next session to look at a zero here should
 * find the reason, not another repair.
 *
 * WHAT REPLACED IT. Nothing was taken away. Feedback lives in the Case model, and did all along:
 * an evaluator submits against a real double-visit at /employee-portals/probation/feedback/<dvDayId>
 * and it lands in `probation_feedback` (scored, versioned, tied to the DV that occasioned it).
 * The last section below ties this retirement to that replacement — if the live path ever goes
 * away, this fails rather than leaving the product with no feedback capture at all.
 */

/** Every file deleted on 2026-09-01. Re-creating any of them rebuilds the dead path. */
const RETIRED_FILES: readonly string[] = [
  "src/lib/probation/feedback-service.ts",
  "src/components/probation/feedback-form-panel.tsx",
  "src/components/probation/aggregate-feedback-report.tsx",
  "src/components/probation/dv-checkbox-panel.tsx",
  "app/api/probation/feedback/route.ts",
  "app/api/probation/feedback/aggregate/route.ts",
  "app/api/probation/feedback/dv-checkbox/route.ts",
  "app/api/probation/feedback/employee/[hrId]/route.ts",
  "app/api/probation/feedback/[submissionId]/comment/route.ts",
];

/**
 * Identifiers that only ever existed to serve the legacy path. `probation_feedback_submissions` is
 * the table itself; the rest are the functions and components that read or wrote it.
 *
 * NOT included, deliberately: `employee_probation`. It is still read by probation/service.ts and
 * still written by the recruitment offer path in provisioning.ts, and untangling that is a separate
 * decision about the Case model's ownership of provisioning — not something to smuggle in here.
 */
const RETIRED_IDENTIFIERS: readonly string[] = [
  "probation_feedback_submissions",
  "probation_feedback_comments",
  "tickDvCheckboxesFromSync",
  "setDvCheckboxManual",
  "getAggregateFeedbackReport",
  "checkFeedbackEligibility",
  "FeedbackFormPanel",
  "AggregateFeedbackReport",
  "DvCheckboxPanel",
];

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** Every .ts/.tsx file under app/ and src/, skipping build output and sibling worktrees. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const skip = new Set(["node_modules", ".next", ".git", ".claude", "__snapshots__"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith("_wt-") || skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) found.push(full);
    }
  };
  for (const root of ["app", "src"]) walk(path.join(REPO_ROOT, root));
  return found;
}

export function runProbationLegacyFeedbackRetiredTests() {
  // ── The files stay deleted ──────────────────────────────────────────────────
  for (const file of RETIRED_FILES) {
    assert.equal(
      existsSync(path.join(REPO_ROOT, file)),
      false,
      `${file} is back. It belongs to the legacy probation feedback path, which is anchored on ` +
        "employee_probation — a table nothing has filled since the Case model took over " +
        "provisioning, so anything rebuilt on it can only ever refuse. Submit feedback against a " +
        "DV-Day instead (intelligence/feedback-workflow.ts).",
    );
  }

  // ── Nothing references what they exported ───────────────────────────────────
  // Comments are allowed to name them — every removal site left a note saying what stood there and
  // why it went, and those notes are the point. Only CODE is checked, so a note cannot fail this.
  const offenders: string[] = [];
  for (const full of sourceFiles()) {
    const code = stripComments(readFileSync(full, "utf8"));
    const hits = RETIRED_IDENTIFIERS.filter((id) => code.includes(id));
    if (hits.length > 0) {
      offenders.push(`${path.relative(REPO_ROOT, full).split(path.sep).join("/")} -> ${hits.join(", ")}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "live code references the retired legacy probation feedback path:\n  " + offenders.join("\n  "),
  );

  // ── The replacement is actually there ───────────────────────────────────────
  // Tie the retirement to its cause, the same way the removal notes do. Retiring the legacy path is
  // only correct while a live one exists; if this ever fails, the product has no feedback capture
  // at all and the right answer is to restore capture, not to delete this assertion.
  const workflow = readFileSync(
    path.join(REPO_ROOT, "src/lib/probation/intelligence/feedback-workflow.ts"),
    "utf8",
  );
  assert.match(
    workflow,
    /export async function submitDvFeedback\(/,
    "the live per-DV-Day feedback submitter is gone. The legacy path was retired on the grounds " +
      "that this one replaces it — with both gone, nobody can record probation feedback at all.",
  );
  assert.match(
    workflow,
    /\.from\("probation_feedback"\)/,
    "the live feedback path no longer writes probation_feedback, the table holding the real " +
      "submissions the legacy path was retired in favour of",
  );

  assert.match(
    readFileSync(path.join(REPO_ROOT, "app/employee-portals/probation/page.tsx"), "utf8"),
    /<ProbationFeedbackTasksPanel/,
    "the portal no longer offers the feedback-tasks panel, which is the only surface an evaluator " +
      "can reach their open DV feedback from now that the legacy per-cycle form is gone",
  );
}
