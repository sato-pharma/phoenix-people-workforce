// ─────────────────────────────────────────────────────────────────────────────
// Employee-portal + executive team performance, sourced from Source of Sales + Targets.
//
// The sales performance surfaces (NSM DSMs view, NSM Med Reps view, the RM regional
// roll-up, and the CEO company-wide med-rep / DSM roll-ups) used to read per-row sales
// AND targets from `sales_records` (view v_employee_portal_sales). This module
// re-sources ALL of them from the SAME engine the /sales-vs-target page already uses:
//
//   • ACTUALS come from Source of Sales (indirect, priced at factory price) unioned
//     with Direct Orders — attributed down line → area → rep seat → DM seat by seat
//     occupancy as of the period end (owner rule: "today's geography always").
//   • TARGETS come from au.monthly_targets (per line × area × product × month).
//
// Both arrive together as AchievementRow[] via loadVsTargetRange → the DB function
// au.f_monthly_achievement. We deliberately do NOT re-derive attribution or the
// achievement math here — a second definition of "achievement" is exactly how two
// screens start quoting different numbers for the same month. Every surface below is a
// different SLICE and GROUPING of one loaded window, so they all reconcile with each
// other and with /sales-vs-target.
//
// FIRST MONTH = JULY 2026. The engine is hard-floored at SALES_VS_TARGET_FLOOR
// ("2026-07") in both TS and SQL, so the period picker never offers an earlier month.
//
// COVERAGE-AWARE ACHIEVEMENT. Achievement % is covered-actual ÷ target, i.e. only the
// actual that sits on a key that HAS a target counts toward the percentage (identical
// to VsTargetTotals/sealTotals). A rep with real sales but no target for a product
// shows those sales with a 0 target and does not inflate the %. Figures shown as
// "Sales" are the FULL actual (what they sold), same as the vs-target page.
//
// HEADLINE ≠ SUM OF THE LEADERBOARD. Line / team / region / company totals come from
// ALL scoped rows (via the engine's totalRows), NOT the sum of the leaderboard. A
// meaningful slice of a line's actual has no resolved rep or DM seat — Direct Orders
// spread across regions, and vacant seats. Footing the headline to the leaderboard
// would silently drop that value (up to ~39% of a line's actual in July 2026) and make
// these pages disagree with /sales-vs-target, which totals the same way.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext } from "@/lib/auth/permissions";
import { reconcileUnattributed } from "@/lib/employee-portal/performance-reconciliation";
import { applyAchievementAreaMerges } from "@/lib/sales/closing-area-merges";
import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { loadEmployeeNameMap, loadProductNameMap } from "@/lib/sales/monthly-targets";
import { logError } from "@/lib/observability/log";
import { isRegionalManagerHeldDistrict } from "@/lib/org/sales-only-seats";
import { creditDmRowsByTenure, creditRepRowsByTenure, loadSeatTenure, type SeatTenure } from "@/lib/sales/seat-tenure-credit";
import {
  loadSalesSeatTree,
  regionalManagerAbove,
  vacantDistrictLabel,
  type SalesSeatTree,
} from "@/lib/sales/seat-hierarchy";
import {
  SALES_VS_TARGET_FLOOR,
  isRowPublished,
  loadPublishedPeriodKeys,
  loadVsTargetRange,
  salesVsTargetPeriods,
  totalRows,
} from "@/lib/sales/vs-target";
import { filterRowsForBound, resolveVsTargetBound, type VsTargetBound } from "@/lib/sales/vs-target-scope";

import type {
  CompanyDsmPerformanceData,
  CompanyDsmPerformanceLine,
  CompanyMedRepPerformanceData,
  CompanyMedRepPerformanceLine,
  DsmTeamMemberData,
  DsmTeamMemberProductData,
  DsmTeamPerformanceData,
  NsmDsmPerformanceData,
  RmRegionalPerformanceData,
} from "./service";

const PERIOD_RE = /^\d{4}-\d{2}$/;

/** Line display label + NSM identity for one sales line, supplied by the directory. */
export type SosCompanyLineMeta = {
  lineId: number | null;
  lineName: string;
  nsmName: string | null;
  nsmHrId: string | null;
};

/**
 * Normalize a requested period (single, comma-separated list, or array) into an
 * ordered, de-duplicated list of valid YYYY-MM strings. Local copy so this module
 * does not import a value back out of service.ts (which imports this module).
 */
