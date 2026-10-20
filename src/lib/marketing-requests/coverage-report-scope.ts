import { canSeeHrScopedRecord, scopeForRole, type AccessContext } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { canViewRestrictedProducts } from "@/lib/sales/access-scope";
import {
  coverageReportCompanyWideRoles,
} from "@/lib/marketing-requests/coverage-report-access";
import {
  normalizeHrId,
  reportsUpToViewer,
  sameEmployeeDepartment,
} from "@/lib/marketing-requests/service";
import { resolveViewerLineRouteNames } from "@/lib/marketing-requests/roi-report-scope";
import type {
  CoverageFilterDimension,
  MarketingCoverageFilterKey,
  MarketingCoverageFilterOptions,
  MarketingCoverageRequestIndexEntry,
  MarketingRoiScope,
  RoiFilterOption,
} from "@/lib/marketing-requests/roi-report-types";

// ─────────────────────────────────────────────────────────────────────────────
// Pure scope + filter-option logic for the Marketing Coverage Report.
//
// Structurally mirrors roi-report-scope.ts. Its company-wide role set
// (coverageReportCompanyWideRoles) is the same six roles as ROI Tracking's
// companyMarketingRoles since 2026-10-09 (owner) — it used to leave the Finance
// Manager and Financial Advisor on their own, empty, subtree. Everyone else is
// scoped via the SAME manager-chain walk ROI Tracking uses (reportsUpToViewer /
// sameEmployeeDepartment, both exported from service.ts) so the two reports never
// disagree on what "own subtree" means. The National Sales Manager's LINE route
// (owner, 2026-10-20: "He sees every campaign on his line, whoever ran it") runs
// here exactly as in ROI Tracking — the same `resolveViewerLineRouteNames` and the
// same `lineRouteAdmitsRequest` — so a Product Manager's campaign on his line is in
// both reports or in neither. The one remaining difference is the Medical Rep's
// territory route, which only ROI Tracking runs (see emptyScope).
// ─────────────────────────────────────────────────────────────────────────────

export type ResolveMarketingCoverageScopeOptions = {
  ownedProductCodes?: Set<string> | null;
  ownedLineNames?: Set<string> | null;
  /** The NSM's `line_scope_override` — see ResolveMarketingRoiScopeOptions.lineScopeOverride. */
  lineScopeOverride?: Iterable<string | null | undefined> | null;
};

/**
 * Per-record visibility check for the coverage report. Mirrors
 * `canSeeMarketingHierarchyRecord` (service.ts): `coverageReportCompanyWideRoles`
 * short-circuits to "sees everything"; every other role falls through to the
 * manager-chain walk.
 */
function canSeeMarketingCoverageRecord(
  access: AccessContext,
  record: { employeeHrId?: string | null; hrId?: string | null; managerHrId?: string | null },
  employeeRows: EmployeeDirectoryRow[],
): boolean {
  if (access.scope === "system" || coverageReportCompanyWideRoles.has(access.role)) return true;

  const viewerHrId = normalizeHrId(access.hrId);
  const targetHrId = normalizeHrId(record.employeeHrId ?? record.hrId);
  if (!viewerHrId) return false;
  if (targetHrId === viewerHrId) return true;

  const employeesByHrId = new Map(
    employeeRows
      .map((row) => [normalizeHrId(row.hrId), row] as const)
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
  );
  const viewer = employeesByHrId.get(viewerHrId);
  const target = targetHrId ? employeesByHrId.get(targetHrId) : undefined;

  if (viewer && target && !sameEmployeeDepartment(viewer, target)) return false;
  if (targetHrId && reportsUpToViewer({ employeesByHrId, targetHrId, viewerHrId })) return true;

  return canSeeHrScopedRecord(access, record);
}

function emptyScope(access: AccessContext, overrides: Partial<MarketingRoiScope>): MarketingRoiScope {
  return {
    role: access.role,
    isCompanyWide: false,
    viewerHrId: normalizeHrId(access.hrId),
    selfOnly: false,
    visibleRequesterHrIds: new Set<string>(),
    visibleDmHrIds: new Set<string>(),
    visibleNsmHrIds: new Set<string>(),
    visibleRsmHrIds: new Set<string>(),
    visibleLineNames: null,
    visibleProductCodes: null,
    // The Coverage Report does NOT run the territory route the ROI Tracker gained on 2026-09-18 —
    // its roles were not part of that instruction, so BOTH halves stay empty and are inert here.
    // That is also why the 2026-09-30 cross-line leak never reached this tab of the same page.
    visibleAreaIds: new Set<number>(),
    visibleAreaLineNames: new Set<string>(),
    // The National Sales Manager's line route DOES run here (owner, 2026-10-20) — filled in by
    // resolveMarketingCoverageScope below; empty, and inert, for every other seat.
    visibleLineRouteNames: new Set<string>(),
    canRevealRestricted: canViewRestrictedProducts(access.role),
    ...overrides,
  };
}

