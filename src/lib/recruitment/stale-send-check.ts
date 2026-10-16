// Recruitment / ATS — a CV that was sent to a hiring manager and never came back.
//
// Measured in production on 2026-08-28: `ats_candidate_status_events` holds 24 moves INTO
// "sent to manager" and ZERO moves out of it. Not one hiring manager decision had ever been
// recorded. Nothing was broken — the send path was two days old — but nothing anywhere asked how
// long a CV had been sitting either. `manager_notified_at` was read in exactly one place
// (`inbound/cv-intake-digest-6h.ts`) and only to report NEW sends. So a manager who simply never
// answers produced no signal at all, and the candidate aged quietly.
//
// That is the same shape as the 2026-08-14 outbox freeze: a pipeline that looks healthy from every
// angle while doing nothing, for 13 days, because nobody was asking the question. The lesson taken
// from that incident was to alarm on "work was due before the run started and nothing happened",
// and this is that alarm for the recruitment pipeline.
//
// TWO DIFFERENT PROBLEMS, DELIBERATELY NOT MERGED INTO ONE.
//
//  1. A reachable manager is slow. Waiting can still produce an answer, so the right response is to
//     nudge THEM, repeatedly, and leave the recruitment desk out of it.
//  2. The manager CANNOT answer at all. Measured the same day: one of those 24 CVs sits with a
//     manager whose employment status is `resigned`. No threshold ever clears that — the candidate
//     was stranded the moment the send landed, and nudging a resigned person is pure noise. That
//     case goes straight to the recruitment desk on day one and is NEVER nudged.
//
// Collapsing the two would produce the worst of both: a resigned manager nudged for a week before
// anyone who could act was told, which is precisely how a candidate becomes lost.
//
// NEVER EMAIL — see STALE_SEND_CHANNELS.
//
// Pure classifier plus async loaders, the split `area-rep-resolver.ts` and today's
// `vacancy-manager-escalation.ts` both use: the rule that decides who gets chased is worth testing
// without a database, and `now` is a parameter for the same reason.

