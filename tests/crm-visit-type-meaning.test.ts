import assert from "node:assert/strict";

import { CRM_DAY_CLASSIFIED_VISIT_TYPES, crmDayVisitTypeStatus } from "../src/lib/attendance/crm-day-maps.ts";
import { leaverVisitTypeStatus } from "../src/lib/automated-payroll/recommend.ts";
import {
  CRM_CLASSIFIED_NON_REGULAR_VISIT_TYPES,
  CRM_LEAVE_VISIT_TYPE_CODES,
  CRM_WORKING_VISIT_TYPE_CODES,
  crmVisitTypeMeaningLenient,
  crmVisitTypeMeaningStrict,
} from "../src/lib/crm/visit-type-meaning.ts";

/**
 * ONE VISIT-TYPE TABLE REPLACED THREE HAND-KEPT COPIES — AND NOT ONE ANSWER MOVED.
 *
 * Before this change the AV/CP ruling lived in:
 *   #1 VISIT_TYPE_TO_STATUS         field-workforce-compliance/ireports360-source.ts, read `?? "CP"`
 *   #2 LEAVER_VISIT_TYPE_TO_STATUS  automated-payroll/recommend.ts, read raw (undefined if unlisted)
 *   #3 CRM_LEAVE_VISIT_TYPES / CRM_CAMPAIGN_VISIT_TYPES  attendance/crm-day-maps.ts, strict whitelist
 *
 * The expected values below are those three copies' OLD literal answers, frozen from origin/main
 * 03c41afe1, for every visit type production has ever produced (16 codes, re-measured 2026-09-13:
 * 0, -1, -2, -4, -5, -6, -7, -8, -9, -11, -12, -15, -19, -20, -21, -30). If any copy's answer for
 * a real code changes, a real day starts being charged (or stops being charged) as leave.
 *
 * The one deliberate difference is copy #2's RAW return for the five codes it never listed
 * (-7, -19, -20, -21, -30): undefined before, "CP" now. Its only callers are tests, and its own
 * contract was always "callers treat undefined as CP", so its EFFECTIVE answer is unchanged —
 * which is what is asserted.
 */

type Status = "AV" | "CP" | undefined;

type OldAnswers = { code: number; name: string; fwc: Status; leaver: Status; dayMap: Status };

const OLD_LITERAL_ANSWERS: ReadonlyArray<OldAnswers> = [
  { code: -1, name: "Conference", fwc: "CP", leaver: "CP", dayMap: "CP" },
  { code: -2, name: "Group Meeting", fwc: "CP", leaver: "CP", dayMap: "CP" },
  { code: -4, name: "Annual Vacation", fwc: "AV", leaver: "AV", dayMap: "AV" },
  { code: -5, name: "Public Holiday", fwc: "CP", leaver: "CP", dayMap: "CP" },
  { code: -6, name: "Casual Leave", fwc: "CP", leaver: "CP", dayMap: "CP" },
  { code: -7, name: "Ambiguous", fwc: "CP", leaver: undefined, dayMap: "CP" },
  { code: -8, name: "Campaign (Prospection)", fwc: "CP", leaver: "CP", dayMap: "CP" },
  { code: -9, name: "Training", fwc: "CP", leaver: "CP", dayMap: "CP" },
  { code: -11, name: "Meeting", fwc: "CP", leaver: "CP", dayMap: "CP" },
  { code: -12, name: "Traveling", fwc: "CP", leaver: "CP", dayMap: "CP" },
  { code: -15, name: "Health Day", fwc: "CP", leaver: "CP", dayMap: "CP" },
  { code: -19, name: "Meetings", fwc: "CP", leaver: undefined, dayMap: "CP" },
  { code: -20, name: "Admin Work", fwc: "CP", leaver: undefined, dayMap: "CP" },
  { code: -21, name: "Business Review (BRM)", fwc: "CP", leaver: undefined, dayMap: "CP" },
  { code: -30, name: "Unlabelled field visit", fwc: "CP", leaver: undefined, dayMap: "CP" },
];

