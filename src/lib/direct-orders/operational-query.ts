/**
 * The OPERATIONAL Orders query — paginated in the database, not in React.
 *
 * WHY THIS EXISTS, SEPARATELY FROM getDirectOrderReport. The reporting function selects EVERY
 * request in the viewer's scope (`select("*")`, no limit), applies the scope tier in JavaScript,
 * decorates every row with steps/pharmacies/names/geography, and hands the lot to a client that
 * shows 25 of them. That is correct for a report — a report legitimately wants the whole set, to
 * export it — and wrong for the Orders list, which is the module's most-opened screen.
 *
 * This module is deliberately NOT a wrapper around that function. Overloading the report with
 * pagination would have made one query serve two jobs with opposite requirements: "give me
 * everything, decorated" and "give me twenty-five, cheaply".
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE:
 *
 *     SCOPE IS APPLIED BEFORE PAGINATION AND BEFORE THE COUNT.
 *
 * Paginating first and dropping unauthorised rows afterwards produces short pages, wrong totals,
 * and — depending on which side you trim — either a leak or a silent omission. Every filter here,
 * including the authorization tier, is a predicate on the query. Nothing is filtered after the
 * read.
 *
 * SCOPE IS NOT RE-DERIVED HERE. It comes from `resolveDirectOrderReportScope` and
 * `resolveVisibleRequesterHrIds` in service.ts — the same two functions the report and the per-rep
 * counters use. A second copy of a visibility rule is exactly how `reverse` once became reachable
 * by every rep in the company (audit C6.2 / F5).
 */

import { hrIdLookupKeys } from "@/lib/hr-id";
import { describeDirectOrderStatus } from "@/lib/direct-orders/status-labels";
import { DIRECT_ORDER_STATUS_VALUES, type DirectOrderReportScope } from "@/lib/direct-orders/types";

/** Which slice of their permitted set the viewer asked for. Narrows scope; never widens it. */
export type DirectOrderOrdersScopeFilter = "mine" | "all";

/**
 * The four groupings the workspace's filter chips offer, plus "all".
 *
 * These are NOT database statuses. "In Progress" spans `held`, `pending_approval`, `returned` and
 * approved-but-unbooked; "Completed" is `approved` AND ONLY when a sales month is booked. They are
 * the reader's vocabulary, and `describeDirectOrderStatus` is the one place that defines it.
 */
export type DirectOrderStatusGroupKey = "all" | "needs-action" | "in-progress" | "returned" | "completed";

const STATUS_GROUP_KEYS: readonly DirectOrderStatusGroupKey[] = [
  "all",
  "needs-action",
  "in-progress",
  "returned",
  "completed",
] as const;

export function resolveDirectOrderStatusGroup(raw: string | null | undefined): DirectOrderStatusGroupKey {
  const key = String(raw ?? "").trim().toLowerCase();
  return (STATUS_GROUP_KEYS as readonly string[]).includes(key) ? (key as DirectOrderStatusGroupKey) : "all";
}

/**
 * Does one order belong to a chip's group?
 *
 * THE SINGLE DEFINITION. The workspace component imports this for its legacy in-memory lists, and
 * `resolveDirectOrderStatusGroupFilter` below derives the SQL from it — so the chip on screen and
 * the predicate in the database cannot disagree. It used to be a private `matchesFilter` inside the
 * component, which meant the server had no way to answer the same question the chips asked.
 */
export function directOrderMatchesStatusGroup(
  order: { status: string; salesMonth: string | null },
  group: DirectOrderStatusGroupKey,
): boolean {
  if (group === "all") return true;
  // Checked before the presentation lookup: `returned` is a raw status, not a stage. Its stage is
  // "approval", so asking the stage would fold it into In Progress and the chip would never
  // isolate anything.
  if (group === "returned") return String(order.status) === "returned";
  const { stage, actionable } = describeDirectOrderStatus(order.status, order.salesMonth);
  if (group === "needs-action") return actionable;
  if (group === "in-progress") return stage === "approval" || stage === "customer_check" || stage === "finance";
  return stage === "completed";
}

/**
 * A chip's group, expressed as something a query can apply.
 *
 * Three buckets rather than one list because a status's group can depend on whether Finance has
 * booked it: `approved` with no sales month is "Waiting for Finance" (in progress, actionable),
 * and the SAME status with a month is "Completed". A flat `status IN (…)` cannot say that, and
 * flattening it would put every completed order into the In Progress chip.
 *
 * Nothing here names `approved` — the split is DISCOVERED by asking the group question twice per
 * status, once each way. If the vocabulary ever splits a second status on the sales month, this
 * keeps working with no edit.
 */
