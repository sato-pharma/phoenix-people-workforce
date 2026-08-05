import type { DirectOrderRequest } from "@/lib/direct-orders/types";
import { canonicalHrIdKey } from "@/lib/hr-id";

// ─────────────────────────────────────────────────────────────────────────────
// When may the "cancel this held request" control appear? (audit finding F3)
//
// ONE exported predicate, called by the admin page, the portal page and the server, so the three
// cannot drift. That is not a style preference — it is the specific failure this module already
// shipped once: the pharmacy-validation capture was written into the admin detail page only, the
// portal page never got a copy, and since every rep is redirected INTO the portal, the door existed
// in the code and could not be opened by anyone who needed it. It surfaced as 11 held orders worth
// 509,736 EGP with zero validation requests, which read like nobody tried when in fact nobody could.
// ─────────────────────────────────────────────────────────────────────────────

/** The role a Super Admin carries. Compared as a literal in one place rather than five. */
const SUPER_ADMIN = "Super Admin";

/**
 * The REQUESTER of a HELD order, or a Super Admin cleaning up after them.
 *
 * Held-only by design. Once an order has entered the approval chain, withdrawing it is an
 * approver's `reject`, not a requester's cancel — leaving that door open would let a requester pull
 * an order out from under an approver who was mid-decision. And once it is approved, `reverse` is
 * the path, because approved orders have already injected sales that have to be retired properly.
 *
 * Deliberately NOT extended to chain members or managers: nobody is mid-decision on a held order
 * (it sits outside the chain entirely), so there is no reviewer with a stake in it. The person who
 * raised it is the person who knows whether it was a duplicate.
 */
/**
 * Deliberately the NARROWEST shape the rule needs, not `DirectOrderApprovalDetail`.
 *
 * The two pages hold a full `DirectOrderApprovalDetail`; the service holds the `{ request, steps }`
 * that `getDirectOrderRequest` returns. Typing this as either concrete payload forces the other
 * caller to fetch one it does not need — the first version of this file demanded the full detail
 * and would not compile against the service at all. Asking for the request alone lets all three
 * callers share the SAME predicate, which is the entire point of having one.
 */
type CancellableRequest = { request: Pick<DirectOrderRequest, "status" | "requesterHrId"> };

export function canCancelHeldDirectOrder(
  viewer: { hrId?: string | null; role?: string | null },
  detail: CancellableRequest | null,
): boolean {
  if (!detail) return false;
  if (detail.request.status !== "held") return false;

  if ((viewer.role ?? "") === SUPER_ADMIN) return true;

  const viewerKey = canonicalHrIdKey(viewer.hrId ?? "");
  if (!viewerKey) return false;
  return viewerKey === canonicalHrIdKey(detail.request.requesterHrId ?? "");
}
