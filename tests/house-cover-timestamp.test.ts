// The generated-at line on a house document cover — Africa/Cairo, human-readable.
//
// Every cover printed a raw UTC ISO string until 2026-09-05: `2026-09-05T09:00:00.000Z`, labelled
// "Generated (UTC)". Two defects in one line. It is not a time anybody reads, against the standing
// rule that every time is reported in Cairo; and it is two-to-three hours out, so a reader
// comparing an export against the hour they asked for it sees a file apparently made before they
// clicked.
//
// THE ASSERTIONS BELOW ARE HARDCODED STRINGS, NOT `Intl` CALLS. A test that formats its own
// expectation with the same formatter the code uses agrees with it by construction — it would pass
// just as happily if both were still rendering UTC. The two instants are on opposite sides of
// Egypt's DST boundary precisely so a relabelling that never converts cannot pass: one is +02:00
// and the other +03:00, and no fixed offset satisfies both.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { houseGeneratedAt, houseGeneratedRow } from "../src/lib/export/house-xlsx-identity.ts";

/** Every workbook builder that prints a generated-at row on its cover. */
const COVER_BUILDERS = [
  "src/lib/deductions/exports/category-workbook.ts",
  "src/lib/deductions/exports/master-workbook.ts",
  "src/lib/export/marketing-coverage-workbook.ts",
  "src/lib/export/marketing-roi-workbook.ts",
  "src/lib/sales/monthly-dashboard-workbook.ts",
  "src/lib/sales/master-workbook.ts",
];

export function runHouseCoverTimestampTests() {
  // ── the conversion is real ─────────────────────────────────────────────────────────────────────
  // Egypt runs DST, so the offset is not a constant. Winter is +02:00. (en-GB abbreviates
  // September as "Sept", not "Sep" — the same rendering the payslip gives a hire date, so the
  // two documents agree. Pinned as EMITTED rather than as assumed.)
  assert.equal(
    houseGeneratedAt("2026-01-15T09:00:00.000Z"),
    "15 Jan 2026, 11:00 AM (Cairo)",
    "A January instant converts at +02:00.",
  );
  // …and summer is +03:00. A relabel-without-convert gives 09:00 for both; a fixed +2 gives 11:00
  // for both. Only a real Africa/Cairo conversion produces 11:00 and 12:00.
  assert.equal(
    houseGeneratedAt("2026-09-05T09:00:00.000Z"),
    "05 Sept 2026, 12:00 PM (Cairo)",
    "A September instant converts at +03:00 — this is the assertion a fixed offset fails.",
  );

  // Midnight is the case that moves the DATE as well as the clock, which is where a naive
  // implementation prints yesterday.
  assert.equal(
    houseGeneratedAt("2026-09-05T22:30:00.000Z"),
    "06 Sept 2026, 1:30 AM (Cairo)",
    "An instant late in the UTC day is already tomorrow in Cairo.",
  );

  // ── the label went with it ─────────────────────────────────────────────────────────────────────
  // The label was half the defect: a cover saying "Generated (UTC)" beside a Cairo time is worse
  // than one saying UTC beside a UTC time, because it is confidently wrong.
  const row = houseGeneratedRow("2026-09-05T09:00:00.000Z");
  assert.deepEqual(
    row,
    ["Generated", "05 Sept 2026, 12:00 PM (Cairo)"],
    "The row carries both halves, so a caller cannot update one and forget the other.",
  );
  assert.doesNotMatch(row[0], /UTC/, "No cover may still say UTC.");

  // ── a cover that cannot say when it was made shows what it was given ───────────────────────────
  // Never the words "Invalid Date" on a document somebody files.
  assert.equal(houseGeneratedAt("not a date"), "not a date", "An unparseable value passes through.");
  assert.equal(houseGeneratedAt(""), "", "…and so does an empty one.");

  // ── no builder prints a raw instant any more ───────────────────────────────────────────────────
  // The sweep, not the sample. Each of these files had at least one `["Generated (UTC)", iso]` row;
  // this is what catches a NEW cover added later that copies the old pattern from a sibling.
  for (const rel of COVER_BUILDERS) {
    const source = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /\["Generated[^"]*\(UTC\)"/,
      `${rel} must not print a "(UTC)" generated-at label — use houseGeneratedRow().`,
    );
    assert.match(
      source,
      /houseGeneratedRow\(/,
      `${rel} must build its generated-at row with the shared Cairo helper.`,
    );
    assert.match(
      source,
      /from "@\/lib\/export\/house-xlsx-identity"/,
      `${rel} must import that helper rather than re-deriving the format.`,
    );
  }
}
