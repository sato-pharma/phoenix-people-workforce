"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCcw, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { TerritorySyncReconciliationRow, TerritorySyncReport, TerritorySyncStatus } from "@/lib/sales/territory/types";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { lineSummaryDetail, SYNC_DESCRIPTION, syncRunLine, syncVerdict } from "@/lib/sales/territory/drilldown-words";

const SYNC_ENDPOINT = "/api/employee-portals/territory-drilldown/sync";

function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  // Owner rule: report every time in Africa/Cairo local time, never raw UTC.
  return formatStableEnGb(new Date(iso), {
    timeZone: "Africa/Cairo",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

type LineSummary = {
  officialLine: string;
  total: number;
  reconciled: number;
  mismatched: number;
  geoMismatchRows: number;
  unrollupRows: number;
  geographyChecked: boolean;
};

function summarizeByLine(rows: TerritorySyncReconciliationRow[]): LineSummary[] {
  const byLine = new Map<string, LineSummary>();
  for (const row of rows) {
    const entry = byLine.get(row.officialLine) ?? {
      officialLine: row.officialLine,
      total: 0,
      reconciled: 0,
      mismatched: 0,
      geoMismatchRows: 0,
      unrollupRows: 0,
      geographyChecked: true,
    };
    entry.total += 1;
    if (row.reconciled) entry.reconciled += 1;
    else entry.mismatched += 1;
    entry.geoMismatchRows += row.geoMismatchRows;
    entry.unrollupRows += row.unrollupRows;
    // One unchecked period makes the whole line unchecked — the weaker claim is the honest one.
    if (!row.geographyChecked) entry.geographyChecked = false;
    byLine.set(row.officialLine, entry);
  }
  return [...byLine.values()].sort((a, b) => a.officialLine.localeCompare(b.officialLine));
}

/**
 * Territory data sync. `canRun` is true for every role the Territory Drilldown page serves — the
 * sync is corrective and idempotent (only rows whose brick actually moved are written), so by
 * owner decision a Medical Rep may press it same as Super Admin (app/employee-portals/
 * territory-drilldown/page.tsx and the sync route's own `assertSyncOperator` agree). What differs
 * by role is `showReconciliation`: the per-line reconciliation chips below cover EVERY line the
 * sync touched, not just the viewer's own, so only a viewer who already sees every line company-
 * wide (Super Admin, CEO — see isTerritoryLinePickerRole) sees them; everyone else still sees the
 * freshness line and the button.
 *
 * Every sentence comes from `drilldown-words.ts`: a Medical Rep presses this button too, so it
 * says what the sync does in plain words ("puts every sale on the area its pharmacy belongs to
 * today"), never "re-stamps", "batches" or a bare plural in brackets. Flat and square like every card on the page.
 */
export function TerritorySyncPanel({ canRun, showReconciliation }: { canRun: boolean; showReconciliation: boolean }) {
  const [status, setStatus] = useState<TerritorySyncStatus | null>(null);
  const [report, setReport] = useState<TerritorySyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the run actually did, in the server's own words — including which months it withheld
  // because their closing is published. Without this the guard is a silent no-op: the operator
  // presses Sync, every month in the window is published, nothing runs, and the panel says nothing.
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(SYNC_ENDPOINT);
      if (!res.ok) return;
      const data = (await res.json()) as { status?: TerritorySyncStatus };
      if (data.status) setStatus(data.status);
    } catch {
      // Freshness fetch errors are non-fatal — the button still works.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStatus();
  }, [loadStatus]);

  async function runSync() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(SYNC_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
        error?: string;
        report?: TerritorySyncReport | null;
        publishedPeriodsSkipped?: string[];
      };
      if (!res.ok || !data.success) {
        setError(data.message ?? "The sync did not finish. Try again in a minute.");
        return;
      }
      // A run that withheld a published month, or that had nothing left to sync at all, returns no
      // report — say so in words rather than leaving the panel unchanged.
      if (data.report) setReport(data.report);
      else setReport(null);
      if (!data.report || (data.publishedPeriodsSkipped?.length ?? 0) > 0) {
        setNotice(data.message ?? null);
      }
      await loadStatus();
    } catch {
      setError("The sync could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const lineSummaries = useMemo(() => (report ? summarizeByLine(report.reconciliation) : []), [report]);
  const lastSyncedAt = formatDateTime(status?.lastSyncedAt ?? null);

  return (
    <section
      aria-labelledby="territory-sync-heading"
      className="border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 id="territory-sync-heading" className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Data sync
          </h3>
          <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">{SYNC_DESCRIPTION}</p>
        </div>
        <Button disabled={!canRun || busy} size="sm" type="button" variant="outline" onClick={() => void runSync()}>
          <RefreshCcw aria-hidden className={`mr-1.5 h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
          {busy ? "Syncing…" : "Sync now"}
        </Button>
      </div>

      <div aria-live="polite" className="mt-3 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
        {lastSyncedAt ? (
          <p className="flex items-start gap-1.5 text-slate-600 dark:text-slate-300">
            {status?.lastAllReconciled === false ? (
              <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            ) : (
              <CheckCircle2 aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
            )}
            <span>
              Last synced {lastSyncedAt}, Cairo time
              {status?.lastSyncedBy ? `, by ${status.lastSyncedBy}` : ""}
              {status?.lastAllReconciled === false ? `. ${syncVerdict(false)}` : ""}
            </span>
          </p>
        ) : (
          <p className="text-slate-600 dark:text-slate-300">Not synced yet.</p>
        )}
        {!canRun && <p className="mt-1 text-slate-600 dark:text-slate-300">Your account cannot run a sync.</p>}

        {error && (
          <p role="alert" className="mt-2 flex items-start gap-1.5 text-red-700 dark:text-red-300">
            <XCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        {notice && !error && (
          <p className="mt-2 flex items-start gap-1.5 text-slate-700 dark:text-slate-200">
            <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <span>{notice}</span>
          </p>
        )}
      </div>

      {report && (
        <div className="mt-3 border-l-2 border-slate-900 bg-slate-50 py-2 pl-3 pr-2 text-xs dark:border-slate-100 dark:bg-slate-950">
          <p className="flex items-start gap-1.5 font-semibold text-slate-900 dark:text-slate-100">
            {report.allReconciled ? (
              <CheckCircle2 aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
            ) : (
              <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            )}
            <span>{syncVerdict(report.allReconciled)}</span>
          </p>
          <p className="mt-1 tabular-nums text-slate-600 dark:text-slate-300">{syncRunLine(report)}</p>
          {showReconciliation && (
            // Every line the sync touched, not just the viewer's own — gated to roles that already
            // see every line company-wide (see the component doc comment above).
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {lineSummaries.map((line) => {
                const clean = line.mismatched === 0 && line.geographyChecked;
                return (
                  <li
                    key={line.officialLine}
                    className={`inline-flex items-start gap-1 border px-2 py-0.5 ${
                      clean
                        ? "border-emerald-200 bg-white text-emerald-800 dark:border-emerald-900 dark:bg-slate-900 dark:text-emerald-300"
                        : "border-amber-300 bg-white text-amber-800 dark:border-amber-900 dark:bg-slate-900 dark:text-amber-300"
                    }`}
                  >
                    {clean ? (
                      <CheckCircle2 aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                    ) : (
                      <AlertTriangle aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                    )}
                    <span>
                      {line.officialLine}
                      {lineSummaryDetail(line)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
