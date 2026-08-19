// ─────────────────────────────────────────────────────────────────────────────
// Extra Direct Orders areas — a narrow, DIRECT-ORDERS-ONLY widening.
//
// WHY THIS EXISTS: a person's area scope comes from the organogram seat map
// (src/lib/sales/seat-area-scope.ts), and `au.line_area_map` allows exactly ONE
// district-manager seat per (line, area) — `line_area_map_current` is a unique
// index on (line_code, area_code) where effective_to is null. So the only way to
// let a second manager work in an area through the seat map is to TAKE it from
// the manager who holds it, which would move that manager's sales attribution,
// targets, incentive scope and approval chain with it.
//
// When the owner wants someone to be able to raise a direct order in a
// neighbouring district WITHOUT any of that, this file is the whole mechanism:
// a hand-listed set of extra area codes per HR id, read in exactly one place
// (`listDirectOrderAreaAndBrickOptions`) and therefore visible in exactly one
// module. It adds areas to what Direct Orders offers and searches. It does NOT
// touch the seat map, the org chart, sales dashboards, targets, incentives, or
// anyone else's scope — those all keep reading the seat map, unchanged.
//
// It only ever WIDENS. An HR id absent from the map behaves exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HR id → extra AREA codes that person may also use in Direct Orders.
 *
 * Area codes are the canonical `au.canonical_areas.area_code` values (AB1, D21, …),
 * the same ones the seat map and `source_of_sales_bricks.area_code` use. Bricks are
 * NOT listed here: every brick under a granted area comes along automatically, so a
 * brick added to that area later needs no edit here.
 *
 * Keep an entry only while the person actually needs it — this is a standing grant,
 * not a dated one, and nothing expires it.
 */
const EXTRA_DIRECT_ORDER_AREA_CODES: Readonly<Record<string, readonly string[]>> = {
  // Salim Gomaa — Anti Infective District Sales Manager, seat SEAT-AIF-DM-D2 (Delta (2):
  // D21-D24, D26). Owner instruction 2026-08-19: he also covers Alex-BHR, and must be able
  // to register a pharmacy and raise a direct order there. Alex-BHR stays on Sara Samir's
  // seat SEAT-AIF-DM-AB, so her district is untouched.
  "B-76": ["AB1", "AB2", "AB3", "AB4", "AB5"],
};

/** Case/whitespace-insensitive HR id key, matching how the seat map compares ids. */
function hrKey(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

/**
 * The extra Direct Orders area codes granted to `hrId`, UPPER-cased. Empty for everyone
 * with no entry, which is almost everyone — callers can treat an empty set as "no change".
 */
export function extraDirectOrderAreaCodes(hrId: string | null | undefined): Set<string> {
  const codes = EXTRA_DIRECT_ORDER_AREA_CODES[hrKey(hrId)];
  if (!codes) return new Set<string>();
  return new Set(codes.map((code) => code.trim().toUpperCase()).filter(Boolean));
}
