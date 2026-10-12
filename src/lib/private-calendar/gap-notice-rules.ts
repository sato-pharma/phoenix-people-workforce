/**
 * Private Calendar — the weekly "your own calendar has an unexplained day" notice, composed.
 *
 * The PURE half of `gap-notice.ts`. Owner, 2026-10-08: the Request review control has been live since
 * 22 July 2026 and had been used ONCE in two and a half months, across 111 active employees. Nothing
 * was wrong with the control — it sits in every employee's portal nav with no role restriction, and it
 * renders on any day of the viewer's own calendar. What was missing is that NOBODY WAS EVER TOLD TO LOOK:
 * three notifications in the module fire the other way (the Super Admin on a new request, the employee
 * on a decision, and thread replies), so discovery depended on an employee voluntarily opening a
 * portal page and noticing a small button in a section header.
 *
 * 🔴 IT JUDGES NOTHING OF ITS OWN. The days it names come from `getCompanyNoActivityDays`, which is
 * the SAME call the Deductions module's No Records Activity connector makes, over the same engine the
 * employee's own calendar renders. It re-derives no rule, sets no threshold, and reads no table the
 * calendar does not. That is deliberate and load-bearing: the employee's notice, the day the calendar
 * shows them, and the day that can become a payroll deduction candidate are then the same day by
 * construction, and cannot drift apart.
 *
 * 🔴 A day whose only entry is an approved plan IS named here now (owner, 2026-10-12: a weekly plan
 * is never coverage). The engine flags it "No Activity Recorded" like any other empty workday and
 * files a separate `info` note, "Planned, but nothing recorded", carrying what was planned; the
 * connector filter keeps only the "No Activity Recorded" title, so the note itself still reaches
 * nothing. Between 2026-10-07 and his ruling such a day was silent here.
 */

/** The dead-man's-switch slug and the cron-job.org job name. */
export const GAP_NOTICE_JOB_SLUG = "private-calendar-gap-notice";

/**
 * 08:09 Cairo on Saturday. Weekly, the first working morning after the Sat-Thu week it reports, so the
 * week is closed and the employee has the whole new week to answer before anything is adjudicated
 * against it. wday 6 is Saturday (cron-job.org counts 0=Sunday, matching this expression and
 * docs/observability.md).
 *
 * Measured against every declared schedule, 2026-10-08: hour 8 holds exactly one other job, the
 * mailbox offboarding sweep at :15, and NOTHING in the account fires at minute 9 of hour 8. Every
 * minute wildcard misses it - the step expressions land on even minutes, on 0 and 5, or on 4 - and
 * the fixed minutes in use are 0, 3, 5, 13, 15, 17, 20, 23, 33, 35, 40, 43, 45, 47, 49, 50, 51, 53,
 * 55 and 57. So a red execution at 08:09 names ONE job, which is the whole reason the minute is odd.
 */
export const GAP_NOTICE_CRON = "9 8 * * 6";

/**
 * How many dates one notice spells out before it counts the rest. A notice that lists thirty days is
 * not read; one that lists five and says how many more remain is. The employee sees every one of them
 * on the calendar itself, which is where the notice sends them.
 */
export const GAP_NOTICE_MAX_DATES = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type GapNoticeWindow = {
  /** Inclusive Saturday of the reported week, YYYY-MM-DD. */
  fromIso: string;
  /** Inclusive Thursday of the reported week, YYYY-MM-DD. */
  toIso: string;
  /** Human label, e.g. "Sat 3 Oct – Thu 8 Oct". No ellipsis, ever (owner rule). */
  label: string;
};

/** One unexplained day on one employee's own calendar, pared to what the notice needs. */
export type GapNoticeDay = {
  /** YYYY-MM-DD. */
  date: string;
  employeeHrId: string;
  employeeName: string;
};

export type GapNotice = {
  title: string;
  message: string;
  /** The dates named, in order — the idempotency key and the tests read this, not the prose. */
  dates: string[];
};

/**
 * The completed Saturday–Thursday working week relative to a Cairo date.
 *
 * Egypt's working week here is Saturday to Thursday (the weekly plans run Sat→Thu; Friday is the
 * weekend), and the job fires on a Saturday, so the Thursday it reports is two days back and the
 * Saturday is five days before that. Computed from the WEEKDAY rather than a fixed offset so it stays
 * correct if the cron is ever moved: the window end is the most recent Thursday STRICTLY before the
 * run day, and the start is that Thursday minus five days. Date-only arithmetic in UTC — these are
 * calendar days, never instants, so no zone shifts them.
 */