export type DirectOrderStatusGroupFilter = {
  /** Matched whatever the sales month holds. */
  statuses: string[];
  /** Matched only while no sales month is booked. */
  unbookedStatuses: string[];
  /** Matched only once a sales month IS booked. */
  bookedStatuses: string[];
};

/** Any month at all; only its null-ness is ever read. */
const BOOKED_PROBE_MONTH = "2000-01";

/** Null for "all" — the caller adds no predicate rather than one listing all nine statuses. */
export function resolveDirectOrderStatusGroupFilter(
  group: DirectOrderStatusGroupKey,
): DirectOrderStatusGroupFilter | null {
  if (group === "all") return null;
  const filter: DirectOrderStatusGroupFilter = { statuses: [], unbookedStatuses: [], bookedStatuses: [] };
  for (const status of DIRECT_ORDER_STATUS_VALUES) {
    const unbooked = directOrderMatchesStatusGroup({ status, salesMonth: null }, group);
    const booked = directOrderMatchesStatusGroup({ status, salesMonth: BOOKED_PROBE_MONTH }, group);
    if (unbooked && booked) filter.statuses.push(status);
    else if (unbooked) filter.unbookedStatuses.push(status);
    else if (booked) filter.bookedStatuses.push(status);
  }
  return filter;
}

/**
 * Is this search term shaped like an order id?
 *
 * Guards the `id.eq.` clause. Postgres rejects `id = 'el salam'` at the cast, BEFORE it evaluates
 * anything else — so an unconditional id clause turns every ordinary word into a failed query.
 * Lives here rather than beside the query so it can be tested without a database.
 */
export const DIRECT_ORDER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeDirectOrderId(value: string): boolean {
  return DIRECT_ORDER_ID_PATTERN.test(value.trim());
}

export type DirectOrderOperationalFilters = {
  /** Free text across order id, pharmacy name/code, requester, product, area, region. */
  q?: string | null;
  /** One exact database status. For deep links and programmatic callers — the chips use `statusGroup`. */
  status?: string | null;
  /** A chip's grouping. ANDs with `status` rather than replacing it; they answer different questions. */
  statusGroup?: DirectOrderStatusGroupKey | null;
  requesterHrId?: string | null;
  pharmacyId?: string | null;
  pharmacyCode?: string | null;
  areaCode?: string | null;
  regionCode?: string | null;
  productCode?: string | null;
  line?: string | null;
  /** Inclusive ISO dates (YYYY-MM-DD) against created_at. */
  createdFrom?: string | null;
  createdTo?: string | null;
  /** YYYY-MM, or the literal "none" for approved-but-unbooked. */
  salesMonth?: string | null;
  scopeFilter?: DirectOrderOrdersScopeFilter | null;
};

export type DirectOrderOperationalPage<TRow> = {
  rows: TRow[];
  /** Total matching the SCOPED, FILTERED set — not the page, and not the whole table. */
  totalCount: number;
  page: number;
  pageSize: number;
  /** Echoed back so the caller can prove what the server actually applied. */
  appliedFilters: DirectOrderOperationalFilters & { scope: DirectOrderReportScope };
};

export const DIRECT_ORDER_PAGE_SIZE = 25;
/** A page size a caller cannot use to pull the whole table by asking for one enormous page. */
export const DIRECT_ORDER_MAX_PAGE_SIZE = 100;

export function clampDirectOrderPageSize(requested: number | null | undefined): number {
  const n = Math.floor(Number(requested) || 0);
  if (n <= 0) return DIRECT_ORDER_PAGE_SIZE;
  return Math.min(n, DIRECT_ORDER_MAX_PAGE_SIZE);
}

export function clampDirectOrderPage(requested: number | null | undefined): number {
  const n = Math.floor(Number(requested) || 0);
  return n > 0 ? n : 1;
}