import { cairoTodayIso } from "@/lib/attendance/working-days";
import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";
import { createSystemNotification, createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { recruitmentDeskAlertRoles } from "@/lib/recruitment/access";
import { managerLabel } from "@/lib/recruitment/person-labels";
import {
  STALE_SEND_ESCALATE_AFTER_DAYS,
  STALE_SEND_NUDGE_AFTER_DAYS,
} from "@/lib/recruitment/stale-send-thresholds";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * How long a CV may sit with a manager before that manager is nudged, and how long before the
 * recruitment desk is told the manager is not answering.
 *
 * THE NUMBERS THEMSELVES LIVE IN stale-send-thresholds.ts and are re-exported here, so every
 * existing importer keeps resolving them from this module. They moved because the screening
 * work-queue rail needs the three-day threshold to say "overdue" and is a client component — this
 * file reaches the service-role Supabase client, which must never enter a browser bundle. Read the
 * reasoning for both numbers, including the owner's own ruling on the three days, in that file.
 */
export { STALE_SEND_ESCALATE_AFTER_DAYS, STALE_SEND_NUDGE_AFTER_DAYS } from "@/lib/recruitment/stale-send-thresholds";

/**
 * IN-APP, TELEGRAM AND PUSH ONLY — never email, and exported so a test can assert it out loud.
 *
 * Two standing rules meet here. Bulk email is never fired from this system; and the owner's rule
 * that a candidate push to a hiring manager is never emailed applies with more force to a nudge,
 * which by definition repeats. Passed explicitly rather than left to the notification policy table,
 * so a later policy edit cannot quietly put email back onto a job that runs every single day.
 */
export const STALE_SEND_CHANNELS = ["in_app", "telegram", "push"] as const;

/** Where a manager lands from the nudge — the same screen the original send links to. */
export const STALE_SEND_MANAGER_ACTION_URL = "/employee-portals/recruitment-candidates";

/** Where the recruitment desk lands from the escalation. */
export const STALE_SEND_TA_ACTION_URL = "/recruitment";

/** One candidate sitting in `sent_to_manager`, narrowed to what the rule reads. */
export type SentCandidate = {
  id: string;
  fullName: string;
  jobTitle: string | null;
  managerHrId: string;
  managerName: string | null;
  /** ISO instant from `manager_notified_at`. */
  sentAt: string;
};

export type WaitingCandidate = SentCandidate & { daysWaiting: number };

export type ManagerNudge = {
  candidates: WaitingCandidate[];
  longestWaitDays: number;
  managerHrId: string;
  managerName: string | null;
};

/**
 * Why a send needs a human other than the manager.
 *
 * `manager_cannot_answer` fires on day one and never resolves itself; `no_answer` fires only after
 * STALE_SEND_ESCALATE_AFTER_DAYS and means the manager could have replied and has not.
 */
export type StrandedReason = "manager_cannot_answer" | "no_answer";

export type StrandedSend = WaitingCandidate & { reason: StrandedReason };

export type StaleSendPlan = {
  nudges: ManagerNudge[];
  stranded: StrandedSend[];
};

/** Whole days elapsed, floored — "waiting 3 days" must not be true at 3 days minus one minute. */
export function daysWaiting(sentAt: string, now: Date): number {
  const sent = new Date(sentAt).getTime();
  if (!Number.isFinite(sent)) return 0;
  const elapsedMs = now.getTime() - sent;
  if (elapsedMs <= 0) return 0;
  return Math.floor(elapsedMs / 86_400_000);
}

/** A date a human can read, in the owner's timezone. Never a raw UTC instant. */
export function cairoDateLabel(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "an unknown date";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(at);
}

/**
 * Split the outstanding sends into "chase the manager" and "a human other than the manager has to
 * deal with this".
 *
 * `activeManagerHrIds` is the set of managers who can actually answer. A manager absent from it is
 * treated as unable to answer regardless of how recent the send is — that is the whole point of the
 * day-one branch, and it is why this takes a set rather than a boolean per candidate: the caller
 * resolves reachability once, for every manager, instead of the rule guessing per row.
 *
 * A candidate is never in both lists. A send waiting on an unreachable manager is stranded and NOT
 * nudged; a send waiting past the escalation threshold on a reachable manager is BOTH nudged and
 * escalated, because both parties still have something to do about it.
 */
export function classifyStaleSends(
  candidates: readonly SentCandidate[],
  activeManagerHrIds: ReadonlySet<string>,
  now: Date,
): StaleSendPlan {
  const nudgeByManager = new Map<string, ManagerNudge>();
  const stranded: StrandedSend[] = [];

  for (const candidate of candidates) {
    const managerKey = canonicalHrIdKey(candidate.managerHrId);
    if (!managerKey) continue;

    const waiting: WaitingCandidate = {
      ...candidate,
      daysWaiting: daysWaiting(candidate.sentAt, now),
    };

    if (!activeManagerHrIds.has(managerKey)) {
      stranded.push({ ...waiting, reason: "manager_cannot_answer" });
      continue;
    }

    if (waiting.daysWaiting >= STALE_SEND_ESCALATE_AFTER_DAYS) {
      stranded.push({ ...waiting, reason: "no_answer" });
    }

    if (waiting.daysWaiting < STALE_SEND_NUDGE_AFTER_DAYS) continue;

    const existing = nudgeByManager.get(managerKey);
    if (existing) {
      existing.candidates.push(waiting);
      existing.longestWaitDays = Math.max(existing.longestWaitDays, waiting.daysWaiting);
      continue;
    }
    nudgeByManager.set(managerKey, {
      candidates: [waiting],
      longestWaitDays: waiting.daysWaiting,
      // Display casing, not the lower-cased match key: this value is handed straight to
      // `recipientHrId`, and an id that does not look like the stored one is unreadable in an
      // audit row even though the notification layer upper-cases it before use.
      managerHrId: canonicalHrIdForDisplay(candidate.managerHrId) ?? candidate.managerHrId,
      managerName: candidate.managerName,
    });
  }

  // Longest wait first, on both lists — whoever has kept somebody waiting longest is read first.
  const nudges = Array.from(nudgeByManager.values());
  for (const nudge of nudges) nudge.candidates.sort((left, right) => right.daysWaiting - left.daysWaiting);
  nudges.sort((left, right) => right.longestWaitDays - left.longestWaitDays);
  stranded.sort((left, right) => right.daysWaiting - left.daysWaiting);

  return { nudges, stranded };
}

/** Plural without the "(s)" that makes a message look machine-written. */
function count(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

/** Every candidate named in full, one per line. Nothing is summarised away or cut with an ellipsis. */
function candidateLines(candidates: readonly WaitingCandidate[]): string[] {
  return candidates.map((candidate) => {
    const role = candidate.jobTitle ? ` — ${candidate.jobTitle}` : "";
    const waited = candidate.daysWaiting === 0 ? "sent today" : `waiting ${count(candidate.daysWaiting, "day")}`;
    return `• ${candidate.fullName}${role} (${waited}, sent ${cairoDateLabel(candidate.sentAt)})`;
  });
}

/** Pure message builder — no IO, so the wording is unit-testable. */
export function buildManagerNudgeMessage(nudge: ManagerNudge): string {
  return [
    `You have ${count(nudge.candidates.length, "CV")} waiting for your answer.`,
    "",
    ...candidateLines(nudge.candidates),
    "",
    "Open each one and choose “I want to interview” or “Not interested”. Recruitment cannot move a",
    "candidate forward until you answer, and a candidate who waits too long takes another job.",
  ].join("\n");
}

/** Pure message builder for the recruitment-desk escalation. */
export function buildStrandedEscalationMessage(stranded: readonly StrandedSend[]): string {
  const cannotAnswer = stranded.filter((send) => send.reason === "manager_cannot_answer");
  const noAnswer = stranded.filter((send) => send.reason === "no_answer");
  const lines: string[] = [];

  if (cannotAnswer.length > 0) {
    lines.push(
      `${count(cannotAnswer.length, "CV")} sits with a manager who cannot answer — they are no longer active.`,
      "Waiting will not help. Send these to somebody else:",
      "",
      // By name, never by id. This text goes into a notification a person reads, and the owner's
      // rule covers chat as much as the UI — "sent to B-10 on 3 Sept" is the shape it replaces.
      ...cannotAnswer.map((send) => {
        const manager = managerLabel(send.managerName);
        return `• ${send.fullName} — sent to ${manager} on ${cairoDateLabel(send.sentAt)}`;
      }),
    );
  }

  if (noAnswer.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `${count(noAnswer.length, "CV")} has had no answer for ${STALE_SEND_ESCALATE_AFTER_DAYS} days or more.`,
      "The manager has been nudged every day since day three:",
      "",
      ...noAnswer.map((send) => {
        const manager = managerLabel(send.managerName);
        return `• ${send.fullName} — with ${manager} for ${count(send.daysWaiting, "day")}`;
      }),
    );
  }

  return lines.join("\n");
}

/** Every candidate still sitting in `sent_to_manager` with a recorded send time. */
export async function loadSentCandidatesAwaitingDecision(): Promise<SentCandidate[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("ats_candidates")
    .select("id,full_name,sent_for_job_title,applied_for_job_title,manager_notified_hr_id,manager_notified_name,manager_notified_at")
    .eq("status", "sent_to_manager")
    .not("manager_notified_at", "is", null);

  if (error) {
    logError("Stale-send check could not read candidates awaiting a manager decision.", {
      error,
      labels: { event: "recruitment_stale_send_load_failed" },
    });
    return [];
  }

  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => ({
      fullName: String(row.full_name ?? "").trim() || "(no name recorded)",
      id: String(row.id ?? "").trim(),
      jobTitle:
        String(row.sent_for_job_title ?? "").trim() ||
        String(row.applied_for_job_title ?? "").trim() ||
        null,
      managerHrId: String(row.manager_notified_hr_id ?? "").trim(),
      managerName: String(row.manager_notified_name ?? "").trim() || null,
      sentAt: String(row.manager_notified_at ?? "").trim(),
    }))
    .filter((candidate) => candidate.id && candidate.managerHrId && candidate.sentAt);
}

