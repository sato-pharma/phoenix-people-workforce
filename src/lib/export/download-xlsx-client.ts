"use client";

import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";

/** The one spelling of the OOXML workbook media type, so a response header and an `accept` cannot drift. */
export const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Turn a workbook response into a saved file.
 *
 * Split out of `downloadXlsxExport` (C1, 2026-09-27) because POSTing a table is no longer the only
 * shape: an export whose rows the SERVER assembles — Phoenix CRM's reports pack, where the viewer's
 * scope decides which sheets exist at all — is a plain GET, and the only half that differs is how the
 * response is obtained. Everything after that is identical, and a second hand-rolled copy is how one
 * caller quietly loses the server's filename or leaks the object URL.
 *
 * The status travels in the message: a bare "Export failed" left 12 production rows on 2026-09-14
 * with no way to tell a rejected request from a server fault.
 */
export async function saveXlsxResponse(response: Response, fallbackName: string): Promise<void> {
  if (!response.ok) throw new Error(`Export failed (HTTP ${response.status})`);

  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = /filename="(.+?)"/.exec(disposition);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = match?.[1] ?? fallbackName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * GET a workbook the server builds itself, and save it.
 *
 * For exports whose content is decided server-side: the caller has no rows to send, because which
 * rows — and which SHEETS — exist depends on what the viewer may read.
 */
export async function downloadXlsxFrom(url: string, fallbackName: string): Promise<void> {
  await saveXlsxResponse(await fetch(url, { headers: { accept: XLSX_MEDIA_TYPE } }), fallbackName);
}

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
  await saveXlsxResponse(response, "phoenix-export.xlsx");
}
