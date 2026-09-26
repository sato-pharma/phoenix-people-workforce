import assert from "node:assert/strict";

import { groupSyncRuns, isRoutineSyncRun } from "../src/lib/crm/sync-run-groups.ts";
import type { VisitsSyncRun } from "../src/lib/visits-report/types.ts";

/**
 * The Sync Status panel on /admin/crm folds consecutive ROUTINE sync runs into one line, because
 * the CRM syncs every minute and the panel was showing a near-identical green card for each run.
 * Measured at 1440px on 2026-09-26: six cards, panel 389px tall, tab bar 560px down the page;
 * folded, the panel is 145px and the tab bar sits at 316px, with all six runs still one click away.
 *
 * 🔴 THE PROPERTY THIS FILE EXISTS TO DEFEND: a group may only ever contain runs that are
 * individually uninteresting. A failure, a run still going, a manual sync or backfill somebody
 * triggered, or a success that deleted rows / skipped an invalid date / hit the reconcile sanity
 * cap must each keep its own row, with its own error text and its own counts. Folding one of those
 * into a count would hide the single thing this panel exists to surface — and it would hide it
 * behind a green tick, which is worse than not showing the panel at all.
 *
 * The other half is that folding never DROPS a run: a group keeps every run it folded, so the
 * panel can list them behind a disclosure. The assertions below check both halves.
 */

let seq = 0;

function run(overrides: Partial<VisitsSyncRun> = {}): VisitsSyncRun {
  seq += 1;
  return {
    completedAt: `2026-09-26T12:0${seq % 10}:30Z`,
    dateFrom: "2026-09-26",
    dateTo: "2026-09-26",
    errorMessage: null,
    id: `run-${seq}`,
    rowsDeleted: 0,
    rowsFetched: 100,
    rowsSkippedInvalidDate: 0,
    rowsSkippedReconcile: 0,
    rowsUpserted: 1,
    startedAt: `2026-09-26T12:0${seq % 10}:00Z`,
    status: "success",
    trigger: "cron",
    ...overrides,
  } as VisitsSyncRun;
}

export async function runCrmSyncRunGroupsTests(): Promise<void> {
  // ── What may be folded, and what may never be ────────────────────────────────
  assert.equal(isRoutineSyncRun(run()), true, "a clean scheduled success is routine");
  assert.equal(isRoutineSyncRun(run({ status: "failed", errorMessage: "boom" })), false, "a FAILED run is never routine");
  assert.equal(isRoutineSyncRun(run({ status: "running" })), false, "a run still going is never routine");
  assert.equal(isRoutineSyncRun(run({ trigger: "manual_backfill" })), false, "a manual backfill is never routine — somebody ran it and wants to see it");
  assert.equal(isRoutineSyncRun(run({ trigger: "manual" })), false, "a manual sync is never routine");
  assert.equal(isRoutineSyncRun(run({ rowsDeleted: 3 })), false, "a run that DELETED rows is never routine");
  assert.equal(isRoutineSyncRun(run({ rowsSkippedInvalidDate: 1 })), false, "a run that skipped an invalid date is never routine");
  assert.equal(
    isRoutineSyncRun(run({ rowsSkippedReconcile: 12 })),
    false,
    "a run that hit the reconcile sanity cap is never routine — that is the partial-fetch signal",
  );

  // ── Six routine runs become one line, and keep all six ───────────────────────
  const six = [
    run({ rowsFetched: 109, rowsUpserted: 1, startedAt: "2026-09-26T12:26:00Z" }),
    run({ rowsFetched: 108, rowsUpserted: 1, startedAt: "2026-09-26T12:25:00Z" }),
    run({ dateFrom: "2026-09-25", rowsFetched: 107, rowsUpserted: 0, startedAt: "2026-09-26T12:24:30Z" }),
    run({ rowsFetched: 107, rowsUpserted: 1, startedAt: "2026-09-26T12:24:00Z" }),
    run({ rowsFetched: 106, rowsUpserted: 1, startedAt: "2026-09-26T12:22:00Z" }),
    run({ rowsFetched: 105, rowsUpserted: 0, startedAt: "2026-09-26T12:21:00Z" }),
  ];
  const folded = groupSyncRuns(six);
  assert.equal(folded.length, 1, "six consecutive routine runs are ONE row, not six");
  assert.equal(folded[0].kind, "routine");
  if (folded[0].kind !== "routine") throw new Error("unreachable");
  assert.equal(folded[0].runs.length, 6, "the folded row still carries every run it folded — folding is not dropping");
  assert.equal(folded[0].rowsFetched, 642, "fetched is summed across the group");
  assert.equal(folded[0].rowsUpserted, 4, "upserted is summed across the group");
  assert.equal(folded[0].windowFrom, "2026-09-25", "the window is the UNION, so a wider run in the group cannot be hidden by the others");
  assert.equal(folded[0].windowTo, "2026-09-26");
  assert.equal(folded[0].startedFirst, "2026-09-26T12:21:00Z", "the line reports the OLDEST start in the group");
  assert.equal(folded[0].startedLast, "2026-09-26T12:26:00Z", "and the newest");

  // ── A failure is never folded, and splits the sequence rather than hiding in it ──
  const withFailure = groupSyncRuns([run(), run(), run({ id: "bad", status: "failed", errorMessage: "CRM timed out" }), run(), run()]);
  assert.equal(withFailure.length, 3, "the failure splits the routine runs into two groups either side of it");
  assert.equal(withFailure[1].kind, "single", "the failure keeps its OWN row");
  if (withFailure[1].kind !== "single") throw new Error("unreachable");
  assert.equal(withFailure[1].run.id, "bad");
  assert.equal(withFailure[1].run.errorMessage, "CRM timed out", "its error text survives — that is what the panel is read for");
  assert.equal(
    withFailure.every((group) => group.kind !== "routine" || group.runs.every(isRoutineSyncRun)),
    true,
    "no group anywhere contains a run that is not routine",
  );

  // ── A lone routine run is left exactly as it was ─────────────────────────────
  const single = groupSyncRuns([run({ id: "only" })]);
  assert.equal(single.length, 1);
  assert.equal(single[0].kind, "single", "one run does not become a group of one — a short panel is unchanged");

  // ── Order is preserved, so the panel stays chronological ─────────────────────
  const ordered = groupSyncRuns([
    run({ id: "a", trigger: "manual_backfill" }),
    run({ id: "b" }),
    run({ id: "c" }),
    run({ id: "d", status: "running" }),
  ]);
  assert.deepEqual(
    ordered.map((group) => (group.kind === "single" ? group.run.id : group.runs.map((r) => r.id).join("+"))),
    ["a", "b+c", "d"],
    "groups appear in the list's own order",
  );

  // ── Nothing is lost, whatever the mix ────────────────────────────────────────
  const mixed = [run(), run({ status: "failed" }), run(), run({ rowsDeleted: 2 }), run(), run()];
  const flattened = groupSyncRuns(mixed).flatMap((group) => (group.kind === "single" ? [group.run] : group.runs));
  assert.deepEqual(flattened.map((r) => r.id), mixed.map((r) => r.id), "every run comes out, once, in the order it went in");
}
