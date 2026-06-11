import {
  getSalesScope,
  resolveEmployeeIdentityId,
  type AccessContext,
  type BusinessScope,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Sales Intelligence — centralized, server-side access scope.
//
// THE confidential-product rule lives here and in the SI RPCs (phx_si_*): products
// LA003 + LA004 ("Lacto Basic 1 & 2") are excluded from EVERY total, KPI, chart, table,
// filter and export for everyone, and can only be revealed by a CEO or Super Admin who
// explicitly opts in. The toggle is the ONLY path to an empty exclusion list, and the
// resolver ignores the opt-in for every other role — so URL/API/filter/export tampering
// cannot reveal them.
//
// The dashboards are geography-and-line centric (shown by name), never per-medical-rep:
// the sales files carry line/region/area/brick/product/customer but not rep ownership.
// So role scope limits WHICH lines/regions a user sees, resolved from their employee row.
// ─────────────────────────────────────────────────────────────────────────────

/** Confidential products excluded by default everywhere. Single source of truth. */
export const RESTRICTED_PRODUCT_CODES = ["LA003", "LA004"] as const;

const RESTRICTED_SET = new Set(RESTRICTED_PRODUCT_CODES.map((code) => code.toUpperCase()));

/** Only these roles may ever reveal the restricted products (per the locked decision). */
export function canViewRestrictedProducts(role: PhoenixRole): boolean {
  return role === "CEO" || role === "Super Admin";
}

export function isRestrictedProductCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return RESTRICTED_SET.has(code.trim().toUpperCase());
}

// Employee `lines.name` values ("Anti Inf", "Pedia", "CNS", "Office") → Source of Sales
// `official_line` values ("Anti infective", "CNS", "Head Office", "Pedia"). Pedia/CNS match
// verbatim; "Anti Inf"/"Office" diverge. The map is keyed by a case/whitespace-insensitive key
// and covers BOTH the employee names and the SoS names, so any case variant resolves to the
// exact SoS official line string (which is what the line-scope filter passes into SQL).
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
};

type ComputeScopeInput = {
  role: PhoenixRole;
  businessScope: BusinessScope;
  viewerLineName: string | null;
  viewerRegionName: string | null;
  includeRestricted: boolean;
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
    };
  }

  // Every non-company sales role is bounded to its own line. A missing line fails closed
  // (empty set → no rows) rather than leaking the whole company.
  const officialLine = bridgeEmployeeLineToOfficial(viewerLineName);
  const allowedLineNames = new Set<string>(officialLine ? [officialLine] : []);

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
  const businessScope: BusinessScope = ctx.scope === "system"
    ? "COMPANY"
    : getSalesScope({ role: ctx.role, salesScopeOverride: await getPersistedSalesScopeOverride(ctx) });

  // Company-wide roles never need the viewer's territory; skip the directory read entirely.
  if (businessScope === "COMPANY" || businessScope === "NONE") {
    return computeSalesAccessScope({
      role: ctx.role,
      businessScope,
      viewerLineName: null,
      viewerRegionName: null,
      includeRestricted: opts?.includeRestricted ?? false,
    });
  }

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
