import {
  normalizeHrId,
  resolveEmployeeIdentityId,
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { isRestrictedProductCode } from "@/lib/sales/access-scope";
import { getWeeklyProductScopeCodes } from "@/lib/sales/weekly/access";
import {
  loadMonthlyClosing,
  type MonthlyClosingCell,
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
//  • territory  — District / Regional / National Sales Manager: their whole line.
//  • product    — Product / Group Product Manager: their line, filtered down to
//                 ONLY the products they own (weekly product-scope sheet).
//
// Visibility is gated by `monthly_closing_publications`: a month appears here
// only after the admin publishes that (line, period). Restricted products
// (Lacto Basic) are always stripped — a product manager only ever sees them if
// they were explicitly assigned, which the seed never does.
// ─────────────────────────────────────────────────────────────────────────────

/** Roles that can open the portal Monthly Closing tab. Medical Rep is excluded. */
export const PORTAL_CLOSING_ROLES: ReadonlySet<PhoenixRole> = new Set([
  "District Manager",
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
  const line = await resolveEmployeeLineName(access);

  if (PRODUCT_SCOPED_CLOSING_ROLES.has(access.role)) {
    const hrKey = canonicalHrIdKey(
      resolveEmployeeIdentityId(access) ?? access.hrId ?? access.loginId ?? null,
    );
    const productCodes = await getWeeklyProductScopeCodes(hrKey);
    return { line, productCodes };
  }

  // Territory roles (DM / RM / NSM) see the whole line.
  return { line, productCodes: null };
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

export type PortalClosingResult = {
  matrix: MonthlyClosingMatrix | null;
  line: string | null;
  /** Published periods available to this viewer's line (newest first). */
  availablePeriods: string[];
  selectedPeriod: string | null;
  /** True when the viewer has a line but nothing has been published for it yet. */
  awaitingPublish: boolean;
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
  const matrix = scope.productCodes ? scopeMatrixToProducts(safe, scope.productCodes) : safe;

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
      const matrix = scope.productCodes ? scopeMatrixToProducts(safe, scope.productCodes) : safe;
      const salesUnits = matrix.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0);
      return { period, salesValue: matrix.grandTotal.rowTotal.salesValue, salesUnits };
    }),
  );

  return points.sort((left, right) => left.period.localeCompare(right.period));
}
