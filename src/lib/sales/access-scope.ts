import {
  getSalesScope,
  resolveEmployeeIdentityId,
  type AccessContext,
  type BusinessScope,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import {
  getUserLineScopeOverride,
  getUserProductScopeOverride,
  getUserSalesScopeOverrideRaw,
} from "@/lib/auth/scope-visibility";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  isHeadOfficeLine,
  normalizeLineKey,
  RESTRICTED_PRODUCT_CODES,
} from "@/lib/sales/confidential-products";
import {
  bridgeEmployeeLineToOfficial,
  OFFICIAL_LINE_VALUES,
  resolveOfficialLineValue,
} from "@/lib/sales/official-lines";
import { resolveSeatAreaScope } from "@/lib/sales/seat-area-scope";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Sales Intelligence — centralized, server-side access scope.
//
// THE confidential-product rule lives here and in the SI RPCs (phx_si_*): products
// LA003 + LA004 ("Lacto Basic 1 & 2") and SS001 ("Satoslim") are excluded from EVERY total,
// KPI, chart, table, filter and export for everyone, and can only be revealed by a CEO or
// Super Admin who explicitly opts in. The toggle is the ONLY path to an empty exclusion list,
// and the resolver ignores the opt-in for every other role — so URL/API/filter/export
// tampering cannot reveal them.
//
// The dashboards are geography-and-line centric (shown by name), never per-medical-rep:
// the sales files carry line/region/area/brick/product/customer but not rep ownership.
// So role scope limits WHICH lines/regions a user sees, resolved from their employee row.
// ─────────────────────────────────────────────────────────────────────────────

const RESTRICTED_SET = new Set(RESTRICTED_PRODUCT_CODES.map((code) => code.toUpperCase()));

/** Only these roles may ever reveal the restricted products (per the locked decision). */
export function canViewRestrictedProducts(role: PhoenixRole): boolean {
  return role === "CEO" || role === "Super Admin";
}

/**
 * The Head Office product line is CONFIDENTIAL. The entire line and ALL of its products are
 * visible only to CEO / Super Admin. For every other role the line, its products, and their
 * contribution are stripped from every total, KPI, chart, table, filter and export — the same
 * lock class as the restricted products above, but at the line grain. Fail-closed.
 */
export function canViewHeadOfficeLine(role: PhoenixRole): boolean {
  return role === "CEO" || role === "Super Admin";
}

/**
 * The admin Source-of-Sales BI workbook export is CEO / Super Admin only (same lock class as
 * the restricted products). One predicate shared by the /sales page (Export button visibility)
 * and the export route (hard gate) so the two can never drift.
 */
export function canExportSosDashboard(role: PhoenixRole): boolean {
  return role === "CEO" || role === "Super Admin";
}

/**
 * Head-office department heads whose OWN line is not a product line (e.g. Marketing Manager, who
 * sits on the Head Office line). Their sales/ROI scope is the FIXED set of product lines their
 * department oversees — not their own line, and not merely the lines of whoever currently reports
 * to them (a marketing line with no PM assigned yet, e.g. CNS, must still be covered).
 */
export const MARKETING_OVERSIGHT_LINE_ROLES = new Set<PhoenixRole>(["Marketing Manager"]);

/** The Marketing department's product lines, as Source-of-Sales official line names (see the
 *  `lines` table: Anti Infective / Pedia / CNS). Head Office is excluded — it carries no product
 *  sales. Update this set if the Marketing department's line portfolio changes. Matching against
 *  official_line data is case-insensitive (every consumer maps through `normalizeLineKey` or the
 *  RPC's `lower(btrim())`), so the display casing here is safe to standardize. */
const MARKETING_OVERSIGHT_OFFICIAL_LINES = ["Anti Infective", "Pedia", "CNS"] as const;

