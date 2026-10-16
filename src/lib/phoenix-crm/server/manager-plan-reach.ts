/**
 * Phoenix CRM — who reads, writes and decides a district manager's weekly plan. No I/O: every answer is
 * read off the viewer and the organogram the viewer already carries, so the Plan tab, the Team tab, the
 * routes and the Approvals Hub ask the same questions the same way.
 *
 * Owner, 2026-10-16:
 *   - WRITES: the district manager himself — a DM or acting DM seat holder (`managerPlanSeats`) with
 *     `create`. Nosiba Salah, the one acting district manager who also holds a rep seat, files both her
 *     rep week and this one.
 *   - READS ("him rsm dsm sfe nsm admin ceo"): his own; his RSM or NSM — any district manager whose
 *     chain above holds them; the SFE Manager, the CEO and the Super Admin — any district manager, picked
 *     from a list.
 *   - DECIDES: whoever the week was sent to — the first approver stored on it at send, then the second
 *     (Ali Mohamed Ali for Hany Saad's district managers) — and the Administrator in place of either, on
 *     real data only (Phoenix CRM's rule of 2026-10-14, `canOverrideDecision`).
 *   - 🔴 A REP NEVER READS IT. He is refused by every function here, and nothing he opens asks.
 *
 * It never goes through `territoryForRead` / `territoryForRepWrite`: those answer for a REP seat, and a
 * district manager's seat owns no customers.
 */

