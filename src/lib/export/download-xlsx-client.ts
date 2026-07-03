"use client";

import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";

// Shared POST-to-/api/exports/table + blob-download logic, extracted from
// ExportXlsxButton so it can also be used by callers that need to fetch a full
// (unpaginated) result set before exporting, not just whatever rows are already
// rendered on screen.
export async function downloadXlsxExport(input: {
  columns: ExportColumn[];
  rows: ExportRow[];
  sheetName?: string;
  subtitle?: string;
  template?: "outstation_expenses";
  title: string;
}): Promise<void> {
  const response = await fetch("/api/exports/table", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
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
}