/**
 * Which of these managers can actually answer.
 *
 * `employment_status` is the authority: production carries `active`, `resigned`, `terminated`,
 * `historical_payroll_record` and `system_placeholder`, and only the first can act on anything.
 *
 * HR ids are stored mixed-case across this schema and PostgREST `in` is case-sensitive, so the
 * query asks for every casing via `hrIdLookupKeys`-style expansion and the result is keyed
 * canonically. An `.eq` on the wrong case returns fewer rows and no error — the trap that once hid
 * 28% of a rep's own direct orders — and here it would silently declare a working manager
 * unreachable and escalate every one of their CVs.
 */
export async function loadActiveManagerHrIds(managerHrIds: readonly string[]): Promise<Set<string>> {
  const wanted = Array.from(
    new Set(
      managerHrIds
        .map((hrId) => canonicalHrIdKey(hrId))
        .filter((hrId): hrId is string => hrId !== null),
    ),
  );
  if (wanted.length === 0) return new Set<string>();

  const supabase = getSupabaseAdmin();
  const casings = Array.from(
    new Set(wanted.flatMap((hrId) => [hrId, hrId.toUpperCase(), hrId.toLowerCase()])),
  );

  const { data, error } = await supabase
    .from("employees")
    .select("hr_id,employment_status")
    .in("hr_id", casings);

  if (error) {
    logError("Stale-send check could not resolve manager reachability.", {
      error,
      labels: { event: "recruitment_stale_send_managers_failed" },
    });
    // Fail CLOSED on the escalation, not open: an empty set would declare every manager
    // unreachable and page the recruitment desk about all of them. Returning everything as reachable
    // means the run nudges as normal and escalates nobody, which is the quieter wrong answer.
    return new Set(wanted);
  }

  const active = new Set<string>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    if (String(row.employment_status ?? "").trim().toLowerCase() !== "active") continue;
    const key = canonicalHrIdKey(String(row.hr_id ?? ""));
    if (key) active.add(key);
  }
  return active;
}

