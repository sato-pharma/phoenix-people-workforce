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
// Nothing here touches the DB or the network. `resolveMarketingRoiScope`'s requester
// route mirrors the EXACT visibility decision `canSeeMarketingRequest` makes (it calls
// the same `canSeeMarketingHierarchyRecord`), so the report can SQL-prefilter to
// visible requests instead of loading 200 rows and discarding most. Two ROI-only
// routes sit beside it and are deliberately WIDER than `canSeeMarketingRequest`: the
// Medical Rep's territory route (`territoryRouteAdmitsRequest`, 2026-09-18/30) and the
// National Sales Manager's line route (`lineRouteAdmitsRequest`, owner 2026-10-20).
// `computeMarketingFilterOptions` enforces the locked "never show a dead filter" rule
// against a viewer's already-scoped visible request set.
// ─────────────────────────────────────────────────────────────────────────────

/** Options that inject data the pure scope function cannot derive from the
 *  directory alone (PM/GPM product ownership — see plan §A; the NSM's line overrides). */
export type ResolveMarketingRoiScopeOptions = {
  /** product codes this PM/GPM owns; null = not yet set up (page shows nothing). */
  ownedProductCodes?: Set<string> | null;
  /** line names this PM/GPM owns (for the line filter). */
  ownedLineNames?: Set<string> | null;
  /**
   * The viewer's `app_auth_users.line_scope_override` — read ONLY for a National Sales Manager
   * (see `resolveLineRouteOverride` in roi-report-service.ts). It ADDS to his own seat line for the
   * line route; it is ignored for every other role, so passing it can never widen anyone else.
   */
  lineScopeOverride?: Iterable<string | null | undefined> | null;
};

/** The one role that runs the line route (owner, 2026-10-20). */
export const LINE_ROUTE_ROLE = "National Sales Manager" as const;

/** Exactly the territory route's own line normalization (trim + lower-case), so the two routes can
 *  never read one line name two ways. */
function normalizeRouteLineName(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * The line(s) a marketing request is ON — the requester's seat line plus every promoted product's
 * line, normalized. Built from ALL the request's products, never the confidential-masked list, so
 * masking a product can neither widen nor narrow who may see the row. A request spanning two lines
 * is on both. Empty = the line is unknown, which neither the territory route nor the line route
 * ever admits.
 *
 * One builder for every gate (the report, View Sales, the reverse lookup and the Coverage Report),
 * so no gate can read a request's lines differently from another.
 */
export function collectRequestLineNames(
  requesterLineName: string | null | undefined,
  productLineNames: Iterable<string | null | undefined>,
): Set<string> {
  const lines = new Set<string>();
  for (const candidate of [requesterLineName, ...productLineNames]) {
    const lineName = normalizeRouteLineName(candidate);
    if (lineName) lines.add(lineName);
  }
  return lines;
}

/**
 * The viewer's lines for the LINE route — National Sales Manager only (owner, 2026-10-20).
 *
 * His own seat line (`employees.line_id` → the directory's `lineName`) plus every line on his
 * `line_scope_override`. Every other role gets an empty set, so the route is inert for them: a
 * District Manager, Regional Manager or Medical Rep scope is exactly what it was.
 */
export function resolveViewerLineRouteNames(
  access: AccessContext,
  employeeRows: EmployeeDirectoryRow[],
  viewerHrId: string | null,
  lineScopeOverride: Iterable<string | null | undefined> | null | undefined,
): Set<string> {
  const lineNames = new Set<string>();
  if (access.role !== LINE_ROUTE_ROLE) return lineNames;
  if (viewerHrId) {
    for (const row of employeeRows) {
      if (normalizeHrId(row.hrId) !== viewerHrId) continue;
      const lineName = normalizeRouteLineName(row.lineName);
      if (lineName) lineNames.add(lineName);
    }
  }
  for (const candidate of lineScopeOverride ?? []) {
    const lineName = normalizeRouteLineName(candidate);
    if (lineName) lineNames.add(lineName);
  }
  return lineNames;
}

/**
 * THE line-route decision, in one pure place (owner, 2026-10-20: a National Sales Manager "sees
 * every campaign on his line, whoever ran it").
 *
 * The requester route walks the manager chain, and Product Managers, Group Product Managers and
 * the Marketing Manager report up the MARKETING department, so their campaigns on his line never
 * reached him. This admits a request raised by ANYBODY when it is on one of his lines — the
 * requester's seat line or any promoted product's line (`collectRequestLineNames`). An unknown
 * line is never his, and a viewer with no lines (every seat but the NSM) admits nothing here.
 *
 * It decides WHICH requests he sees, never which product names he sees: confidential products stay
 * masked by `canRevealRestricted` exactly as for every other row he has.
 */
export function lineRouteAdmitsRequest(
  scope: Pick<MarketingRoiScope, "visibleLineRouteNames">,
  requestLineNames: Iterable<string | null | undefined>,
): boolean {
  if (scope.visibleLineRouteNames.size === 0) return false;
  for (const candidate of requestLineNames) {
    const lineName = normalizeRouteLineName(candidate);
    if (lineName && scope.visibleLineRouteNames.has(lineName)) return true;
  }
  return false;
}

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
    visibleAreaIds: new Set<number>(),
    visibleAreaLineNames: new Set<string>(),
    visibleLineRouteNames: new Set<string>(),
    canRevealRestricted: canViewRestrictedProducts(access.role),
    ...overrides,
  };
}

