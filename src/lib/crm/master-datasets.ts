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
