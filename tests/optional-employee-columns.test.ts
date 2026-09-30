import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isMissingColumnError } from "../src/lib/employees/missing-column.ts";

/**
 * `isMissingOptionalEmployeeColumn` decides whether the employee import re-upserts EVERY row with
 * 45 columns stripped out — salary, national id, bank account, contract, residence, insurance — and
 * then reports success. It used to say yes to `message.includes(<column>)` for each of the 45, true
 * of any error that merely names one, and to `message.includes("schema cache")`, true of a
 * schema-cache message about any column of any table.
 *
 * So one unrelated failure mentioning the word "taxes" imported everybody with 45 fields dropped,
 * silently. This pins the narrow test, and pins the two halves to each other: the column list the
 * predicate asks about must be exactly the list the strip function removes, or the import either
 * drops a column it never checked for or refuses one it would have stripped.
 */

const ROUTE = "app/api/imports/employees/confirm/route.ts";

function src(p: string) {
  return readFileSync(p, "utf8");
}

function postgrestError(message: string, code?: string) {
  const error = new Error(message) as Error & { code?: string };
  if (code) error.code = code;
  return error;
}

/** The list the predicate asks about. */
function declaredColumns(source: string): string[] {
  const start = source.indexOf("const OPTIONAL_EMPLOYEE_COLUMNS");
  assert.ok(start > 0, "OPTIONAL_EMPLOYEE_COLUMNS is declared");
  const body = source.slice(start, source.indexOf("] as const;", start));
  return [...body.matchAll(/^ {2}"([a-z0-9_]+)",$/gm)].map((m) => m[1]);
}

/** The list the strip function actually removes. */
function strippedColumns(source: string): string[] {
  const start = source.indexOf("function withoutOptionalEmployeeColumns");
  assert.ok(start > 0, "withoutOptionalEmployeeColumns exists");
  const body = source.slice(start, source.indexOf("} = values;", start));
  return [...body.matchAll(/^ {4}([a-z0-9_]+),$/gm)].map((m) => m[1]);
}

export function runOptionalEmployeeColumnsTests() {
  const route = src(ROUTE);

  // ── 1. No substring test survives in this predicate ────────────────────────
  const predicate = route.slice(
    route.indexOf("function isMissingOptionalEmployeeColumn"),
    route.indexOf("function withoutOptionalEmployeeColumns"),
  );
  assert.doesNotMatch(
    predicate,
    /message\.includes\(/,
    "the 45-way substring list is gone — it matched any error that merely named a column",
  );
  assert.doesNotMatch(
    predicate,
    /schema cache/,
    'the bare "schema cache" catch-all is gone — it was true of any column of any table',
  );
  assert.match(
    predicate,
    /OPTIONAL_EMPLOYEE_COLUMNS\.some\(\(column\) => isMissingColumnError\(error, column\)\)/,
    "each column is asked properly, by code and by name",
  );

  // ── 2. The two halves are ONE list ─────────────────────────────────────────
  const declared = declaredColumns(route);
  const stripped = strippedColumns(route);
  assert.ok(declared.length >= 40, `the column list is present and populated (${declared.length})`);
  assert.deepEqual(
    declared,
    stripped,
    "the columns the predicate asks about must be exactly the columns the strip removes, in the same "
      + "order — otherwise the import drops a column it never checked for, or refuses one it would strip",
  );

  // ── 3. The columns that used to shadow each other ──────────────────────────
  // `medical_insurance` matched `medical_insurance_number`; `social_insurance` matched
  // `social_insurance_start_date`. Both pairs are real columns, so BOTH must still resolve — but
  // each to itself.
  for (const [shorter, longer] of [
    ["medical_insurance", "medical_insurance_number"],
    ["social_insurance", "social_insurance_start_date"],
  ] as const) {
    assert.ok(declared.includes(shorter) && declared.includes(longer), `${shorter} and ${longer} are both listed`);
    const aboutLonger = postgrestError(`column "${longer}" does not exist`, "42703");
    assert.equal(isMissingColumnError(aboutLonger, shorter), false, `${shorter} must not match ${longer}`);
    assert.equal(isMissingColumnError(aboutLonger, longer), true, `${longer} still matches itself`);
  }

  // ── 4. Real failures that NAME a listed column must not strip 45 columns ───
  const mustNotMatch: Array<[string, Error]> = [
    ["a check constraint on gender", postgrestError('violates check constraint "employees_gender_check"', "23514")],
    ["a NOT NULL breach on national_id", postgrestError('null value in column "national_id" violates not-null constraint', "23502")],
    ["a bad numeric for taxes", postgrestError('invalid input syntax for type numeric: "n/a" for column taxes', "22P02")],
    ["a permission denial on base_salary", postgrestError("permission denied for column base_salary", "42501")],
    ["a foreign key on team_id", postgrestError('violates foreign key constraint "employees_team_id_fkey"', "23503")],
  ];
  for (const [what, error] of mustNotMatch) {
    const matched = declared.some((column) => isMissingColumnError(error, column));
    assert.equal(
      matched,
      false,
      `${what} must NOT strip all 45 columns off every imported employee and report success`,
    );
  }

  // ── 5. A genuinely missing listed column still takes the path ──────────────
  for (const column of ["national_id", "kaab_elamaal_refund", "taxes"]) {
    assert.ok(declared.includes(column), `${column} is listed`);
    const missing = postgrestError(
      `Could not find the '${column}' column of 'employees' in the schema cache`,
      "PGRST204",
    );
    assert.equal(
      declared.some((c) => isMissingColumnError(missing, c)),
      true,
      `a genuinely absent ${column} still sends the import down the strip path`,
    );
  }

  // ── 6. An unrelated schema-cache miss must not ────────────────────────────
  const elsewhere = postgrestError(
    "Could not find the 'geocode_status' column of 'employee_locations' in the schema cache",
    "PGRST204",
  );
  assert.equal(
    declared.some((column) => isMissingColumnError(elsewhere, column)),
    false,
    "a missing column on ANOTHER table must not strip 45 columns off the employees upsert",
  );
}
