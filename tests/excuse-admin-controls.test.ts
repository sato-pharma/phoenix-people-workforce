import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canManageExcuseRecordsFor,
  excuseAdminDecisionColumns,
  excuseAdminEditRefusal,
  parseExcuseAdminStatus,
  type ExcuseAdminCurrent,
} from "../src/lib/excuses/admin-edit.ts";
import { accessRegistry } from "../src/lib/security/access-registry.ts";

// The Super Admin's Admin controls on one excuse request (owner, 2026-11-24: "in excuse approvals
// add admin tools"): who may, what an edit writes, what it refuses, and that the routes and panel
// are wired the way the rule in .claude/rules/time-off.md says.
export async function runExcuseAdminControlsTests() {
  // --- Who may: the Super Admin or a system actor, nobody else -----------------------------
  assert.equal(canManageExcuseRecordsFor({ role: "Super Admin" }), true);
  assert.equal(canManageExcuseRecordsFor({ role: "Employee", scope: "system" }), true);
  for (const role of ["CEO", "HR Operations", "Manager", "National Sales Manager", "Employee", null]) {
    assert.equal(canManageExcuseRecordsFor({ role }), false, `${String(role)} must not edit or delete an excuse`);
  }

  // --- Status parsing ---------------------------------------------------------------------
  assert.equal(parseExcuseAdminStatus("approved"), "approved");
  assert.equal(parseExcuseAdminStatus(" Returned_To_Employee "), "returned_to_employee");
  assert.equal(parseExcuseAdminStatus("cancelled"), null, "only the four statuses the table allows");

  const current: ExcuseAdminCurrent = {
    excuseDate: "2026-11-10",
    excuseType: "morning",
    managerDecisionComment: null,
    status: "pending_manager",
  };
  const now = "2026-11-24T10:00:00.000Z";

  // --- A status moved to a decision is recorded as the ADMIN's, now ------------------------
  assert.deepEqual(
    excuseAdminDecisionColumns({
      adminHrId: "B-10",
      current,
      next: { excuseDate: current.excuseDate, excuseType: "morning", reply: null, status: "approved" },
      now,
    }),
    {
      manager_decision: "approved",
      manager_decision_at: now,
      manager_decision_by_hr_id: "B-10",
      manager_decision_comment: null,
      status: "approved",
    },
    "the record must never say the manager decided what the admin decided",
  );

  // --- Back to pending clears the decision, as a resubmission does -------------------------
  const decided: ExcuseAdminCurrent = { ...current, managerDecisionComment: "ok", status: "approved" };
  assert.deepEqual(
    excuseAdminDecisionColumns({
      adminHrId: "B-10",
      current: decided,
      next: { excuseDate: current.excuseDate, excuseType: "morning", reply: "ok", status: "pending_manager" },
      now,
    }),
    {
      manager_decision: null,
      manager_decision_at: null,
      manager_decision_by_hr_id: null,
      manager_decision_comment: null,
      status: "pending_manager",
    },
  );

  // --- Status unchanged: the decision columns stay as they were, the reply excepted -------
  assert.deepEqual(
    excuseAdminDecisionColumns({
      adminHrId: "B-10",
      current: decided,
      next: { excuseDate: "2026-11-11", excuseType: "afternoon", reply: "ok", status: "approved" },
      now,
    }),
    { manager_decision_comment: "ok", status: "approved" },
    "a date or half correction must not re-stamp who decided it",
  );

  // --- Refusals ----------------------------------------------------------------------------
  assert.equal(
    excuseAdminEditRefusal({ current, next: { ...current, reply: null }, ownRequest: false }),
    "Nothing was changed.",
  );
  assert.match(
    excuseAdminEditRefusal({ current, next: { ...current, reply: null, status: "approved" }, ownRequest: true }) ?? "",
    /^Forbidden: you cannot change the status of your own excuse request/,
    "the Super Admin must never decide his own excuse through the admin tools",
  );
  assert.equal(
    excuseAdminEditRefusal({ current, next: { ...current, excuseDate: "2026-11-12", reply: null }, ownRequest: true }),
    null,
    "his own request's date may still be corrected",
  );
  assert.match(
    excuseAdminEditRefusal({ current, next: { ...current, reply: null, status: "returned_to_employee" }, ownRequest: false }) ?? "",
    /reply to the employee is required/,
  );
  assert.equal(
    excuseAdminEditRefusal({ current, next: { ...current, reply: "Wrong date", status: "returned_to_employee" }, ownRequest: false }),
    null,
  );

  // --- Wiring: the service asks the gate before reading, writes a REQUIRED audit row, and
  //     tells nobody; the manager's decision path is untouched --------------------------------
  const service = readFileSync("src/lib/excuses/service.ts", "utf8");
  for (const fn of ["updateExcuseRequestAsAdmin", "deleteExcuseRequestAsAdmin"]) {
    const start = service.indexOf(`export async function ${fn}(`);
    assert.ok(start >= 0, `${fn} must exist`);
    const end = service.indexOf("\nexport ", start + 10);
    const body = service.slice(start, end);
    assert.ok(
      body.indexOf("assertExcuseAdmin(access)") >= 0 && body.indexOf("assertExcuseAdmin(access)") < body.indexOf("fetchRequestById("),
      `${fn} must refuse a non-admin before it reads the request`,
    );
    assert.match(body, /writeRequiredAuditLog\(/, `${fn} must write a required audit row`);
    assert.doesNotMatch(body, /notify|raiseApproval/, `${fn} must tell nobody, as a leave request's admin edit tells nobody`);
  }
  assert.match(
    service,
    /export function canManageExcuseRecords\(access: AccessContext\): boolean \{\s*return canManageExcuseRecordsFor\(access\);/,
  );
  const decide = service.slice(service.indexOf("export async function decideExcuseRequestAsManager("));
  assert.doesNotMatch(
    decide.slice(0, decide.indexOf("\nexport ", 10)),
    /canManageExcuseRecords|Super Admin"/,
    "the manager's decision keeps no Super Admin stand-in",
  );

  const route = readFileSync("app/api/excuses/[id]/route.ts", "utf8");
  for (const method of ["PATCH", "DELETE"]) {
    assert.match(
      route,
      new RegExp(`export async function ${method}[\\s\\S]*?assertSameOriginMutation\\(request\\)[\\s\\S]*?assertSignedIn\\(access\\)`),
      `${method} must be same-origin and signed in`,
    );
  }
  assert.doesNotMatch(route, /export (async )?function (GET|POST)\b/, "the admin route edits and deletes only");
  const entries = accessRegistry.filter((entry) => entry.pattern === "/api/excuses/:id");
  assert.equal(entries.length, 1, "the admin route has one registry entry");
  assert.deepEqual([...(entries[0]?.methods ?? [])].sort(), ["DELETE", "PATCH"]);
  assert.equal(entries[0]?.csrf.required, true);
  assert.equal(entries[0]?.audit.classification, "mutation");

  // --- The panel shows only where the server said so --------------------------------------
  const hub = readFileSync("src/lib/approvals-hub/service.ts", "utf8");
  assert.match(hub, /const canAdminManage = canManageExcuseRecords\(access\);/);
  const detail = readFileSync("src/components/approvals-hub/excuse-request-detail.tsx", "utf8");
  assert.match(detail, /\{detail\.canAdminManage \? <ExcuseAdminControls backHref=\{backHref\} row=\{req\} \/> : null\}/);
  const panel = readFileSync("src/components/approvals-hub/excuse-admin-controls.tsx", "utf8");
  assert.match(panel, /method: "PATCH"/);
  assert.match(panel, /method: "DELETE"/);
  assert.doesNotMatch(panel, /rounded/, "the square-edge rule: no round corners");
}
