import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** The body of a top-level `export async function <name>`, up to the next top-level export. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in the payroll service`);
  const rest = source.slice(start + 1);
  const end = rest.indexOf("\nexport ");
  return end === -1 ? rest : rest.slice(0, end);
}

export function runPayrollMutationAuditTests() {
  const service = readSource("../src/lib/payroll/service.ts");

  // Production evidence for why this test exists (queried 2026-08-21): audit_logs held 15
  // `payroll_batch` rows EVER, all of them workflow transitions, none since 2026-07-13 — while the
  // vacation module logged 340 rows in 30 days from 10 call sites. A salary import, a batch
  // replacement and a batch deletion each left no trace of who did it. The registry's
  // `audit.classification` does NOT cause an audit row; only these calls do.
  for (const fn of ["createSalaryBatch", "replaceSalaryBatch", "deleteSalaryBatch"]) {
    const body = functionBody(service, fn);
    assert.ok(
      body.includes("await writeRequiredAuditLog({"),
      `${fn} must write a required audit row — payroll mutations must name their actor`,
    );
    assert.ok(
      body.includes('entityType: "payroll_batch"'),
      `${fn} must record its audit row against entityType "payroll_batch"`,
    );
  }

  // Ordering matters for the delete and nothing else enforces it: phx_delete_salary_batch removes
  // the row and its salary_records, so a before-image read placed after the RPC would always return
  // null and the audit row would say nothing about what was destroyed.
  const deleteBody = functionBody(service, "deleteSalaryBatch");
  const readAt = deleteBody.indexOf("await getSalaryBatchById(batchId)");
  const rpcAt = deleteBody.indexOf('supabase.rpc("phx_delete_salary_batch"');
  assert.notEqual(readAt, -1, "deleteSalaryBatch must read the batch before deleting it");
  assert.notEqual(rpcAt, -1, "deleteSalaryBatch must still call the phx_delete_salary_batch RPC");
  assert.ok(readAt < rpcAt, "deleteSalaryBatch must capture the before-image BEFORE the delete RPC runs");
  assert.ok(
    deleteBody.includes("oldValues: existing"),
    "the delete audit row must carry the captured before-image as oldValues",
  );

  // A batch that cannot be read must still be deletable — the caller is authorised, and refusing
  // the delete because the audit read failed would turn a logging problem into an outage.
  assert.ok(
    deleteBody.includes("Batch row could not be read before deletion."),
    "deleteSalaryBatch must record that the before-image read failed rather than blocking the delete",
  );

  // The actor has to come from the route; the service has no session.
  const deleteRoute = readSource("../app/api/payroll/[id]/route.ts");
  assert.match(
    deleteRoute,
    /await deleteSalaryBatch\(\s*id,\s*resolveEmployeeIdentityId\(access\) \?\? access\.loginId \?\? "system"\s*\)/,
    "the payroll DELETE route must pass the acting user into deleteSalaryBatch",
  );
}
