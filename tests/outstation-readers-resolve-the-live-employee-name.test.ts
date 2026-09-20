import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  applyLiveOutstationEmployeeNames,
  liveOutstationEmployeeName,
  outstationRecordName,
} from "../src/lib/outstation/employee-name.ts";

// PR #4135 fixed the WRITE side: a new outstation request now stamps the employee RECORD name
// instead of the nickname-first display name. It could not fix the 432 rows already written —
// `employee_name` and `specialist` are snapshots taken at submit time, so a correction to an
// employee record never travels backwards, which is why the 2026-09-21 repair had to touch every
// row by hand.
//
// This pins the READ side: the lists a human reads a name from resolve it live, so the NEXT
// correction reaches the old rows on its own. The stored columns stay raw — they remain the audit
// trail of what was true on the day, and nothing on this path writes.

const SERVICE = join(process.cwd(), "src/lib/outstation/service.ts");
const EXPENSES = join(process.cwd(), "src/lib/outstation/expenses.ts");

/** The directory map the resolver takes, keyed the way canonicalHrIdKey keys it. */
function names(entries: Record<string, string>) {
  return new Map(Object.entries(entries));
}

/** The body of one top-level exported async function, from its signature to the next one. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist — this test is pinned to it by name`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

export function runOutstationReadersResolveTheLiveEmployeeNameTests() {
  // ── The resolver ──────────────────────────────────────────────────────────
  const directory = names({
    "b-184": "Sally Saied Sedhom Mankrios Sedhom",
    "b-118": "Amgad Ibrahim Tawfik Farag",
  });

  assert.equal(
    liveOutstationEmployeeName(directory, "B-184", "Sally.Saeed"),
    "Sally Saied Sedhom Mankrios Sedhom",
    "a row frozen with the login handle must render the employee record's current name",
  );
  assert.equal(
    liveOutstationEmployeeName(directory, "b-184", "Sally.Saeed"),
    "Sally Saied Sedhom Mankrios Sedhom",
    "the HR id is matched canonically — AccessContext carries the lowercase comparison key",
  );
  assert.equal(
    liveOutstationEmployeeName(directory, "B-999", "Mahmoud Eldaly"),
    "Mahmoud Eldaly",
    "an HR id the directory does not know keeps the stored name rather than blanking",
  );
  assert.equal(
    liveOutstationEmployeeName(directory, null, "Historic Import Name"),
    "Historic Import Name",
    "an imported row carrying only a name keeps it — there is no id to resolve",
  );
  assert.equal(
    liveOutstationEmployeeName(names({}), "B-184", "Sally.Saeed"),
    "Sally.Saeed",
    "a directory that could not be read falls back to the stored name, never to a blank screen",
  );
  assert.equal(
    liveOutstationEmployeeName(names({ "b-122": "B-122" }), "B-122", "Amr Naguib"),
    "Amr Naguib",
    "a record with no usable name of its own resolves to its HR id — the stored name is better",
  );

  // ── The list applier ──────────────────────────────────────────────────────
  const rows = [
    { employeeHrId: "B-184", employeeName: "Sally.Saeed", id: 1 },
    { employeeHrId: "B-999", employeeName: "Someone Who Left", id: 2 },
  ];
  const before = JSON.parse(JSON.stringify(rows));
  const resolved = applyLiveOutstationEmployeeNames(
    directory,
    rows,
    (row) => ({ hrId: row.employeeHrId, storedName: row.employeeName }),
    (row, employeeName) => ({ ...row, employeeName }),
  );

  assert.deepEqual(rows, before, "the applier must copy rows, never mutate the caller's array");
  assert.equal(resolved[0].employeeName, "Sally Saied Sedhom Mankrios Sedhom");
  assert.equal(
    resolved[1].employeeName,
    "Someone Who Left",
    "a leaver or an unknown id keeps the name the row was written with",
  );
  assert.equal(
    resolved[1],
    rows[1],
    "a row whose name does not change is passed through untouched, not re-cloned",
  );
  assert.deepEqual(
    applyLiveOutstationEmployeeNames(
      names({}),
      rows,
      (row) => ({ hrId: row.employeeHrId, storedName: row.employeeName }),
      (row, employeeName) => ({ ...row, employeeName }),
    ),
    rows,
    "an empty directory changes nothing at all — the read degrades, the screen does not",
  );

  // ── The seams ─────────────────────────────────────────────────────────────
  const service = readFileSync(SERVICE, "utf8");
  const expenses = readFileSync(EXPENSES, "utf8");

  for (const fn of [
    "listOutstationRequests",
    "getOutstationRequestById",
    "listMedicalRepExpenseRequests",
  ]) {
    assert.ok(
      functionBody(service, fn).includes("withLiveRequestNames("),
      `${fn} renders employee_name to a human, so it must resolve it live — the stored column is ` +
        `a submit-time snapshot that a corrected employee record never reaches.`,
    );
  }

  assert.match(
    service,
    /message: `\$\{employeeName\}'s outstation request/,
    "the SLA reminder names the employee to an approver, so it must use the resolved name",
  );

  assert.ok(
    expenses.includes("withLiveSpecialistNames(unified)"),
    "the unified expenses list feeds the dashboards, so it must resolve `specialist` live",
  );
  assert.ok(
    expenses.includes("options.readLegacyTables ? unified :"),
    "the Expense Approvals editor path must stay on the stored labels — its Save writes back the " +
      "rows it read, so resolving there would rewrite stored history on the next save",
  );

  // ── The write side is unchanged by all of this ────────────────────────────
  assert.equal(
    outstationRecordName({ displayName: "Sally.Saeed", fullName: "Sally Saied", hrId: "B-184" }),
    "Sally Saied",
    "the write-side resolver still stamps the record name from its new home",
  );
}
