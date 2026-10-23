import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * PostgREST connects as `authenticator`, which preloads `safeupdate`, and `safeupdate` refuses any
 * DELETE or UPDATE with no WHERE clause. A direct SQL session (psql / the SQL editor / the Supabase
 * MCP) preloads `supautils` alone, so an unqualified delete inside a function body succeeds every
 * time it is run by hand and dies the first time the app reaches it over HTTP.
 *
 * It has cost two production incidents:
 *
 *   2026-08-29  phx_refresh_expense_claims() — four unqualified deletes; the hourly expense-claims
 *               refresh failed on its very first PostgREST call.
 *   2026-10-23  crm_person_by_hr_key_rebuild() — one unqualified delete, reached from an AFTER
 *               STATEMENT trigger on `employees`, so EVERY employee write the app made died with
 *               it. A candidate's joining form was refused at 13:11:46 Cairo with no record created.
 *
 * Both were fixed the same way, with `where true`. This test is what stops the third one: it reads
 * the LATEST definition of every function in the migration history and refuses an unqualified
 * DELETE or UPDATE in it. Latest-definition-only is deliberate — a migration that installed the
 * defect stays on disk for ever, and the migration that repaired it is the one that counts.
 */
const MIGRATIONS_DIR = join(import.meta.dirname ?? ".", "..", "supabase", "migrations");

/**
 * Functions nothing calls over PostgREST, left as they are on purpose. Each needs the reason it is
 * safe, not merely a wish that it were.
 */
const ALLOWED: Record<string, string> = {
  // `public.phx_admin_reset_module_data` was allow-listed here on 2026-10-23 because it failed
  // closed on a wholesale delete and re-arming a destructive path was the owner's call, not a side
  // effect of an incident fix. He made that call the same day — "fix the admin Reset module data
  // deletes" — so the function was rewritten to delete one batch at a time with a WHERE clause on
  // every statement, and the entry is gone. This test now enforces that repair instead of excusing
  // its absence. `tests/admin-reset-module-data.test.ts` pins the rest of the shape.
  // Hand-run backfill, never called from the app, and a direct SQL session does not preload
  // safeupdate.
  "public.phx_backfill_sos_customer_directory_rollup":
    "hand-run backfill, never reached over PostgREST",
  // Found when the detector learned to read `execute` strings (23 Oct 2026): its wholesale
  // `execute format('delete from %I.%I', …)` empties the table it then refills from a snapshot.
  // It is the disaster-recovery restore, run by hand in a SQL session exactly as
  // docs/security/recovery-snapshots.md shows, where safeupdate is not loaded. Nothing in the app,
  // scripts or workflows calls it. If anything ever calls it over PostgREST, it needs `where true`
  // first — this entry does not make that path safe.
  "recovery.restore_table":
    "hand-run disaster-recovery restore (docs/security/recovery-snapshots.md), never reached over PostgREST",
};

type FunctionBody = { body: string; file: string; name: string };

