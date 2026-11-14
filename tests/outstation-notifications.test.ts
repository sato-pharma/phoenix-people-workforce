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

  // ── Rule 1 (2026-09-04): Submit mail → the EMPLOYEE himself, his manager on Cc, ──────────
  // ── Super Admin Bcc ────────────────────────────────────────────────────────────────────
  // REVERSES the 2026-08-13 email-reduction rule, which excluded the submitting employee from
  // every slot on the reasoning that a copy confirmed nothing he did not already know. The
  // envelope is now one message: To the employee (unconditionally — it is his own submission),
  // Cc his direct manager (falling back to the skip-level manager when the direct manager is
  // missing or the CEO), Bcc every active Super Admin. See
  // src/lib/outstation/submit-recipients.ts — the envelope decision itself is unit-tested in
  // outstation-submit-email-routing.test.ts.
  assert.match(
    service,
    /async function notifyOutstationSubmitted/,
    "RULE 1: notifyOutstationSubmitted must exist — it is the employee's confirmation that his submission was received",
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
    "the To recipient must come from routing — the submitting employee himself",
  );
  assert.match(
    submitNotifySlice,
    /email: \{ bcc: bccAddresses, cc: ccAddresses, metrics \}/,
    "the manager must ride on Cc and Super Admins on Bcc of that ONE message — never as separate sends",
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

  // REVERSED 2026-08-09 by owner decision ("do not reject any expense, you flag to admin and he
  // decides"). submitOutstationRequest used to make the rejection decision itself and mail the
  // employee about it; the two assertions below therefore required exactly what is now forbidden.
  //
  // The system still runs every check and still records every failure — it just holds the claim
  // for a Super Admin instead of refusing it. So the submit path sends ONE mail, the
  // awaiting-approval one, and a rejection notice can now only come from a human's decision in
  // the queue (notifyOutstationDecision is still called there — see the reject-path pin below).
  const submitDecisionSlice = functionSlice(service, "async function submitOutstationRequest");
  assert.match(
    submitDecisionSlice,
    /notifyOutstationSubmitted\(/,
    "every submit fires the employee's confirmation alert",
  );
  assert.doesNotMatch(
    submitDecisionSlice,
    /notifyOutstationDecision\(/,
    "no rejection mail may be sent at submit time — only a Super Admin's own decision sends one",
  );
  // Quoted form on purpose: this forbids WRITING the status, not naming it. The submit path's own
  // comments explain why the rejection was removed, and a bare-word match would fail on the
  // explanation — punishing the documentation instead of the behaviour.
  assert.doesNotMatch(
    submitDecisionSlice,
    /["']rejected_by_system["']/,
    "the submit path must not reject: the system flags and a human decides",
  );

  // REVERSED 2026-08-08 by owner decision: no submit path auto-accepts any more. Every claim waits
  // for a human, so each of these must raise the alert ITSELF — the notification used to ride along
  // inside approveOutstationRequestForPayroll, and dropping the auto-approval without moving the
  // mail would have silently stopped every submission email in the system.
  //
  // NARROWED 2026-08-28: createManagerExpenseAsAdmin moved out of the unconditional list when
  // the owner extended the National Sales Manager no-hold rule to the admin's manual-entry
  // form. It still alerts, and still alerts as WAITING for every other role — the flag is now
  // computed rather than hard-coded, which is exactly what the assertion below checks.
  const waitingSubmitHooks = ["async function submitMedicalRepSimpleExpenseRequest"];
  const conditionalSubmitHooks = ["async function createManagerExpenseAsAdmin"];
  for (const hook of [...waitingSubmitHooks, ...conditionalSubmitHooks]) {
    assert.doesNotMatch(
      functionSlice(service, hook),
      /approveOutstationRequestForPayroll\(/,
      `${hook} must NOT approve its own submission — an approval belongs to a person, in the queue`,
    );
  }
  for (const hook of waitingSubmitHooks) {
    assert.match(
      functionSlice(service, hook),
      /notifyOutstationSubmitted\([\s\S]{0,120}heldForReview:\s*true/,
      `${hook} must raise the awaiting-approval alert itself, now that no approval fires it`,
    );
  }
  for (const hook of conditionalSubmitHooks) {
    assert.match(
      functionSlice(service, hook),
      /notifyOutstationSubmitted\([\s\S]{0,120}heldForReview:\s*!noHoldRole/,
      `${hook} must still alert, and must tell the truth about whether the claim is waiting — ` +
        "the exempt role is accepted on the spot, everyone else is queued",
    );
  }

  // ── Rule 1: Approve alerts ONLY on a rejection override, never the employee decision email ──
  const approveSlice = functionSlice(service, "async function approveOutstationRequestForPayroll");
  assert.match(
    approveSlice,
    /existing\.status\.startsWith\("rejected"\)[\s\S]{0,80}notifyOutstationSubmitted\(/,
    "RULE 1: the submit alert fires from approve ONLY when overriding a system rejection — every " +
      "other claim was already alerted at submit, so an unconditional send here would double-mail " +
      "the employee, his manager and the Super Admins on every single trip",
  );
  assert.doesNotMatch(
    approveSlice,
    /notifyOutstationDecision\(/,
    "RULE 1: approveOutstationRequestForPayroll must NOT notify the employee",
  );

  // ── Rule 1: Reject-only decision notification ─────────────────────────────────
  // The ONLY decision notice is a rejection — in-app, Telegram and push, never email (owner, 2026-09-19).
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
  // The unused added-to-payroll sender (in-app + EMAIL + Telegram to the employee) was deleted on
  // 2026-09-19 at the owner's instruction, so no one can wire an expense email back in by calling it.
  // expenses.ts sends no notification of any kind; a new one is new work, channels agreed first.
  assert.doesNotMatch(expenses, /notifyExpensesAddedToPayroll/, "the unused added-to-payroll email sender must stay deleted");
  assert.doesNotMatch(expenses, /createSystemNotification/, "expenses.ts must not send a notification — payroll import is silent");

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
    /createSystemNotificationForRecipients\(|raiseApproval\(\{ module: "outstation", step: "reminder" \}, \{ via: "notices"/,
    "the SLA reminder must send ONE consolidated email to all approvers, not one send per recipient",
  );
}
