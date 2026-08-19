import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isOutstationExpenseInPayroll,
  nextEvidenceGateStatus,
  outstationRequestMayReachPayroll,
  resolveOutstationGateState,
} from "../src/lib/outstation/expense-gate.ts";

/**
 * Owner rule (2026-08-04): an outstation request reaches payroll only once it carries an ARRIVAL
 * photo, a DEPARTURE photo, AND a captured AM/PM workload. This is the gate that decides whether
 * real money moves, so every path below asserts the payroll verdict explicitly rather than
 * inferring it from the blocker.
 */
export function runOutstationExpenseGateTests() {
  const complete = {
    employeeRole: "District Manager",
    evidenceGateStatus: "complete",
    hasArrivalPhoto: true,
    hasDeparturePhoto: true,
    workloadGateStatus: "complete",
  } as const;

  // ── The happy path is the ONLY path that pays ───────────────────────────────────
  const ready = resolveOutstationGateState(complete);
  assert.equal(ready.blocker, null, "a fully evidenced request is waiting for nothing");
  assert.equal(ready.isPayrollEligible, true, "…and is the one shape that may reach payroll");

  // ── Each missing checkpoint blocks, and names itself ────────────────────────────
  const noArrivalInput = {
    ...complete,
    evidenceGateStatus: "pending_arrival_photo",
    hasArrivalPhoto: false,
    hasDeparturePhoto: false,
  } as const;
  const noArrival = resolveOutstationGateState(noArrivalInput);
  assert.equal(noArrival.blocker, "arrival_photo", "no arrival photo blocks on the arrival photo");
  assert.equal(noArrival.isPayrollEligible, false, "and must never reach payroll");

  const noDepartureInput = {
    ...complete,
    evidenceGateStatus: "pending_departure_photo",
    hasDeparturePhoto: false,
  } as const;
  const noDeparture = resolveOutstationGateState(noDepartureInput);
  assert.equal(noDeparture.blocker, "departure_photo", "the departure photo is the next checkpoint");
  assert.equal(noDeparture.isPayrollEligible, false, "one photo is not two — this does not pay");

  const noWorkloadInput = { ...complete, workloadGateStatus: "pending_workload" } as const;
  const noWorkload = resolveOutstationGateState(noWorkloadInput);
  assert.equal(noWorkload.blocker, "workload", "both photos in hand, still waiting on the CRM workload");
  assert.equal(
    noWorkload.isPayrollEligible,
    false,
    "two photos alone do not pay — the workload is the third checkpoint, not a nice-to-have",
  );

  // ── A hand-entered workload still pays, but says it was hand-entered ────────────
  const manualWorkload = resolveOutstationGateState({ ...complete, workloadGateStatus: "manual" });
  assert.equal(manualWorkload.isPayrollEligible, true, "an admin's manual workload unblocks payroll");
  assert.match(
    manualWorkload.message,
    /by hand/i,
    "a manual workload must never be described as matched from the CRM — that is the whole point of the separate state",
  );

  // ── The status column is not trusted on its own ─────────────────────────────────
  // A row claiming completeness without the photos to back it is corrupt, not complete.
  const lyingStatusInput = {
    employeeRole: "District Manager",
    evidenceGateStatus: "complete",
    hasArrivalPhoto: true,
    hasDeparturePhoto: false,
    workloadGateStatus: "complete",
  } as const;
  const lyingStatus = resolveOutstationGateState(lyingStatusInput);
  assert.equal(
    lyingStatus.isPayrollEligible,
    false,
    "a 'complete' evidence gate with no departure photo must NOT pay — one bad write cannot bypass the gate",
  );
  assert.equal(lyingStatus.blocker, "departure_photo", "and the real missing thing is named");

  const staleStatusInput = {
    employeeRole: "District Manager",
    evidenceGateStatus: "pending_departure_photo",
    hasArrivalPhoto: true,
    hasDeparturePhoto: true,
    workloadGateStatus: "complete",
  } as const;
  const staleStatus = resolveOutstationGateState(staleStatusInput);
  assert.equal(
    staleStatus.isPayrollEligible,
    false,
    "photos present but the gate status disagrees — held as a data fault rather than quietly paid",
  );
  assert.equal(staleStatus.blocker, "inconsistent", "and it is reported as inconsistent, not as a missing photo");
  assert.match(staleStatus.message, /system administrator/i, "the message must route it to someone who can fix it");

  // ── Pre-rule requests are exempt, never blocked ─────────────────────────────────
  // The 12 requests that existed on 2026-08-04 are already decided and several are already paid.
  // Their trips are over and can never be photographed, so the gate must not reach back for them.
  const legacyInput = {
    employeeRole: "District Manager",
    evidenceGateStatus: "grandfathered",
    hasArrivalPhoto: false,
    hasDeparturePhoto: false,
    workloadGateStatus: "grandfathered",
  } as const;
  const legacy = resolveOutstationGateState(legacyInput);
  assert.equal(legacy.blocker, null, "a pre-rule request is not waiting for a photo it can never take");
  assert.equal(legacy.isPayrollEligible, true, "and must not be pulled back out of payroll by the new gate");
  assert.doesNotMatch(
    legacy.message,
    /^Complete/,
    "exempt must not read as 'complete' — an un-photographable July trip is not evidenced",
  );

  // ── The convenience wrapper cannot drift from the resolver ──────────────────────
  const everyScenario = [
    complete,
    noArrivalInput,
    noDepartureInput,
    noWorkloadInput,
    lyingStatusInput,
    staleStatusInput,
    legacyInput,
  ];
  for (const scenario of everyScenario) {
    assert.equal(
      outstationRequestMayReachPayroll(scenario),
      resolveOutstationGateState(scenario).isPayrollEligible,
      "the shorthand must always agree with the full resolver — two copies of a payroll gate drift apart",
    );
  }

  // ── The write path agrees with the read path about what "complete" means ────────
  assert.equal(
    nextEvidenceGateStatus({ hasArrivalPhoto: false, hasDeparturePhoto: false }),
    "pending_arrival_photo",
  );
  assert.equal(
    nextEvidenceGateStatus({ hasArrivalPhoto: true, hasDeparturePhoto: false }),
    "pending_departure_photo",
  );
  assert.equal(
    nextEvidenceGateStatus({ hasArrivalPhoto: true, hasDeparturePhoto: true }),
    "complete",
    "only both photos produce 'complete' — the status the resolver above demands before it will pay",
  );
  // A departure photo without an arrival photo is not a shortcut to complete.
  assert.equal(
    nextEvidenceGateStatus({ hasArrivalPhoto: false, hasDeparturePhoto: true }),
    "pending_arrival_photo",
    "a departure photo alone must not satisfy the arrival checkpoint",
  );

  // ── The gate must actually be WIRED to the money ────────────────────────────────
  // The assertions above prove the rule is right; these prove it is applied. A correct gate that
  // nothing calls is the exact shape this feature had before the wiring commit — every rule in
  // place, describing the truth, enforcing nothing.
  //
  // Source inspection, deliberately: approveOutstationRequestForPayroll needs Supabase, so the
  // alternative is no coverage at all on the one branch that decides whether money moves.
  const service = readFileSync(
    new URL("../src/lib/outstation/service.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    service,
    /const payrollExpenseRows = gate\.isPayrollEligible\s*\?\s*await pushAcceptedOutstationExpenseToPayroll\([\s\S]*?:\s*\[\];/,
    "the payroll push must be CONDITIONAL on the gate — an unconditional push is the whole bug this feature exists to prevent",
  );
  assert.match(
    service,
    /export async function releaseOutstationRequestToPayrollIfReady/,
    "a held request needs a release path, or gating it strands the payment forever — strictly worse than not gating",
  );
  // The release must re-derive the verdict rather than trust its caller: it runs from more than
  // one trigger, and a caller that "knows" the gate is clear is how a hold gets bypassed.
  const releaseSlice = service.slice(
    service.indexOf("export async function releaseOutstationRequestToPayrollIfReady"),
  );
  assert.match(
    releaseSlice.slice(0, 2500),
    /resolveOutstationGateState\(/,
    "the release path must re-resolve the gate itself, never accept a caller's word that it is satisfied",
  );
  assert.match(
    releaseSlice.slice(0, 2500),
    /getLinkedOutstationPayrollExpense/,
    "and must refuse to push a request that is already in payroll, or a retry pays the same trip twice",
  );
  // …but LOOKING UP the linked row is not the same as reading it correctly, which is why the
  // assertion above passed for months while the release was broken. The row exists as soon as the
  // claim is QUEUED; only a batch id or an import timestamp means it was actually paid.
  assert.doesNotMatch(
    releaseSlice.slice(0, 2500),
    /if \(linked\) \{/,
    "the release gate must not test the expense ROW's existence — a queued row is not a paid one, " +
      "and that reading answered 'already in payroll' for all 360 production rows, stranding every held claim",
  );
  assert.match(
    releaseSlice.slice(0, 2500),
    /isOutstationExpenseInPayroll\(linked\)/,
    "it must ask the shared predicate, so this reading and the five others in service.ts cannot drift apart",
  );

  // ── A held request must always be REACHABLE by the person who can clear it ──────
  // The gate withholds money, so the surface that lets an employee clear it is load-bearing.
  // Caught before merge: the insert left evidence_gate_status at its column default
  // ('pending_arrival_photo') while the portal card selected `= 'pending_departure_photo'`. The
  // gate would have held every new request out of payroll while its owner was never shown the
  // card to fix it — silent, and unrecoverable except by hand.
  assert.match(
    service,
    /evidence_gate_status: nextEvidenceGateStatus\(\{/,
    "the submit insert must SET the gate status from the photos it actually has, never inherit the column default",
  );

  const dueSlice = service.slice(
    service.indexOf("export async function getOwnOutstationRequestsAwaitingDeparturePhoto"),
  );
  assert.doesNotMatch(
    dueSlice.slice(0, 2000),
    /\.eq\("evidence_gate_status"/,
    "the departure-photo queue must not be a status-EQUALITY query — an unexpected value makes it " +
      "silently return nothing, which is exactly how the stranding above happened",
  );
  assert.match(
    dueSlice.slice(0, 2000),
    /resolveOutstationGateState\(/,
    "it must decide membership with the SAME resolver the payroll gate uses, so the queue and the " +
      "thing withholding the money can never disagree",
  );

  // ── "Has an expense row" is NOT "is in payroll" ─────────────────────────────────
  // A row is written when the claim is QUEUED and stays unimported until a batch takes it. The
  // release path used to test the row's mere existence, so it answered "already in payroll" for
  // every queued claim — which was all 360 rows in production, every one carrying a null
  // imported_payroll_batch_id. Held claims could never be released, and the stated reason
  // misdirected whoever read it. These four cases are the whole distinction.
  assert.equal(
    isOutstationExpenseInPayroll({ importedPayrollBatchId: null, importedToPayrollAt: null }),
    false,
    "a QUEUED expense row with no batch and no import timestamp has NOT reached payroll — this is " +
      "the shape of all 360 production rows, and reading it as 'already in payroll' stranded every held claim",
  );
  assert.equal(
    isOutstationExpenseInPayroll(null),
    false,
    "no expense row at all is certainly not in payroll",
  );
  assert.equal(
    isOutstationExpenseInPayroll({ importedPayrollBatchId: "batch-7", importedToPayrollAt: null }),
    true,
    "a row carrying a batch id HAS reached payroll and must never be released into it twice",
  );
  assert.equal(
    isOutstationExpenseInPayroll({ importedPayrollBatchId: null, importedToPayrollAt: "2026-08-09T09:00:00Z" }),
    true,
    "an import timestamp alone also means it reached payroll — either column is sufficient",
  );
}
