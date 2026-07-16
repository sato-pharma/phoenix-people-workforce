"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";

import type { VisitsSyncRun } from "@/lib/visits-report/types";

function formatCairo(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(date);
}

const STATUS_STYLES: Record<VisitsSyncRun["status"], string> = {
  failed: "bg-red-50 text-red-700 ring-red-200",
  running: "bg-amber-50 text-amber-700 ring-amber-200",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
};

export function CrmControlPanel({ latestRuns }: { latestRuns: VisitsSyncRun[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  const lastSuccess = latestRuns.find((run) => run.status === "success") ?? null;

  async function runSync() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/crm/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        rowsFetched?: number;
        rowsUpserted?: number;
        success?: boolean;
      };
      if (!response.ok || !payload.success) {
        throw new Error(payload.message ?? `Sync failed (HTTP ${response.status}).`);
      }
      setMessage({
        tone: "success",
        text: `Synced ${payload.rowsFetched ?? 0} visits (${payload.rowsUpserted ?? 0} written).`,
      });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Sync failed." });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="border border-slate-200 bg-white p-5 shadow-[0_4px_16px_rgba(15,23,42,0.07)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold tracking-[-0.01em] text-slate-950">Sync health</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Last successful CRM sync:{" "}
            <span className="font-semibold text-slate-700">{formatCairo(lastSuccess?.completedAt ?? null)}</span>
            {lastSuccess ? <span className="text-slate-400"> (Cairo)</span> : null}
          </p>
        </div>
        <button
          className="inline-flex items-center gap-2 bg-orange-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={pending}
          onClick={runSync}
          type="button"
        >
          {pending ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
          {pending ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {message ? (
        <div
          className={`mt-4 flex items-center gap-2 border p-3 text-xs font-medium ${
            message.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {message.tone === "success" ? (
            <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
          ) : (
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          )}
          {message.text}
        </div>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        {latestRuns.length === 0 ? (
          <p className="text-xs text-slate-500">No sync runs recorded yet.</p>
        ) : (
          <table className="w-full min-w-[38rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 pr-4 font-semibold">Started (Cairo)</th>
                <th className="py-2 pr-4 font-semibold">Status</th>
                <th className="py-2 pr-4 font-semibold">Window</th>
                <th className="py-2 pr-4 font-semibold text-right">Fetched</th>
                <th className="py-2 pr-4 font-semibold text-right">Written</th>
                <th className="py-2 font-semibold">Trigger</th>
              </tr>
            </thead>
            <tbody>
              {latestRuns.map((run) => (
                <tr className="border-b border-slate-100 text-slate-700" key={run.id}>
                  <td className="py-2 pr-4">{formatCairo(run.startedAt)}</td>
                  <td className="py-2 pr-4">
                    <span className={`inline-flex px-2 py-0.5 text-[11px] font-semibold uppercase ring-1 ${STATUS_STYLES[run.status]}`}>
                      {run.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-slate-500">
                    {run.dateFrom} → {run.dateTo}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{run.rowsFetched}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{run.rowsUpserted}</td>
                  <td className="py-2 text-slate-500">{run.trigger}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
