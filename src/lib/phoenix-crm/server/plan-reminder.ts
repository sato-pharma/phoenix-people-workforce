/**
 * Phoenix CRM — the "your coming week is not sent" reminder, sent.
 *
 * The I/O half of `src/lib/phoenix-crm/plan-reminder-rules.ts`, which holds the owner's words and the
 * when and to whom. This file reads the week's plans and delivers.
 *
 * 🔴 TEAMS THAT STARTED ONLY (owner, 2026-10-02). A team is the territories under one district
 * manager. It is reminded once ANY of its territories has real Phoenix CRM work
 * (`seatsWithRealActivity`, the 06:55 digest's own test). Every rep in that team is then reminded,
 * including one whose own first entries were wiped with the old plan screen on 2 October. A team
 * still on iReports360 hears nothing. It joins on its own the day one of its reps starts.
 *
 * 🔴 NEVER FIRED FROM A LAPTOP. It is a production cron. A hand-run spends the day's keys, so the
 * real tick it stands for stays silent for everyone it reached. Real territories only: the test
 * world has no reminder.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { phoenixCrmChannels } from "@/lib/notifications/phoenix-crm-channel-guard";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import {
  isUnsentStatus,
  managerReminder,
  planReminderDay,
  reminderTickOf,
  repReminder,
  territoriesOfStartedTeams,
  weekIsAllDaysOff,
  type PlanReminderDay,
  type PlanReminderNotice,
  type PlanReminderTick,
} from "@/lib/phoenix-crm/plan-reminder-rules";
import { seatIsInLiveTeam } from "@/lib/phoenix-crm/live-team-rules";
import { territoryReviewer } from "@/lib/phoenix-crm/scope";
import { seatsWithRealActivity } from "@/lib/phoenix-crm/server/daily-digest";
import { chunk, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadSeatsDaysOff } from "@/lib/phoenix-crm/server/leave-days";
import { loadLiveTeamSeatIds } from "@/lib/phoenix-crm/server/live-teams";
import { loadPlanHolidays } from "@/lib/phoenix-crm/server/plan-holidays";
import {
  PHOENIX_CRM_NOTIFICATION_CATEGORY,
  PHOENIX_CRM_NOTIFICATION_MODULE,
  PHOENIX_CRM_PORTAL_PATH,
} from "@/lib/phoenix-crm/server/notifications";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { loadPhoenixCrmConfig, openLineCodes } from "@/lib/phoenix-crm/server/settings";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** How many people are being sent their reminder at once. */
const DELIVERIES_AT_ONCE = 4;

export type PlanReminderRun = {
  /** Null when today is not a reminder day; the run then reads nothing and sends nothing. */
  weekStart: string | null;
  /** The 12:57 tick or the 17:57 one, which says "still". */
  tick: PlanReminderTick;
  late: boolean;
  /** Territories in an open line, with a rep, in a team that has started. */
  territories: number;
  unsent: number;
  reps: number;
  managers: number;
  delivered: number;
  failed: number;
  /** Territories with a rep whose team has not started: left alone, and counted so a quiet run reads as one. */
  waitingForFirstUse: number;
  /**
   * Reps whose whole week is days off — a public holiday or their own approved leave on every working
   * day — so the week holds no customer and the send would be refused `phoenix_crm:empty_plan`. They
   * are left out of BOTH notices, and counted here so a run that reaches fewer people than there are
   * unsent weeks says why (Golden Rule #1: never tell a rep to do what he cannot do).
   */
  cannotSend: number;
};

/** The hour it is in Cairo now, 0–23 — which of the day's two ticks a run is. */
function cairoHourNow(): number {
  const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Africa/Cairo" }).format(new Date());
  return Number(hour);
}

async function loadWeekStatuses(seatIds: ReadonlyArray<string>, weekStart: string): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();
  for (const part of chunk([...seatIds], 200)) {
    const read = await getSupabaseAdmin()
      .from("phoenix_crm_plans")
      .select("seat_id, status")
      .eq("is_test", false)
      .eq("week_start", weekStart)
      .in("seat_id", part);
    throwIfError(read.error);
    for (const row of (read.data ?? []) as Array<{ seat_id?: string | null; status?: string | null }>) {
      if (row.seat_id) statuses.set(String(row.seat_id), String(row.status ?? ""));
    }
  }
  return statuses;
}

async function deliver(notice: PlanReminderNotice): Promise<void> {
  const actionUrl = `${PHOENIX_CRM_PORTAL_PATH}/plan`;
  await createSystemNotificationForRecipients(
    {
      actionUrl,
      category: PHOENIX_CRM_NOTIFICATION_CATEGORY,
      // The guard's allowlist answers for every channel (email included since 2026-10-08), never this file.
      channels: phoenixCrmChannels("plan_reminder"),
      eventType: "plan_reminder",
      message: notice.message,
      metadata: { idempotencyKey: notice.idempotencyKey },
      module: PHOENIX_CRM_NOTIFICATION_MODULE,
      priority: "normal",
      subjectHrId: notice.hrId,
      telegram: { ctaLabel: "Open Plan", ctaUrl: actionUrl },
      title: notice.title,
    },
    [notice.hrId],
  );
}

