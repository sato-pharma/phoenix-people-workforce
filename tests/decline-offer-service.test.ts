import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runDeclineOfferServiceTests() {
  const service = readFileSync("src/lib/resignations/service.ts", "utf8");

  const fnStart = service.indexOf("export async function declineOfferAndOpenVacancy");
  assert.ok(fnStart >= 0, "could not locate declineOfferAndOpenVacancy in service.ts");
  const nextFnStart = service.indexOf("\nfunction ", fnStart + 1);
  const fnBody = service.slice(fnStart, nextFnStart > 0 ? nextFnStart : service.length);

  // (a) same role check -> scope check -> mutate ordering the resignation flow uses.
  const roleCheckIdx = fnBody.indexOf("assertResignationWorkflowTransition(");
  const scopeCheckIdx = fnBody.indexOf("canSeeEmployee(scopedAccess, employee)");
  const rpcCallIdx = fnBody.indexOf("phx_decline_offer_and_open_vacancy");

  assert.ok(roleCheckIdx >= 0, "declineOfferAndOpenVacancy must call assertResignationWorkflowTransition");
  assert.ok(scopeCheckIdx >= 0, "declineOfferAndOpenVacancy must call canSeeEmployee(scopedAccess, employee)");
  assert.ok(rpcCallIdx >= 0, "declineOfferAndOpenVacancy must call the phx_decline_offer_and_open_vacancy RPC");
  assert.ok(
    roleCheckIdx < scopeCheckIdx && scopeCheckIdx < rpcCallIdx,
    "ordering must be role check -> scope check -> mutate",
  );

  const scopeCheckWindow = fnBody.slice(scopeCheckIdx, Math.min(fnBody.length, scopeCheckIdx + 300));
  assert.ok(
    /Forbidden:/.test(scopeCheckWindow),
    "the scope check failure must throw an error prefixed with \"Forbidden:\" (matches isForbiddenError convention)",
  );

  // (b) the 30-day window is re-checked server-side via the SHARED helper — never a
  // locally re-derived day count, which is exactly how the client and server checks
  // could silently drift from each other.
  assert.match(
    fnBody,
    /isDeclineOfferEligible\(/,
    "declineOfferAndOpenVacancy must re-validate eligibility with the shared isDeclineOfferEligible helper",
  );
  assert.doesNotMatch(
    fnBody,
    /daysBetweenDateOnly\(/,
    "declineOfferAndOpenVacancy must not re-derive a day count inline — it must go through isDeclineOfferEligible",
  );

  // (c) "today" must come from the Cairo-safe helper (todayDate() wraps
  // currentCairoDateOnlyIso()), never a bare `new Date()` — the exact class of bug
  // closing-period-gate.ts exists to avoid.
  assert.match(
    fnBody,
    /const today = todayDate\(\);/,
    "declineOfferAndOpenVacancy must resolve \"today\" via todayDate() (Cairo-safe), not new Date()",
  );
  assert.doesNotMatch(
    fnBody,
    /new Date\(\)/,
    "declineOfferAndOpenVacancy must never call a bare new Date() for \"today\"",
  );

  // (d) THE CORE PAYROLL-ROUTING DECISION. Must never write to employee_resignations —
  // that table is what the automated payroll engine's leaver feeder reads
  // (src/lib/payroll/copilot/feeders.ts), and this workflow deliberately never feeds it,
  // so the two payroll engines can never disagree about this employee's pay. See
  // tests/decline-offer-payroll-routing.test.ts for the Ready Payroll side of this.
  assert.doesNotMatch(
    fnBody,
    /employee_resignations/,
    "declineOfferAndOpenVacancy must never insert into employee_resignations",
  );

  // (e) the pay/no-pay choice resolves to the two specific employment_status values the
  // rest of the payroll routing design depends on.
  assert.match(
    fnBody,
    /input\.includeInPayroll\s*\?\s*"terminated"\s*:\s*"declined_offer"/,
    "includeInPayroll must resolve to exactly \"terminated\" (pay) or \"declined_offer\" (no pay)",
  );

  // (f) findability: the exit is written with its own audit entity_type and its own
  // notification title, distinct from an ordinary resignation, per the owner's
  // requirement that this never be folded silently into a normal resignation record.
  assert.match(
    fnBody,
    /entityType:\s*"employee_decline_offer"/,
    "declineOfferAndOpenVacancy must audit-log under its own entity_type, not \"employee_resignation\"",
  );
  assert.match(
    fnBody,
    /"Declined Offer Recorded"/,
    "declineOfferAndOpenVacancy must send a notification with its own distinct title",
  );

  // (g) cache invalidation, matching the resignation flow.
  assert.match(fnBody, /invalidateEmployeeDirectoryCache\(\)/, "must invalidate the employee directory cache");
}
