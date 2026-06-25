import {
  normalizeHrId,
  resolveEmployeeIdentityId,
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { bridgeEmployeeLineToOfficial, canonicalizeRegionName, isRestrictedProductCode } from "@/lib/sales/access-scope";
import { getManagerRegionScope, resolveRegionCodesForNames } from "@/lib/sales/weekly/access";
import {
  loadMonthlyClosing,
  type MonthlyClosingCell,
  type MonthlyClosingGrandTotalRow,
  type MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";
import { listPublishedPeriodsForLine } from "@/lib/sales/monthly-closing-publication";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Employee-portal Monthly Closing.
//
// A read-only, published-gated view of the monthly closing matrix for sales
// managers and product managers. The viewer NEVER picks a line — it is resolved
// from their HR_ID. Two scoping tiers:
//
//  • region     — District / Regional Manager / Medical Rep: bounded to their own region(s).
//  • line-only  — National Sales Manager, Product Manager, Group Product Manager: their
//                 whole line, every product, no further narrowing.
//
// Visibility is gated by `monthly_closing_publications`: a month appears here
// only after the admin publishes that (line, period). Restricted products
// (Lacto Basic) are always stripped for everyone in the portal.
// ─────────────────────────────────────────────────────────────────────────────

/** Owner-set expected distributor count for the Monthly Sales Closing completion bar (fixed). */
const MONTHLY_CLOSING_EXPECTED_DISTRIBUTORS = 17;

/** Distinct distributors with a VALIDATED upload for a period — the closing-completion numerator.
 *  A distributor's upload covers all its lines, so this is period-wide (not line-scoped). */
async function countUploadedDistributorsForPeriod(period: string | null): Promise<number> {
  if (!period) return 0;
  const supabase = getSupabaseAdmin();
  const result = await supabase
    .from("source_of_sales_import_batches")
    .select("distributor_code")
    .eq("status", "validated")
    .eq("period", period);
  if (result.error) return 0;
  const codes = new Set(
    (result.data ?? [])
      .map((row) => String((row as { distributor_code?: unknown }).distributor_code ?? "").trim().toUpperCase())
      .filter(Boolean),
  );
  return codes.size;
}

/** Roles that can open the portal Monthly Closing tab. */
export const PORTAL_CLOSING_ROLES: ReadonlySet<PhoenixRole> = new Set([
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "SFE Manager",
  "CEO",
  "Super Admin",
  "Medical Rep",
]);

// Region-scoped roles: bounded to their own region(s). National Sales Manager, Product Manager,
// and Group Product Manager are intentionally NOT here — they always see the whole line.
const REGION_SCOPED_CLOSING_ROLES: ReadonlySet<PhoenixRole> = new Set([
  "District Manager",
  "Regional Manager",
  "Medical Rep",
]);

export function canAccessPortalClosing(access: AccessContext): boolean {
  return PORTAL_CLOSING_ROLES.has(access.role);
}

export type PortalClosingScope = {
  /** Display line resolved from the viewer's employee record (locked, never chosen). */
  line: string | null;
  /** Allowed SoS region codes for region-scoped roles (DM / RSM / MR); null means "all regions in
   *  the line" (NSM, PM, GPM, or a manager whose region could not be resolved). */
  allowedRegionCodes: Set<string> | null;
};

/** Resolve the viewer's line + region from the employee directory (any role). */
async function resolveEmployeeGeo(access: AccessContext): Promise<{ line: string | null; region: string | null }> {
  const hrId = resolveEmployeeIdentityId(access) ?? access.hrId ?? access.loginId;
  if (!hrId) return { line: null, region: null };
  const target = normalizeHrId(hrId);

  const directory = await getEmployeeDirectory();
  const match = directory.employees.find(
    (employee) => normalizeHrId(employee.hrId) === target,
  );
  return { line: match?.lineName?.trim() || null, region: match?.regionName?.trim() || null };
}

/** Line + region scope for the caller. */
export async function resolvePortalClosingScope(
  access: AccessContext,
): Promise<PortalClosingScope> {
  const { line, region } = await resolveEmployeeGeo(access);

  // DM / RSM / MR: bounded to their region(s). The explicit territory map is authoritative
  // (e.g. RSM PD-0001 -> AB+D1+D2, each DM -> his region); else fall back to auto region-name
  // resolution from the viewer's own region.
  if (REGION_SCOPED_CLOSING_ROLES.has(access.role)) {
    const hrKey = canonicalHrIdKey(
      resolveEmployeeIdentityId(access) ?? access.hrId ?? access.loginId ?? null,
    );
    const explicit = await getManagerRegionScope(hrKey);
    const resolved =
      explicit ?? (await resolveRegionCodesForNames(region ? new Set([canonicalizeRegionName(region)]) : null));
    // Region-scoped roles MUST be bounded: if neither the explicit map nor the region name resolved
    // (null), fail closed (empty set => no regions) rather than fall open to the whole line.
    return { line, allowedRegionCodes: resolved ?? new Set() };
  }

  // National Sales Manager, Product Manager, Group Product Manager (and any other allowed role)
  // — the whole line, every product.
  return { line, allowedRegionCodes: null };
}

function sumCells(cells: MonthlyClosingCell[]): MonthlyClosingCell {
  let salesUnits = 0;
  let salesValue = 0;
  let targetUnits = 0;
  let targetValue = 0;
  let hasTarget = false;
  for (const cell of cells) {
    salesUnits += cell.salesUnits;
    salesValue += cell.salesValue;
    if (cell.targetUnits != null) {
      targetUnits += cell.targetUnits;
      hasTarget = true;
    }
    if (cell.targetValue != null) {
      targetValue += cell.targetValue;
      hasTarget = true;
    }
  }
  const resolvedTargetValue = hasTarget ? targetValue : null;
  return {
    salesUnits,
    salesValue,
    targetUnits: hasTarget ? targetUnits : null,
    targetValue: resolvedTargetValue,
    achievement: resolvedTargetValue ? salesValue / resolvedTargetValue : null,
  };
}

/**
 * Drop the confidential product columns (LA003 / LA004) from a closing matrix, recomputing every
 * row total / subtotal / grand total from the surviving columns. Always applied in the portal:
 * no portal role (DM / RM / NSM / PM / GPM) may ever see these products. Pure — no IO.
 */
export function stripRestrictedColumns(matrix: MonthlyClosingMatrix): MonthlyClosingMatrix {
  const keep: number[] = [];
  matrix.columns.forEach((column, index) => {
    if (!isRestrictedProductCode(column.productCode)) keep.push(index);
  });
  if (keep.length === matrix.columns.length) return matrix;

  const pick = (cells: MonthlyClosingCell[]) =>
    keep.map((index) => cells[index]).filter((cell): cell is MonthlyClosingCell => Boolean(cell));
  const scopeSubtotal = <T extends { cells: MonthlyClosingCell[]; rowTotal: MonthlyClosingCell }>(
    row: T,
  ): T => {
    const cells = pick(row.cells);
    return { ...row, cells, rowTotal: sumCells(cells) };
  };

  return {
    ...matrix,
    columns: keep.map((index) => matrix.columns[index]),
    regions: matrix.regions.map((region) => ({
      ...region,
      areas: region.areas.map(scopeSubtotal),
      subtotal: scopeSubtotal(region.subtotal),
    })),
    grandTotal: scopeSubtotal(matrix.grandTotal),
    directNational: matrix.directNational ? scopeSubtotal(matrix.directNational) : matrix.directNational,
    companyTotal: matrix.companyTotal ? scopeSubtotal(matrix.companyTotal) : matrix.companyTotal,
  };
}

/**
 * Filter a closing matrix down to a set of SoS region codes, recomputing the grand total from the
 * surviving regions. National-direct and company totals are dropped — a region-scoped manager sees
 * only their own region(s), never the whole-company figure. Pure — no IO.
 */
export function scopeMatrixToRegions(
  matrix: MonthlyClosingMatrix,
  codes: Set<string>,
): MonthlyClosingMatrix {
  const allowed = new Set([...codes].map((code) => code.trim().toUpperCase()));
  const regions = matrix.regions.filter((region) => allowed.has((region.regionCode ?? "").trim().toUpperCase()));
  const columnCount = matrix.columns.length;
  // Grand total = column-wise sum across the surviving regions' subtotals.
  const grandCells = Array.from({ length: columnCount }, (_, index) =>
    sumCells(
      regions
        .map((region) => region.subtotal.cells[index])
        .filter((cell): cell is MonthlyClosingCell => Boolean(cell)),
    ),
  );
  const grandTotal: MonthlyClosingGrandTotalRow = {
    kind: "grandTotal",
    cells: grandCells,
    rowTotal: sumCells(grandCells),
  };
  return {
    ...matrix,
    regions,
    grandTotal,
    directNational: null,
    companyTotal: null,
  };
}

export type PortalClosingResult = {
  matrix: MonthlyClosingMatrix | null;
  line: string | null;
  /** Published periods available to this viewer's line (newest first). */
  availablePeriods: string[];
  selectedPeriod: string | null;
  /** True when the viewer has a line but nothing has been published for it yet. */
  awaitingPublish: boolean;
  /** Live monthly only: distinct distributors uploaded this period + the fixed expected total (completion bar). */
  distributorsUploaded?: number;
  distributorsExpected?: number;
};

/**
 * Load the published, viewer-scoped closing for one month. Only published
 * periods are ever offered or loaded; an unpublished/blank request falls back to
 * the latest published month for the line.
 */
export async function loadPortalMonthlyClosing(input: {
  access: AccessContext;
  period?: string | null;
}): Promise<PortalClosingResult> {
  const scope = await resolvePortalClosingScope(input.access);
  if (!scope.line) {
    return { matrix: null, line: null, availablePeriods: [], selectedPeriod: null, awaitingPublish: false };
  }

  const publishedPeriods = await listPublishedPeriodsForLine(scope.line);
  if (publishedPeriods.length === 0) {
    return {
      matrix: null,
      line: scope.line,
      availablePeriods: [],
      selectedPeriod: null,
      awaitingPublish: true,
    };
  }

  const requested = String(input.period ?? "").trim();
  const selectedPeriod = publishedPeriods.includes(requested) ? requested : publishedPeriods[0];

  const raw = await loadMonthlyClosing({ line: scope.line, period: selectedPeriod });
  // Lock the line and restrict the month selector to published months only.
  const locked: MonthlyClosingMatrix = {
    ...raw,
    availableLines: [scope.line],
    availablePeriods: publishedPeriods,
  };
  // Always strip confidential products first, then apply region scope (DM/RSM/MR) if any.
  const safe = stripRestrictedColumns(locked);
  const matrix = scope.allowedRegionCodes ? scopeMatrixToRegions(safe, scope.allowedRegionCodes) : safe;

  return {
    matrix,
    line: scope.line,
    availablePeriods: publishedPeriods,
    selectedPeriod,
    awaitingPublish: false,
  };
}

/**
 * Live (NOT publish-gated) monthly closing for the portal Sales Intelligence section.
 * Mirrors loadPortalMonthlyClosing but offers every VALIDATED month for the viewer's line
 * straight from the working closing matrix — there is no publication gate, so PM/GPM always
 * see current numbers. Line is resolved from the viewer (never chosen), and confidential
 * products are always stripped.
 */
export async function loadPortalLiveMonthly(input: {
  access: AccessContext;
  period?: string | null;
}): Promise<PortalClosingResult> {
  const scope = await resolvePortalClosingScope(input.access);
  if (!scope.line) {
    return { matrix: null, line: null, availablePeriods: [], selectedPeriod: null, awaitingPublish: false };
  }

  // The employee line ("Anti Inf", "Office") is bridged to the Source-of-Sales official line
  // ("Anti infective", "Head Office") so it matches the closing matrix's line dimension.
  const officialLine = bridgeEmployeeLineToOfficial(scope.line) ?? scope.line;
  const requested = String(input.period ?? "").trim();
  const raw = await loadMonthlyClosing({ line: officialLine, period: requested || null });

  // Guard against cross-line leakage: loadMonthlyClosing falls back to the first available line
  // when the requested line has no validated data. Never show another line's numbers.
  const sameLine = !!raw.line && raw.line.trim().toLowerCase() === officialLine.trim().toLowerCase();
  if (!sameLine) {
    return { matrix: null, line: scope.line, availablePeriods: [], selectedPeriod: null, awaitingPublish: false };
  }

  const locked: MonthlyClosingMatrix = { ...raw, availableLines: [scope.line] };
  const safe = stripRestrictedColumns(locked);
  const matrix = scope.allowedRegionCodes ? scopeMatrixToRegions(safe, scope.allowedRegionCodes) : safe;

  return {
    matrix,
    line: scope.line,
    availablePeriods: raw.availablePeriods,
    selectedPeriod: raw.period,
    awaitingPublish: false,
    distributorsUploaded: await countUploadedDistributorsForPeriod(raw.period),
    distributorsExpected: MONTHLY_CLOSING_EXPECTED_DISTRIBUTORS,
  };
}

export type PortalClosingTrendPoint = {
  period: string;
  salesValue: number;
  salesUnits: number;
};

/**
 * Month-over-month series for the viewer's line/products across the most recent
 * published months (oldest → newest for charting). Caps at `maxMonths`.
 */
export async function loadPortalClosingTrend(input: {
  access: AccessContext;
  maxMonths?: number;
}): Promise<PortalClosingTrendPoint[]> {
  const scope = await resolvePortalClosingScope(input.access);
  if (!scope.line) return [];

  const publishedPeriods = await listPublishedPeriodsForLine(scope.line);
  if (publishedPeriods.length === 0) return [];

  const periods = publishedPeriods.slice(0, Math.max(1, input.maxMonths ?? 6));

  const points = await Promise.all(
    periods.map(async (period) => {
      const raw = await loadMonthlyClosing({ line: scope.line as string, period });
      const safe = stripRestrictedColumns(raw);
      const matrix = scope.allowedRegionCodes ? scopeMatrixToRegions(safe, scope.allowedRegionCodes) : safe;
      const salesUnits = matrix.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0);
      return { period, salesValue: matrix.grandTotal.rowTotal.salesValue, salesUnits };
    }),
  );

  return points.sort((left, right) => left.period.localeCompare(right.period));
}
