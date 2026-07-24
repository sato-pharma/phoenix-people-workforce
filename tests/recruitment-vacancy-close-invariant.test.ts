import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Rule 1 — a position vacancy must close ONLY when an employee is created
// (manual add, bulk import). Creating a requisition or marking an application
// hired must never itself set a vacancy to 'filled' — that stays the
// employee-creation flow's job. This is a static-source invariant so a future
// edit that closes a seat too early fails the suite.

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = source.slice(start + signature.length);
  const nextExport = rest.indexOf("\nexport ");
  return nextExport >= 0 ? rest.slice(0, nextExport) : rest;
}

export function runRecruitmentVacancyCloseInvariantTests() {
  // The requisition service must never write to the vacancy table (a comment
  // mentioning the table is fine; an actual query/write is not).
  const requisitions = read("src/lib/recruitment/requisitions.ts");
  assert.doesNotMatch(
    requisitions,
    /\.from\(\s*["']position_vacancies["']\s*\)/,
    "requisition service must not query/write position_vacancies",
  );
  assert.doesNotMatch(requisitions, /status:\s*["']filled["']/, "requisition service must not set a vacancy filled");

  // Marking an application hired must not close the seat itself — the employee
  // record (created via the normal Add Employee flow) already did that.
  const applications = read("src/lib/recruitment/applications.ts");
  const markHired = functionBody(applications, "export async function markApplicationHired");
  assert.doesNotMatch(markHired, /\.from\(\s*["']position_vacancies["']\s*\)/, "markApplicationHired must not touch position_vacancies");
  assert.doesNotMatch(markHired, /status:\s*["']filled["']/, "markApplicationHired must not set a vacancy filled");

  // Positive anchor: the real closer exists (in its own module, apart from the
  // recruitment/offers domain) and is reused by the employee-creation hire paths.
  const closer = read("src/lib/employees/vacancy-closer.ts");
  assert.match(closer, /function closeVacancyOnHire/, "closeVacancyOnHire (the real closer) must exist");
}
