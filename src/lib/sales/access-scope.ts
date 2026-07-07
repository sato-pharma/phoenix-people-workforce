import {
  getSalesScope,
  resolveEmployeeIdentityId,
  type AccessContext,
  type BusinessScope,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { getUserLineScopeOverride, getUserProductScopeOverride } from "@/lib/auth/scope-visibility";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
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

/** Confidential products excluded by default everywhere. Single source of truth. */
export const RESTRICTED_PRODUCT_CODES = ["LA003", "LA004", "SS001"] as const;

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

/** Case/whitespace-insensitive keys that identify the confidential Head Office line. */
const HEAD_OFFICE_LINE_KEYS = new Set(["head office", "headoffice", "office", "hq"]);

/** True when a line name (employee line or SoS official line) is the confidential Head Office line. */
export function isHeadOfficeLine(line: string | null | undefined): boolean {
  return HEAD_OFFICE_LINE_KEYS.has(normalizeLineKey(line));
}

/**
 * Head-office department heads whose OWN line is not a product line (e.g. Marketing Manager, who
 * sits on the Head Office line). Their sales/ROI scope is the FIXED set of product lines their
 * department oversees — not their own line, and not merely the lines of whoever currently reports
 * to them (a marketing line with no PM assigned yet, e.g. CNS, must still be covered).
 */
const MARKETING_OVERSIGHT_LINE_ROLES = new Set<PhoenixRole>(["Marketing Manager"]);

/** The Marketing department's product lines, as Source-of-Sales official line names (see the
 *  `lines` table: Anti infective / Pedia / CNS). Head Office is excluded — it carries no product
 *  sales. Update this set if the Marketing department's line portfolio changes. */
const MARKETING_OVERSIGHT_OFFICIAL_LINES = ["Anti infective", "Pedia", "CNS"] as const;

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

// Employee `lines.name` values ("Anti infective", "Pedia", "CNS", "Head Office") → Source of Sales
// `official_line` values ("Anti infective", "CNS", "Head Office", "Pedia") — all four now match
// verbatim. The map is keyed by a case/whitespace-insensitive key and still carries the legacy
// "anti inf"/"office" abbreviations (kept so pre-rename data and the import codes anti_inf/office
// keep resolving), so any variant resolves to the exact SoS official line string (which is what the
// line-scope filter passes into SQL).
const OFFICIAL_LINE_BY_KEY: Record<string, string> = {
  "anti inf": "Anti infective",
  "anti infective": "Anti infective",
  cns: "CNS",
  office: "Head Office",
  "head office": "Head Office",
  pedia: "Pedia",
};

/** Map an employee line name onto the canonical Source-of-Sales official line. Unknown lines
 *  pass through trimmed (a future line still scopes correctly — the SQL filter lowercases). */
export function bridgeEmployeeLineToOfficial(lineName: string | null | undefined): string | null {
  if (!lineName) return null;
  const trimmed = lineName.trim();
  if (!trimmed) return null;
  return OFFICIAL_LINE_BY_KEY[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * The full set of canonical Source-of-Sales official line values, derived from
 * `OFFICIAL_LINE_BY_KEY` so it can never drift from the bridge map above. This is the
 * write-time allow-list for any place a line label is typed in as free text (e.g. the
 * Product Master import) — confidentiality (`isHeadOfficeLine`) is only as strong as this
 * set staying exhaustive, since a product/rollup row with an unrecognized line label would
 * silently bypass the Head Office strip instead of being caught.
 */
export const OFFICIAL_LINE_VALUES: readonly string[] = Array.from(new Set(Object.values(OFFICIAL_LINE_BY_KEY)));

/** Resolve a free-text line label to its canonical official-line casing, or null if it
 *  doesn't match any known official line (case/whitespace-insensitive). Unlike
 *  `bridgeEmployeeLineToOfficial`, this does NOT pass unknown values through — it is the
 *  write-time gate, where an unrecognized label should be rejected, not silently accepted. */
export function resolveOfficialLineValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  return OFFICIAL_LINE_BY_KEY[key] ?? OFFICIAL_LINE_VALUES.find((v) => v.toLowerCase() === key) ?? null;
}

/** Case/whitespace-insensitive key for comparing line names from different sources. */
export function normalizeLineKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

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
  const allowedRegionNames = regionScoped && canonicalRegion ? new Set<string>([canonicalRegion]) : null;

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
    allowedProductCodes,
  };
}

// Mirror of service.ts getPersistedSalesScopeOverride so the two sales-scope systems agree.
async function getPersistedSalesScopeOverride(ctx: AccessContext): Promise<BusinessScope | null> {
  if (!ctx.loginId) return null;
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("app_auth_users")
    .select("sales_scope_override")
    .eq("login_id", ctx.loginId)
    .maybeSingle();
  const raw = String((data as { sales_scope_override?: string | null } | null)?.sales_scope_override ?? "")
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
  let viewerLineName: string | null = null;
  let viewerRegionName: string | null = null;
  if (currentHrId) {
    const directory = await getEmployeeDirectory();
    const viewer = directory.employees.find(
      (employee) => normalizeIdentity(employee.hrId) === normalizeIdentity(currentHrId),
    );
    viewerLineName = viewer?.lineName ?? null;
    viewerRegionName = viewer?.regionName ?? null;
  }

  return computeSalesAccessScope({
    role: ctx.role,
    businessScope,
    viewerLineName,
    viewerRegionName,
    includeRestricted: opts?.includeRestricted ?? false,
    overseenLineNames,
    allowedProductCodes,
  });
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
 * Drop confidential-product rows from a raw master-data record (snake_case `product_code`,
 * e.g. source_of_sales_products via listMasterRows). Used by the Database Mapping master-data
 * routes, which read the raw DB shape directly rather than the camelCase Source-of-Sales shape
 * `stripRestrictedRows` expects. Returns rows unchanged for CEO / Super Admin.
 */
export function stripRestrictedMasterProductRows<T extends Record<string, string | number | boolean | null>>(
  rows: T[],
  role: PhoenixRole,
): T[] {
  if (canViewRestrictedProducts(role)) return rows;
  return rows.filter((row) => !isRestrictedProductCode(String(row.product_code ?? "")));
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
  T extends { officialLine?: string | null; regionCode?: string | null },
>(
  rows: T[],
  scope: { allowedLineNames: Set<string> | null; allowedRegionCodes: Set<string> | null },
): T[] {
  const { allowedLineNames, allowedRegionCodes } = scope;
  if (!allowedLineNames && !allowedRegionCodes) return rows;
  const lineKeys = allowedLineNames ? new Set([...allowedLineNames].map(normalizeLineKey)) : null;
  return rows.filter((row) => {
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