/**
 * The territory route, Medical-Rep only — owner instruction 2026-09-18, narrowed to the rep's own
 * LINE on 2026-09-30.
 *
 * A rep no longer raises marketing requests (the drafts workspace and the Approval Inbox went dark
 * for them the same day), so the requester route leaves their ROI Tracker empty. He asked for the
 * page to stay "to be able to track roi of requests his manager did in his area", so a rep also
 * sees every request whose TARGET CUSTOMER sits in their own `employees.area_id` — which is their
 * DM's spend on their patch, and not the DM's spend on a sibling rep's patch.
 *
 * 🔴 AN AREA IS NOT PER LINE, so the area on its own is NOT the bound the wording implies. Live
 * `public.areas` rows carry `line_id` NULL — one "Gharbia 2 (Mahalla)" row (id 1104) is held at
 * once by the Pedia rep, the CNS rep and the Anti Infective rep — so area-only matching showed each
 * of them the others' campaigns. Measured on production 2026-09-30: 46 of 82 admitted pairs were
 * another line's spend, across 28 of the 72 active reps, and the Pedia rep on Gharbia 2 saw ONE row
 * and it was the CNS District Manager's. The owner's ruling: "he must see his line."
 *
 * So this returns BOTH halves, and `roi-report-service.ts` requires both to match. A rep with no
 * line on his master record admits nothing through this route — his requester route is untouched.
 *
 * Deliberately narrow: no other seat gets an area route. A DM, RM or NSM already reaches everything
 * their subtree raised through the requester route, which is wider than one area.
 */
function viewerAreaScope(
  access: AccessContext,
  employeeRows: EmployeeDirectoryRow[],
  viewerHrId: string | null,
): { areaIds: Set<number>; lineNames: Set<string> } {
  const areaIds = new Set<number>();
  const lineNames = new Set<string>();
  if (access.role !== "Medical Rep" || !viewerHrId) return { areaIds, lineNames };
  for (const row of employeeRows) {
    if (normalizeHrId(row.hrId) !== viewerHrId) continue;
    const lineName = (row.lineName ?? "").trim().toLowerCase();
    if (lineName) lineNames.add(lineName);
    if (row.areaId === null || row.areaId === undefined) continue;
    const areaId = Number(row.areaId);
    if (Number.isFinite(areaId)) areaIds.add(areaId);
  }
  // Both halves or neither: an area with no line would be the 2026-09-30 leak again, and a line with
  // no area was never a route at all.
  if (areaIds.size === 0 || lineNames.size === 0) return { areaIds: new Set<number>(), lineNames: new Set<string>() };
  return { areaIds, lineNames };
}

