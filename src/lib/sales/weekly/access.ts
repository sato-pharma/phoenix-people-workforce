import {
  resolveEmployeeIdentityId,
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { sharedIdentityKeys } from "@/lib/auth/identity-aliases";
import { canonicalHrIdKey } from "@/lib/hr-id";
import {
  applyLineRegionScope,
  canViewHeadOfficeLine,
  canonicalizeRegionName,
  isHeadOfficeLine,
  isRestrictedProductCode,
  normalizeLineKey,
  resolveSalesAccessScope,
} from "@/lib/sales/access-scope";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Weekly Sales — per-viewer access scope.
//
// Three visibility tiers gate every weekly dashboard read:
//  • full      — the whole company. Exception HR_IDs and CEO/Super Admin see EVERYTHING
//                including the confidential Lacto Basic products (LA003/LA004); SFE Manager
//                sees everything EXCEPT those.
//  • product   — Product / Group Product / Marketing Managers see ONLY the product codes
//                explicitly assigned to them in `weekly_sales_product_scope` (by HR_ID).
//                Line is ignored entirely; an empty assignment set means they see nothing.
//  • territory — sales-field roles (District / Regional / National Sales Manager, Medical
//                Rep) reuse the monthly sales scope: bounded to their own line and/or region.
//
// Confidential products are stripped for every tier except a full-access viewer who is
// allowed to reveal them — mirroring the locked rule in `access-scope.ts`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exception accounts: full weekly access (incl. restricted products) regardless of role — the CEO
 * (AA) and the HR Manager. The latter also holds the system-administrator console, so every HR_ID
 * of that one person is expanded from the shared-identity groups instead of being listed by hand.
 */
export const WEEKLY_FULL_ACCESS_HR_IDS: ReadonlySet<string> = new Set(
  [...sharedIdentityKeys("B-10"), canonicalHrIdKey("aa")].filter((id): id is string => Boolean(id)),
);

/** Roles scoped by their explicit product assignments (line ignored). */
const PRODUCT_SCOPED_ROLES: ReadonlySet<PhoenixRole> = new Set([
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
]);

/** Sales-field roles scoped to their own line/region via the shared monthly sales scope. */
const TERRITORY_SCOPED_ROLES: ReadonlySet<PhoenixRole> = new Set([
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Medical Rep",
]);

type WeeklyAccessTier =
  | { tier: "full"; canViewRestricted: boolean }
  | { tier: "product"; productCodes: Set<string> }
  | {
      tier: "territory";
      allowedLineNames: Set<string> | null;
      /**
       * Region bound applied to rows that carry NO area (the norm — see areaCode on the fact row).
       * This stays the viewer's OWN region label, exactly as before, which is why adding the area
       * bound below can only ever ADD rows, never remove or leak any.
       */
      allowedRegionCodes: Set<string> | null;
      /**
       * Seat-derived area bound (src/lib/sales/seat-area-scope.ts), applied to rows that DO carry an
       * area. null = no area bound, so behaviour is identical to before. This is what lets a District
       * Manager see the weekly numbers of an area he owns that sits in another region (CNS
       * "Kafr El-Sheikh 1" under the Alex-BHR DM) without widening his region bound to that region.
       */
      allowedAreaCodes: Set<string> | null;
    }
  | { tier: "none" };

/** Tier + the confidential Head Office line flag (CEO/Super Admin only). */
export type WeeklyAccessScope = WeeklyAccessTier & { canViewHeadOffice: boolean };

/** Canonical HR_ID key for the caller (employee identity first, then login). */
function viewerHrKey(ctx: AccessContext): string | null {
  return canonicalHrIdKey(resolveEmployeeIdentityId(ctx) ?? ctx.hrId ?? ctx.loginId ?? null);
}

/** Read the product codes assigned to one person in the weekly product-scope table. */
export async function getWeeklyProductScopeCodes(hrKey: string | null): Promise<Set<string>> {
  if (!hrKey) return new Set();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("weekly_sales_product_scope")
    .select("product_code")
    .eq("hr_id", hrKey);
  if (error) return new Set();
  return new Set((data ?? []).map((row) => String(row.product_code ?? "").trim().toUpperCase()).filter(Boolean));
}

/** All product-scope assignments, grouped by canonical HR_ID (for the admin manager). */
export async function listWeeklyProductScopeAssignments(): Promise<Map<string, Set<string>>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("weekly_sales_product_scope").select("hr_id, product_code");
  if (error) throw new Error(error.message);
  const byHrId = new Map<string, Set<string>>();
  for (const row of data ?? []) {
    const hrKey = canonicalHrIdKey(String(row.hr_id ?? ""));
    const code = String(row.product_code ?? "").trim().toUpperCase();
    if (!hrKey || !code) continue;
    const bucket = byHrId.get(hrKey) ?? new Set<string>();
    bucket.add(code);
    byHrId.set(hrKey, bucket);
  }
  return byHrId;
}

