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
//      somebody else's to give). A hire beats an earlier shortlist or rejection; an offer beats an earlier
//      shortlist or back-up.
// WHAT NEVER COUNTS: a later interview being booked (it can follow a no-show), a comment, a status that
// predates the interview, a move made by a batch actor, and an outside person with no candidate record.
//
// It writes NO candidate effect and sends NO notice: the status it read is already on the candidate, and
// the interviewer is being told less, not more. The outcome is stamped with no setter and a history line
// that says it was settled automatically, so nobody mistakes it for a person's word.

import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isBatchActor } from "@/lib/recruitment/batch-actor";
import type { InterviewOutcome } from "@/lib/recruitment/interview-calendar-types";
import { INTERVIEW_OUTCOME_WINDOW_DAYS } from "@/lib/recruitment/interview-outcome-window";
import { isSentCvReturn } from "@/lib/recruitment/manager-recall-status";

/** A decision made later than this after the interview is not read as the verdict on it. */
export const DECISION_WINDOW_DAYS = INTERVIEW_OUTCOME_WINDOW_DAYS;

const DAY_MS = 86_400_000;

export type SettleStatusEvent = { toStatus: string; actorHrId: string | null; createdAt: string; fromStatus?: string | null };

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

  // A HIRE is the end of the road and beats any earlier shortlisting or rejection (owner, 2026-10-17: a
  // candidate shortlisted and then hired is hired, not "shortlisted").
  if (events.some((event) => event.toStatus === "hired")) return { outcome: "attended", reason: "the candidate was hired after it" };

  // Taking a CV back from a manager (a recall, his Hide, the 45-day return) files `sent_to_manager →
  // shortlisted`; nobody judged the interview by it, so it is never the verdict (`isSentCvReturn`).
  const decision = events.find(
    (event) =>
      Boolean(event.actorHrId) &&
      !isBatchActor(event.actorHrId) &&
      Object.prototype.hasOwnProperty.call(DECISION_WORDS, event.toStatus) &&
      !isSentCvReturn(event) &&
      event.at - end <= DECISION_WINDOW_DAYS * DAY_MS,
  );
  // An offer drawn up after the interview outranks a shortlist or a back-up (it is further along), but not a
  // rejection: an offer may have been drawn up before the candidate was turned down.
  const offer = evidence.offerCreatedAt ? Date.parse(evidence.offerCreatedAt) : Number.NaN;
  const offered = Number.isFinite(offer) && offer >= start && before(offer);
  if (offered && (!decision || decision.toStatus !== "rejected")) {
    return { outcome: "attended", reason: "a job offer was drawn up for the candidate after it" };
  }
  if (decision) {
    return { outcome: DECISION_WORDS[decision.toStatus], reason: `the candidate was ${DECISION_LABELS[decision.toStatus]} after it` };
  }
  return null;
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

type BookingRow = { id: string; candidate_id: string; starts_at: string; duration_minutes: number | null };

export type SettledInterview = { bookingId: string; candidateId: string; outcome: InterviewOutcome; reason: string };
/** `stoppedEarly`: the run reached its deadline with interviews still to write; the next run settles them. */
export type SettleRun = { considered: number; settled: SettledInterview[]; stoppedEarly: boolean };

const READ_CHUNK = 40;

/** How many settled interviews are written at once. */
const WRITE_CONCURRENCY = 8;

const BOOKING_COLUMNS = "id,candidate_id,starts_at,duration_minutes";

type Db = ReturnType<typeof getSupabaseAdmin>;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/**
 * The scheduled run reads every interview this recent: older than this, no shortlist, back-up or rejection
 * can still count (DECISION_WINDOW_DAYS) and the panel has let the interview go.
 */
const SCAN_WINDOW_DAYS = DECISION_WINDOW_DAYS + INTERVIEW_OUTCOME_WINDOW_DAYS;

/**
 * The candidates hired, or given an offer, since `sinceIso`. A hire or an offer has no time limit (proof 2
 * above), so these candidates' older interviews are read as well — which keeps "on all time" true without
 * re-reading, every ten minutes, every old interview the record can never prove.
 */
async function candidatesHiredOrOfferedSince(db: Db, sinceIso: string): Promise<string[]> {
  const [hires, offers] = await Promise.all([
    db.from("ats_candidate_status_events").select("candidate_id").eq("to_status", "hired").gte("created_at", sinceIso).limit(5000),
    db.from("offers").select("id").gte("created_at", sinceIso).limit(5000),
  ]);
  if (hires.error) throw hires.error;
  if (offers.error) throw offers.error;
  const ids = new Set<string>();
  for (const row of (hires.data ?? []) as Array<{ candidate_id: string | null }>) if (row.candidate_id) ids.add(String(row.candidate_id));
  // An offer names no candidate; the candidate names the offer.
  for (const part of chunk(((offers.data ?? []) as Array<{ id: string }>).map((row) => String(row.id)), READ_CHUNK)) {
    const { data, error } = await db.from("ats_candidates").select("id").in("offer_id", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string }>) ids.add(String(row.id));
  }
  return [...ids];
}