/**
 * THE territory-route decision, in one pure place: does this request reach this viewer because of
 * WHERE and WHAT it is, rather than who raised it?
 *
 * Both halves must match — the target customer's area must be the viewer's own, AND the request must
 * be on the viewer's own line. It lives here, beside the scope that feeds it, rather than inside
 * `getMarketingRoiReport`'s DB closure, because that is where the 2026-09-30 leak could hide: the
 * area half alone reads as a complete rule ("requests in his area") and is not one, since live
 * `public.areas` rows carry `line_id` NULL and one area id is shared by the Pedia, CNS and Anti
 * Infective reps standing on that patch.
 *
 * `requestLineNames` is normalized here, so no caller can pass the wrong casing and silently widen
 * the route. An empty set means the request's line is unknown, and an unknown line is never "his".
 */
export function territoryRouteAdmitsRequest(
  scope: Pick<MarketingRoiScope, "visibleAreaIds" | "visibleAreaLineNames">,
  targetAreaId: number | null | undefined,
  requestLineNames: Iterable<string | null | undefined>,
): boolean {
  if (scope.visibleAreaIds.size === 0 || scope.visibleAreaLineNames.size === 0) return false;
  if (targetAreaId === null || targetAreaId === undefined) return false;
  if (!scope.visibleAreaIds.has(Number(targetAreaId))) return false;
  for (const candidate of requestLineNames) {
    const lineName = (candidate ?? "").trim().toLowerCase();
    if (lineName && scope.visibleAreaLineNames.has(lineName)) return true;
  }
  return false;
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
 *  - A Medical Rep additionally gets a TERRITORY route (`visibleAreaIds` +
 *    `visibleAreaLineNames`, owner 2026-09-18, narrowed to his own line
 *    2026-09-30): every request whose target customer sits in their own area AND
 *    which is on their own line, whoever raised it. See `viewerAreaScope` below —
 *    an area is shared by every line's rep, so the area alone is not the bound.
 *  - A National Sales Manager additionally gets a LINE route
 *    (`visibleLineRouteNames`, owner 2026-10-20: "He sees every campaign on his
 *    line, whoever ran it"): every request on his own line or a line on his
 *    `line_scope_override`, whoever raised it — in practice the Product, Group
 *    Product and Marketing Managers' campaigns, which sit outside his chain. The
 *    decision is `lineRouteAdmitsRequest`; it never reveals a confidential product.
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

  const territory = viewerAreaScope(access, employeeRows, viewerHrId);
  const lineRoute = resolveViewerLineRouteNames(access, employeeRows, viewerHrId, opts.lineScopeOverride);

  return emptyScope(access, {
    viewerHrId,
    selfOnly: scopeForRole(role) === "self",
    visibleRequesterHrIds,
    visibleDmHrIds,
    visibleNsmHrIds,
    visibleRsmHrIds,
    visibleLineNames: visibleLineNames.size > 0 ? visibleLineNames : new Set<string>(),
    visibleProductCodes: null,
    visibleAreaIds: territory.areaIds,
    visibleAreaLineNames: territory.lineNames,
    visibleLineRouteNames: lineRoute,
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
 *   ≥2 live options → render; exactly 1 AND universal → auto-apply + hide; else hide.
 */
function multiselectDimension(
  key: RoiFilterKey,
  label: string,
  entries: MarketingRoiRequestIndexEntry[],
  extract: (entry: MarketingRoiRequestIndexEntry) => ValueLabel[],
): RoiFilterDimension {
  const options = toSortedOptions(tallyOptions(entries, extract));
  // Only auto-apply a lone value when it covers EVERY entry. A single value present on
  // just a subset (the rest carry none — e.g. the org's only Regional Manager, who
  // appears in a minority of request chains) must NOT be auto-applied: it would mislead
  // and, if applied, exclude all the value-less requests. Matches roi-facets.ts.
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
