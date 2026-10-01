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
 *     Add Visit and the report from day one; those try-outs never reach a real report), on any territory, open or not —
 *     with THREE real-data exceptions, each its own gate below: moving a validated place
 *     (`canMovePlaces`), entering a record a rep MISSED, for that rep (`territoryForMissedRecord`), and
 *     acknowledging, as HR, a rep's request to edit a sent week (`canAcknowledgePlanEdits`);
 *   - a TEST ACCOUNT (owner, 2026-09-27; src/lib/auth/test-persona.ts) is the employee it mirrors, with
 *     that person's own territories, scope and authority — but every read and every save it makes is in
 *     the test world, always, whatever flag the screen sends. It decides test entries only, as the
 *     person it mirrors would decide real ones, so a test rep and a test manager work a plan through
 *     together without either ever touching a real row.
 */

import { isSamePerson } from "@/lib/auth/identity-aliases";
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
import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import { PLAN_EDIT_ACKNOWLEDGER_HR_ID, type PlanEditStage } from "@/lib/phoenix-crm/plan-edit-rules";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import type { PhoenixCrmRequestStage } from "@/lib/phoenix-crm/types";
import type { UnplannedVisitStage } from "@/lib/phoenix-crm/unplanned-rules";
import { loadPhoenixCrmConfig, openLineCodes, type PhoenixCrmConfig } from "@/lib/phoenix-crm/server/settings";

