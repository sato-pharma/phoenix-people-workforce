"use client";

import { Download, Loader2 } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";

// Drop-in "Export XLSX" button for any admin table. Pass the same columns + rows the
// table renders; it POSTs them to /api/exports/table and downloads the styled sheet.
export function ExportXlsxButton({
  className,
  columns,
  label = "Export XLSX",
  rows,
  sheetName,
  subtitle,
  title,
}: {
  className?: string;
  columns: ExportColumn[];
  label?: string;
  rows: ExportRow[];
  sheetName?: string;
  subtitle?: string;
  title: string;
}) {
  const [busy, setBusy] = useState(false);
  const disabled = busy || rows.length === 0;

  async function handleExport() {
    if (disabled) return;
    setBusy(true);
    try {
      const response = await fetch("/api/exports/table", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, subtitle, sheetName, columns, rows }),
      });
      if (!response.ok) throw new Error("Export failed");

      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="(.+?)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "phoenix-export.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("XLSX export failed:", error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className={cn(
        "inline-flex h-9 items-center gap-2 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/40 disabled:opacity-50",
        className,
      )}
      disabled={disabled}
      onClick={handleExport}
      title={rows.length === 0 ? "Nothing to export" : "Download as a styled Excel sheet"}
      type="button"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}
