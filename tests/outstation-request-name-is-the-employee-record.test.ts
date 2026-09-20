import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { outstationRecordName } from "../src/lib/outstation/service.ts";

// An outstation request row is a PERSISTED WORKFLOW RECORD: it feeds the approvals queue, the
// expense_claims mirror and payroll. employee-directory.ts says in its own type comment which name
// such a row takes — "use this [displayName] for live UI/report rendering; use fullName for legal/
// payroll documents, persisted workflow audit snapshots, and identity-matching logic".
//
// The submit path used displayName anyway. displayName is nickname-first by design
// (resolveEmployeeDisplayName returns the nickname whenever one is set), so whatever the nickname
// column happened to hold at submit time was frozen onto the row for good. On 2026-09-21 that was
// 432 live claim rows across 29 people: 18 of the 25 wrong names were simply the then-current
// nickname — login handles like "Sally.Saeed" among them — and the other 7 were short forms frozen
// from a nickname that had since been edited, which no reader could ever have corrected.
//
// The repair aligned the data. This pins the WRITE PATHS so it cannot recur, and it is deliberately
// structural rather than a fixed byte window: it re-derives each function body by name every run.

const SERVICE = join(process.cwd(), "src/lib/outstation/service.ts");

/** The body of one top-level exported function, from its signature to the next one. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in service.ts — this test is pinned to it by name`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

/** The `employee_name:` value an insert payload stamps, with comment lines stripped. */
function stampedNameExpression(body: string, fn: string): string {
  const match = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("//"))
    .find((line) => line.startsWith("employee_name:"));
  assert.ok(match, `${fn} must stamp employee_name on the request it inserts`);
  return match.slice("employee_name:".length).trim().replace(/,$/, "");
}

/**
 * Every path that inserts into outstation_expense_requests.
 *
 * The wizard is the one that actually wrote the 432 rows. The other two are here so the fix cannot
 * be applied once and quietly reintroduced beside it — and the count assertion below fails if a
 * FOURTH write path is ever added without being taught the same rule.
 */
const REQUEST_WRITE_PATHS = [
  {
    fn: "submitOutstationRequest",
    why: "the wizard — also the offline replay, which syncOfflineOutstationRequest delegates here",
  },
  {
    fn: "submitMedicalRepSimpleExpenseRequest",
    why: "the medical rep simple form",
  },
  {
    fn: "createManagerExpenseAsAdmin",
    why: "an admin typing a trip in on behalf of an employee",
  },
] as const;

/** The only two spellings that read the employee RECORD. */
const RECORD_NAME_SOURCES = ["identity.employeeRecordName", "outstationRecordName("];

export function runOutstationRequestNameIsTheEmployeeRecordTests() {
  const service = readFileSync(SERVICE, "utf8");

  // ── Every write path stamps the record name ───────────────────────────────
  for (const path of REQUEST_WRITE_PATHS) {
    const expression = stampedNameExpression(functionBody(service, path.fn), path.fn);

    assert.ok(
      RECORD_NAME_SOURCES.some((source) => expression.includes(source)),
      `${path.fn} (${path.why}) must stamp employee_name from the employee RECORD — got \`${expression}\`. ` +
        `A persisted request row takes fullName; displayName is nickname-first and freezes whatever the nickname held that day onto a payroll-bound row.`,
    );

    // The two display-name spellings, named explicitly: both are what the defect looked like.
    assert.ok(
      !/\bdisplayName\b/.test(expression),
      `${path.fn} must not stamp displayName onto a request row — got \`${expression}\``,
    );
    assert.ok(
      !/\b(?:calculation|identity)\.employeeName\b/.test(expression),
      `${path.fn} must not stamp the nickname-first display name onto a request row — got \`${expression}\`. ` +
        `calculation.employeeName and identity.employeeName are both displayName; the record name is identity.employeeRecordName.`,
    );
  }

  // ── No fourth write path slipped in untaught ──────────────────────────────
  const insertCount = (
    service.match(/\.from\("outstation_expense_requests"\)\s*\n?\s*\.insert\(/g) ?? []
  ).length;
  assert.equal(
    insertCount,
    REQUEST_WRITE_PATHS.length,
    `service.ts has ${insertCount} inserts into outstation_expense_requests but this test knows about ` +
      `${REQUEST_WRITE_PATHS.length}. Add the new write path to REQUEST_WRITE_PATHS and make it stamp the employee record name.`,
  );

  // ── The identity carries a record name distinct from the display name ─────
  assert.match(
    service,
    /employeeRecordName:\s*outstationRecordName\(employee\)/,
    "getEmployeeIdentity must expose employeeRecordName, resolved through outstationRecordName",
  );

  // ── The resolver itself ───────────────────────────────────────────────────
  assert.equal(
    outstationRecordName({
      displayName: "Sally.Saeed",
      fullName: "Sally Saied Sedhom Mankrios Sedhom",
      hrId: "B-184",
    }),
    "Sally Saied Sedhom Mankrios Sedhom",
    "the record's full name wins over the nickname-first display name — this is the exact pair that shipped wrong",
  );
  assert.equal(
    outstationRecordName({ displayName: "Amr Naguib", fullName: "  ", hrId: "B-122" }),
    "Amr Naguib",
    "a blank full name falls back to the display name rather than writing an empty string",
  );
  assert.equal(
    outstationRecordName({ displayName: null, fullName: null, hrId: "B-118" }),
    "B-118",
    "with neither name recorded the row still carries something a human can resolve",
  );
  assert.equal(
    outstationRecordName({ fullName: " Amgad  Ibrahim ", hrId: "B-118" }),
    "Amgad Ibrahim",
    "the stamped name is whitespace-normalised, so two rows for one person cannot differ by spacing alone",
  );
}