export type PhoenixCrmViewer = {
  access: AccessContext;
  /** Upper case, the stored form. */
  hrId: string;
  role: PhoenixRole;
  isSuperAdmin: boolean;
  isSfeManager: boolean;
  /** A test account: the mirrored person's reach, and the test world only. */
  isTestPersona: boolean;
  basis: ScopeBasis;
  canCreate: boolean;
  canApprove: boolean;
  canUpdate: boolean;
  org: OrgIndex;
  config: PhoenixCrmConfig;
  cairoToday: string;
  /**
   * The VISIT day: the Cairo date of now minus two hours (owner, 2026-09-29 — "the visits of today
   * are entered today, maximum 2 AM"). Today, the visit form, planned-or-not and day activities read
   * this; plans, reports and line openings keep the calendar day above.
   */
  visitDay: string;
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
    isTestPersona: Boolean(access.testPersona),
    basis,
    canCreate,
    canApprove,
    canUpdate,
    org,
    config,
    cairoToday,
    visitDay: cairoBusinessDay(new Date()),
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

/** A test account touches test entries only — a real one is refused whatever it would have been. */
function testAccountRealEntry(): ApiError {
  return forbiddenError("This is a test login: it works on test entries only. Real entries stay as they are.");
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
  if (viewer.isTestPersona) {
    // The mirrored person's reach, in the test world whatever the screen asked for.
    if (viewer.scopeTerritories.some((entry) => entry.seatId === seat.seatId)) return { seat, isTest: true };
    if (viewer.waitingTerritories.some((entry) => entry.seatId === seat.seatId)) throw lineNotOpen(viewer, seat);
    throw forbiddenError("This territory is outside your scope.");
  }
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
  if (test && !viewer.isTestPersona) throw forbiddenError("Test entries are the Super Admin's.");
  if (!viewer.canCreate) throw forbiddenError("Your role cannot change a customer list or a plan.");
  // A test account's own territory is the mirrored rep's, and what it changes there is a test entry.
  if (viewer.ownTerritories.some((entry) => entry.seatId === seat.seatId)) return { seat, isTest: viewer.isTestPersona };
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
  if (test && !viewer.isTestPersona) throw forbiddenError("Test entries are the Super Admin's.");
  if (!viewer.canCreate) throw forbiddenError("Your role cannot enter visits.");
  const isTest = viewer.isTestPersona;
  if (viewer.ownTerritories.some((entry) => entry.seatId === seat.seatId)) return { seat, isTest, enteredAs: "rep" };
  const inScope = viewer.scopeTerritories.some((entry) => entry.seatId === seat.seatId);
  if (inScope && managerChain(viewer.org, seat.seatId).some((member) => member.hrId === viewer.hrId)) {
    return { seat, isTest, enteredAs: "manager" };
  }
  if (viewer.waitingTerritories.some((entry) => entry.seatId === seat.seatId)) throw lineNotOpen(viewer, seat);
  throw forbiddenError("Only the territory's rep or one of its managers enters its visits.");
}

/** Deciding a request or approving a plan: the territory's reviewer; the Super Admin on test entries. */
export function assertReviewer(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): void {
  if (viewer.isTestPersona) {
    if (!isTest) throw testAccountRealEntry();
    if (!viewer.canApprove) throw forbiddenError("Your role cannot decide for a territory.");
    if (!isTerritoryReviewer(viewer.org, seat.seatId, viewer.hrId)) throw forbiddenError("Only the territory's reviewing manager decides this.");
    return;
  }
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
 * figure about his own work. Since 2026-09-29 that no longer includes any distance on his own visit:
 * the owner removed the polite "Take care" line — the rep never sees a distance, a flag or a check
 * (see `isLocationBlind`).
 */
export function readsTeamReports(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin || viewer.isSfeManager || viewer.basis === "all" || viewer.managerSeats.length > 0;
}

/**
 * Who opens the CALENDAR — a manager sees his team, and a medical rep sees HIMSELF.
 *
 * 🔴 ITS OWN PREDICATE, AND WIDENING `readsTeamReports` INSTEAD WOULD HAVE BEEN THE BUG. The owner
 * asked for this on 2026-10-01 — *"I want the medical rep to have also his team calendar seeing
 * only himself"* — and `readsTeamReports` is shared by the place-vs-actual report, the exceptions
 * board, the brick report, the adoption board and the daily digest's recipient test. One character
 * there would have handed a rep five boards that compare him with other people, which is exactly
 * what Golden rule #1 keeps off his screens. So the calendar leaves that predicate and gets this
 * one, and the two now answer different questions on purpose.
 *
 * 🔴 IT IS NOT A HOLE IN GOLDEN RULE #1, because of WHOSE WORK IT IS. His own month — the days he
 * worked, AM and PM apart, and the days he was away — is his own work, like his plan and his
 * targets, and the boundary the owner drew on 2026-09-26 is that anything judging his honesty is
 * never his. Nothing on this grid judges: there is no distance, no flag, no accuracy, no integrity
 * signal, and the day a cell opens is the same blinded day view he already reaches from Visits.
 * The SCOPING is what keeps it his: `loadTeamCalendar` builds its rows from `scopeTerritories`,
 * which for a rep holds his own seat and nobody else's, so he cannot be shown a colleague's month
 * even by asking for one.
 *
 * A viewer with no territory in scope is refused rather than shown an empty grid: an empty month is
 * indistinguishable from a month with no work in it, and the tab is hidden for the same reason.
 */
export function readsCalendar(viewer: PhoenixCrmViewer): boolean {
  if (viewer.isSuperAdmin) return true;
  if (viewer.scopeTerritories.length === 0) return false;
  return readsTeamReports(viewer) || viewer.ownTerritories.length > 0;
}

export function canWriteAsRep(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): boolean {
  if (viewer.isTestPersona) return isTest && viewer.canCreate && viewer.ownTerritories.some((entry) => entry.seatId === seat.seatId);
  if (isTest) return viewer.isSuperAdmin;
  return !viewer.isSuperAdmin && viewer.canCreate && viewer.ownTerritories.some((entry) => entry.seatId === seat.seatId);
}

/** The twin of assertReviewer: the viewer decides this territory's requests and approves its plans. */
export function canReviewTerritory(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): boolean {
  if (viewer.isTestPersona) return isTest && viewer.canApprove && isTerritoryReviewer(viewer.org, seat.seatId, viewer.hrId);
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
  // A test account decides the MANAGER step of a test visit as the person it mirrors. The SFE step is
  // the SFE Manager's, an admin-shell seat no test account can hold — the Super Admin takes it in test mode.
  if (viewer.isTestPersona) {
    return isTest && stage !== "sfe" && viewer.canApprove && isTerritoryReviewer(viewer.org, seat.seatId, viewer.hrId);
  }
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
  if (viewer.isTestPersona) {
    if (!isTest) throw testAccountRealEntry();
    if (canDecideUnplannedVisit(viewer, seat, isTest, stage)) return;
    throw forbiddenError(
      stage === "sfe"
        ? "This visit is waiting for SFE, and only the SFE Manager decides that step."
        : "Only the territory's reviewing manager decides this step.",
    );
  }
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

// ── Asking to edit a sent week: the manager, then SFE, then HR ─────────────────────────────────

/**
 * HR's step on a request to edit a week — Omar Gawish himself (owner, 2026-10-01: "district manager
 * approval, then SFE, then HR acknowledgement", and HR is him). Compared as a PERSON, never as a raw
 * id: he also signs in as the system console, which is the same human (identity-aliases.ts).
 *
 * 🔴 One of the Super Admin's REAL-DATA acts in Phoenix CRM, beside `canMovePlaces` and
 * `territoryForMissedRecord` — everywhere else his entries are test entries (owner, 2026-09-16). It
 * changes no figure: an acknowledgement only opens a week that a district manager and SFE already
 * agreed may change, and the rep still sends it again for the ordinary approval.
 */
export function canAcknowledgePlanEdits(viewer: PhoenixCrmViewer): boolean {
  return !viewer.isTestPersona && viewer.isSuperAdmin && viewer.canApprove && isSamePerson(viewer.hrId, PLAN_EDIT_ACKNOWLEDGER_HR_ID);
}

/**
 * Whether the viewer may act at THIS step of a request to edit a week. `stage` is the row's own step,
 * never the phone's. The manager's and SFE's steps are the same two authorities an off-plan visit runs
 * through (`canDecideUnplannedVisit`); HR's is `canAcknowledgePlanEdits`. In the test world the Super
 * Admin takes every step, and a test account takes the manager's as the person it mirrors.
 */
export function canDecidePlanEdit(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean, stage: PlanEditStage): boolean {
  if (viewer.isTestPersona) {
    return isTest && stage === "manager" && viewer.canApprove && isTerritoryReviewer(viewer.org, seat.seatId, viewer.hrId);
  }
  if (isTest) return viewer.isSuperAdmin;
  if (stage === "hr") return canAcknowledgePlanEdits(viewer);
  if (viewer.isSuperAdmin || !viewer.canApprove) return false;
  if (stage === "sfe") return viewer.isSfeManager && viewer.scopeTerritories.some((entry) => entry.seatId === seat.seatId);
  return isTerritoryReviewer(viewer.org, seat.seatId, viewer.hrId);
}

/** The assert twin. The stage comes from the row's own status, never from the phone. */
export function assertPlanEditApprover(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean, stage: PlanEditStage): void {
  if (viewer.isTestPersona && !isTest) throw testAccountRealEntry();
  if (isTest && !viewer.isSuperAdmin && !viewer.isTestPersona) throw forbiddenError("Test entries are the Super Admin's.");
  if (canDecidePlanEdit(viewer, seat, isTest, stage)) return;
  if (!isTest && viewer.isSuperAdmin && stage !== "hr") throw superAdminTestOnly();
  throw forbiddenError(
    stage === "hr"
      ? "This request is waiting for HR's acknowledgement."
      : stage === "sfe"
        ? "This request is waiting for SFE, and only the SFE Manager decides that step."
        : "Only the territory's district manager decides this step.",
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

/**
 * The mode a read across territories runs in: always test for a test account, whatever the screen
 * sent; the Super Admin's own choice; and refused for anyone else who asks for test entries.
 */
export function testModeFor(viewer: PhoenixCrmViewer, flag: unknown): boolean {
  if (viewer.isTestPersona) return true;
  const isTest = readTestFlag(flag);
  if (isTest && !viewer.isSuperAdmin) throw forbiddenError("Test entries are the Super Admin's.");
  return isTest;
}

/**
 * The territories such a read covers. Only the Super Admin's test mode reaches every territory; a test
 * account reads exactly the scope of the person it mirrors, in the test world as in the real one.
 */
export function testReadSeats(viewer: PhoenixCrmViewer, isTest: boolean, scope: OrgSeat[]): OrgSeat[] {
  return isTest && viewer.isSuperAdmin ? viewer.org.territories : scope;
}

/**
 * Whether a report carries test entries. A test account's always do — its own work is test work, read
 * beside the real entries of the people it mirrors; the Super Admin's only when he ticks the box.
 */
export function reportIncludesTest(viewer: PhoenixCrmViewer, flag: unknown): boolean {
  return viewer.isTestPersona || (viewer.isSuperAdmin && readTestFlag(flag));
}

// ── The rep's own screens are blind to location ────────────────────────────────────────────────

/**
 * Whether the viewer is looking at his OWN territory's visits as its rep — and so must see no distance,
 * no flag and no check of any kind (Golden Rule #1, made absolute by the owner on 2026-09-29, when he
 * removed the polite "Take care — about X from the saved place" line from the rep's own visit).
 *
 * The territory's managers, the SFE Manager and the Super Admin keep every measurement; a test account
 * that mirrors a rep is blind exactly as that rep would be.
 */
export function isLocationBlind(viewer: PhoenixCrmViewer, seat: OrgSeat): boolean {
  if (viewer.isSuperAdmin || viewer.isSfeManager) return false;
  return viewer.ownTerritories.some((entry) => entry.seatId === seat.seatId);
}

// ── A list request: one step for a grade, the manager then SFE for everything else ─────────────

/**
 * Whether the viewer may decide THIS step of a list request (owner, 2026-09-29). `stage` is the row's
 * own stage, never the phone's: null for a grade change (the territory's reviewer alone), "manager"
 * for the first step of a drop, an add or a bring-back, "sfe" for the second — the same two
 * authorities an off-plan visit's approval runs through (`canDecideUnplannedVisit`).
 */
export function canDecideListRequest(
  viewer: PhoenixCrmViewer,
  seat: OrgSeat,
  isTest: boolean,
  stage: PhoenixCrmRequestStage | null,
): boolean {
  if (stage === null) return canReviewTerritory(viewer, seat, isTest);
  return canDecideUnplannedVisit(viewer, seat, isTest, stage);
}

export function assertListRequestApprover(
  viewer: PhoenixCrmViewer,
  seat: OrgSeat,
  isTest: boolean,
  stage: PhoenixCrmRequestStage | null,
): void {
  if (stage === null) {
    assertReviewer(viewer, seat, isTest);
    return;
  }
  if (viewer.isTestPersona) {
    if (!isTest) throw testAccountRealEntry();
    if (canDecideListRequest(viewer, seat, isTest, stage)) return;
    throw forbiddenError(
      stage === "sfe"
        ? "This request is waiting for SFE, and only the SFE Manager decides that step."
        : "Only the territory's reviewing manager decides this step.",
    );
  }
  if (isTest) {
    if (!viewer.isSuperAdmin) throw forbiddenError("Test entries are the Super Admin's.");
    return;
  }
  if (viewer.isSuperAdmin) throw superAdminTestOnly();
  if (!viewer.canApprove) throw forbiddenError("Your role cannot decide for a territory.");
  if (canDecideListRequest(viewer, seat, isTest, stage)) return;
  throw forbiddenError(
    stage === "sfe"
      ? "This request is waiting for SFE, and only the SFE Manager decides that step."
      : "Only the territory's reviewing manager decides this step.",
  );
}

// ── Moving a validated place: the Super Admin and the SFE Manager, nobody else ─────────────────

/**
 * Whether the viewer may MOVE a validated place (owner, 2026-09-29: "the location never changes,
 * ever — only the system administrator", widened by him the same day to the SFE Manager).
 *
 * 🔴 One of the THREE real-data writes the Super Admin makes in Phoenix CRM (the others are
 * `territoryForMissedRecord` and `canAcknowledgePlanEdits`). Everywhere else his own entries are test
 * entries (owner, 2026-09-16); a
 * place he moves is a real place, so the move carries a written reason and an audited event
 * (phoenix_crm_move_place). A test account never moves one.
 */
export function canMovePlaces(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): boolean {
  if (viewer.isTestPersona) return false;
  if (viewer.isSuperAdmin) return viewer.canUpdate;
  if (isTest) return false;
  return viewer.isSfeManager && viewer.canApprove && viewer.scopeTerritories.some((entry) => entry.seatId === seat.seatId);
}

export function assertPlaceMover(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): void {
  if (!canMovePlaces(viewer, seat, isTest)) {
    throw forbiddenError("A validated place is fixed. Only the Super Admin and the SFE Manager can move it.");
  }
}

// ── A record a rep missed: the Super Admin enters it for him ───────────────────────────────────

/**
 * Whether the viewer enters records a rep MISSED (owner, 2026-10-01: "the rep is responsible for all
 * his records, but if he missed a visit or a record, admin can enter it for him … for anyone, anytime,
 * anywhere"). The Super Admin, and only him: a test account never does, and neither does any other role.
 *
 * 🔴 The second of the Super Admin's three real-data writes (beside `canMovePlaces` and
 * `canAcknowledgePlanEdits`). With test mode on it
 * enters a test record, exactly like everything else he does in test mode; with it off the record is
 * real, for the real rep, and every screen marks it "Entered by the Super Admin".
 */
export function canEnterMissedRecords(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin && viewer.canUpdate && !viewer.isTestPersona;
}

/** The twin of `territoryForMissedRecord`, answered for a screen (which calendar cells open for him). */
export function canEnterMissedRecordOn(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): boolean {
  if (!canEnterMissedRecords(viewer) || seat.tier !== TERRITORY_TIER || !seat.occupantHrId) return false;
  return isTest || Boolean(seat.lineCode && viewer.openLines.has(seat.lineCode));
}

/**
 * The territory a missed record is entered on, and the rep it is entered FOR.
 *
 * A real record needs the territory's line to be open — a rep whose line has not opened has no Phoenix
 * CRM yet, so there is nothing he could have missed — and a test one reaches any territory, as every
 * test entry of his does. Either way the seat must have a rep: the record is HIS, and a vacant seat has
 * nobody to enter it for.
 */
export function territoryForMissedRecord(
  viewer: PhoenixCrmViewer,
  seatId: unknown,
  test: boolean,
): TerritoryAccess & { repHrId: string } {
  if (!canEnterMissedRecords(viewer)) throw forbiddenError("Only the Super Admin enters a record a rep missed.");
  const seat = territory(viewer, seatId);
  if (!test && !(seat.lineCode && viewer.openLines.has(seat.lineCode))) throw lineNotOpen(viewer, seat);
  if (!seat.occupantHrId) throw forbiddenError("This territory has no rep, so there is nobody to enter a record for.");
  return { seat, isTest: test, repHrId: seat.occupantHrId };
}

/**
 * The territory a visit the Super Admin ENTERED is removed from (owner, 2026-10-01: "add a way to remove
 * a missed visit I entered by mistake").
 *
 * The Super Admin alone, as for entering one — but WITHOUT the rep-and-open-line conditions: his own
 * mistake stays his to take back after the rep has left the seat or the line has been closed again.
 * Which visit may go is the database's to decide from the row itself (phoenix_crm_admin_remove_visit:
 * capture_source 'admin', and entered by him), so a rep's own visit can never be removed through here.
 */
export function territoryForMissedRecordRemoval(viewer: PhoenixCrmViewer, seatId: unknown, test: boolean): TerritoryAccess {
  if (!canEnterMissedRecords(viewer)) throw forbiddenError("Only the Super Admin removes a visit he entered.");
  return { seat: territory(viewer, seatId), isTest: test };
}
