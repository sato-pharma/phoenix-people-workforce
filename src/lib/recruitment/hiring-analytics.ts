// Hiring analytics — how a channel actually performs, computed so the number cannot lie the way
// the last one did.
//
// ── THE NUMBER THIS REPLACES ────────────────────────────────────────────────────────────────────
//
// The ATS plan carried "WhatsApp 373 at 16% vs email 223 at 50%" and drew the obvious conclusion:
// move recruitment spend to email. Re-derived from production on 2026-09-05, excluding automated
// sweeps, the real figures are:
//
//     whatsapp   510 candidates   94 decided by a person   18.4%   96.7h to a first answer
//     email      223 candidates   53 decided by a person   23.8%  371.3h to a first answer
//
// A 5.4-point gap, not 34 — and the speed metric points the OTHER WAY: a WhatsApp applicant hears
// back roughly four times sooner. The original figure counted `ops:non-egyptian-reject-20260828`,
// a single automated pass over 65 candidates, as 65 screening decisions.
//
// So the exclusion is not a detail of this module, it is the module's reason to exist, and it lives
// in `isBatchActor` rather than being re-expressed here.
//
// ── TWO RULES ABOUT PRESENTING A RATE ───────────────────────────────────────────────────────────
//
//   1. A rate on a tiny denominator is noise wearing a percentage sign. One decision out of three
//      is "33%", which reads as a finding and is not one. Channels below MIN_CHANNEL_CANDIDATES
//      are reported with their counts and a null rate, never a number that invites a decision.
//   2. Report the MEDIAN alongside the mean. The mean hours-to-decision above is dragged by a long
//      tail of candidates nobody has looked at in months; the median is what a person waiting for
//      an answer actually experiences. Neither alone is honest.

import { isBatchActor } from "@/lib/recruitment/batch-actor";

/** Below this, a channel gets counts but no percentage. */
export const MIN_CHANNEL_CANDIDATES = 20;

export type AnalyticsCandidate = {
  id: string;
  /** Free text as stored; normalised here so "WhatsApp" and "whatsapp" are one channel. */
  source: string | null;
  createdAt: string | null;
};

export type AnalyticsStatusEvent = {
  candidateId: string;
  createdAt: string | null;
  toStatus: string | null;
  actorHrId: string | null;
};

export type ChannelEffectiveness = {
  channel: string;
  candidates: number;
  decidedByAPerson: number;
  /** Null when the channel is too small to carry a percentage honestly. */
  decidedRate: number | null;
  medianHoursToFirstDecision: number | null;
  meanHoursToFirstDecision: number | null;
};

function normaliseChannel(source: string | null | undefined): string {
  const trimmed = String(source ?? "").trim().toLowerCase();
  return trimmed || "(unrecorded)";
}

/**
 * The first time a PERSON moved this candidate out of `new`.
 *
 * Three things are deliberately not counted as a decision:
 *   - a batch actor, for the reason in the header;
 *   - arriving at `new`, which is where a candidate starts;
 *   - a return to `new`, which the undo path writes — counting it would let one press and its own
 *     undo read as two candidates screened.
 */
export function firstHumanDecisionAt(
  events: readonly AnalyticsStatusEvent[],
): Map<string, string> {
  const first = new Map<string, string>();
  for (const event of events) {
    if (!event.candidateId || !event.createdAt) continue;
    if (isBatchActor(event.actorHrId)) continue;
    const to = String(event.toStatus ?? "").trim().toLowerCase();
    if (!to || to === "new") continue;
    const existing = first.get(event.candidateId);
    if (!existing || event.createdAt < existing) first.set(event.candidateId, event.createdAt);
  }
  return first;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function hoursBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const hours = (end - start) / 3_600_000;
  // A negative span means the event predates the candidate row — a data fault, not a fast answer.
  // Dropping it is right; counting it would pull a median toward a time that never happened.
  return hours >= 0 ? hours : null;
}

export function buildChannelEffectiveness(
  candidates: readonly AnalyticsCandidate[],
  events: readonly AnalyticsStatusEvent[],
): ChannelEffectiveness[] {
  const decidedAt = firstHumanDecisionAt(events);
  const byChannel = new Map<string, { total: number; decided: number; hours: number[] }>();

  for (const candidate of candidates) {
    const channel = normaliseChannel(candidate.source);
    const bucket = byChannel.get(channel) ?? { total: 0, decided: 0, hours: [] };
    bucket.total += 1;
    const decided = decidedAt.get(candidate.id);
    if (decided) {
      bucket.decided += 1;
      const hours = hoursBetween(candidate.createdAt, decided);
      if (hours !== null) bucket.hours.push(hours);
    }
    byChannel.set(channel, bucket);
  }

  return [...byChannel.entries()]
    .map(([channel, bucket]) => ({
      channel,
      candidates: bucket.total,
      decidedByAPerson: bucket.decided,
      decidedRate:
        bucket.total >= MIN_CHANNEL_CANDIDATES ? bucket.decided / bucket.total : null,
      medianHoursToFirstDecision: median(bucket.hours),
      meanHoursToFirstDecision: mean(bucket.hours),
    }))
    .sort((left, right) => right.candidates - left.candidates);
}

export type FunnelStep = {
  label: string;
  count: number;
  /** Share of the step above. Null on the first step, which has nothing to convert from. */
  conversionFromPrevious: number | null;
};

/**
 * A funnel where every step is a subset of the one above it.
 *
 * `conversionFromPrevious` is deliberately not "share of the top": a reader comparing 14 of 745
 * against 1 of 745 learns that both are small, while 1 of 14 says the interview step is where the
 * pipeline actually stops. The steps must be passed already ordered and already nested; this does
 * not verify that, because the caller's ordering IS the definition of the funnel.
 */
export function buildFunnel(steps: readonly { label: string; count: number }[]): FunnelStep[] {
  return steps.map((step, index) => {
    const previous = index === 0 ? null : steps[index - 1].count;
    return {
      label: step.label,
      count: step.count,
      conversionFromPrevious:
        previous === null || previous === 0 ? null : step.count / previous,
    };
  });
}