/**
 * One pass. Never throws for a single failed delivery: one rep whose phone is unreachable must not
 * cost the rest of his team their reminder.
 */
export async function runPhoenixCrmPlanReminder(
  send: (notice: PlanReminderNotice) => Promise<void> = deliver,
  cairoToday: string = currentCairoDateOnlyIso(),
  tick: PlanReminderTick = reminderTickOf(cairoHourNow()),
): Promise<PlanReminderRun> {
  const day: PlanReminderDay | null = planReminderDay(cairoToday);
  const empty: PlanReminderRun = {
    weekStart: null,
    tick,
    late: false,
    territories: 0,
    unsent: 0,
    reps: 0,
    managers: 0,
    delivered: 0,
    failed: 0,
    waitingForFirstUse: 0,
    cannotSend: 0,
  };
  if (!day) return empty;

  const [org, config] = await Promise.all([loadPhoenixCrmOrg(), loadPhoenixCrmConfig()]);
  const openLines = openLineCodes(config.lineRollout, cairoToday);
  // A vacant territory has nobody to plan it, and a vacancy is never raised as a finding.
  const staffed = org.territories.filter((seat) => Boolean(seat.lineCode && openLines.has(seat.lineCode) && seat.occupantHrId));
  // Only a LIVE team is reminded (owner, 2026-10-08): activity alone — a Super Admin's try-out, a rep who
  // opened the app early — is not a start. An unreadable gate fails open (live-teams.ts). The two
  // questions do not depend on each other, so they are asked at once.
  const [started, live] = await Promise.all([seatsWithRealActivity(staffed.map((seat) => seat.seatId)), loadLiveTeamSeatIds(cairoToday)]);
  const seats = territoriesOfStartedTeams(org, staffed, started).filter((seat) => !live || seatIsInLiveTeam(seat, live));
  const statuses = await loadWeekStatuses(
    seats.map((seat) => seat.seatId),
    day.weekStart,
  );
  const stillToSend = seats.filter((seat) => isUnsentStatus(statuses.get(seat.seatId)));

  // 🔴 A WEEK HE CANNOT SEND IS NEVER CHASED (Golden Rule #1). A week whose every working day is a
  // public holiday or his own approved full-day leave holds no customer, and the send refuses an
  // empty plan — so "Due tonight, press Send" was an instruction he had no way to follow, and his
  // manager was told he had not sent it. The holidays are read ONCE for the week and the leave once
  // for every rep on the list; both readers fail OPEN (no days off), which reminds him, and that is
  // the safe direction.
  const weekEnd = addDaysIso(day.weekStart, 5);
  const [holidays, daysOffBySeat] = await Promise.all([
    loadPlanHolidays(day.weekStart, weekEnd),
    loadSeatsDaysOff(stillToSend, { from: day.weekStart, to: weekEnd }),
  ]);
  const unsent = stillToSend.filter(
    (seat) => !weekIsAllDaysOff(day.weekStart, new Set([...holidays.keys(), ...(daysOffBySeat.get(seat.seatId)?.keys() ?? [])])),
  );

  const names = await loadPeopleNames(unsent.map((seat) => seat.occupantHrId));
  const notices: PlanReminderNotice[] = [];
  const reps = new Set<string>();
  const byManager = new Map<string, string[]>();
  for (const seat of unsent) {
    const rep = seat.occupantHrId as string;
    if (!reps.has(rep)) {
      reps.add(rep);
      notices.push(repReminder({ hrId: rep, day, cairoToday, tick, draftStarted: statuses.has(seat.seatId) }));
    }
    const manager = territoryReviewer(org, seat.seatId)?.hrId;
    if (manager && manager !== rep) {
      const list = byManager.get(manager) ?? [];
      const name = nameOf(names, rep);
      if (!list.includes(name)) list.push(name);
      byManager.set(manager, list);
    }
  }
  let managers = 0;
  for (const [hrId, repNames] of byManager) {
    const notice = managerReminder({ hrId, day, cairoToday, tick, repNames });
    if (!notice) continue;
    managers += 1;
    notices.push(notice);
  }

  // Several people at once rather than one after another (Phoenix CRM performance audit, 2026-10-16).
  // A rep who also reviews another territory gets two notices, and his own two still go in their
  // order. Every send is still counted once, delivered or failed.
  const perPerson = new Map<string, PlanReminderNotice[]>();
  for (const notice of notices) perPerson.set(notice.hrId, [...(perPerson.get(notice.hrId) ?? []), notice]);
  let delivered = 0;
  let failed = 0;
  await mapWithConcurrency([...perPerson.values()], DELIVERIES_AT_ONCE, async (theirs) => {
    for (const notice of theirs) {
      try {
        await send(notice);
        delivered += 1;
      } catch (error) {
        failed += 1;
        logError("Phoenix CRM plan reminder could not be delivered", {
          error,
          labels: { event: "phoenix_crm_plan_reminder_failed", hrId: notice.hrId },
        });
      }
    }
  });

  return {
    weekStart: day.weekStart,
    tick,
    late: day.late,
    territories: seats.length,
    unsent: unsent.length,
    reps: reps.size,
    managers,
    delivered,
    failed,
    waitingForFirstUse: staffed.length - seats.length,
    cannotSend: stillToSend.length - unsent.length,
  };
}
