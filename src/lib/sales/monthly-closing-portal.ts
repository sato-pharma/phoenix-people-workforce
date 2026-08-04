import {
  normalizeHrId,
  resolveEmployeeIdentityId,
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  canonicalizeRegionName,
  isRestrictedProductCode,
  resolveSalesAccessScope,
} from "@/lib/sales/access-scope";
import { getWeeklyProductScopeCodes } from "@/lib/sales/weekly/access";
import {
  loadMonthlyClosing,
  type MonthlyClosingCell,
  type MonthlyClosingGrandTotalRow,
  type MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";
import { listPublishedPeriodsForLine } from "@/lib/sales/monthly-closing-publication";

// ─────────────────────────────────────────────────────────────────────────────
// Employee-portal Monthly Closing.
//
// A read-only, published-gated view of the monthly closing matrix for sales
// managers and product managers. The viewer NEVER picks a line — it is resolved
// from their HR_ID. Two scoping tiers:
//
//  • territory  — District / Regional Manager: their line, narrowed to their own
//                 region (they only see their scope). National Sales Manager is
//                 line-scoped and sees the whole line.
//  • product    — Product / Group Product Manager: their line, filtered down to
//                 ONLY the products they own (weekly product-scope sheet).
//
// Region narrowing for DM/RM comes from the shared sales access-scope engine
// (resolveSalesAccessScope) so there is one source of truth for "who sees which
// region", matching the analytics dashboards.
//
// Visibility is gated by `monthly_closing_publications`: a month appears here
// only after the admin publishes that (line, period). Restricted products
// (Lacto Basic) are always stripped — a product manager only ever sees them if
// they were explicitly assigned, which the seed never does.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Roles that can open the portal Monthly Closing tab. Medical Rep and Marketing
 * Manager are excluded — Medical Rep has no line, Marketing Manager sits on
 * "Head Office" (not a product line) so the portal can never resolve meaningful
 * published data for them.
 */
export const PORTAL_CLOSING_ROLES: ReadonlySet<PhoenixRole> = new Set([
  "District Manager",
  // "Manager" is the legacy alias for District Manager (see scopeForRole in permissions.ts and
  // PORTAL_CORE_ANALYTICS_ROLES in analytics/portal-access.ts). A DM whose session role resolves to
  // the alias must reach the same scoped closing, so it is listed alongside "District Manager".
  "Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
]);

const PRODUCT_SCOPED_CLOSING_ROLES: ReadonlySet<PhoenixRole> = new Set([
  "Product Manager",
  "Group Product Manager",
]);

export function canAccessPortalClosing(access: AccessContext): boolean {
  return PORTAL_CLOSING_ROLES.has(access.role);
}

export type PortalClosingScope = {
  /** Display line resolved from the viewer's employee record (locked, never chosen). */
  line: string | null;
  /** Allowed product codes for product-scoped roles; null means "the whole line". */
  productCodes: Set<string> | null;
  /**
   * Canonical region names the viewer may see (from resolveSalesAccessScope). A set narrows the
   * matrix to those regions (District/Regional Manager); null means every region (National Sales
   * Manager, company roles, or a viewer whose own region could not be resolved — fail-open to the
   * whole line, never a blank sheet).
   */
  regionNames: Set<string> | null;
  /**
   * Area codes from the viewer's organogram seat (see src/lib/sales/seat-area-scope.ts). Non-null for
   * a District / Regional Manager whose seat resolved, and then the AUTHORITATIVE bound — it takes
   * precedence over `regionNames` because an area's operational owner can differ from its geography.
   * null for every other role and whenever the seat map couldn't answer (region bound then stands).
   */
  areaCodes: Set<string> | null;
};

/** Resolve the viewer's line from the employee directory (any role). */
async function resolveEmployeeLineName(access: AccessContext): Promise<string | null> {
  const hrId = resolveEmployeeIdentityId(access) ?? access.hrId ?? access.loginId;
  if (!hrId) return null;
  const target = normalizeHrId(hrId);

  const directory = await getEmployeeDirectory();
  const match = directory.employees.find(
    (employee) => normalizeHrId(employee.hrId) === target,
  );
  return match?.lineName?.trim() || null;
}

/** Line + optional product filter for the caller. */
export async function resolvePortalClosingScope(
  access: AccessContext,
): Promise<PortalClosingScope> {
  // "Everyone sees his scope only": the shared sales access-scope engine is the single source of
  // truth for which regions a viewer may see. District/Regional Managers come back region-bound
  // (a set = their region); National Sales Managers are line-scoped and company roles unrestricted
  // (null = the whole line). A region-scoped viewer with NO geography at all — no region label and
  // no seat areas — comes back as an EMPTY set, which applyRegionScope honours as "no rows" rather
  // than widening to the line (an empty set is truthy, so it must be checked explicitly).
  const [line, salesScope] = await Promise.all([
    resolveEmployeeLineName(access),
    resolveSalesAccessScope(access),
  ]);
  const regionNames = salesScope.allowedRegionNames;
  // A District / Regional Manager's real geography is their seat's areas, which can sit outside their
  // own region label — so prefer it when the seat map answered.
  const areaCodes = salesScope.allowedAreaCodes;

  if (PRODUCT_SCOPED_CLOSING_ROLES.has(access.role)) {
    const hrKey = canonicalHrIdKey(
      resolveEmployeeIdentityId(access) ?? access.hrId ?? access.loginId ?? null,
    );
    const productCodes = await getWeeklyProductScopeCodes(hrKey);
    // No explicit assignment → fall back to showing their full line (null = whole line, no column filter).
    return { line, productCodes: productCodes.size > 0 ? productCodes : null, regionNames, areaCodes };
  }

  // Territory roles: DM/RM are narrowed to their own areas (seat map) or, failing that, their own
  // region; NSM is line-scoped so both bounds are null ⇒ the whole line.
  return { line, productCodes: null, regionNames, areaCodes };
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
 * Filter a closing matrix down to a set of product codes, recomputing every
 * row total / subtotal / grand total from the surviving columns. Restricted
 * products are always dropped. Pure — no IO.
 */
export function scopeMatrixToProducts(
  matrix: MonthlyClosingMatrix,
  codes: Set<string>,
): MonthlyClosingMatrix {
  const allowed = new Set([...codes].map((code) => code.trim().toUpperCase()));
  const keep: number[] = [];
  matrix.columns.forEach((column, index) => {
    const code = column.productCode.trim().toUpperCase();
    if (allowed.has(code) && !isRestrictedProductCode(column.productCode)) {
      keep.push(index);
    }
  });

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
 * Drop the confidential product columns (LA003 / LA004) from a closing matrix, recomputing every
 * row total / subtotal / grand total from the surviving columns. Always applied in the portal:
 * no portal role (DM / RM / NSM / PM / GPM) may ever see these products. Territory roles get
 * `productCodes = null` and so skip `scopeMatrixToProducts`, which is why this guard is needed.
 * Pure — no IO.
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
 * Narrow a closing matrix to the SoS regions whose CANONICAL name is in `names`, recomputing the
 * grand total from the surviving regions and dropping the national-direct / company totals a
 * region-scoped viewer must not see. Matches by canonical region NAME because the sales access-scope
 * engine resolves a viewer's regions by name (resolveSalesAccessScope.allowedRegionNames, already
 * canonicalized). Pure — no IO.
 *
 * A block the organogram refined out of a coarser region ("Upper Egypt 1", split from "Upper
 * Egypt") also matches on its BASE name. Employee rows still carry the coarse label — both Anti
 * Infective Upper Egypt managers read "Upper Egypt" — so matching on the refined name alone would
 * hand a region-scoped viewer an empty closing the moment their region was split. Seat-scoped
 * viewers (District / Regional Manager) never reach this path; they are bound by area codes via
 * scopeMatrixToAreaCodes, which is unaffected by how the blocks are grouped.
 */
export function scopeMatrixToRegionNames(
  matrix: MonthlyClosingMatrix,
  names: Set<string>,
): MonthlyClosingMatrix {
  const regions = matrix.regions.filter(
    (region) =>
      names.has(canonicalizeRegionName(region.regionName))
      || (region.baseRegionName != null && names.has(canonicalizeRegionName(region.baseRegionName))),
  );
  const columnCount = matrix.columns.length;
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
  return { ...matrix, regions, grandTotal, directNational: null, companyTotal: null };
}

/**
 * Narrow a closing matrix to an explicit set of AREA codes — the seat-derived bound for a District /
 * Regional Manager (see src/lib/sales/seat-area-scope.ts). Unlike the region-name version above this
 * keeps an area whose region belongs to someone else (e.g. CNS Kafr El-Sheikh 1, owned by the
 * Alex-BHR DM but sitting in Delta (1)) while dropping that region's other areas, and it recomputes
 * every region subtotal from the surviving areas so the totals still tie out. A region left with no
 * areas is dropped entirely. Pure — no IO.
 */
export function scopeMatrixToAreaCodes(
  matrix: MonthlyClosingMatrix,
  areaCodes: Set<string>,
): MonthlyClosingMatrix {
  const allowed = new Set([...areaCodes].map((code) => code.trim().toUpperCase()));
  const columnCount = matrix.columns.length;
  const cellsAt = (rows: Array<{ cells: MonthlyClosingCell[] }>) =>
    Array.from({ length: columnCount }, (_, index) =>
      sumCells(rows.map((row) => row.cells[index]).filter((cell): cell is MonthlyClosingCell => Boolean(cell))),
    );

  const regions = matrix.regions
    .map((region) => {
      // The synthetic per-region "Direct" row carries no real area code; a region-scoped viewer never
      // saw national direct sales (scopeMatrixToRegionNames nulls directNational), so drop it here too.
      const areas = region.areas.filter(
        (area) => !area.isDirect && allowed.has(area.areaCode.trim().toUpperCase()),
      );
      if (areas.length === 0) return null;
      const subtotalCells = cellsAt(areas);
      return {
        ...region,
        areas,
        subtotal: { ...region.subtotal, cells: subtotalCells, rowTotal: sumCells(subtotalCells) },
      };
    })
    .filter((region): region is (typeof matrix.regions)[number] => region !== null);

  const grandCells = cellsAt(regions.map((region) => region.subtotal));
  const grandTotal: MonthlyClosingGrandTotalRow = {
    kind: "grandTotal",
    cells: grandCells,
    rowTotal: sumCells(grandCells),
  };
  return { ...matrix, regions, grandTotal, directNational: null, companyTotal: null };
}

/**
 * Apply the viewer's geography scope to a matrix. A seat-scoped viewer (District / Regional Manager
 * whose organogram seat resolved) is narrowed to their own AREAS; otherwise a region-bound viewer is
 * narrowed to their region. The line filter still applies upstream, so nothing here can ever reach
 * outside the viewer's own line.
 *
 * Two DIFFERENT "the bound matched nothing" cases, which must not be conflated:
 *
 *  • An EMPTY `regionNames` set is the scope engine saying "this viewer has no geography at all"
 *    (see computeSalesAccessScope: no region label AND no seat areas ⇒ deliberate empty set). That
 *    is an authorization answer and is honoured as-is ⇒ no rows.
 *  • A NON-empty set that simply matches no region in THIS matrix is a data gap — e.g. a Regional
 *    Manager whose region label is the aggregate "Alexandria + Delta" rather than a single SoS
 *    region. There we still fall back to the un-narrowed matrix rather than show a blank sheet.
 *
 * Collapsing the two is what previously turned the engine's fail-CLOSED empty set straight back into
 * the whole line: an empty Set is truthy, so it cleared the null guard, narrowed to zero regions,
 * and then hit the fallback below.
 */
export function applyRegionScope(
  matrix: MonthlyClosingMatrix,
  regionNames: Set<string> | null,
  areaCodes?: Set<string> | null,
): MonthlyClosingMatrix {
  if (areaCodes && areaCodes.size > 0) {
    const narrowedToAreas = scopeMatrixToAreaCodes(matrix, areaCodes);
    if (narrowedToAreas.regions.length > 0) return narrowedToAreas;
  }
  if (!regionNames) return matrix;
  const narrowed = scopeMatrixToRegionNames(matrix, regionNames);
  // Explicit "no geography" ⇒ no rows. Never widen this back to the full line.
  if (regionNames.size === 0) return narrowed;
  return narrowed.regions.length > 0 ? narrowed : matrix;
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
  // Always strip confidential products first; territory roles (productCodes === null) would
  // otherwise see the raw matrix including LA003 / LA004.
  const safe = stripRestrictedColumns(locked);
  const productScoped = scope.productCodes ? scopeMatrixToProducts(safe, scope.productCodes) : safe;
  const matrix = applyRegionScope(productScoped, scope.regionNames, scope.areaCodes);

  return {
    matrix,
    line: scope.line,
    availablePeriods: publishedPeriods,
    selectedPeriod,
    awaitingPublish: false,
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
      const productScoped = scope.productCodes ? scopeMatrixToProducts(safe, scope.productCodes) : safe;
      const matrix = applyRegionScope(productScoped, scope.regionNames, scope.areaCodes);
      const salesUnits = matrix.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0);
      return { period, salesValue: matrix.grandTotal.rowTotal.salesValue, salesUnits };
    }),
  );

  return points.sort((left, right) => left.period.localeCompare(right.period));
}

