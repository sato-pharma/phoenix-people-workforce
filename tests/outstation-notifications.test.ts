import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

// Slice an exported function body so assertions are scoped to that function
// (mirrors tests/telegram-operations.test.ts). Returns from the declaration up to
// the next top-level `export ` / function boundary.
function functionSlice(source: string, declaration: string) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `expected to find ${declaration}`);
  const rest = source.slice(start + declaration.length);
  const nextExport = rest.indexOf("\nexport ");
  const nextFn = rest.indexOf("\nasync function ");
  const ends = [nextExport, nextFn].filter((index) => index !== -1);
  const end = ends.length > 0 ? Math.min(...ends) : rest.length;
  return rest.slice(0, end);
}

export function runOutstationNotificationsTests() {
  const service = source("src/lib/outstation/service.ts");

  // ── Deep-link targets (module-level constants) ─────────────────────────────────
  assert.match(service, /OUTSTATION_ADMIN_REVIEW_URL = "\/admin\/outstation\/requests"/, "approvers deep-link must be the admin review queue");
  assert.match(service, /OUTSTATION_EMPLOYEE_PORTAL_URL = "\/employee-portals\/expenses"/, "employee deep-link must be the expenses portal");

  // ── Recipient resolution: submitter's direct manager + Super Admin approver(s) ──
  assert.match(service, /async function resolveOutstationApprovalRecipients/, "approval recipient resolver must exist");
  const resolver = functionSlice(service, "async function resolveOutstationApprovalRecipients");
  assert.match(resolver, /employee\.managerHrId/, "submit alert must target the submitter's direct manager");
  assert.match(resolver, /\.eq\("role", "Super Admin"\)/, "approver audience must query Super Admin accounts (the real approvers)");
  assert.doesNotMatch(resolver, /isDesignatedHrSpecialist/, "A-16 (HR Specialist) must NOT be an approval recipient — it has no outstation approve authority");
  // Best-effort: a missing manager / failed HR lookup must never throw.
  assert.match(resolver, /console\.warn/, "missing direct manager must warn, not throw");
  assert.match(resolver, /console\.error/, "failed HR lookup must log, not throw");

  // ── Submit notification (action required) → manager + HR ───────────────────────
  const submit = functionSlice(service, "async function notifyOutstationSubmitted");
  assert.match(submit, /eventType: "request_submitted"/, "submit eventType");
  assert.match(submit, /module: "outstation"/, "submit must use the outstation module (Telegram-enabled, no governance change)");
  assert.match(submit, /channels: \["in_app", "email", "telegram"\]/, "submit must deliver on all three channels");
  assert.match(submit, /priority: "high"/, "submit is action-required (high priority)");
  assert.match(submit, /outstation:\$\{r\.id\}:request_submitted:\$\{recipient\.hrId\}/, "submit idempotency key per (request, recipient)");
  assert.match(submit, /actionUrl: OUTSTATION_ADMIN_REVIEW_URL/, "submit must deep-link approvers to the review queue");
  assert.match(submit, /Promise\.allSettled/, "submit must fan out with allSettled");
  assert.match(submit, /try \{/, "submit dispatch must be wrapped in try/catch");
  assert.match(submit, /catch \(error\)/, "submit dispatch must swallow errors (non-blocking)");

  // ── Decision notification (FYI) → submitting employee, reason on reject ────────
  const decision = functionSlice(service, "async function notifyOutstationDecision");
  assert.match(decision, /eventType: approved \? "request_approved" : "request_rejected"/, "decision eventType branches on approve/reject");
  assert.match(decision, /recipientHrId: r\.employeeHrId/, "decision must notify the submitting employee");
  assert.match(decision, /subjectHrId: r\.employeeHrId/, "decision subject is the employee");
  assert.match(decision, /Reason: \$\{reason\}/, "reject message must include the rejection reason");
  assert.match(decision, /rejectionReason: reason/, "reject metadata must carry the rejection reason");
  assert.match(decision, /outstation:\$\{r\.id\}:\$\{approved \? "request_approved" : "request_rejected"\}:\$\{r\.employeeHrId\.toUpperCase\(\)\}/, "decision idempotency key per (request, employee)");
  assert.match(decision, /actionUrl: OUTSTATION_EMPLOYEE_PORTAL_URL/, "decision must deep-link the employee to their expenses portal");
  assert.match(decision, /priority: "normal"/, "decision is FYI (normal priority)");
  assert.match(decision, /try \{/, "decision dispatch must be wrapped in try/catch");

  // ── Every hook site invokes a dispatch helper ──────────────────────────────────
  const submitHooks = [
    "async function submitOutstationRequest",
    "async function submitMedicalRepSimpleExpenseRequest",
    "async function createManagerExpenseAsAdmin",
  ];
  for (const hook of submitHooks) {
    assert.match(functionSlice(service, hook), /notifyOutstationSubmitted\(/, `${hook} must emit a submit notification`);
  }
  assert.match(functionSlice(service, "async function approveOutstationRequestForPayroll"), /notifyOutstationDecision\(\{ decision: "approve"/, "approve must notify the employee");
  assert.match(functionSlice(service, "async function rejectOutstationRequestAsAdmin"), /notifyOutstationDecision\(\{ comment, decision: "reject"/, "reject must notify the employee with the reason");

  // ── Governance non-regression: must NOT mark these as payroll-sensitive ────────
  assert.doesNotMatch(service, /sensitivity: "payroll"/, "outstation notifications must not be flagged payroll-sensitive (would strip Telegram/email)");
}
