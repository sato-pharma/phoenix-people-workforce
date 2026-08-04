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

  // ── Rule 1 (revised 2026-08-04): Submit mail → the EMPLOYEE, managers Cc, Super Admin Bcc ──
  // SUPERSEDES the 2026-07-13 rule below it, which fanned every submission out to every
  // active Super Admin AND the CEO and told the submitting employee nothing. The CEO was
  // receiving one mail per outstation submission company-wide; that is the complaint this
  // replaced. The envelope is now one message: To the employee (it is his confirmation),
  // Cc his direct manager, Cc the skip-level manager UNLESS that person is the CEO, Bcc
  // every active Super Admin. See src/lib/outstation/submit-recipients.ts — the envelope
  // decision itself is unit-tested in outstation-submit-email-routing.test.ts.
  assert.match(
    service,
    /async function notifyOutstationSubmitted/,
    "RULE 1: notifyOutstationSubmitted must exist — it is the employee's submit confirmation",
  );

  const submitNotifySlice = functionSlice(service, "async function notifyOutstationSubmitted");
  assert.match(
    submitNotifySlice,
    /resolveOutstationSubmitRouting\(request\.employeeHrId\)/,
    "submit mail must build its envelope from the employee's own reporting chain",
  );
  assert.match(
    submitNotifySlice,
    /recipientHrId: routing\.toHrId/,
    "the employee must be the To recipient, not a Super Admin",
  );
  assert.match(
    submitNotifySlice,
    /email: \{ bcc: bccAddresses, cc: ccAddresses, metrics \}/,
    "managers must ride on Cc and Super Admins on Bcc of that ONE message — never as separate sends",
  );
  assert.doesNotMatch(
    submitNotifySlice,
    /resolveOutstationSubmitAlertHrIds/,
    "the old Super Admin + CEO broadcast lookup must be gone, not merely bypassed",
  );
  assert.match(
    submitNotifySlice,
    /channels:\s*\["in_app",\s*"email",\s*"telegram",\s*"push"\]/,
    "submit notification must reach the employee in-app as well as by email/Telegram/push",
  );
  assert.match(
    submitNotifySlice,
    /eventType: "request_submitted"/,
    "submit notification eventType must be request_submitted",
  );

  // ── Regression guard (2026-07-28): submit alert metrics must not render blank ──
  // The OUTSTATION email template's {{line}}/{{area}}/{{managerName}}/{{approvalFlow}}/
  // {{status}} tokens look up these exact metric labels via metricValue() — losing any
  // of them silently blanks that row in a live email to Super Admin + CEO.
  assert.match(submitNotifySlice, /label: "Line"/, "metrics must include a standalone Line label");
  assert.match(submitNotifySlice, /label: "Area"/, "metrics must include a standalone Area label");
  assert.match(submitNotifySlice, /label: "Manager"/, "metrics must include a Manager label");
  assert.match(submitNotifySlice, /label: "Approval Flow"/, "metrics must include an Approval Flow label");
  assert.match(
    submitNotifySlice,
    /label: "Status",\s*value: "Submitted"/,
    "metrics must include an explicit Status label (the {{status}} token has no other source)",
  );
  // Trip start/end must be human-formatted, not the raw ISO timestamp stored on the request.
  // Owner format (2026-08-04): "Tuesday, 17 October 2026", Africa/Cairo — formatPhoenixLongDate,
  // NOT the short formatDateValue that the dense admin tables keep using.
  assert.match(
    submitNotifySlice,
    /label: "Trip start",\s*value: formatPhoenixLongDate\(request\.tripStartDate\)/,
    "Trip start must use the owner's long Cairo date format, not raw ISO or the short form",
  );
  assert.match(
    submitNotifySlice,
    /label: "Trip end",\s*value: formatPhoenixLongDate\(request\.tripEndDate\)/,
    "Trip end must use the owner's long Cairo date format, not raw ISO or the short form",
  );

  // ── Owner request (2026-08-04): captured location reads as a place, not a coordinate pair ──
  assert.doesNotMatch(
    submitNotifySlice,
    /\$\{request\.capturedLatitude\},\s*\$\{request\.capturedLongitude\}/,
    "the submit mail must not print raw captured coordinates",
  );
  assert.match(
    submitNotifySlice,
    /label: "Captured brick"/,
    "the submit mail must carry the brick resolved from the captured point",
  );
  assert.match(
    submitNotifySlice,
    /label: "Captured area \/ region"/,
    "the submit mail must carry the level above the brick (area / region)",
  );
  assert.match(
    submitNotifySlice,
    /label: "Location match"/,
    "a nearest-brick match is an approximation and must always ship its confidence",
  );

  // submitOutstationRequest now makes the system decision itself: accepted -> push to
  // payroll + Super Admin/CEO alert; a rejected_by_system decision persists the request
  // and notifies the employee (no throw).
  const submitDecisionSlice = functionSlice(service, "async function submitOutstationRequest");
  assert.match(
    submitDecisionSlice,
    /notifyOutstationSubmitted\(/,
    "an accepted submit fires the employee's submit confirmation",
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
    "RULE 1: approveOutstationRequestForPayroll must fire the employee's submit confirmation",
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
