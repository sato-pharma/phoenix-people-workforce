import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { liveViewSql } from "./support/sql-definer.ts";

// Performance audit, 19 Nov 2026: a door read that names a rep read the whole company's visits.
//
// Both CRM doors give a Phoenix row the agent coalesce(p.rep_hr_id, p.manager_hr_id). Until
// 20261119130738 no index carried that expression, so every read filtered on agent_hr_id read every
// visit in its date window and dropped the other reps' rows afterwards, and the Medical Rep landing's
// double-visit summary, which carried no date at all, read every visit in the table about 550 times a
// day. The index serves the doors only while its expression and predicate stay the doors' own, to the
// character, which is what this file holds.

const MIGRATIONS = "supabase/migrations";
const INDEX_FILE = "20261119130738_phoenix_crm_visits_agent_day_and_rep_day_indexes.sql";

const squash = (sql: string) => sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/** One `create or replace view` statement out of a migration, through its closing semicolon. */
function viewStatement(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace view public.${name}`);
  assert.ok(start >= 0, `${name} is created by its last definer`);
  const end = sql.indexOf(";", start);
  assert.ok(end > start, `${name} is closed`);
  return squash(sql.slice(start, end + 1));
}

/** A slice of a source file, from one marker to the next. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `${from} is still in the file`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `${to} still follows ${from}`);
  return source.slice(start, end);
}

export function runPhoenixCrmVisitsAgentIndexTests() {
  const index = squash(readFileSync(join(MIGRATIONS, INDEX_FILE), "utf8"));

  // 1. The index itself: the doors' agent expression, then the day, on real live visits only.
  const agentIndex = /create index if not exists phoenix_crm_visits_agent_day_idx on public\.phoenix_crm_visits \(\((.+?)\), visit_date\) where (.+?);/.exec(index);
  assert.ok(agentIndex, "the agent-day index is created on phoenix_crm_visits with an expression and a predicate");
  const [, expression, predicate] = agentIndex;
  assert.equal(expression, "coalesce(rep_hr_id, manager_hr_id)", "the index carries the doors' agent expression, nothing wrapped round it");
  assert.equal(predicate, "not is_test and imported_from_ireports360_at is null", "the predicate is the two filters both doors apply, so the planner can prove it");
  assert.ok(
    index.includes("create index if not exists phoenix_crm_visits_rep_day_idx on public.phoenix_crm_visits (rep_hr_id, visit_date);"),
    "the raw table's rep reads get (rep_hr_id, visit_date)",
  );

  // 2. Each door's Phoenix branch still says exactly what the index carries. A door that wraps the
  // expression (an upper(), a btrim()) or drops a filter keeps running and quietly loses the index.
  const doorExpression = expression.replace(/\b(rep_hr_id|manager_hr_id)\b/g, "p.$1");
  for (const door of ["crm_visits_unified", "crm_checkins_unified"]) {
    const view = viewStatement(liveViewSql(door), door);
    assert.ok(view.includes(`${doorExpression},`), `${door} still gives a Phoenix row the agent ${doorExpression}, the index's expression`);
    assert.ok(
      view.includes("where not p.is_test and p.imported_from_ireports360_at is null"),
      `${door}'s Phoenix branch still filters on the index's predicate, in the index's words`,
    );
  }

  // 3. Nothing later takes either index away.
  const later = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql") && file > INDEX_FILE);
  for (const file of later) {
    const sql = squash(readFileSync(join(MIGRATIONS, file), "utf8"));
    assert.ok(
      !/drop index (concurrently )?(if exists )?(public\.)?phoenix_crm_visits_(agent|rep)_day_idx/.test(sql),
      `${file} must not drop a rep index on phoenix_crm_visits`,
    );
  }

  // 4. The landing's double-visit summary carries a date floor: with none, it read every visit for
  // one rep, the shape that cost a full table read each time a Medical Rep opened the portal.
  const landing = between(readFileSync("src/lib/employee-portal/home-snapshot.ts", "utf8"), "const dvPromise", "const expensePromise");
  assert.match(landing, /queryVisitsLimited/, "the summary still reads through the CRM door");
  assert.match(landing, /dateFrom: `\$\{currentYear - 1\}-01-01`/, "the summary's door read starts on 1 January last year, the earlier-record window");

  // 5. The Super Admin typed-pharmacy report pages by keyset: an offset page walked the primary key
  // from the start again, 43,390 buffers a page on production.
  const typed = between(readFileSync("src/lib/customer-identity/server/reads.ts", "utf8"), "async function typedPharmacyCandidates", "const placeIds");
  assert.ok(!typed.includes(".range("), "the typed-pharmacy read never pages by offset");
  assert.match(typed, /\.gt\("id", after\)/, "each page starts after the last id of the one before");
  assert.match(typed, /came back without its id/, "a page without its last id throws rather than ending the read short");
}
