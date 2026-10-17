// Recruitment — a finished interview whose outcome is already PROVEN by what happened to the candidate
// afterwards settles itself (owner, 2026-10-17: "this must have a part that is automated, audit the
// rejection, the job offers, and leave only the one that you cannot recognize ... on all time").
//
// The calendar asks the lead interviewer how every finished interview went. Many of those questions had
// already been answered by somebody else's decision — the candidate was rejected, shortlisted, hired or
// given an offer after the interview — so asking again was noise. This module reads those decisions and
// writes the matching outcome. It is STRICT: it settles only what the record proves and leaves everything
// else on the panel for a person.
//
// WHAT COUNTS AS PROOF (and only this):
//   1. A PERSON moved the candidate to shortlisted, back-up or rejected after the interview ended, within
//      DECISION_WINDOW_DAYS of it and before the candidate's next interview → that word is the outcome.
//   2. The candidate was moved to hired after the interview, or an offer was drawn up for them after the
//      interview started, before their next interview → "attended" (they came; the verdict above it is
//      somebody else's to give).
// WHAT NEVER COUNTS: a later interview being booked (it can follow a no-show), a comment, a status that
// predates the interview, a move made by a batch actor, and an outside person with no candidate record.
//
// It writes NO candidate effect and sends NO notice: the status it read is already on the candidate, and
// the interviewer is being told less, not more. The outcome is stamped with no setter and a history line
// that says it was settled automatically, so nobody mistakes it for a person's word.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isBatchActor } from "@/lib/recruitment/batch-actor";
import type { InterviewOutcome } from "@/lib/recruitment/interview-calendar-types";

/** A decision made later than this after the interview is not read as the verdict on it. */
export const DECISION_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

export type SettleStatusEvent = { toStatus: string; actorHrId: string | null; createdAt: string };

export type SettleEvidence = {
  startsAt: string;
  durationMinutes: number;
  /** When the same candidate's NEXT interview starts, if there is one — evidence after it is not about this one. */
  nextInterviewStartsAt: string | null;
  statusEvents: readonly SettleStatusEvent[];
  /** When an offer drawn up for the candidate was created, if any. */
  offerCreatedAt: string | null;
};

export type InferredOutcome = { outcome: InterviewOutcome; reason: string };

const DECISION_WORDS: Record<string, InterviewOutcome> = {
  backup: "backup",
  rejected: "rejected",
  shortlisted: "shortlisted",
};

const DECISION_LABELS: Record<string, string> = {
  backup: "moved to back-up",
  rejected: "rejected",
  shortlisted: "shortlisted",
};

/**
 * The outcome the record proves, or null when it proves nothing. Pure: the evidence is handed in.
 */
