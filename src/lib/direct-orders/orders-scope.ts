import type { DirectOrderOrdersScopeFilter } from "@/lib/direct-orders/operational-query";
import { canonicalHrIdKey } from "@/lib/hr-id";

// ─────────────────────────────────────────────────────────────────────────────
// Which slice of the orders a viewer lands on, and whether an order is theirs.
//
// Both are decided here, in plain functions, so the server loader, the page shells and the
// workspace component cannot each keep their own opinion.
// ─────────────────────────────────────────────────────────────────────────────

/** The `?scope=` value as the URL spelled it: an explicit choice, or absent. Anything else is absent. */
export function parseRequestedOrdersScope(raw: string | null | undefined): DirectOrderOrdersScopeFilter | null {
  const value = String(raw ?? "").trim().toLowerCase();
  return value === "all" || value === "mine" ? value : null;
}

/**
 * The scope the Orders list and Overview's "Recent orders" show.
 *
 * An explicit `?scope=` always wins — but only "mine" can be honoured for a viewer whose scope is
 * their own orders, because "all" would be the same set under a name that promises more.
 *
 * With nothing asked for, the default is "mine" for anyone who has raised an order, and the whole
 * permitted scope for a viewer who has a wider scope and has raised nothing. The old default, "mine"
 * for everyone, told an approver with 91 orders in scope "You have not raised a direct order yet"
 * (National Sales Manager, 26 Oct 2026) — true, and the opposite of useful.
 */
export function resolveEffectiveOrdersScope(input: {
  requested: DirectOrderOrdersScopeFilter | null | undefined;
  canSeeAllOrders: boolean;
  ownOrderCount: number;
}): DirectOrderOrdersScopeFilter {
  if (!input.canSeeAllOrders) return "mine";
  if (input.requested) return input.requested;
  return input.ownOrderCount > 0 ? "mine" : "all";
}

/**
 * True when the order was raised by the viewer. HR ids are stored in both cases
 * (`direct-order-hr-id-columns-are-mixed-case-and-access-hrid-is-lowercase`), so this compares the
 * canonical key and never the raw strings. A blank id on either side is never a match.
 */
export function isRaisedByViewer(
  requesterHrId: string | null | undefined,
  viewerHrId: string | null | undefined,
): boolean {
  const requester = canonicalHrIdKey(requesterHrId);
  const viewer = canonicalHrIdKey(viewerHrId);
  return Boolean(requester) && Boolean(viewer) && requester === viewer;
}
