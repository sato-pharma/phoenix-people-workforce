// Pure, dependency-free cell formatting for the CRM master table + its XLSX export.
//
// Split out of the "use client" CrmMasterTable so the SAME rendering runs on the server-side
// streaming export (see master-export-workbook.ts) — the export used to re-render every cell in the
// browser and POST it back; it now renders server-side, and both surfaces MUST agree character for
// character. Only `Intl` + a type-only CrmMasterColumn import are used, so this stays safe to import
// from both the browser bundle and the Node export route (no Supabase/admin chain reaches either).

import type { CrmMasterColumn } from "@/lib/crm/master";

// Hoisted, reused Intl.DateTimeFormat instances — constructing one is expensive (locale data
// lookup/compilation), and these functions run per CELL. A large streaming export (the 2026-07-29
// incident: ~110k Visits rows × several date/datetime columns each) was constructing 400k+ fresh
// formatters, which alone accounted for several MINUTES of the export's total time — the actual
// dominant cost, well past the DB-query-latency fixes made alongside it. A formatter is stateless
// across calls (`.format(date)` takes the instant as an argument), so reusing one is behavior-
// identical, pure performance.
const DATE_ONLY_UTC = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" });
const DATE_CAIRO = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric" });
const TIME_CAIRO = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true, minute: "2-digit", timeZone: "Africa/Cairo" });
const TIME_UTC = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true, minute: "2-digit", timeZone: "UTC" });

/** Date only, e.g. "11 Jul 2026" (UTC — a plain calendar date has no time-of-day). */
export function formatDateOnly(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return DATE_ONLY_UTC.format(date);
}

/** Date + 12-hour time in Cairo, e.g. "11 Jul 2026, 4:59 PM" — for a true UTC instant we recorded
 * (synced_at), converted to Cairo. */
export function formatDateTimeCairo(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return `${DATE_CAIRO.format(date)}, ${TIME_CAIRO.format(date)}`;
}

/** Vendor timestamps (saveDate / checkDate) are already Cairo wall-clock but stored tagged UTC
 * (iReports360 sends zone-less local times). Render the stored clock reading with NO timezone
 * shift, e.g. "16 Jul 2026, 6:13 PM" — converting would read ~2–3h too late. */
export function formatVendorLocal(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return `${DATE_ONLY_UTC.format(date)}, ${TIME_UTC.format(date)}`;
}

/** Cell rendering: vendor local datetimes render as their stored Cairo wall-clock; our UTC
 * datetimes convert to Cairo; dates → date only; everything else raw. The full untouched value
 * is always available in the row's raw JSON. */
export function renderCell(value: unknown, kind: CrmMasterColumn["kind"]): string {
  if (value === null || value === undefined || value === "") return "—";
  if (kind === "datetime_local") return formatVendorLocal(value);
  if (kind === "datetime") return formatDateTimeCairo(value);
  if (kind === "date") return formatDateOnly(value);
  return String(value);
}

/** Africa/Cairo, 12-hour clock only (no date) — for the Visit Time cell's inline badge, mirroring
 * the Visits Report's time+source display. Vendor-local, so no timezone shift (see formatVendorLocal). */
export function formatVendorTimeOnly(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return TIME_UTC.format(date);
}

/** Label for a recognition_score value — shared by the on-screen badge and the XLSX export cell. */
export function recognitionLabel(score: unknown): string {
  if (score === 100) return "100% Recognized";
  if (score === 75) return "75% Partial";
  if (score === 50) return "50% Half Data";
  return "Unrecognized";
}

/** Export-only rendering: no JSX badge in an XLSX cell, so the visit_time_source is folded into
 * the text as a "(GPS)"/"(Logged)" suffix — otherwise removing the dedicated source column would
 * silently drop that information from exports, not just from the on-screen table. Same idea for
 * recognition_score: the export gets the plain label + what's missing, not a raw 100/75/50/null. */
export function renderExportCell(row: Record<string, unknown>, col: CrmMasterColumn): string {
  if (col.key === "visit_time") {
    const value = row[col.key];
    if (value === null || value === undefined || value === "") return "—";
    const source = row.visit_time_source;
    const suffix = source === "GPS check-in" ? " (GPS)" : source === "Logged/save" ? " (Logged)" : "";
    return `${formatVendorLocal(value)}${suffix}`;
  }
  if (col.key === "recognition_score") {
    const label = recognitionLabel(row[col.key]);
    const missing = row.recognition_missing;
    return typeof missing === "string" && missing ? `${label} (missing: ${missing})` : label;
  }
  return renderCell(row[col.key], col.kind);
}
