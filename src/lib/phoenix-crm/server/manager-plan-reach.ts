/**
 * Phoenix CRM — who reads, writes and decides a manager's weekly plan. No I/O: every answer is read off
 * the viewer and the organogram the viewer already carries, so the Plan tab, the Team tab, the routes and
 * the Approvals Hub ask the same questions the same way.
 *
 * Owner, 2026-10-16:
 *   - WRITES: the district manager himself — a DM or acting DM seat holder (`managerPlanSeats`) with
 *     `create`. Nosiba Salah, the one acting district manager who also holds a rep seat, files both her
 *     rep week and this one.
 *   - READS ("him rsm dsm sfe nsm admin ceo"): his own; his RSM or NSM — any district manager whose
 *     chain above holds them; the SFE Manager, the CEO and the Super Admin — any district manager, picked
 *     from a list.
 *   - DECIDES: whoever the week was sent to — the first approver stored on it at send, then the second
 *     (the national sales manager above a regional first approver) — and the Administrator in place of either, on
 *     real data only (Phoenix CRM's rule of 2026-10-14, `canOverrideDecision`).
 *   - 🔴 A REP NEVER READS IT. He is refused by every function here, and nothing he opens asks.
 *
 * 🔴 WIDENED (owner, 2026-10-17): "Now do the same for the product managers and the national sales
 * managers and the regional manager." Four kinds of writer (`managerPlanWriterOf`): the district manager;
 * the regional and national sales managers, by their seat; the product managers, by their role
 * (`plansAsProductManager` — they sit on no seat). The readers widen with them: a national sales manager
 * reads the regional manager's week below him, and a product manager's week is read by the manager his HR
 * record names (Rasha Sabry reads Ahmed SharafEldeen's; Hossam Reda reads Rasha's). A week is DECIDED by
 * the person stored on it at send, whatever his app role grants elsewhere — the CEO and the Marketing
 * Manager approve a week here with `read` alone, as they do the legacy plan.
 *
 * 🔴 WIDENED AGAIN (owner, 2026-10-24): the Training Manager plans a week too (`plansAsTrainingManager`, a
 * role like the product managers', no seat). Her week is read by the manager her HR record names, and by
 * SFE, the CEO and the Super Admin, as a product manager's is.
 *
 * It never goes through `territoryForRead` / `territoryForRepWrite`: those answer for a REP seat, and a
 * manager's seat owns no customers.
 */