/**
 * Expand a set of CANONICAL hr-id keys into every stored form they could appear as.
 *
 * WHY EXPAND THE SET RATHER THAN NORMALISE THE COLUMN. `resolveVisibleRequesterHrIds` returns
 * canonical keys (trim → lowercase → alias map, e.g. `aaa` → `aa`). The stored
 * `requester_hr_id` is whatever `access.hrId` was at submit time. Comparing the two directly in SQL
 * would miss any row whose stored casing differs — which is the defect that made this look like it
 * needed a schema migration first.
 *
 * It does not. `hrIdLookupKeys` already emits {as-is, lower, upper, canonical, canonical-upper},
 * so expanding the (small) key set gives a plain indexed equality filter with no migration, no
 * trigger and no backfill. The alias case is safe in both directions because the helper emits the
 * raw form AND the canonical form — an order filed under `AAA` and one under `AA` both match a
 * viewer whose subtree contains either, which is correct, because the alias table asserts those are
 * the same person.
 *
 * KNOWN LIMIT, DELIBERATELY NOT PAPERED OVER: if a stored value were mixed-case (`Aa-1`) this
 * would miss it, because it expands the LOOKUP value rather than every casing of the STORED value.
 * The employee directory validates hr-ids as uppercase (`hrIdPattern` in employee-directory.ts) and
 * `requester_hr_id` is written from a session that resolves through that directory, so this is not
 * expected to occur — but it is inferred from code, not observed in data. The failure direction is
 * closed-then-wrong: a miss hides a row from a manager, it can never expose an unauthorised one.
 * See DIRECT_ORDERS_HRID_NORMALISATION_VERDICT.md for the one query that settles it.
 */
export function expandRequesterHrIdCandidates(canonicalKeys: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const key of canonicalKeys) {
    for (const variant of hrIdLookupKeys(key)) out.add(variant);
  }
  return [...out];
}

/**
 * The authorization predicate, as data rather than as a query mutation.
 *
 * Returned as a description so it can be unit-tested without a database, and so a test can assert
 * that `own` and `hierarchy` ALWAYS carry a requester predicate — the property that stops a scoped
 * viewer paging through the company.
 */
export type DirectOrderScopePredicate =
  | { kind: "all" }
  /** Match nothing. A tier that cannot resolve its own basis must return zero rows, never all. */
  | { kind: "none"; reason: string }
  | { kind: "requesters"; hrIdCandidates: string[] }
  | { kind: "line"; line: string };

/**
 * Resolve the scope tier into a predicate. FAILS CLOSED at every tier.
 *
 * `own` with no resolvable identity, `hierarchy` with an empty subtree, and `line` with no
 * resolvable line all return `none`. That mirrors getDirectOrderReport's existing behaviour, where
 * an unresolvable line yields `[]` rather than the whole company — the same instinct, made explicit
 * so it can be asserted.
 */
export function resolveDirectOrderScopePredicate(input: {
  scope: DirectOrderReportScope;
  viewerHrId: string | null | undefined;
  visibleRequesterKeys: ReadonlySet<string> | null;
  viewerLine: string | null;
  /** The viewer asked to narrow to their own orders. Narrows only — never widens the tier. */
  scopeFilter?: DirectOrderOrdersScopeFilter | null;
}): DirectOrderScopePredicate {
  // "Mine" is a NARROWING request from the UI, applied on top of whatever the tier already allows.
  // It is safe at every tier precisely because it only ever removes rows.
  if (input.scopeFilter === "mine") {
    const candidates = expandRequesterHrIdCandidates([input.viewerHrId ?? ""].filter(Boolean));
    return candidates.length > 0
      ? { kind: "requesters", hrIdCandidates: candidates }
      : { kind: "none", reason: "the viewer has no resolvable HR_ID to match their own orders" };
  }

  if (input.scope === "all") return { kind: "all" };

  if (input.scope === "line") {
    const line = (input.viewerLine ?? "").trim().toLowerCase();
    return line
      ? { kind: "line", line }
      : { kind: "none", reason: "line scope with no resolvable field line — matches nothing, never everything" };
  }

  // own | hierarchy — both are requester-set tiers.
  const keys = input.visibleRequesterKeys ?? new Set<string>();
  const candidates = expandRequesterHrIdCandidates(keys);
  return candidates.length > 0
    ? { kind: "requesters", hrIdCandidates: candidates }
    : { kind: "none", reason: `${input.scope} scope resolved to an empty requester set` };
}

/**
 * PostgREST `.in()` sends the candidate list in the URL, so a very deep subtree could in principle
 * outgrow the request line. Truncating silently would shrink a manager's visible set without
 * telling anyone — the exact failure mode this file exists to prevent — so callers check this and
 * fall back to an RPC taking the array as a parameter instead.
 */
export const DIRECT_ORDER_IN_CLAUSE_SAFE_LIMIT = 800;

export function requesterCandidatesExceedUrlBudget(candidates: readonly string[]): boolean {
  return candidates.length > DIRECT_ORDER_IN_CLAUSE_SAFE_LIMIT;
}
