import { hrIdsMatch } from "@/lib/hr-id";

/**
 * Marketing PRODUCT WATCHERS — named people who follow every marketing request for named products
 * without holding a step on its approval chain.
 *
 * Owner, 2026-11-19: "make Ahmed Sharaf have access and notification for Guamusin and Ivyronc
 * marketing requests — he can not approve or reject but he can comment — also show the historical
 * requests for these products."
 *
 * Why a named list and not his product scope: Ahmed SharafEldeen (Product Manager) owns four codes in
 * `product_scope_override` (Guamusin, Ivyronc, Tigogrow, Osteosat), but the owner named TWO. And the
 * Pedia requests that promote them are reviewed by the line's Group Product Manager, so he sat on
 * none of the 21 requests' rungs (measured on production, 19 Nov 2026) — nothing told him about any
 * of them, the conversation refused him, and no list showed them.
 *
 * What a watcher gets, and only this:
 *   - READ: the request's Case File and its detail in full, like a CC reviewer — not the narrowed
 *     product-owner read, because the conversation he must comment in can carry the customer's
 *     details and the Case File hides the thread from a viewer who may not see them;
 *   - COMMENT: the request's conversation, at any status;
 *   - TOLD: an in-app, Telegram and phone notice each time a watched request moves, and every
 *     conversation message on it;
 *   - LIST: every request that promotes a watched product, from the first one ever raised.
 * What a watcher never gets: a rung. Nothing here creates an approval step, so there is no approve,
 * reject or return button for him anywhere — the decision services refuse anyone not assigned.
 *
 * Pure: no database, no server-only import, so the portal sidebar can read it too.
 */
export const MARKETING_PRODUCT_WATCHERS: ReadonlyArray<{ hrId: string; productCodes: readonly string[] }> = [
  // Ahmed SharafEldeen — Product Manager. Guamusin (GU001) and Ivyronc (IV001).
  { hrId: "B-155", productCodes: ["GU001", "IV001"] },
];

function normalizeCode(code: string | null | undefined): string {
  return String(code ?? "").trim().toUpperCase();
}

/** The product codes this person watches — empty when they watch nothing. */
export function watchedMarketingProductCodes(hrId: string | null | undefined): ReadonlySet<string> {
  const codes = new Set<string>();
  if (!hrId) return codes;
  for (const watcher of MARKETING_PRODUCT_WATCHERS) {
    if (!hrIdsMatch(watcher.hrId, hrId)) continue;
    for (const code of watcher.productCodes) codes.add(normalizeCode(code));
  }
  return codes;
}

/** Is this person a product watcher at all? Drives the portal sidebar row and the list page gate. */
export function isMarketingProductWatcher(hrId: string | null | undefined): boolean {
  return watchedMarketingProductCodes(hrId).size > 0;
}

/** Does this person watch at least one of the products this request promotes? */
export function watchesMarketingRequestProducts(
  hrId: string | null | undefined,
  requestProductCodes: Iterable<string>,
): boolean {
  const watched = watchedMarketingProductCodes(hrId);
  if (watched.size === 0) return false;
  for (const code of requestProductCodes) {
    if (watched.has(normalizeCode(code))) return true;
  }
  return false;
}

/** Every watcher of at least one of these products — the people a request's movement must reach. */
export function marketingProductWatcherHrIds(requestProductCodes: Iterable<string>): string[] {
  const codes = new Set(Array.from(requestProductCodes, normalizeCode).filter(Boolean));
  if (codes.size === 0) return [];
  return MARKETING_PRODUCT_WATCHERS.filter((watcher) =>
    watcher.productCodes.some((code) => codes.has(normalizeCode(code))),
  ).map((watcher) => watcher.hrId);
}

/** The workflow moments a watcher is told about — every move, never the approvers' own SLA nudges. */
export type MarketingWatchedEvent =
  | "request_assigned"
  | "request_returned"
  | "request_approved"
  | "request_rejected"
  | "request_completed";

const WATCHED_EVENTS: ReadonlySet<string> = new Set<MarketingWatchedEvent>([
  "request_assigned",
  "request_returned",
  "request_approved",
  "request_rejected",
  "request_completed",
]);

/** A due-date or overdue reminder is the approver's nudge to act; a watcher cannot act, so it is not his. */
export function isWatchedMarketingEvent(eventType: string): eventType is MarketingWatchedEvent {
  return WATCHED_EVENTS.has(eventType);
}

/**
 * The words a watcher reads. Never the approver's wording: "needs your approval" sent to someone who
 * holds no rung is a false instruction, and he has no button to press.
 */
export function marketingWatcherNoticeWording(input: {
  currentStepName: string | null | undefined;
  eventType: MarketingWatchedEvent;
  requestCode: string | null | undefined;
}): { message: string; title: string } {
  const code = String(input.requestCode ?? "").trim() || "A marketing request";
  const step = String(input.currentStepName ?? "").trim();
  const moved =
    input.eventType === "request_assigned"
      ? step
        ? `is now with ${step}`
        : "moved to its next approval step"
      : input.eventType === "request_returned"
        ? "was returned to the requester for changes"
        : input.eventType === "request_approved"
          ? "was approved"
          : input.eventType === "request_rejected"
            ? "was rejected"
            : "was completed";
  return {
    message: `${code} ${moved}. You follow this product's requests: you can read it and comment on it, and you hold no approval step on it.`,
    title: `${code} ${moved}`,
  };
}
