import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export async function runResignationScopeCheckTests() {
  const resignationsService = readFileSync("src/lib/resignations/service.ts", "utf8");
  const contractsService = readFileSync("src/lib/contracts/service.ts", "utf8");

  // (a) resignEmployeeAndOpenVacancy accepts a full AccessContext, not just the role.
  assert.match(
    resignationsService,
    /export\s+async\s+function\s+resignEmployeeAndOpenVacancy\(\s*hrId:\s*string,\s*input:\s*EmployeeResignationInput,\s*actor:\s*string,\s*access\?:\s*AccessContext,\s*\)/,
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
}