function normalizePeriods(requested: string | string[] | null | undefined): string[] {
  const raw = Array.isArray(requested)
    ? requested
    : typeof requested === "string"
      ? requested.split(",")
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const value = String(entry ?? "").trim();
    if (!PERIOD_RE.test(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Running accumulator for one rep or one DM, plus its per-product breakdown. */
type MemberAgg = {
  hrId: string;
  /** Full actual value sold — covered + uncovered. Shown as "Sales". */
  fullActual: number;
  /** Actual value that sits on a key WITH a target — the only actual the % uses. */
  coveredActual: number;
  target: number;
  units: number;
  /** For the rep grain: the DM seat this rep's rows resolved to (first seen). */
  dmHrId: string | null;
  /**
   * For the rep grain: the DM SEAT of the first row that resolved to no DM — a vacant district. Read
   * only while `dmHrId` stays null, to name that district instead of "Unassigned District".
   */
  vacantDmSeatId: string | null;
  products: Map<string, { sales: number; coveredSales: number; target: number; units: number }>;
};

type Grain = "rep" | "dm";

/** Load the whole achievement window (July floor → current Cairo month), area-merged. */
async function loadWindowRows(): Promise<{ rows: AchievementRow[]; publishedKeys: Set<string> }> {
  const { current } = salesVsTargetPeriods();
  const [rangeRows, publishedKeys] = await Promise.all([
    loadVsTargetRange(SALES_VS_TARGET_FLOOR, current),
    loadPublishedPeriodKeys(SALES_VS_TARGET_FLOOR, current),
  ]);
  return { rows: applyAchievementAreaMerges(rangeRows), publishedKeys };
}

/**
 * Periods that actually carry sales AND whose (line-scoped) Monthly Closing is PUBLISHED,
 * newest first.
 *
 * Excludes months that exist only because a FUTURE target was loaded (e.g.
 * August/September Pedia targets with no closing yet) — `hasActual` handles that. It also
 * excludes a month whose Monthly Closing the owner has not yet published for that line —
 * distributor files landing is not enough: on 2026-08-10 a single Direct Order row
 * (1,309.50 EGP, area GZ1) was enough to pull August's full target into every cumulative
 * "default view" denominator and roughly halve every manager's keycard achievement, and even
 * a real distributor upload sat unpublished (and therefore unclosed) for up to 12 days after
 * July 2026 ended. `/sales/vs-target` hit the identical failure for its own landing-period
 * pick and was fixed with the same signal (see loadPublishedPeriodKeys in vs-target.ts) —
 * this reuses it rather than re-deriving it, so the two surfaces cannot drift back apart.
 * [Owner ruling, 2026-08-13]: a blank keycard is the correct state until a period is
 * published, never a live-but-unclosed number.
 */
export function activePeriodsOf(rows: AchievementRow[], publishedKeys: ReadonlySet<string>): string[] {
  return Array.from(
    new Set(rows.filter((row) => row.hasActual && isRowPublished(row, publishedKeys)).map((row) => row.period)),
  ).sort((a, b) => b.localeCompare(a));
}

/**
 * The bound one viewer's performance rows are cut to. The vs-target bound, with one narrowing: a
 * Regional Manager reads these pages ONLY through his seat's areas (owner, 2026-10-20, when MRs and
 * DSMs Performance opened to him). resolveVsTargetBound already answers "none" for an RM whose seat
 * did not resolve (2026-10-26); this keeps any other non-area bound closed too, the same rule
 * getRmRegionalPerformance keeps for his landing page.
 */
export function performanceBoundFor(role: AccessContext["role"], bound: VsTargetBound): VsTargetBound {
  if (role === "Regional Manager" && bound.kind !== "areas") return { kind: "none" };
  return bound;
}

/** Load the window scoped to ONE viewer's bound (NSM line, DSM / RM areas, rep self, …). */
async function loadScopedRows(
  ctx: AccessContext,
): Promise<{ rows: AchievementRow[]; activePeriods: string[]; publishedKeys: Set<string> }> {
  // The bound and the window are read TOGETHER (2026-10-31, "fix the slowest five pages"): the
  // window is the same company-wide read whatever the bound, and the cut below is what scopes it.
  const [viewerBound, { rows: windowRows, publishedKeys }] = await Promise.all([
    resolveVsTargetBound(ctx),
    loadWindowRows(),
  ]);
  const bound = performanceBoundFor(ctx.role, viewerBound);
  const rows = filterRowsForBound(windowRows, bound);
  return { rows, activePeriods: activePeriodsOf(rows, publishedKeys), publishedKeys };
}

/**
 * The rows the PUBLISHED closing holds for one viewer — his bound, published periods only, no period
 * picked — together with the kind of bound that cut them.
 *
 * This is the incentive tab's door onto the closing for a manager whose pay is scored on a line or on
 * a set of areas (NSM, DM, RM): the same rows `buildNsmDsmPerformanceFromSos` and
 * `buildDsmTeamPerformanceFromSos` total for the headline, so the achievement the tab scores equals
 * the one the sales pages print. The caller reads `boundKind` — a rep's own bound (`self`) and a
 * closed bound (`none`) are not a manager's and stay on the portal's own sales view.
 */
export async function loadPublishedClosingRowsForViewer(
  ctx: AccessContext,
): Promise<{ boundKind: VsTargetBound["kind"]; rows: AchievementRow[] }> {
  // Read together, as in loadScopedRows above.
  const [viewerBound, { rows: windowRows, publishedKeys }] = await Promise.all([
    resolveVsTargetBound(ctx),
    loadWindowRows(),
  ]);
  const bound = performanceBoundFor(ctx.role, viewerBound);
  const scoped = filterRowsForBound(windowRows, bound);
  return { boundKind: bound.kind, rows: selectRows(scoped, activePeriodsOf(scoped, publishedKeys), null, publishedKeys) };
}

/**
 * Restrict window rows to the active periods, then to the selected periods (if any).
 *
 * Filters per-ROW on `isRowPublished`, not just per-period: a single-line viewer's rows are
 * already all one line (so this is a no-op there), but the company-wide roll-ups mix every
 * line in one `rows` array — if lines ever publish on different schedules again (as July 2026
 * did, staggered across 2026-08-08 to 2026-08-12), a period-only filter would let an
 * unpublished line's raw rows leak in just because a DIFFERENT line made that period "active".
 */
function selectRows(
  rows: AchievementRow[],
  activePeriods: string[],
  requested: string | string[] | null | undefined,
  publishedKeys: ReadonlySet<string>,
): AchievementRow[] {
  const active = new Set(activePeriods);
  const selected = normalizePeriods(requested).filter((period) => active.has(period));
  const base = rows.filter((row) => active.has(row.period) && isRowPublished(row, publishedKeys));
  return selected.length > 0 ? base.filter((row) => selected.includes(row.period)) : base;
}

/** Fold rows into one accumulator per rep (repHrId) or per DM (dmHrId). */
function aggregate(rows: AchievementRow[], grain: Grain): Map<string, MemberAgg> {
  const map = new Map<string, MemberAgg>();
  for (const row of rows) {
    const hrId = grain === "rep" ? row.repHrId : row.dmHrId;
    if (!hrId) continue; // rows with no resolved occupant belong at area level, not here
    let agg = map.get(hrId);
    if (!agg) {
      agg = {
        hrId,
        fullActual: 0,
        coveredActual: 0,
        target: 0,
        units: 0,
        dmHrId: null,
        vacantDmSeatId: null,
        products: new Map(),
      };
      map.set(hrId, agg);
    }
    const target = row.targetValue ?? 0;
    agg.fullActual += row.actualValue;
    agg.units += row.actualUnits;
    agg.target += target;
    if (row.hasTarget) agg.coveredActual += row.actualValue;
    if (grain === "rep" && row.dmHrId && !agg.dmHrId) agg.dmHrId = row.dmHrId;
    if (grain === "rep" && !row.dmHrId && row.dmSeatId && !agg.vacantDmSeatId) agg.vacantDmSeatId = row.dmSeatId;

    const productCode = row.productCode || "UNKNOWN";
    let product = agg.products.get(productCode);
    if (!product) {
      product = { sales: 0, coveredSales: 0, target: 0, units: 0 };
      agg.products.set(productCode, product);
    }
    product.sales += row.actualValue;
    product.units += row.actualUnits;
    product.target += target;
    if (row.hasTarget) product.coveredSales += row.actualValue;
  }
  return map;
}

/** Turn one accumulator into the DsmTeamMemberData shape the pages already render. */
function toMember(
  agg: MemberAgg,
  employeeNames: Map<string, string>,
  productNames: Map<string, string>,
  manager: ResolvedManager,
): DsmTeamMemberData {
  const { managerHrId, managerName, vacantManagerSeatId } = manager;
  const products: DsmTeamMemberProductData[] = Array.from(agg.products.entries())
    .map(([code, product]) => ({
      achievementPercent: product.target > 0 ? (product.coveredSales / product.target) * 100 : 0,
      family: "",
      product: productNames.get(code.toUpperCase()) ?? code,
      sales: product.sales,
      target: product.target,
      units: product.units,
    }))
    .sort((a, b) => b.sales - a.sales);

  return {
    achievementPercent: agg.target > 0 ? (agg.coveredActual / agg.target) * 100 : 0,
    hrId: agg.hrId,
    name: employeeNames.get(agg.hrId) ?? "Unnamed employee",
    managerHrId,
    managerName,
    ...(vacantManagerSeatId ? { vacantManagerSeatId } : {}),
    position: 0,
    products,
    totalSales: agg.fullActual,
    totalTarget: agg.target,
  };
}

/** Sort by achievement (sales as tiebreaker) and assign 1-based positions. */
function rankMembers(members: DsmTeamMemberData[]): DsmTeamMemberData[] {
  return members
    .sort((a, b) => b.achievementPercent - a.achievementPercent || b.totalSales - a.totalSales)
    .map((member, index) => ({ ...member, position: index + 1 }));
}

/** A member's manager: a person, or — for a rep under a vacant district — that district's seat. */
type ResolvedManager = { managerHrId: string | null; managerName: string | null; vacantManagerSeatId?: string | null };

/** How each member's manager (DM for reps, NSM for DMs) is resolved. */
type ManagerResolver = (agg: MemberAgg) => ResolvedManager;

/** Ranked member list for a set of rows at the given grain. Pure. */
function membersFromRows(
  rows: AchievementRow[],
  grain: Grain,
  employeeNames: Map<string, string>,
  productNames: Map<string, string>,
  managerFor: ManagerResolver,
): DsmTeamMemberData[] {
  const aggMap = aggregate(rows, grain);
  return rankMembers(
    Array.from(aggMap.values()).map((agg) => toMember(agg, employeeNames, productNames, managerFor(agg))),
  );
}

/**
 * A rep's manager is the DM seat its rows resolved to. When that seat was vacant (no row named a
 * DM), the rep is placed under the seat itself — "Vacant — Alex-BHR", from the seat tree — rather
 * than in one "Unassigned District" bucket shared by every vacant district (owner, 2026-10-20).
 * A rep with no district seat at all (the "Others" bucket) keeps the old unassigned label.
 */
function repManagerResolver(employeeNames: Map<string, string>, seats: SalesSeatTree): ManagerResolver {
  return (agg) => {
    if (agg.dmHrId) return { managerHrId: agg.dmHrId, managerName: employeeNames.get(agg.dmHrId) ?? null };
    const vacantLabel = vacantDistrictLabel(agg.vacantDmSeatId, seats);
    if (!vacantLabel) return { managerHrId: null, managerName: null };
    return { managerHrId: null, managerName: vacantLabel, vacantManagerSeatId: agg.vacantDmSeatId };
  };
}

/**
 * Medical-rep members of a set of rows, each under its DM — or its vacant district. Pure: exported
 * so the vacant-district label is pinned without a database.
 */
export function repMembersFromRows(
  rows: AchievementRow[],
  employeeNames: Map<string, string>,
  productNames: Map<string, string>,
  seats: SalesSeatTree,
): DsmTeamMemberData[] {
  return membersFromRows(rows, "rep", employeeNames, productNames, repManagerResolver(employeeNames, seats));
}

/**
 * How a rep LEADERBOARD credits a seat's months. `creditRepsByTenure` (owner, 26 Oct 2026: "Person
 * who made them") credits each month to the person who held the seat that month and was employed —
 * never today's holder — so an October hire is not ranked on July–September. Off by default: the
 * expense forms' medical-trip rep list reads the same builder and must keep today's holders.
 */
export type RepBoardOptions = { creditRepsByTenure?: boolean };

/** The seat history when the board asks for it; null (today's holder, as before) when the read fails. */
async function loadRepTenure(options: RepBoardOptions | undefined): Promise<SeatTenure | null> {
  if (!options?.creditRepsByTenure) return null;
  try {
    return await loadSeatTenure();
  } catch (error) {
    logError("Rep leaderboard seat-tenure read failed; crediting today's seat holders", {
      error,
      labels: { event: "rep_board_seat_tenure_failed" },
    });
    return null;
  }
}

/**
 * The rows a rep leaderboard ranks. Only the leaderboard reads these — every headline total keeps the
 * rows as loaded, so a month credited to nobody flows into "not attributed to a rep", never out of
 * the total. Pure.
 */
export function repBoardRows(rows: AchievementRow[], tenure: SeatTenure | null): AchievementRow[] {
  return tenure ? creditRepRowsByTenure(rows, tenure) : rows;
}

/**
 * The rows a DISTRICT MANAGER board ranks — the DSMs list and the Regional Manager rows summed from
 * it: each month under the manager who held the district seat then (owner, 26 Oct 2026, the rep rule
 * one level up). Headline totals keep the rows as loaded, so a month no manager held is "not
 * attributed", never out of the total. Pure.
 */
export function dmBoardRows(rows: AchievementRow[], tenure: SeatTenure | null): AchievementRow[] {
  return tenure ? creditDmRowsByTenure(rows, tenure) : rows;
}

/**
 * Regional Manager roll-up rows (owner, 2026-10-20: the DSMs view had no Regional Manager row).
 *
 * Each row is the SUM of the district-manager rows beneath him and nothing else: every row with a
 * seated DM whose DM seat hangs off an occupied RSM seat is folded under that RSM's occupant, by the
 * same `aggregate` that builds the DM rows. So his sales, target and covered sales are exactly those
 * DM rows added up, and his % is recomputed from the sums, as every row here is. A vacant district
 * under him (no `dmHrId`) is left out on purpose — it has no DM row either, and is the same
 * reconciliation slice it already is on the page — so his row never reads more than the districts
 * listed under him.
 *
 * A seated district with no occupied RSM above it is not dropped: it is totalled with the others of
 * its region into one "<region> — no regional manager" row (`isRegionWithoutManager`), so the rows
 * together foot to every seated district and each district is still counted once.
 *
 * Built apart from `dsms`, never inside it: a Regional Manager added to that list would be counted
 * as one more DSM and his districts twice. `excludeHrId` drops the viewer's own row (an RM looking at
 * his own region would only see himself). `nsm` is who each Regional Manager reports to. Pure.
 */
export function regionalManagerMembersFromRows(
  rows: AchievementRow[],
  seats: SalesSeatTree,
  employeeNames: Map<string, string>,
  productNames: Map<string, string>,
  nsm: { hrId: string | null; name: string | null },
  excludeHrId?: string | null,
): DsmTeamMemberData[] {
  const exclude = String(excludeHrId ?? "").trim().toUpperCase();
  const underRegionalManagers: AchievementRow[] = [];
  // A seated district with NO occupied RSM above it is totalled under its region instead, so the
  // roll-up rows foot to the seated-district total (owner, 2026-10-26: EGP 3.07M sat in regions with
  // no Regional Manager and appeared nowhere). Skipped only for a Regional Manager reading his own
  // region: his bound holds just his districts, and a region row there would be noise. The NSM page
  // passes the NSM's own id as `exclude` too, so "an id was excluded" is NOT "the viewer is an RM" —
  // the viewer is an RM only when that id is a Regional Manager seated above one of these rows.
  const regionLabels = new Map<string, string>();
  // A month earned under a seat since retired (the single "Upper Egypt" seat, now split in two) names a
  // seat the tree no longer holds, so its district cannot be read from the seat. It is placed with the
  // live district seat that carries the same region code — the row's own region — so it lands under the
  // same Regional Manager, or the same "no regional manager" row, as that region's live districts.
  const liveSeatOfRegionCode = new Map<string, string>();
  for (const row of rows) {
    const code = (row.regionCode ?? "").trim().toUpperCase();
    if (code && row.dmSeatId && !liveSeatOfRegionCode.has(code) && regionWithoutManagerOf(row.dmSeatId, seats)) {
      liveSeatOfRegionCode.set(code, row.dmSeatId);
    }
  }
  const seatToReadFrom = (row: AchievementRow): string | null => {
    if (!row.dmSeatId || seats.size === 0 || seats.has(row.dmSeatId)) return row.dmSeatId;
    return liveSeatOfRegionCode.get((row.regionCode ?? "").trim().toUpperCase()) ?? row.dmSeatId;
  };
  const viewerIsRegionalManager =
    exclude !== "" &&
    rows.some((row) => regionalManagerAbove(seatToReadFrom(row), seats)?.hrId.trim().toUpperCase() === exclude);
  for (const row of rows) {
    if (!row.dmHrId) continue;
    const seatId = seatToReadFrom(row);
    const rsm = regionalManagerAbove(seatId, seats);
    if (rsm) {
      if (exclude && rsm.hrId.trim().toUpperCase() === exclude) continue;
      // Re-keyed, never re-priced: the row's own values go under the RSM's occupant.
      underRegionalManagers.push({ ...row, dmHrId: rsm.hrId });
      continue;
    }
    if (viewerIsRegionalManager) continue;
    // A retired seat with no live district of its region is still a seated district's money — it is
    // totalled as "Other districts" rather than dropped, so the rows always foot.
    const retiredSeat = !!row.dmSeatId && seats.size > 0 && !seats.has(row.dmSeatId);
    const region = regionWithoutManagerOf(seatId, seats) ?? (retiredSeat ? "Other districts" : null);
    if (!region) continue;
    const key = `${REGION_WITHOUT_MANAGER_KEY_PREFIX}${region.toLowerCase()}`;
    regionLabels.set(key, `${region} — no regional manager`);
    underRegionalManagers.push({ ...row, dmHrId: key });
  }
  const names = regionLabels.size > 0 ? new Map([...employeeNames, ...regionLabels]) : employeeNames;
  return membersFromRows(underRegionalManagers, "dm", names, productNames, dmManagerResolver(nsm.hrId, nsm.name)).map(
    (member) => (regionLabels.has(member.hrId) ? { ...member, isRegionWithoutManager: true } : member),
  );
}

/** Synthetic key of a region row — never an employee's HR id. */
const REGION_WITHOUT_MANAGER_KEY_PREFIX = "region-without-manager:";

/**
 * The region a seated district belongs to when no Regional Manager sits above it: the district's own
 * name with a trailing number dropped, so "Upper Egypt 1" and "Upper Egypt 2" are one region. null
 * for anything that is not a named district seat (the "Others" bucket, an unknown seat, an empty tree).
 */
export function regionWithoutManagerOf(dmSeatId: string | null | undefined, seats: SalesSeatTree): string | null {
  if (!dmSeatId) return null;
  const seat = seats.get(dmSeatId);
  if (!seat || seat.isOtherPseudoDm || (seat.tier !== "DM" && seat.tier !== "ACTING_DM")) return null;
  const district = (seat.regionName ?? "").trim();
  const region = district.replace(/\s*\(?\d+\)?\s*$/, "").trim();
  return region || district || null;
}

/** A DM's manager is the line's NSM (fixed per line). */
function dmManagerResolver(nsmHrId: string | null, nsmName: string | null): ManagerResolver {
  return () => ({ managerHrId: nsmHrId, managerName: nsmName });
}

/**
 * Line/team/region/company HEADLINE totals from ALL given rows, coverage-aware (via the
 * engine's totalRows). NOT the sum of the leaderboard — see the file header.
 */
function headlineTotals(rows: AchievementRow[]): {
  sales: number;
  target: number;
  achievementPercent: number;
} {
  const totals = totalRows(rows);
  return {
    sales: totals.actualValue,
    target: totals.targetValue,
    achievementPercent: totals.achievementValue != null ? totals.achievementValue * 100 : 0,
  };
}

/**
 * How many district managers a list stands for. A Regional Manager holding a district himself has a row
 * so his money foots to the header, but he is not one more district manager on the count above it.
 */
export function districtManagerCount(dsms: ReadonlyArray<{ hrId: string }>, rows: readonly AchievementRow[]): number {
  const regional = new Set(
    rows
      .filter((row) => isRegionalManagerHeldDistrict(row.dmSeatId) && row.dmHrId)
      .map((row) => String(row.dmHrId).trim().toUpperCase()),
  );
  return dsms.filter((dsm) => !regional.has(dsm.hrId.trim().toUpperCase())).length;
}

// ── NSM portal views ──────────────────────────────────────────────────────────

/**
 * NSM view: every DISTRICT MANAGER on the NSM's line, rolled up from Source of Sales
 * + Targets. Backs /employee-portals/dsms-performance.
 */
export async function buildNsmDsmPerformanceFromSos(
  ctx: AccessContext,
  requested: string | string[] | null | undefined,
): Promise<NsmDsmPerformanceData> {
  // The four lookups need nothing from the rows, so they start with them (2026-10-31).
  const [{ rows, activePeriods, publishedKeys }, employeeNames, productNames, seats, tenure] = await Promise.all([
    loadScopedRows(ctx),
    loadEmployeeNameMap(),
    loadProductNameMap(),
    loadSalesSeatTree(),
    loadRepTenure({ creditRepsByTenure: true }),
  ]);

  const used = selectRows(rows, activePeriods, requested, publishedKeys);
  const board = dmBoardRows(used, tenure);
  const nsmHrId = ctx.hrId ? String(ctx.hrId) : null;
  const nsmName = nsmHrId ? employeeNames.get(nsmHrId) ?? null : null;

  const dsms = membersFromRows(board, "dm", employeeNames, productNames, dmManagerResolver(nsmHrId, nsmName));
  const totals = headlineTotals(used);
  // Reconciled against the DSM rows only — the Regional Manager rows below are sums OF those rows.
  const { unattributedSales, unattributedTarget } = reconcileUnattributed(totals, dsms);

  return {
    dsms,
    regionalManagers: regionalManagerMembersFromRows(
      board,
      seats,
      employeeNames,
      productNames,
      { hrId: nsmHrId, name: nsmName },
      ctx.hrId,
    ),
    periods: activePeriods,
    lineAchievementPercent: totals.achievementPercent,
    dsmCount: districtManagerCount(dsms, board),
    lineTotalSales: totals.sales,
    lineTotalTarget: totals.target,
    unattributedSales,
    unattributedTarget,
  };
}

/**
 * NSM view: every MEDICAL REP on the NSM's line, each tagged with its DM (for the
 * "grouped by DSM" product section), rolled up from Source of Sales + Targets. Backs
 * /employee-portals/med-reps-performance (DSM viewers get their own team via the bound).
 */
export async function buildDsmTeamPerformanceFromSos(
  ctx: AccessContext,
  requested: string | string[] | null | undefined,
  options?: RepBoardOptions,
): Promise<DsmTeamPerformanceData> {
  // The four lookups need nothing from the rows, so they start with them (2026-10-31).
  const [{ rows, activePeriods, publishedKeys }, employeeNames, productNames, seats, tenure] = await Promise.all([
    loadScopedRows(ctx),
    loadEmployeeNameMap(),
    loadProductNameMap(),
    loadSalesSeatTree(),
    loadRepTenure(options),
  ]);

  const used = selectRows(rows, activePeriods, requested, publishedKeys);
  const members = repMembersFromRows(repBoardRows(used, tenure), employeeNames, productNames, seats);
  const totals = headlineTotals(used);
  const { unattributedSales, unattributedTarget } = reconcileUnattributed(totals, members);

  return {
    members,
    periods: activePeriods,
    teamAchievementPercent: totals.achievementPercent,
    teamMemberCount: members.length,
    teamTotalSales: totals.sales,
    teamTotalTarget: totals.target,
    unattributedSales,
    unattributedTarget,
  };
}

// ── CEO company-wide roll-ups ───────────────────────────────────────────────────
// Built from ONE unscoped window load, then split by line code. Company totals cover
// exactly the reported lines' rows, so the per-line blocks foot to the company headline
// and both foot to the sum of every NSM's own view.

/** All window rows restricted to the reported line codes, plus their active periods. */
async function loadCompanyRows(lineCodes: Set<string>): Promise<{
  rows: AchievementRow[];
  activePeriods: string[];
  publishedKeys: Set<string>;
}> {
  const { rows: windowRows, publishedKeys } = await loadWindowRows();
  const relevant = windowRows.filter((row) => row.lineCode != null && lineCodes.has(row.lineCode));
  return { rows: relevant, activePeriods: activePeriodsOf(relevant, publishedKeys), publishedKeys };
}

/**
 * CEO / Super Admin / SFE Manager: company-wide MEDICAL REP performance, one block per
 * line, from Source of Sales + Targets. `lineMetaByCode` carries the directory-derived
 * line label and NSM identity for each line code.
 */
export async function buildCompanyMedRepPerformanceFromSos(
  requested: string | string[] | null | undefined,
  lineMetaByCode: Map<string, SosCompanyLineMeta>,
): Promise<CompanyMedRepPerformanceData> {
  const { rows, activePeriods, publishedKeys } = await loadCompanyRows(new Set(lineMetaByCode.keys()));
  const [employeeNames, productNames, seats, tenure] = await Promise.all([
    loadEmployeeNameMap(),
    loadProductNameMap(),
    loadSalesSeatTree(),
    loadRepTenure({ creditRepsByTenure: true }),
  ]);
  const used = selectRows(rows, activePeriods, requested, publishedKeys);

  const lines: CompanyMedRepPerformanceLine[] = [];
  for (const [lineCode, meta] of lineMetaByCode) {
    const lineRows = used.filter((row) => row.lineCode === lineCode);
    const members = repMembersFromRows(repBoardRows(lineRows, tenure), employeeNames, productNames, seats);
    if (members.length === 0) continue;
    const totals = headlineTotals(lineRows);
    const lineUnattributed = reconcileUnattributed(totals, members);
    lines.push({
      lineId: meta.lineId,
      lineName: meta.lineName,
      nsmName: meta.nsmName,
      performance: {
        members,
        periods: activePeriods,
        teamAchievementPercent: totals.achievementPercent,
        teamMemberCount: members.length,
        teamTotalSales: totals.sales,
        teamTotalTarget: totals.target,
        unattributedSales: lineUnattributed.unattributedSales,
        unattributedTarget: lineUnattributed.unattributedTarget,
      },
    });
  }
  lines.sort((a, b) => b.performance.teamTotalSales - a.performance.teamTotalSales);

  const company = headlineTotals(used);
  const companyUnattributed = reconcileUnattributed(
    company,
    lines.flatMap((line) => line.performance.members),
  );
  return {
    lines,
    periods: activePeriods,
    companyTotalSales: company.sales,
    companyTotalTarget: company.target,
    companyAchievementPercent: company.achievementPercent,
    companyUnattributedSales: companyUnattributed.unattributedSales,
    companyUnattributedTarget: companyUnattributed.unattributedTarget,
    repCount: lines.reduce((sum, line) => sum + line.performance.teamMemberCount, 0),
    lineCount: lines.length,
  };
}

/**
 * CEO / Super Admin / SFE Manager: company-wide DISTRICT MANAGER performance, one block
 * per line, from Source of Sales + Targets.
 */
export async function buildCompanyDsmPerformanceFromSos(
  requested: string | string[] | null | undefined,
  lineMetaByCode: Map<string, SosCompanyLineMeta>,
): Promise<CompanyDsmPerformanceData> {
  const { rows, activePeriods, publishedKeys } = await loadCompanyRows(new Set(lineMetaByCode.keys()));
  const [employeeNames, productNames, seats, tenure] = await Promise.all([
    loadEmployeeNameMap(),
    loadProductNameMap(),
    loadSalesSeatTree(),
    loadRepTenure({ creditRepsByTenure: true }),
  ]);
  const used = selectRows(rows, activePeriods, requested, publishedKeys);
  const board = dmBoardRows(used, tenure);

  const lines: CompanyDsmPerformanceLine[] = [];
  for (const [lineCode, meta] of lineMetaByCode) {
    const lineRows = used.filter((row) => row.lineCode === lineCode);
    const lineBoard = board.filter((row) => row.lineCode === lineCode);
    const dsms = membersFromRows(
      lineBoard,
      "dm",
      employeeNames,
      productNames,
      dmManagerResolver(meta.nsmHrId, meta.nsmName),
    );
    if (dsms.length === 0) continue;
    const totals = headlineTotals(lineRows);
    const lineUnattributed = reconcileUnattributed(totals, dsms);
    lines.push({
      lineId: meta.lineId,
      lineName: meta.lineName,
      nsmName: meta.nsmName,
      performance: {
        dsms,
        regionalManagers: regionalManagerMembersFromRows(lineBoard, seats, employeeNames, productNames, {
          hrId: meta.nsmHrId,
          name: meta.nsmName,
        }),
        periods: activePeriods,
        lineAchievementPercent: totals.achievementPercent,
        dsmCount: districtManagerCount(dsms, lineBoard),
        lineTotalSales: totals.sales,
        lineTotalTarget: totals.target,
        unattributedSales: lineUnattributed.unattributedSales,
        unattributedTarget: lineUnattributed.unattributedTarget,
      },
    });
  }
  lines.sort((a, b) => b.performance.lineTotalSales - a.performance.lineTotalSales);

  const company = headlineTotals(used);
  const companyUnattributed = reconcileUnattributed(
    company,
    lines.flatMap((line) => line.performance.dsms),
  );
  return {
    lines,
    periods: activePeriods,
    companyTotalSales: company.sales,
    companyTotalTarget: company.target,
    companyAchievementPercent: company.achievementPercent,
    companyUnattributedSales: companyUnattributed.unattributedSales,
    companyUnattributedTarget: companyUnattributed.unattributedTarget,
    dsmCount: lines.reduce((sum, line) => sum + line.performance.dsmCount, 0),
    lineCount: lines.length,
  };
}

// ── RM regional roll-up ─────────────────────────────────────────────────────────

/**
 * Regional Manager region roll-up (districts + top reps), from Source of Sales + Targets.
 *
 * Line rows are built at both grains, then narrowed to the RM's region set exactly as
 * before — `isInRegion` is the directory-derived membership test the caller supplies
 * (region membership comes from the RM's own management subtree, never their coarse
 * region label). DSM positions stay line-wide, matching the previous behaviour. Region
 * totals are the coverage-aware headline over the region's DM rows.
 */
export async function buildRmRegionalPerformanceFromSos(
  requested: string | string[] | null | undefined,
  lineCodes: Set<string>,
  isInRegion: (hrId: string | null | undefined) => boolean,
  nsm: { hrId: string | null; name: string | null },
): Promise<RmRegionalPerformanceData> {
  const { rows: relevantAll, publishedKeys } = await loadWindowRows();
  const relevant =
    lineCodes.size > 0
      ? relevantAll.filter((row) => row.lineCode != null && lineCodes.has(row.lineCode))
      : relevantAll;
  const activePeriods = activePeriodsOf(relevant, publishedKeys);
  const [employeeNames, productNames, seats, tenure] = await Promise.all([
    loadEmployeeNameMap(),
    loadProductNameMap(),
    loadSalesSeatTree(),
    loadRepTenure({ creditRepsByTenure: true }),
  ]);
  const used = selectRows(relevant, activePeriods, requested, publishedKeys);

  const dsms = membersFromRows(dmBoardRows(used, tenure), "dm", employeeNames, productNames, dmManagerResolver(nsm.hrId, nsm.name))
    .filter((dsm) => isInRegion(dsm.hrId))
    .sort((a, b) => b.achievementPercent - a.achievementPercent || b.totalSales - a.totalSales);

  const topReps = repMembersFromRows(repBoardRows(used, tenure), employeeNames, productNames, seats)
    .filter((rep) => isInRegion(rep.hrId) || isInRegion(rep.managerHrId))
    .sort((a, b) => b.achievementPercent - a.achievementPercent || b.totalSales - a.totalSales);

  // Region totals: the coverage-aware headline over rows that belong to this RM's region.
  // Place each row by its DM when it HAS one (unchanged from before — never moves a total
  // that already had a district manager), and fall back to the REP when the DM seat is
  // vacant (dmHrId null). Without that fallback a district whose DM resigned mid-month has
  // its still-selling reps' sales silently dropped from the region total while those reps
  // remain in the Top-Reps list — the header then reads LESS than the reps shown under it.
  // A row with neither a DM nor a rep in the region (Direct Orders parked in "Others")
  // stays excluded, exactly as before.
  const rowInRegion = (row: AchievementRow) =>
    row.dmHrId ? isInRegion(row.dmHrId) : isInRegion(row.repHrId);
  const region = headlineTotals(used.filter(rowInRegion));
  // Foot the header to the districts list: the gap is the vacant-seat reps' sales (and any
  // in-region direct orders) that no DSM row below carries. 0 — and the note hides — while
  // every district has a seated DM.
  const { unattributedSales, unattributedTarget } = reconcileUnattributed(region, dsms);

  return {
    dsms,
    topReps,
    periods: activePeriods,
    regionAchievementPercent: region.achievementPercent,
    dsmCount: districtManagerCount(dsms, used),
    regionTotalSales: region.sales,
    regionTotalTarget: region.target,
    unattributedSales,
    unattributedTarget,
  };
}
