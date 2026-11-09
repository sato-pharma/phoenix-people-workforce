"use client";

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import type { VisitsSyncRun } from "@/lib/visits-report/types";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { groupSyncRuns, type SyncRunGroup } from "@/lib/crm/sync-run-groups";

/** A real INSTANT (started_at / completed_at), so it renders in Cairo like every other clock time
 * in this app. It rendered in UTC until 2026-09-02, which is how a sync that failed at 21:03 Cairo
 * was reported as failing at 18:03 — three hours adrift, on the one panel someone reads precisely
 * because something has just gone wrong. */
function formatDateTime(value: string | null) {
  if (!value) return "—";
  return formatStableEnGb(new Date(value), { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" });
}

/** DATE-ONLY (the sync window's `date_from`/`date_to`, e.g. "2026-08-23"), which `new Date` parses
 * as UTC midnight. UTC here is CORRECT and must stay: it is what stops the calendar day being
 * shifted by a zone offset. Do not "fix" this one to Cairo to match formatDateTime above. */
function formatDate(value: string) {
  return formatStableEnGb(new Date(value), { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/** The retirement INSTANT as a Cairo calendar day — the day the owner switched the vendor off, as he
 * would name it, not the UTC day it happened to fall on. */
function formatCairoDay(value: string) {
  return formatStableEnGb(new Date(value), { day: "2-digit", month: "short", year: "numeric", timeZone: "Africa/Cairo" });
}

/** The sync-run history — the record of what was pulled from iReports360 before it was retired on
 * 6 November 2026. Every dataset tab on the CRM hub shares it, so it renders once above the tab bar.
 * The manual backfill went with the vendor. */
export function CrmSyncStatusPanel({
  latestSyncRuns,
  retiredAt = null,
  surface = "admin",
}: {
  latestSyncRuns: VisitsSyncRun[];
  /** `crm_cutover.vendor_sync_retired_at`, resolved on the server. Once set the panel says so in one
   * line and keeps the run history as the record of what was pulled before. */
  retiredAt?: string | null;
  /**
   * `portal` (the employee-portal CRM only) shows ONE freshness line — "Updated {Cairo time}" — or
   * nothing at all. A field seat was being shown the sync plumbing: "fetched · upserted" counts, a
   * "sanity cap — check for a partial fetch" warning, raw run error text and environment-variable
   * names. None of it is his to act on. `admin` (the default) is the full run history, unchanged.
   */
  surface?: "admin" | "portal";
}) {
  if (surface === "portal") {
    // After the vendor was retired Phoenix records visits directly, so there is no sync to report.
    if (retiredAt) return null;
    const latest = latestSyncRuns.find((run) => run.status === "success" && run.completedAt);
    if (!latest?.completedAt) return null;
    return (
      <p className="text-xs font-semibold text-slate-500" role="status">
        Updated {formatDateTime(latest.completedAt)}
      </p>
    );
  }

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
        <h2 className="text-phx-sm font-bold uppercase tracking-widest text-slate-300">Sync Status</h2>
        <div className="h-1.5 w-12 bg-orange-500" />
      </div>

      {retiredAt ? (
        <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-5 py-3 text-sm text-slate-700">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          iReports360 was retired on {formatCairoDay(retiredAt)}. Phoenix records visits directly.
        </div>
      ) : null}

      <div className="divide-y divide-slate-100">
        {latestSyncRuns.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No sync runs recorded yet.</p>
        ) : (
          groupSyncRuns(latestSyncRuns).map((group) =>
            group.kind === "routine" ? (
              <RoutineRunGroup group={group} key={`group-${group.runs[0].id}`} />
            ) : (
              <SyncRunRow key={group.run.id} run={group.run} />
            ),
          )
        )}
      </div>
    </div>
  );
}

/**
 * The folded line for a run of consecutive routine syncs. It says the same two things each row said
 * — when it ran, and how much it moved — for the whole group, and keeps every individual run one
 * click away inside a `<details>`. Nothing is dropped and nothing is truncated: a reader who wants
 * the six rows still has all six.
 */
function RoutineRunGroup({ group }: { group: Extract<SyncRunGroup, { kind: "routine" }> }) {
  return (
    <details className="group/runs px-5 py-3 text-sm">
      <summary className="flex list-none cursor-pointer flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <div>
            <p className="font-semibold text-slate-900">
              {group.runs.length} scheduled syncs
              {" · "}
              {formatDate(group.windowFrom)} – {formatDate(group.windowTo)}
            </p>
            <p className="text-phx-xs text-slate-500">
              {formatDateTime(group.startedFirst)} → {formatDateTime(group.startedLast)}
              {" · "}
              <span className="font-semibold text-slate-600 group-open/runs:hidden">show each run</span>
              <span className="hidden font-semibold text-slate-600 group-open/runs:inline">hide</span>
            </p>
          </div>
        </div>
        <span className="shrink-0 text-right text-xs font-bold text-slate-700">
          {group.rowsFetched} fetched · {group.rowsUpserted} upserted
        </span>
      </summary>
      <div className="mt-2 divide-y divide-slate-100 border-t border-slate-100">
        {group.runs.map((run) => (
          <SyncRunRow key={run.id} nested run={run} />
        ))}
      </div>
    </details>
  );
}

/** One run, in the shape this panel has always rendered it — used on its own, and inside a group. */
function SyncRunRow({ nested = false, run }: { nested?: boolean; run: VisitsSyncRun }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 text-sm ${nested ? "py-2 pl-6" : "px-5 py-3"}`}>
      <div className="flex items-center gap-2">
        {run.status === "success" ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
        ) : run.status === "failed" ? (
          <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
        ) : (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-400" />
        )}
        <div>
          <p className="font-semibold text-slate-900">
            {run.trigger === "cron" ? "Scheduled sync" : run.trigger === "manual_backfill" ? "Manual backfill" : "Manual sync"}
            {" · "}
            {formatDate(run.dateFrom)} – {formatDate(run.dateTo)}
          </p>
          <p className="text-phx-xs text-slate-500">
            Started {formatDateTime(run.startedAt)}
            {run.status !== "running" && ` · finished ${formatDateTime(run.completedAt)}`}
          </p>
          {run.status === "failed" && run.errorMessage && (
            <p className="mt-1 text-phx-xs font-medium text-rose-600">{run.errorMessage}</p>
          )}
        </div>
      </div>
      {run.status === "success" && (
        <span className="shrink-0 text-right text-xs font-bold text-slate-700">
          {run.rowsFetched} fetched · {run.rowsUpserted} upserted
          {run.rowsDeleted > 0 && <><br /><span className="text-amber-700">{run.rowsDeleted} deleted (CRM-removed)</span></>}
          {run.rowsSkippedInvalidDate > 0 && <><br /><span className="text-rose-600">{run.rowsSkippedInvalidDate} skipped (invalid date)</span></>}
          {run.rowsSkippedReconcile > 0 && <><br /><span className="text-rose-600">{run.rowsSkippedReconcile} stale rows NOT deleted (sanity cap — check for a partial fetch)</span></>}
        </span>
      )}
    </div>
  );
}
