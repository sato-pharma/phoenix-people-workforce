// Recruitment / ATS — taking a CV back from a manager when its 45 days are up, and telling the desk.
//
// The owner, 2026-10-06: *"collect all old CVs from the manager's accounts and make it stay in their
// account maximum 45 days. Then collect it back to the admin."*
//
// THE LISTS AND THE GATES ALREADY LET GO OF A CV THE SECOND IT TURNS 45 DAYS OLD — that is
// manager-hold-window.ts, applied at every read a manager makes, so nothing here is what keeps a CV
// out of his account. This is the half a read cannot do:
//
//   1. A pushed CV is still marked `sent_to_manager`. Left alone it would sit in the recruitment
//      desk's "with a manager" pile for ever, and the stale-send job (stale-send-check.ts) would go
//      on nudging a manager about a CV he can no longer open and escalating it to the desk as
//      "stuck". So its status goes back to `shortlisted` — the state it was sent FROM in 86 of the
//      125 pushes on record, and the one the 57 CVs taken back on 29 Aug – 1 Sep went to.
//   2. The desk is told, once a day and only when something came back, who held what.
//
// A CV in a DISTRICT FOLDER needs neither: it was never `sent_to_manager`, and it was already in the
// desk's own pool. The window alone takes it out of the folder.
//
// ── ALL OF A CV'S MANAGERS, NOT ANY ONE ─────────────────────────────────────────────────────────
//
// A CV can sit with two managers at once (2026-08-30). It goes back only when EVERY send of it is
// past 45 days: one manager's expiry must not pull it from another who still has days left.
//
// ── WHAT IT DOES NOT TOUCH ──────────────────────────────────────────────────────────────────────
//
// The send rows stay (they are the history the timeline and the screening queue read), and so do the
// manager_notified_* columns on the candidate ("where was it last sent"). Nothing is deleted, and the
// status event is written under an `ops:` actor so throughput reports never count it as a decision
// by a person (batch-actor.ts). Nothing here emails anyone: in-app, Telegram and push only.
//
// Pure classifier plus async loaders — the shape stale-send-check.ts uses, for the same reason: the
// rule that decides what comes back is worth testing without a database, and `now` is a parameter.

import { createHash } from "node:crypto";

import { cairoTodayIso } from "@/lib/attendance/working-days";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { CANDIDATE_STATUS_NOTE_MAX_LENGTH, normalizeCandidateStatus } from "@/lib/recruitment/candidate-status";
import { recruitmentDb } from "@/lib/recruitment/db";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { folderHolderKeys, loadDistrictSeatRows } from "@/lib/recruitment/folder-holders";
import { isWithinManagerHold, MANAGER_HOLD_DAYS, managerHoldDaysHeld } from "@/lib/recruitment/manager-hold-window";
import { RECALL_RETURN_STATUS, returnSentCvToShortlist } from "@/lib/recruitment/manager-recall-status";
import { MANAGER_SENDS_TABLE } from "@/lib/recruitment/manager-sends";
import { managerLabel } from "@/lib/recruitment/person-labels";
import {
  recruitmentDeskHrIds,
  STALE_SEND_CHANNELS,
  STALE_SEND_TA_ACTION_URL,
} from "@/lib/recruitment/stale-send-check";

/**
 * Who the status event names. The `ops:` prefix is the contract batch-actor.ts reads: anything before
 * the colon marks an automated sweep, so the screening throughput trend and the hiring analytics skip
 * it instead of counting a night's work as a recruiter's decisions.
 */
export const MANAGER_HOLD_RETURN_ACTOR = "ops:manager-hold-45-days";

/**
 * What a CV goes back to. `shortlisted`, never `new`: sending it WAS a decision by the desk (it moved
 * the CV out of "nobody has looked at this" — see sendCandidatesToManager), so returning it to the
 * unreviewed pile would put 45-day-old, already-screened CVs in front of the triage backlog alarm.
 */
export const MANAGER_HOLD_RETURN_STATUS = RECALL_RETURN_STATUS;

/** One manager's hold on one CV, as the rule reads it. */
export type HeldSendRecord = {
  managerHrId: string;
  managerName: string | null;
  /** ISO instant the CV reached this manager — the send row's `sent_at`, or the legacy stamp's. */
  sentAt: string;
};

