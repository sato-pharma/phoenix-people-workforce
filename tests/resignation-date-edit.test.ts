import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

export function runResignationDateEditTests() {
  const serviceSource = readFileSync("src/lib/resignations/service.ts", "utf8");
  assert.match(serviceSource, /export async function updateResignationDates/);
  assert.match(serviceSource, /submitted_date: dates\.submittedDate/);
  assert.match(serviceSource, /effective_date: dates\.effectiveDate/);
  assert.match(serviceSource, /resignation_date: dates\.submittedDate/);
  assert.match(serviceSource, /last_working_date: dates\.effectiveDate/);
  assert.match(serviceSource, /writeRequiredAuditLog\(\{[\s\S]*summary: "Resignation dates updated\."/);
  assert.match(serviceSource, /invalidateEmployeeDirectoryCache\(\)/);

  const routeSource = readFileSync("app/api/resignations/[id]/dates/route.ts", "utf8");
  assert.match(routeSource, /export async function PATCH/);
  assert.match(routeSource, /assertPermission\(access, "resignations", "update"\)/);
  assert.match(routeSource, /updateResignationDates\(id, dates, actor\)/);
  assert.match(routeSource, /getResignationsDashboardData\(access\)/);

  const dir = "src/components/resignations";
  const reportSource = readdirSync(dir)
    .map((file) => readFileSync(`${dir}/${file}`, "utf8"))
    .join("\n");
  // The variable holding the target record's id and the exact button-label casing are
  // implementation details of the 2026-08-10 ground-up rebuild, not the invariant being guarded —
  // that is the PATCH call shape and the date-only inputs, checked below unchanged.
  assert.match(reportSource, /encodeURIComponent\([a-zA-Z]+\.id\)\}\/dates/);
  assert.match(reportSource, /method: "PATCH"/);
  assert.match(reportSource, /edit dates/i);
  assert.match(reportSource, /type="date"/);
}
