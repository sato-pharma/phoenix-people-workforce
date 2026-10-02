/**
 * The first real weekly plan sent on a team that is NOT counted from Phoenix CRM — told to the Super
 * Admin, once per team (owner, 2026-10-02: "You get an in-app and Telegram notice the first time one of
 * its reps sends a real weekly plan").
 *
 * Since that ruling nothing starts a team but his own Start on the CRM hub (phoenix-team-starts.ts), so
 * a team whose reps have begun planning in Phoenix CRM would otherwise go on being counted from
 * iReports360 with nobody the wiser. This is how he hears of it:
 *
 *   - ONCE PER TEAM. The team's row in `phoenix_crm_team_start_notices` is claimed BEFORE anybody is
 *     told; a second send, a re-send, or two reps sending in the same second claim nothing and tell
 *     nobody.
 *   - REAL plans only. A test-world send never notifies anybody.
 *   - In-app, Telegram and the phone — `phoenixCrmChannels`, which never emails outside the five
 *     edit-request notices — naming the team (its manager, line and region), the rep and the week, with
 *     a link to the panel where he presses Start.
 *   - NEVER FAILS OR SLOWS THE SEND: the submit route runs it after the answer has gone (`after()`), and
 *     every failure is caught and logged here.
 */

import {
  PHOENIX_CRM_TEAM_START_NOTICES_TABLE,
  PHOENIX_CRM_TEAM_STARTS_TABLE,
  PHOENIX_TEAM_NOT_STARTED_EVENT,
  PHOENIX_TEAM_STARTS_PANEL_PATH,
  teamNotStartedNotice,
} from "@/lib/crm/phoenix-team-starts";
import { phoenixCrmChannels } from "@/lib/notifications/phoenix-crm-channel-guard";
import { resolveHrIdsForRole } from "@/lib/notifications/role-recipients";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { PHOENIX_CRM_NOTIFICATION_CATEGORY, PHOENIX_CRM_NOTIFICATION_MODULE } from "@/lib/phoenix-crm/server/notifications";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { getSupabaseAdmin } from "@/lib/supabase/server";

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return Boolean(error && (error.code === "23505" || /duplicate key|unique constraint/i.test(error.message ?? "")));
}

/**
 * After a weekly plan is sent: tell the Super Admin if this is the first real plan on a team with no
 * start. Never throws.
 */
export async function noticeFirstPlanOnUnstartedTeam(planId: string): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    const { data: plan, error: planError } = await supabase
      .from("phoenix_crm_plans")
      .select("id, seat_id, week_start, status, is_test, submitted_by_hr_id")
      .eq("id", planId)
      .maybeSingle();
    if (planError) throw planError;
    const row = plan as Record<string, unknown> | null;
    // A test-world send tells nobody; only a plan that went for review counts as sent.
    if (!row || row.is_test === true || row.status !== "submitted") return;

    const org = await loadPhoenixCrmOrg();
    const seat = org.seats.get(String(row.seat_id));
    const teamSeatId = seat?.parentSeatId ?? null;
    if (!seat || !teamSeatId) return;

    // A team with a start — running, still to come, or stopping after this week begins — is already in
    // his hands.
    const weekStart = String(row.week_start ?? "").slice(0, 10);
    const { data: starts, error: startsError } = await supabase
      .from(PHOENIX_CRM_TEAM_STARTS_TABLE)
      .select("starts_on, stops_on")
      .eq("team_seat_id", teamSeatId);
    if (startsError) throw startsError;
    const hasStart = ((starts ?? []) as Array<{ starts_on: string; stops_on: string | null }>).some(
      (start) => start.stops_on === null || String(start.stops_on).slice(0, 10) > weekStart,
    );
    if (hasStart) return;

    const repHrId = typeof row.submitted_by_hr_id === "string" ? row.submitted_by_hr_id : (seat.occupantHrId ?? null);
    // THE CLAIM: one row per team, ever. Whoever inserts it tells; everyone after it is told nothing.
    const { error: claimError } = await supabase
      .from(PHOENIX_CRM_TEAM_START_NOTICES_TABLE)
      .insert({ team_seat_id: teamSeatId, plan_id: String(row.id), rep_hr_id: repHrId, week_start: weekStart });
    if (claimError) {
      if (isUniqueViolation(claimError)) return;
      throw claimError;
    }

    const team = org.seats.get(teamSeatId) ?? null;
    const names = await loadPeopleNames([repHrId, team?.occupantHrId ?? null]);
    const manager = team?.occupantHrId ? nameOf(names, team.occupantHrId, "") : "";
    const teamName = [manager || (team ? "The district manager seat (vacant)" : "A team"), team?.lineName ?? null, team?.regionName ?? null]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    const { title, message } = teamNotStartedNotice({
      team: teamName,
      repName: repHrId ? nameOf(names, repHrId, "A rep") : "A rep",
      weekStart,
    });
    const recipients = await resolveHrIdsForRole("Super Admin", "Phoenix CRM team not started");
    await createSystemNotificationForRecipients(
      {
        actionUrl: PHOENIX_TEAM_STARTS_PANEL_PATH,
        category: PHOENIX_CRM_NOTIFICATION_CATEGORY,
        channels: phoenixCrmChannels(PHOENIX_TEAM_NOT_STARTED_EVENT),
        eventType: PHOENIX_TEAM_NOT_STARTED_EVENT,
        message,
        metadata: { idempotencyKey: `phoenix_crm:team_not_started:${teamSeatId}`, seatId: teamSeatId, planId: String(row.id) },
        module: PHOENIX_CRM_NOTIFICATION_MODULE,
        priority: "normal",
        recordId: String(row.id),
        subjectHrId: repHrId,
        telegram: { ctaLabel: "Open the CRM page", ctaUrl: PHOENIX_TEAM_STARTS_PANEL_PATH },
        title,
      },
      recipients.hrIds,
    );
  } catch (error) {
    logError("Phoenix CRM team-not-started notice failed", {
      labels: { event: "phoenix_crm_team_not_started_notice_failed", planId },
      error,
    });
  }
}
