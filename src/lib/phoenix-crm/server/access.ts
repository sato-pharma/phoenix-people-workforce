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
 *   - 🔒 THE SUPER ADMIN'S TEST WORLD IS RETIRED (owner, 2026-10-03: *"the test in the phoenix crm is
 *     now irrelevant, u can fully retire it"*), so he READS the field force's own entries everywhere
 *     and WRITES through the three real-data gates he always had and nothing else: moving a validated
 *     place (`canMovePlaces`), entering a record a rep MISSED, for that rep
 *     (`territoryForMissedRecord`), and, as the Administrator, APPROVING, DECLINING or RETURNING a
 *     manager's or SFE's decision (`canAdminister` — never a step anything waits at). The `test` flag a screen sends is read and dropped on a READ and
 *     the write is refused by name (`superAdminHasNoFieldWrite`) — the earlier rule, that his every
 *     entry was a test entry (owner, 2026-09-16), is history and not guidance;
 *   - a TEST ACCOUNT (owner, 2026-09-27; src/lib/auth/test-persona.ts) is the employee it mirrors, with
 *     that person's own territories, scope and authority — but every read and every save it makes is in
 *     the test world, always, whatever flag the screen sends. It decides test entries only, as the
 *     person it mirrors would decide real ones, so a test rep and a test manager work a plan through
 *     together without either ever touching a real row.
 */

import { cache } from "react";

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
  territoryReviewer,
  type OrgIndex,
  type OrgSeat,
  type ScopeBasis,
} from "@/lib/phoenix-crm/scope";
import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import { PRODUCT_MANAGER_PLAN_ROLES } from "@/lib/phoenix-crm/manager-plan-rules";
import { loadProductManagerRoster, type ProductManagerPlanner } from "@/lib/phoenix-crm/server/manager-plan-writers";
import { PHOENIX_CRM_ADMINISTRATOR_HR_ID, type PlanEditStage } from "@/lib/phoenix-crm/plan-edit-rules";
import { isVisitAskAskableRole } from "@/lib/phoenix-crm/visit-ask-rules";
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
  /**
   * He plans a manager's week as a product manager (owner, 2026-10-17): the Product Manager or Group
   * Product Manager role, held by a current employee. A product manager sits on no seat, so the organogram
   * cannot answer this.
   */
  plansAsProductManager: boolean;
  /** Every product manager who plans a week here, with the manager his HR record names — the readers' half. */
  productManagers: ReadonlyArray<ProductManagerPlanner>;
};

const COMPANY_ROLES = new Set<PhoenixRole>(["Super Admin", "CEO", "SFE Manager"]);

/**
 * The viewer, built once per page render (Phoenix CRM performance audit, 2026-10-16). A portal page
 * asked twice — the shell's sidebar entries and the page itself — and paid the organogram, the config
 * and three permission reads both times. React's `cache` keys on the request's one `AccessContext`
 * (the page resolver is itself cached, so both callers hold the same object). A route handler has no
 * render, so there `cache` simply calls through and every API request resolves its own viewer.
 */
export const resolvePhoenixCrmViewer = cache(buildPhoenixCrmViewer);

