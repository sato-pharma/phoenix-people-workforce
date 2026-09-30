import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isMissingColumnError } from "../src/lib/employees/missing-column.ts";

/**
 * The compensation read and write paths used to ask `message.includes("payment_mode")` — true of
 * EVERY error that names the column, not only "it is not there" — and `message.includes("schema
 * cache")`, true of a schema-cache message about any column of any table.
 *
 * Each of the three sites answers a true match by dropping the column and carrying on:
 *
 *   - the directory READ retries the select without it, handing back rows whose payment mode is
 *     silently absent;
 *   - the employee WRITE `return`s having saved nothing, reporting a successful save;
 *   - the IMPORT re-upserts every employee's compensation with the column stripped out, and reports
 *     success.
 *
 * So a constraint breach, an invalid payment mode or a permission denial on salary data was
 * swallowed and reported as a save. These cases are the ones that must NOT match.
 */

function src(p: string) {
  return readFileSync(p, "utf8");
}

/** supabase-js hands back a PostgrestError: a genuine Error subclass carrying `code`. */
function postgrestError(message: string, code?: string) {
  const error = new Error(message) as Error & { code?: string };
  if (code) error.code = code;
  return error;
}

/** `supabaseRest` in employee-directory.ts decorates its thrown Error with `pgrst_code`. */
function restError(message: string, pgrstCode?: string) {
  const error = new Error(message) as Error & { pgrst_code?: string };
  if (pgrstCode) error.pgrst_code = pgrstCode;
  return error;
}

export function runMissingColumnPredicateTests() {
  // ── Genuinely missing: these must still match, or the fallback stops working ──
  assert.equal(
    isMissingColumnError(
      postgrestError("Could not find the 'payment_mode' column of 'employee_compensation' in the schema cache", "PGRST204"),
      "payment_mode",
    ),
    true,
    "PGRST204 naming the column is the write-side missing-column answer",
  );
  assert.equal(
    isMissingColumnError(restError('column employee_compensation.payment_mode does not exist', "42703"), "payment_mode"),
    true,
    "42703 naming the column is the read-side missing-column answer",
  );
  assert.equal(
    isMissingColumnError(restError('column "salary_details" does not exist', "42703"), "salary_details"),
    true,
    "the salary_details half is covered too",
  );
  // No machine code at all — the exact wordings still count.
  assert.equal(
    isMissingColumnError(new Error("Could not find the 'payment_mode' column of 'employee_compensation' in the schema cache"), "payment_mode"),
    true,
    "a codeless error still matches on PostgREST's exact wording",
  );
  assert.equal(
    isMissingColumnError(new Error('column "payment_mode" does not exist'), "payment_mode"),
    true,
    "a codeless error still matches on Postgres's exact wording",
  );

  // ── THE DEFECT: errors that NAME the column but do not say it is missing ──
  const mustNotMatch: Array<[string, Error]> = [
    [
      "a check-constraint violation on the column",
      postgrestError(
        'new row for relation "employee_compensation" violates check constraint "employee_compensation_payment_mode_check"',
        "23514",
      ),
    ],
    [
      "an invalid enum value for the column",
      postgrestError('invalid input value for enum payroll_payment_mode: "BANK "', "22P02"),
    ],
    [
      "a NOT NULL breach on the column",
      postgrestError('null value in column "payment_mode" violates not-null constraint', "23502"),
    ],
    [
      "a permission denial naming the column",
      postgrestError("permission denied for column payment_mode", "42501"),
    ],
    [
      "a foreign-key style failure naming the column",
      postgrestError('insert or update on table "employee_compensation" violates foreign key constraint on payment_mode', "23503"),
    ],
  ];
  for (const [what, error] of mustNotMatch) {
    assert.equal(
      isMissingColumnError(error, "payment_mode"),
      false,
      `${what} must NOT be read as a missing column — that swallows a real failure on salary data`,
    );
  }

  // ── The bare "schema cache" substring is retired ──
  assert.equal(
    isMissingColumnError(
      postgrestError("Could not find the 'residence_area' column of 'employee_locations' in the schema cache", "PGRST204"),
      "payment_mode",
    ),
    false,
    "a schema-cache miss about ANOTHER column must not trigger the payment_mode fallback",
  );
  assert.equal(
    isMissingColumnError(new Error("Could not query the database: schema cache reload in progress"), "payment_mode"),
    false,
    "a schema-cache message naming no column at all must not match",
  );

  // ── The column must be a whole identifier, not a substring ──
  assert.equal(
    isMissingColumnError(restError('column "payment_mode_id" does not exist', "42703"), "payment_mode"),
    false,
    "payment_mode must not match payment_mode_id — the substring trap one column wider",
  );
  assert.equal(
    isMissingColumnError(restError('column "medical_insurance_number" does not exist', "42703"), "medical_insurance"),
    false,
    "medical_insurance must not match medical_insurance_number",
  );

  // ── Shapes that must not throw ──
  for (const odd of [null, undefined, "", 0, {}, { message: 42 }, "payment_mode"]) {
    assert.doesNotThrow(() => isMissingColumnError(odd, "payment_mode"), `tolerates ${JSON.stringify(odd)}`);
  }
  assert.equal(isMissingColumnError(restError("anything", "42703"), ""), false, "an empty column name matches nothing");

  // ── The three call sites actually use it ──
  const dir = src("src/lib/employees/employee-directory.ts");
  // Any spelling of the substring test, not just the one that was there: the defect is the shape.
  assert.doesNotMatch(
    dir,
    /\.includes\("payment_mode"\)/,
    "no loose payment_mode substring test survives in employee-directory.ts, in any spelling",
  );
  assert.doesNotMatch(
    dir,
    /\.includes\("salary_details"\)/,
    "no loose salary_details substring test survives either",
  );
  assert.equal(
    (dir.match(/isMissingColumnError\(/g) ?? []).length >= 4,
    true,
    "the read, the write and its fallback all ask the narrow predicate",
  );

  const route = src("app/api/imports/employees/confirm/route.ts");
  assert.match(
    route,
    /function isMissingPaymentModeColumn\(error: unknown\) \{\s*return isMissingColumnError\(error, "payment_mode"\);\s*\}/,
    "the import route's predicate is the narrow one, not a substring pair",
  );
}