export function resolveMarketingCoverageScope(
  access: AccessContext,
  employeeRows: EmployeeDirectoryRow[],
  opts: ResolveMarketingCoverageScopeOptions = {},
): MarketingRoiScope {
  const role = access.role;
  const viewerHrId = normalizeHrId(access.hrId);
  const canRevealRestricted = canViewRestrictedProducts(role);

  if (access.scope === "system" || coverageReportCompanyWideRoles.has(role)) {
    return emptyScope(access, {
      isCompanyWide: true,
      viewerHrId,
      visibleRequesterHrIds: null,
      visibleLineNames: null,
      visibleProductCodes: null,
      canRevealRestricted,
    });
  }

  if (role === "Product Manager" || role === "Group Product Manager") {
    return emptyScope(access, {
      viewerHrId,
      selfOnly: false,
      visibleRequesterHrIds: null,
      visibleLineNames: opts.ownedLineNames ?? null,
      visibleProductCodes: opts.ownedProductCodes ?? new Set<string>(),
      canRevealRestricted,
    });
  }

  const visibleRequesterHrIds = new Set<string>();
  const visibleDmHrIds = new Set<string>();
  const visibleNsmHrIds = new Set<string>();
  const visibleRsmHrIds = new Set<string>();
  const visibleLineNames = new Set<string>();

  for (const row of employeeRows) {
    const targetHrId = normalizeHrId(row.hrId);
    if (!targetHrId) continue;
    const canSee = canSeeMarketingCoverageRecord(
      access,
      { employeeHrId: row.hrId, managerHrId: row.managerHrId },
      employeeRows,
    );
    if (!canSee) continue;

    visibleRequesterHrIds.add(targetHrId);
    if (row.lineName) visibleLineNames.add(row.lineName);

    if (targetHrId !== viewerHrId) {
      const fn = resolveJobFunctionRole(row.jobTitle);
      if (fn === "District Manager") visibleDmHrIds.add(targetHrId);
      else if (fn === "National Sales Manager") visibleNsmHrIds.add(targetHrId);
      else if (fn === "Regional Manager") visibleRsmHrIds.add(targetHrId);
    }
  }

  return emptyScope(access, {
    viewerHrId,
    selfOnly: scopeForRole(role) === "self",
    visibleRequesterHrIds,
    visibleDmHrIds,
    visibleNsmHrIds,
    visibleRsmHrIds,
    visibleLineNames: visibleLineNames.size > 0 ? visibleLineNames : new Set<string>(),
    visibleProductCodes: null,
    visibleLineRouteNames: resolveViewerLineRouteNames(access, employeeRows, viewerHrId, opts.lineScopeOverride),
    canRevealRestricted,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter options (cheap, non-faceted — powers the initial /filter-options GET;
// the client re-narrows via coverage-report-facets.ts as selections change).
// ─────────────────────────────────────────────────────────────────────────────

type ValueLabel = { value: string; label: string };

function tallyOptions(
  entries: MarketingCoverageRequestIndexEntry[],
  extract: (entry: MarketingCoverageRequestIndexEntry) => ValueLabel[],
): Map<string, { label: string; count: number }> {
  const tally = new Map<string, { label: string; count: number }>();
  for (const entry of entries) {
    const seen = new Set<string>();
    for (const { value, label } of extract(entry)) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      const current = tally.get(value);
      if (current) current.count += 1;
      else tally.set(value, { label: label || value, count: 1 });
    }
  }
  return tally;
}

function toSortedOptions(tally: Map<string, { label: string; count: number }>): RoiFilterOption[] {
  return Array.from(tally.entries())
    .map(([value, { label, count }]) => ({ value, label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function multiselectDimension(
  key: MarketingCoverageFilterKey,
  label: string,
  entries: MarketingCoverageRequestIndexEntry[],
  extract: (entry: MarketingCoverageRequestIndexEntry) => ValueLabel[],
): CoverageFilterDimension {
  const options = toSortedOptions(tallyOptions(entries, extract));
  const everyEntryHasValue = entries.every((entry) => extract(entry).length > 0);
  return {
    key,
    label,
    type: "multiselect",
    options,
    render: options.length >= 2,
    autoApplied: options.length === 1 && everyEntryHasValue ? [options[0].value] : null,
  };
}

function pair(value: string | null | undefined, label: string | null | undefined): ValueLabel[] {
  const v = (value ?? "").trim();
  if (!v) return [];
  const l = (label ?? "").trim();
  if (!l) return [];
  return [{ value: v, label: l }];
}

export function computeMarketingCoverageFilterOptions(
  scope: MarketingRoiScope,
  entries: MarketingCoverageRequestIndexEntry[],
): MarketingCoverageFilterOptions {
  const dimensions: CoverageFilterDimension[] = [];

  dimensions.push(multiselectDimension("nsm", "National Sales Manager", entries, (e) => pair(e.nsmHrId, e.nsmName)));
  dimensions.push(multiselectDimension("rsm", "Regional Manager", entries, (e) => pair(e.rsmHrId, e.rsmName)));
  dimensions.push(multiselectDimension("dm", "District Manager", entries, (e) => pair(e.dmHrId, e.dmName)));
  dimensions.push(multiselectDimension("requester", "Requester", entries, (e) => pair(e.requesterHrId, e.requesterName)));
  dimensions.push(multiselectDimension("requesterTier", "Requester tier", entries, (e) => pair(e.requesterTier, e.requesterTier)));
  dimensions.push(multiselectDimension("line", "Line", entries, (e) => pair(e.lineName, e.lineName)));
  dimensions.push(multiselectDimension("region", "Region", entries, (e) => pair(e.regionName, e.regionName)));
  dimensions.push(multiselectDimension("area", "Area", entries, (e) => pair(e.areaName, e.areaName)));
  dimensions.push(
    multiselectDimension("approvedBy", "Approved by", entries, (e) => e.approverRoleKeys.map((roleKey) => ({ value: roleKey, label: roleKey }))),
  );
  dimensions.push(multiselectDimension("status", "Status", entries, (e) => pair(e.status, e.status)));
  dimensions.push(
    multiselectDimension("requestType", "Request type", entries, (e) =>
      e.requestTypeId ? [{ value: String(e.requestTypeId), label: e.requestTypeName ?? `Type ${e.requestTypeId}` }] : [],
    ),
  );
  dimensions.push(
    multiselectDimension("distributor", "Distributor", entries, (e) => e.distributorCodes.map((code) => ({ value: code, label: code }))),
  );
  dimensions.push(
    multiselectDimension("product", "Product", entries, (e) => e.productCodes.map((code, index) => ({ value: code, label: e.productNames[index] ?? code }))),
  );
  dimensions.push(
    multiselectDimension("pharmacy", "Target pharmacy", entries, (e) => e.pharmacyKeys.map((keyValue, index) => ({ value: keyValue, label: e.pharmacyNames[index] ?? keyValue }))),
  );

  const durations = entries.map((e) => e.roiDurationMonths).filter((n) => Number.isFinite(n) && n > 0);
  const durMin = durations.length ? Math.min(...durations) : null;
  const durMax = durations.length ? Math.max(...durations) : null;
  dimensions.push({
    key: "duration",
    label: "ROI duration (months)",
    type: "numberRange",
    options: [],
    render: durMin !== null && durMax !== null && durMin !== durMax,
    autoApplied: null,
    min: durMin ?? undefined,
    max: durMax ?? undefined,
  });

  const payDates = entries.map((e) => e.payDate).filter((d): d is string => Boolean(d)).sort();
  const earliest = payDates.length ? payDates[0] : null;
  const latest = payDates.length ? payDates[payDates.length - 1] : null;
  dimensions.push({
    key: "payDate",
    label: "Pay date",
    type: "dateRange",
    options: [],
    render: Boolean(earliest && latest && earliest !== latest),
    autoApplied: null,
    earliest,
    latest,
  });

  const hasRestricted = entries.some((e) => e.hasRestrictedProduct);
  dimensions.push({
    key: "includeRestricted",
    label: "Include confidential products",
    type: "toggle",
    options: [],
    render: scope.canRevealRestricted && hasRestricted,
    autoApplied: null,
  });

  return {
    dimensions,
    visibleRequestCount: entries.length,
    canRevealRestricted: scope.canRevealRestricted,
  };
}
