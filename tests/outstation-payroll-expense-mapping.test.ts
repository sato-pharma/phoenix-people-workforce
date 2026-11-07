import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  mapOutstationRequestRowToPayrollApproval,
  outstationPayrollTripId,
} from "../src/lib/outstation/payroll-expense-mapping.ts";

export function runOutstationPayrollExpenseMappingTests() {
  assert.equal(outstationPayrollTripId(42), "OUTSTATION-42");

  // The workload pair is the resolved am_workload/pm_workload, NOT report_am_workload /
  // report_pm_workload — those are `NOT NULL DEFAULT 0`, carry 0 on every live row, and are read
  // by neither mapper (see outstationWorkloadCount). They are set to 0 here, as production has
  // them, so this fixture cannot drift back into pinning the old override preference.
  const mapped = mapOutstationRequestRowToPayrollApproval({
    allowance_amount: 300,
    am_workload: 1,
    claimed_total_amount: 1500,
    created_at: "2026-05-20T10:00:00.000Z",
    distance_from_residence_km: 80,
    employee_hr_id: "A16",
    employee_name: "Account Admin",
    expected_total_amount: 1400,
    expense_type: "traveling",
    fuel_amount: 700,
    id: 42,
    notes: "Manual correction",
    pm_workload: 7,
    report_am_workload: 0,
    report_hr_notes: "Reviewed by HR",
    report_hr_status: "Approved",
    report_meeting_amount: 150,
    report_other_amount: 25,
    report_pm_workload: 0,
    report_travel_cost: 900,
    report_trip_type: "Return same day",
    status: "approved",
    ticket_amount: 500,
    to_city: "Alexandria",
    transportation_type: "car",
    trip_end_date: "2026-05-21T00:00:00.000Z",
    trip_start_date: "2026-05-20T00:00:00.000Z",
  });

  assert.equal(mapped.tripId, "OUTSTATION-42");
  assert.equal(mapped.requestType, "Outstation");
  assert.equal(mapped.hrApproved, true);
  assert.equal(mapped.sourceFileName, "Outstation Requests");
  assert.equal(mapped.total, 1375);
  assert.equal(mapped.travelCost, 900);
  assert.equal(mapped.meetingAmount, 150);
  assert.equal(mapped.other, 25);
  // report_hr_status / report_hr_notes were dropped on 2026-09-19 (owner). The fixture still
  // plants both, as a row written before the drop would carry them, and nothing reads the pair
  // any more: the HR Status column is the request's own decision (audit F-26 — it used to fall
  // back to the employee's name, "Account Admin" here).
  assert.equal(mapped.hr, "Approved", "the HR Status column is the request's decision, not a planted report_hr_status");
  assert.notEqual(mapped.hr, mapped.specialist, "the HR Status column must never be the employee's name (F-26)");
  assert.equal(mapped.hrNotes, "", "a planted report_hr_notes must not reach the HR note");

  // The same holds for a request still waiting and for a refused one.
  for (const [rawStatus, expected] of [
    ["submitted", "Pending"],
    ["pending_manager", "Pending"],
    ["rejected", "Rejected"],
  ] as const) {
    const decided = mapOutstationRequestRowToPayrollApproval({
      employee_name: "Account Admin",
      id: 7,
      status: rawStatus,
      trip_start_date: "2026-05-20T00:00:00.000Z",
    });
    assert.equal(decided.hr, expected, `a ${rawStatus} request reads ${expected} under HR Status`);
    assert.equal(decided.hr, decided.status, "HR Status agrees with the row's Status");
    assert.equal(decided.employeeNote, null, "no note typed reads as no note, never the description's placeholder");
  }

  // The employee's own note reaches Expense Approvals as itself (owner, 2026-11-06: a rep's
  // "استلام نسخة العقد" never showed — the screen drew no field that carried it).
  assert.equal(mapped.employeeNote, "Manual correction", "the claim's notes are the employee's note");
  const arabic = mapOutstationRequestRowToPayrollApproval({
    approval_reason: "Medical rep manual traveling expense submitted without manager outstation distance rules.",
    id: 341,
    notes: "  استلام نسخة العقد ",
    status: "submitted",
    trip_start_date: "2026-09-02T00:00:00.000Z",
  });
  assert.equal(arabic.employeeNote, "استلام نسخة العقد", "an Arabic note arrives whole, trimmed");

  // The stored notes carry the system's evidence stamp after the employee's words (owner,
  // 2026-11-07, on request 112: "why employee notes are awful like this, tidy them").
  const stamp =
    "Car live evidence: source=live_camera hr_id=B-119 captured_at=2026-09-01T11:09:56.430Z " +
    "location=6W33+78P, Mahta Al Raml Sq., Al Mesallah Sharq, Al Attarin, Alexandria Governorate 5373011, Egypt " +
    "· Brick محطة الرمل · Area Alex Center · Region Alex-BHR gps=31.2033172,29.9034106 " +
    "draft_id=eee72441-5482-4703-8281-e61a9aa90b9d request_id=112";
  const stampOnly = mapOutstationRequestRowToPayrollApproval({ id: 112, notes: stamp, status: "submitted", trip_start_date: "2026-09-01T00:00:00.000Z" });
  assert.equal(stampOnly.employeeNote, null, "HEADLINE: a claim whose notes are only the system's stamp shows no employee note");
  const typed = mapOutstationRequestRowToPayrollApproval({
    id: 113,
    notes: `كارتة رايح جاي ٣٠\n${stamp}\nAllowance guard: No allowance: a trip to Cairo from a regional base does not earn an outstation per-diem allowance.`,
    status: "submitted",
    trip_start_date: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(typed.employeeNote, "كارتة رايح جاي ٣٠", "HEADLINE: the employee's typed words stay, the stamp and the allowance line go");
  assert.match(typed.description, /Car live evidence:/, "the stored description is left as it is — other readers key on it");
  assert.notEqual(arabic.employeeNote, arabic.hrComment, "the employee's note is never HR's decision box");
  // Owner's review, 2026-11-07: the note box printed the machine lines service.ts appends to
  // `notes`. Only the rep's own words are the note; the allowance sentences travel on their own.
  const polluted = mapOutstationRequestRowToPayrollApproval({
    departure_evidence_image_path: "trips/9/departure.jpg",
    departure_evidence_metadata: { capturedAt: "2026-10-01T05:00:00.000Z" },
    id: 9,
    notes: [
      "زيارة عملاء الاسكندرية",
      "Allowance guard: No allowance: a trip to Cairo from a regional base does not earn an outstation per-diem allowance.",
      "Arrival photo evidence: source=camera hr_id=A16 captured_at=2026-10-01T09:00:00.000Z gps=31.2,29.9 draft_id=abc",
    ].join("\n"),
    status: "submitted",
    trip_start_date: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(polluted.employeeNote, "زيارة عملاء الاسكندرية", "HEADLINE: the note is the rep's words only");
  assert.doesNotMatch(String(polluted.employeeNote), /source=|draft_id=|Allowance guard/, "no machine text in the note");
  assert.equal(polluted.allowanceNotices?.length, 1, "the allowance sentence is carried on its own line");
  assert.match(String(polluted.allowanceNotices?.[0]), /^No allowance — a trip to Cairo/, "and reads as a sentence");
  const onlyMachine = mapOutstationRequestRowToPayrollApproval({
    id: 10,
    notes: "Arrival photo evidence: source=camera gps=31.2,29.9",
    status: "submitted",
    trip_start_date: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(onlyMachine.employeeNote, null, "machine text alone is no note at all");
  // A departure photo with no GPS is a rail reason (expense-approval-triage.ts), read from the
  // same metadata the photo tile reads.
  assert.equal(polluted.departurePhotoNoGps, true, "HEADLINE: a departure photo without a position is flagged as no-GPS");
  const located = mapOutstationRequestRowToPayrollApproval({
    departure_evidence_image_path: "trips/11/departure.jpg",
    departure_evidence_metadata: { capturedLatitude: 31.2, capturedLongitude: 29.9 },
    id: 11,
    status: "submitted",
    trip_start_date: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(located.departurePhotoNoGps, false, "a located departure photo is not");
  assert.equal(mapped.departurePhotoNoGps, false, "no departure photo at all is not a no-GPS photo");
  // Since the 2026-11-07 rebuild the queue is a table and the trip under review is the one-by-one
  // reviewer, whose findings section prints the note.
  const rail = readFileSync(
    new URL("../src/components/outstation/expense-review/review-queue-table.tsx", import.meta.url),
    "utf8",
  );
  const review = readFileSync(
    new URL("../src/components/outstation/expense-review/review-deck/deck-found.tsx", import.meta.url),
    "utf8",
  );
  // Owner, 2026-11-07, on a rail row holding a long note: "comment already written in the right
  // panel, remove from here". The note is printed once, on the trip under review, never on the rail.
  assert.equal(
    review.match(/<EmployeeNote note=\{record\.employeeNote\} wide \/>/g)?.length,
    1,
    "Expense Approvals draws the employee's note on the trip under review",
  );
  assert.doesNotMatch(rail, /EmployeeNote|employeeNote/, "a queue row never repeats the employee's note");
  assert.equal(mapped.amWorkload, 1, "the resolved am_workload, not the zeroed report_am_workload");
  assert.equal(mapped.pmWorkload, 7, "the resolved pm_workload, not the zeroed report_pm_workload");
  // The stay/duration label, unchanged — the approvals report renders it under "Travel Stay
  // Type". What moved on 2026-09-08 is the MEETING CLASSIFICATION, which no longer reads this
  // label and comes from `expense_type` instead; see the meeting cases in
  // tests/outstation-payroll-payable-total-agreement.test.ts.
  assert.equal(mapped.tripType, "Return same day");
  assert.equal(mapped.payoutMonth, 6);
  assert.equal(mapped.payoutYear, 2026);

  // A traveling request with none of the new fields set must default them to 0
  // (meeting_amount only falls back to claimed/expected for meeting-type requests).
  const mappedSimple = mapOutstationRequestRowToPayrollApproval({
    claimed_total_amount: 500,
    created_at: "2026-05-20T10:00:00.000Z",
    employee_hr_id: "A16",
    employee_name: "Account Admin",
    expense_type: "traveling",
    id: 99,
    status: "approved",
    trip_start_date: "2026-05-20T00:00:00.000Z",
  });
  assert.equal(mappedSimple.meetingAmount, 0, "traveling request with no meeting_amount maps to 0");
  assert.equal(mappedSimple.other, 0);
  assert.equal(mappedSimple.amWorkload, 0);
  assert.equal(mappedSimple.pmWorkload, 0);

  // New expense fields (meeting_amount, other_amount, am_workload, pm_workload) must flow
  // through to the payroll approval output unchanged.
  const mappedWithExtras = mapOutstationRequestRowToPayrollApproval({
    am_workload: 3,
    claimed_total_amount: 1500,
    created_at: "2026-05-20T10:00:00.000Z",
    employee_hr_id: "A16",
    employee_name: "Account Admin",
    expected_total_amount: 1400,
    expense_type: "traveling",
    id: 43,
    meeting_amount: 250,
    other_amount: 120,
    pm_workload: 4,
    status: "approved",
    trip_start_date: "2026-05-20T00:00:00.000Z",
  });
  assert.equal(mappedWithExtras.meetingAmount, 250, "explicit meeting_amount must map through");
  assert.equal(mappedWithExtras.other, 120, "other_amount must map through");
  assert.equal(mappedWithExtras.amWorkload, 3, "am_workload must map through");
  assert.equal(mappedWithExtras.pmWorkload, 4, "pm_workload must map through");

  // A meeting-type request with no explicit meeting_amount falls back to the server's own
  // expected total — NEVER the claim, even when the claim is higher (owner ruling 2026-09-03,
  // requests 52 and 99: a client-posted figure must never silently become the payable amount).
  const mappedMeeting = mapOutstationRequestRowToPayrollApproval({
    claimed_total_amount: 900,
    created_at: "2026-05-20T10:00:00.000Z",
    employee_hr_id: "A16",
    employee_name: "Account Admin",
    expected_total_amount: 800,
    expense_type: "meeting",
    id: 44,
    status: "approved",
    trip_start_date: "2026-05-20T00:00:00.000Z",
  });
  assert.equal(mappedMeeting.meetingAmount, 800, "meeting-type request defaults meeting_amount to the EXPECTED total, not the claim");
  assert.equal(mappedMeeting.total, 800, "the claim (900) must never become the payable total");
  assert.equal(mappedMeeting.other, 0);

  // ── Payout month is resolved on Africa/Cairo's calendar day, never the server's UTC clock ──
  // The payout month is the trip/expense month + 1. `nextPayrollPeriod` reads the date's Cairo
  // calendar day; before the 2026-09-22 hardening it read the raw UTC month, which paid a trip a
  // month early whenever the source instant fell in Cairo's first hours of the 1st (audit F-30).
  // These dates are all in winter (EET, UTC+2), so the result is the same on any engine, whether
  // or not its ICU knows Egypt reintroduced DST in 2023 — the +2 boundary holds year-round in
  // January, February and December.

  // A trip stored at UTC-midnight — how ALL live rows are stored — is unchanged: Cairo reads it
  // on the same calendar day, so the month + 1 answer is identical to the old UTC reading. This is
  // the no-regression-to-current-data guard.
  const utcMidnightTrip = mapOutstationRequestRowToPayrollApproval({
    created_at: "2026-02-01T09:00:00.000Z",
    employee_name: "Account Admin",
    id: 201,
    status: "approved",
    trip_start_date: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(utcMidnightTrip.payoutMonth, 3, "a 1 Feb trip at UTC-midnight pays in March — unchanged by the Cairo anchor");
  assert.equal(utcMidnightTrip.payoutYear, 2026);

  // THE FIX: an instant in Cairo's first hours of the 1st. 2026-01-31 22:00 UTC IS 2026-02-01
  // 00:00 in Cairo, so the trip belongs to February and pays in March. The old UTC reading saw
  // January and paid in February — a month early. Reverting the anchor makes this assertion fire.
  const cairoBoundaryTrip = mapOutstationRequestRowToPayrollApproval({
    employee_name: "Account Admin",
    id: 202,
    status: "approved",
    trip_start_date: "2026-01-31T22:00:00.000Z",
  });
  assert.equal(cairoBoundaryTrip.payoutMonth, 3, "2026-01-31 22:00 UTC is 2026-02-01 in Cairo — a February trip pays in March, not February");
  assert.equal(cairoBoundaryTrip.payoutYear, 2026);

  // The exact hardened fallback: trip_start_date is null, so the mapper reads created_at — a REAL
  // instant, not a stored UTC-midnight date. One stamped just after Cairo midnight on the 1st must
  // resolve on the Cairo day, the same as the trip case above. This is the path F-30 was about.
  const nullDateFallback = mapOutstationRequestRowToPayrollApproval({
    created_at: "2026-01-31T22:30:00.000Z",
    employee_name: "Account Admin",
    id: 203,
    status: "approved",
    trip_start_date: null,
  });
  assert.equal(nullDateFallback.payoutMonth, 3, "a null trip_start_date falls back to created_at, read on the Cairo day — March, not February");
  assert.equal(nullDateFallback.payoutYear, 2026);

  // December rolls the payout into January of the next year — the branch the anchor still owns.
  const decemberRollover = mapOutstationRequestRowToPayrollApproval({
    employee_name: "Account Admin",
    id: 204,
    status: "approved",
    trip_start_date: "2026-12-15T00:00:00.000Z",
  });
  assert.equal(decemberRollover.payoutMonth, 1, "a December trip pays in January");
  assert.equal(decemberRollover.payoutYear, 2027, "the January payout rolls into the next year");
}
