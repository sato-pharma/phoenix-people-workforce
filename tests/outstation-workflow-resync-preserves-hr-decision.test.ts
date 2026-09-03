import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { expenseDecisionsThatChanged } from "../src/lib/automated-payroll/expense-resync.ts";
import {
  resolveExpenseDecisionWrite,
  type StoredExpenseDecision,
} from "../src/lib/outstation/approval-state.ts";
import { mapOutstationRequestToPayrollExpenseRecord } from "../src/lib/outstation/payroll-expense-mapping.ts";
import { payableExpenseAmount } from "../src/lib/outstation/payable.ts";
import type { OutstationExpenseRequest } from "../src/lib/outstation/types.ts";

/**
 * A workflow re-push must never overwrite HR's decision on the payroll row.
 *
 * THE BUG. `mapOutstationRequestToPayrollExpenseRecord` returns `hrApproved: true`, `hr:
 * "Approved"`, `status: "Approved"` and NO `approvedAmount`. `savePayrollExpenseApprovals` upserts
 * that on `trip_id`, so `approved_amount` was written NULL — and `payableExpenseAmount` pays the
 * full `total` when `approved_amount` is null. Net effect: HR cuts a claim from 800 to 500 with a
 * written reason, then anything that re-syncs the request pushes it back to paying 800, and an HR
 * REJECTION on the payroll row is flipped back to Approved.
 *
 * The re-sync paths are `syncLinkedOutstationPayrollExpense` (reached from
 * `addExtraTicketsToOwnOutstationRequest`, i.e. the EMPLOYEE triggers it from the portal, and from
 * admin edits) and `pushAcceptedOutstationExpenseToPayroll`. Both refuse once the row is in a
 * payroll BATCH, so the window is "accepted and queued, not yet imported" — where every workflow
 * row in production sits.
 *
 * Latent, not live, when found (production ozucdzovmcqvepbozvqf, 2026-09-03): the 7 rows carrying
 * an `approved_amount` and the 16 rejected rows were all XLSX-imported, none a workflow
 * `OUTSTATION-%` row, so nothing had been overpaid yet. That is the reason this file is a
 * regression test rather than a repair script — and the reason it must stay.
 *
 * WHY IT IS SHAPED LIKE THIS. The suite has no module mocking, so the DB round-trip is the one
 * link these assertions cannot execute. Everything either side of it is real: the actual mapper
 * output for a re-priced request, fed through the actual resolver that now produces every decision
 * column the upsert writes. The two links that stay unexecuted — that the save routes its payload
 * through that resolver, and that the re-sync callers do not opt out of preservation — are pinned
 * against source at the bottom, because a correct resolver nothing calls is exactly the shape of
 * this bug.
 */

function readSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/**
 * A train trip that has already been accepted and pushed to payroll. Only the fields the mapper
 * reads are set; the request type carries ~90 more (route geometry, evidence gates, workload
 * capture) that no part of this path touches, and spelling them out would bury the two numbers
 * this test is about.
 */
function acceptedTrainTrip(overrides: Partial<OutstationExpenseRequest> = {}): OutstationExpenseRequest {
  return {
    allowanceAmount: 300,
    amWorkload: 4,
    approvalReason: "Accepted by the system.",
    capturedLatitude: 31.2001,
    capturedLongitude: 29.9187,
    claimedTotalAmount: 800,
    distanceFromResidenceKm: 220,
    employeeHrId: "C-77",
    employeeName: "Field Rep",
    expectedTotalAmount: 800,
    expenseType: "traveling",
    fuelAmount: 0,
    id: 4242,
    meetingAmount: 0,
    notes: "Alexandria cycle.",
    otherAmount: 0,
    pmWorkload: 5,
    residenceCity: "Cairo",
    ticketAmount: 500,
    toLabel: "Alexandria",
    transportationType: "train",
    tripEndDate: "2026-08-11T00:00:00.000Z",
    tripStartDate: "2026-08-10T00:00:00.000Z",
    workloadEvidenceSnapshot: {},
    ...overrides,
  } as unknown as OutstationExpenseRequest;
}

