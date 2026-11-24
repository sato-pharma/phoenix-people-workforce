// Loads the Customer Count dashboard. The counting rule is closing-pharmacy-counts.ts; the payload
// shape is customer-count-dashboard.ts; this file decides only WHICH rows reach them.
//
// 🔴 PUBLISHED MONTHS ONLY, for everyone. Every sales figure in the system equals the published
// closing (the monthly-closing source-of-truth golden rule), so the dashboard reads the months the
// closing has published for each line — never a draft month, never a zero for an unpublished one.
//
// 🔴 THE SAME ROWS AS THE CLOSING: loadMonthlyClosingDetails, unpaged, as the Pharmacies column reads.
//
// 🔴 MANAGERS SEE THEIR OWN TEAM (owner, 24 Nov 2026: "Managers, own team"). The portal read takes the
// viewer's closing scope — lines, seat areas, products — exactly as the portal closing does, and a
// Medical Rep is refused. The admin read is gated by its route to the admin Closing Matrix's readers.

import type { AccessContext } from "@/lib/auth/permissions";
import { loadRankingSeats } from "@/lib/sales/closing-rep-ranking";
import { buildCustomerCountPayload, type CustomerCountRow } from "@/lib/sales/customer-count-build";
import type { CustomerCountPayload } from "@/lib/sales/customer-count-dashboard";
import { loadMonthlyClosingDetails, narrowClosingDetailsToAreas } from "@/lib/sales/monthly-closing-details";
import { listMonthlyClosingLines } from "@/lib/sales/monthly-distributor-import";
import { listPublishedPeriodsForLine } from "@/lib/sales/monthly-closing-publication";
import { resolvePortalClosingScope } from "@/lib/sales/monthly-closing-portal";
import { seatLineKey } from "@/lib/sales/sos-pharmacy-actions-workbook";

export type CustomerCountResult =
  | { ok: true; payload: CustomerCountPayload }
  | { ok: false; status: 403 | 404; message: string };

/** Months shown when the viewer has not picked any: the latest six published. */
export const DEFAULT_MONTHS = 6;
/** The most months one view may hold — each is a full closing read. */
export const MAX_MONTHS = 12;
/** Closing reads in flight at once, so a twelve-month, three-line view never floods the database. */
const CONCURRENCY = 3;

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 40;
const cache = new Map<string, { at: number; result: CustomerCountResult }>();

function viewerKey(access: AccessContext): string {
  return `${access.role}|${access.scope}|${String(access.hrId ?? access.loginId ?? "").trim().toUpperCase()}`;
}

const cleanMonths = (months: readonly string[] | null | undefined) =>
  [...new Set((months ?? []).map((month) => String(month ?? "").trim()).filter((month) => /^\d{4}-\d{2}$/.test(month)))];

async function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(...(await Promise.all(items.slice(start, start + size).map(run))));
  }
  return out;
}

/** Only the fields the count and its names read — a month's rows are held, not the whole detail. */
function slim(row: CustomerCountRow): CustomerCountRow {
  return {
    areaCode: row.areaCode,
    sheetAreaCode: row.sheetAreaCode,
    distributorCode: row.distributorCode,
    clientCode: row.clientCode,
    clientName: row.clientName,
    clientAddress: row.clientAddress,
    areaName: row.areaName,
    sheetAreaName: row.sheetAreaName,
    brickId: row.brickId,
    brickName: row.brickName,
    productCode: row.productCode,
    productName: row.productName,
    salesValue: row.salesValue,
    effectiveUnits: row.effectiveUnits,
    isDirect: row.isDirect,
    evenSplitApplied: row.evenSplitApplied,
    qty: row.qty,
    includedInClosing: row.includedInClosing,
    regionName: row.regionName,
    operationalRegionName: row.operationalRegionName,
  };
}

