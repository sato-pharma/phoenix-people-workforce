import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decidePlanPrune, pruneStalePlanEntries } from "../src/lib/crm/plan-sync.ts";
import { staleReconcileIds } from "../src/lib/crm/reconcile-guard.ts";

// The CRM halves of the 23 Oct 2026 audit's C2 row: a check-in an overlapping sync just wrote is
// never deleted as stale (F-07), and the plan prune is guarded the same way and records every row it
// removes before removing it (S-SAL-01).

const RUN_STARTED = "2026-10-23T09:16:00.000Z";

/** F-07 — the check-in reconcile carries the visits' concurrent-sync guard. */
export async function runCrmCheckinReconcileGuardTests() {
  const synced = new Map<number, string>([
    [1, "2026-10-23T09:07:00.000000+00:00"], // written by an earlier run: stale if the CRM dropped it
    [2, "2026-10-23T09:16:30.123456+00:00"], // written by an OVERLAPPING run after this one began
    [3, "2026-10-23T09:16:00.000000+00:00"], // written at the very moment this run began
  ]);
  // HEADLINE.
  assert.deepEqual(
    staleReconcileIds([1, 2, 3, 4, 5], new Set([5]), synced, RUN_STARTED),
    [1, 4],
    "a row an overlapping sync wrote after this run began is never stale; one with no stamp still is",
  );
  const sync = readFileSync(join(process.cwd(), "src/lib/crm/sync.ts"), "utf8");
  assert.match(sync, /\.select\("crm_checkin_id, check_date, synced_at"\)/, "the check-in reconcile reads synced_at");
  assert.match(
    sync,
    /staleReconcileIds\(existingCheckinIds, freshCheckinIds, checkinSyncedAtById, runStartedAt\)/,
    "and judges stale check-ins with the shared guard",
  );
  assert.match(sync, /synced_at: checkinSyncedAtById\.get\(id\) \?\? null/, "the archive row carries the check-in's synced_at");
}

/** S-SAL-01 — the plan prune is guarded and records each row before deleting it. */
export async function runCrmPlanPruneArchiveTests() {
  // The guard: an entry an overlapping sync wrote after this run began is not pruned.
  const mirrorIds = Array.from({ length: 30 }, (_, index) => index + 1);
  const vendorIds = new Set(mirrorIds.filter((id) => id > 3));
  const decision = decidePlanPrune({
    mirrorIds,
    runStartedAt: RUN_STARTED,
    syncedAtById: new Map([[3, "2026-10-23T09:17:00.000Z"]]),
    vendorIds,
    vendorRowCount: vendorIds.size,
  });
  assert.deepEqual(decision.staleIds, [1, 2], "the entry written after this run began survives the prune");
  assert.equal(decision.prune, true);
  // Without the stamps, the old behaviour is unchanged.
  assert.deepEqual(decidePlanPrune({ mirrorIds, vendorIds, vendorRowCount: vendorIds.size }).staleIds, [1, 2, 3]);

  // The record-first delete, against a fake table.
  const events: string[] = [];
  const fake = {
    from: () => ({
      delete: () => ({
        in: (_column: string, ids: readonly number[]) => {
          events.push(`delete ${ids.join(",")}`);
          return Promise.resolve({ error: null });
        },
      }),
      select: () => ({
        in: (_column: string, ids: readonly number[]) =>
          Promise.resolve({ data: ids.map((id) => ({ agent_crm_id: 77, crm_plan_entry_id: id })), error: null }),
      }),
    }),
  };
  const recorded: Array<Record<string, unknown>> = [];
  const pruned = await pruneStalePlanEntries(fake, [1, 2], { kind: "weekly", window: "2026-10-18 to 2026-10-31" }, async (input) => {
    events.push("audit");
    recorded.push(input as unknown as Record<string, unknown>);
  });
  assert.equal(pruned, 2);
  // HEADLINE: the rows are recorded BEFORE they are deleted.
  assert.deepEqual(events, ["audit", "delete 1,2"], "every pruned plan entry is recorded before it is deleted");
  assert.equal(recorded[0]?.entityType, "crm_plan_sync");
  assert.deepEqual(
    ((recorded[0]?.oldValues as { rows: Array<{ crm_plan_entry_id: number }> }).rows ?? []).map((row) => row.crm_plan_entry_id),
    [1, 2],
    "the record holds the full rows",
  );

  // A record that cannot be written stops the delete.
  events.length = 0;
  await assert.rejects(
    pruneStalePlanEntries(fake, [1, 2], { kind: "monthly", window: "2026-10" }, async () => {
      throw new Error("audit down");
    }),
    /audit down/,
  );
  assert.deepEqual(events, [], "nothing is deleted when its record could not be written");
}
