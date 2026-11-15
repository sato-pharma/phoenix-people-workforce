import { strict as assert } from "node:assert";

import {
  CRM_NO_ACTIVITY_REASON,
  RETIRED_CRM_NO_ACTIVITY_REASON,
  currentDeductionReason,
} from "../src/lib/deductions/reason-text.ts";
import { mapDailyLineRow } from "../src/lib/daily-deductions/service.ts";
import { mapPublicationLine } from "../src/lib/deductions/portal.ts";
import {
  PHOENIX_CRM_VERIFICATION_SOURCE,
  RETIRED_CRM_VERIFICATION_SOURCE,
  currentVerificationSourceText,
  verificationSourceOptions,
} from "../src/lib/private-calendar/verification-sources.ts";

/**
 * THE DEDUCTION AND CALENDAR-DISPUTE SCREENS NAME TODAY'S SOURCES, NOT THE RETIRED iREPORTS360 AUDIT
 * (owner, 2026-11-15: "you still showing source of old crm deep audit … match with today updates and
 * keep wording and from where you grab the data accurate").
 *
 * Two places still spoke the old system's language nine days after iReports360 was retired:
 *   - every CRM deduction line read "Field Workforce Compliance no-activity candidate" — on Daily
 *     Deductions, the month Deductions screen, the employee's portal and the Dispute Center;
 *   - a calendar review request offered "CRM / iReports360 (Double Visit)" as where to verify it.
 *
 * Rows already stored keep the old text in the database, so the readers rename it on the way out.
 */
export function runDeductionsCurrentSourceWordingTests(): void {
  // 1. The reason names what the connector really reads today.
  assert.match(CRM_NO_ACTIVITY_REASON, /Phoenix CRM visit or day activity \(training/, "the reason names Phoenix CRM and its day activities");
  assert.match(CRM_NO_ACTIVITY_REASON, /iReports360 archive/, "the reason says the old system is only an archive");
  assert.doesNotMatch(CRM_NO_ACTIVITY_REASON, /Field Workforce Compliance/, "the retired audit name is gone from the reason");

  // 2. A stored row with the retired text reads in today's words; any other reason is untouched.
  assert.equal(currentDeductionReason(RETIRED_CRM_NO_ACTIVITY_REASON), CRM_NO_ACTIVITY_REASON);
  assert.equal(currentDeductionReason(null), null);
  const vacation = "Approved vacation is unpaid (not yet entitled within first 6 months, or hire date missing)";
  assert.equal(currentDeductionReason(vacation), vacation, "only the retired CRM text is renamed");

  // 3. The readers apply it — a Daily Deductions line released on 12 Nov and a published payslip line.
  const daily = mapDailyLineRow({
    category: "crm",
    created_at: "2026-11-12T12:15:52Z",
    dates: ["2026-11-07"],
    employee_hr_id: "PD-0030",
    employee_hr_id_compact: "pd0030",
    id: "line-1",
    publication_id: "pub-1",
    reason: RETIRED_CRM_NO_ACTIVITY_REASON,
    source_system: "crm_visits_mirror",
  });
  assert.equal(daily.reason, CRM_NO_ACTIVITY_REASON, "a released daily line reads the current reason");
  assert.equal(daily.sourceSystem, "crm_visits_mirror", "the stored source key is a ledger key and is never renamed");

  const published = mapPublicationLine({
    applied_amount: 500,
    applied_value: 1,
    candidate_id: "c-1",
    category: "crm",
    created_at: "2026-11-01T00:00:00Z",
    dates: ["2026-10-29"],
    decision_id: "d-1",
    employee_hr_id: "PD-0013",
    employee_hr_id_compact: "pd0013",
    employee_name: "Rep",
    hr_note: null,
    id: "p-1",
    month_key: "2026-10",
    original_value: 1,
    publication_id: "pub-1",
    reason: RETIRED_CRM_NO_ACTIVITY_REASON,
    unit: "days",
  } as unknown as Parameters<typeof mapPublicationLine>[0]);
  assert.equal(published.reason, CRM_NO_ACTIVITY_REASON, "a published payslip line reads the current reason");

  // 4. The calendar review form offers Phoenix CRM, and never the retired option.
  assert.ok((verificationSourceOptions as readonly string[]).includes(PHOENIX_CRM_VERIFICATION_SOURCE));
  assert.ok(!(verificationSourceOptions as readonly string[]).includes(RETIRED_CRM_VERIFICATION_SOURCE), "the form never offers iReports360");

  // 5. A request filed before the rename reads Phoenix CRM; what the employee typed himself is kept.
  assert.equal(
    currentVerificationSourceText(`${RETIRED_CRM_VERIFICATION_SOURCE}, Manager Confirmation`),
    `${PHOENIX_CRM_VERIFICATION_SOURCE}, Manager Confirmation`,
  );
  assert.equal(currentVerificationSourceText("Other: Photos on company WhatsApp group"), "Other: Photos on company WhatsApp group");
  assert.equal(currentVerificationSourceText(null), null);
}