/** A candidate currently marked `sent_to_manager`, with every manager known to hold it. */
export type SentCandidateRecord = {
  fullName: string;
  id: string;
  sends: HeldSendRecord[];
  status: string | null;
};

export type ExpiredHold = {
  candidateId: string;
  fullName: string;
  /** Every manager that held it, oldest send first — all of them are past 45 days. */
  holds: Array<HeldSendRecord & { daysHeld: number }>;
};

/**
 * Which of these CVs have used up their 45 days with EVERY manager that holds them.
 *
 * A candidate is skipped, never returned, when it is not `sent_to_manager` (a decision has already
 * moved it), when no send has a readable date (its age is unknown, and an unknown age is never proof
 * of 45 days), or when any one send is still inside the window. A hold by a manager who holds folders
 * is always inside it.
 */
export function classifyExpiredHolds(
  candidates: readonly SentCandidateRecord[],
  now: Date,
  /** Canonical keys of managers who hold folders: their holds carry no limit (owner, 2026-10-16). */
  exemptManagerKeys: ReadonlySet<string> = new Set(),
): ExpiredHold[] {
  const expired: ExpiredHold[] = [];
  for (const candidate of candidates) {
    if (normalizeCandidateStatus(candidate.status) !== "sent_to_manager") continue;

    const dated = candidate.sends.filter((send) => Number.isFinite(Date.parse(send.sentAt)));
    if (dated.length === 0) continue;
    if (
      dated.some(
        (send) =>
          exemptManagerKeys.has(canonicalHrIdKey(send.managerHrId) ?? "") || isWithinManagerHold(send.sentAt, now),
      )
    ) {
      continue;
    }

    expired.push({
      candidateId: candidate.id,
      fullName: candidate.fullName,
      holds: [...dated]
        .sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt))
        .map((send) => ({ ...send, daysHeld: managerHoldDaysHeld(send.sentAt, now) })),
    });
  }
  return expired;
}

/** The names a CV was held by, once each, in words. */
function holderNames(expired: ExpiredHold): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const hold of expired.holds) {
    const key = canonicalHrIdKey(hold.managerHrId) ?? hold.managerHrId;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(managerLabel(hold.managerName));
  }
  return names;
}

/**
 * The note on the status change — names the people, never their ids, and always fits the column.
 * Refused at 300 characters by updateCandidateStatus, so this falls back to a sentence with no names
 * rather than cutting one in half.
 */
export function buildHoldReturnNote(expired: ExpiredHold): string {
  const named = `Returned to recruitment — ${MANAGER_HOLD_DAYS} days with ${holderNames(expired).join(", ")}.`;
  if (named.length <= CANDIDATE_STATUS_NOTE_MAX_LENGTH) return named;
  return `Returned to recruitment — ${MANAGER_HOLD_DAYS} days with the managers it was sent to.`;
}

/** Plural without the "(s)" that makes a message look machine-written. */
function count(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

/**
 * The digest the recruitment desk reads — one paragraph per manager, every CV named in full and none
 * summarised away. A CV held by two managers appears under both, which is the truth about it.
 */
export function buildHoldReturnDigest(expired: readonly ExpiredHold[]): { message: string; title: string } {
  const byManager = new Map<string, { name: string; cvs: string[] }>();
  for (const item of expired) {
    const seen = new Set<string>();
    for (const hold of item.holds) {
      const key = canonicalHrIdKey(hold.managerHrId) ?? hold.managerHrId;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = byManager.get(key) ?? { cvs: [], name: managerLabel(hold.managerName) };
      entry.cvs.push(item.fullName);
      byManager.set(key, entry);
    }
  }

  const groups = [...byManager.values()].sort(
    (left, right) => right.cvs.length - left.cvs.length || left.name.localeCompare(right.name),
  );
  const lines = [
    `${count(expired.length, "CV")} reached ${MANAGER_HOLD_DAYS} days with a manager and came back to recruitment.`,
    "They are shortlisted again — send them to somebody else, or decide on them here.",
    "",
    ...groups.map((group) => `• ${group.name} — ${group.cvs.join(", ")}`),
  ];
  return {
    message: lines.join("\n"),
    title: `${count(expired.length, "CV")} came back from managers after ${MANAGER_HOLD_DAYS} days`,
  };
}

// ── The database half ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 1000;
const PAGE_LIMIT = 50;

function textOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

/** Same condition the send reader treats as "that table is not in this database yet". */
function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "PGRST205" || code === "42P01";
}

