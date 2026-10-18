/**
 * Customer 360 — the list a page and the Excel file share: one row per validated doctor or account,
 * and the ONE filter both apply, so the file a manager downloads holds exactly the rows on his screen.
 *
 * Pure: no I/O, no React, and nothing but the verdict words imported, because the client list loads
 * it into the browser. The row is BUILT server-side, in `./list-row.ts`.
 */

import type { HubKind } from "./validated";
import { VERDICT_LABELS, type Verdict } from "./verdict";

export type HubListRow = {
  id: string;
  kind: HubKind;
  href: string;
  name: string;
  speciality: string | null;
  grade: string | null;
  dropped: boolean;
  areaName: string | null;
  regionName: string | null;
  brickName: string | null;
  /** Line labels, never codes. */
  linesVisiting: string[];
  validatedOnLines: string[];
  pharmacies: number;
  /** Linked pharmacies with closing sales in the last three closed months. */
  pharmaciesSelling: number;
  namedOnVisit: number;
  requests: number;
  /** The committed marketing money, or null for a viewer who does not read marketing. */
  marketingCost: number | null;
  directOrderVenues: number;
  directOrderValue: number;
  salesLast3: number;
  salesTotal: number;
  verdict: Verdict;
  verdictLabel: string;
  early: boolean;
  /** The verdict's first reason, in plain words. */
  headline: string;
};

export function hubHref(kind: HubKind, id: string): string {
  return `/customer-360/${kind === "doctor" ? "doctors" : "accounts"}/${encodeURIComponent(id)}`;
}

export type HubHasFilter = "" | "marketing" | "direct_order" | "named_on_visit" | "two_lines";

export type HubListFilters = {
  kind: HubKind;
  query?: string;
  line?: string;
  area?: string;
  verdict?: Verdict | "";
  has?: HubHasFilter;
};

export const HUB_HAS_LABELS: Record<Exclude<HubHasFilter, "">, string> = {
  direct_order: "Has a direct-order pharmacy",
  marketing: "Has a marketing request",
  named_on_visit: "Has a pharmacy named on a visit",
  two_lines: "Visited by two lines or more",
};

/** The one filter — the screen and the Excel file both call it. */
export function filterHubRows(rows: readonly HubListRow[], filters: HubListFilters): HubListRow[] {
  const needle = (filters.query ?? "").trim().toLowerCase();
  return rows.filter((row) => {
    if (row.kind !== filters.kind) return false;
    if (filters.line && !row.linesVisiting.includes(filters.line) && !row.validatedOnLines.includes(filters.line)) return false;
    if (filters.area && row.areaName !== filters.area) return false;
    if (filters.verdict && row.verdict !== filters.verdict) return false;
    if (filters.has === "marketing" && row.requests === 0) return false;
    if (filters.has === "direct_order" && row.directOrderVenues === 0) return false;
    if (filters.has === "named_on_visit" && row.namedOnVisit === 0) return false;
    if (filters.has === "two_lines" && row.linesVisiting.length < 2) return false;
    if (!needle) return true;
    return [row.name, row.speciality, row.areaName, row.regionName, row.brickName]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(needle));
  });
}

/** Sort: the verdicts that ask for action first, then sales, then name. */
const VERDICT_ORDER: Record<Verdict, number> = { blacklist: 1, not_enough_data: 3, watch: 2, whitelist: 0 };

export function sortHubRows(rows: readonly HubListRow[]): HubListRow[] {
  return [...rows].sort(
    (left, right) =>
      VERDICT_ORDER[left.verdict] - VERDICT_ORDER[right.verdict] ||
      right.salesLast3 - left.salesLast3 ||
      left.name.localeCompare(right.name),
  );
}

export type HubListSummary = {
  doctors: number;
  accounts: number;
  twoLines: number;
  withMarketing: number;
  verdicts: Record<Verdict, number>;
};

export function summarizeHubRows(rows: readonly HubListRow[]): HubListSummary {
  const verdicts: Record<Verdict, number> = { blacklist: 0, not_enough_data: 0, watch: 0, whitelist: 0 };
  let doctors = 0;
  let accounts = 0;
  let twoLines = 0;
  let withMarketing = 0;
  for (const row of rows) {
    if (row.kind === "doctor") doctors += 1;
    else accounts += 1;
    if (row.linesVisiting.length >= 2) twoLines += 1;
    if (row.requests > 0) withMarketing += 1;
    verdicts[row.verdict] += 1;
  }
  return { accounts, doctors, twoLines, verdicts, withMarketing };
}

/** The filters a URL carries, read the same way by the page and the export route. */
export function hubListFiltersFromParams(params: URLSearchParams | Record<string, string | string[] | undefined>): HubListFilters {
  const get = (key: string): string => {
    if (params instanceof URLSearchParams) return params.get(key) ?? "";
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  };
  const verdict = get("verdict");
  const has = get("has");
  return {
    area: get("area"),
    has: has in HUB_HAS_LABELS ? (has as HubHasFilter) : "",
    kind: get("kind") === "account" ? "account" : "doctor",
    line: get("line"),
    query: get("q"),
    verdict: verdict in VERDICT_LABELS ? (verdict as Verdict) : "",
  };
}
