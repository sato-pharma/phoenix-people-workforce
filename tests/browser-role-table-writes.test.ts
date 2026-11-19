// The browser roles write no public table or view (19 Nov 2026), pinned.
//
// The 18 Nov 2026 Supabase audit (finding 6) found the signed-in browser role, `authenticated`,
// still holding INSERT, UPDATE and DELETE on 56 public tables and 7 public views — the residue of an
// older design in which the browser wrote those tables itself. The app writes every one of them
// through the server's service-role client; its one signed-in client (`rowSecurityClientFor`) only
// reads, and on production pg_stat_statements held 11,612 calls as `authenticated` since 1 Nov and
// not one write. Migration 20261119030931 revoked all 63 on both projects.
//
// Row-level security still guards those tables, so this is a second door, not the only one. What
// this suite stops is the door coming back unnoticed:
//   1. the production schema baseline (supabase/schema/production.sql, a dump refreshed after every
//      production apply and compared with production every night) holds no write grant on a public
//      table or view to `authenticated`, `anon` or PUBLIC;
//   2. no migration after 20261119030931 grants one;
//   3. the migration itself still lists the 63 objects and keeps its guard.
//
// The reads stay. `authenticated` keeps SELECT wherever it had it — the payroll and expense screens
// read through it when the person's Supabase session is on the request.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { stripSqlComments } from "./support/comment-strip.ts";

const MIGRATIONS_DIR = "supabase/migrations";
const REVOKE_MIGRATION = "20261119030931_revoke_authenticated_writes_on_public_tables_and_views.sql";
const REVOKE_VERSION = REVOKE_MIGRATION.slice(0, 14);
const BROWSER_ROLES = /^(authenticated|anon|public)$/i;
const WRITE_PRIVILEGE = /\b(insert|update|delete|truncate|all)\b/i;
// Objects a GRANT can name that are not a table or a view. `all <x> in schema` is read by the noun.
const NOT_A_TABLE = /^\s*(all\s+(functions|sequences|routines|procedures)\b|function|sequence|schema|type|domain|routine|procedure|language|large\s+object|foreign\s+data\s+wrapper|foreign\s+server|tablespace|database|parameter)\b/i;

/** Static GRANT statements in SQL that hand a table or view write to a browser role. */
export function browserTableWriteGrants(sql: string): string[] {
  const found: string[] = [];
  for (const m of stripSqlComments(sql).matchAll(/\bgrant\s+([^;]*?)\s+on\s+([^;]*?)\s+to\s+([^;]+)/gi)) {
    const [statement, privileges, object, grantees] = m;
    if (NOT_A_TABLE.test(object)) continue;
    if (!WRITE_PRIVILEGE.test(privileges)) continue;
    const roles = grantees.replace(/\bwith\s+grant\s+option\b/i, "").split(",").map((r) => r.trim().replace(/"/g, ""));
    if (roles.some((r) => BROWSER_ROLES.test(r))) found.push(statement.replace(/\s+/g, " ").trim());
  }
  return found;
}

function detectorTests(): void {
  for (const bad of [
    "grant insert on table public.salary_records to authenticated;",
    "GRANT ALL ON public.salary_records TO anon;",
    "grant select, update on all tables in schema public to authenticated;",
    "grant delete on table public.a, public.b to service_role, authenticated;",
    "grant truncate on public.x to public;",
    "alter default privileges in schema public grant insert on tables to authenticated;",
    'grant insert on table public.x to "authenticated";',
  ]) {
    assert.equal(browserTableWriteGrants(bad).length, 1, `must be refused: ${bad}`);
  }
  for (const fine of [
    "grant select on table public.salary_records to authenticated;",
    "grant execute on function public.current_access_is_hr() to authenticated;",
    "grant all on function public.f(text) to authenticated;",
    "grant usage, select on sequence public.s to authenticated;",
    "grant insert, update, delete on table public.x to service_role;",
    "revoke insert, update, delete on table public.x from authenticated;",
    "revoke grant option for insert on table public.x from authenticated;",
    "-- grant insert on table public.x to authenticated;",
    "grant usage on schema public to authenticated;",
  ]) {
    assert.deepEqual(browserTableWriteGrants(fine), [], `must be allowed: ${fine}`);
  }
}

function baselineTests(): void {
  const baseline = readFileSync("supabase/schema/production.sql", "utf8");
  const grants = [...baseline.matchAll(/^GRANT ([A-Z,]+) ON TABLE public\.([a-z_0-9]+) TO ([a-z_"]+);$/gm)];
  const browser = grants.filter((g) => BROWSER_ROLES.test(g[3].replace(/"/g, "")));
  // Not vacuous: the dump really does list the signed-in role's read grants, in this shape.
  assert.ok(browser.length >= 60, `expected the baseline's browser-role table grants in this shape, read ${browser.length}`);
  assert.ok(
    browser.some((g) => g[2] === "salary_records" && /\bSELECT\b/.test(g[1])),
    "the signed-in role must keep SELECT on salary_records — the payroll screens read through it",
  );
  const writes = browser.filter((g) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/.test(g[1])).map((g) => g[0]);
  assert.deepEqual(
    writes,
    [],
    "production grants a write on a public table or view to a browser role again. The app writes through the "
      + "service role; a signed-in write path needs its own reviewed migration, not a grant that slipped back.",
  );
}

function migrationHistoryTests(): void {
  const later = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{14}_.+\.sql$/.test(f) && f.slice(0, 14) > REVOKE_VERSION);
  const offenders: string[] = [];
  for (const file of later) {
    for (const statement of browserTableWriteGrants(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"))) {
      offenders.push(`${file}: ${statement}`);
    }
  }
  assert.deepEqual(offenders, [], "a migration after 20261119030931 grants a browser role a write on a table or view");
}

function revokeMigrationTests(): void {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, REVOKE_MIGRATION), "utf8");
  const code = stripSqlComments(sql);
  const objects = [...code.matchAll(/^\s*public\.([a-z_0-9]+),?\s*$/gm)].map((m) => m[1]);
  assert.equal(objects.length, 63, "the revoke covers the 56 tables and 7 views the audit found");
  assert.equal(new Set(objects).size, 63, "an object is listed twice");
  for (const view of ["v_employee_portal_payslips", "v_employee_portal_salary_history"]) {
    assert.ok(objects.includes(view), `the portal payroll view ${view} must be in the revoke`);
  }
  assert.equal((code.match(/\bfrom authenticated;/g) ?? []).length, 2, "both revokes name the signed-in role");
  assert.match(code, /raise exception 'browser roles still hold writes on public objects/, "the no-write guard stays");
  assert.match(code, /has_table_privilege\('authenticated', 'public\.' \|\| t, 'SELECT'\)/, "the reads-survive guard stays");
  assert.deepEqual(browserTableWriteGrants(sql), [], "the revoke migration grants nothing");
}

export function runBrowserRoleTableWritesTests(): void {
  detectorTests();
  baselineTests();
  migrationHistoryTests();
  revokeMigrationTests();
}
