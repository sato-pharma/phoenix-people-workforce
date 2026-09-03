// Distributor files that have not arrived for the month just closed — and telling the people who
// can go and get them.
//
// WHY THIS EXISTS. The monthly closing is the only sales truth in this system, and it is assembled
// from eighteen distributor files that one person uploads by hand. Nothing watched them. Twenty-two
// other cron jobs run here — including two lateness nudges for marketing — and not one looked at
// the files the whole closing depends on, so the only way to learn that a file had not come was to
// open the Source of Sales screen and count. In July 2026 a month was built on four of its eighteen
// sources, 84% of its value absent, and every tab rendered immaculately; `source-coverage.ts` was
// written to make that visible AFTER the fact, and #2976 put the warning on the premium workbook.
// Both are read-only surfaces: somebody still has to look. This is the half that comes to you.
//
// WHAT COUNTS AS LATE — measured, not invented. Each distributor is judged against ITS OWN rhythm:
// the day of the following month that its previous file landed. July's files arrived between the
// 2nd and the 12th of August, spread over ten days, so a single company-wide deadline would either
// nag ten distributors that are on time or stay silent on the one that is genuinely late. January
// to June are deliberately NOT used to calibrate: all six were loaded in a single backfill exercise
// on 29 July and 5 August 2026 and describe an import project, not a monthly cadence.
//
// AUDIENCE. `distributor_upload_overdue_alert`, defaulting to Super Admin and SFE Manager — the two
// roles holding `sales:import`, which is what `/sales/upload` requires, so every recipient can act
// on the message rather than land on a redirect. Owner decision, asked directly: "sfe" and "You +
// Super Admins"; the uploader himself holds Super Admin, so the role list reaches him without a
// separate always-on leg that would deliver the same message to him twice.
//
// IN-APP, TELEGRAM AND PUSH ONLY — never email. House rule for lateness reminders since 2026-07-25,
// after an unactionable "critical" mail re-sent every morning for weeks.

import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotification, logNotificationSendFailure } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Exported so a test can assert the absence of email out loud rather than by inspection. */
export const DISTRIBUTOR_UPLOAD_OVERDUE_CHANNELS = ["in_app", "telegram", "push"] as const;

/** Its own event type: nothing else in this module means "a source file has not arrived". */
export const DISTRIBUTOR_UPLOAD_OVERDUE_EVENT_TYPE = "distributor_upload_overdue";

/** Editable at /admin/notification-recipients, so the audience moves without a deploy. */
export const DISTRIBUTOR_UPLOAD_OVERDUE_AUDIENCE = "distributor_upload_overdue_alert" as const;

/**
 * Where the message lands: the monthly upload wizard, which is the screen that fixes the problem.
 *
 * Checked against the gate rather than assumed — `/sales/upload` calls
 * `assertPermission(access, "sales", "import")`, and `sales:import` is held by exactly Super Admin
 * and SFE Manager, which is this job's whole default audience. The broader
 * `/admin/field-sales/source-of-sales` needs only `sales:read` and would admit more people, but it
 * is the dashboard: it shows the gap without offering the upload that closes it.
 */
export const DISTRIBUTOR_UPLOAD_OVERDUE_URL = "/sales/upload";

/**
 * The grace given to a distributor with no previous file to learn from.
 *
 * Set to the SLOWEST lag actually observed in the one month with a natural rhythm (Marcyrl, eleven
 * days), plus one. A new distributor has no history, and the cost of the two errors is not
 * symmetric: nudging late merely delays a message the recipient can act on immediately, while
 * nudging early trains the reader to dismiss this job — which is exactly how the marketing SLA
 * reminder had to be switched off in July 2026.
 */
export const FALLBACK_LAG_DAYS = 12;

export type DistributorUploadExpectation = {
  /** Distributor code as stored, upper-cased for comparison only. */
  code: string;
  /** Days late as of today. Zero or negative never appears — only overdue rows are returned. */
  daysOverdue: number;
  /** The date this month's file was expected, ISO date-only, Cairo. */
  expectedDate: string;
  /** How the expectation was derived, so the message can be honest about a guess. */
  basis: "own-history" | "peer-median" | "fallback";
  /** Human name — the standing rule is names, never codes, in both UI and message text. */
  name: string;
  /** What this distributor was worth in the previous month, which is the money now missing. */
  priorValue: number;
};

// ── Date helpers ──────────────────────────────────────────────────────────────────────────────
// Every input here is ALREADY a Cairo calendar date, so the arithmetic is plain calendar-day
// arithmetic done in UTC. That is deliberate and is the case AGENTS.md calls date-only: parsing a
// date-only value as UTC midnight is what stops the calendar day shifting, and using Cairo here
// would reintroduce the shift these strings were resolved to remove.

const DAY_MS = 86_400_000;