export function isRestrictedProductCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return RESTRICTED_SET.has(code.trim().toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidential products — NAME matching for the LEGACY Sales pipeline.
//
// The legacy `sales_records` table keys products by NAME (there is no product_code
// column), so the code-based guards above cannot reach it. These helpers strip the
// restricted products by name instead. The name set is the live master names for the
// restricted codes UNION a hardcoded fallback, so a master-read failure (or a rename)
// can never un-hide the products.
// ─────────────────────────────────────────────────────────────────────────────

/** Confidential product NAME fallbacks, kept in lockstep with RESTRICTED_PRODUCT_CODES. */
export const RESTRICTED_PRODUCT_NAME_FALLBACKS = ["lacto basic 1", "lacto basic 2", "satoslim"] as const;

/** Normalize a product name for confidential matching: trim, collapse inner whitespace,
 *  lowercase. Mirrors how source_of_sales_products.normalized_product_name is built. */
export function normalizeProductNameKey(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

let restrictedNameCache: { names: Set<string>; at: number } | null = null;
const RESTRICTED_NAME_TTL_MS = 5 * 60 * 1000;

/** The set of confidential product NAMES (normalized): live master names for the restricted
 *  codes UNION the hardcoded fallbacks. Cached ~5 min. On ANY error it returns the fallbacks
 *  only — it can never return empty, so a read failure cannot widen visibility. */
export async function restrictedProductNameSet(): Promise<Set<string>> {
  const now = Date.now();
  if (restrictedNameCache && now - restrictedNameCache.at < RESTRICTED_NAME_TTL_MS) {
    return restrictedNameCache.names;
  }
  const names = new Set<string>(RESTRICTED_PRODUCT_NAME_FALLBACKS.map(normalizeProductNameKey));
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("source_of_sales_products")
      .select("product_name")
      .in("product_code", [...RESTRICTED_PRODUCT_CODES]);
    for (const row of data ?? []) {
      const key = normalizeProductNameKey((row as { product_name?: string | null }).product_name);
      if (key) names.add(key);
    }
  } catch {
    // Keep the hardcoded fallbacks — never widen visibility on error.
  }
  restrictedNameCache = { names, at: now };
  return names;
}

/** Test-only: reset the name cache so a test can control what the next read returns. */
export function __resetRestrictedNameCacheForTests(): void {
  restrictedNameCache = null;
}

// Employee `lines.name` values ("Anti Infective", "Pedia", "CNS", "Head Office") → Source of Sales
// `official_line` values ("Anti Infective", "CNS", "Head Office", "Pedia") — all four now match
// verbatim. Moved to ./official-lines.ts (a dependency-free module) so client components that
// only need the official-line constant list never pull this file's server-only Supabase/
// employee-directory chain into a client bundle; re-exported here for existing server callers.
export { bridgeEmployeeLineToOfficial, OFFICIAL_LINE_VALUES, resolveOfficialLineValue };

// The restricted-product list, the Head Office line test and the line key they compare on live in
// ./confidential-products.ts (a dependency-free module) for the same reason official-lines.ts does:
// direct-orders/product-family.ts imports them and is reached from a CLIENT component, which before
// the split pulled this file's server-only employee-directory/node:crypto chain into the browser
// bundle. Re-exported here so every existing server caller is untouched.
export { isHeadOfficeLine, normalizeLineKey, RESTRICTED_PRODUCT_CODES };

/** Case/whitespace-insensitive key for comparing region names from different sources. */
export function canonicalizeRegionName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export type SalesAccessScope = {
  role: PhoenixRole;
  businessScope: BusinessScope;
  /** COMPANY scope — sees every line, region and area. */
  canViewAllSales: boolean;
  /** Role is allowed to reveal restricted products (CEO/Super Admin). Gates the UI toggle. */
  canViewRestrictedProducts: boolean;
  includeRestrictedProductsAllowed: boolean;
  /** Did the caller actually opt in (and were they allowed to)? Drives the "including" banner. */
  restrictedIncluded: boolean;
  /** Product codes to exclude. Empty ONLY when an allowed role opted in. */
  excludedProductCodes: string[];
  /** Allowed Source-of-Sales official line names; null = all lines. Empty set = nothing (fail closed). */
  allowedLineNames: Set<string> | null;
  /** Allowed region names (canonicalized employee region); null = all regions within line scope. */
  allowedRegionNames: Set<string> | null;
  /** Areas are shown by name but never used to over-restrict (taxonomy is unreliable). Always null. */
  allowedAreaNames: null;
  /**
   * Area CODES the viewer's own organogram seat operationally owns (see ./seat-area-scope.ts).
   * Non-null ONLY for a District / Regional Manager whose seat resolved; null for every other role
   * and whenever the seat map can't answer, in which case `allowedRegionNames` remains the bound.
   *
   * When non-null this is the AUTHORITATIVE geography bound and MUST be applied as a row filter —
   * it is the only signal that survives an area whose operational owner differs from its geography
   * (e.g. CNS Kafr El-Sheikh 1 is owned by the Alex-BHR DM but its rows carry region Delta (1)).
   */
  allowedAreaCodes: Set<string> | null;
  /**
   * The geographic region codes the `allowedAreaCodes` rows actually carry. Exists purely to widen
   * prefetch / RPC push-down so those out-of-region rows are fetched at all. NOT an authorization
   * bound — it can include a region whose other areas belong to a sibling manager, so it is only
   * ever safe alongside the `allowedAreaCodes` row filter. null whenever allowedAreaCodes is null.
   */
  allowedAreaFactRegionCodes: Set<string> | null;
  /**
   * Per-user product-code allowlist (from product_scope_override). When set, only rows whose
   * productCode is in this set are visible. null = no product-code restriction (line scope only).
   * Empty set = sees nothing.
   */
  allowedProductCodes: Set<string> | null;
};

type ComputeScopeInput = {
  role: PhoenixRole;
  businessScope: BusinessScope;
  viewerLineName: string | null;
  viewerRegionName: string | null;
  includeRestricted: boolean;
  /** Official product lines a head-office department head oversees (e.g. a Marketing Manager
   *  oversees Anti infective / Pedia / CNS). When non-empty, these REPLACE the viewer's own-line
   *  scope, because a head-office line (e.g. "Head Office") is not a product line. */
  overseenLineNames?: string[];
  /** Per-user product code allowlist (from product_scope_override). null = no restriction. */
  allowedProductCodes?: Set<string> | null;
  /**
   * Seat-derived area scope for a District / Regional Manager (see ./seat-area-scope.ts). null when
   * the role isn't seat-scoped or the seat map couldn't answer — the region-name bound then stands.
   */
  seatAreaScope?: { areaCodes: Set<string>; factRegionCodes: Set<string> } | null;
};

/**
 * Pure scope computation — no DB. Given the caller's role, resolved business scope, and the
 * viewer's own line/region, produce the full visibility scope. Unit-tested directly.
 */
export function computeSalesAccessScope(input: ComputeScopeInput): SalesAccessScope {
  const { role, businessScope, viewerLineName, viewerRegionName, includeRestricted } = input;
  const restrictedAllowed = canViewRestrictedProducts(role);
  const restrictedIncluded = restrictedAllowed && includeRestricted === true;
  // The toggle is the ONLY way to empty the exclusion list, and only for an allowed role.
  const excludedProductCodes = restrictedIncluded ? [] : [...RESTRICTED_PRODUCT_CODES];
  const allowedProductCodes = input.allowedProductCodes ?? null;

  const canViewAllSales = businessScope === "COMPANY";

  if (canViewAllSales) {
    return {
      role,
      businessScope,
      canViewAllSales: true,
      canViewRestrictedProducts: restrictedAllowed,
      includeRestrictedProductsAllowed: restrictedAllowed,
      restrictedIncluded,
      excludedProductCodes,
      allowedLineNames: null,
      allowedRegionNames: null,
      allowedAreaNames: null,
      allowedAreaCodes: null,
      allowedAreaFactRegionCodes: null,
      allowedProductCodes,
    };
  }

  if (businessScope === "NONE") {
    return {
      role,
      businessScope,
      canViewAllSales: false,
      canViewRestrictedProducts: restrictedAllowed,
      includeRestrictedProductsAllowed: restrictedAllowed,
      restrictedIncluded,
      excludedProductCodes,
      allowedLineNames: new Set(),
      allowedRegionNames: new Set(),
      allowedAreaNames: null,
      allowedAreaCodes: new Set(),
      allowedAreaFactRegionCodes: new Set(),
      allowedProductCodes,
    };
  }

  // A head-office department head whose own line is not a product line (e.g. a Marketing Manager on
  // the Head Office line) instead oversees an EXPLICIT set of department product lines — when
  // provided, that set REPLACES the own-line scope, so the head-office line never collapses the
  // scope to empty. Everyone else is bounded to their own line; a missing line fails closed (empty
  // set → no rows) rather than leaking the whole company.
  const overseen = (input.overseenLineNames ?? [])
    .map((line) => bridgeEmployeeLineToOfficial(line))
    .filter((line): line is string => Boolean(line));
  const officialLine = bridgeEmployeeLineToOfficial(viewerLineName);
  const allowedLineNames = overseen.length > 0
    ? new Set<string>(overseen)
    : new Set<string>(officialLine ? [officialLine] : []);

  // HIERARCHY (Regional Manager), TEAM (District Manager) and SELF (Medical Rep) are further
  // narrowed to the viewer's region when we know it — the tightest level the data reliably
  // supports without per-rep ownership. If the region is unknown, region stays null (the line
  // bound still applies). Areas are never used to restrict (taxonomy unreliable).
  const regionScoped = businessScope === "HIERARCHY" || businessScope === "TEAM" || businessScope === "SELF";
  const canonicalRegion = canonicalizeRegionName(viewerRegionName);

  // A District / Regional Manager's real geography is their organogram seat's areas, which can
  // legitimately sit outside their own region label (see ./seat-area-scope.ts). When the seat map
  // answered, carry that area set — consumers must filter rows on it, and may use the paired
  // fact-region set to widen prefetch so the out-of-region rows are fetched at all.
  const seatAreaScope = regionScoped ? input.seatAreaScope ?? null : null;

  // Geography must not FAIL OPEN when we know nothing about the viewer's geography.
  //
  // This used to read `regionScoped && canonicalRegion ? {region} : null`, and null means "no
  // region restriction". So a region-scoped viewer with a blank region label got the whole LINE.
  //
  // Scale, measured on the field this code actually reads — `employees.region_name` (see
  // resolveSalesAccessScope: it passes `viewer?.regionName`, and the directory sets
  // `regionName: row.region_name`). NOT `region_code`, which nothing here consults:
  //   District Sales Manager   17 active — 1 blank region_name (16 blank region_code)
  //   Medical Representative   74 active — 0 blank
  //   Regional Sales Manager    1 active — 0 blank
  // So this is a latent guard, not a live outage: verified 2026-08-01, the single blank-region DM
  // (PD-0006, Pedia) holds seat SEAT-PED-DM-CA which owns 6 areas, so he takes the seat branch
  // below and is unaffected. Nobody in production currently lands in the fail-closed case.
  //
  // The seat bound IS populated and correct, so this keeps the existing behaviour wherever it
  // answers — no manager loses access they legitimately have. It closes only the case where BOTH
  // are absent: no region name AND no seat areas. There, an empty set means "no rows", because
  // showing a manager the entire product line is a worse answer than showing them nothing and
  // having them report it.
  //
  // CAVEAT for whoever trips this later: only District Manager / Manager / Regional Manager get a
  // seat scope at all (SEAT_AREA_SCOPED_ROLES in ./seat-area-scope.ts). Medical Rep and Employee
  // are SELF-scoped — so `regionScoped` — with NO seat fallback. A rep onboarded without a region
  // therefore lands straight in the fail-closed branch and silently sees nothing. That is the
  // correct answer for an unknown geography, but it is the most likely way this surfaces as a
  // support ticket, so check `employees.region_name` first when one reports an empty dashboard.
  const hasSeatGeography = (seatAreaScope?.areaCodes.size ?? 0) > 0;
  const allowedRegionNames = !regionScoped
    ? null
    : canonicalRegion
      ? new Set<string>([canonicalRegion])
      : hasSeatGeography
        ? null // seat areas are the authoritative bound; region stays unrestricted so they are reachable
        : new Set<string>(); // no geography at all ⇒ fail closed
  const allowedAreaCodes = seatAreaScope ? new Set([...seatAreaScope.areaCodes].map((c) => c.trim().toUpperCase())) : null;
  const allowedAreaFactRegionCodes = seatAreaScope
    ? new Set([...seatAreaScope.factRegionCodes].map((c) => c.trim().toUpperCase()))
    : null;

  return {
    role,
    businessScope,
    canViewAllSales: false,
    canViewRestrictedProducts: restrictedAllowed,
    includeRestrictedProductsAllowed: restrictedAllowed,
    restrictedIncluded,
    excludedProductCodes,
    allowedLineNames,
    allowedRegionNames,
    allowedAreaNames: null,
    allowedAreaCodes,
    allowedAreaFactRegionCodes,
    allowedProductCodes,
  };
}

// Mirror of service.ts getPersistedSalesScopeOverride so the two sales-scope systems agree. Shares
// one login-row read with the product and line overrides read beside it.
async function getPersistedSalesScopeOverride(ctx: AccessContext): Promise<BusinessScope | null> {
  if (!ctx.loginId) return null;
  const raw = String((await getUserSalesScopeOverrideRaw(ctx.loginId)) ?? "")
    .trim()
    .toUpperCase();
  return ["SELF", "TEAM", "HIERARCHY", "LINE", "COMPANY", "NONE"].includes(raw)
    ? (raw as BusinessScope)
    : null;
}

/**
 * Resolve the full sales access scope for a request/page context. Reads the persisted scope
 * override and the viewer's own line/region from the employee directory, then defers to the
 * pure computeSalesAccessScope.
 */
export async function resolveSalesAccessScope(
  ctx: AccessContext,
  opts?: { includeRestricted?: boolean },
): Promise<SalesAccessScope> {
  const [businessScope, rawProductOverride, rawLineOverride] = await Promise.all([
    (async (): Promise<BusinessScope> => ctx.scope === "system"
      ? "COMPANY"
      : getSalesScope({ role: ctx.role, salesScopeOverride: await getPersistedSalesScopeOverride(ctx) }))(),
    getUserProductScopeOverride(ctx.loginId ?? ""),
    getUserLineScopeOverride(ctx.loginId ?? ""),
  ]);

  // Build the product-code allowlist from the per-user override.
  // null → no restriction; [] → sees nothing; [...] → only those codes.
  const allowedProductCodes: Set<string> | null =
    rawProductOverride === null
      ? null
      : new Set(rawProductOverride.map((c) => c.trim().toUpperCase()));

  // Company-wide roles never need the viewer's territory; skip the directory read entirely.
  if (businessScope === "COMPANY" || businessScope === "NONE") {
    return computeSalesAccessScope({
      role: ctx.role,
      businessScope,
      viewerLineName: null,
      viewerRegionName: null,
      includeRestricted: opts?.includeRestricted ?? false,
      allowedProductCodes,
    });
  }

  // A per-user line_scope_override (e.g. a Product Manager covering both Pedia and Anti infective)
  // is the explicit set of product lines that user may see in sales — it REPLACES the single line
  // on their employee row, exactly like the head-office oversight set below. With no override,
  // head-office department heads (Marketing Manager) fall back to the fixed department line set
  // (covers e.g. CNS even when no PM is assigned); everyone else is bounded to their own line.
  const overseenLineNames = rawLineOverride && rawLineOverride.length > 0
    ? rawLineOverride
    : MARKETING_OVERSIGHT_LINE_ROLES.has(ctx.role)
      ? [...MARKETING_OVERSIGHT_OFFICIAL_LINES]
      : [];

  const currentHrId = resolveEmployeeIdentityId(ctx);
  // The seat-derived area scope is resolved alongside the directory read (both are cached, and the
  // resolver is a no-op for every role that isn't a District / Regional Manager).
  const [viewer, seatAreaScope] = await Promise.all([
    currentHrId
      ? getEmployeeDirectory().then((directory) =>
          directory.employees.find(
            (employee) => normalizeIdentity(employee.hrId) === normalizeIdentity(currentHrId),
          ) ?? null,
        )
      : Promise.resolve(null),
    resolveSeatAreaScope(ctx),
  ]);

  return computeSalesAccessScope({
    role: ctx.role,
    businessScope,
    viewerLineName: viewer?.lineName ?? null,
    viewerRegionName: viewer?.regionName ?? null,
    includeRestricted: opts?.includeRestricted ?? false,
    overseenLineNames,
    allowedProductCodes,
    seatAreaScope,
  });
}

/**
 * The geography bound a consumer should actually apply, resolved once from a SalesAccessScope.
 *
 * - `areaCodes` non-null ⇒ the authoritative bound; filter rows on it. `regionCodes` is then the
 *   PREFETCH widener (the regions those areas' rows carry) and must never be used on its own.
 * - `areaCodes` null ⇒ legacy behaviour: `regionCodes` (resolved from the viewer's region name by
 *   the caller's own name→code map) is the bound.
 *
 * Pure; the caller supplies the region name→code lookup it already has loaded.
 */
export function resolveSalesGeographyBound(
  scope: Pick<SalesAccessScope, "canViewAllSales" | "allowedRegionNames" | "allowedAreaCodes" | "allowedAreaFactRegionCodes">,
  regionCodesForNames: (names: Set<string>) => Set<string>,
): { areaCodes: Set<string> | null; regionCodes: Set<string> | null } {
  if (scope.canViewAllSales) return { areaCodes: null, regionCodes: null };
  if (scope.allowedAreaCodes) {
    return { areaCodes: scope.allowedAreaCodes, regionCodes: scope.allowedAreaFactRegionCodes ?? null };
  }
  if (!scope.allowedRegionNames) return { areaCodes: null, regionCodes: null };
  return { areaCodes: null, regionCodes: regionCodesForNames(scope.allowedRegionNames) };
}

function normalizeIdentity(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Row guards — applied in TypeScript on every loader path, even though the SI RPCs already
// excluded restricted rows in SQL. Defense in depth: a future RPC edit or new entrypoint
// cannot leak a restricted product, and line/region scope is enforced after aggregation.
// ─────────────────────────────────────────────────────────────────────────────

/** Drop any row whose product code is restricted. Rows without a product code pass through
 *  (brick/customer aggregates have already been SQL-excluded above the product grain). */
export function stripRestrictedRows<T extends { productCode?: string | null }>(
  rows: T[],
  excludedProductCodes: readonly string[],
): T[] {
  if (excludedProductCodes.length === 0) return rows;
  const excluded = new Set(excludedProductCodes.map((code) => code.trim().toUpperCase()));
  return rows.filter((row) => {
    const code = row.productCode;
    if (!code) return true;
    return !excluded.has(code.trim().toUpperCase());
  });
}

/**
 * Drop confidential rows from a raw master-data record (snake_case `product_code`/`line`, e.g.
 * source_of_sales_products via listMasterRows). Used by the Database Mapping master-data routes,
 * which read the raw DB shape directly rather than the camelCase Source-of-Sales shape
 * `stripRestrictedRows`/`stripHeadOfficeRows` expect. Strips BOTH the restricted product codes
 * AND any row on the confidential Head Office line (same lock class — see canViewHeadOfficeLine's
 * docstring: "the entire line and ALL of its products", not just the 3 restricted codes). Returns
 * rows unchanged for CEO / Super Admin.
 */
export function stripRestrictedMasterProductRows<T extends Record<string, string | number | boolean | null>>(
  rows: T[],
  role: PhoenixRole,
): T[] {
  const dropRestrictedCodes = !canViewRestrictedProducts(role);
  const dropHeadOffice = !canViewHeadOfficeLine(role);
  if (!dropRestrictedCodes && !dropHeadOffice) return rows;
  return rows.filter((row) => {
    if (dropRestrictedCodes && isRestrictedProductCode(String(row.product_code ?? ""))) return false;
    if (dropHeadOffice && isHeadOfficeLine(row.line != null ? String(row.line) : null)) return false;
    return true;
  });
}

/** Drop rows whose product NAME is confidential (legacy pipeline). `enabled === false`
 *  (an allowed CEO/Super Admin viewer) returns the rows unchanged. Rows with an empty name
 *  pass through. Pure given the name set — unit-tested directly. */
export function stripRestrictedRowsByName<T>(
  rows: T[],
  restrictedNames: Set<string>,
  getName: (row: T) => string | null | undefined,
  enabled: boolean,
): T[] {
  if (!enabled || restrictedNames.size === 0) return rows;
  return rows.filter((row) => {
    const key = normalizeProductNameKey(getName(row));
    if (!key) return true;
    return !restrictedNames.has(key);
  });
}

/**
 * Drop rows on the confidential Head Office line. `enabled` = "stripping on" (i.e.
 * `!canViewHeadOfficeLine(role)`). When disabled (a CEO/Super Admin viewer) rows pass through.
 * Rows whose line is empty pass through (they carry no line dimension to gate on).
 */
export function stripHeadOfficeRows<T>(
  rows: T[],
  getLine: (row: T) => string | null | undefined,
  enabled: boolean,
): T[] {
  if (!enabled) return rows;
  return rows.filter((row) => !isHeadOfficeLine(getLine(row)));
}

/** Drop confidential names from a plain product-name list (e.g. a filter dropdown). */
export function stripRestrictedProductNames(
  names: string[],
  restrictedNames: Set<string>,
  enabled: boolean,
): string[] {
  if (!enabled || restrictedNames.size === 0) return names;
  return names.filter((name) => !restrictedNames.has(normalizeProductNameKey(name)));
}

/**
 * Apply line + region scope to already-aggregated rows. `allowedLineNames` are SoS official
 * line names; `allowedRegionCodes` are region codes (resolved by the loader from the region
 * master). A null filter means "all". An empty set means "nothing" (fail closed).
 */
export function applyLineRegionScope<
  T extends { officialLine?: string | null; regionCode?: string | null; areaCode?: string | null },
>(
  rows: T[],
  scope: {
    allowedLineNames: Set<string> | null;
    allowedRegionCodes: Set<string> | null;
    /**
     * Seat-derived area bound (SalesAccessScope.allowedAreaCodes). When supplied, rows that carry an
     * `areaCode` are filtered on it — this is what keeps a widened region set (needed to fetch an
     * out-of-region area at all) from also exposing a sibling manager's areas in that region. Rows
     * with no area dimension are unaffected, so callers whose fact grain has no area (e.g. Weekly
     * Sales) get no behaviour change.
     */
    allowedAreaCodes?: Set<string> | null;
  },
): T[] {
  const { allowedLineNames, allowedRegionCodes } = scope;
  const allowedAreaCodes = scope.allowedAreaCodes ?? null;
  if (!allowedLineNames && !allowedRegionCodes && !allowedAreaCodes) return rows;
  const lineKeys = allowedLineNames ? new Set([...allowedLineNames].map(normalizeLineKey)) : null;
  return rows.filter((row) => {
    if (allowedAreaCodes && row.areaCode != null) {
      if (!allowedAreaCodes.has(row.areaCode.trim().toUpperCase())) return false;
    }
    if (lineKeys) {
      if (row.officialLine === undefined) {
        // Row carries no line dimension (e.g. brick/customer aggregates) — line scope cannot be
        // applied here; the region filter below still bounds it.
      } else if (!lineKeys.has(normalizeLineKey(row.officialLine))) {
        return false;
      }
    }
    if (allowedRegionCodes) {
      const code = (row.regionCode ?? "").trim();
      if (!allowedRegionCodes.has(code)) return false;
    }
    return true;
  });
}

/**
 * Apply a per-user product-code allowlist (product_scope_override). When `allowedProductCodes`
 * is null, returns rows unchanged. When it is an empty set, returns nothing. When non-empty,
 * keeps only rows whose productCode is in the set (rows without a productCode pass through —
 * they are line/region aggregates, not product-grain rows).
 */
export function applyProductCodeAllowlist<T extends { productCode?: string | null }>(
  rows: T[],
  allowedProductCodes: Set<string> | null,
): T[] {
  if (!allowedProductCodes) return rows;
  if (allowedProductCodes.size === 0) return [];
  return rows.filter((row) => {
    const code = row.productCode;
    if (!code) return true; // pass aggregated rows through
    return allowedProductCodes.has(code.trim().toUpperCase());
  });
}
