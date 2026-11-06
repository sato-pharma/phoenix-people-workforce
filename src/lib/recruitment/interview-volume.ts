/**
 * How much interviewing actually happened — the denominator of the interview-to-offer ratio.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT `loadHiringAnalytics`. The hiring-analytics funnel counts its
 * "Interviews" step from `ats_interviews`, the ATS's own interview object. Measured against
 * production (ozucdzovmcqvepbozvqf) on 13 October 2026: `ats_interviews` holds **2 rows** and
 * `ats_interview_bookings` — the Interview Calendar, which is where interviewing is actually
 * arranged — holds **63**, across **58 distinct people**, every one of them inside the last 90
 * days. So a ratio built on the ATS step would read 2250% and a ratio built on this one reads 78%.
 * The near-1:1 between bookings and people is worth writing down too: the hiring flow has four
 * interview rounds on paper, and in the calendar the rounds are not being booked separately yet, so
 * `people` is not `interviews / 4` and must not be derived as such.
 *
 * DISTINCT PEOPLE, NOT BOOKINGS, is what the KPI divides by. "Interview to offer" asks how many of
 * the people we sat with were offered the job, and counting bookings would punish a candidate who
 * came back for a second round. Both figures are returned anyway: the page prints the people and
 * the caption names the bookings behind them.
 *
 * SOMEBODY FROM OUTSIDE COUNTS. A booking carries either a `candidate_id` or an `external_name`
 * (someone the booker chose not to add to Recruitment) — both are a person who was interviewed, so
 * the external ones are keyed on their name. Dropping them would under-report the denominator,
 * which inflates the ratio.
 *
 * THE NUMERATOR IS THE SAME PEOPLE, NOT A SECOND POPULATION (owner, 2026-10-16: "like for like"). It
 * used to be every offer letter written in the window — withdrawn ones, drafts, letters to people who
 * were never on the calendar — over the people interviewed, so it read 66% against a like-for-like
 * 22% and could pass 100%. `countOfferedPeople` now counts, among the people interviewed, those who
 * hold a live letter, so the top half is a subset of the bottom half by construction. A person is
 * matched to a letter by the letter their candidate record points at (`ats_candidates.offer_id`),
 * else by the e-mail on it; a letter nobody can be traced to is in neither half.
 *
 * A WINDOW, NEVER A LIFETIME. Offers in this system predate the calendar by eleven days, and a
 * lifetime ratio would divide this month's offers by every interview ever held — the same defect
 * the "Hired" tile carried until the owner asked how it could read what it read (see
 * `hiredWindowCaption` in src/lib/hr/command-center.ts). The window is named on the figure.
 *
 * READ, NOT COUNTED, because a distinct count is not something PostgREST will do for us. The read
 * pages to the end, so the figures are a total and never a floor: a fixed row ceiling would have let
 * them stop growing without a sound (nothing on the page ever read the old `truncated` flag), and a
 * select that silently stops at a fixed number is this repo's most expensive recurring trap.
 */

import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The Interview Calendar's bookings. Same table name as src/lib/recruitment/interview-calendar.ts. */
const BOOKINGS = "ats_interview_bookings";

/** Candidate ids per request. An id is a uuid, so a batch of 100 keeps the URL well inside the limit. */
const CANDIDATE_BATCH = 100;

export type InterviewVolume = {
  /** The window's first day, as an ISO instant. Printed in the caption, never recomputed there. */
  fromIso: string;
  /** Interviews held in the window — one row per booking, every round of every candidate. */
  interviews: number;
  /**
   * Of those people, how many hold a live offer letter. NULL when no letters were handed in to match
   * against — the caller's letters did not load — so the ratio is left out rather than drawn as 0%.
   */
  offered: number | null;
  /** DISTINCT people interviewed in the window. The interview-to-offer denominator. */
  people: number;
  /** Always false: the read pages to the end, so both figures are a total. Kept for the callers that carry it. */
  truncated: boolean;
};

/**
 * One booking as this count reads it. Exported so the distinct-person rule below can be driven by
 * literals — the read itself needs a database, the rule that makes the figure right does not.
 */
export type InterviewVolumeRow = {
  candidate_id: string | null;
  external_email?: string | null;
  external_name: string | null;
  starts_at?: string | null;
};

/** What the numerator needs to know about a recruitment record. */
export type InterviewedCandidate = { email: string | null; offerId: string | null };

/**
 * The live letters, as plain keys. "Live" is every letter except a withdrawn one and a draft: a draft
 * was never written to anybody and a withdrawn one was pulled, while a sent, accepted or declined
 * letter IS an offer the person received. Built by the caller from its own offers list so this file
 * never imports the offers module.
 */
export type LiveLetterKeys = { emails: ReadonlySet<string>; ids: ReadonlySet<string> };

