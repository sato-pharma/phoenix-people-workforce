import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";
import { isActiveLifecycleStatus } from "../src/lib/employees/employee-directory.ts";
import { normalizeVacationRequestStatus } from "../src/lib/vacation/calculations.ts";
import { VACATION_STATUSES } from "../src/lib/vacation/types.ts";
import { orphanedRequestModuleScreens } from "../src/lib/approvals/orphaned-requests.ts";

/**
 * CLOSING A RETURNED VACATION REQUEST WHOSE EMPLOYEE HAS LEFT.
 *
 * `returned` is answerable by exactly one person: `resubmitVacationRequest` refuses anyone who is
 * not the employee who submitted the request. When that employee resigns, nothing expires the
 * request and it is in nobody's queue. The Needs You board found these and could only say "no
 * screen in Phoenix can clear it yet"; the direct-order twin had to be cleared with hand-written
 * SQL on 2026-10-08. `closeOrphanedVacationRequest` is the control, and this file pins that it is
 * narrow: Super Admin only, a written reason, `returned` only, REFUSES while the employee can still
 * log in, ends in `cancelled` and never `rejected`, never deletes, and leaves the approval steps and
 * every balance alone.
 *
 * Source is read through `stripComments`/`stripSqlComments` first: these files explain at length
 * what they must not do, and a negative assertion against raw text matches the sentence saying so.
 */

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function bodyOf(source: string, signature: string): string {
  const code = stripComments(source);
  const start = code.indexOf(signature);
  assert.ok(start > 0, `${signature} must exist`);
  const next = code.indexOf("\nexport ", start + signature.length);
  return code.slice(start, next > 0 ? next : undefined);
}

const SERVICE = "src/lib/vacation/service.ts";
const WORKFLOW = "src/lib/vacation/workflow.ts";
const ROUTE = "app/api/vacations/requests/[id]/close-orphaned/route.ts";
const HUB = "src/lib/approvals-hub/service.ts";
const PANEL = "src/components/approvals-hub/stuck-approvals-panel.tsx";
const PAGE = "app/(admin)/admin/approvals/stuck/page.tsx";
const SOURCES = "src/lib/needs-you/sources.ts";
const MIGRATION_DIR = "supabase/migrations";