/** Write one settled outcome, only where it is still empty. Null when somebody answered first. */
async function writeSettledOutcome(
  db: Db,
  item: { row: BookingRow; candidateId: string; inferred: InferredOutcome },
  stamp: string,
): Promise<SettledInterview | null> {
  const { row, candidateId, inferred } = item;
  const { data: written, error: writeError } = await db
    .from("ats_interview_bookings")
    .update({ outcome: inferred.outcome, outcome_set_at: stamp, outcome_set_by_hr_id: null })
    .eq("id", row.id)
    .is("outcome", null)
    .select("id");
  if (writeError) throw writeError;
  if (!written || written.length === 0) return null;
  // The outcome landed; a missing history line is not worth failing the run for, but it is logged.
  const history = await db.from("ats_interview_booking_changes").insert({
    actor_hr_id: null,
    booking_id: row.id,
    kind: "outcome",
    summary: `Settled automatically as ${inferred.outcome}: ${inferred.reason}.`,
  });
  if (history.error) {
    logError("An interview outcome was settled automatically but its history line could not be written", {
      error: history.error,
      labels: { booking_id: row.id, event: "interview_outcome_settle_history_write_failed" },
    });
  }
  return { bookingId: row.id, candidateId, outcome: inferred.outcome, reason: inferred.reason };
}

/**
 * Settle every finished interview of a known candidate that has no outcome and whose outcome the record
 * proves. The scheduled run reads the last SCAN_WINDOW_DAYS, plus any older interview whose candidate was
 * hired or offered inside them: an older interview the record cannot prove stays null for ever, and an
 * unbounded, oldest-first read would re-read those every ten minutes and, once a thousand piled up, starve
 * every newer interview. `allTime` lifts the bound for a one-off sweep. Past `deadlineMs` it starts no new
 * write and returns with `stoppedEarly`. Idempotent: the write only lands where the outcome is still
 * empty, so a run twice at once, or a person answering between the read and the write, loses nothing.
 * `dryRun` reads and infers but writes nothing.
 */
export async function settleFinishedInterviewOutcomes(
  now: Date = new Date(),
  options: { allTime?: boolean; dryRun?: boolean; deadlineMs?: number } = {},
): Promise<SettleRun> {
  const db = getSupabaseAdmin();
  const sinceIso = new Date(now.getTime() - SCAN_WINDOW_DAYS * DAY_MS).toISOString();
  let query = db
    .from("ats_interview_bookings")
    .select(BOOKING_COLUMNS)
    .is("outcome", null)
    .not("candidate_id", "is", null)
    .lt("starts_at", now.toISOString());
  if (!options.allTime) query = query.gte("starts_at", sinceIso);
  const { data, error } = await query.order("starts_at", { ascending: true }).limit(1000);
  if (error) throw error;
  const found = new Map(((data ?? []) as BookingRow[]).map((row) => [row.id, row]));
  if (!options.allTime) {
    for (const ids of chunk(await candidatesHiredOrOfferedSince(db, sinceIso), READ_CHUNK)) {
      const older = await db
        .from("ats_interview_bookings")
        .select(BOOKING_COLUMNS)
        .is("outcome", null)
        .in("candidate_id", ids)
        .lt("starts_at", sinceIso)
        .limit(1000);
      if (older.error) throw older.error;
      for (const row of (older.data ?? []) as BookingRow[]) found.set(row.id, row);
    }
  }
  const rows = [...found.values()].filter(
    (row) => Date.parse(row.starts_at) + (Number(row.duration_minutes) || 0) * 60_000 <= now.getTime(),
  );
  if (rows.length === 0) return { considered: 0, settled: [], stoppedEarly: false };

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
        .select("candidate_id,from_status,to_status,actor_hr_id,created_at")
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
    for (const row of (events.data ?? []) as Array<{ candidate_id: string; from_status: string | null; to_status: string; actor_hr_id: string | null; created_at: string }>) {
      const list = eventsByCandidate.get(String(row.candidate_id)) ?? [];
      list.push({ actorHrId: row.actor_hr_id, createdAt: row.created_at, fromStatus: row.from_status, toStatus: row.to_status });
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
  const toWrite: Array<{ row: BookingRow; candidateId: string; inferred: InferredOutcome }> = [];
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
    toWrite.push({ row, candidateId, inferred });
  }

  const stamp = now.toISOString();
  let stoppedEarly = false;
  for (const group of chunk(toWrite, WRITE_CONCURRENCY)) {
    // Past the deadline no new write starts; what is left keeps its null and the next run settles it.
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
      stoppedEarly = true;
      break;
    }
    for (const result of await Promise.all(group.map((item) => writeSettledOutcome(db, item, stamp)))) {
      if (result) settled.push(result);
    }
  }
  return { considered: rows.length, settled, stoppedEarly };
}
