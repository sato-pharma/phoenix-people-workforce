/**
 * THE ONE PLACE THAT SAYS WHAT AN iREPORTS360 VISIT TYPE MEANS FOR ATTENDANCE AND PAY.
 *
 * Every non-regular visit type resolves to one of two meanings:
 *   - "AV" — away, not working (leave). Annual Vacation (-4) is the ONLY such code.
 *   - "CP" — working, just not a regular customer visit (conference, meeting, campaign, travel…).
 * A regular customer visit (0) is counted as a visit by every caller and never looked up here.
 *
 * This table used to exist as three hand-kept copies — `VISIT_TYPE_TO_STATUS` in
 * field-workforce-compliance/ireports360-source.ts, `LEAVER_VISIT_TYPE_TO_STATUS` in
 * automated-payroll/recommend.ts, and the `CRM_LEAVE_VISIT_TYPES` / `CRM_CAMPAIGN_VISIT_TYPES`
 * Sets in attendance/crm-day-maps.ts. They drifted: the Sets kept Health Day (-15) as leave three
 * weeks after the owner ruled it working time, and never received the Public Holiday (-5) /
 * Casual Leave (-6) ruling. All three now read this table, so there is nothing left to keep in
 * lockstep.
 *
 * Owner rulings carried here:
 *   - 2026-08-01: Health Day (-15) is working time — "an activity they do for patients in the dr
 *     clinic". It used to read as leave and charged 22 days across 11 employees in July 2026.
 *   - 2026-08-21: Public Holiday (-5) and Casual Leave (-6) are WORKING days.
 *   - 2026-08-21: the undocumented codes -7, -19, -20, -21, -30 are working time (CP). Their
 *     meanings were owner-confirmed 2026-07-14 from the reps' comment text; see
 *     src/lib/crm/visit-types.ts for the labels.
 *   - 2026-10-21: RTD, recorded in Phoenix CRM, is working time under its own code -22 (the vendor never
 *     sends it); a recorded Group meeting is served under the vendor's own Group Meeting (-2).
 *   - 2026-09-17: -16 is Training, a working day (CP). The vendor labels it "Unknown"; it first
 *     appeared on 2026-09-12 and every one of its first 54 visits (8 reps, to 2026-09-17) was
 *     commented "Training".
 *
 * TWO LOOKUPS, ON PURPOSE — they differ only for a code this table does not list:
 *   - {@link crmVisitTypeMeaningLenient} answers "CP". The Field Workforce Compliance matrix has
 *     always treated an unclassified code as a worked day, so a new code never starts charging
 *     leave on its own.
 *   - {@link crmVisitTypeMeaningStrict} answers undefined. The attendance digest day map uses it:
 *     silently cancelling a punch deduction for a code nobody has classified is the riskier
 *     default there. (The retired iReports360 sync alerted on such a code; no vendor row arrives now.)
 * For every code listed below, both lookups return the same answer.
 *
 * If iReports360 ever sends a new code, classify it HERE, deliberately, and nowhere else.
 */

export type CrmVisitTypeMeaning = "AV" | "CP";

/** Regular customer visit. Counted as a visit by every caller; deliberately absent from the table. */
export const CRM_REGULAR_VISIT_TYPE = 0;

/** Annual Vacation — the only leave code iReports360 gives Phoenix. */
export const CRM_ANNUAL_VACATION_VISIT_TYPE_CODE = -4;

const CRM_VISIT_TYPE_MEANINGS: ReadonlyMap<number, CrmVisitTypeMeaning> = new Map<number, CrmVisitTypeMeaning>([
  [-1, "CP"], // Conference
  [-2, "CP"], // Group Meeting
  [-4, "AV"], // Annual Vacation — the only genuine leave type
  [-5, "CP"], // Public Holiday — a WORKING day (owner ruling 2026-08-21)
  [-6, "CP"], // Casual Leave — a WORKING day (owner ruling 2026-08-21)
  [-7, "CP"], // Ambiguous — comment text split later by classifyAmbiguousComment
  [-8, "CP"], // Campaign (Prospection)
  [-9, "CP"], // Training
  [-11, "CP"], // Meeting
  [-12, "CP"], // Traveling
  [-15, "CP"], // Health Day — clinic work (owner ruling 2026-08-01)
  [-16, "CP"], // Training — the vendor labels it "Unknown" (owner ruling 2026-09-17)
  [-19, "CP"], // Meeting — undocumented twin of -11, same activity (owner ruling 2026-09-21)
  [-20, "CP"], // Admin Work
  [-21, "CP"], // Business Review (BRM)
  [-22, "CP"], // RTD — a Phoenix-side code, never sent by the vendor (owner ruling 2026-10-21)
  [-30, "CP"], // Unlabelled field visit
]);

/** The meaning of a listed code, or undefined for a code the table does not classify (incl. 0). */
export function crmVisitTypeMeaningStrict(visitType: number): CrmVisitTypeMeaning | undefined {
  return CRM_VISIT_TYPE_MEANINGS.get(visitType);
}

/** The meaning of a listed code, or "CP" (worked) for a code the table does not classify. */
export function crmVisitTypeMeaningLenient(visitType: number): CrmVisitTypeMeaning {
  return CRM_VISIT_TYPE_MEANINGS.get(visitType) ?? "CP";
}

/** Every non-regular visit type the table classifies. */
export const CRM_CLASSIFIED_NON_REGULAR_VISIT_TYPES: ReadonlySet<number> = new Set<number>(CRM_VISIT_TYPE_MEANINGS.keys());

/** The leave ("AV") codes — derived from the table, never hand-listed. */
export const CRM_LEAVE_VISIT_TYPE_CODES: ReadonlySet<number> = new Set<number>(
  [...CRM_VISIT_TYPE_MEANINGS].filter(([, meaning]) => meaning === "AV").map(([code]) => code),
);

/** The working-but-not-a-regular-visit ("CP") codes — derived from the table, never hand-listed. */
export const CRM_WORKING_VISIT_TYPE_CODES: ReadonlySet<number> = new Set<number>(
  [...CRM_VISIT_TYPE_MEANINGS].filter(([, meaning]) => meaning === "CP").map(([code]) => code),
);