async function buildPhoenixCrmViewer(access: AccessContext): Promise<PhoenixCrmViewer> {
  const hrId = personKey(access.hrId);
  if (!hrId) throw forbiddenError("Your account is not linked to an HR record.");
  const [org, config, canCreate, canApprove, canUpdate, productManagers] = await Promise.all([
    loadPhoenixCrmOrg(),
    loadPhoenixCrmConfig(),
    canAccess(access, "phoenix_crm", "create"),
    canAccess(access, "phoenix_crm", "approve"),
    canAccess(access, "phoenix_crm", "update"),
    loadProductManagerRoster(),
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
    // A test account mirrors a current product manager, so its role is enough; a real login also needs a
    // current HR record — a resigned product manager's login can still be active.
    plansAsProductManager:
      PRODUCT_MANAGER_PLAN_ROLES.has(access.role) && (Boolean(access.testPersona) || productManagers.some((entry) => entry.hrId === hrId)),
    productManagers,
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

/**
 * 🔒 THE SUPER ADMIN'S TEST WORLD IS RETIRED — owner, 2026-10-03: *"the test in the phoenix crm is now
 * irrelevant, u can fully retire it"*.
 *
 * It was the ONE thing he could write with in this module, and writing it was always a try-out: a
 * parallel world of rows nothing real ever read. With the field force live there is nothing left to
 * try, so the flag every screen used to send is READ AND DROPPED (see `territoryForRead`) and a write
 * he used to make as a test is refused — with the one real path he has always had named in the
 * refusal, because a message that said "switch on test mode" would now point at a control that no
 * longer exists.
 *
 * 🔴 A `TEST-` LOGIN IS NOT AFFECTED. Its world is forced on by `isTestPersona` whatever the screen
 * sends, so the reps' own test logins are untouched (the same message put them out of scope:
 * *"without touching the reps account"*).
 */
export function superAdminHasNoFieldWrite(what: string): ApiError {
  return forbiddenError(
    `The Super Admin does not ${what}. Open the rep's day from Team or the Calendar and use "Record a missed visit" — that is a real entry, for a rep who forgot to log one.`,
  );
}

/**
 * The same retirement on the DECIDING side. A plan approval, a list request, an off-plan visit and a
 * request to edit a sent week each belong to the territory's own chain — the district manager, then
 * SFE — and the Super Admin took every one of those steps IN THE TEST WORLD, never on a real row. So
 * the refusal he reads now is about whose decision it is, and must not point at "Record a missed
 * visit", which answers a different question.
 */
function superAdminDoesNotDecide(): ApiError {
  return forbiddenError(
    "A decision belongs to the territory's own manager chain — the district manager, then SFE. Reopen or return the row if it is stuck; the decision itself is theirs.",
  );
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

/**
 * Reading a territory — the field force's own entries, for everyone in whose scope it sits.
 *
 * 🔒 A `test` FLAG FROM ANYBODY BUT A TEST- LOGIN IS READ AND DROPPED, NOT REFUSED (the retirement
 * above). Refusing it would make the retirement's first visible effect a 403 on every read made by a
 * browser tab that happened to be open across the deploy, and by every bookmark carrying `test=1`.
 * Dropping it answers the same page with the real entries, which is what the retirement means.
 */
export function territoryForRead(viewer: PhoenixCrmViewer, seatId: unknown, test: boolean): TerritoryAccess {
  const seat = territory(viewer, seatId);
  if (viewer.isTestPersona) {
    // The mirrored person's reach, in the test world whatever the screen asked for.
    if (viewer.scopeTerritories.some((entry) => entry.seatId === seat.seatId)) return { seat, isTest: true };
    if (viewer.waitingTerritories.some((entry) => entry.seatId === seat.seatId)) throw lineNotOpen(viewer, seat);
    throw forbiddenError("This territory is outside your scope.");
  }
  void test;
  if (viewer.scopeTerritories.some((entry) => entry.seatId === seat.seatId)) return { seat, isTest: false };
  if (viewer.waitingTerritories.some((entry) => entry.seatId === seat.seatId)) throw lineNotOpen(viewer, seat);
  throw forbiddenError("This territory is outside your scope.");
}

/** Changing a territory's list or plan: its own rep, and nobody else since test mode was retired. */
export function territoryForRepWrite(viewer: PhoenixCrmViewer, seatId: unknown, test: boolean): TerritoryAccess {
  const seat = territory(viewer, seatId);
  void test;
  if (viewer.isSuperAdmin) throw superAdminHasNoFieldWrite("change a rep's customer list or their plan");
  if (!viewer.canCreate) throw forbiddenError("Your role cannot change a customer list or a plan.");
  // A test account's own territory is the mirrored rep's, and what it changes there is a test entry.
  if (viewer.ownTerritories.some((entry) => entry.seatId === seat.seatId)) return { seat, isTest: viewer.isTestPersona };
  if (viewer.waitingTerritories.some((entry) => entry.seatId === seat.seatId)) throw lineNotOpen(viewer, seat);
  throw forbiddenError("Only the territory's rep changes its list and plan.");
}

/**
 * VALIDATING a carried-over customer: the territory's rep, or a MANAGER of it (owner's pick,
 * 2026-10-02 — "district managers can validate").
 *
 * The rep stays primary; this adds his managers beside him, and it works on a VACANT territory too,
 * which is the case nothing else covers — a seat with no rep has a reference list nobody can work
 * through. The manager test is the one `territoryForVisit` already uses: in scope AND in this
 * territory's own manager chain, so scope runs downward only and a peer's territory is refused.
 *
 * 🔴 IT IS NOT `territoryForRepWrite` WIDENED, DELIBERATELY. That gate also guards the plan, the day
 * activities, the forecast and every list change — a drop, a grade, an add, the hours — and those are
 * the rep's own work. And a manager is only allowed the `reference` mode (`validatedAs` says which he
 * is): "Add new customer" and an out-of-list validation FILE A REQUEST whose first step is the
 * territory's reviewer, so a manager doing both would be proposing and approving in one act.
 */
export function territoryForValidation(
  viewer: PhoenixCrmViewer,
  seatId: unknown,
  test: boolean,
): TerritoryAccess & { validatedAs: "rep" | "manager" } {
  const seat = territory(viewer, seatId);
  void test;
  if (viewer.isSuperAdmin) throw superAdminHasNoFieldWrite("validate a customer for a rep");
  if (!viewer.canCreate) throw forbiddenError("Your role cannot validate a customer.");
  const isTest = viewer.isTestPersona;
  if (viewer.ownTerritories.some((entry) => entry.seatId === seat.seatId)) return { seat, isTest, validatedAs: "rep" };
  if (isManagerOfTerritory(viewer, seat)) return { seat, isTest, validatedAs: "manager" };
  if (viewer.waitingTerritories.some((entry) => entry.seatId === seat.seatId)) throw lineNotOpen(viewer, seat);
  throw forbiddenError("Only the territory's rep or one of its managers validates its customers.");
}

/**
 * In scope AND in this territory's own manager chain — "a manager of this territory", downward only.
 * The chain is the organogram's, so a vacant district seat passes the territory to the next manager up,
 * exactly as every other decision about it is routed.
 */
function isManagerOfTerritory(viewer: PhoenixCrmViewer, seat: OrgSeat): boolean {
  if (!viewer.scopeTerritories.some((entry) => entry.seatId === seat.seatId)) return false;
  return managerChain(viewer.org, seat.seatId).some((member) => member.hrId === viewer.hrId);
}

/**
 * The twin of {@link territoryForValidation} for a screen: whether the viewer may validate a
 * carried-over customer here. True for the rep (where `canWriteAsRep` is) and for a manager of the
 * territory; the rest of the list screen stays on `canWriteAsRep`.
 */
export function canValidateReference(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): boolean {
  if (canWriteAsRep(viewer, seat, isTest)) return true;
  if (viewer.isTestPersona) return isTest && viewer.canCreate && isManagerOfTerritory(viewer, seat);
  if (isTest) return false;
  return !viewer.isSuperAdmin && viewer.canCreate && isManagerOfTerritory(viewer, seat);
}

/**
 * Entering a visit: the territory's rep, or a manager of the territory (his own single visit, or a
 * double or chain visit with the rep). The Super Admin reached this in test mode, which is retired —
 * his one real path is "Record a missed visit", which has its own gate (`territoryForMissedRecord`).
 */
export function territoryForVisit(
  viewer: PhoenixCrmViewer,
  seatId: unknown,
  test: boolean,
): TerritoryAccess & { enteredAs: "rep" | "manager" } {
  const seat = territory(viewer, seatId);
  void test;
  if (viewer.isSuperAdmin) throw superAdminHasNoFieldWrite("enter a rep's visit");
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
  if (viewer.isSuperAdmin) throw superAdminDoesNotDecide();
  if (!viewer.canApprove) throw forbiddenError("Your role cannot decide for a territory.");
  if (!isTerritoryReviewer(viewer.org, seat.seatId, viewer.hrId)) {
    throw forbiddenError("Only the territory's reviewing manager decides this.");
  }
}

/**
 * Returning a plan: the reviewer or the SFE Manager; the Super Admin on test entries — and the
 * Administrator on any real one (owner, 2026-10-08: he may return with a comment, and is never a step).
 */
export function assertCanReturnPlan(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): "reviewer" | "sfe" | "administrator" {
  if (canOverrideDecision(viewer, isTest)) return "administrator";
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

/**
 * The product and marketing managers, who read ONE Phoenix CRM report: what the field heard about their
 * own products, company-wide (owner, 2026-10-02 — "product managers and marketing see it too, for their
 * own products, company-wide, never per rep and never any honesty figure").
 *
 * Read off the APP ROLE, as every marketing rule in Phoenix is (`productOwnerRoles` and
 * `companyMarketingRoles` in the marketing-requests module) — never off a job-title parse, which
 * job-function.ts forbids for anything that grants access. For every live holder the two agree: the
 * Group Product Manager, the Marketing Manager and both Product Managers each hold the app role their
 * HR job title names.
 *
 * 🔴 THEY HOLD NO SEAT IN THE SALES ORGANOGRAM, so `scopeTerritories` is empty for them and every other
 * section, list, plan, visit and photo route answers them with nothing or a refusal — the same
 * position the Training Manager has held since 2026-09-22. This predicate opens the module's door and
 * the Reports tab to them (overview.ts, page.ts) and nothing else; the report itself narrows them to
 * their own products (`loadFieldHeardReport`), and never shows them an area, a territory or a rep.
 */
const FIELD_HEARD_PRODUCT_ROLES = new Set<PhoenixRole>(["Product Manager", "Group Product Manager", "Marketing Manager"]);

export function readsFieldHeardByProduct(viewer: Pick<PhoenixCrmViewer, "role">): boolean {
  return FIELD_HEARD_PRODUCT_ROLES.has(viewer.role);
}

/**
 * 🔒 THE DOUBLE VISITOR READS THE VISITS HE WAS ON — and for a product manager that is a report about
 * HIMSELF and nobody else (owner, 2026-10-07: *"nada abdullah yesterday submitted double visits with
 * ahmed sharaf those visists are not appearing in his data also check all double visists are
 * appearing to the double visitor"*).
 *
 * A manager already reads his own double and chain visits on "Double and chain visits", because the
 * rep's seat is inside his downward scope. A PRODUCT manager holds no seat in the sales organogram at
 * all, so `scopeTerritories` is empty for him and every visit, team, plan and report route answered
 * him with nothing — the visits he personally rode existed in his column of the row and on no screen
 * he could open. Measured on production the day he said so: 11 visits, 8 of them Nada Abdullah's with
 * Ahmed SharafEldeen on 2026-10-06.
 *
 * 🔴 IT IS HIS OWN ROW AND NOTHING ELSE — the loader passes HIS hr id alone, so this is not a widened
 * team board and it adds no line, area or rep comparison to the one report the 2026-10-02 ruling gave
 * him. The team's gate is asked FIRST, so a product manager who also held a manager seat would read
 * the full board as a manager instead.
 */
export function readsOwnRideAlongs(viewer: PhoenixCrmViewer): boolean {
  return !readsTeamReports(viewer) && readsFieldHeardByProduct(viewer);
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
  if (canOverrideDecision(viewer, isTest)) return true;
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
  if (viewer.isSuperAdmin) throw superAdminDoesNotDecide();
  if (!viewer.canApprove) throw forbiddenError("Your role cannot decide for a territory.");
  if (canDecideUnplannedVisit(viewer, seat, isTest, stage)) return;
  throw forbiddenError(
    stage === "sfe"
      ? "This visit is waiting for SFE, and only the SFE Manager decides that step."
      : "Only the territory's reviewing manager decides this step.",
  );
}

// ── Asking to edit a sent week: the manager, then SFE — and the Administrator may decline ───────

/**
 * The Administrator — Omar Gawish himself (owner, 2026-10-08: "call it the Administrator"). Compared as a
 * PERSON, never as a raw id: he also signs in as the system console, which is the same human
 * (identity-aliases.ts).
 *
 * 🔴 HE IS NEVER A STEP. Nothing in Phoenix CRM waits for his approval and no count of "waiting for you"
 * includes him. What he has is the right to APPROVE, DECLINE or RETURN, on any approval, in place of
 * whoever holds the step it waits at (owner, 2026-10-14: "in an urgent situation he can approve instead
 * of anyone, any title" — it replaced the earlier decline-only ruling of 2026-10-08). He takes the step
 * the row is AT, never skips one, and the rep, the district manager and SFE are told it was the
 * Administrator. One of the Super Admin's REAL-DATA acts in Phoenix CRM, beside `canMovePlaces` and
 * `territoryForMissedRecord` — everywhere else his entries are test entries (owner, 2026-09-16).
 */
export function canAdminister(viewer: PhoenixCrmViewer): boolean {
  return !viewer.isTestPersona && viewer.isSuperAdmin && viewer.canApprove && isSamePerson(viewer.hrId, PHOENIX_CRM_ADMINISTRATOR_HR_ID);
}

/** Whether the Administrator may approve, decline or return a REAL decision. Never on a test entry, and never counted as a step. */
export function canOverrideDecision(viewer: PhoenixCrmViewer, isTest: boolean): boolean {
  return !isTest && canAdminister(viewer);
}

/**
 * Whether the viewer may act at THIS step of a request to edit a week. `stage` is the row's own step,
 * never the phone's. The manager's and SFE's steps are the same two authorities an off-plan visit runs
 * through (`canDecideUnplannedVisit`). In the test world the Super Admin takes every step, and a test
 * account takes the manager's as the person it mirrors. The Administrator is not a step here — see
 * `canOverrideDecision`.
 */
export function canDecidePlanEdit(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean, stage: PlanEditStage): boolean {
  if (viewer.isTestPersona) {
    return isTest && stage === "manager" && viewer.canApprove && isTerritoryReviewer(viewer.org, seat.seatId, viewer.hrId);
  }
  if (isTest) return viewer.isSuperAdmin;
  if (viewer.isSuperAdmin || !viewer.canApprove) return false;
  if (stage === "sfe") return viewer.isSfeManager && viewer.scopeTerritories.some((entry) => entry.seatId === seat.seatId);
  return isTerritoryReviewer(viewer.org, seat.seatId, viewer.hrId);
}

/** The assert twin. The stage comes from the row's own status, never from the phone. */
export function assertPlanEditApprover(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean, stage: PlanEditStage): void {
  if (viewer.isTestPersona && !isTest) throw testAccountRealEntry();
  if (isTest && !viewer.isSuperAdmin && !viewer.isTestPersona) throw forbiddenError("Test entries are the Super Admin's.");
  if (canDecidePlanEdit(viewer, seat, isTest, stage)) return;
  if (!isTest && viewer.isSuperAdmin) throw superAdminDoesNotDecide();
  throw forbiddenError(
    stage === "sfe"
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
 * The mode a read across territories runs in: a TEST- login's own world, and the real entries for
 * everybody else. The Super Admin's choice of world is retired (see `superAdminHasNoFieldWrite`), and
 * the flag a screen still sends is read and dropped rather than refused, for the reason
 * `territoryForRead` records.
 */
export function testModeFor(viewer: PhoenixCrmViewer, flag: unknown): boolean {
  void readTestFlag(flag);
  return viewer.isTestPersona;
}

/**
 * The territories such a read covers. It was the Super Admin's test mode that reached EVERY territory
 * rather than a scope — retired, so this is now the viewer's scope in every case, a test account
 * included: it reads exactly the scope of the person it mirrors, in the test world as in the real one.
 */
export function testReadSeats(viewer: PhoenixCrmViewer, isTest: boolean, scope: OrgSeat[]): OrgSeat[] {
  void viewer;
  void isTest;
  return scope;
}

/**
 * Whether a report carries test entries. A test account's always do — its own work is test work, read
 * beside the real entries of the people it mirrors.
 *
 * 🔒 THE SUPER ADMIN'S "Include my test entries" TICK IS RETIRED with his test mode (owner,
 * 2026-10-03). It was the one control in the module that could make a figure he quoted disagree with
 * the same figure read by anybody else.
 */
export function reportIncludesTest(viewer: PhoenixCrmViewer, flag: unknown): boolean {
  void readTestFlag(flag);
  return viewer.isTestPersona;
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

/**
 * Who reads the measurement BEHIND a distance — the reading's accuracy, the weak-signal verdict, the
 * phone-clock warning, a place's two raw readings and where its fixed point came from: the Super
 * Admin and the SFE Manager, and nobody else (owner, 2026-10-02 — "District Managers see the distance
 * only"). Everyone else who may read a location reads the DISTANCE and the far / at-the-place wording.
 */
export function readsLocationDetail(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin || viewer.isSfeManager;
}

/**
 * How much of a visit's or a place's location this viewer is shown on this seat:
 *   - `none` — his own territory as its rep (Golden Rule #1): no distance, no flag, no check;
 *   - `distance` — every other reader below the Super Admin and the SFE Manager (owner, 2026-10-02): the
 *     distance and the far / at-the-place wording, and nothing about the reading behind it;
 *   - `full` — the Super Admin and the SFE Manager: everything.
 */
export type LocationSight = "none" | "distance" | "full";

export function locationSight(viewer: PhoenixCrmViewer, seat: OrgSeat): LocationSight {
  if (readsLocationDetail(viewer)) return "full";
  return isLocationBlind(viewer, seat) ? "none" : "distance";
}

/** The seat tiers whose holder reads the place-vs-actual report: the DM (acting or not) and the NSM. */
const PLACE_VS_ACTUAL_TIERS = new Set(["DM", "ACTING_DM", "NSM"]);

/**
 * Who reads the place-vs-actual report — and so a far-visit count at all: the Super Admin, the SFE
 * Manager, and a viewer holding a District Manager, acting District Manager or National Sales Manager
 * seat (owner, 2026-09-26, narrowed by his own ruling of 2026-10-02).
 *
 * 🔴 ITS OWN PREDICATE, NOT `readsTeamReports`. That one admits a company basis (the CEO) and every
 * manager seat (the RSM included), and the owner took both off this report on 2026-10-02. It also
 * answers the exceptions board, the brick report, the adoption board and the digest's recipients,
 * which he did NOT narrow — so it is left exactly as it was.
 */
export function readsPlaceVsActual(viewer: PhoenixCrmViewer): boolean {
  return readsLocationDetail(viewer) || viewer.managerSeats.some((seat) => PLACE_VS_ACTUAL_TIERS.has(seat.tier));
}

/**
 * Whether a location section may measure THIS seat for this viewer: he reads the place-vs-actual
 * report, and the seat is not his own as its rep.
 *
 * 🔴 A VIEWER-LEVEL ANSWER IS THE WRONG QUESTION FOR A SEAT. An ACTING District Manager who still holds
 * a rep seat is a manager by every viewer-level test, and he read his OWN distances in the
 * place-vs-actual report and his own far-visit count — while every visit screen already blinded him on
 * that seat (audit, 2026-10-02). A seat a viewer is blind on is a seat no section measures for him.
 */
export function readsSeatLocations(viewer: PhoenixCrmViewer, seat: OrgSeat): boolean {
  return readsPlaceVsActual(viewer) && !isLocationBlind(viewer, seat);
}

/** The seats a location section measures: the chosen ones, less any the viewer may not measure. */
export function locationReportSeats(viewer: PhoenixCrmViewer, seats: ReadonlyArray<OrgSeat>): OrgSeat[] {
  return seats.filter((seat) => readsSeatLocations(viewer, seat));
}

// ── The district manager's own Place checks tab (owner, 2026-10-13) ────────────────────────────

/** The seat tiers whose holder reads his TEAM'S place checks: the district manager, acting or not. */
const TEAM_PLACE_CHECKS_TIERS = new Set(["DM", "ACTING_DM"]);

/**
 * Who reads the Place checks of his own team — the district manager and the acting district manager,
 * and nobody else below the Super Admin (owner, 2026-10-13: "in every district manager account, build
 * a tab in his sidebar that shows the check places only for his team").
 *
 * 🔴 ITS OWN PREDICATE, AND DELIBERATELY NARROWER THAN `readsPlaceVsActual`, which also admits the
 * National Sales Manager and the SFE Manager because the owner put the place-vs-actual REPORT in their
 * hands. He named the district manager here and nobody else, and widening somebody's sight into this
 * module on a guess is exactly what the three sight tiers above exist to prevent.
 *
 * 🔴 AND THE QUESTION IS SETTLED, NOT MERELY UNASKED — he was put the choice the same day the tab
 * shipped and answered it: "keep place checks to district managers only" (2026-10-13). So the two
 * tiers above are a RULING. Do not widen this set because the place-vs-actual report is wider, or
 * because a Regional or National Sales Manager asks why he cannot see his districts' boards, or
 * because the next session reads the paragraph above as an open question. Only his own word, naming
 * the rung, changes it.
 *
 * It decides NOTHING. `canDecideValidationReviews` is the Super Admin and the SFE Manager, never the
 * district manager, and the manager's screen never says so (his own instruction, the same day: "don't
 * show this on the screen").
 */
export function readsTeamPlaceChecks(viewer: PhoenixCrmViewer): boolean {
  return viewer.managerSeats.some((seat) => TEAM_PLACE_CHECKS_TIERS.has(seat.tier));
}

/**
 * The territories a team Place checks board is about: the ones in his scope, less any seat he is blind
 * on.
 *
 * 🔴 THAT SUBTRACTION IS AN ACTING DISTRICT MANAGER'S OWN REP SEAT. He is a manager by every
 * viewer-level test and a REP on one territory, and golden rule #1 means his own captures are not
 * evidence he reads about himself — the same defect `readsSeatLocations` was written for after the
 * 2026-10-02 audit found him reading his own distances in the place-vs-actual report.
 */
export function teamPlaceChecksSeats(viewer: PhoenixCrmViewer): OrgSeat[] {
  if (!readsTeamPlaceChecks(viewer)) return [];
  return viewer.scopeTerritories.filter((seat) => !isLocationBlind(viewer, seat));
}

/** How the viewer reads the Double visit requests report: "scope" — the territories he reads; "own" — only what is addressed to him. */
export type DoubleVisitReportAudience = "scope" | "own";

/**
 * Who opens the Double visit requests report (owner, 2026-10-16: "all managers must have access on this
 * report as per their scope up to the CEO"). The Super Admin, the CEO and the SFE Manager read every
 * territory in their scope (`basis` "all"); every manager who holds a seat reads the territories beneath
 * him; a product manager, a group product manager and the Marketing Manager — people who hold NO seat
 * but whom a rep can ask — read the requests addressed to them. Null for everyone else: a rep reads his
 * own requests on his customer's page, never here.
 *
 * It lives here, beside the other sidebar predicates, because the portal sidebar asks it on every page
 * and must not pull the whole request service in to do so. The page, the routes and the sidebar flag all
 * read this one function.
 */
export function doubleVisitReportAudience(viewer: PhoenixCrmViewer): DoubleVisitReportAudience | null {
  if (viewer.basis === "all") return "scope";
  if (viewer.managerSeats.length > 0) return "scope";
  if (isVisitAskAskableRole(viewer.role)) return "own";
  return null;
}

/**
 * The Super Admin and the SFE Manager decide a place check (owner, 2026-10-03: "only system admin can
 * approve or reject"; widened 2026-10-19: "show check place to sfe manager exactly as it in the admin
 * account to be able validate approve and refuse"). Never a test account, and never the district
 * manager, who READS his own team's board and writes a recommendation on it (2026-10-13).
 *
 * The Super Admin holds `phoenix_crm` `update`; the SFE Manager holds `approve` and no `update`, so the
 * gate is each role's own grant rather than a new `update` handed to the SFE Manager (which would also
 * open every other `update` route in the module to him). The decision routes are gated on `approve` for
 * the same reason — see `access-registry.ts`.
 *
 * 🔴 WHAT THIS DOES NOT WIDEN, each its own ruling and each still the Super Admin's alone: settling a
 * location-integrity case (`canSettleIntegrityCases`, 2026-10-09), seating a standalone customer in a
 * polyclinic (`canDecideSharedPlaces`, 2026-10-10), and the mock-location evidence (`readsPositionCases`,
 * 2026-10-02) — so an SFE Manager on this board is served the photo evidence only.
 *
 * 🔴 IT LIVES HERE, AND `server/validation-reviews.ts` RE-EXPORTS IT UNDER ITS OWN NAME, because
 * `placeChecksSeatScope` below has to answer for all FOUR section reads and one of them is the venue
 * board in `server/shared-places.ts` — a file `server/validation-reviews.ts` already imports
 * `loadSharedPlaceNames` from. Declaring either of these two there and importing it into
 * `shared-places.ts` closes exactly the cycle that file's own header warns about. The alternative, a
 * second copy of the predicate, is worse: it is the one sentence that separates reading this board
 * from deciding on it.
 */
export function canDecideValidationReviews(viewer: PhoenixCrmViewer): boolean {
  if (viewer.isTestPersona) return false;
  if (viewer.isSuperAdmin) return viewer.canUpdate;
  return viewer.isSfeManager && viewer.canApprove;
}

/**
 * WHICH SEATS a Place checks read covers: `null` is the whole company, a list of seat ids is one
 * district manager's own team (owner, 2026-10-13: "shows the check places only for his team").
 *
 * 🔴 ONE HELPER FOR ALL FOUR SECTION READS, AND IT THROWS RATHER THAN RETURNING AN EMPTY LIST. A
 * forbidden viewer handed back `[]` would be served an `.in("seat_id", [])`, and a PostgREST `.in()`
 * on an empty array answers ZERO ROWS WITH NO ERROR — so the page would draw itself, empty, for
 * somebody it must not draw for at all, and read as "nothing waiting" rather than as a refusal.
 *
 * It does not widen the decider by one person: `canDecideValidationReviews` is unchanged by it, and a
 * manager's board renders none of the decision controls. A decider (Super Admin or SFE Manager) reads
 * the whole company.
 */
export function placeChecksSeatScope(viewer: PhoenixCrmViewer): string[] | null {
  if (canDecideValidationReviews(viewer)) return null;
  const seats = teamPlaceChecksSeats(viewer);
  if (seats.length === 0) throw forbiddenError("These place checks are not yours to read.");
  return seats.map((seat) => seat.seatId);
}

/**
 * Whether a team-only judgement about how a seat was WORKED — the tracking sheet's spacing note — is
 * shown for this seat: the viewer reads team reports, and the seat is not his own as its rep (the
 * acting District Manager's own sheet is a rep's sheet; audit, 2026-10-02).
 */
export function readsTeamReportsOn(viewer: PhoenixCrmViewer, seat: OrgSeat): boolean {
  return readsTeamReports(viewer) && !isLocationBlind(viewer, seat);
}

// ── A list request: one step for a grade, the manager then SFE for everything else ─────────────

/**
 * Whether the viewer may decide THIS step of a list request (owner, 2026-09-29). `stage` is the row's
 * own stage, never the phone's: null for a grade change (the territory's reviewer alone), "manager"
 * for the first step of a drop, an add or a bring-back, "sfe" for the second — the same two
 * authorities an off-plan visit's approval runs through (`canDecideUnplannedVisit`).
 *
 * 🔴 A GRADE CHANGE ON A TERRITORY WITH NO MANAGER AT ALL FALLS TO SFE (owner's pick, 2026-10-02), and
 * ONLY then. A grade change is one step and the district manager's — but a rep under a vacant chain
 * could not get one decided by anybody: nothing offered it, nobody was told, and his ask sat for ever.
 * The authority is not a new one, it is the SFE STEP's own (`canDecideUnplannedVisit(…, "sfe")`), so
 * there is no second copy of who SFE is. The moment somebody holds the seat it is his again.
 */
export function canDecideListRequest(
  viewer: PhoenixCrmViewer,
  seat: OrgSeat,
  isTest: boolean,
  stage: PhoenixCrmRequestStage | null,
): boolean {
  if (stage === null) {
    if (canReviewTerritory(viewer, seat, isTest)) return true;
    return territoryReviewer(viewer.org, seat.seatId) === null && canDecideUnplannedVisit(viewer, seat, isTest, "sfe");
  }
  return canDecideUnplannedVisit(viewer, seat, isTest, stage);
}

export function assertListRequestApprover(
  viewer: PhoenixCrmViewer,
  seat: OrgSeat,
  isTest: boolean,
  stage: PhoenixCrmRequestStage | null,
): void {
  if (stage === null) {
    // The reviewer's own step, unless the seat above is empty — then SFE's, by the same predicate the
    // reads use, so a screen can never offer a decision this would refuse.
    if (canDecideListRequest(viewer, seat, isTest, stage)) return;
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
  if (viewer.isSuperAdmin) throw superAdminDoesNotDecide();
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
 * `territoryForMissedRecord` and `canAdminister`). Everywhere else his own entries are test
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

// ── Curating a rep's list: the SFE Manager drops a customer, or hands him to another rep ───────

/**
 * Whether the viewer may CURATE any rep's list — drop a customer off it himself, or move him to
 * another rep's list (owner, 2026-10-06: "make the sfe able to enter on any med rep list and delete or
 * drop from it any irrelevant customer or move this customer to and choose where").
 *
 * 🔴 IT IS NOT A SHORTCUT ROUND THE TWO-STEP DROP, it is the other end of it. A REP asking to drop a
 * customer still goes to his district manager and then to SFE (`canDecideListRequest`), because that
 * ask is about the rep's own work. This is the SFE going into the list himself, which is the same
 * authority he already holds over the Archive (`sfeBringBack`, owner 2026-09-29) — and the drop is
 * filed and decided as a `drop` request at his own step, so the list's history reads the same whoever
 * took the customer off it.
 *
 * The set of people is `canMovePlaces`'s, deliberately: moving a clinic and moving a customer are the
 * two acts that rewrite a validated record somebody else captured, both carry a written reason, and
 * both are audited. So the Super Admin is included — this is one of the handful of real-data writes
 * that are his (`canMovePlaces`, `territoryForMissedRecord`, `canAdminister`) — and a test
 * account never curates a real list.
 */
export function canCurateList(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): boolean {
  return canMovePlaces(viewer, seat, isTest);
}

export function assertListCurator(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean): void {
  if (!canCurateList(viewer, seat, isTest)) {
    throw forbiddenError("Only the SFE Manager and the Super Admin change a rep's list from outside it.");
  }
}

// ── A record a rep missed: the Super Admin enters it for him ───────────────────────────────────

/**
 * Whether the viewer enters records a rep MISSED (owner, 2026-10-01: "the rep is responsible for all
 * his records, but if he missed a visit or a record, admin can enter it for him … for anyone, anytime,
 * anywhere"). The Super Admin, and only him: a test account never does, and neither does any other role.
 *
 * 🔴 The second of the Super Admin's three real-data writes (beside `canMovePlaces` and
 * `canAdminister`). With test mode on it
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
  if (!canEnterMissedRecords(viewer)) throw forbiddenError("Only the Super Admin removes a visit they entered.");
  return { seat: territory(viewer, seatId), isTest: test };
}

/**
 * The territory a rep's visit is CORRECTED on (owner, 2026-10-06: "make the admin able to edit a visit
 * submitted by an employee"). The Super Admin alone, on the same footing as removing a visit: no
 * open-line or rep conditions, because correcting a record that already exists must stay possible after
 * the rep has left the seat or the line has closed. Which visit, and which of its fields, is the
 * database's and `visit-edit-rules.ts`'s to decide from the row itself.
 */
export function territoryForVisitEdit(viewer: PhoenixCrmViewer, seatId: unknown, test: boolean): TerritoryAccess {
  if (!canEnterMissedRecords(viewer)) throw forbiddenError("Only the Super Admin corrects a rep's visit.");
  return { seat: territory(viewer, seatId), isTest: test };
}

// ── The Visit report generator (owner, 2026-10-15) ──────────────────────────────────────────────

/**
 * Who reads the Visit report generator for his OWN TEAM: the district manager and the acting district
 * manager, the same two seat tiers as the Place checks tab and for the same reason (owner, 2026-10-15:
 * "start building same module for DSMs only their scope"). Seat-based, never a role name, so an acting
 * district manager is admitted and the report is never offered to anyone who merely holds a similar
 * title. WHICH territories it covers is `scopeTerritories` less the seats he is blind on — the loader's
 * own `readableSeats` — never a filter applied after a wider read.
 */
export function readsTeamVisitReport(viewer: PhoenixCrmViewer): boolean {
  return viewer.managerSeats.some((seat) => TEAM_PLACE_CHECKS_TIERS.has(seat.tier));
}

/**
 * Who opens the Visit report generator: the Super Admin and the SFE Manager across the company, and the
 * district manager across his own team. Nobody else.
 *
 * 🔴 ITS OWN PREDICATE, THE SAME TWO READERS AS `readsLocationDetail` AND THE INTEGRITY BOARD, because a
 * report that prints where a phone was, how far from the place and which detectors fired is location
 * evidence about named people (Golden Rule #1). The SFE Manager and the district manager read everything
 * but the mock-location evidence, which stays the Super Admin's (`readsPositionCases`); that narrowing is
 * applied where the evidence is READ, not on the screen. The district manager's reach is his own team and
 * is applied where the SEATS are chosen (`readableSeats` in the loader).
 */
export function canReadVisitReport(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin || viewer.isSfeManager || readsTeamVisitReport(viewer);
}
