import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// The Resignations UI is a DIRECTORY of components since the 2026-08-10 rebuild (it was one
// 1,337-line src/components/reports/resignations-report.tsx before). Read the whole module so
// these guards keep holding wherever inside it a given string lives.
export function readResignationsUiSource() {
  const dir = "src/components/resignations";
  return readdirSync(dir)
    .map((file) => readFileSync(`${dir}/${file}`, "utf8"))
    .join("\n");
}

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

  const reportSource = readResignationsUiSource();
  assert.match(reportSource, /encodeURIComponent\(record\.id\)}\/dates/);
  assert.match(reportSource, /method: "PATCH"/);
  assert.match(reportSource, /Edit Dates/);
  assert.match(reportSource, /type="date"/);
}
