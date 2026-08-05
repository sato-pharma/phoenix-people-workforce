import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";

// The organogram seat model (au.seats + au.occupancy_history) is the source of truth for org
// structure, but until 2026-08-05 NOTHING outside the `au` schema referenced a seat: neither
// position_vacancies nor employees had a seat column, verified against information_schema. Every
// link was re-derived by matching line + area + manager + job_title TEXT, every time. That single
// omission is the shared root of three separate production failures:
//
//   * duplicate open vacancies (8 rows over 6 seats) — "duplicate" is undefinable without a seat;
//   * hires that never reached a seat (CN-0006, PD-0007) — the chain GUESSED via text tiers;
//   * a vacancy for a seat that does not exist (VAC-PEDIA-CAIRO-DOWNTOWN-SHOUBRA-MR: a Pedia rep
//     for Down town, an area only CNS staffs).
//
// These are source-text guards over the migration (same style as
// reconcile-stale-vacancy-area-guard.test.ts): the behavioural proof is the rolled-back staging
// reproduction, but this fails fast in CI if the linkage is ever loosened back into text matching.

function migrationSource(prefix: string): string {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const file = readdirSync(dir).find((name) => name.startsWith(prefix));
  assert.ok(file, `expected migration ${prefix}* to exist`);
  return readFileSync(new URL(file!, dir), "utf8");
}

export function runVacancySeatLinkageTests() {
  const sql = migrationSource("20260805020000_");

  // ── The foreign key itself — the whole point ────────────────────────────────
  assert.match(
    sql,
    /add column if not exists seat_id text/i,
    "position_vacancies must carry the seat it recruits for",
  );
  assert.match(
    sql,
    /foreign key \(seat_id\) references au\.seats\(seat_id\)/i,
    "seat_id must be a real FOREIGN KEY into au.seats — a loose text column would drift exactly like the columns it replaces",
  );

  // ── Duplicates become structurally impossible, not merely discouraged ───────
  assert.match(
    sql,
    /create unique index if not exists position_vacancies_one_open_per_seat[\s\S]*?on public\.position_vacancies \(seat_id\)[\s\S]*?where seat_id is not null and lower\(coalesce\(status, 'open'\)\) = 'open'/i,
    "at most ONE open vacancy per seat must be enforced by a partial unique index — a trigger alone can be bypassed and cannot fix a race",
  );

  // ── The backfill must never guess ───────────────────────────────────────────
  assert.match(
    sql,
    /\) = 1\s*\n?\s*\) as resolved/i,
    "the backfill must only claim a seat when EXACTLY ONE matches; an ambiguous row must be left NULL rather than guessed",
  );

  // ── Route 0: the hire resolves from the seat, before any text matching ──────
  const trigger = sql.slice(sql.indexOf("create or replace function public.phx_hire_into_seat_on_vacancy_filled"));
  const routeZero = trigger.indexOf("v_resolved_by := 'vacancy_seat_id'");
  const predecessorRoute = trigger.indexOf("v_resolved_by := 'predecessor_seat'");
  const lineAreaRoute = trigger.indexOf("v_resolved_by := 'line_area_match'");
  assert.ok(routeZero > 0, "the hire chain must resolve the seat from vacancy.seat_id");
  assert.ok(
    routeZero < predecessorRoute && routeZero < lineAreaRoute,
    "vacancy.seat_id must be tried FIRST — the text-matching tiers exist only for seat-less manager/head-office rows, and letting them run first would reintroduce the guessing this replaces",
  );

  // ── The already-seated guard from 20260804190000 must survive this rewrite ──
  assert.match(
    trigger,
    /au_seat_hire_blocked/,
    "the rewritten trigger must keep the already-seated guard — dropping it would let the 2026-08-01 double-seating recur",
  );

  // ── A resignation-opened vacancy inherits the seat being vacated ────────────
  assert.match(
    sql,
    /create or replace function public\.phx_stamp_vacancy_seat_from_predecessor/i,
    "a vacancy opened for a departing employee must inherit their seat, so the replacement needs no text matching at all",
  );
  assert.match(
    sql,
    /if v_seat_id is not null and not exists \([\s\S]*?lower\(coalesce\(pv\.status, 'open'\)\) = 'open'[\s\S]*?\) then\s*\n?\s*new\.seat_id := v_seat_id;/i,
    "the stamp must skip a seat that already has an open vacancy, or it would trip the one-open-per-seat index and break the resignation flow",
  );

  // ── The au schema must not be touched: structure is not the hiring ledger's to edit ──
  const auWrites = sql.match(/\b(insert\s+into|update|delete\s+from|alter\s+table|drop\s+table)\s+au\./gi);
  assert.equal(
    auWrites,
    null,
    `the vacancy migration must never write to the au schema — the organogram is fixed structure, separate from employee movement (found: ${auWrites?.join(", ")})`,
  );
}