// ── Backward-compat shims ─────────────────────────────────────────────────────
// Legacy callers (monthly-sales/page.tsx, monthly-closing-region-scope.test.ts)
// use the old region-scoped API. Keep these until all callers are migrated.

/**
 * Filter a closing matrix down to a set of SoS region codes, recomputing the grand total from the
 * surviving regions. National-direct and company totals are dropped.
 * @deprecated Use scopeMatrixToProducts for the new product-scoped API.
 */
export function scopeMatrixToRegions(
  matrix: MonthlyClosingMatrix,
  codes: Set<string>,
): MonthlyClosingMatrix {
  const allowed = new Set([...codes].map((code) => code.trim().toUpperCase()));
  const regions = matrix.regions.filter((region) => allowed.has((region.regionCode ?? "").trim().toUpperCase()));
  const columnCount = matrix.columns.length;
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
  return { ...matrix, regions, grandTotal, directNational: null, companyTotal: null };
}

/**
 * Live (non-publication-gated) monthly closing for the portal.
 * Unlike loadPortalMonthlyClosing, this reads directly from the raw SoS data so
 * territory roles (DM/RM/NSM) see their line's data as soon as it is uploaded,
 * without waiting for an admin to publish it. Product-scoped roles (PM/GPM/MM)
 * still require product codes in weekly_sales_product_scope to see columns.
 */
export async function loadPortalLiveMonthly(input: {
  access: AccessContext;
  period?: string | null;
}): Promise<PortalClosingResult> {
  const scope = await resolvePortalClosingScope(input.access);
  if (!scope.line) {
    return { matrix: null, line: null, availablePeriods: [], selectedPeriod: null, awaitingPublish: false };
  }

  const raw = await loadMonthlyClosing({ line: scope.line, period: input.period ?? null });
  const availablePeriods: string[] = raw.availablePeriods ?? [];

  if (availablePeriods.length === 0) {
    return { matrix: null, line: scope.line, availablePeriods: [], selectedPeriod: null, awaitingPublish: false };
  }

  const selectedPeriod =
    input.period && availablePeriods.includes(input.period)
      ? input.period
      : availablePeriods[0];

  const safe = stripRestrictedColumns(raw);
  const productScoped = scope.productCodes ? scopeMatrixToProducts(safe, scope.productCodes) : safe;
  const matrix = applyRegionScope(productScoped, scope.regionNames, scope.areaCodes);

  return {
    matrix,
    line: scope.line,
    availablePeriods,
    selectedPeriod,
    awaitingPublish: false,
  };
}
