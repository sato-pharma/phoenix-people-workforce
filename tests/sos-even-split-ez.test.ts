import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { buildOfficeAreaWeights, type OfficeBrickShare } from "../src/lib/sales/office-allocation.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The EZ even-split rule (owner, 2026-08-26): EZ (client 1011654, «مخزن شركه اى زد») is CNS-only and
// its sales are credited EVENLY across the CNS reps active in Cairo and Giza that month, instead of
// all landing in the one area the warehouse physically sits in.
//
// Two properties carry real money and are what this file exists to defend.
//
// ── 1. A SETTLED MONTH NEVER RE-SPLITS ───────────────────────────────────────────────────────────
// His words: "once a month is uploaded, it's not changed … if one of these reps resigned, then
// August sales will be as it is — what will change is the distribution of EZ in September."
//
// Deriving the divisor live from hire/resignation dates LOOKS point-in-time safe, and it is — right
// up until somebody corrects a historical hire date or an employee row is removed, at which point
// every past month silently re-splits and published closings move underneath the business. So the
// roster is frozen into `sos_even_split_roster` once per period and read back forever after. The
// no-op guard inside `phx_freeze_even_split_roster` IS that immutability. Delete it and the freeze
// becomes a recompute — the exact failure his rule was stated to prevent, and one that would show up
// months later as a quietly different published number. Assertion A below fails the build for it.
//
// ── 2. EACH AREA NEEDS ITS OWN LANDING BRICK ─────────────────────────────────────────────────────
// The rows and the rollup key on brick_id, so each area's slice must land on a brick. It is tempting
// to reuse EZ's real brick (B196-2) for all of them — the customer genuinely sits there, and the
// owner's rule stops at the AREA, so the brick looks like a formality.
//
// It is not. Inside the LOCKED golden rule, `brickUnits` is keyed on brick_id ALONE and keeps the
// FIRST area it encounters, so one brick spread over several areas collapses into a single entry
// carrying every area's units. Section 2 drives the real locked function with both shapes and shows
// the collapse produces a within-area share ABOVE 1.0 while the other areas lose their brick detail
// entirely — which distorts the AREA totals the rule exists to produce. That is why every row of
// `sos_even_split_roster` carries its own `landing_brick_id`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const MIGRATION_NAME = "20260826190000_sos_even_split_ez.sql";
const MIGRATION = path.join(process.cwd(), "supabase/migrations", MIGRATION_NAME);