/**
 * Whoever can reassign a candidate stuck with the wrong manager.
 *
 * `recruitmentDeskAlertRoles` — the Super Admin; the Talent Acquisition seat (HR Resourcing) is
 * deliberately NOT on it since 2026-10-16, her notification center holds only a new CV, an interview
 * request and an accepted offer — is the same list `inbound/recruitment-notify.ts` uses for its other
 * alerts, so the escalation lands with the people who are already watching this pipeline rather than
 * inventing a new audience. Do NOT read the role named "Talent
 * Acquisition" into this: it was retired from the role list on 2026-08-28 and holds nobody.
 *
 * Measured in production that day, this resolves to exactly ONE reachable person (`B-10`) — the
 * second Super Admin row is the `admin-HR` canary, whose `hr_id` is deliberately NULL.
 */
export async function recruitmentDeskHrIds(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("hr_id")
    .in("role", recruitmentDeskAlertRoles as unknown as string[]);
  if (error) {
    logError("Stale-send check could not resolve the recruitment escalation recipients.", {
      error,
      labels: { event: "recruitment_stale_send_recipients_failed" },
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

export type StaleSendRunResult = {
  escalated: number;
  nudged: number;
  ok: boolean;
  reason?: string;
  strandedCandidates: number;
};

/**
 * The daily run. Best-effort and never throws: this is one step inside the shared daily cron, and a
 * failure here must not take down the birthday, contract-renewal and SLA jobs that run beside it.
 */
export async function runStaleSendCheck(now: Date = new Date()): Promise<StaleSendRunResult> {
  try {
    const candidates = await loadSentCandidatesAwaitingDecision();
    if (candidates.length === 0) {
      return { escalated: 0, nudged: 0, ok: true, strandedCandidates: 0 };
    }

    const activeManagers = await loadActiveManagerHrIds(candidates.map((candidate) => candidate.managerHrId));
    const plan = classifyStaleSends(candidates, activeManagers, now);
    const day = cairoTodayIso();

    let nudged = 0;
    for (const nudge of plan.nudges) {
      const result = await createSystemNotification({
        actionUrl: STALE_SEND_MANAGER_ACTION_URL,
        category: "recruitment",
        channels: [...STALE_SEND_CHANNELS],
        eventType: "recruitment_stale_send_nudge",
        message: buildManagerNudgeMessage(nudge),
        metadata: {
          candidateIds: nudge.candidates.map((candidate) => candidate.id),
          // One nudge per manager per Cairo day. A CV that becomes stale later the same day waits
          // for tomorrow, which costs nothing: it only became stale on day three anyway.
          idempotencyKey: `recruitment_stale_send_nudge:${nudge.managerHrId}:${day}`,
          longestWaitDays: nudge.longestWaitDays,
        },
        module: "recruitment",
        priority: "normal",
        recipientHrId: nudge.managerHrId,
        telegram: { ctaLabel: "Open my candidates", ctaUrl: STALE_SEND_MANAGER_ACTION_URL },
        title: `${count(nudge.candidates.length, "CV")} waiting for your answer`,
      });
      if (result.deliveries.some((delivery) => delivery.status === "sent")) nudged += 1;
    }

    let escalated = 0;
    if (plan.stranded.length > 0) {
      const recipients = await recruitmentDeskHrIds();
      if (recipients.length > 0) {
        const strandedIds = plan.stranded.map((send) => send.id).sort();
        const result = await createSystemNotificationForRecipients(
          {
            actionUrl: STALE_SEND_TA_ACTION_URL,
            category: "recruitment",
            channels: [...STALE_SEND_CHANNELS],
            eventType: "recruitment_stale_send_stranded",
            message: buildStrandedEscalationMessage(plan.stranded),
            metadata: {
              // Keyed on the exact set as well as the day, so a NEWLY stranded candidate reaches
              // somebody today instead of being swallowed by an earlier key — the same reasoning as
              // the drain-stranded alarm, and for the same reason: the day-one case is the urgent one.
              idempotencyKey: `recruitment_stale_send_stranded:${day}:${strandedIds.join(",")}`,
              strandedCandidateIds: strandedIds,
            },
            module: "recruitment",
            priority: "high",
            telegram: { ctaLabel: "Open recruitment", ctaUrl: STALE_SEND_TA_ACTION_URL },
            title: `${count(plan.stranded.length, "CV")} stuck with a hiring manager`,
          },
          recipients,
        );
        if (result.deliveries.some((delivery) => delivery.status === "sent")) escalated = recipients.length;
      }
    }

    return { escalated, nudged, ok: true, strandedCandidates: plan.stranded.length };
  } catch (error) {
    logError("Stale-send check failed.", { error, labels: { event: "recruitment_stale_send_failed" } });
    return {
      escalated: 0,
      nudged: 0,
      ok: false,
      reason: error instanceof Error ? error.message : "Stale-send check failed.",
      strandedCandidates: 0,
    };
  }
}