async function load(input: {
  access: AccessContext;
  availableLines: string[];
  requestedLines: string[];
  requestedMonths: string[];
  areaCodes: string[] | null;
  productCodes: Set<string> | null;
}): Promise<CustomerCountResult> {
  const { access } = input;
  const publishedByLine = new Map<string, string[]>();
  await Promise.all(
    input.availableLines.map(async (line) => publishedByLine.set(line, await listPublishedPeriodsForLine(line).catch(() => []))),
  );
  const availableMonths = [...new Set([...publishedByLine.values()].flat())].sort().reverse();
  if (availableMonths.length === 0) {
    return { ok: false, status: 404, message: "No closing month has been published yet." };
  }

  const lines = input.requestedLines.length > 0
    ? input.availableLines.filter((line) => input.requestedLines.includes(line))
    : input.availableLines;
  if (lines.length === 0) return { ok: false, status: 403, message: "That line is outside your access." };

  const picked = input.requestedMonths.filter((month) => availableMonths.includes(month)).sort();
  const months = (picked.length > 0 ? picked : availableMonths.slice(0, DEFAULT_MONTHS).sort()).slice(-MAX_MONTHS);

  const jobs: { line: string; month: string }[] = [];
  const unpublished: { line: string; month: string }[] = [];
  for (const line of lines) {
    for (const month of months) {
      if (publishedByLine.get(line)?.includes(month)) jobs.push({ line, month });
      else unpublished.push({ line, month });
    }
  }

  const loaded = await inBatches(jobs, CONCURRENCY, async ({ line, month }) => {
    const details = await loadMonthlyClosingDetails({
      access,
      line,
      period: month,
      availableLines: [line],
      availablePeriods: [month],
      unpaged: true,
    });
    if (details.outOfScope || details.line !== line) return { line, month, rows: null };
    const narrowed = input.areaCodes ? narrowClosingDetailsToAreas(details, input.areaCodes) : details;
    const rows = (input.productCodes
      ? narrowed.rows.filter((row) => input.productCodes!.has(String(row.productCode ?? "").toUpperCase()))
      : narrowed.rows
    ).map((row) => slim(row as CustomerCountRow));
    return { line, month, rows };
  });

  const seatsByMonth = new Map<string, Awaited<ReturnType<typeof loadRankingSeats>>>();
  await Promise.all(
    months.map(async (month) => seatsByMonth.set(month, await loadRankingSeats(month).catch(() => new Map()))),
  );

  const byLine = new Map<string, { month: string; rows: CustomerCountRow[] }[]>();
  for (const entry of loaded) {
    if (!entry.rows) continue;
    const list = byLine.get(entry.line) ?? [];
    list.push({ month: entry.month, rows: entry.rows });
    byLine.set(entry.line, list);
  }

  const payload = buildCustomerCountPayload({
    months,
    lines: lines.filter((line) => byLine.has(line)).map((line) => ({ line, months: byLine.get(line)! })),
    repFor: (line, area, month) => {
      const seat = seatsByMonth.get(month)?.get(`${seatLineKey(line)}::${area.toUpperCase()}`);
      if (!seat) return null;
      if (seat.repName) return seat.repName;
      return seat.repIsVacant ? "Vacant seat" : null;
    },
    availableMonths,
    availableLines: input.availableLines,
    unpublished,
  });
  return { ok: true, payload };
}

async function cached(key: string, fresh: boolean, run: () => Promise<CustomerCountResult>) {
  const hit = fresh ? undefined : cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  const result = await run();
  if (result.ok) {
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), result });
  }
  return result;
}

/** The admin dashboard: every line, every area. The CALLER enforces who may ask. */
export async function loadAdminCustomerCount(input: {
  access: AccessContext;
  lines?: readonly string[] | null;
  months?: readonly string[] | null;
  fresh?: boolean;
}): Promise<CustomerCountResult> {
  const requestedLines = [...new Set((input.lines ?? []).map((line) => String(line ?? "").trim()).filter(Boolean))].sort();
  const requestedMonths = cleanMonths(input.months).sort();
  const key = `admin|${viewerKey(input.access)}|${requestedLines.join(",")}|${requestedMonths.join(",")}`;
  return cached(key, input.fresh === true, async () =>
    load({
      access: input.access,
      availableLines: await listMonthlyClosingLines(),
      requestedLines,
      requestedMonths,
      areaCodes: null,
      productCodes: null,
    }),
  );
}

/** The managers' portal dashboard: the viewer's own team only. A Medical Rep is refused. */
export async function loadPortalCustomerCount(input: {
  access: AccessContext;
  lines?: readonly string[] | null;
  months?: readonly string[] | null;
}): Promise<CustomerCountResult> {
  const { access } = input;
  if (access.role === "Medical Rep") return { ok: false, status: 403, message: "The customer count is for managers." };
  const scope = await resolvePortalClosingScope(access);
  if (scope.allowedLines.length === 0) return { ok: false, status: 403, message: "No product line is in your scope." };
  const areaCodes = scope.areaCodes && scope.areaCodes.size > 0 ? [...scope.areaCodes].map((code) => code.toUpperCase()) : null;
  const productCodes = scope.productCodes ? new Set([...scope.productCodes].map((code) => code.toUpperCase())) : null;
  const requestedLines = [...new Set((input.lines ?? []).map((line) => String(line ?? "").trim()).filter(Boolean))].sort();
  const requestedMonths = cleanMonths(input.months).sort();
  const key = `portal|${viewerKey(access)}|${requestedLines.join(",")}|${requestedMonths.join(",")}`;
  return cached(key, false, async () =>
    load({
      access,
      availableLines: [...scope.allowedLines],
      requestedLines,
      requestedMonths,
      areaCodes,
      productCodes,
    }),
  );
}