import { forbiddenError, notFoundError, type ApiError } from "@/lib/http/api-errors";
import { managerPlanSeats, type ManagerPlanStatus, type ManagerPlanStage } from "@/lib/phoenix-crm/manager-plan-rules";
import { districtManagers } from "@/lib/phoenix-crm/double-visit-plan-rules";
import { managerChain, personKey, territoriesBelow, TERRITORY_TIER, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { canOverrideDecision, superAdminHasNoFieldWrite, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";

export const MANAGER_PLAN_NOT_FOR_YOU =
  "A district manager's weekly plan is read by that district manager, the managers above that seat, SFE, the CEO and the Super Admin.";

/** A district manager the viewer may read, with the seat his plan is filed on. */
export type ReachableManager = { hrId: string; seat: OrgSeat };

/**
 * "own" — his own plan, as the district manager; "pick" — any of `managers`, chosen on screen. A person
 * who is both (an acting district manager who is also somebody's RSM does not exist today, but the
 * organogram allows it) is "own": his own week is the one he plans.
 */
export type ManagerPlanReach = {
  mode: "own" | "pick";
  /** He may change his own open days on screen. */
  canWrite: boolean;
  /** "pick" mode: every district manager he reads. Empty in "own" mode. */
  managers: ReachableManager[];
};

/** "Delta (1) · Anti Infective" — where a district manager's seat is, never its code. */
export function managerPlace(seat: OrgSeat | null): string {
  if (!seat) return "District";
  return [seat.regionName ?? seat.areaName ?? seat.seatLabel ?? "District", seat.lineName].filter(Boolean).join(" · ");
}

/** The viewer plans a week of his own: he holds a DM or acting DM seat. */
export function isManagerPlanner(viewer: PhoenixCrmViewer): boolean {
  return managerPlanSeats(viewer.org, viewer.hrId).length > 0;
}

/** His plan seat — the first DM or acting DM seat he holds — or null. */
export function managerPlanSeatOf(viewer: Pick<PhoenixCrmViewer, "org">, hrId: string | null | undefined): OrgSeat | null {
  return managerPlanSeats(viewer.org, hrId)[0] ?? null;
}

/** The district managers the managers above them read: those whose seat's chain holds the viewer. */
function managersBelow(viewer: PhoenixCrmViewer): ReachableManager[] {
  if (viewer.managerSeats.length === 0) return [];
  return districtManagers(viewer.org, (seat) => !seat.isOtherPseudoDm).filter(
    (entry) => entry.hrId !== viewer.hrId && managerChain(viewer.org, entry.seat.seatId).some((member) => member.hrId === viewer.hrId),
  );
}

/** Every district manager of the company, never the per-line "Others" bucket. */
function everyManager(viewer: PhoenixCrmViewer): ReachableManager[] {
  return districtManagers(viewer.org, (seat) => !seat.isOtherPseudoDm);
}

/**
 * Whose district-manager plans the viewer reads, and whether he writes his own. Null for everyone the
 * server refuses — a rep above all — so no screen ever offers the section to somebody it would turn away.
 */
export function managerPlanReach(viewer: PhoenixCrmViewer): ManagerPlanReach | null {
  if (isManagerPlanner(viewer)) {
    return { mode: "own", canWrite: viewer.canCreate && !viewer.isSuperAdmin, managers: [] };
  }
  if (viewer.basis === "all") return { mode: "pick", canWrite: false, managers: everyManager(viewer) };
  const below = managersBelow(viewer);
  if (below.length > 0) return { mode: "pick", canWrite: false, managers: below };
  return null;
}

/** The viewer reads this district manager's plan. */
export function readsManagerPlanOf(viewer: PhoenixCrmViewer, managerHrId: string | null | undefined): boolean {
  const key = personKey(managerHrId);
  if (!key) return false;
  const reach = managerPlanReach(viewer);
  if (!reach) return false;
  if (reach.mode === "own") return key === viewer.hrId || managersBelow(viewer).some((entry) => entry.hrId === key);
  return reach.managers.some((entry) => entry.hrId === key);
}

export type ManagerPlanReader = ManagerPlanReach & {
  /** Whose plan is read; null in "pick" mode until one is chosen. */
  managerHrId: string | null;
};

/** Gate two for READING: his own, or the one he picked among those he reaches. */
export function resolveManagerPlanReader(viewer: PhoenixCrmViewer, managerParam: unknown): ManagerPlanReader {
  const reach = managerPlanReach(viewer);
  if (!reach) throw forbiddenError(MANAGER_PLAN_NOT_FOR_YOU);
  const asked = personKey(typeof managerParam === "string" ? managerParam : null);
  if (reach.mode === "own") {
    if (asked && asked !== viewer.hrId) {
      if (!managersBelow(viewer).some((entry) => entry.hrId === asked)) {
        throw forbiddenError("A district manager opens only the weekly plan of their own seat.");
      }
      return { mode: "pick", canWrite: false, managers: managersBelow(viewer), managerHrId: asked };
    }
    return { ...reach, managerHrId: viewer.hrId };
  }
  if (!asked) return { ...reach, managerHrId: reach.managers.length === 1 ? reach.managers[0].hrId : null };
  if (!reach.managers.some((entry) => entry.hrId === asked)) throw notFoundError("This district manager is not one you read. Reload the page.");
  return { ...reach, managerHrId: asked };
}

/**
 * Gate two for WRITING: the district manager's own plan, and nobody else's. The Super Admin plans no
 * district manager's week (his test mode is retired — `superAdminHasNoFieldWrite`), and SFE, the CEO and
 * the managers above him read it and never write it. Answers his plan seat.
 */
export function assertManagerPlanWriter(viewer: PhoenixCrmViewer): OrgSeat {
  if (viewer.isSuperAdmin && !viewer.isTestPersona) throw superAdminHasNoFieldWrite("plan a district manager's week");
  const seat = managerPlanSeatOf(viewer, viewer.hrId);
  if (!seat) throw forbiddenError("Only a district manager plans a district manager's week.");
  if (!viewer.canCreate) throw forbiddenError("Your role cannot plan a week.");
  return seat;
}

// ── His district ────────────────────────────────────────────────────────────────────────────────

/** Every territory under his district manager seats — vacant ones included, never his own rep seat. */
export function managerDistrictSeats(viewer: Pick<PhoenixCrmViewer, "org">, managerHrId: string): OrgSeat[] {
  const roots = managerPlanSeats(viewer.org, managerHrId).map((seat) => seat.seatId);
  const manager = personKey(managerHrId);
  return territoriesBelow(viewer.org, roots).filter((seat) => seat.tier === TERRITORY_TIER && personKey(seat.occupantHrId) !== manager);
}

/** The reps he may go with: the occupied territories of his district. */
export function managerTeamSeats(viewer: Pick<PhoenixCrmViewer, "org">, managerHrId: string): OrgSeat[] {
  return managerDistrictSeats(viewer, managerHrId).filter((seat) => Boolean(personKey(seat.occupantHrId)));
}

// ── Who decides ─────────────────────────────────────────────────────────────────────────────────

/** The role a decision is recorded under: the step's own holder, or the Administrator in its place. */
export type ManagerPlanDeciderRole = "first" | "second" | "administrator";

/**
 * Whether the viewer decides THIS step of a sent week. `stage` is the row's own (its status), never the
 * phone's; the holder is the approver STORED on the row at send. A test account decides as the person
 * it mirrors, in the test world only; the Administrator acts in place of either holder on real data.
 */
export function managerPlanDeciderRole(
  viewer: PhoenixCrmViewer,
  row: { stage: ManagerPlanStage; firstApproverHrId: string | null; secondApproverHrId: string | null; isTest: boolean },
): ManagerPlanDeciderRole | null {
  if (viewer.isTestPersona !== row.isTest) return null;
  const holder = row.stage === "first" ? row.firstApproverHrId : row.secondApproverHrId;
  if (viewer.canApprove && holder && personKey(holder) === viewer.hrId && !(viewer.isSuperAdmin && !viewer.isTestPersona)) return row.stage;
  if (canOverrideDecision(viewer, row.isTest)) return "administrator";
  return null;
}

/** The decision the viewer takes on a waiting ask (an edit, a removal): its approver, or the Administrator. */
export function managerAskDeciderRole(viewer: PhoenixCrmViewer, row: { approverHrId: string | null; isTest: boolean }): "first" | "administrator" | null {
  if (viewer.isTestPersona !== row.isTest) return null;
  if (viewer.canApprove && row.approverHrId && personKey(row.approverHrId) === viewer.hrId && !(viewer.isSuperAdmin && !viewer.isTestPersona)) {
    return "first";
  }
  if (canOverrideDecision(viewer, row.isTest)) return "administrator";
  return null;
}

/** The refusal a decider reads when the step is not his. */
export function notYourManagerPlanStep(status: ManagerPlanStatus | null): ApiError {
  if (status === "first_approved") return forbiddenError("This week is waiting for its second approver, who decides this step.");
  if (status === "submitted") return forbiddenError("This week is waiting for the manager above the district manager, who decides it.");
  return forbiddenError("This week is not waiting for a decision. Reload the page.");
}
