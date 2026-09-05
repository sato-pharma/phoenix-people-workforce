import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A FACTORY-PRICE EDIT THAT RESTATES A SETTLED CLOSING MUST SAY SO — AND MUST STILL BE ALLOWED.
//
// Last gap of the SoS audit finding at 20260801120000_sos_rollup_and_closing_sql_truth.sql:186.
// #3199 taught the drift check to see value; #3208 made publishing take a baseline; this records
// the act itself as it happens.
//
// THE POINT OF THIS TEST IS THE THING IT FORBIDS. The obvious "fix" for a price sitting outside
// the closing lock is to extend phx_reject_write_to_locked_closing to source_of_sales_products, and
// that is wrong twice over:
//
//   1. It would REFUSE THE OWNER'S OWN PRICE CORRECTIONS. He ruled on 2026-08-14 that every closed
//      month is valued at the CURRENT factory price and rejected period-scoped prices; the Saginko
//      realignment "stands for all months"; and on 2026-09-04 he corrected Royafloxacin RO001 to
//      60.70 for exactly that reason. All three published closings are locked, so a hard block
//      would have refused that edit. The restatement is the policy — only its invisibility was the
//      defect.
//   2. phx_reject_write_to_locked_closing is parameterised by a PERIOD column and a LINE column it
//      joins to monthly_closing_locks. A product row has neither, so the mechanism has nothing to
//      match on.
//
// A future session reading "the price is outside the lock" will reach for the guard. This test is
// what stops that, so it pins the SHAPE (record, never refuse) and not merely the presence.

const MIGRATIONS_URL = new URL("../supabase/migrations/", import.meta.url);

/** The migration installing the price-restatement recorder, found by content not filename. */
function priceAuditMigration(): string {
  const files = readdirSync(fileURLToPath(MIGRATIONS_URL)).filter((name) => name.endsWith(".sql"));
  const matches = files
    .map((name) => readFileSync(new URL(name, MIGRATIONS_URL), "utf8"))
    .filter((sql) => sql.includes("trg_record_factory_price_restatement"));
  assert.ok(
    matches.length > 0,
    "no migration installs trg_record_factory_price_restatement — a factory-price edit would " +
      "restate settled closings with nothing written down",
  );
  return matches.join("\n");
}

/** SQL with comment lines removed — the file explains at length what it deliberately does NOT do. */
function statementsOf(sql: string): string {
  return sql
    .toLowerCase()
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

export async function runFactoryPriceRestatementAuditTests(): Promise<void> {
  const migration = priceAuditMigration();
  const statements = statementsOf(migration);

  // ── 1. it RECORDS, and must never refuse ───────────────────────────────────────────────────
  // The trigger runs AFTER the write and returns null; nothing about it can reject a price fix.
  assert.ok(
    /create\s+trigger\s+trg_record_factory_price_restatement\s+after\s+update\s+on\s+public\.source_of_sales_products/.test(
      statements,
    ),
    "the recorder must be an AFTER UPDATE trigger on source_of_sales_products",
  );
  assert.ok(
    !/\braise\s+exception\b/.test(statements),
    "THE PRICE EDIT MUST NEVER BE REFUSED. The owner values every closed month at the CURRENT " +
      "factory price (2026-08-14) and corrects prices deliberately — blocking the write would " +
      "refuse his own corrections. Record it, never reject it.",
  );

  // The lock guard must not be wired onto this table: that is the wrong fix, and it cannot work
  // anyway — it is parameterised by a (period, line) column pair a product row does not have.
  assert.ok(
    !/phx_reject_write_to_locked_closing/.test(statements),
    "do not attach phx_reject_write_to_locked_closing to source_of_sales_products — it would " +
      "refuse the owner's price corrections, and a product row has no period or line to match on",
  );

  // ── 2. a failed audit must not take the price edit down with it ────────────────────────────
  assert.ok(
    /exception\s*\n?\s*when\s+others\s+then/.test(statements) && /raise\s+warning/.test(statements),
    "the audit must be wrapped so a failure raises a WARNING and the price change still commits — " +
      "recording is the goal, but it must never become a new way to block a correction",
  );

  // ── 3. direct rows are excluded, and that is arithmetic not preference ─────────────────────
  // A direct order's value is the value Finance booked (direct_value), never units x factory
  // price, so a price move does not restate it. Counting them would invent an impact.
  assert.ok(
    /not\s+coalesce\(f\.is_direct,\s*false\)/.test(statements),
    "direct rows must be excluded from the impact: their value comes from the source, never from " +
      "units x factory price, so a factory-price move does not restate them at all",
  );

  // ── 4. it only reports months someone has been told are final ──────────────────────────────
  assert.ok(
    /monthly_closing_locks/.test(statements) && /monthly_closing_publications/.test(statements),
    "a settled month is one that is actively locked OR published — both must be consulted, " +
      "because lock and publish are separate acts",
  );
  // EVERY lock lookup must carry the active filter, not just one of them. Counting matters here:
  // an earlier version of this assertion looked for the filter anywhere in the file and passed
  // while one of the two lookups had lost it — caught by deliberately breaking it.
  const lockLookups = (statements.match(/monthly_closing_locks/g) ?? []).length;
  const activeFilters = (statements.match(/unlocked_at\s+is\s+null/g) ?? []).length;
  assert.ok(
    lockLookups > 0 && activeFilters >= lockLookups,
    `only an ACTIVE lock counts — an unlocked closing is not settled, and 11 of the 14 lock rows ` +
      `on production are already unlocked. Found ${lockLookups} monthly_closing_locks lookup(s) ` +
      `but only ${activeFilters} "unlocked_at is null" filter(s): every lookup needs one`,
  );

  // ── 5. the wider reach is reported, so a wide edit cannot read as a narrow one ──────────────
  // RO001's 2026-09-04 move touched eight periods for 1,017.10 EGP, of which only July was
  // published. A row that mentioned July alone would understate it by a factor of ten.
  // The QUOTED form, because that is the jsonb_build_object key. The bare word also appears as a
  // CTE alias, so an unquoted search passed with the payload field deleted — caught by breaking it.
  for (const key of ["all_periods_value_delta", "all_periods_cells", "value_delta"]) {
    assert.ok(
      statements.includes(`'${key}'`),
      `the audit row's metadata must carry the key '${key}' — otherwise an edit whose visible ` +
        "effect is one closed month but whose real reach is eight gets reported as small " +
        "(RO001 on 2026-09-04: eight periods, 1,017.10 EGP, only July published)",
    );
  }
}
