// The deduction detail sheets' own timestamp cells — Cairo, like the cover above them.
//
// #3252 fixed the COVER's generated-at line and left the table below it printing
// `2026-09-05T09:00:00.000Z` in the Created At and Decided At columns. One document, two answers to
// "when": the cover said Cairo and the rows said UTC, three hours apart, with nothing on the page
// saying so.
//
// The zone moved into the COLUMN HEADING rather than into every cell: "(Cairo)" repeated down two
// hundred rows is noise a reader skips on every line, and it does not fit an 18-wide column — which
// is also why the columns widened to 24. The cover keeps the suffixed form, because a provenance
// line stands alone with no heading to carry the zone for it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { houseCairoDateTime, houseGeneratedAt } from "../src/lib/export/house-xlsx-identity.ts";

const EXPORT_BUILDERS = [
  "src/lib/deductions/exports/category-workbook.ts",
  "src/lib/deductions/exports/master-workbook.ts",
];

export function runDeductionCellTimestampTests() {
  // ── the conversion is real, on both sides of Egypt's DST boundary ──────────────────────────────
  // Hardcoded, not re-derived with the same formatter: a test that formats its own expectation
  // agrees with the code by construction and would pass while both still rendered UTC. +02:00 in
  // January and +03:00 in September is a pair no fixed offset satisfies.
  assert.equal(houseCairoDateTime("2026-01-15T09:00:00.000Z"), "15 Jan 2026, 11:00 AM");
  assert.equal(houseCairoDateTime("2026-09-05T09:00:00.000Z"), "05 Sept 2026, 12:00 PM");

  // The instant that moves the DATE as well as the clock.
  assert.equal(houseCairoDateTime("2026-09-05T22:30:00.000Z"), "06 Sept 2026, 1:30 AM");

  // ── a cell carries no zone; the cover still does ───────────────────────────────────────────────
  assert.doesNotMatch(
    houseCairoDateTime("2026-09-05T09:00:00.000Z"),
    /Cairo/,
    "A cell is headed by its column — repeating the zone on every row is noise.",
  );
  assert.match(
    houseGeneratedAt("2026-09-05T09:00:00.000Z"),
    /\(Cairo\)$/,
    "The cover's provenance line stands alone, so it keeps the zone.",
  );
  assert.equal(
    houseGeneratedAt("2026-09-05T09:00:00.000Z"),
    `${houseCairoDateTime("2026-09-05T09:00:00.000Z")} (Cairo)`,
    "One formatter, two presentations — the cover and the cells cannot disagree about the time.",
  );

  // ── nullable cells are BLANK, never a date ─────────────────────────────────────────────────────
  // A candidate nobody has decided yet has no `decidedAt`. `new Date(null)` is the epoch and
  // `new Date(undefined)` is Invalid Date, so without the guard this column would have printed
  // "01 Jan 1970" or "Invalid Date" on a payroll document — both worse than an empty cell, because
  // both look like data.
  assert.equal(houseCairoDateTime(null), "", "null is a blank cell.");
  assert.equal(houseCairoDateTime(undefined), "", "so is undefined.");
  assert.equal(houseCairoDateTime(""), "", "and so is an empty string.");
  assert.doesNotMatch(houseCairoDateTime(null), /1970/, "The epoch must never reach a cell.");
  assert.equal(houseCairoDateTime("not a date"), "not a date", "An unparseable value passes through.");

  // ── the sheets use it, and say which zone ──────────────────────────────────────────────────────
  for (const rel of EXPORT_BUILDERS) {
    const source = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    assert.match(
      source,
      /houseCairoDateTime\(candidate\.createdAt\)/,
      `${rel} must format the Created At cell.`,
    );
    assert.match(
      source,
      /houseCairoDateTime\(candidate\.decision\?\.decidedAt\)/,
      `${rel} must format the Decided At cell.`,
    );
    assert.doesNotMatch(
      source,
      /^\s{4}candidate\.createdAt,$/m,
      `${rel} must not emit a raw instant as a cell.`,
    );
    // The heading is what tells the reader which zone the column is in; without it the conversion
    // is invisible and a reader comparing against their own clock has nothing to go on.
    for (const label of ["Decided At (Cairo)", "Created At (Cairo)"]) {
      assert.ok(source.includes(label), `${rel} must head the column "${label}".`);
    }
    // 22 characters of value do not fit an 18-wide column.
    assert.doesNotMatch(
      source,
      /\{ label: "(Decided|Created) At \(Cairo\)", width: 18 \}/,
      `${rel} must widen the column, or the value arrives clipped.`,
    );
  }

  // ── what stays UTC, and why ────────────────────────────────────────────────────────────────────
  // `hireDate` and `monthKey` are DATE-ONLY. They parse as UTC midnight, and converting them to
  // Cairo would shift the calendar day — the opposite defect. Asserted so a later sweep for
  // "timestamps not in Cairo" does not convert them too.
  for (const rel of EXPORT_BUILDERS) {
    const source = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /houseCairoDateTime\(candidate\.(hireDate|monthKey)/,
      `${rel}: a date-only column must NOT be converted — UTC is what stops the day shifting.`,
    );
  }
}
