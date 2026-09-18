import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Slice one function body so an assertion is scoped to it, not to the whole service. */
function functionSlice(src: string, declaration: string) {
  const start = src.indexOf(declaration);
  assert.notEqual(start, -1, `expected to find ${declaration}`);
  const rest = src.slice(start + declaration.length);
  const nextExport = rest.indexOf("\nexport ");
  const nextFn = rest.indexOf("\nasync function ");
  const ends = [nextExport, nextFn].filter((index) => index !== -1);
  return rest.slice(0, ends.length > 0 ? Math.min(...ends) : rest.length);
}

/** Executable code only — the comments explain the incidents and must not satisfy or trip a match. */
function code(slice: string) {
  return slice.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * What a District Manager saw about ONE same-day Alexandria trip on 2026-09-12, four defects deep:
 *
 *   1. The departure-photo reminder EMAIL arrived as "An Outstation / Expense request for B-119 needs
 *      your review … submitted automatically and requires your review", with his HR ID where his name
 *      belongs and blank Job Title and Line rows. Module "outstation" routes every event to the SUBMIT
 *      template, whose fields are read from submit-only metrics.
 *   2. Every submit link was built for the ADMIN queue, because authRoleForHrId looked the role up
 *      by the lowercase comparison key and app_auth_users stores "B-119" — no row, no role, admin.
 *   3. The submit notice said the governorate "could not be confirmed automatically" — the reason a
 *      hold USED to have. Every hold-role submission waits now; his trip failed no such check.
 *   4. The request had been deleted by a Super Admin, and the review page reported it as "not
 *      available, or outside what you can view", which reads as a permissions fault.
 */
export function runOutstationNotificationFramingTests() {
  const service = source("src/lib/outstation/service.ts");

  // ── 1. Non-submit events never wear the submit template ──────────────────────────────────
  const reminder = code(functionSlice(service, "export async function sendOutstationDeparturePhotoReminder"));
  assert.match(
    reminder,
    /templateKey: "general"/,
    "the departure-photo reminder must pin the plain template — module routing frames it as a request needing review",
  );
  const decision = code(functionSlice(service, "async function notifyOutstationDecision"));
  assert.match(decision, /templateKey: "general"/, "the rejection must pin the plain template");
  const sla = code(functionSlice(service, "export async function runOutstationSlaDaily"));
  assert.match(sla, /templateKey: "general"/, "the overdue reminder must pin the plain template");
  // The submit notice is the one event the submit template was written for; pinning it away would
  // lose the table the manager and the Super Admin read.
  const submit = code(functionSlice(service, "async function notifyOutstationSubmitted"));
  assert.equal(/templateKey:/.test(submit), false, "the submit notice keeps the outstation submit template");

  // ── 2. The role lookup matches the stored hr id ──────────────────────────────────────────
  const roleLookup = code(functionSlice(service, "async function authRoleForHrId"));
  assert.match(
    roleLookup,
    /\.eq\("hr_id", hrIdForStorage\(hrId\)\)/,
    "authRoleForHrId must query app_auth_users by the STORED form (B-119), or every link falls back to the admin queue",
  );
  assert.equal(
    /\.eq\("hr_id", normalized\)/.test(roleLookup),
    false,
    "authRoleForHrId must not query by the lowercase comparison key again",
  );

  // ── 3. The hold notice names no reason the checks did not raise ──────────────────────────
  assert.equal(
    /governorate could not be confirmed/.test(submit),
    false,
    "the submit notice must not blame the governorate — every hold-role submission waits, whatever the checks found",
  );
  assert.match(
    submit,
    /"HELD FOR REVIEW: this request is NOT added to payroll yet\. A Super Admin will approve or reject it\.",\s*text\(options\.reviewReason\)/,
    "the hold line must carry the real review reason when there is one",
  );

  // ── 4. A deleted request says so, only to someone who could have seen it ─────────────────
  const deleted = code(functionSlice(service, "export async function getDeletedOutstationRequestNotice"));
  assert.match(
    deleted,
    /\.like\("summary", "Admin deleted outstation request%"\)/,
    "the notice must read the audit row deleteOutstationRequest writes",
  );
  assert.match(
    deleted,
    /canViewEmployeeExpenseScope\(access, employeeHrId\)/,
    "the notice must be scoped like the request itself, or the page confirms a request id to anyone",
  );
  const deleteSummary = functionSlice(service, "export async function deleteOutstationRequestAsAdmin");
  assert.match(
    deleteSummary,
    /summary: `Admin deleted outstation request \$\{existing\.id\}\.`/,
    "the audit summary the notice matches on must stay exactly this",
  );
  const page = source("app/employee-portals/outstation-review/[id]/page.tsx");
  assert.match(
    page,
    /getDeletedOutstationRequestNotice\(access, requestId\)[\s\S]{0,200}title="Request deleted"/,
    "the review page must tell a deleted request apart from one outside the viewer's scope",
  );
}
