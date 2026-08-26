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

/**
 * The lines that carry an Office channel at all — the owner's rule, 2026-08-25: **CNS only.**
 *
 * Office is not a distributor. It is the company's own stock, imported last and spread across
 * areas by the owner's value-share rule (see office-allocation.ts). Only CNS works that way, and
 * production agrees. Every Office import row ever validated, counted 2026-08-25:
 *
 *   CNS   2026-01 → 2026-07   15,564 rows   219,245 units
 *   Pedia 2026-01 only            84 rows       556 units   150,119.99 EGP
 *
 * Anti Infective and Head Office have never had one. That single Pedia slice is the whole of the
 * non-CNS history, and it is seven months old.
 *
 * So on Pedia, Anti Infective and Head Office the "of wh. Office" columns and the Office
 * Allocation sheet were a wall of zeroes beside every real figure — measured 2026-08-25, the
 * Office grid's grand total for Pedia and Anti Infective 2026-08 is 0.00.
 *
 * DISPLAY ONLY. The Office grid is a lens on the closing, never a source of it: no headline,
 * subtotal or grand total anywhere is computed from it, so hiding the columns cannot move a
 * number. The one visible consequence is that Pedia's 2026-01 Office slice above no longer shows
 * its breakdown — those 556 units and 150,119.99 EGP stay inside Pedia's January sales exactly as
 * before, they just are not broken out any more.
 */
export const OFFICE_CHANNEL_LINES = ["CNS"] as const;

/** True when this line's closing should carry the Office breakdown. See OFFICE_CHANNEL_LINES. */
export function lineHasOfficeChannel(line: string | null | undefined): boolean {
  const normalized = String(line ?? "").trim().toUpperCase();
  return OFFICE_CHANNEL_LINES.some((candidate) => candidate.toUpperCase() === normalized);
}