export function addDaysIso(iso: string, days: number): string {
  const at = new Date(`${iso}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export function daysBetweenIso(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

/** "2026-08" -> "2026-09-01": the first day a month's files can start arriving. */
export function followingMonthStart(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

/** "2026-08" -> "2026-07". */
export function priorPeriodOf(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/**
 * The month whose files are being collected today: the one that just ended.
 *
 * Always the previous calendar month, never the current one. That is not an approximation — the
 * closing golden rule forbids a closing being done or sent during the month it covers, so the
 * running month is never the one being chased.
 */
export function periodBeingCollected(todayIso: string): string {
  const [year, month] = todayIso.split("-").map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** One distributor's raw state, as the loader assembles it. Kept separate so the rule is pure. */
export type DistributorUploadRow = {
  code: string;
  name: string;
  /** Cairo date-only the CURRENT period's file landed, or null when it has not. */
  currentArrivedOn: string | null;
  /** Cairo date-only the PREVIOUS period's file landed, or null when there was none. */
  priorArrivedOn: string | null;
  priorValue: number;
};

/**
 * Which distributors are late, and by how much.
 *
 * Pure on purpose. `node --test` passes vacuously on this repo's suites — a file with no assertion
 * reports a pass for merely importing — so the rule has to be exercisable without a database for
 * its test to mean anything.
 */
export function buildOverdueDistributors(input: {
  period: string;
  rows: readonly DistributorUploadRow[];
  todayIso: string;
}): DistributorUploadExpectation[] {
  const { period, rows, todayIso } = input;
  const priorStart = followingMonthStart(priorPeriodOf(period));
  const currentStart = followingMonthStart(period);

  // Each distributor's own lag, and the peer median that stands in when it has none. The median is
  // taken over the SAME month, so a month where everyone ran late calibrates to itself.
  const lagByCode = new Map<string, number>();
  for (const row of rows) {
    if (!row.priorArrivedOn) continue;
    lagByCode.set(row.code, Math.max(0, daysBetweenIso(priorStart, row.priorArrivedOn)));
  }
  const peerMedian = medianOf([...lagByCode.values()]);

  const overdue: DistributorUploadExpectation[] = [];
  for (const row of rows) {
    if (row.currentArrivedOn) continue;
    const own = lagByCode.get(row.code);
    const basis: DistributorUploadExpectation["basis"] =
      own !== undefined ? "own-history" : peerMedian !== null ? "peer-median" : "fallback";
    const lag = own ?? peerMedian ?? FALLBACK_LAG_DAYS;
    const expectedDate = addDaysIso(currentStart, lag);
    const daysOverdue = daysBetweenIso(expectedDate, todayIso);
    if (daysOverdue <= 0) continue;
    overdue.push({ basis, code: row.code, daysOverdue, expectedDate, name: row.name, priorValue: row.priorValue });
  }

  // Biggest money first: the message is read top-down and the value is what decides which call to
  // make first. In August 2026 one distributor carried 87% of the whole gap.
  return overdue.sort((left, right) => right.priorValue - left.priorValue || right.daysOverdue - left.daysOverdue);
}

/** The message body. Names, never codes; no ellipsis; Cairo dates spelled as dates. */
export function overdueDistributorMessage(period: string, overdue: readonly DistributorUploadExpectation[]): string {
  const monthLabel = new Date(`${period}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  });
  const value = overdue.reduce((sum, one) => sum + one.priorValue, 0);
  const lines = overdue.map((one) => {
    const worth = one.priorValue > 0 ? `, worth ${Math.round(one.priorValue).toLocaleString("en-US")} EGP last month` : "";
    const guess = one.basis === "own-history" ? "" : " (expected date estimated — no file from this distributor last month)";
    return `• ${one.name} — ${one.daysOverdue} ${one.daysOverdue === 1 ? "day" : "days"} past ${one.expectedDate}${worth}${guess}`;
  });
  const head =
    overdue.length === 1
      ? `1 distributor file for ${monthLabel} is later than it was last month.`
      : `${overdue.length} distributor files for ${monthLabel} are later than they were last month.`;
  const tail =
    value > 0
      ? `\n\nTogether they carried ${Math.round(value).toLocaleString("en-US")} EGP last month. The closing understates every total until they arrive.`
      : "\n\nThe closing understates every total until they arrive.";
  return `${head}\n\n${lines.join("\n")}${tail}`;
}

// ── Loader ────────────────────────────────────────────────────────────────────────────────────

/**
 * Every active distributor, with when its file landed for this period and the previous one.
 *
 * `validated` is the only status that counts as arrived — the same test `getDistributorUploadStatus`
 * applies on the closing screen, so this job and that screen can never disagree about whether a
 * file is in. Codes are compared upper-cased: they are stored mixed-case in this schema, and an
 * exact-case comparison silently under-returns rather than erroring.
 */
