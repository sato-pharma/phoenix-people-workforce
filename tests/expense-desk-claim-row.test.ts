/**
 * Expense Approvals, rebuilt 2026-11-23 — ONE CLAIM ROW, pinned.
 *
 *   1. The desk never reads `select("*")`, and every column the ONE payroll mapper reads is in the
 *      list — a column dropped from the list would silently price a claim wrong on the desk.
 *   2. A waiting claim: its figures come from that mapper, its reason box opens EMPTY with the
 *      system's sentence kept beside it, and an idle day with an allowance puts the cut on Approve.
 *   3. 🔴 A decided claim reads its STORED payroll row: the amount he typed is never replaced by
 *      the claim's total, and the stored total wins over a re-derived one.
 *   4. A rejected claim pays nothing; a claim a payroll took is locked.
 *   5. "Held" is read BEFORE the press, from the payroll gate itself: a missing departure photo
 *      holds, a National Sales Manager is never held, a pre-rule claim is exempt.
 *   6. A claim decided before the rebuild says its checks were not kept — nothing is made up.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildDeskClaim,
  claimFactsFromRow,
  claimInWords,
  daysBetween,
  DECIDED_CLAIM_COLUMNS,
  DESK_CLAIM_COLUMNS,
  holdReasonOfRow,
  LEDGER_COLUMNS,
  receiptPrintsOfRow,
  storedVerdictOfRow,
  tripDatesOfRow,
  type ClaimRow,
  type LedgerRow,
} from "@/lib/outstation/approvals/claim-row";
import type { FieldWorkReading } from "@/lib/outstation/approvals/checks";
import { mapOutstationRequestRowToPayrollApproval } from "@/lib/outstation/payroll-expense-mapping";

const NOW = new Date("2026-11-23T08:00:00.000Z");
const TODAY = "2026-11-23";

/** A District Manager's two-day car trip to Asyut, 9–10 Nov, still waiting. */
function row(over: ClaimRow = {}): ClaimRow {
  return {
    allowance_amount: 300,
    approval_reason: "No field activity on 10 Nov.",
    car_evidence_image_path: "evidence/412-arrival.jpg",
    car_evidence_metadata: { capturedAt: "2026-11-09T07:00:00.000Z", capturedLatitude: 27.18, capturedLongitude: 31.18, source: "camera" },
    created_at: "2026-11-10T08:00:00.000Z",
    departure_evidence_image_path: "evidence/412-departure.jpg",
    departure_evidence_metadata: {
      capturedAt: "2026-11-10T14:00:00.000Z",
      capturedLatitude: 27.18,
      capturedLongitude: 31.18,
      distanceFromArrivalKm: 0.4,
      flags: [],
      minutesAfterArrival: 1860,
    },
    eligibility_status: "eligible",
    employee_hr_id: "PD-0015",
    employee_name: "Stored Name",
    employee_role: "District Manager",
    evidence_gate_status: "complete",
    expected_total_amount: 900,
    expense_type: "traveling",
    fuel_amount: 600,
    id: 412,
    notes: "",
    residence_address: "Minya",
    status: "submitted",
    to_label: "Asyut 2",
    transportation_type: "car",
    trip_end_date: "2026-11-10",
    trip_start_date: "2026-11-09",
    updated_at: "2026-11-10T08:05:00.000Z",
    workload_gate_status: "complete",
    ...over,
  };
}

const worked = (visits: number) => ({ atDestination: visits > 0, beforePhoenix: false, meetings: 0, positioned: visits > 0, visits });
const fieldWork = (second: number): FieldWorkReading => ({
  days: [{ date: "2026-11-09", ...worked(5) }, { date: "2026-11-10", ...worked(second) }],
  homeDays: [],
  km: null,
});

const ledger = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  approved_amount: null,
  approved_at: "2026-11-12T09:00:00.000Z",
  imported_payroll_batch_id: null,
  imported_to_payroll_at: null,
  payout_month: 11,
  payout_year: 2026,
  total: 900,
  trip_id: "OUTSTATION-412",
  ...over,
});