/** The columns the daily run reads off a candidate. Exported because assembleSentCandidates takes them. */
export type SentCandidateDbRow = {
  full_name?: unknown;
  id?: unknown;
  manager_notified_at?: unknown;
  manager_notified_hr_id?: unknown;
  manager_notified_name?: unknown;
  status?: unknown;
};

/** The columns the daily run reads off a send row. */
export type SendTrailDbRow = { candidate_id?: unknown; manager_hr_id?: unknown; manager_name?: unknown; sent_at?: unknown };

/** Every candidate still marked `sent_to_manager`, paged — PostgREST stops at 1,000 rows without saying so. */
async function loadSentCandidates(): Promise<SentCandidateDbRow[]> {
  const rows: SentCandidateDbRow[] = [];
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await recruitmentDb()
      .from("ats_candidates")
      .select("id,full_name,status,manager_notified_hr_id,manager_notified_name,manager_notified_at")
      .eq("status", "sent_to_manager")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as SentCandidateDbRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
  throw new Error(`Sent-to-manager paging stopped at ${PAGE_LIMIT * PAGE_SIZE} rows. Refusing to return CVs on a partial read.`);
}

/** The send trail for these candidates. A missing table reads as "no rows", and the legacy stamp stands alone. */
async function loadSendRows(candidateIds: readonly string[]): Promise<SendTrailDbRow[]> {
  const rows: SendTrailDbRow[] = [];
  for (const batch of chunkIds(candidateIds)) {
    const { data, error } = await recruitmentDb()
      .from(MANAGER_SENDS_TABLE)
      .select("candidate_id,manager_hr_id,manager_name,sent_at")
      .in("candidate_id", batch);
    if (error) {
      if (isMissingTable(error)) return [];
      throw error;
    }
    rows.push(...((data ?? []) as SendTrailDbRow[]));
  }
  return rows;
}

/**
 * Candidates with every manager that holds them — the send trail plus the single-manager stamp the
 * trail was built to replace, deduplicated per manager keeping the NEWER date. Both sources, because
 * reading only the table misses a send made while its write was skipped, and reading only the column
 * misses everyone but the last manager.
 */
export function assembleSentCandidates(
  candidates: readonly SentCandidateDbRow[],
  sendRows: readonly SendTrailDbRow[],
): SentCandidateRecord[] {
  const sendsByCandidate = new Map<string, Map<string, HeldSendRecord>>();
  const remember = (candidateId: string, send: HeldSendRecord): void => {
    const key = canonicalHrIdKey(send.managerHrId);
    if (!key) return;
    const held = sendsByCandidate.get(candidateId) ?? new Map<string, HeldSendRecord>();
    const existing = held.get(key);
    if (!existing || Date.parse(send.sentAt) > Date.parse(existing.sentAt) || !Number.isFinite(Date.parse(existing.sentAt))) {
      held.set(key, send);
    }
    sendsByCandidate.set(candidateId, held);
  };

  for (const row of sendRows) {
    const candidateId = textOrNull(row.candidate_id);
    const managerHrId = textOrNull(row.manager_hr_id);
    const sentAt = textOrNull(row.sent_at);
    if (candidateId && managerHrId && sentAt) {
      remember(candidateId, { managerHrId, managerName: textOrNull(row.manager_name), sentAt });
    }
  }
  for (const row of candidates) {
    const candidateId = textOrNull(row.id);
    const managerHrId = textOrNull(row.manager_notified_hr_id);
    const sentAt = textOrNull(row.manager_notified_at);
    if (candidateId && managerHrId && sentAt) {
      remember(candidateId, { managerHrId, managerName: textOrNull(row.manager_notified_name), sentAt });
    }
  }

  return candidates
    .map((row) => {
      const id = textOrNull(row.id) ?? "";
      return {
        fullName: textOrNull(row.full_name) ?? "(no name recorded)",
        id,
        sends: [...(sendsByCandidate.get(id)?.values() ?? [])],
        status: textOrNull(row.status),
      };
    })
    .filter((record) => record.id.length > 0);
}

