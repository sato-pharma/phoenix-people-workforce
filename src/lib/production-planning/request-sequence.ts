/**
 * 🔴 A LATE ANSWER FOR THE PRODUCT HE LEFT MUST NEVER LAND ON THE PRODUCT HE IS ON.
 *
 * The planner's whole payload is per product, and switching the dropdown fires a new GET while the
 * old one may still be in flight. Before this, whichever answer arrived LAST won: pick Ivyronc, then
 * Guamusin, and a slow Ivyronc response painted Ivyronc's figures under the Guamusin heading — and
 * Save posted `productId: Guamusin` beside them. Technical audit 23 Oct 2026, P7-04.
 *
 * Two guards, both here so they can be tested without React:
 *  - `createRequestSequence` — every request takes a ticket, and only the newest ticket may write
 *    state. An older answer is dropped whatever order the network returns them in.
 *  - `planForSelection` — a computed plan is shown (and can be saved) only while it belongs to the
 *    product the screen is on. A plan for another product is withheld, which also disables Save.
 */
export type RequestSequence = {
  /** Start a request; the returned ticket is what its answer is checked against. */
  begin: () => number;
  /** True only for the newest ticket handed out — an answer for anything older is stale. */
  isCurrent: (ticket: number) => boolean;
  /** Make every ticket already handed out stale, without starting a new request. */
  invalidate: () => void;
};

export function createRequestSequence(): RequestSequence {
  let latest = 0;
  return {
    begin: () => {
      latest += 1;
      return latest;
    },
    invalidate: () => {
      latest += 1;
    },
    isCurrent: (ticket: number) => ticket === latest,
  };
}

/** The plan, only when it was computed for the product the screen is on; otherwise null. */
export function planForSelection<T extends { productId: string }>(
  plan: T | null,
  selectedProductId: string,
): T | null {
  if (!plan || !selectedProductId) return null;
  return plan.productId === selectedProductId ? plan : null;
}
