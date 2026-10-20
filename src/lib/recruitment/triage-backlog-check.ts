// Recruitment / ATS — CVs that arrived and that nobody has looked at yet.
//
// Measured in production on 2026-08-29: 313 of 455 candidates sat at status `new` — whose own
// definition in `candidate-status.ts` is "Arrived. Nobody has looked at them yet." — and 51 of them
// had been there 36 days. All 313 had a CV attached and all 313 had already been read by the
// extraction pipeline, so nothing was blocked on the machine; every one was waiting on a human.
//
// Nothing anywhere reported that. The recruitment module had three notification paths and not one
// of them could see this queue:
//
//   - `inbound/cv-intake-digest-6h.ts` filters on `manager_notified_at`, so it only reports CVs
//     already pushed to a manager — a candidate at `new` has by definition never been pushed.
//   - `inbound/daily-cv-digest.ts` counts `awaitingReview`, but only within a 36-hour lookback on
//     `created_at`. On a quiet day it truthfully reports "3 awaiting" while 313 sit behind it.
//   - `stale-send-check.ts` watches the stage AFTER triage.
//
// The standing depth existed in exactly one place: the `notYetReviewed` tile on the recruitment
// workspace, which is a PULL surface — it tells you 313 only if you already opened the screen.
//
// That is the same shape `stale-send-check.ts` was written for the day before, and the same shape as
// the 2026-08-14 outbox freeze: a pipeline that looks healthy from every angle while work piles up,
// because nobody was asking the question. This asks it for the front door.
//
// THIS ALARM WILL FIRE EVERY DAY UNTIL THE BACKLOG IS WORKED, AND THAT IS CORRECT — the condition
// is real and 252 people are actually waiting. It is not a transient to be silenced by raising the
// threshold. What stops it is triaging the queue, and it goes quiet on its own the moment nothing is
// older than the threshold. To keep a daily alarm readable rather than wallpaper it is deliberately
// ONE notification per Cairo day, a summary rather than 252 names, and `normal` priority.
//
// NEVER EMAIL — see TRIAGE_BACKLOG_CHANNELS.
//
// Pure classifier plus async loader, the split `stale-send-check.ts` uses and for the same reason:
// the rule that decides what is overdue is worth testing without a database, and `now` is a
// parameter so the thresholds can be tested against a fixed clock.

import { cairoTodayIso } from "@/lib/attendance/working-days";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { recruitmentDeskAlertRoles } from "@/lib/recruitment/access";
import { DEFAULT_CANDIDATE_STATUS } from "@/lib/recruitment/candidate-status";
// Borrowed rather than copied. Both are pure, both already exported, and a second floored-day
// helper that rounds differently from the first is exactly how two alarms come to disagree about
// what "waiting 7 days" means.
import { cairoDateLabel, daysWaiting } from "@/lib/recruitment/stale-send-check";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { workspaceHref } from "@/lib/recruitment/workspace/links";

/**
 * How long a CV may sit unlooked-at before the recruitment desk is told.
 *
 * SEVEN DAYS IS THE OWNER'S OWN CALL, made on 2026-08-29 when he was shown the measured queue —
 * 313 waiting, 51 of them past a month — and asked what the threshold should be. He answered
 * "7 days, recruitment desk". Do not lower it because the backlog looks urgent, and do not raise it
 * because the alarm fires daily; the daily firing is the queue being real, not the threshold being
 * wrong. Changing it needs him to say so.
 *
 * It matches STALE_SEND_ESCALATE_AFTER_DAYS by coincidence of judgement, not by dependency. The two
 * stages are answered by different people and either number can move without the other.
 */
export const TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS = 7;

/**
 * IN-APP, TELEGRAM AND PUSH ONLY — never email, and exported so a test can assert it out loud.
 *
 * Bulk email is never fired from this system, and this job runs every day: an emailed daily backlog
 * report is a subscription nobody asked for. Passed explicitly rather than left to the notification
 * policy table, so a later policy edit cannot quietly put email back onto a recurring job.
 */
export const TRIAGE_BACKLOG_CHANNELS = ["in_app", "telegram", "push"] as const;

