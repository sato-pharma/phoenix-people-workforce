import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export async function runResignationScopeCheckTests() {
  const resignationsService = readFileSync("src/lib/resignations/service.ts", "utf8");
  const contractsService = readFileSync("src/lib/contracts/service.ts", "utf8");

  // (a) resignEmployeeAndOpenVacancy accepts a full AccessContext, not just the role.
  assert.match(
    resignationsService,
    /export\s+async\s+function\s+resignEmployeeAndOpenVacancy\(\s*hrId:\s*string,\s*input:\s*EmployeeResignationInput,\s*actor:\s*string,\s*access\?:\s*AccessContext,/,
    "resignEmployeeAndOpenVacancy must accept access?: AccessContext (widened from Pick<AccessContext, \"role\">)",
  );
  assert.doesNotMatch(
    resignationsService,
    /export\s+async\s+function\s+resignEmployeeAndOpenVacancy\([^)]*access\?:\s*Pick<AccessContext,\s*"role">/,
    "resignEmployeeAndOpenVacancy must no longer narrow access to Pick<AccessContext, \"role\">",
  );

  // (b) canSeeEmployee and systemAccessContext are imported from the permissions module.
  assert.match(
    resignationsService,
    /import\s*\{[^}]*canSeeEmployee[^}]*\}\s*from\s*["']@\/lib\/auth\/permissions["']/,
    "service.ts must import canSeeEmployee from @/lib/auth/permissions",
  );
  assert.match(
    resignationsService,
    /import\s*\{[^}]*systemAccessContext[^}]*\}\s*from\s*["']@\/lib\/auth\/permissions["']/,
    "service.ts must import systemAccessContext from @/lib/auth/permissions",
  );

  // (c) locate resignEmployeeAndOpenVacancy's body and confirm ordering: role check
  // (assertResignationWorkflowTransition) -> scope check (canSeeEmployee) -> mutate (RPC call).
  const fnStart = resignationsService.indexOf("export async function resignEmployeeAndOpenVacancy");
  assert.ok(fnStart >= 0, "could not locate resignEmployeeAndOpenVacancy in service.ts");
  const nextFnStart = resignationsService.indexOf("\nfunction ", fnStart + 1);
  const fnBody = resignationsService.slice(fnStart, nextFnStart > 0 ? nextFnStart : resignationsService.length);

  const roleCheckIdx = fnBody.indexOf("assertResignationWorkflowTransition(");
  const scopeCheckIdx = fnBody.indexOf("canSeeEmployee(scopedAccess, employee)");
  const rpcCallIdx = fnBody.indexOf("phx_resign_employee_and_open_vacancy");

  assert.ok(roleCheckIdx >= 0, "resignEmployeeAndOpenVacancy must still call assertResignationWorkflowTransition");
  assert.ok(scopeCheckIdx >= 0, "resignEmployeeAndOpenVacancy must call canSeeEmployee(scopedAccess, employee)");
  assert.ok(rpcCallIdx >= 0, "resignEmployeeAndOpenVacancy must still call the phx_resign_employee_and_open_vacancy RPC");
  assert.ok(
    roleCheckIdx < scopeCheckIdx && scopeCheckIdx < rpcCallIdx,
    "ordering must be role check -> scope check -> mutate (assertResignationWorkflowTransition -> canSeeEmployee -> RPC call)",
  );

  // (d) the scope check throws a Forbidden error near the canSeeEmployee call.
  const scopeCheckWindow = fnBody.slice(scopeCheckIdx, Math.min(fnBody.length, scopeCheckIdx + 300));
  assert.ok(
    /Forbidden:/.test(scopeCheckWindow),
    "the scope check failure must throw an error prefixed with \"Forbidden:\" (matches isForbiddenError convention)",
  );

  // (e) regression sentinel: no new directory fetch was introduced for the scope check —
  // it must reuse the `employee` object already loaded via getEmployeeDirectory() above.
  assert.doesNotMatch(
    fnBody,
    /getEmployeeDirectoryRows\(/,
    "resignEmployeeAndOpenVacancy must not call getEmployeeDirectoryRows — reuse the already-loaded employee instead of an extra directory fetch",
  );
  assert.match(
    fnBody,
    /canSeeEmployee\(scopedAccess,\s*employee\)/,
    "the scope check must reuse the existing `employee` variable, not a freshly fetched row",
  );

  // (f) contracts/service.ts propagates the widened AccessContext type so
  // maybeRunNonRenewalTerminalLifecycle's defense-in-depth call keeps type-checking.
  assert.match(
    contractsService,
    /async function maybeRunNonRenewalTerminalLifecycle\(\s*record:\s*ContractRenewalRecord,\s*access:\s*AccessContext\s*\|\s*undefined,\s*actor:\s*string,\s*\)/,
    "maybeRunNonRenewalTerminalLifecycle must accept access: AccessContext | undefined (widened from Pick<AccessContext, \"role\"> | undefined)",
  );
  assert.match(
    contractsService,
    /input:\s*\{\s*access\?:\s*AccessContext;/,
    "runContractRenewalWorkflow's input.access must be widened to AccessContext",
  );

  // (g) THE OTHER WRITE PATH. /api/resignations POST -> createResignation ->
  // createResignationForEmployee takes the target employee from the caller-supplied payload
  // (input.employeeHrId), not from the URL, and until 2026-08-02 had no scope check at all —
  // it could not even perform one, because `access` was narrowed to the role and carried no
  // hrId. That was survivable only because resignations:create was held solely by Super Admin
  // and Talent Acquisition, whom canSeeEmployee passes company-wide anyway; widening that
  // grant to Employee/Medical Rep/manager roles without this guard would have let any account
  // submit a resignation for any other employee.
  assert.match(
    resignationsService,
    /export\s+async\s+function\s+createResignation\(\s*input:\s*CreateResignationInput,\s*actor:\s*string,\s*access\?:\s*AccessContext,/,
    "createResignation must accept access?: AccessContext (widened from Pick<AccessContext, \"role\">)",
  );
  assert.match(
    resignationsService,
    /async\s+function\s+createResignationForEmployee\(\s*input:\s*CreateResignationInput,\s*actor:\s*string,\s*employee:\s*DirectoryEmployee,\s*access\?:\s*AccessContext,/,
    "createResignationForEmployee must accept access?: AccessContext, or it cannot scope-check at all",
  );
  assert.doesNotMatch(
    resignationsService,
    /function\s+createResignation\([^)]*access\?:\s*Pick<AccessContext,\s*"role">/,
    "createResignation must no longer narrow access to Pick<AccessContext, \"role\">",
  );
  assert.doesNotMatch(
    resignationsService,
    /function\s+createResignationForEmployee\([^)]*access\?:\s*Pick<AccessContext,\s*"role">/,
    "createResignationForEmployee must no longer narrow access to Pick<AccessContext, \"role\">",
  );

  const createFnStart = resignationsService.indexOf("async function createResignationForEmployee");
  assert.ok(createFnStart >= 0, "could not locate createResignationForEmployee in service.ts");
  const createFnEnd = resignationsService.indexOf("\nfunction ", createFnStart + 1);
  const createFnBody = resignationsService.slice(
    createFnStart,
    createFnEnd > 0 ? createFnEnd : resignationsService.length,
  );

  const createRoleCheckIdx = createFnBody.indexOf("assertResignationWorkflowTransition(");
  const createScopeCheckIdx = createFnBody.indexOf("canSeeEmployee(scopedAccess, employee)");
  const createInsertIdx = createFnBody.indexOf("insertResignationRecord(");

  assert.ok(
    createScopeCheckIdx >= 0,
    "createResignationForEmployee must call canSeeEmployee(scopedAccess, employee) — without it the payload-supplied employeeHrId is unscoped",
  );
  assert.ok(createRoleCheckIdx >= 0, "createResignationForEmployee must still call assertResignationWorkflowTransition");
  assert.ok(createInsertIdx >= 0, "createResignationForEmployee must still call insertResignationRecord");
  assert.ok(
    createRoleCheckIdx < createScopeCheckIdx && createScopeCheckIdx < createInsertIdx,
    "ordering must be role check -> scope check -> mutate (assertResignationWorkflowTransition -> canSeeEmployee -> insertResignationRecord)",
  );

  const createScopeWindow = createFnBody.slice(
    createScopeCheckIdx,
    Math.min(createFnBody.length, createScopeCheckIdx + 300),
  );
  assert.ok(
    /Forbidden:/.test(createScopeWindow),
    "createResignationForEmployee's scope check must throw an error prefixed with \"Forbidden:\" (matches isForbiddenError convention)",
  );
}