export async function loadDistributorUploadRows(period: string): Promise<DistributorUploadRow[]> {
  const supabase = getSupabaseAdmin();
  const prior = priorPeriodOf(period);
  const [distRes, batchRes] = await Promise.all([
    supabase.from("source_of_sales_distributors").select("distributor_code,distributor_name").eq("active", true),
    supabase
      .from("source_of_sales_import_batches")
      .select("distributor_code,period,status,total_value,created_at")
      .in("period", [period, prior])
      .eq("status", "validated"),
  ]);
  if (distRes.error) throw distRes.error;
  if (batchRes.error) throw batchRes.error;

  const norm = (value: unknown) => String(value ?? "").trim().toUpperCase();
  type Batch = { created_at: string | null; distributor_code: string | null; period: string | null; total_value: number | null };

  const current = new Map<string, string>();
  const priorArrival = new Map<string, string>();
  const priorValue = new Map<string, number>();
  for (const row of (batchRes.data ?? []) as Batch[]) {
    const code = norm(row.distributor_code);
    if (!code || !row.created_at) continue;
    // The batch timestamp is a timestamptz; the rhythm being measured is a Cairo working day, so
    // the day is resolved in Cairo before any arithmetic touches it.
    const landedOn = currentCairoDateOnlyIso(new Date(row.created_at));
    const bucket = row.period === period ? current : priorArrival;
    const held = bucket.get(code);
    if (!held || landedOn < held) bucket.set(code, landedOn);
    if (row.period === prior) priorValue.set(code, (priorValue.get(code) ?? 0) + Number(row.total_value ?? 0));
  }

  return ((distRes.data ?? []) as { distributor_code: string | null; distributor_name: string | null }[])
    .map((row) => {
      const code = norm(row.distributor_code);
      if (!code) return null;
      return {
        code,
        currentArrivedOn: current.get(code) ?? null,
        name: String(row.distributor_name ?? "").trim() || code,
        priorArrivedOn: priorArrival.get(code) ?? null,
        priorValue: priorValue.get(code) ?? 0,
      } satisfies DistributorUploadRow;
    })
    .filter((row): row is DistributorUploadRow => row !== null);
}

/** True when the period has been locked, which means the closing is finished and chasing is over. */
export async function isPeriodLocked(period: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("monthly_sales_period_lock")
    .select("locked")
    .eq("period", period)
    .maybeSingle();
  if (error) throw error;
  return Boolean((data as { locked?: boolean } | null)?.locked);
}

export type DistributorUploadNudgeResult = {
  locked: boolean;
  notified: number;
  overdue: number;
  period: string;
  skipped: number;
  warnings: string[];
};

/**
 * Tell the audience which files are late, once a day.
 *
 * The idempotency key carries the Cairo date AND the summed days overdue, so a second run on the
 * same day re-sends nothing while tomorrow's larger figure still gets through. Suppressing
 * tomorrow's message would present a stale day count as a current one, and the day count is the
 * whole point of a lateness reminder.
 */
export async function runDistributorUploadOverdueNudge(
  todayIso: string = currentCairoDateOnlyIso(),
): Promise<DistributorUploadNudgeResult> {
  const period = periodBeingCollected(todayIso);
  const empty = { locked: false, notified: 0, overdue: 0, period, skipped: 0, warnings: [] as string[] };

  if (await isPeriodLocked(period)) return { ...empty, locked: true };

  const rows = await loadDistributorUploadRows(period);
  const overdue = buildOverdueDistributors({ period, rows, todayIso });
  if (overdue.length === 0) return empty;

  const { recipients, warnings } = await resolveNotificationPersonRecipients(
    DISTRIBUTOR_UPLOAD_OVERDUE_AUDIENCE,
    "Distributor upload overdue — recipients",
  );

  // An audience that resolves to nobody looks exactly like an audience with nothing to say, and
  // that is how a job runs green and unread for weeks — the outbox drain did precisely this for
  // thirteen days. Say it loudly instead of returning a clean result.
  if (recipients.length === 0) {
    logError("Distributor files are overdue but the audience resolved to nobody", {
      labels: { event: "distributor_upload_overdue_no_recipient", job: "distributor-upload-overdue-nudge" },
      error: new Error(
        `${overdue.length} overdue distributor files for ${period} had no recipient. Warnings: ${warnings.join("; ") || "none"}`,
      ),
    });
  }

  const message = overdueDistributorMessage(period, overdue);
  const totalDays = overdue.reduce((sum, one) => sum + one.daysOverdue, 0);
  let notified = 0;
  let skipped = 0;
  for (const recipient of recipients) {
    try {
      await createSystemNotification({
        actionUrl: DISTRIBUTOR_UPLOAD_OVERDUE_URL,
        channels: [...DISTRIBUTOR_UPLOAD_OVERDUE_CHANNELS],
        eventType: DISTRIBUTOR_UPLOAD_OVERDUE_EVENT_TYPE,
        message,
        metadata: {
          distributorCodes: overdue.map((one) => one.code),
          idempotencyKey: `distributor-upload-overdue:${period}:${todayIso}:${totalDays}:${recipient.hrId}`,
          overdueCount: overdue.length,
          period,
        },
        module: "sales",
        priority: "high",
        recipientHrId: recipient.hrId,
        recipientUserId: recipient.userId,
        subjectHrId: recipient.hrId,
        title:
          overdue.length === 1
            ? "A distributor file is late"
            : `${overdue.length} distributor files are late`,
      });
      notified += 1;
    } catch (error) {
      skipped += 1;
      logNotificationSendFailure("sales.runDistributorUploadOverdueNudge", error);
    }
  }

  return { locked: false, notified, overdue: overdue.length, period, skipped, warnings };
}
