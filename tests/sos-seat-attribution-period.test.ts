import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Who gets credited for a month's sales.
//
// Owner ruling 2026-08-01: today's area→person wiring decides it, EXCEPT that a departed rep keeps
// the credit for months they actually worked. That is exactly
//     coalesce(occupant today, occupant at period end)
//
// The bug this replaces did not fail closed, it INVENTED an owner: au.f_seat_occupant_asof ordered
// by `(span covers p_asof) desc, effective_from asc limit 1`, so when no span covered the date it
// returned the EARLIEST occupant the seat ever had — a rep who never held it in that period, and
// possibly had not joined yet. Measured on production: firing on 100 of 525 area x period rows.

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

function migrationSource(fragment: string): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(fragment));
  assert.ok(file, `migration containing "${fragment}" must exist`);
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])--[^\n]*/g, "$1");
}

export function runSosSeatAttributionPeriodTests() {
  const sql = code(migrationSource("au_seat_occupant_todays_wiring"));

  // ── The invented-owner fallback must be gone ────────────────────────────────
  assert.ok(
    !/effective_from asc/.test(sql),
    "the earliest-ever fallback (`effective_from asc`) invents an owner and must not come back",
  );

  // ── Both arms of the ruling are present, in the right order ─────────────────
  const todayArm = sql.indexOf("oh.effective_from <= current_date");
  const periodArm = sql.indexOf("oh.effective_from <= p_asof");
  assert.ok(todayArm > 0, "arm 1 must resolve the occupant as of TODAY");
  assert.ok(periodArm > 0, "arm 2 must fall back to the occupant at the period end");
  assert.ok(
    todayArm < periodArm,
    "today's wiring must be the FIRST coalesce arm — reversing them would ignore transfers",
  );
  assert.match(sql, /select coalesce\(/, "the two arms must be combined with coalesce, not a union");

  // Exactly two arms. A third would reintroduce a guess.
  assert.equal(
    (sql.match(/from au\.occupancy_history oh/g) ?? []).length,
    2,
    "exactly two lookups: today, then period-end. Anything else is inventing an owner again.",
  );

  // Both arms must pick deterministically within their window.
  assert.equal(
    (sql.match(/order by oh\.effective_from desc/g) ?? []).length,
    2,
    "each arm needs a deterministic order, or two overlapping spans return an arbitrary person",
  );

  // ── CREATE OR REPLACE must re-declare what it silently drops ────────────────
  // This is the 20260728100500 regression class, and it bites harder here: losing SECURITY DEFINER
  // breaks every caller that has no direct access to au.occupancy_history.
  const fn = sql.slice(sql.indexOf("create or replace function au.f_seat_occupant_asof"));
  assert.match(fn, /security definer/i, "SECURITY DEFINER must be re-declared — the live function has it");
  assert.match(fn, /set search_path to 'au', 'public'/i, "search_path must be re-declared verbatim");
  assert.match(fn, /\bstable\b/i, "STABLE must be re-declared");
  assert.match(fn, /returns text/i, "the signature must not drift");
}