// The header quotes table names, function names and the owner's ruling in prose, so a raw text
// search would match the commentary rather than the SQL.
function strip(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

function bodyOf(sql: string, fnName: string): string {
  const start = sql.indexOf(`function public.${fnName}`);
  assert.ok(start >= 0, `${fnName} is defined in ${MIGRATION_NAME}`);
  const rest = sql.slice(start);
  const end = rest.indexOf("$function$;");
  assert.ok(end > 0, `${fnName} has a terminated body`);
  return rest.slice(0, end);
}

// ── 1. The migration's load-bearing SQL properties ───────────────────────────────────────────────
function runMigrationShapeTests() {
  const files = readdirSync(path.join(process.cwd(), "supabase/migrations"));
  assert.ok(files.includes(MIGRATION_NAME), `${MIGRATION_NAME} is present in supabase/migrations`);

  const raw = readFileSync(MIGRATION, "utf8");
  const sql = strip(raw).toLowerCase();

  // A — THE HEADLINE. The freeze must be a no-op on an already-frozen period.
  const freeze = bodyOf(sql, "phx_freeze_even_split_roster");
  assert.match(
    freeze,
    /if exists\s*\([\s\S]*?from public\.sos_even_split_roster[\s\S]*?where r\.period = p_period[\s\S]*?\)\s*then\s*continue;/,
    "phx_freeze_even_split_roster must SKIP a period that is already frozen — without this guard a " +
      "later resignation retroactively re-splits published months",
  );

  // B — the raw import is never mutated. The whole point of applying the rule on read.
  for (const verb of ["update", "delete from", "insert into"]) {
    assert.ok(
      !new RegExp(`${verb}\\s+public\\.source_of_sales_import_rows`).test(sql),
      `the migration must never ${verb} public.source_of_sales_import_rows — the raw import stays a ` +
        "true record of what the distributor invoiced",
    );
  }

  // C — the Office weight base reads the ATTRIBUTED rows. This is what makes the Office allocation
  // place units on the post-redistribution geography instead of the pre-split one.
  const officeShare = bodyOf(sql, "phx_office_brick_share");
  assert.ok(
    officeShare.includes("phx_sos_rows_attributed"),
    "phx_office_brick_share must read phx_sos_rows_attributed, or the Office spread silently keeps " +
      "weighting on EZ's pre-split position",
  );
  assert.ok(
    !officeShare.includes("public.source_of_sales_import_rows"),
    "phx_office_brick_share must NOT read the raw import rows directly",
  );

  // D — the fact rollup is rebuilt from the attributed rows, so the split survives a refresh.
  const factRefresh = bodyOf(sql, "phx_refresh_sos_fact_rollup");
  assert.ok(
    factRefresh.includes("phx_sos_rows_attributed"),
    "phx_refresh_sos_fact_rollup must rebuild from phx_sos_rows_attributed — rebuilding from the raw " +
      "import rows is what erased the previous attempt at this rule",
  );

  // E — presence stays on the RAW rows on purpose: presence answers "did this customer buy at all",
  // and EZ is one customer in one place. Only the credit spreads.
  const presenceLeg = factRefresh.slice(factRefresh.indexOf("source_of_sales_customer_presence_rollup"));
  assert.ok(
    presenceLeg.includes("public.source_of_sales_import_rows"),
    "the customer-presence leg must keep reading the raw import rows — splitting presence would " +
      "report one warehouse as several customers",
  );

  // F — an unfrozen period must pass through untouched rather than lose its rows.
  const attributed = bodyOf(sql, "phx_sos_rows_attributed");
  assert.ok(
    /union all/.test(attributed),
    "phx_sos_rows_attributed must UNION the untouched rows with the exploded ones",
  );
  assert.ok(
    attributed.includes("where not t.is_split"),
    "phx_sos_rows_attributed must pass non-split rows through unchanged",
  );
}

// ── 2. Why the landing brick must be unique per area — driven through the REAL locked function ───
function runLandingBrickTests() {
  const priceOf = () => 1; // value == units here; the collapse is about geography, not price

  // The shape the roster produces: each area's slice on its OWN brick.
  const distinct: OfficeBrickShare[] = [
    { productCode: "P1", brickId: "B196-2", areaCode: "CA1", regionCode: "CA", units: 100 },
    { productCode: "P1", brickId: "B189-2", areaCode: "GZ2", regionCode: "GZ", units: 100 },
  ];
  const okWeights = buildOfficeAreaWeights(distinct, priceOf);

  assert.equal(okWeights.areaShare.get("CA1"), 0.5, "CA1 takes half the value");
  assert.equal(okWeights.areaShare.get("GZ2"), 0.5, "GZ2 takes half the value");
  for (const area of ["CA1", "GZ2"]) {
    const bricks = okWeights.brickWithinArea.get(area) ?? [];
    const total = bricks.reduce((acc, b) => acc + b.share, 0);
    assert.equal(bricks.length, 1, `${area} keeps its own brick`);
    assert.equal(total, 1, `${area}'s brick shares sum to exactly 1`);
  }

  // The shape a shared brick would produce — this is the corruption the roster design avoids.
  const shared: OfficeBrickShare[] = [
    { productCode: "P1", brickId: "B196-2", areaCode: "CA1", regionCode: "CA", units: 100 },
    { productCode: "P1", brickId: "B196-2", areaCode: "GZ2", regionCode: "GZ", units: 100 },
  ];
  const badWeights = buildOfficeAreaWeights(shared, priceOf);

  // Area VALUE is still split correctly — which is exactly why this is easy to miss.
  assert.equal(badWeights.areaShare.get("CA1"), 0.5, "the area shares still look right");
  assert.equal(badWeights.areaShare.get("GZ2"), 0.5, "the area shares still look right");

  // …but the brick detail has collapsed onto the first area, above 1.0.
  const ca1 = badWeights.brickWithinArea.get("CA1") ?? [];
  const gz2 = badWeights.brickWithinArea.get("GZ2") ?? [];
  const ca1Total = ca1.reduce((acc, b) => acc + b.share, 0);
  assert.ok(
    ca1Total > 1,
    `a brick shared across areas inflates the first area's within-area share past 1.0 (got ${ca1Total})`,
  );
  assert.equal(
    gz2.length,
    0,
    "the second area loses its brick detail entirely when the brick is shared — this is why every " +
      "roster row carries its own landing_brick_id",
  );
}

// ── 3. The even split itself: Σ slices === the original row, to the unit ─────────────────────────
// Mirrors the SQL: round(qty / n, 6) per slice, with the rounding residual carried by the first.
function splitEvenly(qty: number, n: number): number[] {
  const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const base = round6(qty / n);
  const slices = Array.from({ length: n }, () => base);
  slices[0] = round6(slices[0] + round6(qty - base * n));
  return slices;
}

function runSplitArithmeticTests() {
  // The real Feb–Jul divisors and unit totals, including the two that do not divide cleanly.
  const cases: Array<{ period: string; qty: number; n: number }> = [
    { period: "2026-02", qty: 2410, n: 5 },
    { period: "2026-03", qty: 152, n: 5 },
    { period: "2026-04", qty: 468, n: 6 },
    { period: "2026-05", qty: 1779, n: 7 },
    { period: "2026-06", qty: 3846, n: 8 },
    { period: "2026-07", qty: 2650, n: 8 },
  ];

  for (const { period, qty, n } of cases) {
    const slices = splitEvenly(qty, n);
    assert.equal(slices.length, n, `${period} splits across ${n} reps`);

    const total = Math.round(slices.reduce((acc, s) => acc + s, 0) * 1e6) / 1e6;
    assert.equal(total, qty, `${period}: the slices must sum back to ${qty} exactly`);

    // Every rep gets the same amount bar the sub-unit rounding residual on the first.
    const spread = Math.max(...slices) - Math.min(...slices);
    assert.ok(spread < 1e-5, `${period}: the split is even (spread ${spread})`);
  }

  // 1779 / 7 is the awkward one — 254.142857… — and must still tie to the unit.
  const may = splitEvenly(1779, 7);
  assert.equal(Math.round(may.reduce((a, b) => a + b, 0) * 1e6) / 1e6, 1779);
  assert.ok(may.every((s) => Math.abs(s - 254.142857) < 1e-5), "May lands at 254.142857 per rep");
}

export async function runSosEvenSplitEzTests() {
  runMigrationShapeTests();
  runLandingBrickTests();
  runSplitArithmeticTests();
}
