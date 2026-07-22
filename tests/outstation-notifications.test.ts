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
  const expenses = source("src/lib/outstation/expenses.ts");

  // ── Rule 1 (revised 2026-07-13): Submit notification → Super Admin + CEO, full details ──
  // Outstation/expense submissions auto-approve directly to payroll (no human
  // pending-approval step). Instead of an actionable "approve this" alert, every
  // active Super Admin AND the CEO get a live, informational feed of what was just
  // submitted — by email + Telegram, with the full request detail (amounts, GPS,
  // risk signals) — not the submitter's manager, and not the wider approver set
  // that has no outstation approval authority. (Super-Admin-only was a regression:
  // it silently dropped the CEO from every outstation alert.)
  assert.match(
    service,
    /async function notifyOutstationSubmitted/,
    "RULE 1: notifyOutstationSubmitted must exist — Super Admin + CEO get a submit alert",
  );

  const submitNotifySlice = functionSlice(service, "async function notifyOutstationSubmitted");
  assert.match(
    submitNotifySlice,
    /resolveOutstationSubmitAlertHrIds/,
    "submit notification must resolve recipients via the submit-alert lookup, not the employee's manager",
  );
  assert.doesNotMatch(
    submitNotifySlice,
    /direct_manager/,
    "submit notification must NOT go to the submitter's manager — Super Admin + CEO only",
  );
  assert.match(
    submitNotifySlice,
    /channels:\s*\["email",\s*"telegram"\]/,
    "submit notification must be delivered via email + Telegram",
  );
  assert.match(
    submitNotifySlice,
    /eventType: "request_submitted"/,
    "submit notification eventType must be request_submitted",
  );

  const submitAlertLookupSlice = functionSlice(service, "async function resolveOutstationSubmitAlertHrIds");
  assert.match(
    submitAlertLookupSlice,
    /\.in\("role",\s*\["Super Admin",\s*"CEO"\]\)/,
    "submit notification recipients must be scoped to Super Admin + CEO roles",
  );

  // submitOutstationRequest now makes the system decision itself: accepted -> push to
  // payroll + Super Admin/CEO alert; a rejected_by_system decision persists the request
  // and notifies the employee (no throw).
  const submitDecisionSlice = functionSlice(service, "async function submitOutstationRequest");
  assert.match(
    submitDecisionSlice,
    /notifyOutstationSubmitted\(/,
    "an accepted submit fires the Super Admin/CEO alert",
  );
  assert.match(
    submitDecisionSlice,
    /notifyOutstationDecision\(/,
    "a system-rejected submit notifies the employee",
  );
  assert.match(
    submitDecisionSlice,
    /rejected_by_system/,
    "a failed decision persists as rejected_by_system rather than throwing",
  );

  // The medical-rep and admin-manual flows still auto-accept via approveOutstationRequestForPayroll.
  const autoAcceptHooks = [
    "async function submitMedicalRepSimpleExpenseRequest",
    "async function createManagerExpenseAsAdmin",
  ];
  for (const hook of autoAcceptHooks) {
    const slice = functionSlice(service, hook);
    assert.doesNotMatch(
      slice,
      /notifyOutstationSubmitted\(/,
      `${hook} must not call the submit notification directly — it fires from inside approveOutstationRequestForPayroll`,
    );
    assert.match(
      slice,
      /approveOutstationRequestForPayroll\(/,
      `${hook} must auto-accept on submit`,
    );
  }

  // ── Rule 1: Approve fires the Super Admin submit alert, never the employee decision email ──
  const approveSlice = functionSlice(service, "async function approveOutstationRequestForPayroll");
  assert.match(
    approveSlice,
    /notifyOutstationSubmitted\(/,
    "RULE 1: approveOutstationRequestForPayroll must fire the Super Admin submit alert",
  );
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
  // Recipients for a given overdue request are now notified in ONE consolidated send
  // (createSystemNotificationForRecipients — see the 2026-07-22 duplicate-email fix), so a
  // failure is tagged by the affected request rather than by an individual recipient.
  assert.match(
    slaSlice,
    /catch \(error\) \{\s*logError\("Outstation SLA reminder failed for recipients", \{ labels: \{ event: "outstation_sla_reminder_failed", cron: "outstation-sla-reminder", requestId: String\(row\.id\) \}, error \}\);\s*errors \+= approverHrIds\.length;\s*\}/,
    "a failed SLA reminder send must be captured in Sentry, tagged with the affected request",
  );
  assert.match(
    slaSlice,
    /createSystemNotificationForRecipients\(/,
    "the SLA reminder must send ONE consolidated email to all approvers, not one send per recipient",
  );
}
