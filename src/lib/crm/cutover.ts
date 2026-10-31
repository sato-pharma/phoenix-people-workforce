/**
 * The CRM cutover — the one dated switch from iReports360 to Phoenix's own visits and plans.
 *
 * One row in `crm_cutover` (supabase/migrations/20260913230000_crm_cutover.sql) holds two facts:
 *
 *  - `cutover_date` — the first day Phoenix is the record, for everyone at once (owner decision 17).
 *    The three unified views read it: vendor rows before it, native rows on and after it. Null means
 *    no cutover, and every read returns exactly what it returned before this module existed.
 *  - `vendor_sync_retired_at` — every vendor pull stands down: the live poller's tick, the four cron
 *    routes and the manual sync buttons. It stands alone (20261031150000): with no date it closes the
 *    vendor API and changes nothing else. Every team already moves on its own start date
 *    (phoenix-team-starts.ts), and a date would also pick the month decision 18 never charges, which is
 *    the owner's money decision, never a side effect of closing the API.
 *
 * Nothing in the app ever WRITES the row. Setting either field is a production step the owner approves
 * and that is announced first — docs/crm-cutover-runbook.md.
 *
 * TWO FAILURE POSTURES, on purpose:
 *  - a vendor pull asks through `resolveVendorSyncStandDown`, which fails OPEN: if the setting cannot
 *    be read the pull carries on. A read-only mirror refreshed once too often costs nothing.
 *  - the deductions connector asks through `readCrmCutoverSetting`, which THROWS. Pay must never be
 *    charged on a guess about which month the cutover fell in (decision 18), and a throw inside a
 *    connector becomes a warning before either ledger write.
 *  A missing table (the migration not applied yet) is "no cutover" for both.
 */

import { CRM_CUTOVER_TABLE } from "@/lib/crm/tables";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type CrmCutoverSetting = {
  /** YYYY-MM-DD, or null while iReports360 is still the record. */
  cutoverDate: string | null;
  /** When vendor pulls were stood down, or null. Independent of the date. */
  vendorSyncRetiredAt: string | null;
};

export type CrmMonth = { month: number; year: number };

export const NO_CRM_CUTOVER: CrmCutoverSetting = Object.freeze({ cutoverDate: null, vendorSyncRetiredAt: null });

/** How long a process trusts the setting it read. A cutover is a once-in-a-lifetime switch; a minute of
 * lag on it costs nothing, and a read per vendor tick would. */
export const CRM_CUTOVER_CACHE_MS = 60_000;

/** The machine reason a stood-down vendor pull reports. */
export const VENDOR_SYNC_RETIRED_REASON = "vendor_sync_retired";

/** What a person pressing a vendor sync button is told once it is stood down. */
export const VENDOR_SYNC_RETIRED_MESSAGE =
  "iReports360 has been retired. Visits and plans are entered in Phoenix now, so there is nothing to pull from it.";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Only a missing TABLE means "not provisioned". A missing column is a code bug and must surface. */
export function isCrmCutoverSchemaMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : JSON.stringify(error ?? "");
  if (/42703|column .* does not exist|Could not find the .* column/i.test(message)) return false;
  return /PGRST205|42P01/.test(message) || (message.includes(CRM_CUTOVER_TABLE) && /schema cache|does not exist/i.test(message));
}

/** Pure: a database row onto the setting. A malformed date is treated as no date. A retirement is read
 * with or without a date — the table stopped requiring one in 20261031150000. */
export function parseCrmCutoverRow(
  row: { cutover_date?: unknown; vendor_sync_retired_at?: unknown } | null | undefined,
): CrmCutoverSetting {
  if (!row) return NO_CRM_CUTOVER;
  const rawDate = typeof row.cutover_date === "string" ? row.cutover_date.slice(0, 10) : "";
  const cutoverDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
  const vendorSyncRetiredAt =
    typeof row.vendor_sync_retired_at === "string" && row.vendor_sync_retired_at.trim() ? row.vendor_sync_retired_at : null;
  return { cutoverDate, vendorSyncRetiredAt };
}

/** A fresh read. THROWS when the row cannot be read (a missing table is no cutover). */
export async function readCrmCutoverSetting(): Promise<CrmCutoverSetting> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_CUTOVER_TABLE)
    .select("cutover_date, vendor_sync_retired_at")
    .eq("id", true)
    .maybeSingle();
  if (error) {
    if (isCrmCutoverSchemaMissing(error)) return NO_CRM_CUTOVER;
    throw new Error(`The CRM cutover setting could not be read: ${error.message}`);
  }
  return parseCrmCutoverRow(data as { cutover_date?: unknown; vendor_sync_retired_at?: unknown } | null);
}

