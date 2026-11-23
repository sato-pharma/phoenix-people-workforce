/**
 * Phoenix CRM — Place checks: what the page's address remembers.
 *
 * The rebuild, 23 Nov 2026 (`docs/approvals-rebuild-2026-11-place-checks.md`). The tab, the filters and how far
 * a list was opened lived in the component, so a reload — or the page coming back after a decision —
 * opened on the first tab with every filter gone. They are written to the address now, so a reload, the
 * Back button and a link sent to somebody open the same view.
 *
 * Pure and screen-free: the board's hook reads and writes with it, and the test runs it directly.
 *
 * 🔴 NO PERSON'S NAME IS EVER WRITTEN TO THE ADDRESS. A link is pasted into chats, kept in the browser's
 * history and written to server logs. The rep, the decider and the search box (which is typed names) are
 * kept for the visit in the browser's own session store instead (`PLACE_CHECK_PRIVATE_FILTERS`): a reload
 * keeps them, a link does not carry them.
 *
 * 🔴 EVERY OTHER PARAMETER ON THE ADDRESS IS LEFT ALONE — `review` opens the one-by-one review, and a
 * parameter this file does not know is somebody else's.
 */

import {
  EMPTY_VALIDATION_REVIEW_FILTERS,
  type ValidationReviewFilters,
  type ValidationReviewOutcome,
  type ValidationReviewPeriod,
} from "@/lib/phoenix-crm/validation-review-filters";

/** The filters a link may carry: places and lines, never a person. */
export const PLACE_CHECK_ADDRESS_FILTERS = ["outcome", "period", "line", "region", "area", "list"] as const;
type AddressFilter = (typeof PLACE_CHECK_ADDRESS_FILTERS)[number];

/** The filters that name a person, kept in the session store and never in a link. */
export const PLACE_CHECK_PRIVATE_FILTERS = ["rep", "decider", "text"] as const;
type PrivateFilter = (typeof PLACE_CHECK_PRIVATE_FILTERS)[number];

/** Where the private filters are kept for the visit. */
export const PLACE_CHECK_PRIVATE_STORE_KEY = "phoenix-crm:place-checks:filters";

const OUTCOMES: ReadonlyArray<ValidationReviewOutcome> = ["all", "pending", "approved", "rejected", "validated", "unseen"];
const PERIODS: ReadonlyArray<ValidationReviewPeriod> = ["all", "today", "7", "14", "30"];

/** A list is never opened further than this from an address, so a typed number cannot draw a whole set. */
export const PLACE_CHECK_ADDRESS_MAX_ROWS = 200;

export type PlaceCheckAddress = {
  /** The tab's key, or null for the page's own first tab. Whether the board offers it is the board's check. */
  tab: string | null;
  /** The narrowing of Not confirmed, or null for its default. */
  chip: string | null;
  /** How many rows the open tab's first list shows, or null for its first page. */
  rows: number | null;
  filters: Pick<ValidationReviewFilters, AddressFilter>;
};

const text = (value: string | null) => (value ?? "").trim().slice(0, 120);
const key = (value: string | null) => {
  const cleaned = (value ?? "").trim();
  return /^[A-Za-z][A-Za-z0-9:_-]{0,39}$/.test(cleaned) ? cleaned : null;
};

/** What an address asks for. Anything it cannot read is the default, never an error. */
export function parsePlaceCheckAddress(search: string): PlaceCheckAddress {
  const params = new URLSearchParams(search);
  const outcome = params.get("outcome") as ValidationReviewOutcome | null;
  const period = params.get("period") as ValidationReviewPeriod | null;
  const rows = Number(params.get("rows"));
  return {
    tab: key(params.get("tab")),
    chip: key(params.get("chip")),
    rows: Number.isInteger(rows) && rows > 0 ? Math.min(rows, PLACE_CHECK_ADDRESS_MAX_ROWS) : null,
    filters: {
      outcome: outcome && OUTCOMES.includes(outcome) ? outcome : EMPTY_VALIDATION_REVIEW_FILTERS.outcome,
      period: period && PERIODS.includes(period) ? period : EMPTY_VALIDATION_REVIEW_FILTERS.period,
      line: text(params.get("line")),
      region: text(params.get("region")),
      area: text(params.get("area")),
      list: text(params.get("list")),
    },
  };
}

/**
 * The address for a view: `current` with this file's own parameters replaced. A default is left out, so
 * the plain page keeps its plain address. The answer starts with "?" or is empty.
 */
export function placeCheckAddressSearch(current: string, address: PlaceCheckAddress): string {
  const params = new URLSearchParams(current);
  for (const name of ["tab", "chip", "rows", ...PLACE_CHECK_ADDRESS_FILTERS, ...PLACE_CHECK_PRIVATE_FILTERS]) params.delete(name);
  if (address.tab) params.set("tab", address.tab);
  if (address.chip) params.set("chip", address.chip);
  if (address.rows !== null && address.rows > 0) params.set("rows", String(Math.min(address.rows, PLACE_CHECK_ADDRESS_MAX_ROWS)));
  for (const name of PLACE_CHECK_ADDRESS_FILTERS) {
    const value = address.filters[name];
    if (value && value !== EMPTY_VALIDATION_REVIEW_FILTERS[name]) params.set(name, value);
  }
  const said = params.toString();
  return said ? `?${said}` : "";
}

/** The private filters as the session store keeps them: one small JSON object, empty values left out. */
export function privateFiltersText(filters: Pick<ValidationReviewFilters, PrivateFilter>): string | null {
  const kept: Partial<Record<PrivateFilter, string>> = {};
  for (const name of PLACE_CHECK_PRIVATE_FILTERS) if (filters[name].trim()) kept[name] = filters[name];
  return Object.keys(kept).length === 0 ? null : JSON.stringify(kept);
}

/** What the session store held. Anything that is not the object this file wrote reads as nothing kept. */
export function parsePrivateFilters(stored: string | null): Pick<ValidationReviewFilters, PrivateFilter> {
  const empty = { rep: "", decider: "", text: "" };
  if (!stored) return empty;
  try {
    const value: unknown = JSON.parse(stored);
    if (value === null || typeof value !== "object") return empty;
    const read = (name: PrivateFilter) => {
      const held = (value as Record<string, unknown>)[name];
      return typeof held === "string" ? held.slice(0, 120) : "";
    };
    return { rep: read("rep"), decider: read("decider"), text: read("text") };
  } catch {
    return empty;
  }
}
