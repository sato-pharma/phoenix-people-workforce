/**
 * Phoenix CRM — the filters on Visits held for SFE (owner, 23 Nov 2026: "in the held visits make me advanced
 * filters top, to be able to filter instead of passing by all visits to find what I want"). No I/O.
 *
 * The page lists every held visit still waiting and those decided in the last 14 days — 96 on production that
 * day, from 18 reps, 83 of them logged before the customer had a place — so finding one rep's or one
 * customer's visits meant reading the whole list. The filter is a plain GET form: it changes WHICH rows the
 * page draws and in what order, never who may open the page or what a row says, so the page's own gate
 * (`canDecideFarVisitHolds`) is unchanged and nothing new is read from the database.
 *
 * A value in the address that does not parse is simply not applied, as on the Visits Archive.
 */

import { foldCustomerName } from "@/lib/customer-master/name-key";
import type { FarVisitHoldBasis, FarVisitHoldStatus } from "@/lib/phoenix-crm/far-visit-safeguards";

export const FAR_VISIT_HOLDS_PATH = "/admin/phoenix-crm/far-visit-holds";

/** What a filter reads of a held visit — the page's own row carries all of it. */
export type FilterableHold = {
  status: FarVisitHoldStatus;
  basis: FarVisitHoldBasis;
  repName: string;
  customerName: string;
  territory: string;
  /** The visit's own Cairo day, `YYYY-MM-DD`. */
  visitDate: string;
  heldAt: string;
  distanceMeters: number | null;
};

export type HoldStatusChoice = "waiting" | "approved" | "refused";
export type HoldDistanceBand = "under_500" | "500_1000" | "1_5_km" | "over_5_km";
export type HoldSort = "waiting_newest" | "visit_newest" | "visit_oldest" | "farthest" | "rep";

export type FarVisitHoldFilter = {
  status: HoldStatusChoice | null;
  basis: FarVisitHoldBasis | null;
  rep: string | null;
  territory: string | null;
  /** Visit days, both inclusive. */
  from: string | null;
  to: string | null;
  distance: HoldDistanceBand | null;
  /** Words to find in the rep's, the customer's or the territory's name. */
  q: string | null;
  sort: HoldSort;
};

export const HOLD_STATUS_LABELS: Record<HoldStatusChoice, string> = {
  waiting: "Waiting for SFE",
  approved: "Approved",
  refused: "Refused",
};

export const HOLD_BASIS_LABELS: Record<FarVisitHoldBasis, string> = {
  stuck: "Refused again and again from one spot",
  before_place: "Logged before the customer had a place",
};

export const HOLD_DISTANCE_LABELS: Record<HoldDistanceBand, string> = {
  under_500: "Under 500 m",
  "500_1000": "500 m to 1 km",
  "1_5_km": "1 km to 5 km",
  over_5_km: "Over 5 km",
};

export const HOLD_SORT_LABELS: Record<HoldSort, string> = {
  waiting_newest: "Waiting first, newest held first",
  visit_newest: "Newest visit first",
  visit_oldest: "Oldest visit first",
  farthest: "Farthest from the saved place first",
  rep: "Rep name, A to Z",
};

export const DEFAULT_HOLD_SORT: HoldSort = "waiting_newest";

type SearchValue = string | string[] | undefined;

