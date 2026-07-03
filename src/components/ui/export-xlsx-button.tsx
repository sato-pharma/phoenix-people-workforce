"use client";

import { Download, Loader2 } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import { downloadXlsxExport } from "@/lib/export/download-xlsx-client";
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
  template,
  title,
}: {
  className?: string;
  columns: ExportColumn[];
  label?: string;
  rows: ExportRow[];
  sheetName?: string;
  subtitle?: string;
  template?: "outstation_expenses";
  title: string;
}) {
  const [busy, setBusy] = useState(false);
  const disabled = busy || rows.length === 0;

  async function handleExport() {
    if (disabled) return;
    setBusy(true);
    try {
      await downloadXlsxExport({ title, subtitle, sheetName, columns, rows, template });
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