/** Strip `--` line comments so a `;` or the word `where` inside one cannot be read as SQL. */
function withoutLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** The latest `create [or replace] function` body per qualified name, migrations read in order. */
export function latestFunctionBodies(files: Array<{ name: string; sql: string }>): Map<string, FunctionBody> {
  const latest = new Map<string, FunctionBody>();
  const header = /create\s+(?:or\s+replace\s+)?function\s+("?[a-z0-9_]+"?(?:\."?[a-z0-9_]+"?)?)\s*\(/gi;

  for (const file of files) {
    const sql = withoutLineComments(file.sql);
    for (let match = header.exec(sql); match; match = header.exec(sql)) {
      const openQuote = /\$([a-z0-9_]*)\$/i.exec(sql.slice(match.index));
      if (!openQuote) continue;
      const tag = `$${openQuote[1]}$`;
      const bodyStart = match.index + (openQuote.index ?? 0) + tag.length;
      const bodyEnd = sql.indexOf(tag, bodyStart);
      if (bodyEnd < 0) continue;

      const bare = match[1].replace(/"/g, "").toLowerCase();
      const name = bare.includes(".") ? bare : `public.${bare}`;
      latest.set(name, { body: sql.slice(bodyStart, bodyEnd), file: file.name, name });
    }
  }

  return latest;
}

/**
 * Split a function body into statements on `;`, ignoring semicolons inside single-quoted strings.
 * A naive `body.split(";")` cuts `' (matched on area/line/position; the box had no manager)'` in
 * half and reports the WHERE-bearing tail as a separate statement — which read as two unqualified
 * updates in `phx_autofill_replacement_vacancy_for_employee` that do not exist.
 */
export function splitStatements(body: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;

  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (inString) {
      current += char;
      if (char === "'") inString = body[i + 1] === "'" ? (current += body[++i], true) : false;
      continue;
    }
    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }
    if (char === ";") {
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  statements.push(current);
  return statements;
}

/**
 * The unqualified DELETE/UPDATE statements in one function body, in source order.
 *
 * A statement is not matched from the start of its chunk: plpgsql block keywords carry no
 * semicolon, so the very first statement of a body arrives as `begin delete from …` — which is
 * exactly the shape both 2026-10-23 rebuilds had. The keyword is found anywhere in the chunk and
 * the tail after it is what must carry a WHERE.
 */
/**
 * The target of a DELETE or UPDATE: an optional `only`, then anything up to whitespace — so a
 * quoted `"name"`, a `%I` format slot and the `'` that closes an `execute` string all count. Three
 * shapes the first version missed (review of #6346, 23 Oct 2026), each proven by running its own
 * patterns: an ALIASED update (`update public.crm_contacts c set …`, the commonest update shape in
 * this repo), `update only`, and the same statements built as a string for `execute`.
 */
const WRITE_TARGET = String.raw`(?:only\s+)?(?!set\b|only\b)[^\s;(]+`;
/** `update t c set` / `update t as c set` — never the word `set` or `where` itself. */
const UPDATE_ALIAS = String.raw`(?:\s+(?:as\s+)?(?!set\b|where\b)[a-z_][a-z0-9_]*)?`;
// A quote or a parenthesis may precede the keyword: `execute 'delete from …'`, `format('update …`.
const DELETE_WRITE = new RegExp(String.raw`(?:^|[\s'(])(delete\s+from\s+${WRITE_TARGET})(.*)$`, "i");
// `update <target> [alias] set` only — `insert … on conflict do update set` has no target there.
const UPDATE_WRITE = new RegExp(String.raw`(?:^|[\s'(])(update\s+${WRITE_TARGET}${UPDATE_ALIAS}\s+set)(.*)$`, "i");

export function unqualifiedWrites(body: string): string[] {
  const found: string[] = [];
  for (const statement of splitStatements(body)) {
    const trimmed = statement.replace(/\s+/g, " ").trim();
    const write = DELETE_WRITE.exec(trimmed) ?? UPDATE_WRITE.exec(trimmed);
    if (!write) continue;
    if (/\bwhere\b/i.test(write[2])) continue;
    found.push(`${write[1]}${write[2]}`.replace(/\s+/g, " ").trim().slice(0, 120));
  }
  return found;
}

export function runFunctionBodiesNeedAWhereClauseTests() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));

  assert.ok(files.length > 100, `expected the migration history, read ${files.length} files`);

  const offenders: string[] = [];
  for (const fn of latestFunctionBodies(files).values()) {
    if (fn.name in ALLOWED) continue;
    for (const statement of unqualifiedWrites(fn.body)) {
      offenders.push(`${fn.name} (${fn.file}): ${statement}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "safeupdate is preloaded on PostgREST's `authenticator` role, so an unqualified DELETE or UPDATE " +
      "inside a function body works by hand and 400s the moment the app reaches it. Add `where true` " +
      "— semantically identical, and it is how 20260829190000 and 20261023154500 were both fixed. " +
      `Offending statements:\n  ${offenders.join("\n  ")}`,
  );

  // The two 2026-10-23 rebuilds are the reason this test exists: prove it reads them, and reads the
  // REPAIRED body rather than the one the original migration installed.
  const latest = latestFunctionBodies(files);
  for (const name of ["public.crm_person_by_hr_key_rebuild", "public.phoenix_crm_rep_entry_days_rebuild"]) {
    const fn = latest.get(name);
    assert.ok(fn, `${name} should be read out of the migration history`);
    assert.match(fn.body, /delete\s+from\s+\S+\s+where\s+true/i, `${name} must keep its \`where true\``);
  }

  // And prove the detector itself fires, so an empty offender list means "clean", not "blind".
  assert.deepEqual(unqualifiedWrites("begin\n  delete from public.a_cache;\nend"), [
    "delete from public.a_cache",
  ]);
  assert.deepEqual(unqualifiedWrites("begin\n  update public.a set b = 1;\nend"), [
    "update public.a set b = 1",
  ]);
  // The three shapes the first version of this detector could not see (review of #6346).
  assert.deepEqual(unqualifiedWrites("begin\n  update public.crm_contacts c set x = 1;\nend"), [
    "update public.crm_contacts c set x = 1",
  ], "an ALIASED update is still an update");
  assert.deepEqual(unqualifiedWrites("begin\n  update public.crm_contacts as c set x = 1;\nend"), [
    "update public.crm_contacts as c set x = 1",
  ]);
  assert.deepEqual(unqualifiedWrites("begin\n  update only public.a set b = 1;\nend"), [
    "update only public.a set b = 1",
  ], "`update only` is still an update");
  assert.deepEqual(unqualifiedWrites("begin\n  execute format('delete from %I', t);\nend"), [
    "delete from %I', t)",
  ], "a delete built as a string for `execute` is still a delete");
  assert.deepEqual(unqualifiedWrites("begin\n  update public.crm_contacts c set x = 1 where c.id = 2;\nend"), []);
  assert.deepEqual(unqualifiedWrites("begin\n  execute format('delete from %I where id = $1', t) using 1;\nend"), []);
  assert.deepEqual(unqualifiedWrites("begin\n  perform 1 from public.a for update skip locked;\nend"), []);
  assert.deepEqual(unqualifiedWrites("begin\n  delete from public.a_cache where true;\nend"), []);
  assert.deepEqual(unqualifiedWrites("begin\n  update public.a set b = 1 where id = 2;\nend"), []);
  assert.deepEqual(
    unqualifiedWrites("insert into public.a (b) values (1) on conflict (b) do update set b = 2;"),
    [],
    "an `on conflict do update` carries its own target row and is not an unqualified UPDATE",
  );
  assert.deepEqual(
    unqualifiedWrites("begin\n  update public.a set note = 'one; two' where id = 1;\nend"),
    [],
    "a semicolon inside a string literal does not end the statement — splitting on it reported the " +
      "WHERE-bearing tail as a second, unqualified update in two real vacancy functions",
  );
}
