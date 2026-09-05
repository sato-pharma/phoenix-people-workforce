import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// PUBLISHING A CLOSING MUST RECORD WHAT WAS PUBLISHED.
//
// The SoS audit finding at 20260801120000_sos_rollup_and_closing_sql_truth.sql:186 — distributor
// value is never stored, so a factory_price edit silently restates every closed month. PR #3199
// taught phx_closing_publication_drift to see VALUE and to fall back to the lock snapshot. This
// test pins the other half: that publishing takes a snapshot at all.
//
// Measured on production 2026-09-05: monthly_closing_publications has carried all four snapshot
// columns since it was created, and all 3 published rows had every one of them NULL. The columns
// were built and never filled, so a closing was only auditable if it also happened to be LOCKED —
// and lock and publish are separate acts.
//
// Two properties are load-bearing here, and both are easy to "fix" back into a bug:
//
//   1. THE SNAPSHOT IS TAKEN ON INSERT ONLY. A re-publish must never re-snapshot, because that
//      replaces the baseline with today's figures at exactly the moment someone is asking whether
//      the figures moved.
//   2. publishClosing's upsert payload MUST stay four columns. On a re-publish the upsert takes
//      the ON CONFLICT branch and writes exactly the columns it names; naming snapshot_* there
//      would overwrite the published baseline. Leaving them out is the whole mechanism.
//
// Both are pinned against source, because neither is visible at the call site: the write happens
// in a database trigger.

const PUBLICATION_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/monthly-closing-publication.ts", import.meta.url)),
  "utf8",
);

const MIGRATIONS_DIR = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));

/** The migration that installs the publish-time snapshot trigger, found by content not filename. */
function snapshotTriggerMigration(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
  const matches = files
    .map((name) => readFileSync(new URL(name, new URL("../supabase/migrations/", import.meta.url)), "utf8"))
    .filter((sql) => sql.includes("trg_publication_take_snapshot"));
  assert.ok(
    matches.length > 0,
    "no migration installs trg_publication_take_snapshot — publishing a closing would record no baseline",
  );
  return matches.join("\n");
}

/** Body of one exported function, from its signature to the next top-level export. */
function exportedFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start > 0, `expected to find ${name} in monthly-closing-publication.ts`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf("\nexport ");
  return next === -1 ? rest : rest.slice(0, next);
}

export async function runClosingPublicationSnapshotTests(): Promise<void> {
  const migration = snapshotTriggerMigration();
  const normalized = migration.toLowerCase();

  // ── 1. the trigger fires on INSERT and never on UPDATE ─────────────────────────────────────
  // Stripping comments first: this file explains at length why there is no update branch, and the
  // word "update" appears throughout that prose.
  const statements = normalized
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  assert.ok(
    /create\s+trigger\s+trg_publication_take_snapshot\s+before\s+insert\s+on\s+public\.monthly_closing_publications/.test(
      statements,
    ),
    "trg_publication_take_snapshot must be a BEFORE INSERT trigger on monthly_closing_publications",
  );

  const triggerClause = statements.slice(statements.indexOf("create trigger trg_publication_take_snapshot"));
  assert.ok(
    !/before\s+insert\s+or\s+update/.test(triggerClause) && !/\bor\s+update\s+on\b/.test(triggerClause),
    "the trigger must NEVER fire on UPDATE — a re-publish would overwrite the published baseline " +
      "with today's figures, which is the exact failure this snapshot exists to detect",
  );

  // ── 2. it does not back-fill the rows that were published before snapshots existed ─────────
  // A snapshot taken now would record already-restated figures as though they were what was
  // published in August — and the set includes July 2026 Anti Infective, which the owner ruled on
  // 2026-09-04 stays exactly as published.
  assert.ok(
    !/update\s+(public\.)?monthly_closing_publications\s+set/.test(statements),
    "the migration must not back-fill snapshots onto already-published rows — that fabricates a " +
      "baseline out of current figures",
  );

  // ── 3. an explicitly supplied snapshot is honoured, not overwritten ─────────────────────────
  assert.ok(
    /if\s+new\.snapshot_breakdown\s+is\s+not\s+null\s+or\s+new\.snapshot_taken_at\s+is\s+not\s+null\s+then/.test(
      statements,
    ),
    "the trigger must return early when the insert already carries a snapshot, so a restore can " +
      "bring its own true baseline",
  );

  // ── 4. it records all four columns, from the same function the drift check compares against ──
  for (const column of [
    "new.snapshot_units",
    "new.snapshot_cells",
    "new.snapshot_breakdown",
    "new.snapshot_taken_at",
  ]) {
    assert.ok(
      statements.includes(column),
      `the trigger must set ${column} — a partial snapshot is not a baseline, and the drift check ` +
        "requires snapshot_taken_at AND snapshot_breakdown before it will use a publication row",
    );
  }
  assert.ok(
    statements.includes("phx_closing_publication_snapshot(new.line, new.period)"),
    "the snapshot must come from phx_closing_publication_snapshot, so it is the same shape " +
      "(units AND value, per cell) that phx_closing_publication_drift compares against",
  );

  // ── 5. THE PAYLOAD GUARD — publishClosing must not name the snapshot columns ────────────────
  // This is the half a future session is most likely to "fix" the wrong way: seeing that the
  // snapshot is written elsewhere and helpfully adding it here. On the ON CONFLICT branch that
  // silently restates the baseline on every re-publish.
  const publishBody = exportedFunctionBody(PUBLICATION_SOURCE, "publishClosing");
  const upsertStart = publishBody.indexOf(".upsert(");
  assert.ok(upsertStart > 0, "expected publishClosing to still write through .upsert(");
  const upsertCall = publishBody.slice(upsertStart, publishBody.indexOf(".select(", upsertStart));
  assert.ok(
    !upsertCall.includes("snapshot"),
    "publishClosing's upsert payload must NOT carry snapshot_* columns: on a re-publish the " +
      "ON CONFLICT branch writes exactly the columns named here, so naming them would overwrite " +
      "the published baseline with current figures",
  );
  assert.ok(
    upsertCall.includes("onConflict"),
    "expected the upsert to still be keyed on normalized_line,period — the snapshot's " +
      "insert-only behaviour depends on that conflict target",
  );

  // The pointer at the call site is the only thing telling a reader the snapshot happens at all.
  assert.ok(
    PUBLICATION_SOURCE.includes("trg_publication_take_snapshot"),
    "publishClosing must name the trigger that fills the snapshot — otherwise the write is " +
      "invisible to anyone reading the publish path",
  );
}
