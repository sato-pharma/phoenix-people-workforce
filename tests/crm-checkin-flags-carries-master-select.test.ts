import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { liveViewSql } from "./support/sql-definer.ts";

import { PHOENIX_VISIT_DETAIL_COLUMNS } from "../src/lib/crm/phoenix-visit-detail.ts";

/**
 * CRM Master's "Regular · No Check-in" and "Regular · DV No Check-in" tabs read `crm_visits_checkin_flags`
 * with the SAME `VISIT_SELECT` the other visit tabs send to `crm_visits_unified`. PostgREST fails the
 * WHOLE read on one missing column, so a column the page asks for and this view lacks is two dead tabs —
 * which is exactly what shipped on 8 Oct 2026 (#5499 widened the select; the view stayed frozen at 32
 * columns) and answered 42703 on every open until 20261021140001.
 *
 * This pins the CODE'S ASK against the view the database LAST defines. It reads both inside the function,
 * never at module load, so a break-and-watch run can change either file and see this fire.
 */

/** Every column CRM Master's `VISIT_SELECT` asks a visit view for. */
function visitSelectColumns(): string[] {
  const source = readFileSync("src/lib/crm/master.ts", "utf8");
  const start = source.indexOf("const VISIT_SELECT =");
  const end = source.indexOf("const CHECKIN_SELECT =", start);
  assert.ok(start >= 0 && end > start, "master.ts declares VISIT_SELECT, then CHECKIN_SELECT");
  // Comments are stripped from this one declaration only: a comment above `double2_*` names columns too.
  const declaration = stripComments(source.slice(start, end));
  const text = [...declaration.matchAll(/"([^"]*)"|\b(PHOENIX_VISIT_DETAIL_COLUMNS)\b/g)]
    .map((match) => (match[2] ? PHOENIX_VISIT_DETAIL_COLUMNS : match[1]))
    .join(" ");
  return text
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column.length > 0);
}

/** The output name of each select item of the flags view: `v.id` → `id`, `(…) as regular_no_checkin` → `regular_no_checkin`. */
function flagsViewColumns(sql: string): string[] {
  const create = sql.indexOf("create or replace view public.crm_visits_checkin_flags");
  assert.ok(create >= 0, "the last definer of crm_visits_checkin_flags creates it");
  const from = sql.search(/\bfrom\s+public\.crm_visits_unified\s+v\b/);
  const select = sql.slice(create).search(/\bselect\b/);
  assert.ok(select >= 0 && create + select < from, "the view selects from crm_visits_unified");
  return sql
    .slice(create + select + "select".length, from)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => /\bas\s+(\w+)\s*$/.exec(item)?.[1] ?? /\.(\w+)\s*$/.exec(item)?.[1] ?? item);
}

export function runCrmCheckinFlagsCarriesMasterSelectTests() {
  const asked = visitSelectColumns();

  // A parser that read nothing would pass every column below, so require the ask to be there first.
  assert.ok(asked.length >= 50, `VISIT_SELECT parsed to ${asked.length} columns — the parser, not the page, is wrong`);
  for (const column of ["double2_crm_id", "double2_hr_id", "double2_name", "visit_kind", "phoenix_synced_at", "raw_payload"]) {
    assert.ok(asked.includes(column), `VISIT_SELECT must ask for ${column}`);
  }

  const sql = liveViewSql("crm_visits_checkin_flags");
  const carried = new Set(flagsViewColumns(sql));
  assert.ok(carried.has("regular_no_checkin") && carried.has("has_checkin"), "the view keeps its two flags");

  const missing = asked.filter((column) => !carried.has(column));
  assert.deepEqual(
    missing,
    [],
    `crm_visits_checkin_flags lacks ${missing.length} column(s) CRM Master's VISIT_SELECT asks for (${missing.join(", ")}) — ` +
      "PostgREST fails the whole read on one missing column, so the Regular · No Check-in tabs would answer an error on every open",
  );

  // `create or replace view` replaces reloptions wholesale and the grants are the owner's: restating the
  // view must not drop either.
  assert.match(sql, /create or replace view public\.crm_visits_checkin_flags\s+with \(security_invoker = true\)/, "the view stays security_invoker");
  assert.match(sql, /revoke all on table public\.crm_visits_checkin_flags from anon, authenticated/, "the browser roles stay locked out of the view");
}
