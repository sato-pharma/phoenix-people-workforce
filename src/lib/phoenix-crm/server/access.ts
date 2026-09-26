/**
 * Phoenix CRM — who is asking, and what they may do on which territory.
 *
 * The route handler has already checked the `phoenix_crm` permission (the matrix is gate one). This
 * is gate two, by identity and the organogram:
 *   - a territory's list and plan are changed by its own rep only;
 *   - a visit is entered by the territory's rep, or by a manager of the territory (their own single
 *     visit, or a double or chain visit with the rep);
 *   - requests are decided and plans approved by the territory's reviewer only (scope.ts); the SFE
 *     Manager can also return a plan; the system never approves;
 *   - everyone reads downward only; the Super Admin, the CEO and the SFE Manager read the company;
 *   - a line's reps and managers use the module from the line's opening day;
 *   - the Super Admin's own entries are ALWAYS test entries (owner, 2026-09-16: the Super Admin tries
 *     Add Visit and the report from day one; those try-outs never reach a real report), on any territory, open or not.
 */

import { canAccess, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { ApiError, forbiddenError, notFoundError } from "@/lib/http/api-errors";
import { currentCairoDateOnlyIso, formatPhoenixLongDate } from "@/lib/i18n/format";
import {
  heldManagerSeats,
  isTerritoryReviewer,
  managerChain,
  ownTerritories,
  personKey,
  TERRITORY_TIER,
  territoriesInScope,
  type OrgIndex,
  type OrgSeat,
  type ScopeBasis,
} from "@/lib/phoenix-crm/scope";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import type { UnplannedVisitStage } from "@/lib/phoenix-crm/unplanned-rules";
import { loadPhoenixCrmConfig, openLineCodes, type PhoenixCrmConfig } from "@/lib/phoenix-crm/server/settings";

export type PhoenixCrmViewer = {
  access: AccessContext;
  /** Upper case, the stored form. */
  hrId: string;
  role: PhoenixRole;
  isSuperAdmin: boolean;
  isSfeManager: boolean;
  basis: ScopeBasis;
  canCreate: boolean;
  canApprove: boolean;
  canUpdate: boolean;
  org: OrgIndex;
  config: PhoenixCrmConfig;
  cairoToday: string;
  openLines: ReadonlySet<string>;
  /** The territories the viewer holds as the rep, in open lines. */
  ownTerritories: OrgSeat[];
  /** The territories the viewer holds whose line has not opened. */
  waitingTerritories: OrgSeat[];
  /** The territories the viewer reads (real entries): open lines only, except for the Super Admin. */
  scopeTerritories: OrgSeat[];
  /**
   * The territories BENEATH him whose line has not opened — the manager's twin of
   * `waitingTerritories`, and the reason a District Manager on a closed line used to see nothing at
   * all and be told nothing. `scopeTerritories` is already filtered to open lines, so without this
   * set a manager whose whole district is waiting is indistinguishable from a stranger.
   */
  waitingScopeTerritories: OrgSeat[];
  managerSeats: OrgSeat[];
};

const COMPANY_ROLES = new Set<PhoenixRole>(["Super Admin", "CEO", "SFE Manager"]);

export async function resolvePhoenixCrmViewer(access: AccessContext): Promise<PhoenixCrmViewer> {
  const hrId = personKey(access.hrId);
  if (!hrId) throw forbiddenError("Your account is not linked to an HR record.");
  const [org, config, canCreate, canApprove, canUpdate] = await Promise.all([
    loadPhoenixCrmOrg(),
    loadPhoenixCrmConfig(),
    canAccess(access, "phoenix_crm", "create"),
    canAccess(access, "phoenix_crm", "approve"),
    canAccess(access, "phoenix_crm", "update"),
  ]);
  const cairoToday = currentCairoDateOnlyIso();
  const openLines = openLineCodes(config.lineRollout, cairoToday);
  const isSuperAdmin = access.role === "Super Admin";
  const basis: ScopeBasis = COMPANY_ROLES.has(access.role) ? "all" : "tree";
  const isOpen = (seat: OrgSeat) => Boolean(seat.lineCode && openLines.has(seat.lineCode));

  const held = ownTerritories(org, hrId);
  const scope = territoriesInScope(org, hrId, basis);
  return {
    access,
    hrId,
    role: access.role,
    isSuperAdmin,
    isSfeManager: access.role === "SFE Manager",
    basis,
    canCreate,
    canApprove,
    canUpdate,
    org,
    config,
    cairoToday,
    openLines,
    ownTerritories: held.filter(isOpen),
    waitingTerritories: held.filter((seat) => !isOpen(seat)),
    scopeTerritories: isSuperAdmin ? scope : scope.filter(isOpen),
    waitingScopeTerritories: isSuperAdmin ? [] : scope.filter((seat) => !isOpen(seat)),
    managerSeats: heldManagerSeats(org, hrId),
  };
}

export type TerritoryAccess = { seat: OrgSeat; isTest: boolean };

function territory(viewer: PhoenixCrmViewer, seatId: unknown): OrgSeat {
  const seat = typeof seatId === "string" ? viewer.org.seats.get(seatId.trim()) : undefined;
  if (!seat || seat.tier !== TERRITORY_TIER) throw notFoundError("This territory is not in the organogram. Reload the page.");
  return seat;
}

function superAdminTestOnly(): ApiError {
  return forbiddenError("The Super Admin's entries are test entries. Switch on test mode to try the module.");
}

/** The opening day of a seat's line: "Phoenix CRM opens for Pedia on 19 September 2026." */
export function lineOpeningText(viewer: PhoenixCrmViewer, seat: Pick<OrgSeat, "lineCode" | "lineName">): string {
  const opensOn = viewer.config.lineRollout.find((entry) => entry.lineCode === seat.lineCode)?.opensOn ?? null;
  return opensOn && opensOn > viewer.cairoToday
    ? `Phoenix CRM opens for ${seat.lineName ?? "your line"} on ${formatPhoenixLongDate(opensOn)}.`
    : `Phoenix CRM is not open for ${seat.lineName ?? "your line"} yet.`;
}

function lineNotOpen(viewer: PhoenixCrmViewer, seat: OrgSeat): ApiError {
  return forbiddenError(lineOpeningText(viewer, seat));
}

/** Reading a territory. Test entries are the Super Admin's view only. */
export function territoryForRead(viewer: PhoenixCrmViewer, seatId: unknown, test: boolean): TerritoryAccess {
  const seat = territory(viewer, seatId);
  if (test) {
    if (!viewer.isSuperAdmin) throw forbiddenError("Test entries are the Super Admin's.");
    return { seat, isTest: true };
  }
  if (viewer.scopeTerritories.some((entry) => entry.seatId === seat.seatId)) return { seat, isTest: false };
  if (viewer.waitingTerritories.some((entry) => entry.seatId === seat.seatId)) throw lineNotOpen(viewer, seat);
  throw forbiddenError("This territory is outside your scope.");
}

/** Changing a territory's list or plan: its own rep; the Super Admin in test mode. */
export function territoryForRepWrite(viewer: PhoenixCrmViewer, seatId: unknown, test: boolean): TerritoryAccess {
  const seat = territory(viewer, seatId);
  if (viewer.isSuperAdmin) {
    if (!test) throw superAdminTestOnly();
    return { seat, isTest: true };
  }
  if (test) throw forbiddenError("Test entries are the Super Admin's.");
  if (!viewer.canCreate) throw forbiddenError("Your role cannot change a customer list or a plan.");
  if (viewer.ownTerritories.some((entry) => entry.seatId === seat.seatId)) return { seat, isTest: false };
  if (viewer.waitingTerritories.some((entry) => entry.seatId === seat.seatId)) throw lineNotOpen(viewer, seat);
  throw forbiddenError("Only the territory's rep changes its list and plan.");
}

/** Entering a visit: the territory's rep, a manager of the territory, or the Super Admin in test mode. */
export function territoryForVisit(
  viewer: PhoenixCrmViewer,
  seatId: unknown,
  test: boolean,
): TerritoryAccess & { enteredAs: "rep" | "manager" } {
  const seat = territory(viewer, seatId);
  if (viewer.isSuperAdmin) {
    if (!test) throw superAdminTestOnly();
    return { seat, isTest: true, enteredAs: "rep" };
  }
  if (test) throw forbiddenError("Test entries are the Super Admin's.");
  if (!viewer.canCreate) throw forbiddenError("Your role cannot enter visits.");
  if (viewer.ownTerritories.some((entry) => entry.seatId === seat.seatId)) return { seat, isTest: false, enteredAs: "rep" };
  const inScope = viewer.scopeTerritories.some((entry) => entry.seatId === seat.seatId);
  if (inScope && managerChain(viewer.org, seat.seatId).some((member) => member.hrId === viewer.hrId)) {
    return { seat, isTest: false, enteredAs: "manager" };
  }
  if (viewer.waitingTerritories.some((entry) => entry.seatId === seat.seatId)) throw lineNotOpen(viewer, seat);
  throw forbiddenError("Only the territory's rep or one of its managers enters its visits.");
}

/** Deciding a request or approving a plan: the territory's reviewer; the Super Admin on test entries. */
export function assertReviewer(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): void {
  if (isTest) {
    if (!viewer.isSuperAdmin) throw forbiddenError("Test entries are the Super Admin's.");
    return;
  }
  if (viewer.isSuperAdmin) throw superAdminTestOnly();
  if (!viewer.canApprove) throw forbiddenError("Your role cannot decide for a territory.");
  if (!isTerritoryReviewer(viewer.org, seat.seatId, viewer.hrId)) {
    throw forbiddenError("Only the territory's reviewing manager decides this.");
  }
}

/** Returning a plan: the reviewer or the SFE Manager; the Super Admin on test entries. */
export function assertCanReturnPlan(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): "reviewer" | "sfe" {
  if (!isTest && viewer.isSfeManager && viewer.canApprove) {
    if (!viewer.scopeTerritories.some((entry) => entry.seatId === seat.seatId)) {
      throw forbiddenError("This territory is outside your scope.");
    }
    return "sfe";
  }
  assertReviewer(viewer, seat, isTest);
  return "reviewer";
}

// ── The same rules as answers, for screens (which button to show). Saves still assert. ─────────

/** The twin of territoryForRepWrite: the viewer changes this territory's list and plan. */
/**
 * The viewer reads a report ABOUT A TEAM rather than about himself.
 *
 * One predicate with three readers now — the place-vs-actual report, the exceptions board, and the
 * daily digest's recipient test — because they are the same question and a second copy of it would
 * drift. A medical rep is deliberately NOT in it: the owner ruled on 2026-09-26 that the comparison
 * ACROSS a team is the DM's, the SFE's, the NSM's and the Super Admin's, while a rep keeps every
 * figure about his own work, including the polite distance line on his own visit.
 */
export function readsTeamReports(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin || viewer.isSfeManager || viewer.basis === "all" || viewer.managerSeats.length > 0;
}

export function canWriteAsRep(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): boolean {
  if (isTest) return viewer.isSuperAdmin;
  return !viewer.isSuperAdmin && viewer.canCreate && viewer.ownTerritories.some((entry) => entry.seatId === seat.seatId);
}

/** The twin of assertReviewer: the viewer decides this territory's requests and approves its plans. */
export function canReviewTerritory(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): boolean {
  if (isTest) return viewer.isSuperAdmin;
  return !viewer.isSuperAdmin && viewer.canApprove && isTerritoryReviewer(viewer.org, seat.seatId, viewer.hrId);
}

/** The twin of assertCanReturnPlan. */
export function canReturnTerritoryPlan(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): boolean {
  if (!isTest && viewer.isSfeManager && viewer.canApprove) return viewer.scopeTerritories.some((entry) => entry.seatId === seat.seatId);
  return canReviewTerritory(viewer, seat, isTest);
}

// ── An off-plan visit: the manager stage, then the SFE stage ───────────────────────────────────

/**
 * Whether the viewer may decide THIS stage of an off-plan visit (owner, 2026-09-26: the direct manager
 * first, then the SFE).
 *
 * The two stages are two different authorities, which is why this is not one chain walk: the manager
 * stage is the territory's own reviewer, exactly as a grade or drop request is, while the SFE Manager
 * holds no sales seat at all and so can never appear in `managerChain`. The manager's manager reads the
 * queue through his ordinary scope and decides nothing — scope is sight, not authority.
 */
export function canDecideUnplannedVisit(
  viewer: PhoenixCrmViewer,
  seat: OrgSeat,
  isTest: boolean,
  stage: UnplannedVisitStage,
): boolean {
  if (isTest) return viewer.isSuperAdmin;
  if (viewer.isSuperAdmin || !viewer.canApprove) return false;
  if (stage === "sfe") return viewer.isSfeManager && viewer.scopeTerritories.some((entry) => entry.seatId === seat.seatId);
  return isTerritoryReviewer(viewer.org, seat.seatId, viewer.hrId);
}

/** The assert twin. The stage comes from the row's own status, never from the phone. */
export function assertUnplannedVisitApprover(
  viewer: PhoenixCrmViewer,
  seat: OrgSeat,
  isTest: boolean,
  stage: UnplannedVisitStage,
): void {
  if (isTest) {
    if (!viewer.isSuperAdmin) throw forbiddenError("Test entries are the Super Admin's.");
    return;
  }
  if (viewer.isSuperAdmin) throw superAdminTestOnly();
  if (!viewer.canApprove) throw forbiddenError("Your role cannot decide for a territory.");
  if (canDecideUnplannedVisit(viewer, seat, isTest, stage)) return;
  throw forbiddenError(
    stage === "sfe"
      ? "This visit is waiting for SFE, and only the SFE Manager decides that step."
      : "Only the territory's reviewing manager decides this step.",
  );
}

/** Settings: the Super Admin. */
export function assertSettingsWriter(viewer: PhoenixCrmViewer): void {
  if (!viewer.isSuperAdmin || !viewer.canUpdate) throw forbiddenError("Only the Super Admin changes Phoenix CRM settings.");
}

/** The body's test flag, read strictly: only a literal true switches test mode on. */
export function readTestFlag(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}
