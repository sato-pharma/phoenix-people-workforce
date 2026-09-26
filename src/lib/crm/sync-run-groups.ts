import type { VisitsSyncRun } from "@/lib/visits-report/types";

/**
 * The CRM sync runs every minute, so the Sync Status panel on /admin/crm was showing a separate
 * card for each run, all saying the same thing — measured at 1440px on 2026-09-26, six of them read
 * "Scheduled sync · 26 Sept 2026 – 26 Sept 2026 · 1 upserted" and the panel stood 389px tall,
 * putting the tab bar 560px down the page. Folded, the same panel is 145px and the tab bar sits at
 * 316px. The panel exists to answer two questions — "is the mirror fresh" and "did anything go
 * wrong" — and six identical green rows answer neither faster than one line does.
 *
 * So consecutive runs that are ROUTINE collapse into one row. Routine is deliberately narrow: a
 * scheduled (cron) run that SUCCEEDED and touched nothing unusual. Anything a person might need to
 * act on — a failure, a run still going, a manual sync or backfill somebody triggered, or a success
 * that deleted rows, skipped an invalid date, or hit the reconcile sanity cap — is never folded
 * away, and never counted as part of a group. That is the whole safety property of this file: a
 * group can only ever contain runs that are individually uninteresting.
 *
 * Grouping is CONSECUTIVE, over the list's own order (newest first). A failure between two clean
 * runs splits them into two groups rather than being hidden between them, which keeps the panel
 * chronological — a reader can still see where in the sequence the bad run sits.
 */

/** A run that is safe to fold into a count: scheduled, succeeded, and unremarkable. */
export function isRoutineSyncRun(run: VisitsSyncRun): boolean {
  return (
    run.trigger === "cron" &&
    run.status === "success" &&
    run.rowsDeleted === 0 &&
    run.rowsSkippedInvalidDate === 0 &&
    run.rowsSkippedReconcile === 0
  );
}

export type SyncRunGroup =
  /** One run, rendered exactly as the panel always rendered it. */
  | { kind: "single"; run: VisitsSyncRun }
  /**
   * Two or more consecutive routine runs, rendered as one line with a count. `runs` is kept whole
   * so the panel can still list every one of them behind a disclosure — the rows are folded, never
   * dropped.
   */
  | {
      kind: "routine";
      runs: VisitsSyncRun[];
      /** Sum across the group, the same two figures each row shows on its own. */
      rowsFetched: number;
      rowsUpserted: number;
      /** The union of the runs' sync windows — the calendar span these runs covered between them. */
      windowFrom: string;
      windowTo: string;
      /** Oldest and newest `startedAt` in the group, so the line can say when it ran from and to. */
      startedFirst: string;
      startedLast: string;
    };

/**
 * Fold consecutive routine runs together. A group of ONE stays a `single`, so nothing changes for a
 * panel that is already short — the collapse only ever appears where there was repetition.
 */
export function groupSyncRuns(runs: readonly VisitsSyncRun[]): SyncRunGroup[] {
  const groups: SyncRunGroup[] = [];
  let pending: VisitsSyncRun[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    if (pending.length === 1) {
      groups.push({ kind: "single", run: pending[0] });
    } else {
      const started = pending.map((run) => run.startedAt).sort();
      const froms = pending.map((run) => run.dateFrom).sort();
      const tos = pending.map((run) => run.dateTo).sort();
      groups.push({
        kind: "routine",
        rowsFetched: pending.reduce((sum, run) => sum + run.rowsFetched, 0),
        rowsUpserted: pending.reduce((sum, run) => sum + run.rowsUpserted, 0),
        runs: [...pending],
        startedFirst: started[0],
        startedLast: started[started.length - 1],
        windowFrom: froms[0],
        windowTo: tos[tos.length - 1],
      });
    }
    pending = [];
  };

  for (const run of runs) {
    if (isRoutineSyncRun(run)) {
      pending.push(run);
      continue;
    }
    flush();
    groups.push({ kind: "single", run });
  }
  flush();

  return groups;
}
