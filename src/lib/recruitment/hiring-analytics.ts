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
import { chunkIds } from "@/lib/recruitment/db-batch";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeChannelCode } from "@/lib/recruitment/outreach/channel-code";
import { listJobPostChannels } from "@/lib/recruitment/outreach/job-post-channels";
import {
  buildSourceOfHire,
  type HiredApplicationInput,
  type SourceOfHire,
} from "@/lib/recruitment/source-of-hire";

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
/**
 * How many offers have been made — across BOTH tables that hold one.
 *
 * There are two, and the funnel only ever counted the empty one. `ats_offers` is the GOVERNED
 * offer: keyed on `application_id`, carrying the whole approval chain (submitted → approved → sent →
 * responded). `offers` is the offer LETTER: keyed on a free-text `candidate_name`/`candidate_email`,
 * carrying the document. Measured on production 2026-09-08, `ats_offers` held **0** rows and had
 * never held one, while `offers` held **3** — two of them sent that day. So the Offers step of the
 * hiring funnel read zero while three real letters were out with real people.
 *
 * Zero is the worst possible wrong answer here, because it is also what "we have not made any
 * offers yet" looks like. Nothing alerts on it and nothing contradicts it.
 *
 * THEY CANNOT BE DEDUPLICATED, and that is a fact about the schema rather than a shortcut: `offers`
 * carries no `candidate_id` and no `application_id`, so there is no key to join on — only a name
 * typed onto a letter. Summing is therefore the only honest arithmetic available, and it is exact
 * today because the two sets are disjoint (one is empty). If the governed chain is ever switched on
 * for a person who also receives a letter, this will count them twice — the fix then is to give
 * `offers` a real link, not to pick one table and hide the other.
 *
 * Expect this to exceed the Interviews step. That is not a bug in the arithmetic; it is the process
 * genuinely running outside the ATS, and the funnel showing it is the point.
 */
export function offersMade(governed: number | null | undefined, letters: number | null | undefined): number {
  return (governed ?? 0) + (letters ?? 0);
}

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


// ── reading it out of the database ──────────────────────────────────────────────────────────────
//
// PAGED, because a PostgREST select stops at 1000 rows with no marker of any kind — the read simply
// returns 1000 and looks complete. There are 733 candidates and thousands of status events today,
// so an unpaged read would silently compute these rates over a truncated pool and every figure
// would be wrong in the same direction.
//
// Ordered by a column plus the id, so the order is TOTAL: without the tiebreak two rows written in
// the same millisecond can appear on two consecutive pages, or on neither. The shared pager walks to
// the end on a short page, with no page ceiling that could drop the tail without a sound.
async function readAllPages<T>(
  table: string,
  columns: string,
  orderColumn: string,
): Promise<T[]> {
  const supabase = getSupabaseAdmin();
  return fetchAllRows<T>(() => supabase.from(table).select(columns).order(orderColumn, { ascending: true }), "id");
}

export type HiringAnalytics = {
  channels: ChannelEffectiveness[];
  funnel: FunnelStep[];
  sourceOfHire: SourceOfHire;
  generatedAt: string;
  totalCandidates: number;
};

/**
 * The advert each hire's candidate actually came from, keyed by candidate.
 *
 * The EARLIEST surviving code wins — the covering message that first brought them, not a code
 * quoted later in a re-send. Candidates with no code (the majority) simply do not appear, which the
 * caller reads as "no automatic advert" and falls back to the coarse source or a manual tag.
 */
export function earliestCodePerCandidate(
  events: readonly { candidateId: string | null; code: string | null; createdAt: string | null }[],
): Map<string, string> {
  const earliest = new Map<string, { code: string; at: string }>();
  for (const event of events) {
    const candidateId = event.candidateId ? String(event.candidateId) : "";
    const code = normalizeChannelCode(event.code);
    if (!candidateId || !code) continue;
    const at = event.createdAt ?? "";
    const existing = earliest.get(candidateId);
    if (!existing || at < existing.at) earliest.set(candidateId, { at, code });
  }
  return new Map([...earliest.entries()].map(([candidateId, value]) => [candidateId, value.code]));
}

/**
 * The whole report, for the dashboard.
 *
 * The permission is asserted HERE and not only in the route: this is the security boundary, and a
 * second caller added later would otherwise inherit an unguarded read of every candidate.
 */
