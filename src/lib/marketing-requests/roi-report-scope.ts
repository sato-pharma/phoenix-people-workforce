import { scopeForRole, type AccessContext } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { canViewRestrictedProducts } from "@/lib/sales/access-scope";
import {
  canSeeMarketingHierarchyRecord,
  companyMarketingRoles,
  normalizeHrId,
} from "@/lib/marketing-requests/service";
import type {
  MarketingRoiFilterOptions,
  MarketingRoiRequestIndexEntry,
  MarketingRoiScope,
  RoiFilterDimension,
  RoiFilterKey,
  RoiFilterOption,
} from "@/lib/marketing-requests/roi-report-types";

// ─────────────────────────────────────────────────────────────────────────────
// Pure scope + filter-option logic for the Marketing ROI Filter Engine.
//
// Nothing here touches the DB or the network. `resolveMarketingRoiScope` mirrors
// the EXACT visibility decision `canSeeMarketingRequest` makes (it calls the same
// `canSeeMarketingHierarchyRecord`), so the report can SQL-prefilter to visible
// requests instead of loading 200 rows and discarding most. `computeMarketing
// FilterOptions` enforces the locked "never show a dead filter" rule against a
// viewer's already-scoped visible request set.
// ─────────────────────────────────────────────────────────────────────────────

/** Options that inject data the pure scope function cannot derive from the
 *  directory alone (PM/GPM product ownership — see plan §A). */
export type ResolveMarketingRoiScopeOptions = {
  /** product codes this PM/GPM owns; null = not yet set up (page shows nothing). */
  ownedProductCodes?: Set<string> | null;
  /** line names this PM/GPM owns (for the line filter). */
  ownedLineNames?: Set<string> | null;
};

function emptyScope(
  access: AccessContext,
  overrides: Partial<MarketingRoiScope>,
): MarketingRoiScope {
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
    canRevealRestricted: canViewRestrictedProducts(access.role),
    ...overrides,
  };
}

/**
 * Resolve the viewer's marketing-ROI data-visibility scope from their AccessContext
 * and the employee directory. Pure and synchronous.
 *
 *  - Company-wide oversight roles (system scope or `companyMarketingRoles`) → no
 *    constraint (`visibleRequesterHrIds = null`).
 *  - Product roles (PM/GPM) → product-centric: requester is NOT constrained, but
 *    results are limited to requests promoting an owned product (injected via
 *    `opts.ownedProductCodes`).
 *  - Everyone else → one directory pass collects the requester HR_IDs whose
 *    requests are visible (exactly `canSeeMarketingRequest`'s decision) and
 *    classifies the visible seats into DM/NSM/RSM buckets (excluding the viewer's
 *    own seat) so the per-DM / per-NSM / per-RSM filters can be offered.
 */
