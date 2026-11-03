// ─────────────────────────────────────────────────────────────────────────────
// CRM viewer scope — who may see which CRM rows.
//
// Until now the CRM data layer had NO notion of a viewer at all: getCrmMasterData took only a
// filter bag, and visibility was decided entirely by /admin/crm's hardcoded `role !== "Super Admin"`
// page redirect. Opening CRM to the field-management roles therefore needs a real row bound.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE:
//
// 1. EXACT-MATCH ONLY. Scope is expressed as `agentHrIds` -> `.in("agent_hr_id", ...)`, NEVER as
//    `agentHrIdILike` -> `.ilike("agent_hr_id", "%x%")`. This repo has already shipped and fixed a
//    substring-HR_ID leak (incident "C1": an employee whose id PREFIXED another's saw their
//    colleague's rows). tests/crm-visits-self-scope.test.ts names the ilike filter as that risk.
//
// 2. FAIL CLOSED BY CONSTRUCTION. The scope is a REQUIRED parameter, not an optional one, and
//    company-wide access must be spelled out as `CRM_SCOPE_ALL`. An optional `scope?` defaulting to
//    unrestricted would mean any future caller who forgets it silently exposes the whole company.
//    Making it required turns that into a compile error.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Server-resolved row bound for every CRM master read.
 *
 * `company` is constructed in exactly two places — the /admin/crm page and its export route — and a
 * test pins that. Everything else must pass an `hr-ids` scope.
 */
import { canonicalHrIdKey } from "@/lib/hr-id";

export type CrmViewerScope =
  | { kind: "company" }
  | {
      /** Bounded to a set of agents. An EMPTY array means "sees nothing", never "sees everything". */
      kind: "hr-ids";
      /** Raw employees.hr_id values, matched exactly (case-insensitively, via expandHrIdFilterValues). */
      hrIds: readonly string[];
      /** canonicalHrIdKey keys for the in-memory computed tabs (vacations / triple visits). */
      keys: ReadonlySet<string>;
      /** Official line names in scope, used to trim the Line dropdown. null = no trim. */
      lineNames: readonly string[] | null;
    };

/** The only company-wide scope value. Grep-able on purpose: a test asserts where it may appear. */
export const CRM_SCOPE_ALL: CrmViewerScope = { kind: "company" };

/** A bound that matches nothing — the fail-closed value for an unresolvable viewer. */
export function crmScopeNothing(): CrmViewerScope {
  return { kind: "hr-ids", hrIds: [], keys: new Set<string>(), lineNames: [] };
}

function normalizeHrIdKey(value: string): string {
  return canonicalHrIdKey(value) ?? "";
}

/**
 * Intersect the viewer's scope with the Line / Hiring-date filter's allow-set.
 *
 * BOTH land in the SAME `allowedHrIds` slot of applyMasterFilters, so they must be combined here —
 * if one simply overwrote the other, a District Manager selecting "Line: Pedia" would see ALL of
 * Pedia. Intersecting is what makes the UI filter NARROW the scope instead of replacing it.
 *
 * `null` on a side means "no restriction from that side". The result is `null` ONLY when both are
 * null; an empty intersection returns `[]` (matches nobody), never `null`.
 */
export function intersectHrIdAllowLists(
  scopeHrIds: readonly string[] | null,
  filterHrIds: readonly string[] | null,
): string[] | null {
  if (!scopeHrIds && !filterHrIds) return null;
  if (!scopeHrIds) return [...(filterHrIds ?? [])];
  if (!filterHrIds) return [...scopeHrIds];
  const filterKeys = new Set(filterHrIds.map(normalizeHrIdKey));
  return scopeHrIds.filter((hrId) => filterKeys.has(normalizeHrIdKey(hrId)));
}

/** Same intersection for the canonical-key sets the in-memory computed tabs use. */
export function intersectHrIdKeySets(
  scopeKeys: ReadonlySet<string> | null,
  filterKeys: ReadonlySet<string> | null,
): Set<string> | null {
  if (!scopeKeys && !filterKeys) return null;
  if (!scopeKeys) return new Set(filterKeys ?? []);
  if (!filterKeys) return new Set(scopeKeys);
  const result = new Set<string>();
  for (const key of scopeKeys) if (filterKeys.has(key)) result.add(key);
  return result;
}