export async function loadHiringAnalytics(access: AccessContext): Promise<HiringAnalytics> {
  await assertPermission(access, "candidates", "read");

  const [candidateRows, eventRows] = await Promise.all([
    readAllPages<{ id: string; source: string | null; created_at: string | null }>(
      "ats_candidates",
      "id,source,created_at",
      "created_at",
    ),
    readAllPages<{
      id: string;
      candidate_id: string | null;
      created_at: string | null;
      to_status: string | null;
      actor_hr_id: string | null;
    }>("ats_candidate_status_events", "id,candidate_id,created_at,to_status,actor_hr_id", "created_at"),
  ]);

  const candidates: AnalyticsCandidate[] = candidateRows.map((row) => ({
    id: String(row.id),
    source: row.source,
    createdAt: row.created_at,
  }));
  const events: AnalyticsStatusEvent[] = eventRows.map((row) => ({
    candidateId: String(row.candidate_id ?? ""),
    createdAt: row.created_at,
    toStatus: row.to_status,
    actorHrId: row.actor_hr_id,
  }));

  const supabase = getSupabaseAdmin();
  // count(*) rather than a select length, for the same reason the reads above are paged.
  //
  // BOTH offer tables, because an offer can be made through either door and this step used to see
  // only the door nobody uses. See `offersMade` for why they cannot be deduplicated.
  //
  // The hired rows are READ, not counted: source-of-hire needs each hire's candidate, its manual
  // tag and who it came from, and the count for the funnel's last step is just their length.
  const [applications, interviews, governedOffers, letterOffers, hiredAppRows, channels] = await Promise.all([
    supabase.from("ats_applications").select("id", { count: "exact", head: true }),
    supabase.from("ats_interviews").select("id", { count: "exact", head: true }),
    supabase.from("ats_offers").select("id", { count: "exact", head: true }),
    supabase.from("offers").select("id", { count: "exact", head: true }),
    // Every hire, paged to a short page by the unique `id`: a hire a response cap dropped would leave
    // the source-of-hire report short with nothing to say so.
    fetchAllRows<{
      id: string;
      candidate_id: string | null;
      converted_employee_hr_id: string | null;
      attributed_channel_code: string | null;
      last_stage_changed_at: string | null;
    }>(
      () =>
        supabase
          .from("ats_applications")
          .select("id,candidate_id,converted_employee_hr_id,attributed_channel_code,last_stage_changed_at")
          .eq("stage", "hired"),
      "id",
    ),
    listJobPostChannels({ includeInactive: true }),
  ]);

  // The automatic advert for the hired candidates only — a targeted read, not the whole intake log.
  const hiredCandidateIds = Array.from(
    new Set(hiredAppRows.map((row) => (row.candidate_id ? String(row.candidate_id) : "")).filter(Boolean)),
  );
  const intakeCodeByCandidate = new Map<string, string>();
  // Batches of a hundred ids (a longer `.in()` overflows the request URL and answers no rows, not an
  // error), each paged to a short page. A candidate's events all sit in one batch, so the earliest
  // code per candidate is exact.
  const intakeRows: Record<string, unknown>[] = [];
  for (const batch of chunkIds(hiredCandidateIds)) {
    intakeRows.push(
      ...(await fetchAllRows<Record<string, unknown>>(
        () =>
          supabase
            .from("ats_cv_intake_events")
            .select("candidate_id,source_channel_code,created_at")
            .in("candidate_id", batch)
            .not("source_channel_code", "is", null),
        "id",
      )),
    );
  }
  for (const [candidateId, code] of earliestCodePerCandidate(
    intakeRows.map((r) => ({
      candidateId: r.candidate_id == null ? null : String(r.candidate_id),
      code: r.source_channel_code == null ? null : String(r.source_channel_code),
      createdAt: r.created_at == null ? null : String(r.created_at),
    })),
  )) {
    intakeCodeByCandidate.set(candidateId, code);
  }

  const coarseSourceByCandidate = new Map(candidates.map((candidate) => [candidate.id, candidate.source]));
  const hires: HiredApplicationInput[] = hiredAppRows.map((row) => {
    const candidateId = row.candidate_id ? String(row.candidate_id) : "";
    return {
      applicationId: String(row.id),
      candidateId,
      employeeHrId: row.converted_employee_hr_id,
      hiredAt: row.last_stage_changed_at,
      manualChannelCode: row.attributed_channel_code,
      coarseSource: coarseSourceByCandidate.get(candidateId) ?? null,
      autoChannelCode: intakeCodeByCandidate.get(candidateId) ?? null,
    };
  });

  return {
    channels: buildChannelEffectiveness(candidates, events),
    funnel: buildFunnel([
      { label: "Candidates", count: candidates.length },
      { label: "Applications", count: applications.count ?? 0 },
      { label: "Interviews", count: interviews.count ?? 0 },
      { label: "Offers", count: offersMade(governedOffers.count, letterOffers.count) },
      { label: "Hired", count: hiredAppRows.length },
    ]),
    sourceOfHire: buildSourceOfHire(
      hires,
      channels.map((channel) => ({ code: channel.code, name: channel.name, kind: channel.kind })),
    ),
    generatedAt: new Date().toISOString(),
    totalCandidates: candidates.length,
  };
}
