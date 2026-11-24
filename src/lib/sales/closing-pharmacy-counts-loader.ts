// Loads the pharmacy count for the Monthly Closing sales sheet. The rule lives in
// closing-pharmacy-counts.ts (pure); this file only decides WHICH rows reach it.
//
// 🔴 THE SAME ROWS AS THE CLOSING. Read through loadMonthlyClosingDetails — the one pharmacy-level
// source that reconciles to the closing — never revealed (El Qema stays Main Stores, which is not a
// pharmacy), so the store split's shares are already credited before a row is counted.
//
// 🔴 MANAGERS SEE THEIR OWN TEAM (owner's answer, 24 Nov 2026). The portal read takes the viewer's
// own closing scope — line, region, seat areas, products — exactly as Pharmacy Actions does, and only
// PUBLISHED months. A Medical Rep is not given the count. The admin read is gated by its route to the
// same readers as the admin Closing Matrix, who already see every validated month.

import type { AccessContext } from "@/lib/auth/permissions";
import { buildClosingPharmacyCounts, type ClosingPharmacyCounts } from "@/lib/sales/closing-pharmacy-counts";
import {
  loadMonthlyClosingDetails,
  narrowClosingDetailsToAreas,
  type ClosingDetailRow,
} from "@/lib/sales/monthly-closing-details";
import { listPublishedPeriodsForLine } from "@/lib/sales/monthly-closing-publication";
import { resolvePortalClosingScope } from "@/lib/sales/monthly-closing-portal";

export type ClosingPharmacyCountsResult =
  | { ok: true; counts: ClosingPharmacyCounts }
  | { ok: false; status: 403 | 404; message: string };

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const cache = new Map<string, { at: number; result: ClosingPharmacyCountsResult }>();

function viewerKey(access: AccessContext): string {
  return `${access.role}|${access.scope}|${String(access.hrId ?? access.loginId ?? "").trim().toUpperCase()}`;
}

async function cached(key: string, fresh: boolean, load: () => Promise<ClosingPharmacyCountsResult>) {
  const hit = fresh ? undefined : cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  const result = await load();
  if (result.ok) {
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), result });
  }
  return result;
}

const cleanPeriods = (periods: readonly string[]) =>
  [...new Set(periods.map((period) => String(period ?? "").trim()).filter((period) => /^\d{4}-\d{2}$/.test(period)))].sort();

async function loadRows(input: {
  access: AccessContext;
  line: string;
  periods: string[];
  areaCodes?: readonly string[] | null;
  productCodes?: ReadonlySet<string> | null;
}): Promise<{ period: string; rows: ClosingDetailRow[] }[] | null> {
  const loaded = await Promise.all(
    input.periods.map(async (period) => {
      const details = await loadMonthlyClosingDetails({
        access: input.access,
        line: input.line,
        period,
        availableLines: [input.line],
        availablePeriods: input.periods,
        unpaged: true,
      });
      if (details.outOfScope || details.line !== input.line) return null;
      const narrowed = input.areaCodes ? narrowClosingDetailsToAreas(details, [...input.areaCodes]) : details;
      const rows = input.productCodes
        ? narrowed.rows.filter((row) => input.productCodes!.has(row.productCode.toUpperCase()))
        : narrowed.rows;
      return { period, rows };
    }),
  );
  return loaded.some((entry) => entry === null) ? null : (loaded as { period: string; rows: ClosingDetailRow[] }[]);
}

/**
 * The admin Closing Matrix's count: every area of the line, for the month or months on screen.
 * The CALLER enforces who may ask (the admin closing route's own gate).
 */
export async function loadAdminClosingPharmacyCounts(input: {
  access: AccessContext;
  line: string;
  periods: readonly string[];
  fresh?: boolean;
}): Promise<ClosingPharmacyCountsResult> {
  const line = String(input.line ?? "").trim();
  const periods = cleanPeriods(input.periods);
  if (!line || periods.length === 0) return { ok: false, status: 404, message: "Pick a line and a month." };
  return cached(`admin|${viewerKey(input.access)}|${line}|${periods.join(",")}`, input.fresh === true, async () => {
    const rows = await loadRows({ access: input.access, line, periods });
    if (!rows) return { ok: false, status: 403, message: "This line is outside your access." };
    return { ok: true, counts: buildClosingPharmacyCounts({ line, periods: rows }) };
  });
}

/** The portal Monthly Closing's count: the viewer's own team, one published month. */
export async function loadPortalClosingPharmacyCounts(input: {
  access: AccessContext;
  line: string;
  period: string;
}): Promise<ClosingPharmacyCountsResult> {
  const { access } = input;
  if (access.role === "Medical Rep") {
    return { ok: false, status: 403, message: "The pharmacy count is for managers." };
  }
  const line = String(input.line ?? "").trim();
  const [period] = cleanPeriods([input.period]);
  if (!line || !period) return { ok: false, status: 404, message: "Pick a line and a month." };

  const scope = await resolvePortalClosingScope(access);
  if (!scope.allowedLines.includes(line)) return { ok: false, status: 403, message: "That line is outside your scope." };
  const published = await listPublishedPeriodsForLine(line);
  if (!published.includes(period)) {
    return { ok: false, status: 404, message: "This month's closing has not been published yet." };
  }
  const areaCodes = scope.areaCodes && scope.areaCodes.size > 0 ? [...scope.areaCodes].map((code) => code.toUpperCase()) : null;
  const productCodes = scope.productCodes ? new Set([...scope.productCodes].map((code) => code.toUpperCase())) : null;

  return cached(`portal|${viewerKey(access)}|${line}|${period}`, false, async () => {
    const rows = await loadRows({ access, line, periods: [period], areaCodes, productCodes });
    if (!rows) return { ok: false, status: 403, message: "This line is outside your access." };
    return { ok: true, counts: buildClosingPharmacyCounts({ line, periods: rows }) };
  });
}

/** What the screen needs: the brick level is for the workbook only. */
export function pharmacyCountsForScreen(counts: ClosingPharmacyCounts): ClosingPharmacyCounts {
  return { ...counts, bricks: [] };
}
