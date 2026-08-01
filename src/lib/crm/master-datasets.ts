/**
 * The CRM master table's dataset list — split out from master.ts on purpose: this file has NO
 * server-only imports (no Supabase admin client, no employee-directory chain), so client
 * components (CrmMasterTable, CrmTabBar) can import CRM_MASTER_DATASETS as a real value without
 * pulling master.ts's server-only dependency chain into the browser bundle. master.ts re-exports
 * both for its own (server-side) consumers.
 */

export type CrmMasterDataset =
  | "visits"
  | "checkins"
  | "double_visits"
  | "triple_visits"
  | "vacations"
  | "regular_no_checkin"
  | "regular_dv_no_checkin";

/** All datasets a tab can show, in display order. Unmapped-identity resolution ("CRM Issues") and
 * the double-visit chain-recovery audit are separate views on the same hub page (see
 * CrmTabBar / CrmUnmappedIdentitiesPanel / CrmRecoveredChainsPanel) — not a raw dataset, since
 * they show aggregated/derived rows rather than a paginated slice of one table. */
export const CRM_MASTER_DATASETS: ReadonlyArray<{ id: CrmMasterDataset; label: string }> = [
  { id: "visits", label: "Visits" },
  { id: "checkins", label: "Check-ins" },
  { id: "double_visits", label: "Double Visits" },
  { id: "triple_visits", label: "Triple Visits" },
  { id: "vacations", label: "Vacations" },
  { id: "regular_no_checkin", label: "Regular · No Check-in" },
  { id: "regular_dv_no_checkin", label: "Regular DV · No Check-in" },
];

/** Every filter the master table's filter bar can offer. */
export type CrmMasterFilterKey =
  | "agentHrId"
  | "ampm"
  | "dateRange"
  | "halfDaysOnly"
  | "hireDate"
  | "line"
  | "mappingStatus"
  | "minDuration"
  | "search"
  | "visitType";

/** Filters every dataset honours: the date range scopes the fetch, and the rest resolve through
 * either the DB query (applyMasterFilters) or the in-memory pass (filterComputedRows). */
const UNIVERSAL_FILTERS: readonly CrmMasterFilterKey[] = ["agentHrId", "dateRange", "hireDate", "line", "search"];

/**
 * Which filters each dataset ACTUALLY honours — the single source of truth for three things that
 * had drifted apart: which controls the filter bar renders, which active-filter chips it shows, and
 * which values the server echoes back as applied.
 *
 * They drifted because the filter bar gated controls on ad-hoc booleans (`!isCheckins`,
 * `isVacations`) while the server gated enforcement on a different condition. The computed tabs
 * (Vacations, Triple Visits) don't go through the DB filter builder at all — they compute rows in
 * memory and run `filterComputedRows`, which knows nothing about AM/PM, Visit Type, or Mapping. So
 * those three controls rendered, accepted a value, produced a chip asserting the filter was on, and
 * changed nothing: picking "Annual Vacation" on the Vacations tab still returned Health Day rows.
 * A filter that silently does nothing is worse than one that isn't offered — the user believes the
 * narrowed list is the answer.
 *
 * Keep this in step with `filterComputedRows` / `applyMasterFilters`: adding a control here without
 * teaching one of those to honour it re-creates exactly the bug this map exists to prevent.
 */
export const CRM_MASTER_SUPPORTED_FILTERS: Readonly<Record<CrmMasterDataset, readonly CrmMasterFilterKey[]>> = {
  visits: [...UNIVERSAL_FILTERS, "ampm", "mappingStatus", "visitType"],
  // Check-ins are a different table with no ampm / visit_type / agent-mapping columns, so the DB
  // filter builder already skips all three for this dataset (`isVisits` guards).
  checkins: [...UNIVERSAL_FILTERS],
  double_visits: [...UNIVERSAL_FILTERS, "ampm", "mappingStatus", "visitType"],
  // Computed in memory (computeTriplesInRange -> filterComputedRows): no AM/PM, type or mapping.
  triple_visits: [...UNIVERSAL_FILTERS],
  // Computed in memory (computeVacationPeriods -> filterComputedRows). Duration / half-days are
  // period-level fields that exist ONLY here.
  vacations: [...UNIVERSAL_FILTERS, "halfDaysOnly", "minDuration"],
  regular_no_checkin: [...UNIVERSAL_FILTERS, "ampm", "mappingStatus", "visitType"],
  regular_dv_no_checkin: [...UNIVERSAL_FILTERS, "ampm", "mappingStatus", "visitType"],
};

/** True when `dataset` actually applies `key`. Use this instead of re-deriving per-tab booleans. */
export function crmMasterSupportsFilter(dataset: CrmMasterDataset, key: CrmMasterFilterKey): boolean {
  return CRM_MASTER_SUPPORTED_FILTERS[dataset].includes(key);
}