export function inferInterviewOutcome(evidence: SettleEvidence): InferredOutcome | null {
  const start = Date.parse(evidence.startsAt);
  if (!Number.isFinite(start)) return null;
  const end = start + Math.max(0, Number(evidence.durationMinutes) || 0) * 60_000;
  const next = evidence.nextInterviewStartsAt ? Date.parse(evidence.nextInterviewStartsAt) : Number.NaN;
  const before = (instant: number) => !Number.isFinite(next) || instant < next;

  const events = evidence.statusEvents
    .map((event) => ({ ...event, at: Date.parse(event.createdAt) }))
    .filter((event) => Number.isFinite(event.at) && event.at >= end && before(event.at))
    .sort((a, b) => a.at - b.at);

  for (const event of events) {
    const personMade = Boolean(event.actorHrId) && !isBatchActor(event.actorHrId);
    if (personMade && event.toStatus in DECISION_WORDS && event.at - end <= DECISION_WINDOW_DAYS * DAY_MS) {
      return { outcome: DECISION_WORDS[event.toStatus], reason: `the candidate was ${DECISION_LABELS[event.toStatus]} after it` };
    }
    if (event.toStatus === "hired") return { outcome: "attended", reason: "the candidate was hired after it" };
  }

  const offer = evidence.offerCreatedAt ? Date.parse(evidence.offerCreatedAt) : Number.NaN;
  if (Number.isFinite(offer) && offer >= start && before(offer)) {
    return { outcome: "attended", reason: "a job offer was drawn up for the candidate after it" };
  }
  return null;
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

type BookingRow = { id: string; candidate_id: string; starts_at: string; duration_minutes: number | null };

export type SettledInterview = { bookingId: string; candidateId: string; outcome: InterviewOutcome; reason: string };
export type SettleRun = { considered: number; settled: SettledInterview[] };

const READ_CHUNK = 40;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/**
 * Settle, across ALL time, every finished interview of a known candidate that has no outcome and whose
 * outcome the record proves. Idempotent: the write only lands where the outcome is still empty, so a run
 * twice at once, or a person answering between the read and the write, loses nothing. `dryRun` reads and
 * infers but writes nothing.
 */
export async function settleFinishedInterviewOutcomes(
  now: Date = new Date(),
  options: { dryRun?: boolean } = {},
): Promise<SettleRun> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("ats_interview_bookings")
    .select("id,candidate_id,starts_at,duration_minutes")
    .is("outcome", null)
    .not("candidate_id", "is", null)
    .lt("starts_at", now.toISOString())
    .order("starts_at", { ascending: true })
    .limit(1000);
  if (error) throw error;
  const rows = ((data ?? []) as BookingRow[]).filter(
    (row) => Date.parse(row.starts_at) + (Number(row.duration_minutes) || 0) * 60_000 <= now.getTime(),
  );
  if (rows.length === 0) return { considered: 0, settled: [] };

  const candidateIds = Array.from(new Set(rows.map((row) => String(row.candidate_id))));
  const bookingsByCandidate = new Map<string, string[]>();
  const eventsByCandidate = new Map<string, SettleStatusEvent[]>();
  const offerIdByCandidate = new Map<string, string>();
  const offerCreatedById = new Map<string, string>();

  for (const ids of chunk(candidateIds, READ_CHUNK)) {
    const [bookings, events, candidates] = await Promise.all([
      db.from("ats_interview_bookings").select("candidate_id,starts_at").in("candidate_id", ids),
      db
        .from("ats_candidate_status_events")
        .select("candidate_id,to_status,actor_hr_id,created_at")
        .in("candidate_id", ids)
        .order("created_at", { ascending: true })
        .limit(5000),
      db.from("ats_candidates").select("id,offer_id").in("id", ids),
    ]);
    if (bookings.error) throw bookings.error;
    if (events.error) throw events.error;
    if (candidates.error) throw candidates.error;
    for (const row of (bookings.data ?? []) as Array<{ candidate_id: string; starts_at: string }>) {
      const list = bookingsByCandidate.get(String(row.candidate_id)) ?? [];
      list.push(row.starts_at);
      bookingsByCandidate.set(String(row.candidate_id), list);
    }
    for (const row of (events.data ?? []) as Array<{ candidate_id: string; to_status: string; actor_hr_id: string | null; created_at: string }>) {
      const list = eventsByCandidate.get(String(row.candidate_id)) ?? [];
      list.push({ actorHrId: row.actor_hr_id, createdAt: row.created_at, toStatus: row.to_status });
      eventsByCandidate.set(String(row.candidate_id), list);
    }
    for (const row of (candidates.data ?? []) as Array<{ id: string; offer_id: string | null }>) {
      if (row.offer_id) offerIdByCandidate.set(String(row.id), String(row.offer_id));
    }
  }

  const offerIds = Array.from(new Set(offerIdByCandidate.values()));
  for (const ids of chunk(offerIds, READ_CHUNK)) {
    const { data: offers, error: offersError } = await db.from("offers").select("id,created_at").in("id", ids);
    if (offersError) throw offersError;
    for (const row of (offers ?? []) as Array<{ id: string; created_at: string }>) offerCreatedById.set(String(row.id), row.created_at);
  }

  const settled: SettledInterview[] = [];
  for (const row of rows) {
    const candidateId = String(row.candidate_id);
    const start = Date.parse(row.starts_at);
    const later = (bookingsByCandidate.get(candidateId) ?? [])
      .filter((startsAt) => Date.parse(startsAt) > start)
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    const offerId = offerIdByCandidate.get(candidateId);
    const inferred = inferInterviewOutcome({
      durationMinutes: Number(row.duration_minutes) || 0,
      nextInterviewStartsAt: later[0] ?? null,
      offerCreatedAt: offerId ? (offerCreatedById.get(offerId) ?? null) : null,
      startsAt: row.starts_at,
      statusEvents: eventsByCandidate.get(candidateId) ?? [],
    });
    if (!inferred) continue;
    if (options.dryRun) {
      settled.push({ bookingId: row.id, candidateId, outcome: inferred.outcome, reason: inferred.reason });
      continue;
    }
    const stamp = now.toISOString();
    const { data: written, error: writeError } = await db
      .from("ats_interview_bookings")
      .update({ outcome: inferred.outcome, outcome_set_at: stamp, outcome_set_by_hr_id: null })
      .eq("id", row.id)
      .is("outcome", null)
      .select("id");
    if (writeError) throw writeError;
    if (!written || written.length === 0) continue;
    settled.push({ bookingId: row.id, candidateId, outcome: inferred.outcome, reason: inferred.reason });
    try {
      await db.from("ats_interview_booking_changes").insert({
        actor_hr_id: null,
        booking_id: row.id,
        kind: "outcome",
        summary: `Settled automatically as ${inferred.outcome}: ${inferred.reason}.`,
      });
    } catch {
      // The outcome landed; a missing history line is not worth failing the run for.
    }
  }
  return { considered: rows.length, settled };
}
