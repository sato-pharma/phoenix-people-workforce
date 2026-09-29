import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * A migration that drops a column must not read that column unguarded.
 *
 * 🔴 WHY. Taking a pre-image before a `drop column` is the right habit — it is what made today's
 * four label drops reversible. But `create table ... as select ... <col>` references the column at
 * PARSE time, and a missing column is a 42703 that fails the whole statement. `drop column` can say
 * IF EXISTS; a select cannot. So the file works exactly once, on the database that still has the
 * column, and fails on every other one:
 *
 *   - applying 20260929183000 to STAGING on 2026-09-29 errored with `column "team_name" does not
 *     exist` — staging's employees carries line_name and team_id but none of the other three, so it
 *     had diverged from production in both directions;
 *   - replaying the same statement against PRODUCTION after the drop errors identically, which is
 *     what any freshly built environment would hit.
 *
 * The fix is a DO block that checks information_schema and EXECUTEs the create only when the column
 * is there — verified on production: it parses, runs, and creates nothing when the column is gone.
 *
 * This scan is deliberately narrow: only migrations that DROP a column, and only the
 * `create table ... as select` shape, which is the one that reads a doomed column by name.
 */

const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url);

export function runMigrationPreimageGuardedTests() {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql"));
  // A filter that matches nothing reports a clean repo it never looked at.
  assert.ok(files.length > 50, `expected the migrations directory, found ${files.length} files`);

  const offenders: string[] = [];
  let dropMigrations = 0;

  for (const file of files) {
    const text = readFileSync(new URL(file, MIGRATIONS), "utf8")
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");

    if (!/alter\s+table[\s\S]{0,120}?drop\s+column/i.test(text)) continue;
    dropMigrations += 1;

    for (const match of text.matchAll(/create\s+table[\s\S]{0,120}?\bas\b\s*\n?\s*select/gi)) {
      const before = text.slice(Math.max(0, match.index - 200), match.index);
      // Guarded means the create is inside an EXECUTE, which defers parsing until it is known the
      // column exists. A bare create is parsed when the file is read, column present or not.
      if (!/execute\s+\$/i.test(before)) {
        offenders.push(`${file}: ${match[0].replace(/\s+/g, " ").slice(0, 70)}`);
      }
    }
  }

  // The scan must have found the migrations it is meant to police.
  assert.ok(
    dropMigrations >= 2,
    `expected to find migrations that drop a column, found ${dropMigrations} — the scan is not ` +
      "reaching them, so an empty offender list would prove nothing",
  );

  assert.deepEqual(
    offenders,
    [],
    "a migration takes a pre-image of a column it then drops, without guarding the read. That file " +
      "works once and fails on every database that no longer has the column — a fresh environment, " +
      "a replay, or staging, which had already diverged. Wrap the create in a DO block that checks " +
      `information_schema and EXECUTEs it: ${offenders.join(" | ")}`,
  );
}