/** An address as it is compared: trimmed and lower-cased, nothing cleverer. */
function addressKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * One person, as this count identifies them: the recruitment record when there is one, and the
 * outside person's name (case-folded) when there is not. Returns null for a row carrying neither,
 * which is counted as an interview and not as a person — a booking with no subject at all is a
 * data fault, and inventing a distinct person for it would inflate the denominator.
 */
function personKey(row: InterviewVolumeRow): string | null {
  const candidateId = (row.candidate_id ?? "").trim();
  if (candidateId) return `candidate:${candidateId}`;
  const external = (row.external_name ?? "").trim().toLowerCase();
  return external ? `external:${external}` : null;
}

/**
 * How many DISTINCT people those bookings are. Pure, and the whole rule of this module.
 *
 * Split out from the read so it can be driven by literals: the rule is the thing that makes the
 * interview-to-offer denominator right or wrong, and it is three decisions deep (second rounds
 * collapse, outside people count, a subject-less booking counts as neither). A rule that can only
 * be exercised against the live table is a rule nobody will exercise.
 */
export function countDistinctPeople(rows: readonly InterviewVolumeRow[]): number {
  const people = new Set<string>();
  for (const row of rows) {
    const key = personKey(row);
    if (key) people.add(key);
  }
  return people.size;
}

/**
 * How many of the interviewed people hold a live letter. Pure, like `countDistinctPeople`, and driven
 * by literals in the test: the matching rule is what makes the ratio honest.
 *
 * ONE PERSON IS COUNTED ONCE however many rounds they sat, and a person counts as offered if ANY of
 * their rows is — the candidate record's pointer to a live letter, that record's e-mail on a live
 * letter, or the e-mail typed on an outside booking. Matching is by pointer and address only, never
 * by name: two people share a name, and an offer credited to the wrong one flatters the ratio.
 */
export function countOfferedPeople(
  rows: readonly InterviewVolumeRow[],
  candidates: ReadonlyMap<string, InterviewedCandidate>,
  letters: LiveLetterKeys,
): number {
  const offered = new Set<string>();
  for (const row of rows) {
    const key = personKey(row);
    if (!key || offered.has(key)) continue;
    const candidate = row.candidate_id ? candidates.get(row.candidate_id.trim()) : undefined;
    const pointer = candidate?.offerId ?? "";
    const addresses = [addressKey(candidate?.email), addressKey(row.external_email)].filter(Boolean);
    if ((pointer && letters.ids.has(pointer)) || addresses.some((address) => letters.emails.has(address))) {
      offered.add(key);
    }
  }
  return offered.size;
}

/** The recruitment records behind the interviewed people, read in small batches. */
async function readInterviewedCandidates(
  rows: readonly InterviewVolumeRow[],
): Promise<Map<string, InterviewedCandidate>> {
  const ids = [...new Set(rows.map((row) => (row.candidate_id ?? "").trim()).filter(Boolean))];
  const found = new Map<string, InterviewedCandidate>();
  const supabase = getSupabaseAdmin();
  for (let index = 0; index < ids.length; index += CANDIDATE_BATCH) {
    const { data, error } = await supabase
      .from("ats_candidates")
      .select("id,email,offer_id")
      .in("id", ids.slice(index, index + CANDIDATE_BATCH));
    if (error) throw error;
    for (const record of (data ?? []) as unknown as { email: string | null; id: string; offer_id: string | null }[]) {
      found.set(String(record.id), { email: record.email, offerId: record.offer_id ? String(record.offer_id) : null });
    }
  }
  return found;
}

/**
 * Interviews held, and people interviewed, in the last `days` days.
 *
 * `now` is injectable so a test can drive a fixed window; the default is the real clock. The window
 * is measured in whole days back from the instant, not from a Cairo midnight, because the other
 * half of the ratio (offer letters) is windowed on its own timestamps the same way — a ratio whose
 * two halves use two different window edges is a ratio that drifts by a day every day.
 */
export async function countInterviewVolume(
  days = 90,
  now: Date = new Date(),
  letters?: LiveLetterKeys,
): Promise<InterviewVolume> {
  const from = new Date(now.getTime() - days * 86_400_000);
  const fromIso = from.toISOString();

  const supabase = getSupabaseAdmin();
  const rows = await fetchAllRows<InterviewVolumeRow>(
    () =>
      supabase
        .from(BOOKINGS)
        .select("candidate_id,external_email,external_name,starts_at")
        .gte("starts_at", fromIso)
        // An interview booked for later has not happened yet. Counting its person as "interviewed" put a
        // name in the bottom half that no letter could honestly follow.
        .lte("starts_at", now.toISOString())
        .order("starts_at", { ascending: true }),
    "id",
  );

  const candidates = letters ? await readInterviewedCandidates(rows) : null;

  return {
    fromIso,
    interviews: rows.length,
    offered: letters && candidates ? countOfferedPeople(rows, candidates, letters) : null,
    people: countDistinctPeople(rows),
    truncated: false,
  };
}
