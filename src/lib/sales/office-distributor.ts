/**
 * The Office channel's distributor code — the one marker that tells an allocated Office unit apart
 * from a real distributor sell-out unit.
 *
 * A leaf module on purpose. `office-allocation.ts` owns the allocation and imports
 * `monthly-distributor-import.ts`, so the closing loader cannot import the constant back from there
 * without a cycle. Everything that only needs to ASK "is this row Office?" imports it from here.
 */
export const OFFICE_DISTRIBUTOR_CODE = "Office";

/** True when a row's distributor code is the Office channel. Tolerant of case and stray spaces. */
export function isOfficeDistributorCode(value: unknown): boolean {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase() === OFFICE_DISTRIBUTOR_CODE.toUpperCase();
}
