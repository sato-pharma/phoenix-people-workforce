/**
 * Fails when a .sql file snapshots data into a table in `public`.
 *
 * Why this exists: on 2026-07-30 and 2026-08-01 three ad-hoc backup tables shipped into
 * `public` carrying login IDs, emails, agent names and visit dates. `public` is the only
 * schema PostgREST exposes, and Supabase's default privileges grant `anon` SELECT on new
 * tables there, so each one was readable by anyone holding the public anon key until RLS
 * was enabled by hand. The schema-shape monitor caught all three — but only after they
 * were already live in production. This catches the same mistake in review, before it
 * reaches any database.
 *
 * The fix is never "enable RLS on the backup table". It is to put the snapshot in a
 * dated schema of its own, which PostgREST does not expose and `anon` has no USAGE on:
 *
 *   create schema if not exists crm_restamp_backup_20260801;
 *   revoke all on schema crm_restamp_backup_20260801 from anon, authenticated;
 *   create table crm_restamp_backup_20260801.visits as select ...;
 *
 * That is the pattern the SoS work already used on 2026-07-28 (`sos_backup_20260728`,
 * `sos_merge_undo_20260728`, and two more) — 41 tables, none of them ever exposed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "node:fs/promises";

import { looksLikeSnapshot } from "./lib/snapshot-name.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// The two-tier name rule used to live here. It moved to scripts/lib/snapshot-name.ts on
// 2026-08-30 when check-schema-shape.ts began applying the SAME rule to the live database —
// this check can only see snapshots that arrive as a `.sql` file, and every one found in
// production `public` that day had been created by hand through MCP execute_sql instead.
// Two checks with two private copies of "what a snapshot looks like" would drift, so there
// is now exactly one definition and both import it.

/**
 * Already-shipped history. These ran once against a database that no longer takes them, and
 * they must not be edited — flagging them forever would only teach people to ignore the check.
 * New work goes in `supabase/migrations/` or a loose `supabase/*.sql` script, both of which
 * ARE scanned.
 */
const NOT_SCANNED = [
  /^supabase\/_migrations_archive\//,
  // The production schema baseline (docs/schema-baseline.md) is a pg_dump of what production HOLDS,
  // regenerated, never run. A table created there by hand shows up in it; this check judging the dump
  // would fail the PR that writes production down, not the hand that made the table. That table is the
  // live check's to report: check-schema-shape.ts's snapshot_table_in_public reads production itself.
  /^supabase\/schema\/production\.sql$/,
];

/**
 * `create table [if not exists] public.foo_backup_20260801` — with or without the schema
 * qualifier, since an unqualified name lands in `public` too (search_path is `public` by
 * default here, and every offender so far wrote it out explicitly).
 */
const CREATE_TABLE =
  /create\s+(?:unlogged\s+|temp\s+|temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:(["\w]+)\s*\.\s*)?(["\w]+)/gi;

export type Misplacement = { file: string; line: number; table: string; statement: string };

const unquote = (s: string) => s.replace(/"/g, "");

/**
 * Strips `--` line comments and `/* *\/` block comments so a documented example or a
 * commented-out historical statement never trips the check. Dollar-quoted bodies are left
 * alone: a `create table` inside a `do $$ ... $$` block is still a real create.
 */
export function stripSqlComments(sql: string): string {
  // Replace comment characters with spaces rather than deleting them, so line numbers and
  // column offsets survive — the reported line must match the file the author is looking at.
  const blanked = sql.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return blanked.replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}

/**
 * Pure and file-system free so it can be unit tested against the exact statements that
 * caused the two production exposures.
 */
export function findMisplacedBackupTables(sql: string, file: string): Misplacement[] {
  const scrubbed = stripSqlComments(sql);
  const found: Misplacement[] = [];

  for (const match of scrubbed.matchAll(CREATE_TABLE)) {
    const schema = match[1] ? unquote(match[1]).toLowerCase() : "public";
    const table = unquote(match[2]);
    if (schema !== "public") continue;
    if (!looksLikeSnapshot(table)) continue;

    found.push({
      file,
      line: scrubbed.slice(0, match.index).split("\n").length,
      table: `${schema}.${table}`,
      statement: match[0].replace(/\s+/g, " "),
    });
  }

  return found;
}

async function main() {
  const files: string[] = [];
  for await (const f of glob("supabase/**/*.sql", { cwd: REPO_ROOT })) {
    const rel = f.replace(/\\/g, "/");
    if (NOT_SCANNED.some((re) => re.test(rel))) continue;
    files.push(rel);
  }
  files.sort();

  const violations: Misplacement[] = [];
  for (const file of files) {
    // `file` is already repo-relative with forward slashes; re-deriving it via relative()
    // would resolve against process.cwd() instead of REPO_ROOT and mangle the reported path.
    const sql = readFileSync(resolve(REPO_ROOT, file), "utf8");
    violations.push(...findMisplacedBackupTables(sql, file));
  }

  if (violations.length > 0) {
    console.error("[sql-backup-placement] FAILED — snapshot tables created in `public`:");
    for (const v of violations) console.error(`  ${v.file}:${v.line}: ${v.table} — ${v.statement}`);
    console.error(
      "\n`public` is the schema PostgREST exposes and where Supabase grants `anon` SELECT by" +
        " default, so a snapshot there is readable with the public anon key until someone" +
        "\nremembers to enable RLS. Put it in a dated schema of its own instead:" +
        "\n\n  create schema if not exists <domain>_backup_YYYYMMDD;" +
        "\n  revoke all on schema <domain>_backup_YYYYMMDD from anon, authenticated;" +
        "\n  create table <domain>_backup_YYYYMMDD.<name> as select ...;" +
        "\n\nSee docs/security/backup-table-placement.md.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[sql-backup-placement] OK — scanned ${files.length} SQL files, no snapshot tables in \`public\`.`);
}

// Only run the CLI when invoked directly, so the unit test can import the pure functions.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("[sql-backup-placement] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