export function runVacationCloseOrphanedTests() {
  const service = read(SERVICE);
  const closer = bodyOf(service, "export async function closeOrphanedVacationRequest");
  const reader = bodyOf(service, "export async function listStrandedVacationRequests");

  // ── "Left" is the shared rule, executed ──────────────────────────────────────────────────
  for (const active of ["active", "on_leave", null, undefined, ""]) {
    assert.equal(isActiveLifecycleStatus(active), true, `"${String(active)}" is EMPLOYED — closing their returned request destroys their own work`);
  }
  for (const gone of ["resigned", "terminated", "inactive", "probation", "notice_period"]) {
    assert.equal(isActiveLifecycleStatus(gone), false, `"${gone}" is not employed`);
  }

  // ── The status vocabulary carries `cancelled`, and it survives the reader ────────────────
  assert.ok(
    VACATION_STATUSES.some((option) => option.value === "cancelled"),
    "VACATION_STATUSES must carry `cancelled` — the closed request is stored with it",
  );
  assert.equal(
    normalizeVacationRequestStatus("cancelled"),
    "cancelled",
    "a closed request must read back as `cancelled`; an unknown status falls back to pending_manager, which would put a dead request back in an approver's queue",
  );

  // ── The closer ───────────────────────────────────────────────────────────────────────────
  assert.match(closer, /assertStrandedVacationAccess\(access\)/, "Super Admin / system only, restated inside the service — a route or page gate is not the boundary");
  assert.match(
    stripComments(service),
    /function assertStrandedVacationAccess[\s\S]*?isAllVacationVisibility\(access\)/,
    "the access gate is the module's own Super Admin / system predicate",
  );
  assert.match(closer, /const reason = input\.reason\?\.trim\(\);\s*if \(!reason\) \{/, "a written reason is mandatory — it is the only record of the decision");
  assert.match(closer, /request\.status !== "returned"/, "ONLY a returned request may be closed this way; a pending one is its approver's to decide");
  assert.match(closer, /getEmployeeDirectoryRows\(\{ includeInactive: true \}\)/, "the people this is ABOUT are the ones the default directory drops");
  assert.match(closer, /isActiveLifecycleStatus\(employee\.employmentStatus\)/, "an ACTIVE employee's return is theirs to answer — this must refuse");
  assert.match(closer, /if \(!employee\) \{/, "an HR id the employee master does not hold is a directory problem, not a departure");

  // The refusals must come BEFORE the write.
  const writeAt = closer.indexOf(".update(");
  assert.ok(writeAt > 0, "the closer must update the request");
  for (const guard of ['request.status !== "returned"', "isActiveLifecycleStatus(employee.employmentStatus)", "if (!employee) {", "if (!reason) {", "assertLeaveWorkflowTransition("]) {
    const at = closer.indexOf(guard);
    assert.ok(at > 0 && at < writeAt, `${guard} must be evaluated before the update, or the refusal arrives after the damage`);
  }

  assert.match(closer, /actionKey: "close_orphaned"/, "the registry transition is asserted under close_orphaned");
  assert.match(closer, /status: request\.status,/, "the registry gate is given the row's REAL status, not a literal");
  assert.match(closer, /update\(\{ status: "cancelled"/, "the result is cancelled");
  assert.doesNotMatch(closer, /"rejected"/, "NEVER rejected — nobody turned this down, and it would inflate every approver's rejection count");
  assert.match(closer, /\.eq\("status", "returned"\)/, "the update is guarded on `returned` so a request resubmitted a moment ago is not closed under its approver");
  assert.match(closer, /!updated \|\| updated\.length === 0/, "a lost race is an error, never a success");

  // Never deletes, never touches steps, balances or decisions.
  assert.doesNotMatch(closer, /\.delete\(/, "closing is not deleting — the request, its events and its steps stay on record");
  assert.doesNotMatch(closer, /v2_vacation_approval_steps|vacationApprovalStepsTable/, "the approval steps are deliberately left exactly as they are");
  assert.doesNotMatch(closer, /manager_decision|hr_decision/, "no approver decision is written — nobody decided this");
  assert.doesNotMatch(closer, /balance/i, "a returned request was never approved, so no balance moves");

  // The event row and the audit row.
  assert.match(closer, /insertVacationEvent\(\{/, "an event row is written");
  assert.match(closer, /eventType: "closed_stranded"/, "the event is typed");
  assert.match(closer, /previousStatus: "returned"/, "the event carries the previous status");
  assert.match(closer, /strandedEmployeeHrId: request\.employeeHrId/, "the event carries the stranded employee");
  assert.match(closer, /writeRequiredAuditLog\(\{/, "the close is audited, and a failed audit write fails the close");

  // ── The reader ───────────────────────────────────────────────────────────────────────────
  assert.match(reader, /assertStrandedVacationAccess\(access\)/, "the list has the same gate as the close");
  assert.match(reader, /\.eq\("status", "returned"\)/, "only returned requests are listed");
  assert.match(reader, /getEmployeeDirectoryRows\(\{ includeInactive: true \}\)/, "includeInactive is the whole point");
  assert.match(reader, /isActiveLifecycleStatus\(employee\.employmentStatus\)/, "the shared lifecycle rule, never a hand-rolled list");
  assert.match(reader, /if \(!employee\) continue;/, "an id the master does not hold is left alone");

  // ── Registry: union, route, migration ────────────────────────────────────────────────────
  assert.match(stripComments(read(WORKFLOW)), /\| "close_orphaned"/, "the TS action union carries close_orphaned");

  const migrations = readdirSyncSafe(MIGRATION_DIR).filter((name) => name.endsWith("_vacation_close_orphaned.sql"));
  assert.equal(migrations.length, 1, "exactly one vacation_close_orphaned migration");
  const sql = stripSqlComments(read(`${MIGRATION_DIR}/${migrations[0]}`));
  assert.match(sql, /module_key = 'leave_requests'/, "the action is added to the leave_requests registry module");
  assert.match(sql, /'key', 'close_orphaned'/, "the action key");
  assert.match(sql, /'from', jsonb_build_array\('returned'\)/, "from returned only");
  assert.match(sql, /'to', 'cancelled'/, "to cancelled, never rejected");
  assert.match(sql, /'requiresReason', true/, "a reason is required");
  assert.match(sql, /'allowedRoles', jsonb_build_array\('Super Admin'\)/, "Super Admin only");
  assert.doesNotMatch(sql, /\bversion\s*=/, "version is bumped by the touch trigger, never by hand");
  assert.match(sql, /'cancelled'::text/, "the status CHECK admits `cancelled` — without it the update is rejected by the database");
  assert.match(sql, /raise exception 'leave_requests registry would be SKIPPED/, "the loader simulation runs in the migration");

  const route = stripComments(read(ROUTE));
  assert.match(route, /assertSameOriginMutation\(request\)/, "the route is CSRF-guarded");
  assert.match(route, /closeOrphanedVacationRequest\(access, \{/, "the route calls the domain service");
  assert.match(route, /status: 403/, "a forbidden caller gets 403");

  // ── The screen ───────────────────────────────────────────────────────────────────────────
  const hub = stripComments(read(HUB));
  assert.match(hub, /strandedVacations: StrandedVacationRow\[\];/, "the payload carries the stranded vacations");
  assert.match(
    hub,
    /canCloseStrandedDirectOrders\s*\n?\s*\? listStrandedVacationRequests\(access\)/,
    "the reader is only called for a viewer who may act on what it returns",
  );
  const panel = stripComments(read(PANEL));
  assert.match(panel, /\/api\/vacations\/requests\/\$\{encodeURIComponent\(vacation\.id\)\}\/close-orphaned/, "the panel posts to the close route");
  assert.match(panel, /if \(!reason\.trim\(\)\) \{/, "the panel refuses an empty reason before posting");
  assert.match(panel, /vacation\.returnReason \?/, "the approver's own words are rendered");
  assert.match(panel, /strandedVacations\.length === 0/, "the empty state counts the vacations too, or a lone stranded vacation reads 'No stuck approvals'");
  assert.match(stripComments(read(PAGE)), /strandedVacations=\{data\.strandedVacations\}/, "the page passes the list to the panel");

  // ── The board points at the control ──────────────────────────────────────────────────────
  assert.equal(orphanedRequestModuleScreens.vacation.requesterRemedy, "close", "the board offers the verb that exists");
  assert.equal(orphanedRequestModuleScreens.vacation.requesterHref, "/admin/approvals/stuck", "the requester case links to the screen with the button");
  assert.equal(orphanedRequestModuleScreens.vacation.href, "/admin/approvals/vacation", "the approver case still links to Leave Approvals, where the rung is reassigned");
  const sources = stripComments(read(SOURCES));
  assert.match(sources, /group\.actorRole === "requester" \? \(screen\.requesterHref \?\? screen\.href\)/, "the item href follows the actor case");
  assert.match(sources, /\$\{requesterScreen\} screen/, "the note names the screen that holds the control");
}

function readdirSyncSafe(dir: string): string[] {
  return readdirSync(new URL(`../${dir}`, import.meta.url));
}
