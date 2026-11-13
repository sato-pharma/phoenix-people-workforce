import { getSupabaseAdmin } from "@/lib/supabase/server";
import { createSystemNotification } from "@/lib/notifications/system";
import { sendPunchFeedStalledTelegram } from "@/lib/attendance/punch-feed-stalled-telegram";
import { resolveNotificationRoleEnabled, resolveNotificationRoleRecipients } from "@/lib/notifications/role-recipients";
import {
  buildAttendanceCalendarContext,
  cairoTodayIso,
  classifyAttendanceDay,
  listIsoDatesInRange,
} from "@/lib/attendance/working-days";

const reportTimeZone = process.env.ATTENDANCE_REPORT_TIME_ZONE || "Africa/Cairo";

/** Maximum days we look back when counting missed working days. */
const LOOKBACK_CAP_DAYS = 60;

export type AttendanceIngestionHealth = {
  checkedAtIso: string;
  lastIngestedAgoHours: number | null;
  lastIngestedAt: string | null;
  lastIngestedLabel: string;
  /**
   * Fully-elapsed working days (through YESTERDAY) with zero punch ingestion.
   * Today is deliberately excluded: the daily check runs ~06:00 Cairo, before
   * the device has synced anything for the day.
   */
  missedWorkingDays: number;
  status: "healthy" | "warning" | "attention";
  todayIsWorkingDay: boolean;
};

function localDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: reportTimeZone,
    year: "numeric",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function shiftIsoDate(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function agoLabel(hours: number | null): string {
  if (hours == null) return "never";
  if (hours < 1) return "under 1 h ago";
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// This is a system health alert, not a per-employee workflow notification — there is no
// employee subject to resolve a recipient against (see the exact-key policy override in
// notifications/policy.ts), so the active Super Admins are named explicitly here via
// metadata.moduleOwnerHrIds, which permission_based honours without requiring a subject.
async function activeSuperAdminHrIds(): Promise<string[]> {
  const roles = await resolveNotificationRoleRecipients("attendance_ingestion_alert");
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id")
    .in("role", roles)
    .eq("is_active", true);
  if (error) return [];
  return ((data ?? []) as Array<{ hr_id?: string | null }>)
    .map((row) => row.hr_id)
    .filter((hrId): hrId is string => Boolean(hrId));
}

/**
 * Ingestion freshness of the fingerprint pipeline, derived from
 * attendance_raw_punches.ingested_at. Weekend/holiday aware: a device that is
 * silent over Friday/Saturday or a public holiday is healthy.
 *
 * (Distinct from checkAttendanceAgentHealth in local-agent.ts, which pings the
 * local agent's HTTP port on the dev machine.)
 */
export async function getAttendanceIngestionHealth(): Promise<AttendanceIngestionHealth> {
  const checkedAt = new Date();
  const todayIso = cairoTodayIso();
  const yesterdayIso = shiftIsoDate(todayIso, -1);

  const { data, error } = await getSupabaseAdmin()
    .from("attendance_raw_punches")
    .select("ingested_at")
    .order("ingested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Attendance ingestion lookup failed: ${error.message}`);

  const lastIngestedAt = (data as { ingested_at: string | null } | null)?.ingested_at ?? null;
  const lastIngestedDate = lastIngestedAt ? new Date(lastIngestedAt) : null;
  const lastIngestedAgoHours = lastIngestedDate
    ? Math.max(0, (checkedAt.getTime() - lastIngestedDate.getTime()) / 3_600_000)
    : null;

  const contextFrom = shiftIsoDate(todayIso, -LOOKBACK_CAP_DAYS);
  const context = await buildAttendanceCalendarContext({ dateFromIso: contextFrom, dateToIso: todayIso });
  const todayIsWorkingDay = classifyAttendanceDay({ context, dateIso: todayIso }).isExpectedWorkingDay;

  let missedWorkingDays = 0;
  if (!lastIngestedDate) {
    missedWorkingDays = 99;
  } else {
    const lastIngestedIso = localDateKey(lastIngestedDate);
    const countFrom = shiftIsoDate(lastIngestedIso, 1);
    const cappedFrom = countFrom > contextFrom ? countFrom : contextFrom;
    if (cappedFrom <= yesterdayIso) {
      for (const dateIso of listIsoDatesInRange(cappedFrom, yesterdayIso)) {
        // No title = office weekend policy (Friday + Saturday off): the office
        // device being silent on those days is normal.
        if (classifyAttendanceDay({ context, dateIso }).isExpectedWorkingDay) {
          missedWorkingDays += 1;
        }
      }
    }
  }

  const status: AttendanceIngestionHealth["status"] =
    missedWorkingDays >= 2 ? "attention" : missedWorkingDays === 1 ? "warning" : "healthy";

  return {
    checkedAtIso: checkedAt.toISOString(),
    lastIngestedAgoHours: lastIngestedAgoHours == null ? null : Math.round(lastIngestedAgoHours * 10) / 10,
    lastIngestedAt,
    lastIngestedLabel: agoLabel(lastIngestedAgoHours),
    missedWorkingDays,
    status,
    todayIsWorkingDay,
  };
}

/**
 * Company-wide device-outage dates within a range: expected working days
 * where literally NO employee has a punch (by punch_time, Cairo-local
 * calendar day) — a signal strong enough to trust, since it's implausible
 * every employee coincidentally skipped the device the same day. Used by the
 * weekly-digest generator's device-outage fail-safe (digest-reconcile.ts) so
 * a device/sync outage never becomes a false missing-punch or false
 * field-punch-anomaly for anyone.
 */
export async function getCompanyWideOutageDates(dateFromIso: string, dateToIso: string): Promise<Set<string>> {
  const context = await buildAttendanceCalendarContext({ dateFromIso, dateToIso });
  const expectedWorkingDates = listIsoDatesInRange(dateFromIso, dateToIso).filter(
    (dateIso) => classifyAttendanceDay({ context, dateIso }).isExpectedWorkingDay,
  );
  if (expectedWorkingDates.length === 0) return new Set();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_raw_punches")
    .select("punch_time")
    .gte("punch_time", `${dateFromIso}T00:00:00.000Z`)
    .lt("punch_time", `${shiftIsoDate(dateToIso, 1)}T00:00:00.000Z`);
  if (error) throw new Error(`Company-wide punch lookup failed: ${error.message}`);

  const datesWithAnyPunch = new Set(
    ((data ?? []) as Array<{ punch_time: string }>).map((row) => localDateKey(new Date(row.punch_time))),
  );

  return new Set(expectedWorkingDates.filter((dateIso) => !datesWithAnyPunch.has(dateIso)));
}

export type AttendanceIngestionAlertResult = {
  error?: string;
  notified: boolean;
  status: AttendanceIngestionHealth["status"] | "unknown";
  /** People newly told on Telegram by this run; 0 on every later run of the same Cairo day. */
  telegramDelivered?: number;
};

/**
 * Daily alert runner, piggybacked on scheduled notification processing (no
 * dedicated cron). The per-calendar-day idempotency key keeps repeated runs of
 * the scheduler from re-alerting. Never throws — outbox processing must not be
 * blocked by a failed health check.
 */
export async function runAttendanceIngestionAlert(): Promise<AttendanceIngestionAlertResult> {
  try {
    const health = await getAttendanceIngestionHealth();
    if (health.status === "healthy") {
      return { notified: false, status: health.status };
    }

    // An alert switched OFF in the admin console must stay SILENT, not fail loudly.
    //
    // Without this check the disabled path still built a notification, resolved its recipient
    // list to [] (resolveNotificationRoleRecipients returns [] when the policy is disabled),
    // and therefore tripped the fail-closed governance guard — writing one `skipped` row per
    // channel every single day with
    //   "Notification skipped because no exact authorized recipient was resolved."
    // That reads like a broken security control, not an admin preference. It is exactly what
    // happened here: the alert was disabled on 2026-07-24 and then logged a governance failure
    // nightly, which cost a full investigation before the cause turned out to be a toggle.
    //
    // resolveNotificationRoleEnabled exists for this — it lets a runner short-circuit BEFORE it
    // emits anything.
    if (!(await resolveNotificationRoleEnabled("attendance_ingestion_alert"))) {
      return { notified: false, status: health.status };
    }

    const missedLabel = health.missedWorkingDays >= 99
      ? "no punches have ever been ingested"
      : `${health.missedWorkingDays} working day(s) passed with zero punches ingested`;
    const message =
      `The fingerprint attendance agent appears to be down: ${missedLabel}. ` +
      `Last successful sync: ${health.lastIngestedLabel}. Payroll attendance data is falling behind.`;
    const superAdminHrIds = await activeSuperAdminHrIds();
    // Belt and braces: if the policy is enabled but resolves to nobody deliverable, emitting
    // would once again manufacture a fail-closed "skipped" row that looks like a security
    // failure. Log the real problem instead of dressing it up as one.
    if (superAdminHrIds.length === 0) {
      return {
        error: "Attendance ingestion alert is enabled but resolved no active recipient.",
        notified: false,
        status: health.status,
      };
    }

    const result = await createSystemNotification({
      actionUrl: "/attendance/device-user-mapping",
      actorId: "system",
      // Email retired 2026-08-08 at the owner's request. The alert itself stays — it is the only
      // automated signal that punch data has stopped flowing into payroll — but it now reaches
      // Super Admins in-app and by push only. The email added nothing: it was addressed
      // hr_notifications, i.e. the shared inbox, so it never named a person to act, and it fired
      // once every night for as long as an outage lasted.
      channels: ["in_app", "push"],
      eventType: "attendance_agent_ingestion_stalled",
      message,
      metadata: {
        idempotencyKey: `attendance-agent-ingestion:${cairoTodayIso()}`,
        lastIngestedAt: health.lastIngestedAt,
        missedWorkingDays: health.missedWorkingDays,
        moduleOwnerHrIds: superAdminHrIds,
      },
      module: "attendance",
      priority: health.status === "attention" ? "high" : "normal",
      title: "Attendance agent not syncing",
    });

    // The same alarm on Telegram (13 Nov 2026): in-app and push are read only by someone who has
    // Phoenix open, and a feed that stops is the fault that happens while nobody is looking. Its own
    // send with its own event, so the notice above keeps the channel list its tests pin. It never
    // throws and never emails — see punch-feed-stalled-telegram.ts.
    const telegram = await sendPunchFeedStalledTelegram({
      dayIso: cairoTodayIso(),
      lastIngestedAt: health.lastIngestedAt,
      missedWorkingDays: health.missedWorkingDays,
      priority: health.status === "attention" ? "high" : "normal",
    });

    const notified = result.deliveries.some((delivery) => delivery.status === "sent" || delivery.status === "pending");
    return { notified, status: health.status, telegramDelivered: telegram.delivered };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Attendance ingestion alert failed.",
      notified: false,
      status: "unknown",
    };
  }
}
