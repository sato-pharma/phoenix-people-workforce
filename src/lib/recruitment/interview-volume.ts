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
 * A WINDOW, NEVER A LIFETIME. Offers in this system predate the calendar by eleven days, and a
 * lifetime ratio would divide this month's offers by every interview ever held — the same defect
 * the "Hired" tile carried until the owner asked how it could read what it read (see
 * `hiredWindowCaption` in src/lib/hr/command-center.ts). The window is named on the figure.
 *
 * READ, NOT COUNTED, because a distinct count is not something PostgREST will do for us — and a
 * read has a ceiling, so `truncated` says when the figures became a floor rather than a total
 * rather than letting them silently stop growing. At 63 rows in the first three weeks the cap is
 * roughly a decade away; it is here because a select that silently stops at 1000 is this repo's
 * most expensive recurring trap, not because this table is near it.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The Interview Calendar's bookings. Same table name as src/lib/recruitment/interview-calendar.ts. */
const BOOKINGS = "ats_interview_bookings";

/** The read ceiling. See the header — `truncated` reports it rather than hiding it. */
const READ_CAP = 5000;

export type InterviewVolume = {
  /** The window's first day, as an ISO instant. Printed in the caption, never recomputed there. */
  fromIso: string;
  /** Interviews held in the window — one row per booking, every round of every candidate. */
  interviews: number;
  /** DISTINCT people interviewed in the window. The interview-to-offer denominator. */
  people: number;
  /** True when the read hit `READ_CAP`: both figures are then a floor, not a total. */
  truncated: boolean;
};

/**
 * One booking as this count reads it. Exported so the distinct-person rule below can be driven by
 * literals — the read itself needs a database, the rule that makes the figure right does not.
 */
export type InterviewVolumeRow = {
  candidate_id: string | null;
  external_name: string | null;
  starts_at?: string | null;
};

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
): Promise<InterviewVolume> {
  const from = new Date(now.getTime() - days * 86_400_000);
  const fromIso = from.toISOString();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(BOOKINGS)
    .select("candidate_id,external_name,starts_at")
    .gte("starts_at", fromIso)
    .order("starts_at", { ascending: true })
    .range(0, READ_CAP - 1);
  if (error) throw error;

  const rows = (data ?? []) as unknown as InterviewVolumeRow[];

  return {
    fromIso,
    interviews: rows.length,
    people: countDistinctPeople(rows),
    truncated: rows.length >= READ_CAP,
  };
}