export function resolveMarketingRoiScope(
  access: AccessContext,
  employeeRows: EmployeeDirectoryRow[],
  opts: ResolveMarketingRoiScopeOptions = {},
): MarketingRoiScope {
  const role = access.role;
  const viewerHrId = normalizeHrId(access.hrId);
  const canRevealRestricted = canViewRestrictedProducts(role);

  if (access.scope === "system" || companyMarketingRoles.has(role)) {
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
    // Product roles are not in the rep chain — scope by owned products, not by
    // requester subtree. Until §A ownership is wired, an empty owned set yields an
    // empty (never wrong) page rather than leaking every line's requests.
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
    const canSee = canSeeMarketingHierarchyRecord(
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
    canRevealRestricted,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter options
// ─────────────────────────────────────────────────────────────────────────────

type ValueLabel = { value: string; label: string };

/** Count distinct requests carrying each value (one count per request, not per
 *  occurrence) so the option counts read as "N requests". */
function tallyOptions(
  entries: MarketingRoiRequestIndexEntry[],
  extract: (entry: MarketingRoiRequestIndexEntry) => ValueLabel[],
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

/**
 * Build one multi-select dimension and apply the locked render rule:
 *   ≥2 live options → render; exactly 1 → auto-apply + hide; 0 → hide.
 */
function multiselectDimension(
  key: RoiFilterKey,
  label: string,
  entries: MarketingRoiRequestIndexEntry[],
  extract: (entry: MarketingRoiRequestIndexEntry) => ValueLabel[],
): RoiFilterDimension {
  const options = toSortedOptions(tallyOptions(entries, extract));
  return {
    key,
    label,
    type: "multiselect",
    options,
    render: options.length >= 2,
    autoApplied: options.length === 1 ? [options[0].value] : null,
  };
}

function pair(value: string | null | undefined, label: string | null | undefined): ValueLabel[] {
  const v = (value ?? "").trim();
  if (!v) return [];
  // Hide rather than expose a raw key (e.g. an hr_id) when the human label is missing.
  // Dimensions that intentionally use the value as its own label (status, line, …) always
  // pass a non-empty label, so this only drops name-keyed options whose name never resolved.
  const l = (label ?? "").trim();
  if (!l) return [];
  return [{ value: v, label: l }];
}

/**
 * Compute the filter dimensions for a viewer's already-scoped, eligible visible
 * request set. Pure: derives options purely from `entries` (which already encode
 * the viewer's scope), so no dimension can ever offer a value the viewer can't see.
 *
 * Note: ROI result-status is intentionally NOT emitted here — it needs the ROI
 * math that the cheap options endpoint deliberately skips. The client offers it as
 * a fixed enum and the report applies it to the returned rows.
 */
export function computeMarketingFilterOptions(
  scope: MarketingRoiScope,
  entries: MarketingRoiRequestIndexEntry[],
): MarketingRoiFilterOptions {
  const dimensions: RoiFilterDimension[] = [];

  dimensions.push(
    multiselectDimension("dm", "District Manager", entries, (e) => pair(e.dmHrId, e.dmName)),
  );
  dimensions.push(
    multiselectDimension("nsm", "National Sales Manager", entries, (e) => pair(e.nsmHrId, e.nsmName)),
  );
  dimensions.push(
    multiselectDimension("rsm", "Regional Manager", entries, (e) => pair(e.rsmHrId, e.rsmName)),
  );
  dimensions.push(
    multiselectDimension("line", "Line", entries, (e) => pair(e.lineName, e.lineName)),
  );
  dimensions.push(
    multiselectDimension("requester", "Requester", entries, (e) => pair(e.requesterHrId, e.requesterName)),
  );
  dimensions.push(
    multiselectDimension("approvedBy", "Approved by", entries, (e) =>
      e.approverRoleKeys.map((roleKey) => ({ value: roleKey, label: roleKey })),
    ),
  );
  dimensions.push(
    multiselectDimension("status", "Status", entries, (e) => pair(e.status, e.status)),
  );
  dimensions.push(
    multiselectDimension("requestType", "Request type", entries, (e) =>
      e.requestTypeId ? [{ value: String(e.requestTypeId), label: e.requestTypeName ?? `Type ${e.requestTypeId}` }] : [],
    ),
  );
  dimensions.push(
    multiselectDimension("region", "Region", entries, (e) => pair(e.regionName, e.regionName)),
  );
  dimensions.push(
    multiselectDimension("distributor", "Distributor", entries, (e) =>
      e.distributorCodes.map((code) => ({ value: code, label: code })),
    ),
  );
  dimensions.push(
    multiselectDimension("product", "Product", entries, (e) =>
      e.productCodes.map((code, index) => ({ value: code, label: e.productNames[index] ?? code })),
    ),
  );
  dimensions.push(
    multiselectDimension("pharmacy", "Target pharmacy", entries, (e) =>
      e.pharmacyKeys.map((keyValue, index) => ({ value: keyValue, label: e.pharmacyNames[index] ?? keyValue })),
    ),
  );

  // ROI duration — number range. Render only when there are ≥2 distinct values.
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

  // Pay date — date range. Render only when there are ≥2 distinct dates.
  const payDates = entries
    .map((e) => e.payDate)
    .filter((d): d is string => Boolean(d))
    .sort();
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

  // Confidential toggle — only when the viewer may reveal AND something is hidden.
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