export function runExpenseDeskClaimRowTests() {
  // 1. The columns.
  const desk = DESK_CLAIM_COLUMNS.split(", ");
  assert.ok(!DESK_CLAIM_COLUMNS.includes("*") && !DECIDED_CLAIM_COLUMNS.includes("*") && !LEDGER_COLUMNS.includes("*"));
  assert.equal(new Set(desk).size, desk.length, "no column is listed twice");
  const mapperSource = fs.readFileSync("src/lib/outstation/payroll-expense-mapping.ts", "utf8");
  const mapperBody = mapperSource.slice(mapperSource.indexOf("export function mapOutstationRequestRowToPayrollApproval"));
  const mapperReads = [...new Set([...mapperBody.matchAll(/\brow\.([a-z_]+)\b/g)].map((match) => match[1]))];
  assert.ok(mapperReads.length > 30, "the mapper's own reads were found");
  assert.deepEqual(
    mapperReads.filter((column) => !desk.includes(column)),
    [],
    "every column the payroll mapper reads must be in DESK_CLAIM_COLUMNS, or the desk prices the claim without it",
  );
  for (const column of DECIDED_CLAIM_COLUMNS.split(", ")) {
    // A path read (`alias:column->key`, the two odometer readings) takes one key of a column the desk reads whole.
    const source = column.includes(":") ? column.slice(column.indexOf(":") + 1).split("->")[0] : column;
    assert.ok(desk.includes(source), `${column} is read for a decided claim only`);
  }
  for (const column of ["workload_gate_status", "evidence_gate_status", "system_lane_at_decision", "system_verdict_at_decision"]) {
    assert.ok(desk.includes(column));
  }

  assert.deepEqual(tripDatesOfRow(row()), ["2026-11-09", "2026-11-10"]);
  assert.deepEqual(tripDatesOfRow(row({ trip_end_date: null })), ["2026-11-09"]);
  assert.equal(tripDatesOfRow(row({ trip_end_date: "2028-01-01" })).length, 31, "a bad end date never builds a year of days");
  assert.deepEqual(tripDatesOfRow(row({ trip_start_date: null })), []);

  // 2. A waiting claim.
  const mapped = mapOutstationRequestRowToPayrollApproval(row());
  const waiting = buildDeskClaim({ context: { fieldWork: fieldWork(0), today: TODAY }, ledger: null, now: NOW, row: row() });
  assert.equal(waiting.standing, "waiting");
  assert.equal(waiting.total, mapped.total, "the desk's total is the payroll mapper's total, not its own sum");
  assert.equal(waiting.payable, mapped.total);
  assert.equal(waiting.approvedAmount, null);
  assert.equal(waiting.revision, "2026-11-10T08:05:00.000Z");
  assert.equal(waiting.tripId, "OUTSTATION-412");
  assert.equal(waiting.daysWaiting, 13);
  assert.equal(waiting.hrComment, "", "the reason box opens empty");
  assert.equal(waiting.systemNote, "No field activity on 10 Nov.", "the system's sentence is a one-press insert, never a pre-filled reason");
  assert.equal(waiting.verdict.lane, "your_call");
  assert.deepEqual(waiting.verdict.idleDates, ["2026-11-10"]);
  assert.deepEqual(waiting.preCut && { deduction: waiting.preCut.deduction, payable: waiting.preCut.payable }, {
    deduction: 150,
    payable: Math.round((mapped.total - 150) * 100) / 100,
  });
  assert.equal(waiting.holdReason, null);
  assert.equal(waiting.locked, false);

  const ready = buildDeskClaim({ context: { fieldWork: fieldWork(3), today: TODAY }, ledger: null, now: NOW, row: row() });
  assert.equal(ready.verdict.lane, "ready");
  assert.equal(ready.preCut, null, "no idle day, no cut");
  // A pending payroll row left under a waiting claim decides nothing.
  const shadowed = buildDeskClaim({ context: { fieldWork: fieldWork(3), today: TODAY }, ledger: ledger({ approved_amount: 10, total: 10 }), now: NOW, row: row() });
  assert.equal(shadowed.standing, "waiting");
  assert.equal(shadowed.total, mapped.total);
  assert.equal(shadowed.approvedAmount, null);
  // Phoenix CRM not read at all (undefined) reads as "could not check", exactly like a failed read.
  assert.equal(buildDeskClaim({ context: { today: TODAY }, ledger: null, now: NOW, row: row() }).verdict.lane, "your_call");

  // 3. A decided claim reads its stored payroll row.
  const accepted = row({ status: "accepted_by_admin", updated_at: "2026-11-12T09:00:00.000Z" });
  const reduced = buildDeskClaim({ context: { today: TODAY }, ledger: ledger({ approved_amount: 500, total: 880 }), now: NOW, row: accepted });
  assert.equal(reduced.standing, "approved_queued");
  assert.equal(reduced.approvedAmount, 500);
  assert.equal(reduced.payable, 500, "the amount he typed is what the trip pays — never the claim's total");
  assert.equal(reduced.total, 880, "the stored row's total is the truth of a decided claim");
  assert.equal(reduced.preCut, null);
  assert.equal(reduced.systemNote, null);
  assert.equal(reduced.hrComment, "No field activity on 10 Nov.");
  assert.equal(reduced.decidedAt, "2026-11-12T09:00:00.000Z");
  assert.equal(reduced.daysWaiting, 0);
  assert.equal(reduced.holdReason, null, "held-before-press is a waiting claim's question only");

  const held = buildDeskClaim({ context: { today: TODAY }, ledger: null, now: NOW, row: accepted });
  assert.equal(held.standing, "approved_held");
  assert.equal(held.payable, mapped.total, "a held claim has no payroll row yet, so it pays its own claim");

  // 4. Rejected pays nothing; in payroll is locked.
  const rejected = buildDeskClaim({ context: { today: TODAY }, ledger: null, now: NOW, row: row({ status: "rejected_by_admin" }) });
  assert.equal(rejected.standing, "rejected");
  assert.equal(rejected.payable, 0);
  const paid = buildDeskClaim({ context: { today: TODAY }, ledger: ledger({ imported_payroll_batch_id: "batch-1" }), now: NOW, row: accepted });
  assert.equal(paid.standing, "in_payroll");
  assert.equal(paid.locked, true);
  assert.equal(reduced.locked, false);

  // 5. Held, read before the press.
  assert.equal(holdReasonOfRow(row()), null);
  assert.match(
    holdReasonOfRow(row({ departure_evidence_image_path: null, evidence_gate_status: "pending_departure_photo" })) ?? "",
    /departure photo/,
  );
  assert.match(holdReasonOfRow(row({ workload_gate_status: "pending_workload" })) ?? "", /workload/);
  assert.equal(
    holdReasonOfRow(row({ car_evidence_image_path: null, employee_role: "National Sales Manager", workload_gate_status: "pending_workload" })),
    null,
    "a National Sales Manager is never held",
  );
  assert.equal(holdReasonOfRow(row({ car_evidence_image_path: null, departure_evidence_image_path: null, evidence_gate_status: "grandfathered" })), null);
  assert.equal(holdReasonOfRow(row({ evidence_gate_status: null, workload_gate_status: null })), null, "an unstamped row is a pre-gate one, as the service reads it");
  const willHold = buildDeskClaim({
    context: { fieldWork: fieldWork(3), today: TODAY },
    ledger: null,
    now: NOW,
    row: row({ departure_evidence_image_path: null, evidence_gate_status: "pending_departure_photo" }),
  });
  assert.match(willHold.holdReason ?? "", /departure photo/);

  // 6. The verdict of a decided claim.
  assert.deepEqual(storedVerdictOfRow(accepted), { checks: [], idleDates: [], lane: "your_call", reason: "Decided before the checks were kept." });
  const kept = storedVerdictOfRow(
    row({
      system_lane_at_decision: "ready",
      system_verdict_at_decision: { checks: [{ answer: "pass", key: "field_work", label: "Field work", sentence: "Worked the day: 4 visits." }], reason: null },
    }),
  );
  assert.equal(kept.lane, "ready");
  assert.equal(kept.checks.length, 1);
  assert.equal(kept.reason, null);

  // The stored facts the checks read.
  const stored = claimFactsFromRow(
    row({
      car_evidence_metadata: { fileTakenAt: "2026-11-09T06:00:00.000Z", source: "upload" },
      meeting_invoice_path: "invoice.pdf",
      ticket_attachment_metadata: [{ name: "go.jpg", size: 1200 }, { name: "back.jpg", size: 900 }],
    }),
    { today: TODAY },
  );
  assert.equal(stored.arrival.uploaded, true);
  assert.equal(stored.arrival.fileTakenOn, "2026-11-09");
  assert.equal(stored.arrival.hasPosition, false);
  assert.equal(stored.departure.hasPosition, true);
  assert.equal(stored.departure.kmFromArrival, 0.4);
  assert.equal(stored.attachments, 3);
  assert.equal(stored.fieldWork, null);
  assert.equal(stored.noTicketFareLine, null);
  assert.equal(claimFactsFromRow(row({ no_ticket_fare: { line: " Cairo → Asyut · EGP 420 there and back " } }), { today: TODAY }).noTicketFareLine, "Cairo → Asyut · EGP 420 there and back", "the stored fare's own line reaches the ticket check");
  // What the old system's record is read against, for a trip from before Phoenix CRM.
  assert.deepEqual(
    buildDeskClaim({ context: { today: TODAY }, ledger: null, now: NOW, row: row({ am_workload: 2, pharmacy_workload: 1, pm_workload: 5, workload_match_status: "matched" }) }).declaredWorkload,
    { am: 2, matchStatus: "matched", pharmacies: 1, pm: 5 },
    "HEADLINE: the claim carries the declared visits and the verdict stamped at submission",
  );
  assert.equal(receiptPrintsOfRow(row({ ticket_attachment_metadata: [{ name: "go.jpg", size: 1200 }] })).length, 1);

  assert.equal(claimInWords(row(), "approved"), "the approved claim of 9 Nov");
  assert.equal(daysBetween("2026-11-22T09:00:00.000Z", NOW), 0);
  assert.equal(daysBetween(null, NOW), 0);
}