/**
 * Where the desk lands — the workspace filtered to the same queue this counts (status New), so the
 * tab counts under the filter say where the waiting CVs are.
 */
export const TRIAGE_BACKLOG_ACTION_URL = workspaceHref({ statuses: [DEFAULT_CANDIDATE_STATUS] });

/** The age bands the summary reports, longest first. `from` is inclusive, `to` exclusive. */
const AGE_BANDS: ReadonlyArray<{ from: number; label: string; to: number }> = [
  { from: 30, label: "30 or more days", to: Number.POSITIVE_INFINITY },
  { from: 21, label: "21 to 29 days", to: 30 },
  { from: 14, label: "14 to 20 days", to: 21 },
  { from: TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS, label: "7 to 13 days", to: 14 },
];

/** One candidate sitting at `new`, narrowed to what the rule reads. */
export type UntriagedApplicant = {
  /** False when neither a phone number nor an email address is on file. */
  contactable: boolean;
  id: string;
  /** ISO instant the wait started — see `loadUntriagedApplicants` for why it is not always arrival. */
  waitingSince: string;
};

export type TriageBacklogBand = { count: number; label: string };

export type TriageBacklogSummary = {
  bands: TriageBacklogBand[];
  longestWaitDays: number;
  /** The instant the longest-waiting candidate started waiting, or null when nothing is overdue. */
  longestWaitSince: string | null;
  /** Crossed the threshold within the last day — the part of the queue that is new information. */
  newlyOverdue: number;
  overdue: number;
  /** Overdue AND unreachable: no threshold will ever produce an answer from them. */
  uncontactableOverdue: number;
  /** Waiting, but not yet past the threshold. Reported for context, never alarmed on. */
  withinThreshold: number;
};

/**
 * Split the untriaged queue into what is overdue and what is merely waiting.
 *
 * Takes the whole `new` queue rather than a pre-filtered one so that `withinThreshold` is honest:
 * a summary that said "252 overdue" without knowing the queue is 313 deep would read as though the
 * other 61 did not exist.
 */
export function summarizeTriageBacklog(
  applicants: readonly UntriagedApplicant[],
  now: Date,
): TriageBacklogSummary {
  let overdue = 0;
  let newlyOverdue = 0;
  let uncontactableOverdue = 0;
  let withinThreshold = 0;
  let longestWaitDays = 0;
  let longestWaitSince: string | null = null;
  const bandCounts = new Map<string, number>();

  for (const applicant of applicants) {
    const waited = daysWaiting(applicant.waitingSince, now);
    if (waited < TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS) {
      withinThreshold += 1;
      continue;
    }

    overdue += 1;
    if (!applicant.contactable) uncontactableOverdue += 1;
    // Exactly one day wide: a candidate is "newly overdue" on the single day they cross, so the
    // number answers "what changed today" instead of restating the backlog.
    if (waited < TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS + 1) newlyOverdue += 1;
    if (waited > longestWaitDays) {
      longestWaitDays = waited;
      longestWaitSince = applicant.waitingSince;
    }

    const band = AGE_BANDS.find((entry) => waited >= entry.from && waited < entry.to);
    if (band) bandCounts.set(band.label, (bandCounts.get(band.label) ?? 0) + 1);
  }

  return {
    // Declaration order, longest band first, and empty bands dropped rather than printed as zero.
    bands: AGE_BANDS.map((band) => ({ count: bandCounts.get(band.label) ?? 0, label: band.label })).filter(
      (band) => band.count > 0,
    ),
    longestWaitDays,
    longestWaitSince,
    newlyOverdue,
    overdue,
    uncontactableOverdue,
    withinThreshold,
  };
}

