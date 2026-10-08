import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { stripSqlComments } from "./comment-strip.ts";

/**
 * Finds the migration that LAST defines a function or a view, so a pin reads the SQL the database
 * actually runs.
 *
 * WHY THIS EXISTS. A pin that names a migration path reads DEAD SQL the moment a later migration
 * redefines the same object: it stays green while the live body does the opposite of what it asserts.
 * `tests/phoenix-crm-visit-dating.test.ts` worked this out for `phoenix_crm_save_visit` and three other
 * files then copied the loop. This is that loop, once.
 *
 * Migration file names are a sortable timestamp (`YYYYMMDDHHMMSS_slug.sql`) and the CLI applies them in
 * exactly that order, so the last match by name is the last one applied.
 */

const MIGRATIONS_DIR = "supabase/migrations";

/** Every migration whose body (comments stripped) matches, oldest first. */
function definersOf(pattern: RegExp): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => pattern.test(stripSqlComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))));
}

/** The path of the migration that last defines it. */
export function lastDefinerPath(pattern: RegExp, label: string): string {
  const files = definersOf(pattern);
  assert.ok(files.length > 0, `${label} must be defined by some migration`);
  return join(MIGRATIONS_DIR, files[files.length - 1]);
}

/** The whole last-defining migration, comments stripped. */
export function lastDefinerSql(pattern: RegExp, label: string): string {
  return stripSqlComments(readFileSync(lastDefinerPath(pattern, label), "utf8"));
}

/** The whole last-defining migration, comments INTACT — for a pin on its header or its comment statements. */
export function lastDefinerRaw(pattern: RegExp, label: string): string {
  return readFileSync(lastDefinerPath(pattern, label), "utf8");
}

/**
 * The live body of one `create or replace function`, from its header to its `$function$;` terminator.
 * A function defined more than once in that same file (a rare but legal shape) yields the last one.
 */
export function liveFunctionBody(name: string): string {
  const header = `create or replace function public.${name}(`;
  const sql = lastDefinerSql(new RegExp(`create or replace function public\\.${name}\\(`), name);
  const start = sql.lastIndexOf(header);
  assert.ok(start >= 0, `${name} must be redefined by its last definer`);
  const end = sql.indexOf("$function$;", start);
  assert.ok(end > start, `${name} must be closed with $function$;`);
  return sql.slice(start, end + "$function$;".length);
}

/** The last-defining migration of one view, comments stripped. */
export function liveViewSql(name: string): string {
  return lastDefinerSql(new RegExp(`create or replace view public\\.${name}\\s`), name);
}
