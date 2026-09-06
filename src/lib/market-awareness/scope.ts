import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type { MarketAwarenessStatus } from "@/lib/market-awareness/types";

/**
 * Who sees what, and who may do what.
 *
 * The permission matrix says whether a role may read the module. It cannot say WHOSE rows, because
 * it has no per-row layer — that narrowing lives here, and it is applied in the service before any
 * query returns, never in a component. A screen that filters what a route already returned has
 * already leaked it.
 */

/**
 * Creators: the Group Product Manager, both Product Managers, the Marketing Manager and Super Admin.
 *
 * Owner answer 2 chose "GPM and Product Managers only" from the dropdown and then wrote "also
 * marketing manager and systemn admin" in the note. The NOTE is authoritative — it is the more
 * specific statement, and answer 35 confirms it by settling where the Marketing Manager's OWN
 * request goes, a question that only arises if he can raise one.
 */
export const MARKET_AWARENESS_CREATOR_ROLES: readonly PhoenixRole[] = [
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Super Admin",
] as const;

/**
 * Roles that see every activity. A Product Manager is deliberately absent: he sees his own only
 * (owner answer 3), and that narrowing is `ownOnly` below.
 *
 * The informed roles — NSM, SFE Manager, District Manager, Finance Manager — are here because being
 * informed of an approved activity is meaningless without being able to open it. They hold `read`
 * and nothing else in the matrix, so seeing everything cannot become doing anything.
 */
export const MARKET_AWARENESS_SEE_ALL_ROLES: readonly PhoenixRole[] = [
  "Super Admin",
  "CEO",
  "Group Product Manager",
  "Marketing Manager",
  "National Sales Manager",
  "SFE Manager",
  "District Manager",
  "Finance Manager",
] as const;

export function canCreateActivity(access: Pick<AccessContext, "role">): boolean {
  return MARKET_AWARENESS_CREATOR_ROLES.includes(access.role);
}

export function seesEveryActivity(access: Pick<AccessContext, "role">): boolean {
  return MARKET_AWARENESS_SEE_ALL_ROLES.includes(access.role);
}

export type ActivityVisibility =
  | { kind: "all" }
  | { kind: "own"; hrId: string }
  | { kind: "none" };

/**
 * What this viewer may list.
 *
 * `none` for a viewer with no HR id who is not a see-all role: an unauthenticated caller resolves to
 * role `Employee` rather than to null here, so a `!access.role` guard would never fire. The check is
 * positive — a role that may see all, or an identity to scope to — never "not refused".
 */
export function resolveActivityVisibility(
  access: Pick<AccessContext, "role" | "hrId">,
): ActivityVisibility {
  if (seesEveryActivity(access)) return { kind: "all" };
  const hrId = access.hrId?.trim();
  if (!hrId) return { kind: "none" };
  if (access.role === "Product Manager") return { kind: "own", hrId };
  return { kind: "none" };
}

export function canViewActivity(
  access: Pick<AccessContext, "role" | "hrId">,
  activity: { requesterHrId: string },
): boolean {
  const visibility = resolveActivityVisibility(access);
  if (visibility.kind === "all") return true;
  if (visibility.kind === "none") return false;
  return canonicalHrIdKey(visibility.hrId) === canonicalHrIdKey(activity.requesterHrId);
}

/**
 * Editing. An APPROVED activity is locked (owner answer 40): changing the cost or the brick after
 * approval would leave the approval describing something that never happened. The way to change one
 * is to withdraw and raise a new one.
 */
export function canEditActivity(
  access: Pick<AccessContext, "role" | "hrId">,
  activity: { requesterHrId: string; status: MarketAwarenessStatus },
): boolean {
  if (!["draft", "returned"].includes(activity.status)) return false;
  if (access.role === "Super Admin") return true;
  if (!access.hrId) return false;
  return canonicalHrIdKey(access.hrId) === canonicalHrIdKey(activity.requesterHrId);
}

export function canWithdrawActivity(
  access: Pick<AccessContext, "role" | "hrId">,
  activity: { requesterHrId: string; status: MarketAwarenessStatus },
): boolean {
  const withdrawable: MarketAwarenessStatus[] = [
    "draft",
    "returned",
    "pending_manager",
    "pending_ceo",
  ];
  if (!withdrawable.includes(activity.status)) return false;
  if (access.role === "Super Admin") return true;
  if (!access.hrId) return false;
  return canonicalHrIdKey(access.hrId) === canonicalHrIdKey(activity.requesterHrId);
}

/** Closure is the requester's own step: he marks it executed and writes the outcome. */
export function canCloseActivity(
  access: Pick<AccessContext, "role" | "hrId">,
  activity: { requesterHrId: string; status: MarketAwarenessStatus },
): boolean {
  if (!["approved", "executed"].includes(activity.status)) return false;
  if (access.role === "Super Admin") return true;
  if (!access.hrId) return false;
  return canonicalHrIdKey(access.hrId) === canonicalHrIdKey(activity.requesterHrId);
}

/**
 * The paid / not-paid mark. Finance only, and only once the CEO has approved — marking an
 * unapproved activity paid would record a payment against something nobody authorised.
 */
export function canMarkFinancePaid(
  access: Pick<AccessContext, "role">,
  activity: { status: MarketAwarenessStatus },
): boolean {
  if (!["approved", "executed", "closed"].includes(activity.status)) return false;
  return access.role === "Finance Manager" || access.role === "Super Admin";
}
