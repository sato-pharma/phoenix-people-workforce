import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every column the sync writes to `ireports360_visits_sync_runs` must actually exist in the schema.
 *
 * WHY THIS IS ITS OWN GUARD. That update is what marks a run `"success"`. If it names a column the
 * database does not have, PostgREST rejects the whole statement — so the sync writes all its visit
 * rows correctly and then reports itself as FAILED, and the digest pages someone about a healthy
 * run. The failure is loud in exactly the wrong place and silent where it matters.
 *
 * It is also a deploy-ordering trap rather than a coding mistake: the code and the migration are
 * both correct in isolation, and the breakage only appears if the code ships first. A test is the
 * only thing that catches it before that ordering decision has to be remembered by a human.
 *
 * Deliberately schema-derived rather than a hardcoded list: it reads the columns out of the
 * baseline plus every migration, so adding a column keeps passing without touching this file, while
 * writing one that was never migrated fails.
 */
export function runCrmSyncRunColumnsTests() {
  const sync = readFileSync("src/lib/crm/sync.ts", "utf8");

  // The `.update({ … })` block that closes out a sync run. Anchored on the table constant so a
  // renamed local or a reordered key list cannot make this silently match nothing.
  const updateBlock = /\.from\(syncRunsTable\)\s*\n\s*\.update\(\{([\s\S]*?)\}\)/.exec(sync);
  assert.ok(updateBlock, "could not locate the syncRunsTable .update({...}) block in sync.ts");

  // Keys are `column_name: value`; comment lines inside the block must not be picked up.
  const written = new Set<string>();
  for (const line of updateBlock[1].split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) continue;
    const key = /^([a-z_][a-z0-9_]*)\s*:/.exec(trimmed);
    if (key) written.add(key[1]);
  }
  assert.ok(written.size > 0, "parsed no columns out of the sync-run update — the regex has drifted");
  assert.ok(written.has("status"), "sanity: the update must set status");

  // Every column this table has ever been given, from the baseline and every later migration.
  const migrationsDir = "supabase/migrations";
  const sql = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
    .join("\n");

  const known = new Set<string>();
  // CREATE TABLE … ( … ) — take the column name at the start of each line inside the definition.
  const created = /create table[^(]*ireports360_visits_sync_runs[^(]*\(([\s\S]*?)\n\);/i.exec(sql);
  if (created) {
    for (const line of created[1].split("\n")) {
      const col = /^\s{2,}([a-z_][a-z0-9_]*)\s+/.exec(line);
      if (col) known.add(col[1]);
    }
  }
  // ALTER TABLE … ADD COLUMN [IF NOT EXISTS] <name>. The keyword filter is not cosmetic: without
  // it a statement whose optional clause the regex fails to consume contributes "if" as a column
  // name. That only ever makes `known` more permissive, never less — but a guard whose allow-list
  // contains SQL keywords is one nobody can trust to be reading what they think it is.
  const SQL_KEYWORDS = new Set(["if", "not", "exists", "column", "add", "table"]);
  const addColumn = /alter table[^;]*ireports360_visits_sync_runs[\s\S]*?add column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi;
  for (const match of sql.matchAll(addColumn)) {
    if (!SQL_KEYWORDS.has(match[1])) known.add(match[1]);
  }
  assert.ok(
    [...known].every((column) => !SQL_KEYWORDS.has(column)),
    "the schema parser captured a SQL keyword as a column name — its regex has drifted",
  );

  assert.ok(known.size > 0, "found no schema definition for ireports360_visits_sync_runs in migrations");

  const missing = [...written].filter((column) => !known.has(column));
  assert.deepEqual(
    missing,
    [],
    `sync.ts writes ireports360_visits_sync_runs column(s) that no migration creates: ${missing.join(", ")}. ` +
      "Add the migration, and apply it BEFORE this code deploys — otherwise every sync marks itself failed.",
  );

  // The specific column this guard was written for, so a silent revert of the persistence is caught.
  assert.ok(
    written.has("blocked_post_exit_attributions"),
    "the post-exit block count must be PERSISTED on the sync run, not only sent to the digest — " +
      "a signal that exists solely in a notification cannot be queried, trended, or verified after the fact",
  );
}
