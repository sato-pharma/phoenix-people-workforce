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
 * 🔴 IT FAILS OPEN TO NOBODY. An unreadable roster leaves the product managers without the Plan tab for a
 * minute; it never takes the whole module down, since every Phoenix CRM page builds its viewer through it.
 *
 * Nothing here sends a notice, so `access.ts` may import it without closing a cycle.
 */

import { unstable_cache } from "next/cache";

import type { PhoenixRole } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
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

async function readProductManagerRoster(): Promise<ProductManagerPlanner[]> {
  // The role holders come through the shared resolver, as the SFE Managers do (`notifications.ts`): Phoenix
  // CRM's services read no login table of their own. It swallows a failed read into a warning, so any
  // warning is thrown here — the cache never keeps a degraded roster for five minutes.
  const holders: string[] = [];
  for (const role of PRODUCT_MANAGER_PLAN_ROLES) {
    const { hrIds, warnings } = await resolveHrIdsForRole(role as PhoenixRole, "Phoenix CRM — product managers who plan a week");
    if (warnings.length > 0) throw new Error(warnings.join("; "));
    holders.push(...hrIds);
  }
  const hrIds = [...new Set(holders.map((hrId) => personKey(hrId)).filter((id): id is string => id !== null))];
  if (hrIds.length === 0) return [];
  const { data: people, error: peopleError } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, employment_status, manager_hr_id")
    .in("hr_id", hrIds);
  if (peopleError) throw peopleError;
  const out: ProductManagerPlanner[] = [];
  for (const row of (people ?? []) as Row[]) {
    const hrId = personKey(textOrNull(row.hr_id));
    if (!hrId || isTerminalEmploymentStatus(textOrNull(row.employment_status))) continue;
    out.push({ hrId, managerHrId: personKey(textOrNull(row.manager_hr_id)) });
  }
  return out.sort((left, right) => left.hrId.localeCompare(right.hrId));
}

const cachedProductManagerRoster = unstable_cache(readProductManagerRoster, ["phoenix-crm-product-manager-planners-v1"], { revalidate: 300 });

/** Every product manager who plans a week here. Five minutes old at most; nobody when it cannot be read. */
export async function loadProductManagerRoster(): Promise<ProductManagerPlanner[]> {
  try {
    return await cachedProductManagerRoster();
  } catch (error) {
    logWarning("Phoenix CRM could not read the product managers who plan a week", {
      labels: { event: "phoenix_crm_product_manager_roster_failed" },
      error,
    });
    return [];
  }
}

/** The manager one person's HR record names. A failed read throws: a week is never sent to a guess. */
async function managerOfRecord(hrId: string): Promise<string | null> {
  const ids = [...new Set([hrId, hrId.toUpperCase()])];
  const { data, error } = await getSupabaseAdmin().from("employees").select("hr_id, manager_hr_id").in("hr_id", ids);
  if (error) throw error;
  for (const row of (data ?? []) as Row[]) {
    const manager = personKey(textOrNull(row.manager_hr_id));
    if (manager) return manager;
  }
  return null;
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
