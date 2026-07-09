import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

// Slice an exported function body so assertions are scoped to that function.
function functionSlice(src: string, declaration: string) {
  const start = src.indexOf(declaration);
  assert.notEqual(start, -1, `expected to find ${declaration}`);
  const rest = src.slice(start + declaration.length);
  const nextExport = rest.indexOf("\nexport ");
  const nextFn = rest.indexOf("\nasync function ");
  const ends = [nextExport, nextFn].filter((i) => i !== -1);
  const end = ends.length > 0 ? Math.min(...ends) : rest.length;
  return rest.slice(0, end);
}

export function runOutstationNotificationsTests() {
  const service = source("src/lib/outstation/service.ts");
  const expenses = source("src/lib/payroll/expenses.ts");

  // ── Rule 1: No submit notification ────────────────────────────────────────────
  // Outstation/expense submissions auto-approve directly to payroll. No email on submit.
  assert.doesNotMatch(
    service,
    /async function notifyOutstationSubmitted/,
    "RULE 1: notifyOutstationSubmitted must NOT exist — no email on submit",
  );

  const submitHooks = [
    "async function submitOutstationRequest",
    "async function submitMedicalRepSimpleExpenseRequest",
    "async function createManagerExpenseAsAdmin",
  ];
  for (const hook of submitHooks) {
    const slice = functionSlice(service, hook);
    assert.doesNotMatch(
      slice,
      /notifyOutstationSubmitted\(/,
      `RULE 1: ${hook} must NOT emit a submit notification`,
    );
    assert.match(
      slice,
      /approveOutstationRequestForPayroll\(/,
      `RULE 1: ${hook} must auto-approve on submit`,
    );
  }

  // ── Rule 1: No approve notification ──────────────────────────────────────────
  // Approvals are silent — they auto-happen on submission, no email needed.
  const approveSlice = functionSlice(service, "async function approveOutstationRequestForPayroll");
  assert.doesNotMatch(
    approveSlice,
    /notifyOutstationDecision\(/,
    "RULE 1: approveOutstationRequestForPayroll must NOT notify the employee",
  );

  // ── Rule 1: Reject-only decision notification ─────────────────────────────────
  // The ONLY email for outstation/expenses is when HR Manager rejects.
  const decisionSlice = functionSlice(service, "async function notifyOutstationDecision");
  assert.match(decisionSlice, /decision: "reject"/, "decision function must be reject-only");
  assert.doesNotMatch(decisionSlice, /"approve"/, "decision function must NOT handle approve");
  assert.match(decisionSlice, /eventType: "request_rejected"/, "decision eventType must be request_rejected");
  assert.match(decisionSlice, /recipientHrId: r\.employeeHrId/, "decision must notify the submitting employee");
  assert.match(decisionSlice, /priority: "normal"/, "decision is FYI (normal priority)");

  assert.match(
    functionSlice(service, "async function rejectOutstationRequestAsAdmin"),
    /notifyOutstationDecision\(\{ comment, decision: "reject"/,
    "RULE 1: reject must notify the employee with the reason",
  );

  // ── Rule 1: No payroll-import notification ────────────────────────────────────
  const importSlice = functionSlice(expenses, "async function importApprovedExpensesToPayroll");
  assert.doesNotMatch(
    importSlice,
    /notifyExpensesAddedToPayroll\(/,
    "RULE 1: payroll import must NOT emit an added-to-payroll alert",
  );

  // ── Governance non-regression: must NOT mark these as payroll-sensitive ────────
  assert.doesNotMatch(
    service,
    /sensitivity: "payroll"/,
    "outstation notifications must not be flagged payroll-sensitive",
  );

  // Deeper audit finding F: the SLA reminder loop counted failures (errors++) but never
  // reported them to Sentry — a systemic failure was only visible as a number buried in the
  // daily cron's JSON response body, with nothing that would ever alert anyone.

  const slaSlice = functionSlice(service, "export async function runOutstationSlaDaily");
  assert.doesNotMatch(slaSlice, /\}\s*catch\s*\{\s*errors\+\+;\s*\}/, "the SLA reminder loop must not swallow errors without reporting them");
  assert.match(
    slaSlice,
    /catch \(error\) \{\s*console\.error\(error, \{ tags: \{ cron: "outstation-sla-reminder", recipientHrId: hrId \} \}\);\s*errors\+\+;\s*\}/,
    "a failed SLA reminder send must be captured in Sentry, tagged with the affected recipient",
  );
}
