import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveInvoiceDate } from "../src/lib/sales/monthly-distributor-import.ts";

const importSource = readFileSync(
  new URL("../src/lib/sales/monthly-distributor-import.ts", import.meta.url),
  "utf8",
);
const backfillSource = readFileSync(
  new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260611141000_sos_invoice_date_backfill.sql", import.meta.url),
  "utf8",
);
const columnSource = readFileSync(
  new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260611140000_sos_invoice_date.sql", import.meta.url),
  "utf8",
);

const excelSerialFor = (iso: string) =>
  (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;

export function runSosInvoiceDateTests() {
  // ── Date instances + Excel serials (unambiguous machine dates) ─────────────────────
  assert.equal(
    resolveInvoiceDate(new Date(Date.UTC(2026, 3, 20)), undefined, "2026-04"),
    "2026-04-20",
    "Date instance resolves to its UTC day",
  );
  assert.equal(
    resolveInvoiceDate(excelSerialFor("2026-04-05"), undefined, "2026-04"),
    "2026-04-05",
    "Excel serial resolves",
  );

  // ── JS Date.toString() text — the DIRECT/EG/PS/RM raw format ───────────────────────
  assert.equal(
    resolveInvoiceDate("Mon Apr 20 2026 11:56:02 GMT+0000 (Coordinated Universal Time)", undefined, "2026-04"),
    "2026-04-20",
    "JS toString text resolves via the native-parse fallback",
  );

  // ── ISO-like — the IS / IS-S raw format ─────────────────────────────────────────────
  assert.equal(resolveInvoiceDate("2026/04/30", undefined, "2026-04"), "2026-04-30");
  assert.equal(resolveInvoiceDate("2026-04-09", undefined, "2026-04"), "2026-04-09");

  // ── Day-first — the SF raw format ───────────────────────────────────────────────────
  assert.equal(resolveInvoiceDate("22-04-2026", true, "2026-04"), "2026-04-22", "SF day-first");
  // Even without the column hint, 22 cannot be a month — day-first wins via the guard.
  assert.equal(resolveInvoiceDate("22-04-2026", undefined, "2026-04"), "2026-04-22");

  // ── Slash-date ambiguity: "4/9/2026" — the period arbitrates the orientation ─────────
  assert.equal(
    resolveInvoiceDate("4/9/2026", undefined, "2026-04"),
    "2026-04-09",
    "ambiguous slash date with April period reads month-first (April 9)",
  );
  assert.equal(
    resolveInvoiceDate("4/9/2026", undefined, "2026-09"),
    "2026-09-04",
    "ambiguous slash date with September period reads day-first (Sept 4)",
  );
  assert.equal(
    resolveInvoiceDate("4/9/2026", undefined, "2026-05"),
    null,
    "neither orientation matches the period → null, never a wrong-month date",
  );
  // Both orientations matching implies day == month — same date either way.
  assert.equal(resolveInvoiceDate("4/4/2026", undefined, "2026-04"), "2026-04-04");

  // ── The universal guard: a parsed date outside the row's period is rejected ─────────
  assert.equal(
    resolveInvoiceDate(new Date(Date.UTC(2026, 4, 2)), undefined, "2026-04"),
    null,
    "date in the wrong month never survives the period guard",
  );
  assert.equal(resolveInvoiceDate("2026/04/30", undefined, null), null, "no period → no date");

  // ── Garbage in → null ────────────────────────────────────────────────────────────────
  assert.equal(resolveInvoiceDate("", undefined, "2026-04"), null);
  assert.equal(resolveInvoiceDate("not a date", undefined, "2026-04"), null);
  assert.equal(resolveInvoiceDate("30/02/2026", true, "2026-02"), null, "impossible civil date → null");
  assert.equal(resolveInvoiceDate(undefined, undefined, "2026-04"), null);

  // ── Structural guards ────────────────────────────────────────────────────────────────
  assert.match(importSource, /invoice_date: row\.invoiceDate/, "import insert payload must persist invoice_date");
  assert.match(columnSource, /add column if not exists invoice_date date null/, "column migration adds nullable invoice_date");

  // Every backfill UPDATE must carry the period guard; 4 distributor groups → at least 4 guards.
  const guardCount = (backfillSource.match(/to_char\(d\.(?:parsed|mdy|dmy), 'YYYY-MM'\) = r\.invoice_period/g) ?? []).length;
  assert.ok(guardCount >= 4, `backfill must period-guard every UPDATE (found ${guardCount})`);
  const idempotentCount = (backfillSource.match(/invoice_date is null/g) ?? []).length;
  assert.ok(idempotentCount >= 4, "backfill must be idempotent (only fills NULL rows)");
  assert.match(backfillSource, /analyze public\.source_of_sales_import_rows/, "backfill refreshes planner stats");
}