/** HR cut the 800 claim to 500 and then rejected the trip outright, with a reason for both. */
function hrReducedThenRejected(): StoredExpenseDecision {
  return {
    approvedAmount: 500,
    approvedAt: "2026-08-12T09:30:00.000Z",
    approvedBy: "B-10",
    hrApproved: false,
    hrComment: "Second ticket leg is not reimbursable; paying 500 of the 800 claimed.",
    hrStatus: "Rejected",
    status: "Rejected",
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    approvedAmount: 500 as number | null,
    hrApproved: false as boolean | null,
    hrId: "C-77",
    payoutMonth: 9,
    payoutYear: 2026,
    status: "Rejected" as string | null,
    total: 800 as number | null,
    tripId: "OUTSTATION-4242",
    ...overrides,
  };
}

export function runOutstationWorkflowResyncPreservesHrDecisionTests() {
  // -- HEADLINE ------------------------------------------------------------------------------
  // The employee adds an extra ticket worth 150, taking the claim from 800 to 950. The mapper
  // produces its usual hard-coded "Approved", and the save must still write back HR's own 500 and
  // HR's own rejection.
  const rePriced = acceptedTrainTrip({
    claimedTotalAmount: 950,
    expectedTotalAmount: 950,
    ticketAmount: 650,
  });
  const rePushed = mapOutstationRequestToPayrollExpenseRecord(rePriced, { reportId: "report-1" });

  assert.equal(rePushed.total, 950, "the re-push carries the employee's NEW claim");
  assert.equal(
    rePushed.preserveExistingDecision,
    true,
    "a workflow re-push defaults to preserving whatever HR already decided",
  );
  // Everything the bug wrote is still on the record — it is a default, not a decision, and the
  // resolver below is what stops it reaching the row.
  assert.equal(rePushed.hrApproved, true);
  assert.equal(rePushed.status, "Approved");
  assert.equal((rePushed as { approvedAmount?: number | null }).approvedAmount, undefined);

  const written = resolveExpenseDecisionWrite({
    approvedBy: "C-77",
    claimedTotal: rePushed.total,
    incoming: {
      approvedAmount: (rePushed as { approvedAmount?: number | null }).approvedAmount,
      hrApproved: rePushed.hrApproved,
      hrComment: rePushed.hrComment,
      hrStatus: rePushed.hr,
      status: rePushed.status,
    },
    now: "2026-08-20T12:00:00.000Z",
    preserveExistingDecision: rePushed.preserveExistingDecision,
    stored: hrReducedThenRejected(),
  });

  assert.equal(
    written.approvedAmount,
    500,
    "HEADLINE: HR's reduced figure survives an extra-ticket re-sync — writing null here is what puts payroll back on the full claim",
  );
  assert.equal(
    written.hrApproved,
    false,
    "HEADLINE: an HR rejection is not flipped back to approved by a re-sync",
  );
  assert.equal(written.status, "Rejected", "the rejection literal survives verbatim");
  assert.equal(written.hrStatus, "Rejected");
  assert.match(
    written.hrComment,
    /not reimbursable/,
    "the written reason for the reduction survives — a deduction with no reason is not defensible",
  );
  assert.equal(
    written.approvedBy,
    "B-10",
    "credit stays with the HR user who decided, not the employee re-syncing",
  );
  assert.equal(written.approvedAt, "2026-08-12T09:30:00.000Z", "the decision keeps its own timestamp");
  assert.equal(
    written.decidesApproval,
    false,
    "a carry-forward decides nothing, so it must not demand the HR Manager rights the approvals screen needs — this is what lets an employee add a ticket to their own accepted trip",
  );
  assert.equal(
    payableExpenseAmount(written.approvedAmount, 950),
    500,
    "and the money that follows from it: 500, not the 950 now claimed",
  );

  // -- First push: nothing stored, so the workflow default IS the decision ---------------------
  const firstPush = mapOutstationRequestToPayrollExpenseRecord(acceptedTrainTrip(), {});
  const created = resolveExpenseDecisionWrite({
    approvedBy: "SYSTEM",
    claimedTotal: firstPush.total,
    incoming: {
      approvedAmount: undefined,
      hrApproved: firstPush.hrApproved,
      hrComment: firstPush.hrComment,
      hrStatus: firstPush.hr,
      status: firstPush.status,
    },
    now: "2026-08-11T08:00:00.000Z",
    preserveExistingDecision: firstPush.preserveExistingDecision,
    stored: null,
  });
  assert.equal(created.hrApproved, true, "an accepted trip reaching payroll for the first time is approved");
  assert.equal(created.status, "Approved");
  assert.equal(created.approvedAmount, null, "nobody has adjusted it, so the claim stands");
  assert.equal(created.approvedAt, "2026-08-11T08:00:00.000Z");
  assert.equal(created.approvedBy, "SYSTEM");
  assert.equal(
    created.decidesApproval,
    true,
    "creating an approved row IS an approval, and stays behind the manual-approval gate",
  );

  // -- The one caller that IS deciding overwrites, which is the whole point of that path -------
  const hrDecided = mapOutstationRequestToPayrollExpenseRecord(acceptedTrainTrip(), {
    hrComment: "Paying 600 of 800: one leg unsupported.",
    preserveExistingDecision: false,
  });
  const overwritten = resolveExpenseDecisionWrite({
    approvedBy: "B-10",
    claimedTotal: 800,
    incoming: {
      approvedAmount: 600,
      hrApproved: hrDecided.hrApproved,
      hrComment: hrDecided.hrComment,
      hrStatus: hrDecided.hr,
      status: hrDecided.status,
    },
    now: "2026-08-13T10:00:00.000Z",
    preserveExistingDecision: hrDecided.preserveExistingDecision,
    stored: hrReducedThenRejected(),
  });
  assert.equal(hrDecided.preserveExistingDecision, false, "an explicit HR decision opts out of preservation");
  assert.equal(overwritten.approvedAmount, 600, "HR's newly typed figure replaces the stored one");
  assert.equal(overwritten.hrApproved, true, "and re-approves a trip they had rejected, deliberately");
  assert.equal(overwritten.decidesApproval, true, "so the manual-approval gate applies to it");

  // -- The XLSX approvals screen is untouched: no flag, so the record is the decision ----------
  const sheetSave = resolveExpenseDecisionWrite({
    approvedBy: "B-10",
    claimedTotal: 800,
    incoming: {
      approvedAmount: 500,
      hrApproved: true,
      hrComment: "Reduced.",
      hrStatus: "Approved",
      status: "Approved",
    },
    now: "2026-08-13T10:00:00.000Z",
    stored: hrReducedThenRejected(),
  });
  assert.equal(sheetSave.approvedAmount, 500);
  assert.equal(sheetSave.hrApproved, true, "without the flag the incoming decision wins, exactly as before");
  assert.equal(sheetSave.status, "Approved");

  // A save that leaves the claim alone still stores null, so "never adjusted" stays
  // distinguishable from "approved at exactly the claim".
  assert.equal(
    resolveExpenseDecisionWrite({
      approvedBy: "B-10",
      claimedTotal: 800,
      incoming: {
        approvedAmount: 800,
        hrApproved: true,
        hrComment: "",
        hrStatus: "Approved",
        status: "Approved",
      },
      now: "2026-08-13T10:00:00.000Z",
      stored: null,
    }).approvedAmount,
    null,
  );

  // -- A re-price under a stored reduction has to reach HR ------------------------------------
  // Keeping the reduction is the deliberate answer; the claim moving underneath it is what HR has
  // to be told about, and re-opening the payroll Expenses step is the mechanism that already
  // exists for saying so.
  const rePricedTarget = expenseDecisionsThatChanged([snapshot()], [snapshot({ total: 950 })]);
  assert.deepEqual(
    rePricedTarget.hrIds,
    ["C-77"],
    "a claim that moves while HR's adjusted figure stays put must still re-open the payroll step — the payable amount did not move, so nothing else here would have caught it",
  );
  assert.deepEqual(rePricedTarget.periods, [{ month: 9, year: 2026 }]);

  // The same claim move on an UNADJUSTED row was already covered, because there the payable
  // amount IS the claim. Guarded so the new clause is not silently doing that job twice.
  const unadjusted = expenseDecisionsThatChanged(
    [snapshot({ approvedAmount: null })],
    [snapshot({ approvedAmount: null, total: 950 })],
  );
  assert.deepEqual(unadjusted.hrIds, ["C-77"]);

  // And a re-push that genuinely changes nothing must stay quiet, or every extra-ticket upload
  // re-opens a confirmed payroll step for no reason.
  const unchanged = expenseDecisionsThatChanged([snapshot()], [snapshot()]);
  assert.deepEqual(unchanged.hrIds, [], "an identical re-push targets nobody");
  assert.deepEqual(unchanged.periods, []);

  // -- Wiring: the DB round-trip these assertions cannot execute -------------------------------
  const expenses = readSource("../src/lib/outstation/expenses.ts");

  const payload = expenses.match(/const payload = input\.records\.map\([\s\S]*?\n {2}\}\);/)?.[0];
  assert.ok(payload, "savePayrollExpenseApprovals must still build its upsert payload from input.records");
  for (const [column, source] of [
    ["approved_amount", "decision.approvedAmount"],
    ["approved_at", "decision.approvedAt"],
    ["approved_by", "decision.approvedBy"],
    ["hr_approved", "decision.hrApproved"],
    ["hr_comment", "decision.hrComment"],
    ["hr_status", "decision.hrStatus"],
    ["status", "decision.status"],
  ] as const) {
    assert.ok(
      payload.includes(`${column}: ${source},`),
      `the upsert's ${column} must come from the resolved decision, not straight off the record — reading the record is the bug`,
    );
  }

  assert.match(
    expenses,
    /resolveExpenseDecisionWrite\(\{[\s\S]*?stored: storedByTripId\.get\(/,
    "the resolver must be given what is already stored, or it can only ever produce the incoming decision",
  );
  assert.match(
    expenses,
    /const hasManualPayrollApprovals = decisions\.some\(\(decision\) => decision\.decidesApproval\)/,
    "the manual-approval gate must key on what the save decides, not on what the records carry",
  );
  assert.match(
    expenses,
    /EXPENSE_CARRY_FORWARD_COLUMNS =\s*[\s\S]{0,40}approved_at,approved_by,hr_comment,hr_status/,
    "the carry-forward read must fetch the reason and the approver too, not just the amount",
  );

  const service = readSource("../src/lib/outstation/service.ts");
  const optOuts = service.match(/preserveExistingDecision:\s*false/g) ?? [];
  assert.equal(
    optOuts.length,
    1,
    "exactly one outstation caller may opt out of preservation — writeOutstationRequestPayableAmount, which carries HR's own typed figure",
  );
  // Sliced to `return true`, not to the first `\n}` — that one closes the parameter type, so the
  // shorter match would end before the mapper call this is here to check.
  const payableWriter = service.match(
    /async function writeOutstationRequestPayableAmount\([\s\S]*?return true;/,
  )?.[0];
  assert.ok(payableWriter, "writeOutstationRequestPayableAmount must still exist");
  assert.match(
    payableWriter,
    /preserveExistingDecision:\s*false/,
    "and it must be the caller holding that opt-out",
  );

  const mapping = readSource("../src/lib/outstation/payroll-expense-mapping.ts");
  assert.match(
    mapping,
    /preserveExistingDecision:\s*options\.preserveExistingDecision \?\? true/,
    "the mapper must default to preserving; a default of false restores the overwrite for every re-sync path at once",
  );
}