function firstOf(value: SearchValue): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim() : "";
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | null {
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** A real calendar day as `YYYY-MM-DD`, or null. */
function parseDay(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

/** A name from the address, at most 200 characters; empty is no choice. */
function parseText(value: string): string | null {
  const text = value.slice(0, 200).trim();
  return text ? text : null;
}

/** The page's search parameters, each one checked. */
export function parseFarVisitHoldFilter(params: Record<string, SearchValue>): FarVisitHoldFilter {
  let from = parseDay(firstOf(params.from));
  let to = parseDay(firstOf(params.to));
  // Days typed the wrong way round are read as the range they plainly mean.
  if (from && to && from > to) [from, to] = [to, from];
  return {
    status: oneOf(firstOf(params.status), Object.keys(HOLD_STATUS_LABELS) as HoldStatusChoice[]),
    basis: oneOf(firstOf(params.basis), Object.keys(HOLD_BASIS_LABELS) as FarVisitHoldBasis[]),
    rep: parseText(firstOf(params.rep)),
    territory: parseText(firstOf(params.territory)),
    from,
    to,
    distance: oneOf(firstOf(params.distance), Object.keys(HOLD_DISTANCE_LABELS) as HoldDistanceBand[]),
    q: parseText(firstOf(params.q)),
    sort: oneOf(firstOf(params.sort), Object.keys(HOLD_SORT_LABELS) as HoldSort[]) ?? DEFAULT_HOLD_SORT,
  };
}

/** Is anything chosen that narrows the list? The sort alone narrows nothing. */
export function holdFilterNarrows(filter: FarVisitHoldFilter): boolean {
  return Boolean(filter.status || filter.basis || filter.rep || filter.territory || filter.from || filter.to || filter.distance || filter.q);
}

function statusChoiceOf(status: FarVisitHoldStatus): HoldStatusChoice {
  return status === "sfe_pending" ? "waiting" : status;
}

/** A distance with no measurement falls in no band — it is never guessed into one. */
export function distanceBandOf(metres: number | null): HoldDistanceBand | null {
  if (metres === null || !Number.isFinite(metres)) return null;
  if (metres < 500) return "under_500";
  if (metres < 1000) return "500_1000";
  if (metres < 5000) return "1_5_km";
  return "over_5_km";
}

/**
 * Every word typed must appear in the rep's, the customer's or the territory's name, each read through the one
 * customer-name key (`foldCustomerName`), so an Arabic name is found whatever its hamza, alif maqsura or
 * diacritics, and an English one whatever its case.
 */
function matchesWords(hold: FilterableHold, q: string): boolean {
  const words = foldCustomerName(q).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = ` ${foldCustomerName(`${hold.repName} ${hold.customerName} ${hold.territory}`)} `;
  return words.every((word) => haystack.includes(word));
}

export function holdMatchesFilter(hold: FilterableHold, filter: FarVisitHoldFilter): boolean {
  if (filter.status && statusChoiceOf(hold.status) !== filter.status) return false;
  if (filter.basis && hold.basis !== filter.basis) return false;
  if (filter.rep && hold.repName !== filter.rep) return false;
  if (filter.territory && hold.territory !== filter.territory) return false;
  if (filter.from && hold.visitDate < filter.from) return false;
  if (filter.to && hold.visitDate > filter.to) return false;
  if (filter.distance && distanceBandOf(hold.distanceMeters) !== filter.distance) return false;
  if (filter.q && !matchesWords(hold, filter.q)) return false;
  return true;
}

const names = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function newestHeldFirst(a: FilterableHold, b: FilterableHold): number {
  return b.heldAt.localeCompare(a.heldAt);
}

function compareFor(sort: HoldSort): (a: FilterableHold, b: FilterableHold) => number {
  switch (sort) {
    case "visit_newest":
      return (a, b) => b.visitDate.localeCompare(a.visitDate) || newestHeldFirst(a, b);
    case "visit_oldest":
      return (a, b) => a.visitDate.localeCompare(b.visitDate) || -newestHeldFirst(a, b);
    case "farthest":
      // An unmeasured distance goes last: it is no evidence of being far.
      return (a, b) => (b.distanceMeters ?? -1) - (a.distanceMeters ?? -1) || newestHeldFirst(a, b);
    case "rep":
      return (a, b) => names.compare(a.repName, b.repName) || b.visitDate.localeCompare(a.visitDate) || newestHeldFirst(a, b);
    case "waiting_newest":
    default:
      return (a, b) => Number(a.status !== "sfe_pending") - Number(b.status !== "sfe_pending") || newestHeldFirst(a, b);
  }
}

/** The rows the filter keeps, in the order it asks for. The input is never changed. */
export function filterFarVisitHolds<T extends FilterableHold>(holds: readonly T[], filter: FarVisitHoldFilter): T[] {
  return holds.filter((hold) => holdMatchesFilter(hold, filter)).sort(compareFor(filter.sort));
}

/** The reps and territories the page's own rows hold, each once, A to Z — the filter offers nothing else. */
export function farVisitHoldFilterOptions(holds: readonly FilterableHold[]): { reps: string[]; territories: string[] } {
  const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort(names.compare);
  return { reps: unique(holds.map((hold) => hold.repName)), territories: unique(holds.map((hold) => hold.territory)) };
}

/** The address of a filtered view; a default value is left out of it. */
export function farVisitHoldsHref(filter: FarVisitHoldFilter): string {
  const query = new URLSearchParams();
  if (filter.status) query.set("status", filter.status);
  if (filter.basis) query.set("basis", filter.basis);
  if (filter.rep) query.set("rep", filter.rep);
  if (filter.territory) query.set("territory", filter.territory);
  if (filter.from) query.set("from", filter.from);
  if (filter.to) query.set("to", filter.to);
  if (filter.distance) query.set("distance", filter.distance);
  if (filter.q) query.set("q", filter.q);
  if (filter.sort !== DEFAULT_HOLD_SORT) query.set("sort", filter.sort);
  const text = query.toString();
  return text ? `${FAR_VISIT_HOLDS_PATH}?${text}` : FAR_VISIT_HOLDS_PATH;
}