let cached: { atMs: number; value: CrmCutoverSetting } | null = null;

/** The setting, cached for CRM_CUTOVER_CACHE_MS. Throws like readCrmCutoverSetting; a failed read is
 * not cached, so the next call retries. */
export async function getCrmCutoverSetting(): Promise<CrmCutoverSetting> {
  const nowMs = Date.now();
  if (cached && nowMs - cached.atMs < CRM_CUTOVER_CACHE_MS) return cached.value;
  const value = await readCrmCutoverSetting();
  cached = { atMs: nowMs, value };
  return value;
}

/** Pure: why vendor pulls must not run, or null when they may. */
export function vendorSyncStandDownReason(setting: CrmCutoverSetting): string | null {
  return setting.vendorSyncRetiredAt ? VENDOR_SYNC_RETIRED_REASON : null;
}

/**
 * Why a vendor pull must not run, or null. FAILS OPEN — an unreadable setting lets the pull run, and
 * is logged. See the header for why the deductions connector does the opposite.
 */
export async function resolveVendorSyncStandDown(): Promise<string | null> {
  try {
    return vendorSyncStandDownReason(await getCrmCutoverSetting());
  } catch (error) {
    logError("CRM cutover setting unreadable; vendor sync carries on", {
      error,
      labels: { event: "crm_cutover_setting_unreadable", job: "crm-cutover" },
    });
    return null;
  }
}

/** Pure: whether a Cairo day (YYYY-MM-DD) is Phoenix's record rather than the vendor's. */
export function isOnOrAfterCrmCutover(setting: CrmCutoverSetting, day: string): boolean {
  return setting.cutoverDate != null && day.slice(0, 10) >= setting.cutoverDate;
}

/** Pure: the calendar month the cutover date falls in, or null with no date. */
export function crmCutoverMonth(setting: CrmCutoverSetting): CrmMonth | null {
  if (!setting.cutoverDate) return null;
  return { month: Number(setting.cutoverDate.slice(5, 7)), year: Number(setting.cutoverDate.slice(0, 4)) };
}

/** Pure: owner decision 18 — the month whose CRM no-activity days are never charged. */
export function isCrmCutoverMonth(setting: CrmCutoverSetting, input: CrmMonth): boolean {
  const cutover = crmCutoverMonth(setting);
  return cutover != null && cutover.month === input.month && cutover.year === input.year;
}

function monthIndex(input: CrmMonth): number {
  return input.year * 12 + (input.month - 1);
}

/**
 * Pure: the KPI series break — the first month whose CRM figures are Phoenix's own. Months before it
 * are counted from iReports360, the break month is mixed when the date is not the 1st, and months
 * after it are Phoenix only. A month-over-month figure that crosses it compares two different
 * recording systems, and a screen must say so rather than present it as a trend.
 */
export function crmKpiSeriesBreak(
  setting: CrmCutoverSetting,
): { cutoverDate: string; firstPhoenixMonth: CrmMonth; mixedMonth: boolean } | null {
  const month = crmCutoverMonth(setting);
  if (!month || !setting.cutoverDate) return null;
  return { cutoverDate: setting.cutoverDate, firstPhoenixMonth: month, mixedMonth: !setting.cutoverDate.endsWith("-01") };
}

/** Pure: whether comparing month `from` with the later month `to` spans the series break. */
export function monthRangeCrossesCrmSeriesBreak(setting: CrmCutoverSetting, from: CrmMonth, to: CrmMonth): boolean {
  const seriesBreak = crmKpiSeriesBreak(setting);
  if (!seriesBreak) return false;
  const [earlier, later] = monthIndex(from) <= monthIndex(to) ? [from, to] : [to, from];
  const breakIndex = monthIndex(seriesBreak.firstPhoenixMonth);
  return monthIndex(earlier) < breakIndex && monthIndex(later) >= breakIndex;
}

/** The note a CRM deductions collection carries for the cutover month (decision 18). */
export function crmCutoverMonthDeductionNote(input: CrmMonth): string {
  return (
    `CRM no-activity is not charged for ${MONTH_NAMES[input.month - 1]} ${input.year}, ` +
    "the month Phoenix replaced iReports360 (owner decision 18)."
  );
}
