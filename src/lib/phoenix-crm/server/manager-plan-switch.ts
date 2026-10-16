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

import { seatIsInLiveTeam } from "@/lib/phoenix-crm/live-team-rules";
import { dmPlansInPhoenixCrmFor, managerPlanSeats } from "@/lib/phoenix-crm/manager-plan-rules";
import type { OrgIndex } from "@/lib/phoenix-crm/scope";
import { loadLiveTeamSeatIdsForDisplay } from "@/lib/phoenix-crm/server/live-teams";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";

export const DM_PLANS_IN_PHOENIX_CRM = "Forbidden: district managers plan in Phoenix CRM now. Open Phoenix CRM, then Plan.";

/** He plans his week in Phoenix CRM: a DM or acting DM seat whose team is live. */
export async function dmPlansInPhoenixCrm(hrId: string | null | undefined, options: { org?: OrgIndex; cairoToday?: string } = {}): Promise<boolean> {
  if (!hrId) return false;
  const org = options.org ?? (await loadPhoenixCrmOrg());
  const seats = managerPlanSeats(org, hrId);
  if (seats.length === 0) return false;
  const live = await loadLiveTeamSeatIdsForDisplay(options.cairoToday);
  if (live === null) return true;
  return dmPlansInPhoenixCrmFor(seats, (seat) => seatIsInLiveTeam(seat, live));
}
