import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Rule 1 — a position vacancy must close ONLY when an employee is created
// (manual add, bulk import, or convert). Sending an offer or creating a
// requisition must never set a vacancy to 'filled'. This is a static-source
// invariant so a future edit that closes a seat too early fails the suite.

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
  const offers = read("src/lib/offers/service.ts");
  const createOffer = functionBody(offers, "export async function createOffer");
  assert.doesNotMatch(
    createOffer,
    /status:\s*["']filled["']/,
    "createOffer must only validate the vacancy, never set it to filled",
  );

  // The requisition service must never write to the vacancy table (a comment
  // mentioning the table is fine; an actual query/write is not).
  const requisitions = read("src/lib/recruitment/requisitions.ts");
  assert.doesNotMatch(
    requisitions,
    /\.from\(\s*["']position_vacancies["']\s*\)/,
    "requisition service must not query/write position_vacancies",
  );
  assert.doesNotMatch(requisitions, /status:\s*["']filled["']/, "requisition service must not set a vacancy filled");

  // Launching an offer from an application must not close the seat either.
  const applications = read("src/lib/recruitment/applications.ts");
  const launch = functionBody(applications, "export async function launchOfferFromApplication");
  assert.doesNotMatch(launch, /\.from\(\s*["']position_vacancies["']\s*\)/, "launchOfferFromApplication must not touch position_vacancies");
  assert.doesNotMatch(launch, /status:\s*["']filled["']/, "launchOfferFromApplication must not set a vacancy filled");

  // Positive anchor: the real closer exists (in the dedicated vacancies module,
  // kept apart from service.ts's dynamic offer-letter-pdf.ts import) and is reused by the hire paths.
  const vacancies = read("src/lib/offers/vacancies.ts");
  assert.match(vacancies, /function closeVacancyForOffer/, "closeVacancyForOffer (the real closer) must exist");
}
