import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The leaflet is TWO materials, and only the new artwork carries a formula line.
 *
 * The owner settled it on 2026-10-06: "split the leaflet into old and new and track both". EGPI had
 * reported a single figure of 78,250 leaflets, which its own note already described as 68,250 old
 * across two lots plus 10,000 new — two artworks counted as one item, with no composition row at
 * all, so the leaflet appeared in the stock tab and contributed nothing to any buy list.
 *
 * Splitting them is only meaningful because they are NOT interchangeable: an old-artwork leaflet
 * cannot go into a new box. So the requirement lands on `LEAFLET_NEW` — one per packaging set,
 * samples included, exactly like the carton and the sticker it goes in with — and `LEAFLET_OLD` is
 * tracked stock with no formula line, visible but never counted as cover.
 *
 * What this test exists to stop: giving `LEAFLET_OLD` a composition row. That is the one edit that
 * looks tidy and is wrong — two leaflet lines at one per packaging set would double the leaflet
 * requirement on every plan, and 68,250 pieces of superseded artwork would start covering new
 * production. It is a silent wrong number: every figure on the row still looks ordinary.
 *
 * The engine half needs no new fixture — `tests/production-planning-engine.test.ts` already pins
 * that a material with no composition answers `excludedReason: "no_composition"` with cover `null`
 * rather than a zero, which IS the old leaflet's whole safety property.
 */
export function runProductionPlanningLeafletSplitTests() {
  const migration = readFileSync(
    "supabase/migrations/20261006120001_production_planning_leaflet_split.sql",
    "utf8",
  );

  // --- Both materials exist, and the combined one is retired rather than deleted --------------
  for (const code of ["LEAFLET_NEW", "LEAFLET_OLD"]) {
    assert.ok(migration.includes(`'${code}'`), `${code} must be created by the split migration`);
  }
  assert.match(
    migration,
    /update prodplan_materials\s+set is_active = false,[\s\S]*?where code = 'LEAFLET' and is_active/,
    "the combined LEAFLET material must be deactivated, so it stops appearing beside its own halves",
  );
  assert.doesNotMatch(
    migration,
    /delete\s+from\s+prodplan_(materials|stock_entries|compositions)/i,
    "nothing is deleted: the stock table is append-only and EGPI's original report is the evidence",
  );

  // --- The halves add up to exactly what the factory reported --------------------------------
  assert.ok(migration.includes("68250"), "the old artwork's 68,250 pieces must be carried over");
  assert.ok(migration.includes("10000"), "the new artwork's 10,000 pieces must be carried over");
  assert.equal(68_250 + 10_000, 78_250, "the two halves must equal EGPI's single reported figure");
  assert.match(
    migration,
    /qty, as_of_date, source, note\)\s*\nselect m\.id, m\.unit_kind, l\.id, 0, date '2026-10-06', 'adjustment'/,
    "the retired material must be closed at zero, or a later reactivation double-counts the same pieces",
  );

  // --- Exactly ONE leaflet composition row, and it is the new artwork ------------------------
  const compositionInsert = migration.slice(migration.indexOf("insert into prodplan_compositions"));
  assert.ok(compositionInsert.length > 0, "the split must give the new leaflet its formula line");
  assert.match(
    compositionInsert,
    /'per_packaging_set', 1, 'sato'/,
    "one per packaging set, supplied by Sato — the same line the carton and the sticker carry",
  );
  assert.match(
    compositionInsert,
    /m\.code = 'LEAFLET_NEW'/,
    "the requirement must land on the NEW artwork",
  );
  assert.doesNotMatch(
    compositionInsert,
    /LEAFLET_OLD/,
    "LEAFLET_OLD must never get a composition row: two leaflet lines double the requirement and the old artwork would start covering new production",
  );
  assert.equal(
    (migration.match(/insert into prodplan_compositions/g) ?? []).length,
    1,
    "exactly one composition row is added by this split",
  );

  // --- `shared_unsettled` would re-block plan commits, which is the trap just cleared -------
  assert.doesNotMatch(
    compositionInsert,
    /shared_unsettled/,
    "a shared_unsettled leaflet line would make prodplan_plan_lines refuse every commit — the same wall potassium sorbate hit",
  );
}
