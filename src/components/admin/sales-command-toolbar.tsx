"use client";

import { Download, Loader2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { cn } from "@/lib/utils";

type Props = {
  /** "all" for all-time, otherwise the selected YYYY-MM period. */
  selected: string;
  periods: string[];
};

const ALL = "all";

// Period switcher + workbook export for the Sales Command dashboard. Period changes drive a
// server re-render via the URL (?period=...), so every table re-aggregates on the server — the
// browser never holds the raw Source of Sales facts. Export reuses the existing Executive Report
// XLSX endpoint (same company-wide Source of Sales data) so the CEO can pivot the numbers offline.
export function SalesCommandToolbar({ selected, periods }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const selectClassName =
    "h-11 w-full rounded-2xl border border-[#D8E0EA] bg-[#F8FAFC] px-3.5 text-sm font-semibold text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10 disabled:opacity-60 sm:w-56";

  function handlePeriodChange(value: string) {
    const query = value === ALL ? "" : `?period=${encodeURIComponent(value)}`;
    startTransition(() => {
      router.push(`${pathname}${query}`);
    });
  }

  async function handleExport() {
    setIsExporting(true);
    setExportError(null);
    try {
      const response = await fetch("/api/sales/executive-report/export", {
        body: JSON.stringify({ period: selected }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="(.+?)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "phoenix-sales-command.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : "Export failed.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border border-[#E2E8F0] bg-white p-4 sm:flex-row sm:items-end sm:justify-between">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
          Reporting period
        </span>
        <select
          className={selectClassName}
          disabled={isPending}
          onChange={(event) => handlePeriodChange(event.target.value)}
          value={selected}
        >
          <option value={ALL}>All-time (all months)</option>
          {periods.map((period) => (
            <option key={period} value={period}>
              {period}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-col items-stretch gap-1 sm:items-end">
        <button
          className={cn(
            "inline-flex h-11 shrink-0 items-center justify-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-[#F97316] disabled:opacity-50",
          )}
          disabled={isExporting}
          onClick={() => void handleExport()}
          type="button"
        >
          {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Download workbook (XLSX)
        </button>
        {exportError ? <span className="text-xs font-semibold text-rose-600">{exportError}</span> : null}
      </div>
    </div>
  );
}
