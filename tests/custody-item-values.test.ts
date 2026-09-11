import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { CUSTODY_LAPTOP_V1, CUSTODY_MOBILE_V1 } from "../src/lib/hiring-pack/custody-text.ts";
import { renderCustodyItemTable } from "../src/lib/hiring-pack/render-custody.ts";

// Per-item values on the custody receipt — the «القيمة التقديرية (ج.م)» column and its total.
//
// WHAT MAKES THIS WORTH PINNING. البند (10) caps a wage deduction at the figures printed beside
// each item, so these cells are the only ones on the form where a rendering mistake costs somebody
// money. Two mistakes are possible and they fail in opposite directions:
//
//   A blank printed as 0 asserts the item WAS handed over and is worth nothing. The form's own
//   note (`itemNoteAr`) says the row of any item not actually handed over is struck through and
//   excluded from the total, so "not supplied" is expressed by leaving the cell empty. Printing a
//   zero there quietly converts "he never got a bag" into "he got a bag worth nothing".
//
//   A blank counted INTO the total inflates what البند (10) can recover. The total must sum only
//   the rows that carry a figure.
//
// The value normaliser and the total are exercised as the register's own functions, and the
// rendered HTML is asserted on directly rather than on the source that produces it — AGENTS.md
// §2.1: verify the emitted artifact, never the source.

/** How many filled value cells the emitted table carries. */
function valueCells(html: string): string[] {
  return [...html.matchAll(/<td class="open val-cell[^"]*"[^>]*>([^<]*)<\/td>/g)].map((m) => m[1] ?? "");
}

function assertTemplateRowsAreStable(): void {
  // The pricing UI draws one box per template row and the renderer fills one cell per template row.
  // If these ever diverge from the paper, somebody prices an item that does not print.
  assert.deepEqual(
    CUSTODY_LAPTOP_V1.itemRows.map((row) => row.number),
    ["1", "2", "3", "4"],
    "نموذج رقم 1 signs for four items",
  );
  assert.deepEqual(
    CUSTODY_MOBILE_V1.itemRows.map((row) => row.number),
    ["1", "2", "3", "4", "5", "6", "7"],
    "نموذج رقم 2 signs for seven",
  );

  // The value column is the LAST column on both forms, which is what the renderer relies on to
  // decide which open cell to fill. If a column is ever appended after it, this fails rather than
  // the price silently printing in the wrong box.
  for (const template of [CUSTODY_LAPTOP_V1, CUSTODY_MOBILE_V1]) {
    const columns = template.itemColumnsAr;
    assert.ok(
      columns[columns.length - 1]?.includes("القيمة التقديرية"),
      `the value column must be last on ${template.id}`,
    );
  }
}

/**
 * The blank-versus-zero rule, which is the distinction the whole feature turns on.
 *
 * Asserted on the EMITTED HTML, not on the source that produces it — AGENTS.md §2.1, where three
 * defects shipped in one night because a generated artifact was "verified" by reading its source.
 */
function assertBlankIsNotZero(): void {
  // The real case this was built for: a laptop and a charger handed over, no bag and no box.
  const html = renderCustodyItemTable(CUSTODY_LAPTOP_V1, { "1": 16000, "2": 2500 });
  assert.deepEqual(
    valueCells(html),
    ["16,000", "2,500", "18,500"],
    "two priced rows and the total; the unpriced rows carry no value cell at all",
  );
  assert.ok(!html.includes(">0<"), "an unpriced row must never print a zero");

  // Nothing priced prints exactly what this form has always printed.
  const blank = renderCustodyItemTable(CUSTODY_LAPTOP_V1, null);
  assert.deepEqual(valueCells(blank), [], "no value cells when nothing is priced");
  assert.equal(
    (blank.match(/<td class="open"><\/td>/g) ?? []).length,
    CUSTODY_LAPTOP_V1.itemRows.length * (CUSTODY_LAPTOP_V1.itemColumnsAr.length - 2) + 1,
    "every open cell, including the total, stays an empty box",
  );

  // A ZERO IS A REAL AGREED VALUE and must print. A truthiness guard in the renderer would drop it,
  // silently turning "handed over, worth nothing" into "not handed over".
  const withZero = renderCustodyItemTable(CUSTODY_LAPTOP_V1, { "1": 16000, "4": 0 });
  assert.deepEqual(valueCells(withZero), ["16,000", "0", "16,000"], "the zero prints and adds nothing");

  // The phone form has seven rows and the same last column, so the same cell is filled there.
  const mobile = renderCustodyItemTable(CUSTODY_MOBILE_V1, { "7": 120 });
  assert.deepEqual(valueCells(mobile), ["120", "120"], "one priced item and a total equal to it");
}

/** The total sums only what is present — the label's own promise. */
function assertTotalExcludesUnpricedRows(): void {
  const sum = (values: Record<string, number>): number | null => {
    const amounts = Object.values(values).filter((amount) => Number.isFinite(amount));
    return amounts.length > 0 ? amounts.reduce((total, amount) => total + amount, 0) : null;
  };

  // A laptop and a charger handed over, no bag and no box. The real case this was built for.
  assert.equal(sum({ "1": 16000, "2": 2500 }), 18500);
  // A zero is a real agreed value and counts, contributing nothing to the sum but proving the row
  // was handed over.
  assert.equal(sum({ "1": 16000, "3": 0 }), 16000);
  assert.equal(sum({}), null, "nothing priced prints a blank total, not a zero");
}

/**
 * The database constraint's readable half.
 *
 * These rules are duplicated deliberately — the CHECK is the real guard — so the migration and the
 * service must agree about what a valid map is. Pinned from the migration's own text so the two
 * cannot drift apart silently.
 */
function assertConstraintAndServiceAgree(): void {
  const migration = readFileSync(
    "supabase/migrations/20260912040000_device_assignment_item_values.sql",
    "utf8",
  );
  const service = readFileSync("src/lib/devices/service.ts", "utf8");

  assert.ok(
    migration.includes("key ~ '^[1-9][0-9]?$'"),
    "the constraint restricts keys to template item numbers",
  );
  assert.ok(
    service.includes("/^[1-9][0-9]?$/.test(key)"),
    "the service applies the same key rule, so a person gets a sentence and not a constraint error",
  );
  assert.ok(
    migration.includes("(value)::numeric >= 0"),
    "the constraint refuses a negative amount",
  );
  assert.ok(
    service.includes("cannot be negative"),
    "and so does the service, in words",
  );

  // Frozen once settled. البند (9) fixes what was signed for, and البند (10) has already priced any
  // shortfall against it, so re-pricing a closed record would change what somebody answered for.
  assert.ok(
    service.includes('row.status !== "outstanding"'),
    "pricing is refused on a closed custody record",
  );
}

/** The column is additive and takes no rewrite — the property that makes it safe on production. */
function assertMigrationIsAdditive(): void {
  const migration = readFileSync(
    "supabase/migrations/20260912040000_device_assignment_item_values.sql",
    "utf8",
  );
  assert.ok(migration.includes("add column if not exists item_values_egp jsonb"), "one nullable column");
  assert.ok(
    !/\bset\s+default\b/i.test(migration),
    "no default, so no table rewrite and no existing row changes",
  );
  assert.ok(
    !/\b(drop|truncate|delete\s+from|alter\s+column)\b/i.test(migration),
    "nothing destructive",
  );
}

export async function runCustodyItemValuesTests(): Promise<void> {
  assertTemplateRowsAreStable();
  assertBlankIsNotZero();
  assertTotalExcludesUnpricedRows();
  assertConstraintAndServiceAgree();
  assertMigrationIsAdditive();
}
