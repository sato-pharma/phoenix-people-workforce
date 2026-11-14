/**
 * Phoenix CRM — WHICH district managers plan their week here instead of on the legacy Weekly/Monthly form
 * (owner, 2026-10-16: "replace the old DM plan"; "Mohamed Alaa stays on the old plan until his team
 * starts").
 *
 * The rule is `dmPlansInPhoenixCrmFor` (manager-plan-rules.ts): he holds a DM or acting DM seat AND that
 * seat's team is live — a `phoenix_crm_team_starts` row the Super Admin pressed Start on, with no stop
 * yet in effect. Each district manager switches by himself the day his own team starts; nothing here is
 * a date or a list of names.
 *
 * 🔴 AN UNREADABLE START TABLE FAILS OPEN, like every live-team read (`server/live-teams.ts`): 18 of the
 * 19 district managers' teams were live when this was built, so "Phoenix CRM" is the right answer for
 * almost everyone, and the one it is wrong for still has the legacy form's history to read.
 *
 * Read through the minute-old copy (`loadLiveTeamSeatIdsForDisplay`): this decides which screen opens and
 * which form refuses a new plan — a display question, never whether anybody is told something.
 */

import { owesAWeeklyPlan } from "@/lib/daily-deductions/no-weekly-plan-select";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { seatHasLiveTeamBelow, seatIsInLiveTeam } from "@/lib/phoenix-crm/live-team-rules";
import {
  dmPlansInPhoenixCrmFor,
  isSeatlessPlannerKind,
  managerOwnVisitClosed,
  managerPlanSeats,
  managerPlanWriterOf,
  seniorPlanSeats,
} from "@/lib/phoenix-crm/manager-plan-rules";
import type { OrgIndex } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadLiveTeamSeatIdsForDisplay } from "@/lib/phoenix-crm/server/live-teams";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const DM_PLANS_IN_PHOENIX_CRM = "Forbidden: your week is planned in Phoenix CRM now. Open Phoenix CRM, then Plan.";

/**
 * ⚠️ SINCE 14 NOV 2026 THE LEGACY FORM IS CLOSED TO EVERYONE (DR-02, weekly-planning/legacy-closed.ts), and
 * the no-weekly-plan deduction finds his week in Phoenix CRM too, so nobody files both any more. This rule
 * is left as it was: it only matters to a product manager who also holds a district seat, and there is none.
 *
 * 🔴 Whoever still OWES a legacy weekly plan keeps the legacy form, whatever seat he holds. The
 * no-weekly-plan deduction charges a Product Manager or a Group Product Manager a day for every week
 * with no plan on that form (`owesAWeeklyPlan`, read from `employees.job_title` exactly as the charge
 * reads it), so refusing him the form while the charge still runs would take a day's pay for a plan he
 * was not allowed to file. A failed read throws: every caller already decides what "unknown" means.
 */
async function owesTheLegacyWeeklyPlan(hrId: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin().from("employees").select("hr_id, job_title").in("hr_id", hrIdLookupKeys(hrId));
  if (error) throw error;
  return ((data ?? []) as Array<{ job_title: string | null }>).some((row) => owesAWeeklyPlan(row.job_title));
}

/**
 * He plans his week in Phoenix CRM: a DM or acting DM seat whose team is live, or a regional or national
 * seat with a live team below it (owner, 2026-10-17) — unless his title still owes the legacy plan.
 */
export async function dmPlansInPhoenixCrm(hrId: string | null | undefined, options: { org?: OrgIndex; cairoToday?: string } = {}): Promise<boolean> {
  if (!hrId) return false;
  const org = options.org ?? (await loadPhoenixCrmOrg());
  const seats = managerPlanSeats(org, hrId);
  if (seats.length === 0) return seniorPlansInPhoenixCrm(org, hrId, options.cairoToday);
  // The title read and the live-team read are independent, so they run side by side (performance brief,
  // 2026-10-23): this answers the sidebar row on every portal page. The title still wins over the live team.
  const [owes, live] = await Promise.all([owesTheLegacyWeeklyPlan(hrId), loadLiveTeamSeatIdsForDisplay(options.cairoToday)]);
  if (owes) return false;
  if (live === null) return true;
  return dmPlansInPhoenixCrmFor(seats, (seat) => seatIsInLiveTeam(seat, live));
}

/**
 * 🔴 A REGIONAL OR NATIONAL SALES MANAGER SWITCHES ONCE ANY TEAM BELOW HIS SEAT IS LIVE (owner, 2026-10-17:
 * "Now do the same for … the national sales managers and the regional manager") — his week is planned on
 * the teams below him, so it moves with the first of them. A product manager NEVER switches: the
 * no-weekly-plan deduction still reads his legacy form (`owesAWeeklyPlan`), so he files both, and the
 * legacy title rule below keeps that true whatever seat he holds. An unreadable start table fails open.
 */
async function seniorPlansInPhoenixCrm(org: OrgIndex, hrId: string, cairoToday: string | undefined): Promise<boolean> {
  const seats = seniorPlanSeats(org, hrId);
  if (seats.length === 0) return false;
  const [owes, live] = await Promise.all([owesTheLegacyWeeklyPlan(hrId), loadLiveTeamSeatIdsForDisplay(cairoToday)]);
  if (owes) return false;
  if (live === null) return true;
  return seats.some((seat) => seatHasLiveTeamBelow(org.seats, seat.seatId, live));
}

/**
 * He has a manager's week to plan on the Phoenix CRM board: a district, regional or national sales manager
 * once his switch is on (`dmPlansInPhoenixCrm`), and a product manager ALWAYS — he files both (owner,
 * 2026-10-17), so his board opens beside the legacy form instead of replacing it, and the legacy form's
 * refusal, which asks `dmPlansInPhoenixCrm`, never reaches him.
 */
export async function plansManagerWeekHere(
  viewer: Pick<PhoenixCrmViewer, "org" | "hrId" | "cairoToday" | "plansAsProductManager"> & Partial<Pick<PhoenixCrmViewer, "plansAsTrainingManager">>,
): Promise<boolean> {
  const writer = managerPlanWriterOf(viewer.org, viewer.hrId, {
    productManager: viewer.plansAsProductManager === true,
    trainingManager: viewer.plansAsTrainingManager === true,
  });
  if (!writer) return false;
  // A product manager and the Training Manager (owner, 2026-10-24) always plan here, beside the legacy form.
  if (isSeatlessPlannerKind(writer.kind)) return true;
  return dmPlansInPhoenixCrm(viewer.hrId, { org: viewer.org, cairoToday: viewer.cairoToday });
}

/**
 * 🔴 THE OLD "MY OWN VISIT" CLOSES ONLY FOR A DISTRICT MANAGER WHO PLANS HERE — the seat test
 * (`managerOwnVisitClosed`) AND this switch. One still on the legacy form (Mohamed Alaa Eleiwa until his
 * team starts) has no "My single visits" to log in instead, so closing it there would leave a visit he
 * made alone nowhere to go. An unreadable answer keeps the option open: a refused save loses a real visit.
 */
export async function managerOwnVisitClosedNow(viewer: Pick<PhoenixCrmViewer, "org" | "hrId" | "cairoToday">): Promise<boolean> {
  if (!managerOwnVisitClosed(viewer.org, viewer.hrId)) return false;
  return dmPlansInPhoenixCrm(viewer.hrId, { org: viewer.org, cairoToday: viewer.cairoToday }).catch(() => false);
}
