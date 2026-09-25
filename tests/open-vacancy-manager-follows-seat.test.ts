import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { stripSqlComments } from "./support/comment-strip.ts";

// Regression guard for "an open vacancy's manager is a COPY that goes stale".
//
// position_vacancies.manager_hr_id is what the Employee Master hands a new hire as Direct Manager.
// It was written once, when the vacancy opened, so the 2026-09-01 territory splits left the open
// Pedia Fayoum vacancy naming Taha (Giza) instead of Osama (Upper Egypt 1), and five more the same
// way. supabase/migrations/20260920131903_open_vacancy_manager_follows_organogram_seat.sql makes the
// organogram seat the single source: the manager is the occupant of the vacancy's PARENT seat, on
// every write to an open seated vacancy AND whenever au.seats or au.occupancy_history changes.
//
// This reads the migration text, the same technique as tests/au-hire-into-seat-wiring.test.ts.
// The behaviour itself was proved against staging and production inside a rolled-back transaction.
export function runOpenVacancyManagerFollowsSeatTests() {
  const dir = "supabase/migrations";
  const matches = readdirSync(dir).filter((f) => f.endsWith("_open_vacancy_manager_follows_organogram_seat.sql"));
  assert.equal(matches.length, 1, "exactly one migration carries the vacancy-manager-follows-seat rule");
  const sql = stripSqlComments(readFileSync(`${dir}/${matches[0]}`, "utf8"));

  function functionBody(name: string): string {
    const start = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "i"));
    assert.ok(start >= 0, `${name} is defined`);
    const open = sql.indexOf("$$", start);
    const close = sql.indexOf("$$", open + 2);
    assert.ok(open > 0 && close > open, `${name} has a dollar-quoted body`);
    return sql.slice(start, close + 2);
  }

  // 1. The manager is the occupant of the PARENT seat, and a vacant parent gives no answer at all.
  const seatManager = functionBody("phx_vacancy_seat_manager");
  assert.match(seatManager, /join\s+au\.v_org_tree\s+p\s+on\s+p\.seat_id\s*=\s*s\.parent_seat_id/i, "the manager comes from the PARENT seat");
  assert.match(seatManager, /p\.occupant_hr_id\s+is\s+not\s+null/i, "a vacant parent seat answers nothing, so the stored stand-in stays");
  assert.match(seatManager, /s\.region_name/i, "the region comes from the vacancy's own seat");

  // 2. The row trigger only ever touches an OPEN, SEATED vacancy, and only when the seat has a manager.
  const rowFn = functionBody("phx_vacancy_manager_from_seat");
  assert.match(rowFn, /<>\s*'open'\s+or\s+new\.seat_id\s+is\s+null\s+then\s+return\s+new/i, "filled, cancelled and seatless vacancies are left alone");
  assert.match(rowFn, /if\s+v\.manager_hr_id\s+is\s+null\s+then\s+return\s+new/i, "no seat manager means the stored manager is kept");
  assert.doesNotMatch(rowFn, /manager_replacement_for_hr_id/i, "the manager-replacement marker is never rewritten");
  assert.match(
    sql,
    /create\s+trigger\s+trg_position_vacancies_sync_manager_from_seat\s+before\s+insert\s+or\s+update\s+on\s+public\.position_vacancies\s+for\s+each\s+row/i,
    "every insert and update of a vacancy runs the row trigger",
  );
  // BEFORE triggers fire in name order, and trg_position_vacancies_stamp_seat stamps seat_id on INSERT first.
  assert.ok(
    "trg_position_vacancies_sync_manager_from_seat" > "trg_position_vacancies_stamp_seat",
    "the sync trigger sorts AFTER the seat-stamping trigger, so an inserted vacancy has its seat by then",
  );

  // 3. The organogram moving re-syncs the open vacancies, without ever blocking a hire or a departure.
  const syncFn = functionBody("phx_sync_open_vacancy_managers");
  assert.match(syncFn, /lower\(coalesce\(x\.status,\s*'open'\)\)\s*=\s*'open'/i, "only open vacancies are re-synced");
  assert.match(syncFn, /x\.seat_id\s+is\s+not\s+null/i, "only seated vacancies are re-synced");
  assert.doesNotMatch(syncFn, /manager_replacement_for_hr_id/i, "the sync never rewrites the manager-replacement marker");
  const afterOrgChange = functionBody("phx_sync_vacancy_managers_after_org_change");
  assert.match(afterOrgChange, /exception\s+when\s+others\s+then\s+raise\s+warning/i, "a failed sync warns; it never blocks an organogram write");
  for (const table of ["au.seats", "au.occupancy_history"]) {
    assert.match(
      sql,
      new RegExp(`create\\s+trigger\\s+\\w+\\s+after\\s+insert\\s+or\\s+update\\s+or\\s+delete\\s+on\\s+${table.replace(".", "\\.")}\\s+for\\s+each\\s+statement\\s+execute\\s+function\\s+public\\.phx_sync_vacancy_managers_after_org_change`, "i"),
      `a change to ${table} re-syncs the open vacancies`,
    );
  }

  // 4. Every SECURITY DEFINER function is closed to the browser roles.
  for (const [fn, args] of [
    ["phx_vacancy_seat_manager", "text"],
    ["phx_vacancy_manager_from_seat", ""],
    ["phx_sync_open_vacancy_managers", ""],
    ["phx_sync_vacancy_managers_after_org_change", ""],
  ] as const) {
    assert.match(
      sql,
      new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\(${args}\\)\\s+from\\s+public,\\s*anon,\\s*authenticated`, "i"),
      `${fn} revokes EXECUTE from public, anon and authenticated`,
    );
  }
}