export function gapNoticeWindow(cairoTodayIso: string): GapNoticeWindow {
  const today = new Date(`${cairoTodayIso}T00:00:00.000Z`);
  let end = new Date(today.getTime() - DAY_MS);
  // 4 === Thursday. Walk back at most a week to the nearest Thursday before today.
  while (end.getUTCDay() !== 4) end = new Date(end.getTime() - DAY_MS);
  const start = new Date(end.getTime() - 5 * DAY_MS);
  return {
    fromIso: start.toISOString().slice(0, 10),
    toIso: end.toISOString().slice(0, 10),
    label: `${labelOf(start)} – ${labelOf(end)}`,
  };
}

function labelOf(date: Date): string {
  return `${WEEKDAY_SHORT[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH_SHORT[date.getUTCMonth()]}`;
}

/** The idempotency key: one notice per employee per reported WEEK, so a retry reaches nobody twice. */
export function gapNoticeIdempotencyKey(input: { employeeHrId: string; windowEndIso: string }): string {
  return `private-calendar-gap:${input.windowEndIso}:${input.employeeHrId.trim().toUpperCase()}`;
}

/**
 * Compose one employee's notice.
 *
 * The wording has a job beyond informing: it has to make clear that the employee is not being accused
 * of anything, and that the fix is a sentence they type. "Unexplained" is the strongest word it uses —
 * the day may be perfectly legitimate and simply unrecorded, which is the common case for someone the
 * fingerprint devices do not cover. It names the control ("Request review") and the page, because the
 * portal page always opens on the CURRENT Cairo month and takes no date parameter, so a day in a
 * month already rolled over has to be stepped back to by hand.
 *
 * Dates are rendered as the calendar renders them. Names, never HR ids (owner rule), and no ellipsis.
 */
export function composeGapNotice(input: {
  days: ReadonlyArray<GapNoticeDay>;
  employeeName: string;
  window: GapNoticeWindow;
}): GapNotice {
  const dates = [...new Set(input.days.map((day) => day.date))].sort();
  const named = dates.slice(0, GAP_NOTICE_MAX_DATES);
  const remaining = dates.length - named.length;
  const spelled = named.map((date) => labelOf(new Date(`${date}T00:00:00.000Z`)));
  const list = remaining > 0
    ? `${spelled.join(", ")}, and ${remaining} more day${remaining === 1 ? "" : "s"}`
    : spelled.join(", ");
  const plural = dates.length === 1 ? "day" : "days";

  return {
    dates,
    message:
      `Your Private Calendar has ${dates.length} ${plural} in ${input.window.label} with nothing recorded on `
      + `it: ${list}. This is usually a recording gap rather than a problem — a day away from a `
      + `fingerprint device, or work that was never logged — and it is worth putting right, because `
      + `an unexplained workday can be read as absence. Open Private Calendar in your portal, pick the `
      + `day, and use Request review to say what actually happened and who can confirm it. `
      + `The calendar opens on the current month, so step back to the month you need.`,
    title: `${dates.length} unexplained ${plural} on your calendar`,
  };
}

/**
 * Group the engine's company-wide rows into one bundle per employee, dropping days the employee has
 * ALREADY raised a review request for.
 *
 * Suppression matters more than it looks: without it the notice nags about precisely the day the
 * employee has already done the right thing on, while a Super Admin decision is still pending — which
 * teaches them that using the control achieves nothing. Keyed on the upper-case HR id and the date,
 * because `employees.hr_id` is stored upper-case in all but one row and the dispute table stores
 * whatever the portal sent.
 */
export function bundleGapNoticesByEmployee(input: {
  /** `<UPPER HR ID>|<YYYY-MM-DD>` for every day already under review. */
  alreadyRaised: ReadonlySet<string>;
  days: ReadonlyArray<GapNoticeDay>;
}): Array<{ days: GapNoticeDay[]; employeeHrId: string; employeeName: string }> {
  const byEmployee = new Map<string, { days: GapNoticeDay[]; employeeHrId: string; employeeName: string }>();

  for (const day of input.days) {
    const key = day.employeeHrId.trim().toUpperCase();
    if (!key || !day.date) continue;
    if (input.alreadyRaised.has(`${key}|${day.date}`)) continue;
    const bundle = byEmployee.get(key)
      ?? { days: [], employeeHrId: day.employeeHrId, employeeName: day.employeeName };
    bundle.days.push(day);
    byEmployee.set(key, bundle);
  }

  return [...byEmployee.values()]
    .filter((bundle) => bundle.days.length > 0)
    .sort((left, right) => left.employeeName.localeCompare(right.employeeName));
}

/** The key form both sides of the suppression test must agree on. */
export function gapNoticeDayKey(input: { date: string; employeeHrId: string }): string {
  return `${input.employeeHrId.trim().toUpperCase()}|${input.date}`;
}
