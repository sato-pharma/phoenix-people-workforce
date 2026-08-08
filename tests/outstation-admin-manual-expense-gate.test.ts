import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveOutstationGateState } from "../src/lib/outstation/expense-gate.ts";
import type { OutstationEvidenceGateStatus } from "../src/lib/outstation/types.ts";

// The two-photo gate (#1707, 2026-08-04) gave outstation_expense_requests.evidence_gate_status a
// deliberately fail-closed default of 'pending_arrival_photo', so a row that skips the submit path
// can never sneak past the gate. createManagerExpenseAsAdmin is exactly such a path — an admin
// types a trip in on behalf of an employee who never opened the app — and it was never taught
// about the gate, so every manual expense silently inherited that default and was frozen out of
// payroll with no possible remedy: there is no photo to recover and no employee who failed to take
// one. Nine requests worth 6,587.56 EGP piled up between 2026-08-05 and 2026-08-08, each one
// logging "Waiting for the arrival photo. Capture it in the app at your destination" at somebody
// who had no request to photograph.
//
// This pins the WIRING rather than the resolver: the resolver was correct and green throughout —
// it held the rows exactly as designed. The defect was a write path that never stated its intent.

const SERVICE = join(process.cwd(), "src/lib/outstation/service.ts");

/** The body of one top-level exported function, from its signature to the next one. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in service.ts — this test is pinned to it by name`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

/**
 * Every write path that creates a request WITHOUT a photo step. Both must declare their gate.
 *
 * The admin path is the one that actually froze 6,587.56 EGP. The medical-rep path is the same
 * defect that had simply never been triggered — no medical rep had submitted through it yet — and
 * it is in this list precisely so it cannot be fixed once and quietly reintroduced next to it.
 */
const PHOTOLESS_WRITE_PATHS = [
  {
    fn: "createManagerExpenseAsAdmin",
    why: "an admin types this trip in for an employee who never opened the app",
  },
  {
    fn: "submitMedicalRepSimpleExpenseRequest",
    why: "the medical rep simple flow files a ticket amount and attachments, never a live capture",
  },
] as const;

export function runOutstationAdminManualExpenseGateTests() {
  const service = readFileSync(SERVICE, "utf8");

  for (const path of PHOTOLESS_WRITE_PATHS) {
    const body = functionBody(service, path.fn);

    // ── The write path states its gate, rather than inheriting one ────────────
    const match = body.match(/evidence_gate_status:\s*"([a-z_]+)"/);
    assert.ok(
      match,
      `${path.fn} must set evidence_gate_status EXPLICITLY on insert — ${path.why}, so omitting it takes the column's fail-closed default and freezes the expense out of payroll forever`,
    );

    const gateStatus = match![1] as OutstationEvidenceGateStatus;

    // ── And the value it states actually releases a photo-less row ────────────
    // Asserted through the real resolver, never by comparing strings: this is the thing that
    // decides whether money moves, and a value that merely LOOKS settled ('complete') is held as
    // inconsistent because the resolver checks the photos themselves before it trusts the column.
    const gate = resolveOutstationGateState({
      evidenceGateStatus: gateStatus,
      hasArrivalPhoto: false,
      hasDeparturePhoto: false,
      workloadGateStatus: "pending_workload",
    });

    assert.equal(
      gate.blocker,
      null,
      `${path.fn} carries no photo by design, so evidence_gate_status "${gateStatus}" must leave it unblocked — it resolved to "${gate.blocker}" instead, which is the original defect`,
    );
    assert.equal(
      gate.isPayrollEligible,
      true,
      `evidence_gate_status "${gateStatus}" must let a photo-less request from ${path.fn} reach payroll — anything else strands real money with no way for anyone to clear it`,
    );
  }

  // ── The workload repair must not claim a release it cannot see ──────────────
  // retryOutstationWorkloadCapture used to derive `released` from the workload gate moving off
  // pending, which is a different question from "did a payroll row appear". It reported success
  // for all nine repaired requests before any of them had reached payroll.
  const retry = functionBody(service, "retryOutstationWorkloadCapture");
  assert.ok(
    !/const released = Boolean\(after && after\.workloadGateStatus !== "pending_workload"\)/.test(retry),
    "retryOutstationWorkloadCapture must not report `released` from the workload gate — a cleared gate is not a payroll row, and reporting one as the other tells the caller money moved when it did not",
  );
  assert.ok(
    /getLinkedOutstationPayrollExpense/.test(retry),
    "retryOutstationWorkloadCapture must read `released` from the linked payroll expense — the thing that actually had to happen",
  );

  // ── The employee submit path keeps its own, opposite guarantee ──────────────
  // Guards against "fixing" this by loosening the gate everywhere. A real submission has a photo
  // and must still be held until the second one lands.
  assert.equal(
    resolveOutstationGateState({
      evidenceGateStatus: "pending_departure_photo",
      hasArrivalPhoto: true,
      hasDeparturePhoto: false,
      workloadGateStatus: "pending_workload",
    }).blocker,
    "departure_photo",
    "an app-submitted request must still be held for its departure photo — this fix is scoped to the path that has no photo step at all",
  );

  // A photo-less row that is NOT grandfathered must stay blocked, so the default keeps protecting
  // every other write path that forgets to declare itself.
  assert.equal(
    resolveOutstationGateState({
      evidenceGateStatus: "pending_arrival_photo",
      hasArrivalPhoto: false,
      hasDeparturePhoto: false,
      workloadGateStatus: "pending_workload",
    }).isPayrollEligible,
    false,
    "the fail-closed default must still fail closed — the fix is that the admin path declares itself, not that the gate got weaker",
  );
}
