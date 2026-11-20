/**
 * TWO OR MORE INTERVIEWS IN ONE HALF OF THE DAY ARE THAT HALF DAY WORKED (owner, 2026-11-18:
 * "لو 2 انترفيو مثلا الصبح، فده كده يبقى نص يوم صباحي … لو 2 يعني بعد الظهر يبقى كده نص يوم مسائي …
 * 2 انترفيوز او اكتر، دول كده يعتبروا نص يوم" — two interviews in the morning are a morning half day,
 * two in the afternoon an afternoon half day; two or more is half a day).
 *
 * The boundary is 1 PM Cairo by his choice the same day: an interview that STARTS before 13:00 is in
 * the morning, one that starts at 13:00 or later is in the afternoon. It matches the 1 PM split the
 * half-day deductions already read save times by (`half-day-rule.ts`).
 *
 * A single interview in a half covers nothing — it stays on the calendar as display only, as it was
 * from 2026-10-29. Both halves with two or more each is the whole day.
 *
 * THURSDAY, the field force's morning-only day: two or more interviews at ANY hour are that Thursday
 * worked (owner, 2026-11-18, "Any time counts"). Thursday is judged as one half, so there is no
 * afternoon to split it by.
 *
 * Pure, so the rule is pinned by a test with no database. Account:
 * `docs/private-calendar-interviews-half-day.md`.
 */

export type InterviewHalf = "AM" | "PM";

/** 13:00 Cairo — an interview starting from here is in the afternoon. */
const INTERVIEW_AFTERNOON_STARTS_AT_MINUTES = 13 * 60;

/** How many interviews in one half make that half a day worked. */
const INTERVIEWS_THAT_MAKE_A_HALF_DAY = 2;

/** The half an interview belongs to, by the Cairo minute it starts. */
export function interviewHalfOf(startMinutesCairo: number): InterviewHalf {
  return startMinutesCairo < INTERVIEW_AFTERNOON_STARTS_AT_MINUTES ? "AM" : "PM";
}

/** Which halves of one person's day his interviews cover, from the half of each interview he sat in. */
export function interviewHalvesWorked(halves: readonly InterviewHalf[]): { am: boolean; amCount: number; pm: boolean; pmCount: number } {
  const amCount = halves.filter((half) => half === "AM").length;
  const pmCount = halves.filter((half) => half === "PM").length;
  return {
    am: amCount >= INTERVIEWS_THAT_MAKE_A_HALF_DAY,
    amCount,
    pm: pmCount >= INTERVIEWS_THAT_MAKE_A_HALF_DAY,
    pmCount,
  };
}

/** One person-day on which his interviews cover at least one half — or, on a Thursday, the day. */
export type InterviewHalfDay = { am: boolean; amCount: number; date: string; hrId: string; pm: boolean; pmCount: number };

/** A Thursday, the field force's morning-only day (same test as `isFieldWorkforceThursday`). */
function isInterviewThursday(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(`${date}T00:00:00Z`).getUTCDay() === 4;
}

/**
 * What his interviews cover on one day. On a Thursday two or more at any hour are the whole
 * (morning-only) day; on any other day each half needs two or more of its own.
 */
export function interviewDayCover(
  date: string,
  halves: Pick<InterviewHalfDay, "am" | "amCount" | "pm" | "pmCount">,
): "whole" | "AM" | "PM" | null {
  if (isInterviewThursday(date)) return halves.amCount + halves.pmCount >= INTERVIEWS_THAT_MAKE_A_HALF_DAY ? "whole" : null;
  if (halves.am && halves.pm) return "whole";
  if (halves.am) return "AM";
  if (halves.pm) return "PM";
  return null;
}

/** Group interview attendances into the person-days they cover; days covering no half are dropped. Pure. */
export function selectInterviewHalfDays(
  attendances: ReadonlyArray<{ date: string; half: InterviewHalf; hrId: string; interviewId: string }>,
  keyOf: (hrId: string) => string,
): InterviewHalfDay[] {
  const byDay = new Map<string, { date: string; halves: Map<string, InterviewHalf>; hrId: string }>();
  for (const attendance of attendances) {
    const person = keyOf(attendance.hrId);
    if (!person || !attendance.date) continue;
    const key = `${person}|${attendance.date}`;
    const day = byDay.get(key) ?? { date: attendance.date, halves: new Map<string, InterviewHalf>(), hrId: attendance.hrId };
    // One interview counts once for a person, however many times the booking names him.
    day.halves.set(attendance.interviewId, attendance.half);
    byDay.set(key, day);
  }
  const out: InterviewHalfDay[] = [];
  for (const day of byDay.values()) {
    const worked = interviewHalvesWorked([...day.halves.values()]);
    if (!interviewDayCover(day.date, worked)) continue;
    out.push({ date: day.date, hrId: day.hrId, ...worked });
  }
  return out.sort((left, right) => `${left.hrId}|${left.date}`.localeCompare(`${right.hrId}|${right.date}`));
}

/** The reason line a deduction reader prints beside a day the interviews prove. */
export function describeInterviewHalfDay(day: Pick<InterviewHalfDay, "am" | "amCount" | "date" | "pm" | "pmCount">): string {
  if (isInterviewThursday(day.date)) {
    return `Interviews on the recruitment calendar: ${day.amCount + day.pmCount} on a Thursday — the Thursday worked`;
  }
  const parts: string[] = [];
  if (day.am) parts.push(`${day.amCount} in the morning`);
  if (day.pm) parts.push(`${day.pmCount} in the afternoon`);
  const which = day.am && day.pm ? "the whole day" : day.am ? "the morning half" : "the afternoon half";
  return `Interviews on the recruitment calendar: ${parts.join(" and ")} — ${which} worked`;
}
