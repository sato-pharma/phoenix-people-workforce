import assert from "node:assert/strict";

import { archiveSyncDeletions, type SyncDeletionRecord } from "../src/lib/crm/sync.ts";
import {
  PARITY_MAX_DELETE_ROWS,
  PARITY_MAX_DELETE_SHARE,
  decideParityAction,
} from "../src/lib/crm/parity.ts";

/**
 * THE DELETION ARCHIVE, AND WHY IT FAILS CLOSED.
 *
 * WHAT HAPPENED (production, `ireports360_parity_windows`, read 2026-10-02). The nightly parity
 * sweep deleted mirror visit rows on five consecutive nights and recorded only COUNTS:
 *
 *   2026-05-31..06-29   crm 19,769  mirror 20,227  missing 0  extra 458   02 Oct 07:52
 *   2026-05-01..05-30   crm 17,358  mirror 17,711  missing 0  extra 353   01 Oct 11:51
 *   2026-04-01..04-30   crm 16,840  mirror 17,191  missing 0  extra 351   30 Sep 15:50
 *   2026-03-02..03-31   crm 14,029  mirror 14,395  missing 0  extra 366   29 Sep 19:50
 *   2026-08-29..09-26   crm 13,790  mirror 13,789  missing 1  extra 0     26 Sep 11:46
 *
 * 1,879 rows, no id anywhere: `ireports360_parity_windows` is a running state table, the sync-run
 * row carries `rows_deleted`, and production has NO point-in-time recovery — 7 daily backups are
 * the whole recovery story. Two further facts made that worth stopping rather than watching:
 *
 *   - the owner's locked CRM rule says the CRM admin deactivates and CLONES, never deletes
 *     (.claude/rules/crm.md), so a one-sided `extraInMirror` is being read as a condition that is
 *     not supposed to occur;
 *   - the extras were period-concentrated in Mar-Jun while Jan-Feb and Jul-Sep read `equal`, which
 *     a uniform scope artefact would not produce — so it is either real vendor-side loss or a
 *     period-specific artefact, and row counts cannot tell those apart.
 *
 * WHAT THIS PINS. Three things, each of which was absent and each of which is cheap to lose again:
 * the archive refuses to let a delete proceed unrecorded, the ceilings stop a bulk delete before it
 * starts, and the ceilings do not stop the routine case the sweep exists for.
 */