import { forbiddenError, notFoundError, type ApiError } from "@/lib/http/api-errors";
import {
  managerPlanSeats,
  managerPlannerTitle,
  managerPlanWriterOf,
  seniorPlanSeats,
  type ManagerPlannerKind,
  type ManagerPlanStage,
  type ManagerPlanStatus,
  type ManagerPlanWriter,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { districtManagers } from "@/lib/phoenix-crm/double-visit-plan-rules";
import { managerChain, personKey, territoriesBelow, TERRITORY_TIER, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { canOverrideDecision, decidesTestWorld, superAdminHasNoFieldWrite, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import type { ProductManagerPlanner } from "@/lib/phoenix-crm/server/manager-plan-writers";

export const MANAGER_PLAN_NOT_FOR_YOU =
  "A manager's weekly plan is read by that manager, the managers above, SFE, the CEO and the Super Admin.";

/** A manager the viewer may read, with the seat his plan is filed on — none for a product manager. */
export type ReachableManager = { hrId: string; kind: ManagerPlannerKind; seat: OrgSeat | null; jobTitle?: string | null };

/**
 * "own" — his own plan, as its writer; "pick" — any of `managers`, chosen on screen. A writer who also
 * reads others below him (Ali Mohamed Ali reads Hany Saad's week and his district managers') is "own":
 * his own week is the one he plans, and `managers` lists the others he may open on the Team tab.
 */
export type ManagerPlanReach = {
  mode: "own" | "pick";
  /** He may change his own open days on screen. */
  canWrite: boolean;
  /** "pick": every manager he reads. "own": the OTHER managers he reads, beside his own week. */
  managers: ReachableManager[];
};

/** "Delta (1) · Anti Infective" — where a manager's seat is, never its code. A product manager's: his title. */
export function managerPlace(seat: OrgSeat | null, kind: ManagerPlannerKind = "dm", jobTitle?: string | null): string {
  if (!seat) return kind === "dm" ? "District" : managerPlannerTitle(kind, jobTitle);
  const place = [seat.regionName ?? seat.areaName ?? seat.seatLabel ?? (kind === "dm" ? "District" : null), seat.lineName].filter(Boolean).join(" · ");
  return kind === "dm" ? place || "District" : [managerPlannerTitle(kind), place].filter(Boolean).join(" · ");
}

/** A viewer built by hand (a test, a script) may carry no roster; the server always does. */
function productManagersOf(viewer: Partial<Pick<PhoenixCrmViewer, "productManagers">>): ReadonlyArray<ProductManagerPlanner> {
  return Array.isArray(viewer.productManagers) ? viewer.productManagers : [];
}

/** The same for the Training Manager roster. */
function trainingManagersOf(viewer: Partial<Pick<PhoenixCrmViewer, "trainingManagers">>): ReadonlyArray<ProductManagerPlanner> {
  return Array.isArray(viewer.trainingManagers) ? viewer.trainingManagers : [];
}

/** The viewer's own writer: what he plans as, or null. */
export function managerPlanWriter(
  viewer: Pick<PhoenixCrmViewer, "org" | "hrId" | "plansAsProductManager"> & Partial<Pick<PhoenixCrmViewer, "plansAsTrainingManager" | "productManagers">>,
): ManagerPlanWriter | null {
  const own = personKey(viewer.hrId);
  return managerPlanWriterOf(viewer.org, viewer.hrId, {
    productManager: viewer.plansAsProductManager === true,
    productManagerTitle: productManagersOf(viewer).find((entry) => entry.hrId === own)?.jobTitle ?? null,
    trainingManager: viewer.plansAsTrainingManager === true,
  });
}

/** Any person's writer, as the viewer's organogram and roster know him. */
export function managerPlanWriterFor(
  viewer: Pick<PhoenixCrmViewer, "org" | "productManagers"> & Partial<Pick<PhoenixCrmViewer, "trainingManagers">>,
  hrId: string | null | undefined,
): ManagerPlanWriter | null {
  const key = personKey(hrId);
  if (!key) return null;
  const productManager = productManagersOf(viewer).find((entry) => entry.hrId === key);
  return managerPlanWriterOf(viewer.org, key, {
    productManager: productManager !== undefined,
    productManagerTitle: productManager?.jobTitle ?? null,
    trainingManager: trainingManagersOf(viewer).some((entry) => entry.hrId === key),
  });
}

/** The viewer plans a week of his own, as any of the four kinds. */
export function isManagerPlanner(viewer: PhoenixCrmViewer): boolean {
  return managerPlanWriter(viewer) !== null;
}

/** A district manager's plan seat — the first DM or acting DM seat he holds — or null. */
export function managerPlanSeatOf(viewer: Pick<PhoenixCrmViewer, "org">, hrId: string | null | undefined): OrgSeat | null {
  return managerPlanSeats(viewer.org, hrId)[0] ?? null;
}

function reachable(writer: ManagerPlanWriter): ReachableManager {
  return { hrId: writer.hrId, kind: writer.kind, seat: writer.seat, jobTitle: writer.jobTitle ?? null };
}

/** The seat-holding writers of the company: every district manager, then every regional and national sales manager. */
function seatWriters(viewer: PhoenixCrmViewer): ReachableManager[] {
  const out = new Map<string, ReachableManager>();
  for (const entry of districtManagers(viewer.org, (seat) => !seat.isOtherPseudoDm)) out.set(entry.hrId, { hrId: entry.hrId, kind: "dm", seat: entry.seat });
  for (const seat of [...viewer.org.seats.values()].sort((left, right) => left.seatId.localeCompare(right.seatId))) {
    if (seat.tier !== "RSM" && seat.tier !== "NSM") continue;
    const hrId = personKey(seat.occupantHrId);
    if (!hrId || out.has(hrId)) continue;
    const writer = managerPlanWriterOf(viewer.org, hrId, { productManager: false });
    if (writer) out.set(hrId, reachable(writer));
  }
  return [...out.values()];
}

/** The product managers and the Training Manager who plan here, as writers — the seatless planners. */
function seatlessRoster(viewer: PhoenixCrmViewer): ProductManagerPlanner[] {
  const seen = new Set<string>();
  return [...productManagersOf(viewer), ...trainingManagersOf(viewer)].filter((entry) => {
    if (seen.has(entry.hrId)) return false;
    seen.add(entry.hrId);
    return true;
  });
}

function productManagerWriters(viewer: PhoenixCrmViewer): ReachableManager[] {
  return seatlessRoster(viewer).flatMap((entry) => {
    const writer = managerPlanWriterFor(viewer, entry.hrId);
    return writer ? [reachable(writer)] : [];
  });
}

/**
 * The managers below the viewer: every seat-holding writer whose chain holds him (a district manager under
 * his RSM or NSM, the regional manager under his NSM), and every product manager whose HR record names him
 * as manager.
 */
function managersBelow(viewer: PhoenixCrmViewer): ReachableManager[] {
  const out: ReachableManager[] = [];
  if (viewer.managerSeats.length > 0) {
    for (const entry of seatWriters(viewer)) {
      if (entry.hrId === viewer.hrId || !entry.seat) continue;
      const seatId = entry.seat.seatId;
      if (managerChain(viewer.org, seatId).some((member) => member.hrId === viewer.hrId)) out.push(entry);
    }
  }
  const reports = new Set(seatlessRoster(viewer).filter((entry) => entry.managerHrId === viewer.hrId).map((entry) => entry.hrId));
  for (const entry of productManagerWriters(viewer)) {
    if (entry.hrId !== viewer.hrId && reports.has(entry.hrId) && !out.some((known) => known.hrId === entry.hrId)) out.push(entry);
  }
  return out;
}

/** Every manager who plans a week here, never the per-line "Others" bucket. */
function everyManager(viewer: PhoenixCrmViewer): ReachableManager[] {
  const seen = new Set<string>();
  return [...seatWriters(viewer), ...productManagerWriters(viewer)].filter((entry) => {
    if (seen.has(entry.hrId)) return false;
    seen.add(entry.hrId);
    return true;
  });
}

/** May he change his own week on screen? A district manager needs `create`; the others plan by their seat or role. */
function writerCanWrite(viewer: PhoenixCrmViewer, writer: ManagerPlanWriter): boolean {
  if (viewer.isSuperAdmin && !viewer.isTestPersona) return false;
  return writer.kind === "dm" ? viewer.canCreate : true;
}

/**
 * Whose manager plans the viewer reads, and whether he writes his own. Null for everyone the server
 * refuses — a rep above all — so no screen ever offers the section to somebody it would turn away.
 */
export function managerPlanReach(viewer: PhoenixCrmViewer): ManagerPlanReach | null {
  const writer = managerPlanWriter(viewer);
  const below = viewer.basis === "all" ? everyManager(viewer) : managersBelow(viewer);
  if (writer) return { mode: "own", canWrite: writerCanWrite(viewer, writer), managers: below.filter((entry) => entry.hrId !== writer.hrId) };
  if (below.length > 0) return { mode: "pick", canWrite: false, managers: below };
  return null;
}

/** The viewer reads this manager's plan. */
export function readsManagerPlanOf(viewer: PhoenixCrmViewer, managerHrId: string | null | undefined): boolean {
  const key = personKey(managerHrId);
  if (!key) return false;
  const reach = managerPlanReach(viewer);
  if (!reach) return false;
  if (reach.mode === "own" && key === viewer.hrId) return true;
  return reach.managers.some((entry) => entry.hrId === key);
}

/**
 * Who may open one of his records in the Approvals Hub, and its conversation: whoever reads that manager's
 * plan (he himself, the managers above him, SFE, the CEO and the Super Admin), plus the approvers stored on
 * it — the CEO and the Marketing Manager open a regional, national or product manager's week this way.
 */
export function mayOpenManagerRecord(viewer: PhoenixCrmViewer, managerHrId: string, approverHrIds: ReadonlyArray<string | null>): boolean {
  if (readsManagerPlanOf(viewer, managerHrId)) return true;
  return approverHrIds.some((hrId) => hrId !== null && personKey(hrId) === viewer.hrId);
}

export type ManagerPlanReader = ManagerPlanReach & {
  /** Whose plan is read; null in "pick" mode until one is chosen. */
  managerHrId: string | null;
};

/**
 * The managers the Team tab offers to choose between — himself FIRST when he plans a week too, then every
 * other manager he reads; null when there is nobody to choose. Without it a writer who also reads (Ali
 * Mohamed Ali, "own") could open none of the weeks below him, which he read as a "pick" reader until he
 * started planning his own (owner, 2026-10-17).
 */
export function managerPlanChoices(viewer: PhoenixCrmViewer, reader: Pick<ManagerPlanReach, "mode" | "managers">): ReachableManager[] | null {
  const self = managerPlanWriter(viewer);
  const others = reader.managers.filter((entry) => !self || entry.hrId !== self.hrId);
  if (!self) return reader.mode === "pick" ? others : null;
  return others.length > 0 ? [reachable(self), ...others] : null;
}

/** Gate two for READING: his own, or the one he picked among those he reaches. */
export function resolveManagerPlanReader(viewer: PhoenixCrmViewer, managerParam: unknown): ManagerPlanReader {
  const reach = managerPlanReach(viewer);
  if (!reach) throw forbiddenError(MANAGER_PLAN_NOT_FOR_YOU);
  const asked = personKey(typeof managerParam === "string" ? managerParam : null);
  if (reach.mode === "own") {
    if (asked && asked !== viewer.hrId) {
      if (!reach.managers.some((entry) => entry.hrId === asked)) {
        throw forbiddenError("A manager opens only the weekly plans of their own seat and the managers below it.");
      }
      return { mode: "pick", canWrite: false, managers: reach.managers, managerHrId: asked };
    }
    return { ...reach, managerHrId: viewer.hrId };
  }
  if (!asked) return { ...reach, managerHrId: reach.managers.length === 1 ? reach.managers[0].hrId : null };
  if (!reach.managers.some((entry) => entry.hrId === asked)) throw notFoundError("This manager is not one you read. Reload the page.");
  return { ...reach, managerHrId: asked };
}

/**
 * Gate two for WRITING: his own plan, and nobody else's. The Super Admin plans no manager's week (his test
 * mode is retired — `superAdminHasNoFieldWrite`), and SFE, the CEO and the managers above read a week and
 * never write it. A district manager also needs `create`; a regional, national or product manager plans by
 * his seat or role alone, since their grants are `read` and `approve`. Answers his writer.
 */
export function assertManagerPlanWriter(viewer: PhoenixCrmViewer): ManagerPlanWriter {
  if (viewer.isSuperAdmin && !viewer.isTestPersona) throw superAdminHasNoFieldWrite("plan a manager's week");
  const writer = managerPlanWriter(viewer);
  if (!writer) throw forbiddenError("Only a district, regional, national or product manager, or the Training Manager, plans a manager's week.");
  if (writer.kind === "dm" && !viewer.canCreate) throw forbiddenError("Your role cannot plan a week.");
  return writer;
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

/** The regional or national seat a person plans from, or null. */
export function seniorPlanSeatOf(viewer: Pick<PhoenixCrmViewer, "org">, hrId: string | null | undefined): OrgSeat | null {
  return seniorPlanSeats(viewer.org, hrId)[0] ?? null;
}

// ── Who decides ─────────────────────────────────────────────────────────────────────────────────

/** The role a decision is recorded under: the step's own holder, or the Administrator in its place. */
export type ManagerPlanDeciderRole = "first" | "second" | "administrator";

/**
 * Whether the viewer decides THIS step of a sent week. `stage` is the row's own (its status), never the
 * phone's; the holder is the approver STORED on the row at send — whatever `approve` his role carries
 * elsewhere, since the CEO and the Marketing Manager decide a regional, national or product manager's week
 * "as today". The Administrator acts in place of either holder on real data.
 *
 * 🔒 A TEST week's every step is the Super Admin's, from his "Test accounts" tab (owner, 2026-10-22): he
 * takes the step the row is AT, recorded under that step's own role, so the test manager reads the same
 * in-between state a real one would. A test account decides none, the approver stored on the row
 * included.
 */
export function managerPlanDeciderRole(
  viewer: PhoenixCrmViewer,
  row: { stage: ManagerPlanStage; firstApproverHrId: string | null; secondApproverHrId: string | null; isTest: boolean },
): ManagerPlanDeciderRole | null {
  if (row.isTest) return decidesTestWorld(viewer) ? row.stage : null;
  if (viewer.isTestPersona) return null;
  const holder = row.stage === "first" ? row.firstApproverHrId : row.secondApproverHrId;
  if (holder && personKey(holder) === viewer.hrId && !viewer.isSuperAdmin) return row.stage;
  if (canOverrideDecision(viewer, row.isTest)) return "administrator";
  return null;
}

/**
 * The decision the viewer takes on one step of a waiting ask (an edit, a removal): the holder of THAT
 * step — the first approver, then the second stored on the ask — or the Administrator in place of either.
 * The same predicate as the week's own.
 */
export function managerAskDeciderRole(
  viewer: PhoenixCrmViewer,
  row: { stage: ManagerPlanStage; approverHrId: string | null; secondApproverHrId: string | null; isTest: boolean },
): ManagerPlanDeciderRole | null {
  return managerPlanDeciderRole(viewer, { stage: row.stage, firstApproverHrId: row.approverHrId, secondApproverHrId: row.secondApproverHrId, isTest: row.isTest });
}

/** The refusal a decider reads when the step is not his. */
export function notYourManagerPlanStep(status: ManagerPlanStatus | null): ApiError {
  if (status === "first_approved") return forbiddenError("This week is waiting for its second approver, who decides this step.");
  if (status === "submitted") return forbiddenError("This week is waiting for the manager it was sent to, who decides it.");
  return forbiddenError("This week is not waiting for a decision. Reload the page.");
}
