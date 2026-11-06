/**
 * The three lists a CRM agent can hold — PM doctors, AM doctors and pharmacies — in the old CRM's
 * exact spelling (`Pharmacy`, never `PH`: an unknown type came back as an empty grid, not an
 * error). Kept after iReports360 was retired (6 November 2026) because the stored contact lists,
 * the KPI rules and Employee 360 still key every row by it.
 */
export const LIST_TYPES = ["PM", "AM", "Pharmacy"] as const;
export type CrmListType = (typeof LIST_TYPES)[number];
