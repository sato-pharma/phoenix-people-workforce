import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export async function runResignationWorkflowScopeCheckTests() {
  const service = readFileSync("src/lib/resignations/service.ts", "utf8");
  const route = readFileSync("app/api/resignations/[id]/workflow/route.ts", "utf8");

  // (a) runResignationWorkflow accepts a full AccessContext, not just the role.
  assert.match(
    service,
    /export\s+async\s+function\s+runResignationWorkflow\(\s*id:\s*string,\s*action:\s*ResignationWorkflowAction,\s*actor:\s*string,\s*note\?:\s*string\s*\|\s*null,\s*rejectedReason\?:\s*string\s*\|\s*null,\s*access\?:\s*AccessContext,\s*\)/,
    "runResignationWorkflow must accept access?: AccessContext (widened from Pick<AccessContext, \"role\">)",
  );
  assert.doesNotMatch(
    service,
    /export\s+async\s+function\s+runResignationWorkflow\([^)]*access\?:\s*Pick<AccessContext,\s*"role">/,
    "runResignationWorkflow must no longer narrow access to Pick<AccessContext, \"role\">",
  );

  // (b) canSeeEmployee and systemAccessContext are imported from the permissions module.
  assert.match(
    service,
    /import\s*\{[^}]*canSeeEmployee[^}]*\}\s*from\s*["']@\/lib\/auth\/permissions["']/,
    "service.ts must import canSeeEmployee from @/lib/auth/permissions",
  );
  assert.match(
    service,
    /import\s*\{[^}]*systemAccessContext[^}]*\}\s*from\s*["']@\/lib\/auth\/permissions["']/,
    "service.ts must import systemAccessContext from @/lib/auth/permissions",
  );

  // (c) locate runResignationWorkflow's body and confirm ordering: role check
  // (assertResignationWorkflowTransition) -> scope check (canSeeEmployee) -> mutate (update).
  const fnStart = service.indexOf("export async function runResignationWorkflow");
  assert.ok(fnStart >= 0, "could not locate runResignationWorkflow in service.ts");
  const nextFnStart = service.indexOf("\nexport async function runResignationSlaDaily", fnStart + 1);
  assert.ok(nextFnStart > fnStart, "could not locate the end of runResignationWorkflow");
  const fnBody = service.slice(fnStart, nextFnStart);

  const roleCheckIdx = fnBody.indexOf("assertResignationWorkflowTransition(");
  const scopeCheckIdx = fnBody.indexOf("canSeeEmployee(scopedAccess, employee)");
  const updateCallIdx = fnBody.indexOf('.from("employee_resignations")\n    .update(');

  assert.ok(roleCheckIdx >= 0, "runResignationWorkflow must still call assertResignationWorkflowTransition");
  assert.ok(scopeCheckIdx >= 0, "runResignationWorkflow must call canSeeEmployee(scopedAccess, employee)");
  assert.ok(updateCallIdx >= 0, "runResignationWorkflow must still update employee_resignations");
  assert.ok(
    roleCheckIdx < scopeCheckIdx && scopeCheckIdx < updateCallIdx,
    "ordering must be role check -> scope check -> mutate (assertResignationWorkflowTransition -> canSeeEmployee -> update)",
  );

  // (d) the scope check throws a Forbidden error near the canSeeEmployee call.
  const scopeCheckWindow = fnBody.slice(scopeCheckIdx, Math.min(fnBody.length, scopeCheckIdx + 300));
  assert.ok(
    /Forbidden:/.test(scopeCheckWindow),
    "the scope check failure must throw an error prefixed with \"Forbidden:\" (matches isForbiddenError convention)",
  );

  // (e) the scope check resolves the employee via getEmployeeDirectoryRows({ includeInactive:
  // true }), NOT getEmployeeDirectory() -- the latter silently excludes any employee whose status
  // isn't "active", which would make the scope check throw Forbidden for every caller (including
  // Super Admin) once a resignation's employee is no longer active. Matches by row.employee_hr_id
  // — the same HR ID the row was loaded and transitioned under.
  assert.match(
    fnBody,
    /const directory = await getEmployeeDirectoryRows\(\{\s*includeInactive:\s*true\s*\}\);/,
    "runResignationWorkflow must resolve the employee via getEmployeeDirectoryRows({ includeInactive: true }), not getEmployeeDirectory()",
  );
  assert.match(
    fnBody,
    /directory\.find\(\(item\) => hrIdsMatch\(item\.hrId, row\.employee_hr_id\)\)/,
    "the employee lookup must match against row.employee_hr_id (the resignation record's own employee)",
  );

  // (f) route.ts must pass a full AccessContext (from resolveAccessContext) into
  // runResignationWorkflow so the widened scope check actually receives hrId/scope, not just role.
  assert.match(
    route,
    /const access = await resolveAccessContext\(request\);/,
    "route.ts must resolve a full AccessContext before calling runResignationWorkflow",
  );
  assert.match(
    route,
    /runResignationWorkflow\(id,\s*action,\s*actor,\s*note,\s*rejectedReason,\s*access\)/,
    "route.ts must pass the resolved access context through to runResignationWorkflow",
  );

  // Deeper audit finding F: the SLA reminder loop counted failures (errors++) but never
  // reported them to Sentry — a systemic failure was only visible as a number buried in the
  // daily cron's JSON response body, with nothing that would ever alert anyone.

  assert.doesNotMatch(
    service,
    /\}\s*catch\s*\{\s*errors\+\+;\s*\}/,
    "the SLA reminder loop must not swallow errors without reporting them",
  );
  assert.match(
    service,
    /catch \(error\) \{\s*logError\("Resignation SLA reminder failed for recipient", \{ labels: \{ event: "resignation_sla_reminder_failed", cron: "resignation-sla-reminder", recipientHrId: hrId \}, error \}\);\s*errors\+\+;\s*\}/,
    "a failed SLA reminder send must be captured in Sentry, tagged with the affected recipient",
  );
}