/** The 16th production code: a regular visit. #1 counts it (never looked up); #2 and #3 returned undefined. */
const REGULAR = { code: 0, leaver: undefined as Status, dayMap: undefined as Status };

export function runCrmVisitTypeMeaningTests() {
  // ---- THE HEADLINE: ONLY ANNUAL VACATION IS LEAVE ---------------------------
  assert.deepEqual(
    [...CRM_LEAVE_VISIT_TYPE_CODES],
    [-4],
    "Annual Vacation (-4) must be the ONLY leave code in the shared table — Public Holiday (-5) and Casual "
      + "Leave (-6) are WORKING days (owner ruling 2026-08-21) and Health Day (-15) is working time (2026-08-01)",
  );

  // ---- EVERY PRODUCTION CODE GIVES EACH COPY ITS OLD ANSWER ------------------
  for (const { code, name, fwc, leaver, dayMap } of OLD_LITERAL_ANSWERS) {
    assert.equal(
      crmVisitTypeMeaningLenient(code),
      fwc,
      `${name} (${code}): the Field Workforce Compliance matrix (copy #1, lenient) must still read ${fwc}`,
    );
    assert.equal(
      crmDayVisitTypeStatus(code),
      dayMap,
      `${name} (${code}): the attendance day map (copy #3, strict) must still read ${dayMap}`,
    );
    assert.equal(
      leaverVisitTypeStatus(code) ?? "CP",
      leaver ?? "CP",
      `${name} (${code}): the payroll leaver ruling (copy #2) must keep its effective answer ${leaver ?? "CP"}`,
    );
    assert.equal(
      crmVisitTypeMeaningStrict(code),
      crmVisitTypeMeaningLenient(code),
      `${name} (${code}) is a listed code, so the strict and lenient lookups must agree on it`,
    );
  }
  assert.equal(crmDayVisitTypeStatus(REGULAR.code), REGULAR.dayMap, "a regular visit (0) is never looked up in the day map");
  assert.equal(leaverVisitTypeStatus(REGULAR.code), REGULAR.leaver, "a regular visit (0) is never looked up by the leaver ruling");

  // ---- THE TABLE IS EXACTLY THE 15 PRODUCTION NEGATIVES ----------------------
  assert.deepEqual(
    [...CRM_CLASSIFIED_NON_REGULAR_VISIT_TYPES].sort((a, b) => a - b),
    OLD_LITERAL_ANSWERS.map((entry) => entry.code).sort((a, b) => a - b),
    "the shared table must classify exactly the 15 non-regular codes production has produced",
  );
  assert.deepEqual(
    [...CRM_DAY_CLASSIFIED_VISIT_TYPES].sort((a, b) => a - b),
    [0, ...OLD_LITERAL_ANSWERS.map((entry) => entry.code)].sort((a, b) => a - b),
    "the sync alert's recognized set must be the same 16 codes it was before",
  );
  for (const code of CRM_WORKING_VISIT_TYPE_CODES) {
    assert.equal(CRM_LEAVE_VISIT_TYPE_CODES.has(code), false, `${code} cannot be both leave and working time`);
  }

  // ---- AN UNKNOWN CODE: THE TWO LOOKUPS STILL DIFFER, ON PURPOSE -------------
  assert.equal(crmVisitTypeMeaningLenient(-99), "CP", "copy #1 must still count an unclassified code as a worked day");
  assert.equal(crmVisitTypeMeaningStrict(-99), undefined, "the strict lookup must not invent a meaning for an unclassified code");
  assert.equal(crmDayVisitTypeStatus(-99), undefined, "the day map must still fall through on an unclassified code (no cancel)");
  assert.equal(leaverVisitTypeStatus(-99), undefined, "the leaver ruling must still return undefined for an unclassified code");
}
