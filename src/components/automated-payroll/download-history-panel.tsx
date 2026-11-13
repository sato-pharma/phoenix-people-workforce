"use client";

import { useCallback, useState } from "react";

import { adminPanelClassName } from "@/components/admin/admin-design-tokens";
import { cairoTimeLabel } from "@/lib/automated-payroll/cell-history-labels";
import type { PayrollDownloadEntry } from "@/lib/automated-payroll/download-log";
import { cn } from "@/lib/utils";

const FILE_LABELS: Record<string, string> = {
  run_sheet: "Payroll sheet",
  finance_sheet: "Finance sheet",
  fab_bank_file: "FAB bank file",
  cib_bank_file: "CIB bank file",
};

const SCOPE_LABELS: Record<string, string> = {
  part1: "Part 1",
  part2: "Part 2",
  full: "Full month",
};

/**
 * Who took this run's payroll files, and when (REC-054). Every sheet and bank file built from the run
 * writes a row (download-log.ts); this is where they are read. Closed by default — it is a record to
 * consult, not a step — and it is read afresh each time it is opened, so a file just taken is listed.
 */
export function DownloadHistoryPanel({ runId }: { runId: string }) {
  const [downloads, setDownloads] = useState<PayrollDownloadEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/downloads`, { cache: "no-store" });
      const payload = (await res.json().catch(() => ({}))) as { downloads?: PayrollDownloadEntry[]; error?: string };
      if (!res.ok) {
        setError(payload.error ?? "The download history could not be loaded.");
        return;
      }
      setError(null);
      setDownloads(payload.downloads ?? []);
    } catch {
      setError("The download history could not be loaded.");
    }
  }, [runId]);

  return (
    <details
      className={cn(adminPanelClassName, "p-4")}
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary className="cursor-pointer text-sm font-bold text-slate-900">
        File downloads{downloads ? ` (${downloads.length})` : ""}
      </summary>
      {error ? (
        <p className="mt-3 text-xs font-medium text-rose-700" role="alert">
          {error}
        </p>
      ) : downloads === null ? (
        <p className="mt-3 text-xs text-slate-500">Loading…</p>
      ) : downloads.length === 0 ? (
        <p className="mt-3 text-xs text-slate-500">No sheet or bank file has been downloaded from this month yet.</p>
      ) : (
        <ul className="mt-3 space-y-1">
          {downloads.map((entry) => (
            <li key={entry.id} className="border border-slate-200 px-3 py-2 text-xs">
              <span className="block break-words font-bold text-slate-900">
                {FILE_LABELS[entry.file] ?? entry.file}
                {entry.scope ? ` · ${SCOPE_LABELS[entry.scope] ?? entry.scope}` : ""}
                {entry.rows !== null ? ` · ${entry.rows} rows` : ""}
              </span>
              <span className="block break-words text-slate-500">
                {entry.actorName}
                {entry.role ? ` (${entry.role})` : ""} · {cairoTimeLabel(entry.downloadedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