/**
 * Move one CV back to the desk. Conditional on it STILL being `sent_to_manager`, so a manager who
 * answered a minute ago, or a recruiter who moved it, is never overwritten by a nightly sweep.
 * Returns false when somebody got there first.
 *
 * Written straight to the table and NOT through updateCandidateStatus: that function exists for a
 * person's click and refuses `sent_to_manager → shortlisted` on purpose (statusChangeRefusal) — the
 * refusal protects a CV a manager still holds, and this is the case where he no longer does. The write
 * is the one a person's recall uses (manager-recall-status.ts); only the actor differs.
 */
async function returnOne(expired: ExpiredHold, now: Date): Promise<boolean> {
  return returnSentCvToShortlist(recruitmentDb(), {
    candidateId: expired.candidateId,
    changedAt: now.toISOString(),
    note: buildHoldReturnNote(expired),
    // NULL, exactly like every other sweep: the `ops:` marker lives on the event row, never here.
    statusActorHrId: null,
    eventActorHrId: MANAGER_HOLD_RETURN_ACTOR,
    eventWriteFailed: {
      event: "manager_hold_return_event_write_failed",
      message: "A CV came back from its managers but the history line could not be written",
    },
  });
}

export type ManagerHoldReturnResult = {
  notified: boolean;
  ok: boolean;
  reason?: string;
  returned: number;
};

/**
 * The daily run. Best-effort and never throws: it is one step inside the shared recruitment cron and
 * a failure here must not take the stale-send check, the backlog report or the interview reminders
 * down with it. It runs BEFORE the stale-send check so that check never nudges about a CV this step
 * has just taken back.
 */
export async function runManagerHoldReturn(now: Date = new Date()): Promise<ManagerHoldReturnResult> {
  try {
    const candidateRows = await loadSentCandidates();
    if (candidateRows.length === 0) return { notified: false, ok: true, returned: 0 };

    // Who holds folders is read from the organogram. An unreadable organogram reads as NOBODY, which
    // would send every folder CV back, so that run returns nothing at all and tries again tomorrow.
    const seatRows = await loadDistrictSeatRows();
    if (seatRows.length === 0) return { notified: false, ok: true, returned: 0 };
    const sendRows = await loadSendRows(candidateRows.map((row) => String(row.id ?? "")).filter(Boolean));
    const expired = classifyExpiredHolds(assembleSentCandidates(candidateRows, sendRows), now, folderHolderKeys(seatRows));
    if (expired.length === 0) return { notified: false, ok: true, returned: 0 };

    const returned: ExpiredHold[] = [];
    for (const item of expired) {
      if (await returnOne(item, now)) returned.push(item);
    }
    if (returned.length === 0) return { notified: false, ok: true, returned: 0 };

    const recipients = await recruitmentDeskHrIds();
    if (recipients.length === 0) return { notified: false, ok: true, returned: returned.length };

    const ids = returned.map((item) => item.candidateId).sort();
    const digest = buildHoldReturnDigest(returned);
    const result = await createSystemNotificationForRecipients(
      {
        actionUrl: STALE_SEND_TA_ACTION_URL,
        category: "recruitment",
        // In-app, Telegram and push — never email. Passed explicitly so a later edit to the policy
        // table cannot quietly put a daily job on email.
        channels: [...STALE_SEND_CHANNELS],
        eventType: "recruitment_manager_hold_returned",
        message: digest.message,
        metadata: {
          candidateIds: ids,
          // The day AND a fingerprint of the exact set: a rerun the same day is absorbed, and a CV
          // that comes back later the same day still reaches the desk.
          idempotencyKey: `recruitment_manager_hold_returned:${cairoTodayIso()}:${createHash("sha1").update(ids.join(",")).digest("hex").slice(0, 16)}`,
        },
        module: "recruitment",
        priority: "normal",
        telegram: { ctaLabel: "Open recruitment", ctaUrl: STALE_SEND_TA_ACTION_URL },
        title: digest.title,
      },
      recipients,
    );
    return {
      notified: result.deliveries.some((delivery) => delivery.status === "sent"),
      ok: true,
      returned: returned.length,
    };
  } catch (error) {
    logError("Manager hold return failed.", { error, labels: { event: "recruitment_manager_hold_return_failed" } });
    return {
      notified: false,
      ok: false,
      reason: error instanceof Error ? error.message : "Manager hold return failed.",
      returned: 0,
    };
  }
}