/** Replace one person's full set of assigned product codes (delete-then-insert). */
export async function replaceWeeklyProductScope(
  hrId: string,
  productCodes: string[],
  actorId: string | null,
): Promise<void> {
  const hrKey = canonicalHrIdKey(hrId);
  if (!hrKey) throw new Error("A valid HR_ID is required.");
  const codes = [...new Set(productCodes.map((code) => code.trim().toUpperCase()).filter(Boolean))];
  const supabase = getSupabaseAdmin();

  const del = await supabase.from("weekly_sales_product_scope").delete().eq("hr_id", hrKey);
  if (del.error) throw new Error(del.error.message);
  if (codes.length === 0) return;

  const insert = await supabase.from("weekly_sales_product_scope").insert(
    codes.map((product_code) => ({ hr_id: hrKey, product_code, created_by: actorId })),
  );
  if (insert.error) throw new Error(insert.error.message);
}

/**
 * Resolve the full weekly access scope for a request/page context. Does all the DB/reference
 * work up front so the dashboard aggregator can stay a pure in-memory filter.
 */
export async function resolveWeeklyAccessScope(ctx: AccessContext): Promise<WeeklyAccessScope> {
  const tier = await resolveWeeklyAccessTier(ctx);
  // Head Office line is confidential — only CEO / Super Admin may ever see it, regardless of tier
  // (so even a full-access exception HR_ID or SFE Manager is stripped). Fail-closed.
  return { ...tier, canViewHeadOffice: canViewHeadOfficeLine(ctx.role) };
}

async function resolveWeeklyAccessTier(ctx: AccessContext): Promise<WeeklyAccessTier> {
  const hrKey = viewerHrKey(ctx);

  // 1. Exception accounts — full access including restricted products.
  if (hrKey && WEEKLY_FULL_ACCESS_HR_IDS.has(hrKey)) {
    return { tier: "full", canViewRestricted: true };
  }

  // 2. Company executives keep full access (CEO/Super Admin reveal restricted products).
  if (ctx.role === "Super Admin" || ctx.role === "CEO") return { tier: "full", canViewRestricted: true };

  // 3. The product-scope sheet is the source of truth: anyone with an explicit assignment is bounded
  // to exactly those products — regardless of role (e.g. an SFE Manager who owns a curated list).
  const assignedCodes = await getWeeklyProductScopeCodes(hrKey);
  if (assignedCodes.size > 0) return { tier: "product", productCodes: assignedCodes };

  // 4. Product roles without an explicit assignment fall back to their full line scope so they
  //    always see data without requiring an admin to populate weekly_sales_product_scope.
  if (PRODUCT_SCOPED_ROLES.has(ctx.role)) {
    const scope = await resolveSalesAccessScope(ctx);
    return { tier: "territory", allowedLineNames: scope.allowedLineNames, allowedRegionCodes: null, allowedAreaCodes: null };
  }

  // 5. Sales-field roles — reuse the monthly line/region scope.
  if (TERRITORY_SCOPED_ROLES.has(ctx.role)) {
    const scope = await resolveSalesAccessScope(ctx);
    if (scope.canViewAllSales) return { tier: "full", canViewRestricted: scope.canViewRestrictedProducts };
    let allowedRegionCodes = await resolveRegionCodesForNames(scope.allowedRegionNames);
    // A Regional Manager's real coverage is every region his seat's areas live in — for the Pedia RSM
    // that resolves to exactly AB + D1 + D2, which is what the previously hardcoded set spelled out.
    // Deriving it from the seat map means a reorganisation no longer needs a code change.
    if (ctx.role === "Regional Manager" && scope.allowedAreaFactRegionCodes) {
      allowedRegionCodes = new Set(scope.allowedAreaFactRegionCodes);
    } else if (ctx.role === "Regional Manager" && hasPediaLine(scope.allowedLineNames)) {
      // Seat map couldn't answer — keep the legacy explicit set rather than under-scoping him.
      allowedRegionCodes = new Set(["AB", "D1", "D2"]);
    }
    return {
      tier: "territory",
      allowedLineNames: scope.allowedLineNames,
      allowedRegionCodes,
      allowedAreaCodes: scope.allowedAreaCodes,
    };
  }

  // 6. Company-wide commercial oversight without a curated list keeps full access minus the
  // confidential Lacto Basic. An explicit product-scope assignment in step 3 still narrows it.
  if (ctx.role === "SFE Manager") {
    return { tier: "full", canViewRestricted: false };
  }

  return { tier: "none" };
}

