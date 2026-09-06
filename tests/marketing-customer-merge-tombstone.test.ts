import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// marketing_customers — a retired customer must name its successor in a column.
//
// `marketing_pharmacies` has recorded a venue merge machine-readably since it shipped. Customers
// had nothing, and there is no customer-merge code path at all — a customer merge here is hand SQL.
//
// Measured on production 2026-09-06: customer MKT-HCP-20260812-A26BF1C7 was retired 2026-08-21 and
// its venue link re-pointed to ROI-C-CF7662DC8FAF, with the successor written only into free-text
// `validation_notes`. Request MKT-REQ-20260814-6CD456E4 — approved, live, 11,200 EGP — was left
// pointing at the retired row. No join could find it, because there was nothing to join on.
//
// The last assertion is the one most likely to be "helpfully" undone, so it is the one stated
// loudest: this migration backfills NOTHING.
// ─────────────────────────────────────────────────────────────────────────────

function migrationSource(): string {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const file = readdirSync(dir).find((f) => f.endsWith("_marketing_customer_merge_leaves_a_tombstone.sql"));
  assert.ok(file, "the marketing customer tombstone migration must exist");
  return readFileSync(new URL(file, dir), "utf8");
}

export function runMarketingCustomerMergeTombstoneTests() {
  const sql = migrationSource();
  const lower = sql.toLowerCase();

  for (const column of ["merged_into_customer_id", "merged_at", "merged_by_hr_id"]) {
    assert.ok(
      lower.includes(`add column if not exists ${column}`),
      `${column} must be added — the three together mirror marketing_pharmacies, and a successor with no date or actor is half a record`,
    );
  }

  // The load-bearing half of the foreign key. CASCADE here would mean deleting a survivor silently
  // deletes every row it absorbed: losing the pointer is recoverable, losing the customer is not.
  assert.match(
    lower,
    /foreign key \(merged_into_customer_id\) references public\.marketing_customers\(id\) on delete set null/,
    "the successor FK must be ON DELETE SET NULL, never CASCADE — a merge must not turn into a delete",
  );

  // The trap this spelling avoids: a bare `merged_into_customer_id <> id` is NULL for every
  // un-merged row, and a CHECK that evaluates to NULL passes — but the moment anyone "tidies" it
  // into NOT NULL form it rejects all 207 live rows instead.
  assert.match(
    lower,
    /check \(merged_into_customer_id is null or merged_into_customer_id <> id\)/,
    "the not-self check must stay NULL-permissive, matching marketing_pharmacies_merged_not_self_check",
  );

  assert.match(
    lower,
    /create index if not exists marketing_customers_merged_into_idx[\s\S]*where merged_into_customer_id is not null/,
    "the index must be partial — it exists to find the handful of retired rows, not to carry 207 NULLs",
  );

  // Nothing is backfilled, on purpose.
  //
  // The one known merge on production spans two sales LINES: the retired row is Pedia (owner B-94,
  // a Pedia District Sales Manager) and the survivor is CNS (owner B-136, a CNS Medical
  // Representative), both active, both in area 1117 Helwan-Maadi. That is the shape the owner's
  // 2026-08-19 rule protects — "never shift, never shift. You just select and highlight" — where a
  // customer called on by two lines is a SHARED customer, a treasure, not a duplicate. Writing the
  // pointer would machine-record that merge as settled and let any future reader redirect Pedia
  // work onto a CNS row. Whether that pair is one customer or two is the owner's call.
  assert.doesNotMatch(
    lower,
    /update\s+public\.marketing_customers[\s\S]*set[\s\S]*merged_into_customer_id\s*=/,
    "this migration must not backfill a successor — the one known merge crosses a line boundary and is the owner's decision, not a fact the schema may assert",
  );
  assert.doesNotMatch(
    lower,
    /insert\s+into\s+public\.marketing_customers/,
    "a schema migration must not write customer rows",
  );
}
