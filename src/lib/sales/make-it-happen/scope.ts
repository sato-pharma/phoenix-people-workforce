// ─────────────────────────────────────────────────────────────────────────────
// Make It Happen — who plans which rows.
//
// Roles (owner, 2026-09-13): Medical Rep, District Manager, National Sales Manager, SFE Manager,
// Product Manager, Group Product Manager, Marketing Manager, Super Admin. Regional Manager and CEO
// were not named and are not admitted.
//
// Reach is the Sales vs Target bound — a rep is bounded to the rows attributed to them, a DM to
// their district's areas, an NSM / GPM / Marketing Manager to their line, SFE Manager and Super
// Admin to the company — with ONE owner-ruled difference: a Product Manager plans THEIR OWN
// products company-wide (weekly_sales_product_scope), falling back to the line only when no
// products are assigned to them, the same fallback Weekly Sales uses.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { resolveWeeklyProductBound } from "@/lib/sales/weekly/access";
import {
  boundLabel,
  filterRowsForBound,
  resolveVsTargetBound,
  type VsTargetBound,
} from "@/lib/sales/vs-target-scope";

/** Portal-shell roles. Mirrored by showMakeItHappenTab in src/lib/employee-portal/navigation.ts. */
export const MAKE_IT_HAPPEN_PORTAL_ROLES: ReadonlyArray<PhoenixRole> = [
  "Medical Rep",
  "District Manager",
  // Owner, 2026-11-14 ("Yes, own region"): his own region only. The bound is the sales scope's seat
  // areas (vs-target-scope.ts), and a Regional Manager whose seat gives no areas fails closed to none.
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
];

/** Admin-shell roles. Mirrored by the /sales/make-it-happen row in system-navigation.ts. */
export const MAKE_IT_HAPPEN_ADMIN_ROLES: ReadonlyArray<PhoenixRole> = ["SFE Manager", "Super Admin"];

const MAKE_IT_HAPPEN_ROLES = new Set<string>([...MAKE_IT_HAPPEN_PORTAL_ROLES, ...MAKE_IT_HAPPEN_ADMIN_ROLES]);

export function canUseMakeItHappen(role: string | null | undefined): boolean {
  return role != null && MAKE_IT_HAPPEN_ROLES.has(role);
}

export type MakeItHappenBound = {
  rows: VsTargetBound;
  /** Set only for a Product Manager with assigned products: their products, company-wide. */
  productCodes: ReadonlySet<string> | null;
  label: string;
};

export async function resolveMakeItHappenBound(ctx: AccessContext): Promise<MakeItHappenBound> {
  if (!canUseMakeItHappen(ctx.role)) {
    return { rows: { kind: "none" }, productCodes: null, label: "No sales territory" };
  }
  if (ctx.role === "Product Manager") {
    // No list → the line bound below, as on every other screen (owner, 2026-09-18).
    const codes = await resolveWeeklyProductBound(canonicalHrIdKey(ctx.hrId ?? ctx.loginId ?? null));
    if (codes) return { rows: { kind: "company" }, productCodes: codes, label: "Your products" };
  }
  const rows = await resolveVsTargetBound(ctx);
  return { rows, productCodes: null, label: makeItHappenBoundLabel(rows) };
}

/** A viewer placed on several lines (a Marketing Manager usually is) must not read "Your line". */
export function makeItHappenBoundLabel(rows: VsTargetBound): string {
  return rows.kind === "line" && rows.lineCodes.size > 1 ? "Your lines" : boundLabel(rows);
}

/** Apply the bound to raw achievement rows. PURE — runs before any roll-up. */
export function applyMakeItHappenBound(rows: AchievementRow[], bound: MakeItHappenBound): AchievementRow[] {
  const scoped = filterRowsForBound(rows, bound.rows);
  const codes = bound.productCodes;
  if (!codes) return scoped;
  return scoped.filter((row) => codes.has(row.productCode.trim().toUpperCase()));
}

/** A bound that spans more than one person — the viewer gets the per-rep view. */
export function isTeamBound(bound: MakeItHappenBound): boolean {
  return bound.rows.kind !== "self" && bound.rows.kind !== "none";
}
