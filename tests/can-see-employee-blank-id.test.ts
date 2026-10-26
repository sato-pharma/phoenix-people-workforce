import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// public.current_access_can_see_employee() must never let a caller with no HR id match a row with
// no HR id (audit 2026-10-26, point 11).
//
// The body from the 2026-07-11 baseline compared `lower(coalesce(employee_hr_id, ''))` with
// `lower(coalesce(current_access_hr_id(), ''))`. With no session, or a signed-in account linked to
// no employee, both sides fell to '' and the answer was TRUE: called as `authenticated` on staging,
// (null, null) and ('', '') both returned true. 20261026120400 rewrote it; staging then returned
// false for every blank shape, kept own-row and manager matches for real users, and the function's
// ACL was unchanged.
//
// This pin reads the LATEST migration that defines the function, so a later rewrite that brings
// the blank-to-blank comparison back fails here — not on a database, months later, under a policy.
// Static: no database, no network.

const NAME = "current_access_can_see_employee";
const MIGRATIONS_DIR = "supabase/migrations";

function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

function definitions(): Array<{ file: string; body: string; header: string }> {
  const found: Array<{ file: string; body: string; header: string }> = [];
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = stripComments(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    const create = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+(?:"?public"?\\.)?"?${NAME}"?\\s*\\(`, "gi");
    let m: RegExpExecArray | null;
    while ((m = create.exec(sql)) !== null) {
      const rest = sql.slice(m.index);
      const open = rest.indexOf("$$");
      const close = open === -1 ? -1 : rest.indexOf("$$", open + 2);
      assert.ok(open !== -1 && close !== -1, `${file}: could not find the $$-quoted body of ${NAME}`);
      found.push({ file, header: rest.slice(0, open), body: rest.slice(open + 2, close) });
    }
  }
  return found;
}

export function runCanSeeEmployeeBlankIdTests() {
  const defs = definitions();
  assert.ok(defs.length >= 2, `expected the baseline and the 2026-10-26 fix to define ${NAME}; read ${defs.length}`);
  const latest = defs[defs.length - 1];
  const body = latest.body.replace(/\s+/g, " ").toLowerCase();
  const header = latest.header.replace(/\s+/g, " ").toLowerCase();

  // ── the hole must not come back ───────────────────────────────────────────
  assert.ok(
    !/coalesce\(\s*(?:public\.)?current_access_hr_id\(\)\s*,\s*''\s*\)/.test(body),
    `${latest.file}: ${NAME} turns a missing caller HR id into '' again — a caller with no HR id then ` +
      "matches every row with no HR id. Read the caller's id once and treat blank as null.",
  );
  assert.ok(
    !/coalesce\(\s*employee_(?:manager_)?hr_id\s*,\s*''\s*\)/.test(body),
    `${latest.file}: ${NAME} coalesces the ROW's HR id to '' again — the half of the comparison that ` +
      "makes a blank row match a blank caller.",
  );

  // ── the guard that replaced it ────────────────────────────────────────────
  assert.match(
    body,
    /btrim\(coalesce\(raw\.hr_id, ''\)\) = '' then null/,
    `${latest.file}: the caller's HR id must be read once, and a blank one must become null`,
  );
  assert.match(body, /me\.hr_id is not null/, `${latest.file}: the id and manager branches must require a caller HR id`);
  assert.match(
    body,
    /^ select coalesce\(.*, false \) from/,
    `${latest.file}: the whole answer must be wrapped in coalesce(..., false) so it can never be NULL`,
  );
  assert.match(
    body,
    /public\.current_access_can_manage_employees\(\) or/,
    `${latest.file}: the manage-employees branch must stay first and untouched`,
  );
  assert.match(
    body,
    /current_access_scope\(\) in \('team', 'hierarchy'\)/,
    `${latest.file}: the manager branch must stay limited to TEAM and HIERARCHY scope`,
  );

  // ── same function, same door ──────────────────────────────────────────────
  assert.match(header, /security definer/, `${latest.file}: ${NAME} must stay SECURITY DEFINER`);
  assert.match(header, /\bstable\b/, `${latest.file}: ${NAME} must stay STABLE`);
  assert.match(header, /set search_path to 'public'/, `${latest.file}: ${NAME} must keep search_path pinned to public`);

  const fileSql = stripComments(readFileSync(path.join(MIGRATIONS_DIR, latest.file), "utf8")).replace(/\s+/g, " ").toLowerCase();
  assert.match(
    fileSql,
    /revoke execute on function public\.current_access_can_see_employee\(text, text\) from public;/,
    `${latest.file}: the rewrite must revoke EXECUTE from PUBLIC (check-migrations rule 4)`,
  );
  assert.match(
    fileSql,
    /grant execute on function public\.current_access_can_see_employee\(text, text\) to authenticated, service_role;/,
    `${latest.file}: authenticated keeps EXECUTE — the live policies and the phase 25/26 smokes need it ` +
      "(tests/access-helper-execute-grant-lock.test.ts)",
  );
  assert.match(
    fileSql,
    /refusing: a caller with no hr id still matches a row with no hr id/,
    `${latest.file}: the apply-time assertion that the blank-to-blank case answers false must stay`,
  );
}