/** True when the viewer's allowed lines include Pedia (any case/whitespace variant). */
function hasPediaLine(lineNames: Set<string> | null): boolean {
  if (!lineNames) return false;
  for (const name of lineNames) {
    if (normalizeLineKey(name) === "pedia") return true;
  }
  return false;
}

/** Map canonical employee region NAMES onto Source-of-Sales region CODES via the master. */
async function resolveRegionCodesForNames(
  allowedRegionNames: Set<string> | null,
): Promise<Set<string> | null> {
  if (!allowedRegionNames) return null;
  const references = await loadSalesReferenceData({ includeCustomerBricks: false });
  const codesByName = new Map<string, Set<string>>();
  for (const pair of references.regions ?? []) {
    const key = canonicalizeRegionName(pair.regionName);
    if (!key || !pair.regionCode) continue;
    const bucket = codesByName.get(key) ?? new Set<string>();
    bucket.add(pair.regionCode.trim().toUpperCase());
    codesByName.set(key, bucket);
  }
  const codes = new Set<string>();
  for (const name of allowedRegionNames) {
    for (const code of codesByName.get(name) ?? []) codes.add(code);
  }
  // An empty result means the viewer's region didn't resolve to any code → fail closed.
  return codes;
}

/**
 * Territory-tier geography filter. Weekly facts are at DISTRIBUTOR BRANCH grain, and only the branches
 * the owner explicitly mapped carry an area — so the two bounds apply to disjoint halves of the data:
 *
 *   row HAS an area    → keep iff it is one of the viewer's own seat areas
 *   row has NO area    → keep iff its region is in the viewer's own region bound (unchanged behaviour)
 *
 * That split is the whole point. A District Manager whose district reaches into another region (CNS
 * "Kafr El-Sheikh 1" sits in Delta (1) but belongs to the Alex-BHR DM) gains exactly the mapped rows
 * for that area and nothing else from that region — his region bound is never widened. With no area
 * bound, or before any branch is area-mapped, this is byte-identical to the previous
 * applyLineRegionScope call. Pure.
 */
export function applyWeeklyTerritoryScope<
  T extends { officialLine?: string | null; regionCode?: string | null; areaCode?: string | null },
>(
  rows: T[],
  scope: { allowedLineNames: Set<string> | null; allowedRegionCodes: Set<string> | null; allowedAreaCodes: Set<string> | null },
): T[] {
  const { allowedLineNames, allowedRegionCodes, allowedAreaCodes } = scope;
  // Line scope is orthogonal to geography — reuse the shared helper for it, with no geography bound.
  const lineScoped = applyLineRegionScope(rows, { allowedLineNames, allowedRegionCodes: null });
  if (!allowedRegionCodes && !allowedAreaCodes) return lineScoped;

  const areaSet = allowedAreaCodes ? new Set([...allowedAreaCodes].map((code) => code.trim().toUpperCase())) : null;
  const regionSet = allowedRegionCodes ? new Set([...allowedRegionCodes].map((code) => code.trim().toUpperCase())) : null;

  return lineScoped.filter((row) => {
    const area = (row.areaCode ?? "").trim().toUpperCase();
    if (area) {
      // An area-mapped row is judged ONLY by the area bound. Falling back to the region bound here
      // would re-admit a sibling manager's mapped areas inside the viewer's own region.
      return areaSet ? areaSet.has(area) : regionSet ? regionSet.has((row.regionCode ?? "").trim().toUpperCase()) : true;
    }
    if (!regionSet) return true;
    return regionSet.has((row.regionCode ?? "").trim().toUpperCase());
  });
}

/**
 * Pure tiered filter applied to weekly fact rows. Restricted products (Lacto Basic) are
 * stripped for every tier except a full-access viewer allowed to reveal them.
 */
export function applyWeeklyAccessScope<
  T extends { productCode: string; officialLine?: string | null; regionCode?: string | null; areaCode?: string | null },
>(rows: T[], scope: WeeklyAccessScope): T[] {
  const scoped = ((): T[] => {
    switch (scope.tier) {
      case "none":
        return [];
      case "full":
        return scope.canViewRestricted ? rows : rows.filter((row) => !isRestrictedProductCode(row.productCode));
      case "product": {
        const allowed = new Set([...scope.productCodes].map((code) => code.trim().toUpperCase()));
        if (allowed.size === 0) return [];
        return rows.filter(
          (row) => allowed.has(row.productCode.trim().toUpperCase()) && !isRestrictedProductCode(row.productCode),
        );
      }
      case "territory":
        return applyWeeklyTerritoryScope(
          rows.filter((row) => !isRestrictedProductCode(row.productCode)),
          scope,
        );
    }
  })();
  // Confidential Head Office line — stripped for everyone except CEO / Super Admin.
  return scope.canViewHeadOffice ? scoped : scoped.filter((row) => !isHeadOfficeLine(row.officialLine));
}
