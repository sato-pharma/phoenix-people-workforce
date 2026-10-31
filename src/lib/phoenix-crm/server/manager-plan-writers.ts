/**
 * Phoenix CRM — the planners who hold NO organogram seat, and who approves a manager's week.
 *
 * Owner, 2026-10-17: "Now do the same for the product managers and the national sales managers and the
 * regional manager." A district, regional or national sales manager is found on the organogram; a product
 * manager sits on none, so the people who plan as one are read here — every current holder of the Product
 * Manager or Group Product Manager role ("Rasha and Ahmed", "Both of them") with the manager his HR record
 * names, the person who reads his week and approves it first.
 *
 * 🔴 CURRENT EMPLOYEES ONLY. `app_auth_users.is_active` lags the HR record (a resigned product manager's
 * login stayed active on 17 Oct 2026), so a departed holder is dropped by `isTerminalEmploymentStatus` —
 * she neither plans a week nor appears in anybody's pick list.
 *
 * 🔴 IT NEVER TAKES THE MODULE DOWN, since every Phoenix CRM page builds its viewer through it. An unreadable
 * roster keeps the last one read on this server for up to fifteen minutes (nobody, past that or if none
 * was) rather than taking the Plan tab away from the product managers, and the reading link from their
 * managers, over a passing failure.
 *
 * Nothing here sends a notice, so `access.ts` may import it without closing a cycle.
 */

import { unstable_cache } from "next/cache";

import type { PhoenixRole } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { resolveHrIdsForRole } from "@/lib/notifications/role-recipients";
import { logWarning } from "@/lib/observability/log";
import { seatIsInLiveTeam } from "@/lib/phoenix-crm/live-team-rules";
import {
  ceoHrIdOf,
  legacyStyleApprovers,
  managerPlanApprovers,
  managerPlanScopes,
  managerWriterTerritories,
  PRODUCT_MANAGER_PLAN_ROLES,
  TRAINING_MANAGER_PLAN_ROLES,
  type ManagerApproverPair,
  type ManagerPlanScope,
  type ManagerPlanWriter,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { personKey, type OrgIndex, type OrgSeat } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { textOrNull } from "@/lib/phoenix-crm/server/db";
import { loadLiveTeamSeatIdsForDisplay } from "@/lib/phoenix-crm/server/live-teams";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** A product manager who plans here, and the manager his HR record names. */
export type ProductManagerPlanner = { hrId: string; managerHrId: string | null };

type Row = Record<string, unknown>;

async function readRoleRoster(roles: ReadonlySet<string>, purpose: string): Promise<ProductManagerPlanner[]> {
  // The role holders come through the shared resolver, as the SFE Managers do (`notifications.ts`): Phoenix
  // CRM's services read no login table of their own. It swallows a failed read into a warning, so any
  // warning is thrown here — the cache never keeps a degraded roster for five minutes.
  // Every role is asked at once (2026-10-31, "fix the slowest five pages"): on a cold cache they went one after
  // another. The holders are gathered, and a warning thrown, in the same role order as before.
  const answers = await Promise.all([...roles].map((role) => resolveHrIdsForRole(role as PhoenixRole, purpose)));
  const holders: string[] = [];
  for (const { hrIds, warnings } of answers) {
    if (warnings.length > 0) throw new Error(warnings.join("; "));
    holders.push(...hrIds);
  }
  const hrIds = [...new Set(holders.map((hrId) => personKey(hrId)).filter((id): id is string => id !== null))];
  if (hrIds.length === 0) return [];
  const { data: people, error: peopleError } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, employment_status, manager_hr_id")
    .in("hr_id", hrIds.flatMap((hrId) => hrIdLookupKeys(hrId)));
  if (peopleError) throw peopleError;
  // Every spelling of an id is asked for, so one person can come back as two rows: he plans once, under
  // the manager either row names.
  const byPerson = new Map<string, ProductManagerPlanner>();
  for (const row of (people ?? []) as Row[]) {
    const hrId = personKey(textOrNull(row.hr_id));
    if (!hrId || isTerminalEmploymentStatus(textOrNull(row.employment_status))) continue;
    const managerHrId = personKey(textOrNull(row.manager_hr_id));
    const known = byPerson.get(hrId);
    if (!known || (!known.managerHrId && managerHrId)) byPerson.set(hrId, { hrId, managerHrId });
  }
  return [...byPerson.values()].sort((left, right) => left.hrId.localeCompare(right.hrId));
}

const cachedProductManagerRoster = unstable_cache(
  () => readRoleRoster(PRODUCT_MANAGER_PLAN_ROLES, "Phoenix CRM — product managers who plan a week"),
  ["phoenix-crm-product-manager-planners-v1"],
  { revalidate: 300 },
);

/** The Training Manager's roster (owner, 2026-10-24) — read the same way, under its own key. */
const cachedTrainingManagerRoster = unstable_cache(
  () => readRoleRoster(TRAINING_MANAGER_PLAN_ROLES, "Phoenix CRM — the Training Manager who plans a week"),
  ["phoenix-crm-training-manager-planners-v1"],
  { revalidate: 300 },
);

/**
 * How long the last roster read stands in for one that cannot be read. Past it the answer is nobody, as
 * before there was a fallback: a product manager who has left must not go on planning through a long
 * outage, and two servers must not disagree for longer than this.
 */
const LAST_GOOD_ROSTER_MAX_AGE_MS = 15 * 60_000;

/** The roster as it last read, kept so a short failed read does not take the product managers' Plan tab away. */
let lastGoodProductManagerRoster: { roster: ProductManagerPlanner[]; readAt: number } | null = null;

/** Every product manager who plans a week here. Five minutes old at most; the last roster read, for up to fifteen minutes, when it cannot be read now. */
export async function loadProductManagerRoster(): Promise<ProductManagerPlanner[]> {
  try {
    const roster = await cachedProductManagerRoster();
    lastGoodProductManagerRoster = { roster, readAt: Date.now() };
    return roster;
  } catch (error) {
    logWarning("Phoenix CRM could not read the product managers who plan a week", {
      labels: { event: "phoenix_crm_product_manager_roster_failed" },
      error,
    });
  }
  const lastGood = lastGoodProductManagerRoster;
  return lastGood && Date.now() - lastGood.readAt <= LAST_GOOD_ROSTER_MAX_AGE_MS ? lastGood.roster : [];
}

let lastGoodTrainingManagerRoster: { roster: ProductManagerPlanner[]; readAt: number } | null = null;

/** Every Training Manager who plans a week here (Salma Labib, 2026-10-24), with the same fifteen-minute fallback. */
export async function loadTrainingManagerRoster(): Promise<ProductManagerPlanner[]> {
  try {
    const roster = await cachedTrainingManagerRoster();
    lastGoodTrainingManagerRoster = { roster, readAt: Date.now() };
    return roster;
  } catch (error) {
    logWarning("Phoenix CRM could not read the Training Manager who plans a week", {
      labels: { event: "phoenix_crm_training_manager_roster_failed" },
      error,
    });
  }
  const lastGood = lastGoodTrainingManagerRoster;
  return lastGood && Date.now() - lastGood.readAt <= LAST_GOOD_ROSTER_MAX_AGE_MS ? lastGood.roster : [];
}

/**
 * The manager one person's HR record names. A failed read throws: a week is never sent to a guess. 🔴 A
 * manager who has left, or who has no employees row at all, is not named — the HR record lags a
 * resignation, and a week sent to someone who can never decide it would wait for ever — so the week goes
 * on to the CEO (`legacyStyleApprovers`).
 */
async function managerOfRecord(hrId: string): Promise<string | null> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.from("employees").select("hr_id, manager_hr_id").in("hr_id", hrIdLookupKeys(hrId));
  if (error) throw error;
  let manager: string | null = null;
  for (const row of (data ?? []) as Row[]) {
    manager = personKey(textOrNull(row.manager_hr_id));
    if (manager) break;
  }
  if (!manager) return null;
  const { data: held, error: heldError } = await db.from("employees").select("hr_id, employment_status").in("hr_id", hrIdLookupKeys(manager));
  if (heldError) throw heldError;
  const rows = (held ?? []) as Row[];
  const present = rows.length > 0 && !rows.some((row) => isTerminalEmploymentStatus(textOrNull(row.employment_status)));
  return present ? manager : null;
}

