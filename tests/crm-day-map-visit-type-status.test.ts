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
 *
 * SECOND OWNER RULING, SAME DAY. The Sets are a strict whitelist while the two Maps end in
 * `?? "CP"`, so five undocumented codes — -7, -19, -20, -21, -30 — reached CP in copies #1 and #2
 * but fell through here with no cancel at all. That one was NOT latent: 88 agent-days across 30
 * employees since 2026-07-01 had one of those as their only CRM record, inside the
 * `deductions_candidates` window. The owner ruled they join the CP Set, so all three copies now
 * agree on every one of the 15 visit types production has ever produced.
 */

type Ruling = { code: number; status: "AV" | "CP"; name: string };

/**
 * Codes named EXPLICITLY in all three copies. -4 is the ONLY genuine leave type iReports360 gives
 * Phoenix. Because these are listed by hand in VISIT_TYPE_TO_STATUS, they can be source-guarded.
 */
const MAPPED_RULING: ReadonlyArray<Ruling> = [
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

/**
 * Undocumented codes that copies #1 and #2 reach CP for through their `?? "CP"` default rather than
 * a listed entry — so they must NOT be source-guarded against those Maps, only behaviourally
 * pinned. This Set has no default, so it has to name them; owner ruling 2026-08-21.
 */
const DEFAULTED_TO_CP: ReadonlyArray<Ruling> = [
  { code: -7, status: "CP", name: "Ambiguous (split by comment text)" },
  { code: -19, status: "CP", name: "Meetings" },
  { code: -20, status: "CP", name: "Admin Work" },
  { code: -21, status: "CP", name: "Business Review (BRM)" },
  { code: -30, status: "CP", name: "Unlabelled field visit" },
];

/** Every visit type production has ever produced (measured 2026-08-21). */
const RULING: ReadonlyArray<Ruling> = [...MAPPED_RULING, ...DEFAULTED_TO_CP];

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

  // ---- THE 88-AGENT-DAY GAP MUST STAY CLOSED --------------------------------
  // These five were the live hole: CP in copies #1/#2 via `?? "CP"`, but a fall-through here, so no
  // cancel reached reconcileDay and the day was judged on punch timing alone. Asserted separately
  // from the table loop so dropping one fails on a message that names the gap, not a row index.
  const stillFallingThrough = DEFAULTED_TO_CP.filter((entry) => crmDayVisitTypeStatus(entry.code) === undefined);
  assert.deepEqual(
    stillFallingThrough.map((entry) => entry.code),
    [],
    "the five undocumented codes (-7, -19, -20, -21, -30) must stay in the CP Set — they are CP in the "
      + "other two copies via `?? \"CP\"`, and falling through here left 88 agent-days across 30 "
      + "employees (since 2026-07-01) with no cancel at all (owner ruling 2026-08-21)",
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
  for (const { code, status, name } of MAPPED_RULING) {
    assert.ok(
      sourceMap.includes(`[${code}, "${status}"]`),
      `VISIT_TYPE_TO_STATUS must still map ${name} (${code}) to ${status} — the day map is pinned to it`,
    );
  }

  // ---- BUT THE WHITELIST IS STILL A WHITELIST -------------------------------
  // A code iReports360 has never sent stays a fall-through, deliberately: copies #1/#2 would call it
  // CP, and cancelling a deduction for a code nobody has classified is the riskier default. Nothing
  // alerts on this (crm/unmapped-alert.ts covers unmapped AGENTS, not visit types), so if a 16th
  // code ever appears it must be classified by hand in all three copies.
  assert.equal(
    crmDayVisitTypeStatus(-99),
    undefined,
    "an unknown/future visit type must NOT silently become a cancel — classify it deliberately instead",
  );
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
    dayMap.includes("-1, -2, -5, -6, -7, -8, -9, -11, -12, -15, -19, -20, -21, -30,"),
    "the CP Set must carry all 15 production visit types — Public Holiday (-5), Casual Leave (-6) and "
      + "Health Day (-15) alongside the original campaign types and the five undocumented codes",
  );
}