export async function runCrmParityDeleteArchiveTests() {
  const sample = (id: number): SyncDeletionRecord => ({
    kind: "visit",
    record_id: id,
    record_date: "2026-06-15",
    synced_at: "2026-06-16T04:00:00.000Z",
    window_from: "2026-05-31",
    window_to: "2026-06-29",
    sync_run_id: "11111111-2222-3333-4444-555555555555",
    trigger: "cron",
  });

  // ── (A) FAIL CLOSED ───────────────────────────────────────────────────────────────────────
  // A failed archive write must THROW, so the caller's `await` propagates and the delete below it
  // never runs. The tempting alternative — log the failure and delete anyway — is the one outcome
  // with no way back, because the ids are gone and nothing recorded them.
  // An array, not a `let … | null`: a variable assigned only inside a callback is narrowed to
  // `never` at the later read, which the local suite cannot see because it ERASES types rather than
  // checking them. This exact line failed `tsc` on the PR after passing 2,139 local tests.
  const attempted: Array<{ table: string; rows: SyncDeletionRecord[] }> = [];
  const failing = {
    from: (table: string) => ({
      insert: async (rows: SyncDeletionRecord[]) => {
        attempted.push({ table, rows });
        return { error: { message: "permission denied for table ireports360_sync_deletions" } };
      },
    }),
  };
  await assert.rejects(
    () => archiveSyncDeletions(failing, [sample(1001), sample(1002)]),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.match(message, /Refusing to delete 2 mirror visit\(s\)/, "it says what it refused to do, and how many");
      assert.match(message, /permission denied/, "it carries the underlying cause rather than hiding it");
      assert.match(message, /no PITR/, "it says WHY an unrecorded delete is different from any other failure");
      return true;
    },
    "an archive write that fails must stop the delete, not warn past it",
  );
  assert.equal(attempted.length, 1, "the archive was attempted exactly once before the refusal");
  assert.equal(attempted[0]?.table, "ireports360_sync_deletions", "the archive goes to its own table");
  assert.equal(attempted[0]?.rows.length, 2, "every id in the chunk is offered to the archive, not a sample");

  // ── (B) THE HAPPY PATH WRITES EVERY ID, WITH ITS DATE ─────────────────────────────────────
  const written: SyncDeletionRecord[][] = [];
  const working = {
    from: (_table: string) => ({
      insert: async (rows: SyncDeletionRecord[]) => {
        written.push(rows);
        return { error: null };
      },
    }),
  };
  await archiveSyncDeletions(working, [sample(2001), sample(2002), sample(2003)]);
  assert.equal(written.length, 1, "one insert for the chunk, not one per row");
  assert.deepEqual(
    written[0]?.map((row) => row.record_id),
    [2001, 2002, 2003],
    "the archived ids are the ids handed in, in order",
  );
  assert.equal(written[0]?.[0]?.record_date, "2026-06-15", "the visit's own date is archived, so a wrong delete is readable");
  assert.equal(written[0]?.[0]?.window_from, "2026-05-31", "the window is archived, which is what ties a row to its sweep log line");
  assert.equal(written[0]?.[0]?.trigger, "cron", "the trigger distinguishes the nightly sweep from a manual backfill");

  // An empty chunk must not round-trip to the database at all.
  const idle = {
    from: (_table: string) => ({
      insert: async (_rows: SyncDeletionRecord[]) => {
        throw new Error("the archive must not be written for an empty chunk");
      },
    }),
  };
  await archiveSyncDeletions(idle, []);

  // ── (C) THE CEILINGS, AGAINST THE NUMBERS THAT ACTUALLY RAN ───────────────────────────────
  // The pre-existing >50% guard was never approached on any of the five nights, so in practice
  // nothing bounded the destructive direction. Each of these four is the real measured window.
  for (const [windowName, crmRows, mirrorRows, extra] of [
    ["2026-05-31..06-29", 19769, 20227, 458],
    ["2026-05-01..05-30", 17358, 17711, 353],
    ["2026-04-01..04-30", 16840, 17191, 351],
    ["2026-03-02..03-31", 14029, 14395, 366],
  ] as const) {
    const decision = decideParityAction({ crmRows, mirrorRows, missingInMirror: 0, extraInMirror: extra });
    assert.equal(decision.action, "refuse", `${windowName} (${extra} of ${mirrorRows}) must now refuse, not delete`);
    assert.ok(
      extra / mirrorRows <= 0.5,
      `${windowName} is under the old >50% guard — which is exactly why that guard never fired`,
    );
  }

  // The constants are part of the contract: silently raising them would restore the old behaviour
  // while every assertion above still passed.
  assert.equal(PARITY_MAX_DELETE_ROWS, 250, "the row ceiling is 250 — raising it needs a deliberate change here");
  assert.equal(PARITY_MAX_DELETE_SHARE, 0.05, "the share ceiling is 5% — raising it needs a deliberate change here");

  // ── (D) AND IT STILL REPAIRS ──────────────────────────────────────────────────────────────
  // A guard that refuses everything is not safety, it is the sweep switched off. The late-save case
  // the sweep exists for is additions-only and must stay unbounded.
  assert.equal(
    decideParityAction({ crmRows: 20000, mirrorRows: 20010, missingInMirror: 0, extraInMirror: 10 }).action,
    "repair",
    "a handful of deletions in a full window is the routine case and is still reconciled",
  );
  assert.equal(
    decideParityAction({ crmRows: 30000, mirrorRows: 100, missingInMirror: 29900, extraInMirror: 0 }).action,
    "repair",
    "additions are never bounded by a DELETE ceiling, however many there are",
  );

  console.log("crm-parity-delete-archive: ok");
}
