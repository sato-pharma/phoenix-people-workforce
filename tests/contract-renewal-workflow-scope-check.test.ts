import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export async function runContractRenewalWorkflowScopeCheckTests() {
  const service = readFileSync("src/lib/contracts/service.ts", "utf8");
  const route = readFileSync("app/api/contracts/[id]/workflow/route.ts", "utf8");

  // (a) runContractRenewalWorkflow's input.access accepts a full AccessContext, not just the role.
  assert.match(
    service,
    /input:\s*\{\s*access\?:\s*AccessContext;/,
    "runContractRenewalWorkflow's input.access must accept AccessContext (widened from Pick<AccessContext, \"role\">)",
  );
  assert.doesNotMatch(
    service,
    /input:\s*\{\s*access\?:\s*Pick<AccessContext,\s*"role">/,
    "runContractRenewalWorkflow's input.access must no longer be narrowed to Pick<AccessContext, \"role\">",
  );

  // (b) canSeeContractRow (the file's existing read-time scope helper) and getEmployeeDirectoryRows
  // are used for the mutation-path scope check, rather than a newly invented helper.
  assert.match(
    service,
    /function canSeeContractRow\(access: AccessContext \| undefined, employee: EmployeeDirectoryRow\)/,
    "the existing canSeeContractRow helper must still be defined in service.ts",
  );
  assert.match(
    service,
    /import\s*\{[^}]*getEmployeeDirectoryRows[^}]*\}\s*from\s*["']@\/lib\/employees\/employee-directory["']/,
    "service.ts must import getEmployeeDirectoryRows from the employee directory module",
  );

  // (c) locate runContractRenewalWorkflow's body and confirm ordering: role check
  // (assertContractWorkflowTransition) -> scope check (canSeeContractRow) -> mutate (RPC call).
  const fnStart = service.indexOf("export async function runContractRenewalWorkflow");
  assert.ok(fnStart >= 0, "could not locate runContractRenewalWorkflow in service.ts");
  const nextFnStart = service.indexOf("\nexport async function getContractRenewalReminderCandidates", fnStart + 1);
  assert.ok(nextFnStart > fnStart, "could not locate the end of runContractRenewalWorkflow");
  const fnBody = service.slice(fnStart, nextFnStart);

  const roleCheckIdx = fnBody.indexOf("assertContractWorkflowTransition(");
  const scopeCheckIdx = fnBody.indexOf("canSeeContractRow(input.access, contractEmployee)");
  const rpcCallIdx = fnBody.indexOf("phx_apply_contract_renewal_workflow");

  assert.ok(roleCheckIdx >= 0, "runContractRenewalWorkflow must still call assertContractWorkflowTransition");
  assert.ok(scopeCheckIdx >= 0, "runContractRenewalWorkflow must call canSeeContractRow(input.access, contractEmployee)");
  assert.ok(rpcCallIdx >= 0, "runContractRenewalWorkflow must still call the phx_apply_contract_renewal_workflow RPC");
  assert.ok(
    roleCheckIdx < scopeCheckIdx && scopeCheckIdx < rpcCallIdx,
    "ordering must be role check -> scope check -> mutate (assertContractWorkflowTransition -> canSeeContractRow -> RPC call)",
  );

  // (d) the scope check throws a Forbidden error near the canSeeContractRow call.
  const scopeCheckWindow = fnBody.slice(scopeCheckIdx, Math.min(fnBody.length, scopeCheckIdx + 300));
  assert.ok(
    /Forbidden:/.test(scopeCheckWindow),
    "the scope check failure must throw an error prefixed with \"Forbidden:\" (matches isForbiddenError convention)",
  );

  // (e) the employee lookup includes inactive employees, so the scope check does not
  // false-negative (block legitimate actions) on requests belonging to an employee whose
  // employment status has since changed away from active.
  assert.match(
    fnBody,
    /getEmployeeDirectoryRows\(\{\s*includeInactive:\s*true\s*\}\)/,
    "the scope check's employee lookup must pass includeInactive: true so already-inactive employees are still resolvable",
  );
  assert.match(
    fnBody,
    /cleanHrId\(item\.hrId\) === cleanHrId\(existing\.employee_hr_id\)/,
    "the employee lookup must match against existing.employee_hr_id (the renewal request's own employee)",
  );

  // (f) route.ts must pass a full AccessContext (from resolveAccessContext) into
  // runContractRenewalWorkflow so the widened scope check actually receives hrId/scope, not just role.
  assert.match(
    route,
    /const access = await resolveAccessContext\(request\);/,
    "route.ts must resolve a full AccessContext before calling runContractRenewalWorkflow",
  );
  assert.match(
    route,
    /runContractRenewalWorkflow\(id,\s*action,\s*actor,\s*\{\s*access,/,
    "route.ts must pass the resolved access context through to runContractRenewalWorkflow",
  );
}