/**
 * The scopes a regional, national or product manager plans in — none for a district manager, who plans his
 * own district. A vacant district only while its team is live (the minute-old copy: a display question).
 */
export async function managerWriterScopes(viewer: Pick<PhoenixCrmViewer, "org" | "cairoToday">, writer: ManagerPlanWriter): Promise<ManagerPlanScope[]> {
  if (writer.kind === "dm") return [];
  const live = await loadLiveTeamSeatIdsForDisplay(viewer.cairoToday);
  return managerPlanScopes(viewer.org, writer, (seat) => live === null || seatIsInLiveTeam(seat, live));
}

/**
 * Every territory a planner may name — his own district, or every territory of every scope he plans in.
 * Manager's own list, a single visit and his own visits are checked against this, never one district.
 */
export async function managerWriterReach(viewer: Pick<PhoenixCrmViewer, "org" | "cairoToday">, writer: ManagerPlanWriter): Promise<OrgSeat[]> {
  return managerWriterTerritories(viewer.org, writer, await managerWriterScopes(viewer, writer));
}

/**
 * Who approves this planner's week, his ask to edit it and his ask to take a customer off his own list.
 * A district manager: his seat's chain, never skipping the NSM after a regional manager (`managerPlanApprovers`).
 * Everyone else: "as today" — the manager on his HR record, then the CEO (`legacyStyleApprovers`).
 */
export async function managerApproversFor(org: OrgIndex, writer: ManagerPlanWriter): Promise<ManagerApproverPair> {
  if (writer.kind === "dm" && writer.seat) {
    const approvers = managerPlanApprovers(org, writer.seat.seatId);
    return { firstHrId: personKey(approvers.first?.hrId), secondHrId: personKey(approvers.secondHrId) };
  }
  return legacyStyleApprovers({ plannerHrId: writer.hrId, managerHrId: await managerOfRecord(writer.hrId), ceoHrId: ceoHrIdOf(org) });
}
