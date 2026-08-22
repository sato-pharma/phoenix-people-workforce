"use client";

import { AlertTriangle, Download, Loader2 } from "lucide-react";
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
  resolveRows,
  rows,
  sheetName,
  subtitle,
  template,
  title,
}: {
  className?: string;
  columns: ExportColumn[];
  label?: string;
  /**
   * Build the rows to export at the moment the button is pressed, instead of exporting
   * `rows` as-is.
   *
   * For sheets that carry a column the page itself must not hold. The organogram export
   * is the case this exists for: its Mobile column is fetched from the server here, so a
   * viewer's chart never sits on a list of colleagues' phone numbers. `rows` is still
   * required — it is what the enabled/disabled state and the count are read from.
   *
   * A throw is surfaced on the button rather than swallowed: half a sheet delivered
   * quietly is worse than an export the user knows to retry.
   */
  resolveRows?: () => Promise<ExportRow[]>;
  rows: ExportRow[];
  sheetName?: string;
  subtitle?: string;
  template?: "outstation_expenses";
  title: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const disabled = busy || rows.length === 0;

  async function handleExport() {
    if (disabled) return;
    setBusy(true);
    setFailed(false);
    try {
      const exportRows = resolveRows ? await resolveRows() : rows;
      await downloadXlsxExport({ title, subtitle, sheetName, columns, rows: exportRows, template });
    } catch (error) {
      console.error("XLSX export failed:", error);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className={cn(
        "inline-flex h-9 items-center gap-2 whitespace-nowrap border px-3 text-xs font-bold shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/40 disabled:opacity-50",
        failed
          ? "border-rose-500 bg-rose-50 text-rose-700 hover:border-rose-600"
          : "border-[#D8E0EA] bg-white text-[#0F172A] hover:border-[#FDBA74] hover:text-[#F97316]",
        className,
      )}
      disabled={disabled}
      onClick={handleExport}
      title={
        rows.length === 0
          ? "Nothing to export"
          : failed
            ? "The sheet could not be built. Press again to retry."
            : "Download as a styled Excel sheet"
      }
      type="button"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : failed ? (
        <AlertTriangle className="h-3.5 w-3.5" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
      {failed ? "Export failed — retry" : label}
    </button>
  );
}