/** Plural without the "(s)" that makes a message look machine-written. */
function count(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

/**
 * Pure message builder — no IO, so the wording is unit-testable.
 *
 * A SUMMARY, NOT A LIST OF NAMES, and deliberately so: `inbound/daily-cv-digest.ts` settled this
 * question for this module already — the digest answers "is there work waiting, and what kind", and
 * the names are one click away on a screen built to show them. Naming 252 people in a Telegram
 * message would be unreadable, and cutting the list short would need the ellipsis the owner has
 * ruled out. Every number here is printed in full for the same reason.
 */
export function buildTriageBacklogMessage(summary: TriageBacklogSummary): string {
  const lines: string[] = [
    `${count(summary.overdue, "CV")} ${summary.overdue === 1 ? "has" : "have"} been waiting more than ${count(TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS, "day")} for a first look.`,
    "",
    ...summary.bands.map((band) => `• ${band.label} — ${band.count}`),
  ];

  if (summary.longestWaitSince) {
    lines.push(
      "",
      `The longest has waited ${count(summary.longestWaitDays, "day")}, since ${cairoDateLabel(summary.longestWaitSince)}.`,
    );
  }

  if (summary.newlyOverdue > 0) {
    lines.push(`${count(summary.newlyOverdue, "CV")} crossed ${TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS} days today.`);
  }

  if (summary.uncontactableOverdue > 0) {
    lines.push(
      `${summary.uncontactableOverdue} of them ${summary.uncontactableOverdue === 1 ? "has" : "have"} neither a phone number nor an email address on file.`,
    );
  }

  if (summary.withinThreshold > 0) {
    lines.push(
      "",
      `${count(summary.withinThreshold, "other CV")} ${summary.withinThreshold === 1 ? "is" : "are"} waiting but not yet past ${TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS} days.`,
    );
  }

  return lines.join("\n");
}

/** How many rows one PostgREST page asks for. Below the 1000-row ceiling on an unbounded select. */
const PAGE_SIZE = 500;

/**
 * Every candidate still sitting at `new`.
 *
 * PAGED, NOT A BARE SELECT. An unbounded PostgREST `.select()` stops at 1000 rows with no error and
 * no marker, which here would silently under-report the very number the alarm exists to report —
 * and it would do so only once the backlog grew past 1000, which is exactly when the alarm matters
 * most. The explicit `.order()` is part of that: paging without a stable sort can repeat and skip
 * rows across pages.
 *
 * The wait starts at `status_changed_at` when there is one, else `created_at`. Measured on
 * 2026-08-29, ZERO of the 313 rows at `new` carried a `status_changed_at`, so today the two are the
 * same — but a candidate moved BACK to `new` has genuinely just been handed to a human again, and
 * charging them for the wait before that would report a stale age as a fresh failure.
 *
 * `phone` and `email` are read only to reduce them to one boolean, and neither value is kept: the
 * summary needs to know that somebody is unreachable, never how to reach them, and the notification
 * this feeds must not carry contact details it has no use for.
 */
export async function loadUntriagedApplicants(): Promise<UntriagedApplicant[]> {
  const supabase = getSupabaseAdmin();
  const applicants: UntriagedApplicant[] = [];

  for (let page = 0; ; page += 1) {
    const { data, error } = await supabase
      .from("ats_candidates")
      .select("id,created_at,status_changed_at,phone,email")
      .eq("status", DEFAULT_CANDIDATE_STATUS)
      .order("created_at", { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (error) {
      logError("Triage backlog check could not read the untriaged queue.", {
        error,
        labels: { event: "recruitment_triage_backlog_load_failed" },
      });
      // Partial pages are discarded rather than reported: an under-count here reads as "the desk
      // caught up" and is worse than no alarm at all.
      return [];
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = String(row.id ?? "").trim();
      const waitingSince =
        String(row.status_changed_at ?? "").trim() || String(row.created_at ?? "").trim();
      if (!id || !waitingSince) continue;
      applicants.push({
        contactable:
          String(row.phone ?? "").trim().length > 0 || String(row.email ?? "").trim().length > 0,
        id,
        waitingSince,
      });
    }

    if (rows.length < PAGE_SIZE) return applicants;
  }
}

/**
 * The recruitment desk — the people who can actually triage this queue.
 *
 * `recruitmentDeskAlertRoles` (the Super Admin; the Talent Acquisition seat is deliberately NOT on it
 * since 2026-10-16, her notification center holds only a new CV, an interview request and an accepted
 * offer) is the same audience `stale-send-check.ts` escalates to and the same one
 * `inbound/recruitment-notify.ts` tells about its other alerts, so this lands with the people already
 * watching the pipeline rather than inventing a new audience. Do NOT
 * read the role named "Talent Acquisition" into this — it was retired on 2026-08-28 and holds
 * nobody.
 */
async function recruitmentDeskHrIds(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("hr_id")
    .in("role", recruitmentDeskAlertRoles as unknown as string[]);
  if (error) {
    logError("Triage backlog check could not resolve the recruitment desk recipients.", {
      error,
      labels: { event: "recruitment_triage_backlog_recipients_failed" },
    });
    return [];
  }
  return Array.from(
    new Set(
      ((data ?? []) as Array<{ hr_id: unknown }>)
        .map((row) => canonicalHrIdForDisplay(String(row.hr_id ?? "")))
        .filter((hrId): hrId is string => hrId !== null),
    ),
  );
}

export type TriageBacklogRunResult = {
  notified: number;
  ok: boolean;
  overdue: number;
  reason?: string;
};

/**
 * The daily run. Best-effort and never throws: this is one step inside the shared daily cron, and a
 * failure here must not take down the interview reminders or the stale-send check beside it.
 */
export async function runTriageBacklogCheck(now: Date = new Date()): Promise<TriageBacklogRunResult> {
  try {
    const applicants = await loadUntriagedApplicants();
    const summary = summarizeTriageBacklog(applicants, now);
    // Nothing overdue is the goal state, not an error, and it must be silent — an alarm that also
    // fires on success is one nobody reads by the second week.
    if (summary.overdue === 0) return { notified: 0, ok: true, overdue: 0 };

    const recipients = await recruitmentDeskHrIds();
    if (recipients.length === 0) {
      logError("Triage backlog check found overdue CVs but resolved nobody to tell.", {
        labels: { event: "recruitment_triage_backlog_no_recipients" },
      });
      return { notified: 0, ok: false, overdue: summary.overdue, reason: "No recruitment desk recipients." };
    }

    const result = await createSystemNotificationForRecipients(
      {
        actionUrl: TRIAGE_BACKLOG_ACTION_URL,
        category: "recruitment",
        channels: [...TRIAGE_BACKLOG_CHANNELS],
        eventType: "recruitment_triage_backlog",
        message: buildTriageBacklogMessage(summary),
        metadata: {
          // ONE per Cairo day, keyed on the day alone — deliberately unlike the stale-send strand
          // key, which also carries the exact candidate set so a newly stranded CV gets through the
          // same day. That distinction does not apply here: this is a depth report, so a candidate
          // crossing the threshold today is already inside today's single alert rather than being a
          // separate event that could be swallowed. Keying on the count instead would re-fire every
          // time a CV arrived.
          idempotencyKey: `recruitment_triage_backlog:${cairoTodayIso()}`,
          longestWaitDays: summary.longestWaitDays,
          newlyOverdue: summary.newlyOverdue,
          overdue: summary.overdue,
          uncontactableOverdue: summary.uncontactableOverdue,
        },
        module: "recruitment",
        // Normal, not high, and this is a judgement worth stating: the alarm repeats every day for
        // as long as the queue is deep, and a daily `high` becomes wallpaper — at which point it
        // stops working on the day something genuinely urgent arrives. The three channels are what
        // make it hard to miss; the priority is not.
        priority: "normal",
        telegram: { ctaLabel: "Open recruitment", ctaUrl: TRIAGE_BACKLOG_ACTION_URL },
        title: `${count(summary.overdue, "CV")} waiting for a first look`,
      },
      recipients,
    );

    const notified = result.deliveries.some((delivery) => delivery.status === "sent") ? recipients.length : 0;
    return { notified, ok: true, overdue: summary.overdue };
  } catch (error) {
    logError("Triage backlog check failed.", {
      error,
      labels: { event: "recruitment_triage_backlog_failed" },
    });
    return {
      notified: 0,
      ok: false,
      overdue: 0,
      reason: error instanceof Error ? error.message : "Triage backlog check failed.",
    };
  }
}
