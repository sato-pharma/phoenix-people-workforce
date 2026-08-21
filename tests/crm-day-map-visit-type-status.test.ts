import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { crmDayVisitTypeStatus } from "../src/lib/attendance/crm-day-maps.ts";
import { leaverVisitTypeStatus } from "../src/lib/automated-payroll/recommend.ts";

/**
 * THE iREPORTS360 AV/CP RULING EXISTS IN THREE PLACES, AND THE THIRD ONE DRIFTED.
 *
 * Two of the copies are Maps and grep as `VISIT_TYPE_TO_STATUS`
 * (field-workforce-compliance/ireports360-source.ts) and `LEAVER_VISIT_TYPE_TO_STATUS`
 * (automated-payroll/recommend.ts). The third is a pair of Sets in attendance/crm-day-maps.ts, so
 * it matches neither name and every sweep over "the two maps" walked straight past it. It was
 * still carrying:
 *
 *   -15 Health Day as LEAVE, three weeks after the owner ruled it working time (2026-08-01,
 *        "an activity they do for patients in the dr clinic"). Live: 121 rows, 35 since July.
 *   -5 Public Holiday and -6 Casual Leave in NEITHER Set, so they classified as nothing at all
 *        and the day fell through the loop's `continue` with no cancel — contradicting the owner
 *        ruling of 2026-08-21 that both are working days.
 *
 * Neither had yet cost money (verified on production 2026-08-21): -15 is a wrong reason string
 * only, because digest-reconcile cancels a deduction on hasCrmLeave AND hasCrmFieldVisit alike;
 * and -5/-6 went dormant on 2026-04-25 / 2026-02-08, before `deductions_candidates` starts in
 * 2026-07, so 0 agent-days overlap. This test is what stops the next drift from being the one
 * that does cost money.
 */

/** Owner-confirmed AV/CP ruling. -4 is the ONLY genuine leave type iReports360 gives Phoenix. */
const RULING: ReadonlyArray<{ code: number; status: "AV" | "CP"; name: string }> = [
  { code: -1, status: "CP", name: "Conference" },
  { code: -2, status: "CP", name: "Group Meeting" },
  { code: -4, status: "AV", name: "Annual Vacation" },
  { code: -5, status: "CP", name: "Public Holiday" },
  { code: -6, status: "CP", name: "Casual Leave" },
  { code: -8, status: "CP", name: "Campaign (Prospection)" },
  { code: -9, status: "CP", name: "Training" },
  { code: -11, status: "CP", name: "Meeting" },
  { code: -12, status: "CP", name: "Traveling" },
  { code: -15, status: "CP", name: "Health Day" },
];

export function runCrmDayMapVisitTypeStatusTests() {
  // ---- THE HEADLINE: ONLY ANNUAL VACATION IS LEAVE --------------------------
  // Stated as its own assertion rather than only inside the table loop below, so that breaking
  // the rule fails on a message naming the rule, not on a row index.
  const leaveCodes = RULING.filter((entry) => crmDayVisitTypeStatus(entry.code) === "AV").map((e) => e.code);
  assert.deepEqual(
    leaveCodes,
    [-4],
    "Annual Vacation (-4) must be the ONLY CRM visit type the attendance day map treats as leave — "
      + "Health Day (-15) is working time per the owner ruling of 2026-08-01, and Public Holiday (-5) "
      + "and Casual Leave (-6) are working days per the owner ruling of 2026-08-21",
  );

  // ---- EVERY RULED CODE, BOTH DIRECTIONS ------------------------------------
  for (const { code, status, name } of RULING) {
    assert.equal(
      crmDayVisitTypeStatus(code),
      status,
      `${name} (${code}) must classify as ${status} in the attendance day map`,
    );
  }

  // ---- THE THREE COPIES MUST AGREE -----------------------------------------
  // The whole defect was one copy diverging in silence. Pin them against each other so a change to
  // one that isn't mirrored fails here, naming the code that drifted.
  for (const { code, status, name } of RULING) {
    assert.equal(
      leaverVisitTypeStatus(code) ?? "CP",
      status,
      `${name} (${code}) must carry the same ruling in LEAVER_VISIT_TYPE_TO_STATUS as in the day map`,
    );
  }

  const sourceMap = readFileSync(
    new URL("../src/lib/field-workforce-compliance/ireports360-source.ts", import.meta.url),
    "utf8",
  );
  // VISIT_TYPE_TO_STATUS is module-private, so the third copy is pinned at the source. Plain string
  // checks, deliberately not a regex over match-anything (the SonarQube S5852 ReDoS hotspot).
  for (const { code, status, name } of RULING) {
    assert.ok(
      sourceMap.includes(`[${code}, "${status}"]`),
      `VISIT_TYPE_TO_STATUS must still map ${name} (${code}) to ${status} — the day map is pinned to it`,
    );
  }

  // ---- THE FALL-THROUGH IS REAL, AND IT IS NOT `?? "CP"` --------------------
  // The two Maps end in `?? "CP"`, so an unlisted code still counts as working time there. The day
  // map is a strict whitelist: an unlisted code sets NO flag, the day hits the loop's `continue`,
  // and no cancel reaches reconcileDay. That difference is why -5/-6 were a hole rather than a
  // harmless omission, and it still applies to -7/-19/-20/-21/-30 (88 agent-days across 30
  // employees since 2026-07-01, production 2026-08-21) pending an owner ruling.
  for (const unlisted of [-7, -19, -20, -21, -30]) {
    assert.equal(
      crmDayVisitTypeStatus(unlisted),
      undefined,
      `${unlisted} is knowingly outside both Sets — if it gains a ruling, add it here deliberately, `
        + "never by accident",
    );
  }
  assert.equal(
    crmDayVisitTypeStatus(0),
    undefined,
    "a regular visit (0) is counted by regularCount in the classification loop, never through these Sets",
  );

  // ---- SOURCE GUARD: THE SETS THEMSELVES ------------------------------------
  // crmDayVisitTypeStatus is a thin reader over the two Sets, so a revert that edits the Sets is
  // caught above — but pin the literals too, so a reviewer diffing this file sees the ruling.
  const dayMap = readFileSync(new URL("../src/lib/attendance/crm-day-maps.ts", import.meta.url), "utf8");
  assert.ok(
    dayMap.includes("const CRM_LEAVE_VISIT_TYPES = new Set<number>([-4]);"),
    "the leave Set must contain Annual Vacation and nothing else",
  );
  assert.ok(
    dayMap.includes("const CRM_CAMPAIGN_VISIT_TYPES = new Set<number>([-1, -2, -5, -6, -8, -9, -11, -12, -15]);"),
    "the CP Set must carry Public Holiday (-5), Casual Leave (-6) and Health Day (-15) alongside the "
      + "original campaign types",
  );
}
