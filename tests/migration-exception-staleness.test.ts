import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Staleness guard for ACKNOWLEDGED_EXCEPTIONS in scripts/lib/migration-inventory.ts — the sibling of
// tests/migration-grandfather-staleness.test.ts, for the other list in the migration tooling that
// can quietly outlive what it excuses.
//
// That Set names migration files the drift check and the staging applier must stop reporting: each
// one was proved APPLIED by `md5(pg_proc.prosrc)` against the file's own dollar-quoted body, with
// the ledger simply holding no row for it — the bookkeeping is lost when SQL goes through a direct
// Postgres connection, and stamped with the MCP's own clock when it goes through apply_migration, so
// the filename's 14 digits appear nowhere. The two reconciliation rounds behind the list, both on the
// owner's instruction, are docs/security/migration-ledger-reconciliation-2026-10-08.md and
// docs/security/migration-ledger-reconciliation-2026-10-13.md.
//
// The exemptions are fine. What is not fine is an exemption that no longer names a migration in the
// directory: it tells every reader a gap exists that does not, and it sits there as silent cover for
// any FUTURE file that takes that name — the same rot that had killed three of the four entries in
// GRANDFATHERED_DUPLICATE_TIMESTAMPS before 2026-09-03, and that tests/hr-function-governance.test.ts
// states as doctrine for its own list: a grandfather list "must not rot into cover for a name that no
// longer collides".
//
// 🔴 PARSE THE BLOCK ANCHORED ON ITS CLOSING `\n]);`, NEVER WITH A NON-GREEDY `([\s\S]*?)\]\)`.
// Measured 2026-10-13: the lazy form stops at the first `])` it meets, and this block's own comments
// contain one, so it captures 43 of the 81 entries — and a guard that reads 38 entries fewer than
// exist passes happily while proving nothing about them. The floor and the two-way count agreement
// below exist so that a parse which silently narrows fails instead.
export function runMigrationExceptionStalenessTests() {
  const SOURCE = "scripts/lib/migration-inventory.ts";
  const source = readFileSync(SOURCE, "utf8");

  const opener = "ACKNOWLEDGED_EXCEPTIONS = new Set<string>([";
  const start = source.indexOf(opener);
  assert.notEqual(
    start,
    -1,
    `could not find ACKNOWLEDGED_EXCEPTIONS in ${SOURCE} — if it was renamed or restructured, update ` +
      "this guard rather than deleting it",
  );
  const end = source.indexOf("\n]);", start);
  assert.ok(end > start, `ACKNOWLEDGED_EXCEPTIONS in ${SOURCE} has no closing "]);" at the start of a line`);
  const block = source.slice(start + opener.length, end);

  // One entry per line, exactly as the list is written. Every quoted .sql name inside the block is
  // counted separately: the two must agree, so an entry that drifts off this shape — re-indented,
  // two to a line, wrapped in a helper — is caught here instead of silently leaving the guard.
  const entries = [...block.matchAll(/^ {2}"(\d{14}_[^"]+\.sql)",?$/gm)].map((m) => m[1]);
  const quoted = [...block.matchAll(/"([^"]*\.sql)"/g)].map((m) => m[1]);
  assert.equal(
    entries.length,
    quoted.length,
    `the line-level parse found ${entries.length} entries and the block holds ${quoted.length} quoted ` +
      ".sql names — one of them is not a plain one-per-line entry, so this guard is no longer reading " +
      "the whole list. Fix the parse (or the list's shape) rather than accepting the smaller read",
  );
  assert.ok(
    entries.length >= 70,
    `only ${entries.length} acknowledged exceptions parsed, and there were 81 on 2026-10-13 — this is ` +
      "almost certainly the parse breaking rather than two thirds of the list being retired, and a " +
      "short read would make every assertion below vacuous",
  );

  const files = new Set(readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")));

  // 1. Every exemption must still name a migration that exists.
  for (const entry of entries) {
    assert.ok(
      files.has(entry),
      `"${entry}" is in ACKNOWLEDGED_EXCEPTIONS but no such file is in supabase/migrations/. Either it ` +
        "was renamed — in which case the entry must follow it, or the exemption no longer applies — or " +
        "it was deleted and the entry is dead weight that will silently excuse the next file to take " +
        "that name. Remove it rather than leaving a stale exemption behind",
    );
  }

  // 2. No duplicates. A Set swallows them, so the only cost is a reader believing two gaps were
  //    investigated when one was, and a batch header that no longer matches what sits under it.
  const seen = new Set<string>();
  for (const entry of entries) {
    assert.ok(
      !seen.has(entry),
      `"${entry}" appears twice in ACKNOWLEDGED_EXCEPTIONS — the Set ignores the second one, so the ` +
        "duplicate is only ever misleading",
    );
    seen.add(entry);
  }
}
