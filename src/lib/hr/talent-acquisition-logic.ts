/**
 * The Talent Acquisition overview's arithmetic — every part of it that is a pure function.
 *
 * WHY IT IS A SEPARATE FILE FROM `talent-acquisition-overview.ts`. Two reasons, and they are the
 * same two that split `src/lib/calendar/logic.ts` from `src/lib/calendar/service.ts`:
 *
 *   1. THE CLIENT NEEDS THESE. The calendar panel is a client component and prints her own
 *      upcoming interviews and the month marks from values this file shapes (`toTalentInterview`,
 *      `TalentMonthMark`). The overview module imports the Supabase services, so a client component
 *      may only `import type` from it; these live here so the component can import them for real.
 *      It no longer lays out a WEEK: since 13 October 2026 the week tab mounts the real
 *      `InterviewCalendarView`, which reads and lays out its own weeks.
 *   2. A TEST SHOULD NOT NEED A DATABASE to assert that a rate is null rather than zero. Everything
 *      this file holds is driven by literals, which is why the rules worth pinning are all in here.
 *
 * Nothing in this file reads anything. If a function added here needs a client, a service or an
 * `AccessContext`, it belongs in the overview module instead.
 */

import type { HrBundleName } from "@/lib/auth/hr-functions";
import type { HrCommandTile } from "@/lib/hr/command-center";
import type { CalendarGridDay, CalendarItem } from "@/lib/calendar/logic";
import type { InterviewBooking, InterviewCalendarRole } from "@/lib/recruitment/interview-calendar-types";
import { formatTimeOfDay, formatTimeRange } from "@/lib/recruitment/interview-calendar-week";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { isIsoDate, parseLetterDate } from "@/lib/offers/dates";
import type { OfferRecord } from "@/lib/offers/types";
import type { DailyCvDigest } from "@/lib/recruitment/inbound/daily-cv-digest";
import { HR_WORKSPACE_BASE_PATH, workspaceHref } from "@/lib/recruitment/workspace/links";

/** The seat this page is built for. The route's gate, and the only bundle it ever renders. */
export const TALENT_ACQUISITION_SEAT: HrBundleName = "HR Resourcing";

/**
 * How far back the interview-to-offer ratio looks.
 *
 * BOTH halves are windowed, and on the same window — see the header of interview-volume.ts for why
 * a lifetime ratio would divide this month's offers by every interview ever held. Ninety days is
 * wide enough to hold a full hiring cycle for a medical rep and short enough that the figure still
 * moves when the work does.
 */
export const KPI_WINDOW_DAYS = 90;

/**
 * The task keys this page shows — her RECRUITING queues, and nothing else.
 *
 * An allow-list rather than a block-list of one. `buildHrTodayTasks` is driven by the seat's whole
 * bundle, so a function added to it later would put a queue on this page silently; the owner's
 * instruction was that this page carries her recruiting work, so a task not named here does not
 * appear until somebody decides it should. `answer-support-requests` is the one it excludes today,
 * by his words — and it cannot appear in any case, because this page never reads that source.
 */
export const RECRUITING_TASK_KEYS: readonly string[] = [
  "screen-candidates",
  "advance-interviews",
  "close-filled-requisitions",
  "raise-requisitions",
  "chase-offers",
];

/**
 * One measured KPI from her handbook.
 *
 * `rate` is 0..1 or NULL, and null is the whole point of the type: it means the denominator is
 * zero, which is a stated absence and not a score of zero. `emptyLabel` is rendered in its place
 * and says what the measure WOULD show — the same rule the charts on this page follow.
 */
export type TalentKpi = {
  /** What the two halves count, in a sentence a person who has held the job four days can read. */
  caption: string;
  denominator: number;
  /** The unit under the denominator — "people interviewed". Never a sentence. */
  denominatorLabel: string;
  /** Shown instead of a percentage when there is nothing to divide by. NEVER "0%". */
  emptyLabel: string;
  href: string;
  hrefLabel: string;
  key: string;
  label: string;
  numerator: number;
  numeratorLabel: string;
  rate: number | null;
};

/**
 * A KPI with its rate derived once, and NULL rather than zero on an empty denominator.
 *
 * Every KPI on this page is built through here, so the rule cannot be forgotten at one call site.
 * It is not defensive style: on 13 October 2026 production holds **36 probation cases and 0
 * decided**, so `rollupOutcomes` returns `passRate: 0` — and printing that would tell her on her
 * first morning that no new hire has ever passed probation.
 */
export function kpi(input: Omit<TalentKpi, "rate">): TalentKpi {
  return { ...input, rate: input.denominator > 0 ? input.numerator / input.denominator : null };
}

/** One interview on her calendar, flattened to what a landing page prints. */
export type TalentInterview = {
  candidateName: string;
  dateKey: string;
  href: string;
  id: string;
  interviewerName: string | null;
  /** How long it runs, in minutes — the figure `timeLabel`'s end time is built from. */
  durationMinutes: number;
  /**
   * The role this round is for — the booking's own `jobTitle`, else what the candidate applied for.
   * Null when neither names one; the page then prints nothing rather than "Role not set".
   */
  jobTitle: string | null;
  /** "Zoom", "In person" — the platform as a person reads it, never the stored token. */
  platformLabel: string;
  startMinutes: number;
  /** "10:00 - 10:30", from the calendar's own formatter. */
  timeLabel: string;
};

/** Somebody's joining day, from an ACCEPTED offer's own start date. */
export type TalentJoiner = {
  dateKey: string;
  href: string;
  id: string;
  name: string;
  title: string;
};

/** One thing on a month-grid day, from whichever calendar put it there. */
export type TalentMonthMark = {
  kind: "birthday" | "event" | "holiday" | "interview" | "joining" | "leave" | "plan";
  title: string;
};

export type TalentCalendarMonth = {
  /** "October 2026". */
  label: string;
  /** Keyed `YYYY-MM-DD`. Built once, so a 6x7 grid does not rescan every item 42 times. */
  marksByDay: Record<string, TalentMonthMark[]>;
  month: number;
  weeks: CalendarGridDay[][];
  year: number;
};

/**
 * WHAT THE REAL INTERVIEW CALENDAR NEEDS TO RUN INSIDE THIS PAGE — resolved on the server, exactly
 * as `app/(admin)/recruitment/interview-calendar/page.tsx` resolves it for the full page.
 *
 * The week tab IS `InterviewCalendarView`: the owner asked for the FULL interview calendar features
 * on her landing page (13 October 2026), so the page does not re-implement any part of it — it
 * mounts it and hands it the same four answers the recruitment page does. Each one is a SERVER
 * decision and every API route behind the component asks again, so a prop that said more than her
 * seat holds would buy nothing.
 *
 * NULL when `resolveInterviewCalendarRole` gives her no role at all. Her seat resolves to a Viewer
 * through `seesWholeInterviewCalendar`, so that is not the expected case — it is carried because the
 * role is a runtime resolution, and a calendar drawn with no role would be a blank week, which is
 * the one wrong answer a diary can give.
 */
export type TalentInterviewCalendar = {
  /** Whether she may search candidates / add one to Recruitment from inside the calendar. */
  abilities: { canAddToRecruitment: boolean; canSearchCandidates: boolean };
  /** Whether she reads the requests waiting for a time, read-only — her seat (`readsInterviewRequestInbox`). */
  canReadRequests: boolean;
  /** Whether she may ASK for an interview — true for any HR seat (`mayRequestInterviews`). */
  canRequest: boolean;
  /** Viewer, Commenter, Editor, Owner, interviewer or requester — her tier on the calendar. */
  role: InterviewCalendarRole;
  /** Whether the Zoom integration is configured at all; the screen hides what it cannot do. */
  zoomConnected: boolean;
};

export type TalentCalendar = {
  /**
   * The props the embedded Interview Calendar runs on. Null = no role; the panel says so rather
   * than drawing an empty week. See `TalentInterviewCalendar`.
   */
  interviewCalendar: TalentInterviewCalendar | null;
  /** Her own next three weeks, from the calendar's own `listMyUpcomingInterviews`. */
  mine: TalentInterview[];
  /**
   * FALSE when that read REFUSED or failed. Her agenda is then unknown, not empty, and the Mine tab
   * says so — "you are not on an interview" drawn over a failed read is the one wrong answer a diary
   * can give, and it is the answer that makes somebody miss an interview.
   */
  mineLoaded: boolean;
  /**
   * Never null: the grid itself is arithmetic (`buildMonthGrid`), so a failed company-calendar read
   * costs the holidays and the leave, not the month. `monthItemsLoaded` says which it is.
   */
  month: TalentCalendarMonth;
  /** FALSE when the company calendar did not answer — the grid then carries only her own two kinds. */
  monthItemsLoaded: boolean;
  /**
   * The instant the server built this page, in ms. It changes on every 60-second re-read, which is
   * what tells the embedded week grid (that fetches its own data) to read its week again.
   */
  refreshedAt?: number;
  /**
   * Today, in Cairo, as the SERVER saw it.
   *
   * Carried rather than computed in the component, because the month grid marks today whatever week
   * the week strip happens to be showing — deriving it from the strip would lose today the moment
   * she pages to another week, and computing it in the browser would make the first client render
   * disagree with the server's across a Cairo midnight.
   */
  todayKey: string;
  /** The Sunday the embedded calendar opens on (`initialWeek`). Always set — it is arithmetic. */
  weekStart: string;
};

/** "Zoom", "In person", "Phone" — the platform token as a person reads it. */
const PLATFORM_LABELS: Record<string, string> = {
  in_person: "In person",
  phone: "Phone",
  zoom: "Zoom",
};

export function platformLabel(platform: string | null | undefined): string {
  const token = String(platform ?? "").trim();
  return PLATFORM_LABELS[token] ?? (token ? token.replace(/_/g, " ") : "Not set");
}

/** A stored title, trimmed, or null when it is blank — a booking stores "" as often as null. */
function cleanTitle(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

/** One booking, flattened. The link opens the interview on the calendar she already holds. */
export function toTalentInterview(booking: InterviewBooking): TalentInterview {
  return {
    candidateName: booking.candidateName,
    dateKey: booking.dateKey,
    durationMinutes: booking.durationMinutes,
    href: `/hr/recruitment/interview-calendar?open=${encodeURIComponent(booking.id)}`,
    id: booking.id,
    interviewerName: booking.interviewerName,
    jobTitle: cleanTitle(booking.jobTitle) ?? cleanTitle(booking.candidateJobTitle),
    platformLabel: platformLabel(booking.platform),
    startMinutes: booking.startMinutes,
    timeLabel: formatTimeRange(booking.startMinutes, booking.durationMinutes),
  };
}

/**
 * THERE IS NO WEEK LAYOUT IN THIS FILE, AND THERE MUST NOT BE ONE AGAIN.
 *
 * Three week layouts were written for this page in one day and the owner rejected all three — a
 * card per booking, then a ruled list, then a time canvas of blocks positioned by start minute
 * ("2 OUT OF 10", then "BULLSHIT ,, AUDIT THE INTERVIEW CALENDER"). What he asked for instead is
 * the FULL interview calendar: the week tab mounts `InterviewCalendarView` itself, so the grid, the
 * slot split, the week window, the bookings and everything they can do belong to the one component
 * the whole recruitment team already uses. `bookingsInSlot`, `outsideWorkdayInterviews` and
 * `buildWeekDays` were this page's own copies of that work and are gone with it.
 *
 * Account: `docs/agents-owner-rules.md`, "Her week is the interview calendar's own grid".
 */

/**
 * An offer's start date as `yyyy-mm-dd`, or "" when it is neither that nor a letter date.
 *
 * AN OFFER STORES ITS START DATE THE WAY THE LETTER PRINTS IT — "18 October 2026" — so the value is
 * read through the letter-date parser, never sliced as if it were `yyyy-mm-dd`. Sliced, every
 * accepted offer on production fell outside every window and the panel said nobody was joining.
 */
export function offerStartKey(startDate: string | null | undefined): string {
  const raw = (startDate ?? "").trim();
  if (!raw) return "";
  if (isIsoDate(raw.slice(0, 10))) return raw.slice(0, 10);
  return parseLetterDate(raw) ?? "";
}

/**
 * Where a joining row leads: the Job Offers list. The page reads no `?open=<id>` (it takes no search
 * params at all), so a row that carried one only LOOKED like a deep link to that offer.
 */
const OFFERS_HREF = "/hr/offers";

/**
 * The day an accepted offer's person walks in. Once the offer has an employee record, THAT record's
 * hire date wins — it is the date attendance and payroll run from, and HR can move it after the
 * letter went out (measured 2026-10-16: a letter said 17 October while the employee record said
 * 24 October). Until there is a record, the letter's own start date stands.
 */
function joiningDayKey(
  offer: OfferRecord,
  hireDateByHrId: ReadonlyMap<string, string> | undefined,
): string {
  const key = canonicalHrIdKey(offer.employeeHrId);
  const hired = key ? (hireDateByHrId?.get(key) ?? "") : "";
  return isIsoDate(hired) ? hired : offerStartKey(offer.startDate);
}

/**
 * The joining days inside a span, from the offers that were ACCEPTED.
 *
 * `OfferFields.startDate` is the date the letter itself names, which is the date she onboards
 * against — not a derived or forecast one. Only `accepted` offers count: a start date on a letter
 * still awaiting a reply is a proposal, and drawing it as a joining day would put somebody in the
 * diary who has not said yes.
 */
export function joinersBetween(
  offers: readonly OfferRecord[],
  fromKey: string,
  toKey: string,
  hireDateByHrId?: ReadonlyMap<string, string>,
): TalentJoiner[] {
  return offers
    .filter((offer) => offer.status === "accepted")
    .map((offer) => ({ offer, start: joiningDayKey(offer, hireDateByHrId) }))
    .filter(({ start }) => Boolean(start) && start >= fromKey && start <= toKey)
    .map(({ offer, start }) => ({
      dateKey: start,
      href: OFFERS_HREF,
      id: offer.id,
      name: offer.candidateName,
      title: offer.title,
    }))
    .sort(
      (left, right) =>
        left.dateKey.localeCompare(right.dateKey) || left.name.localeCompare(right.name),
    );
}

/** The company calendar's own item sources, mapped onto this page's mark kinds. */
function markKindFor(item: CalendarItem): TalentMonthMark["kind"] {
  switch (item.source) {
    case "birthday":
      return "birthday";
    case "holiday":
      return "holiday";
    case "leave":
      return "leave";
    case "plan":
      return "plan";
    default:
      return "event";
  }
}

/**
 * Every mark on every day of the month grid — the company calendar's items, with her interviews and
 * the joining days laid over them.
 *
 * A COMPANY ITEM SPANS DAYS and is marked on each of them. `CalendarItem` carries `startDate` and
 * `endDate`, and a four-day holiday drawn only on its first cell would read as a one-day holiday —
 * the grid is the one surface where that difference is visible at a glance.
 */
export function buildMonthMarks(
  weeks: CalendarGridDay[][],
  items: readonly CalendarItem[],
  interviews: readonly TalentInterview[],
  joiners: readonly TalentJoiner[],
): Record<string, TalentMonthMark[]> {
  const marks: Record<string, TalentMonthMark[]> = {};
  const push = (dateKey: string, mark: TalentMonthMark) => {
    (marks[dateKey] ??= []).push(mark);
  };
  const gridDays = weeks
    .flatMap((week) => week.map((day) => day.date))
    .filter((date): date is string => Boolean(date));
  const gridSet = new Set(gridDays);

  for (const item of items) {
    const from = (item.startDate ?? "").slice(0, 10);
    if (!from) continue;
    const to = (item.endDate ?? "").slice(0, 10) || from;
    for (const dateKey of gridDays) {
      if (dateKey >= from && dateKey <= to) {
        push(dateKey, { kind: markKindFor(item), title: item.title });
      }
    }
  }
  for (const interview of interviews) {
    if (gridSet.has(interview.dateKey)) {
      push(interview.dateKey, { kind: "interview", title: interview.candidateName });
    }
  }
  for (const joiner of joiners) {
    if (gridSet.has(joiner.dateKey)) {
      push(joiner.dateKey, { kind: "joining", title: `${joiner.name} joins` });
    }
  }
  return marks;
}

/**
 * The first instant of the KPI window — the same `now - 90 days` arithmetic
 * `countInterviewVolume` uses, so the conversion cards and the interview count cover one period.
 */
export function kpiWindowFromIso(now: Date, days = KPI_WINDOW_DAYS): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/**
 * The live letters as plain keys, for matching an interviewed person to a letter. "Live" is every
 * letter except a withdrawn one and a draft: a draft was never written to anybody and a withdrawn
 * one was pulled, while a sent, accepted or declined letter is an offer the person received.
 */
export function liveLetterKeys(offers: readonly OfferRecord[]): { emails: Set<string>; ids: Set<string> } {
  const emails = new Set<string>();
  const ids = new Set<string>();
  for (const offer of offers) {
    if (offer.status === "withdrawn" || offer.status === "draft") continue;
    if (offer.id) ids.add(String(offer.id));
    const address = (offer.candidateEmail ?? "").trim().toLowerCase();
    if (address) emails.add(address);
  }
  return { emails, ids };
}

/**
 * Her handbook's HIRING QUALITY family — *"Managers get relevant candidates, and new hires pass
 * their probation."* Only the interview-to-offer ratio is drawn; the owner removed the probation
 * retention card from her overview on 2026-10-16.
 */
export function buildHiringQualityKpis(input: {
  /** The windowed interview count, or null when that read failed. See interview-volume.ts. */
  volume: {
    fromIso: string;
    interviews: number;
    /** Of those people, how many hold a live letter — null when the letters were not available. */
    offered: number | null;
    people: number;
    truncated: boolean;
  } | null;
}): TalentKpi[] {
  const kpis: TalentKpi[] = [];

  // ── Interview to offer ────────────────────────────────────────────────────────────────────────
  //
  // THE SAME PEOPLE ON BOTH SIDES (owner, 2026-10-16: "like for like"). The bottom is the distinct
  // people interviewed in the window; the top is how many of THOSE people hold a live offer letter.
  // It used to be every letter written in the window over the people interviewed, which read 66%
  // against a like-for-like 22% on 2026-10-16: it counted withdrawn and test letters, and letters
  // to people who were never on the calendar, so it could pass 100% and the caption had to apologise.
  //
  // It counts offer LETTERS (the `offers` module) and not also `ats_offers`, which is what
  // `offersMade` in hiring-analytics.ts adds together. That is a decision: the letter module is the
  // door this seat uses and the one the Job-offers chart beside it plots, while `ats_offers` is the
  // ATS's own governed offer object and is already inside the pipeline chart's Offer column.
  // Measured 2026-10-13 against production: 43 letters against 2 ATS rows.
  const volume = input.volume;
  // No matched count means the letters were not available. A card for it would be a figure invented
  // out of a failure, so it is left out; the offers read names itself on the page's notice.
  if (volume && volume.offered !== null) {
    kpis.push(
      kpi({
        caption:
          `Of the people interviewed in the last ${KPI_WINDOW_DAYS} days, how many hold an offer letter — ` +
          "withdrawn and draft letters are not counted. A person is matched to a letter through the record their " +
          "CV sits on, or the e-mail on it. Both halves are the same people, so this cannot pass 100%, and it " +
          "moves when your own work moves — it is not a lifetime total.",
        denominator: volume.people,
        denominatorLabel: "people interviewed",
        emptyLabel: "No interview has been held in this period yet.",
        href: "/hr/recruitment/interview-calendar",
        hrefLabel: "Open the Interview Calendar",
        key: "interview-to-offer",
        label: "Interview to offer",
        numerator: volume.offered,
        numeratorLabel: "holding an offer letter",
      }),
    );
  }

  // Probation retention was on this band until 2026-10-16, when the owner had it removed from her
  // overview ("remove this section from ta overview"). Do not put it back.

  return kpis;
}

/**
 * The accepted letters whose person has actually STARTED: an employee record that is active, and a
 * first day that has arrived. A person who said yes and starts next week is an acceptance and not yet
 * a start, which is what the "Offer to join" card used to blur (owner, 2026-10-16).
 *
 * The first day is the Employee Master's hire date when there is one and the letter's own date
 * otherwise (`joiningDayKey`, the rule the joiners panel uses). A record with neither has no first
 * day to have arrived, so it does not count as started.
 */
export function startedOfferIds(
  offers: readonly OfferRecord[],
  input: {
    /** Canonical hr id keys of the employees whose record is active. */
    activeHrIds: ReadonlySet<string>;
    hireDateByHrId: ReadonlyMap<string, string> | undefined;
    todayKey: string;
  },
): Set<string> {
  const started = new Set<string>();
  for (const offer of offers) {
    if (offer.status !== "accepted") continue;
    const key = canonicalHrIdKey(offer.employeeHrId);
    if (!key || !input.activeHrIds.has(key)) continue;
    const day = joiningDayKey(offer, input.hireDateByHrId);
    if (day && day <= input.todayKey) started.add(String(offer.id));
  }
  return started;
}

/**
 * Her handbook's OFFER CONVERSION family — *"The candidates we choose accept the offer and actually
 * join."*
 *
 * BOTH CARDS COUNT THE LETTERS WRITTEN IN THE KPI WINDOW (owner, 2026-10-16). They used to read the
 * newest 200 letters with no date filter under a "Last 90 days" header that only the interview card
 * honoured. A letter with no timestamp is counted out: it cannot be shown to belong to the window.
 *
 * `started` is null when the Employee Master did not load; the join card is then ABSENT rather than
 * drawn as 0 of N, which would say nobody arrived.
 */
export function buildOfferConversionKpis(
  offers: readonly OfferRecord[] | undefined,
  options: { fromIso: string; started: ReadonlySet<string> | null },
): TalentKpi[] {
  if (!offers) return [];
  const inWindow = offers.filter((offer) => (offer.createdAt ?? "") >= options.fromIso);
  const accepted = inWindow.filter((offer) => offer.status === "accepted");
  const declined = inWindow.filter((offer) => offer.status === "declined");
  const started = options.started;

  const cards: TalentKpi[] = [
    kpi({
      caption:
        `Of the offers written in the last ${KPI_WINDOW_DAYS} days that candidates have answered, how many said yes. ` +
        "Letters still awaiting a reply are in neither half — an offer nobody has answered is not a decision yet, " +
        "and counting it would make a busy week look like a bad one.",
      denominator: accepted.length + declined.length,
      denominatorLabel: "offers answered",
      emptyLabel: "No offer has been answered yet.",
      href: "/hr/offers",
      hrefLabel: "Open Job Offers",
      key: "offer-acceptance",
      label: "Offer acceptance",
      numerator: accepted.length,
      numeratorLabel: "offers accepted",
    }),
  ];
  if (started) {
    cards.push(
      kpi({
        caption:
          `Of the offers accepted in the last ${KPI_WINDOW_DAYS} days, how many people are now active employees ` +
          "whose first day has arrived. Someone who said yes and starts next week is in the bottom half and not " +
          "yet the top, so this climbs on its own as first days pass.",
        denominator: accepted.length,
        denominatorLabel: "offers accepted",
        emptyLabel: "No offer has been accepted yet.",
        href: "/hr/offers",
        hrefLabel: "Open Job Offers",
        key: "offer-to-join",
        label: "Offer to join",
        numerator: accepted.filter((offer) => started.has(String(offer.id))).length,
        numeratorLabel: "employee started",
      }),
    );
  }
  return cards;
}

// ── THE REBUILT PAGE (owner, 2026-10-16) ─────────────────────────────────────────────────────────
//
// "do a fucken wide big hilarious full end to end sweep from scratch premium polish to her overview
// landing page". His answers the same evening shaped what follows: the eight figure cards stand in
// THREE LABELLED GROUPS, and three new panels sit under them — today's interviews, the joiners
// arriving in the next fourteen days, and the CVs received today. Every helper below is pure, so the
// rules each one carries are pinned by a test without a database, a clock or a browser.

/** How far ahead the joiners panel looks, in days, counting today as day 0. */
export const JOINERS_WINDOW_DAYS = 14;

/**
 * A `YYYY-MM-DD` key moved by whole days.
 *
 * Done in UTC on purpose: a date KEY has no time of day, so the arithmetic must not have one either.
 * Doing it in local time moves a key across a DST change by an hour and, at midnight, by a whole day —
 * Egypt observes DST, and that is exactly the kind of fault that only appears twice a year.
 */
export function addDaysToKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const moved = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1) + days * 86_400_000);
  return moved.toISOString().slice(0, 10);
}

/** Whole days from one key to another — negative when `to` is earlier. Both are Cairo date keys. */
export function daysBetweenKeys(fromKey: string, toKey: string): number {
  const toUtc = (key: string) => {
    const [year, month, day] = key.split("-").map(Number);
    return Date.UTC(year, (month ?? 1) - 1, day ?? 1);
  };
  return Math.round((toUtc(toKey) - toUtc(fromKey)) / 86_400_000);
}

/**
 * "Today", "Tomorrow", "In 5 days" — how near a joining day is, as a person says it.
 *
 * A date that has already passed reads "Started 2 days ago" rather than a negative count; the panel
 * never asks for one, but a label that printed "In -2 days" would be the one visible sign of it.
 */
export function daysUntilLabel(todayKey: string, dateKey: string): string {
  const days = daysBetweenKeys(todayKey, dateKey);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days > 1) return `In ${days} days`;
  if (days === -1) return "Started yesterday";
  return `Started ${Math.abs(days)} days ago`;
}

/** The three parts of a date block — "SUN", "18", "OCT" — read from the key alone, never a clock. */
export function dateBlockParts(dateKey: string): { day: string; month: string; weekday: string } {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
  return {
    day: String(day ?? ""),
    month: new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(date),
    weekday: new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(date),
  };
}

/** "Friday 16 October" — the day the page is about, from the server's Cairo key. */
export function longDayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    weekday: "long",
  }).format(new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1)));
}

/**
 * How much of a conversion meter to fill, as a whole percentage — or NULL, which draws no meter.
 *
 * NULL in, NULL out: a measure with nothing to divide by has no meter, for the same reason it has no
 * percentage (see `kpi()`). Above 100% fills the meter and no more — interview-to-offer can pass 100%
 * when letters go to people interviewed before the window, and a bar drawn past its own track would
 * break the card it sits in.
 */
export function rateMeterPercent(rate: number | null): number | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  return Math.max(0, Math.min(100, Math.round(rate * 100)));
}

/**
 * A bar's width inside a breakdown, as a whole percentage of the biggest group.
 *
 * Relative to the LARGEST group, not to the total: the bars compare groups with each other, and
 * scaling them to the total makes every bar short on a day with many small groups. A group with any
 * count at all is never drawn thinner than 4%, so "1" is still visibly a bar beside "20".
 */
export function breakdownBarPercent(count: number, largest: number): number {
  if (count <= 0 || largest <= 0) return 0;
  return Math.max(4, Math.round((count / largest) * 100));
}

/** The three groups the six figure cards stand in, in the order he reads them. */
export type TalentTileGroupKey = "seats" | "candidates" | "outcomes";

export type TalentTileGroupSpec = {
  /** One short line under the caption — what the group answers. */
  caption: string;
  key: TalentTileGroupKey;
  label: string;
  /** The tile keys that belong here, in their reading order. */
  tileKeys: readonly string[];
};

/**
 * THE THREE GROUPS: Seats, Candidates, Outcomes. Re-cut 2026-10-16 (owner: vacants by line with the
 * actual number against the line's total structure, Hired and Offers Out as they were, a CVs
 * Received card, "and remove the rest of the key cards") from eight figures to six.
 *
 * Keyed on TILE KEYS, never on a label — a label is worded for a person and is reworded freely.
 */
export const TALENT_TILE_GROUPS: readonly TalentTileGroupSpec[] = [
  {
    caption: "Empty seats, by line",
    key: "seats",
    label: "Seats",
    tileKeys: ["vacants-pedia", "vacants-anti-infective", "vacants-cns"],
  },
  {
    caption: "CVs that reached the pool",
    key: "candidates",
    label: "Candidates",
    tileKeys: ["cvs-received"],
  },
  {
    caption: "Hires and open offers",
    key: "outcomes",
    label: "Outcomes",
    tileKeys: ["hired", "offers-sent"],
  },
];

/**
 * The two figures the shared recruiting builder emits that stay on her page, untouched. The builder
 * serves the HR command centre too, so it keeps every other figure and this page drops them here.
 */
export const TALENT_KEPT_BUILDER_TILE_KEYS: readonly string[] = ["hired", "offers-sent"];

/** The business lines whose seats she sees, in his reading order (Pedia, Anti Infective, CNS). */
export const TALENT_SEAT_LINES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "pedia", label: "Pedia" },
  { key: "anti-infective", label: "Anti Infective" },
  { key: "cns", label: "CNS" },
];

function lineMatches(name: string | null | undefined, label: string): boolean {
  return String(name ?? "").trim().toLowerCase() === label.toLowerCase();
}

/**
 * One card per line: the figure is the line's VACANT SEATS, and the caption puts the actual
 * headcount against the line's total structure — "35 of 36 seats filled".
 *
 * Total structure is the active people in the line plus its open seats, the same sum the CEO
 * landing's "Total structure" card prints for the company (`calculateWorkforceStructureSummary`),
 * so a line's three numbers always add up. The open seats come from `openWorkforceSeats`, which has
 * already deduplicated `position_vacancies` down to distinct seats. A vacancy PARKED on purpose
 * (Cairo Pedia) is still an empty seat and still counts here — it is parked from recruiting, not
 * from the structure.
 */
export function buildLineVacancyTiles(input: {
  activeLineNames: ReadonlyArray<string | null | undefined>;
  openSeatLineNames: ReadonlyArray<string | null | undefined>;
}): HrCommandTile[] {
  return TALENT_SEAT_LINES.map((line) => {
    const active = input.activeLineNames.filter((name) => lineMatches(name, line.label)).length;
    const vacant = input.openSeatLineNames.filter((name) => lineMatches(name, line.label)).length;
    const total = active + vacant;
    return {
      href: "/hr/reports/vacancies",
      key: `vacants-${line.key}`,
      label: `Vacants · ${line.label}`,
      sub: `${active} of ${total} seats filled`,
      tone: vacant > 0 ? "amber" : "emerald",
      value: vacant,
    };
  });
}

/**
 * The CVs Received card. `windowPhrase` is `describeWindow(...)`: "in October", or "11 Sep – 22 Sep".
 * With the window, the card opens the workspace on the same received dates (Cairo, inclusive) and
 * with archived rejections included — the count includes them, so the rows it opens must too.
 */
export function buildCvsReceivedTile(
  count: number,
  windowPhrase: string,
  window?: { fromIso: string; toIso: string } | null,
): HrCommandTile {
  return {
    href: window
      ? workspaceHref(
          { archived: "include", fromDate: window.fromIso, toDate: window.toIso },
          { basePath: HR_WORKSPACE_BASE_PATH },
        )
      : "/hr/recruitment",
    key: "cvs-received",
    label: "CVs Received",
    sub: `received ${windowPhrase}`,
    tone: "slate",
    value: count,
  };
}

export type TalentTileGroup<T> = TalentTileGroupSpec & { tiles: T[] };

/**
 * The figure cards, sorted into their groups — and NOTHING DROPPED.
 *
 * A tile whose key no group names (a ninth figure added to the shared builder one day) joins the
 * LAST group rather than vanishing: a figure the builder emits is a figure somebody decided she
 * should see, and silently dropping it is the failure that never shows up in a review. A group with
 * no tiles at all (the directory did not load, so the two seat figures were never built and only
 * Open requisitions is left — or nothing) is left out, so no caption ever sits over an empty row.
 */
export function groupRecruitingTiles<T extends { key: string }>(tiles: readonly T[]): TalentTileGroup<T>[] {
  const claimed = new Set(TALENT_TILE_GROUPS.flatMap((group) => group.tileKeys));
  const strays = tiles.filter((tile) => !claimed.has(tile.key));
  return TALENT_TILE_GROUPS.map((group, index) => {
    const own = group.tileKeys.flatMap((key) => tiles.filter((tile) => tile.key === key));
    const isLast = index === TALENT_TILE_GROUPS.length - 1;
    return { ...group, tiles: isLast ? [...own, ...strays] : own };
  }).filter((group) => group.tiles.length > 0);
}

/**
 * Today's interviews, in the order they happen, and which one is NEXT.
 *
 * `nowMinutes` is minutes past Cairo midnight as the SERVER saw it — the same reason `todayKey` is
 * carried rather than computed in the browser. An interview is `done` once its END has passed, not
 * its start: one that began ten minutes ago is still happening, and greying it out would tell her it
 * is over while the candidate is still in the room. `next` is the first one not done.
 */
export type TalentTodayInterview = TalentInterview & { done: boolean; next: boolean };

export function orderTodaysInterviews(
  interviews: readonly TalentInterview[],
  nowMinutes: number,
): TalentTodayInterview[] {
  const sorted = [...interviews].sort(
    (left, right) =>
      left.startMinutes - right.startMinutes || left.candidateName.localeCompare(right.candidateName),
  );
  const nextId = sorted.find((one) => one.startMinutes + one.durationMinutes > nowMinutes)?.id ?? null;
  return sorted.map((one) => ({
    ...one,
    done: one.startMinutes + one.durationMinutes <= nowMinutes,
    next: one.id === nextId,
  }));
}

/**
 * "2:00" and "PM" — the start alone, for the time column, in the Interview Calendar's own 12-hour
 * reading. The week grid, the "mine" list and every row's accessible name already say "2:00 PM", so
 * the Today panel saying "14:00" put two clocks on one page.
 */
export function startClockParts(startMinutes: number): { suffix: string; time: string } {
  const [time = "", suffix = ""] = formatTimeOfDay(startMinutes).split(" ");
  return { suffix, time };
}

/** Minutes past midnight in Cairo for an instant — the clock `orderTodaysInterviews` reads. */
export function cairoMinutesNow(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: "Africa/Cairo",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/**
 * The CVs received today, as the page carries them: the digest when it loaded, a named failure when
 * it did not, and HIDDEN for a seat that may not read candidates — which draws no panel at all,
 * because a panel that says "could not load" to somebody who was never allowed to see it is a lie.
 */
export type TalentCvToday =
  | { digest: DailyCvDigest; status: "loaded" }
  | { status: "failed" }
  | { status: "hidden" };

/** Today's interviews as the page carries them. `loaded: false` = the read failed, never "none". */
export type TalentToday = {
  interviews: TalentInterview[];
  loaded: boolean;
  nowMinutes: number;
};

/** The joiners panel's span and rows. `loaded: false` = the offers did not load, never "nobody". */
export type TalentJoiners = {
  fromKey: string;
  loaded: boolean;
  rows: TalentJoiner[];
  toKey: string;
};

/**
 * Who arrives in the next fortnight, from the ACCEPTED offers already on the page.
 *
 * No new read: it is `joinersBetween` over the offers `listOffers` already returned, on a window
 * starting TODAY (a joiner starting today is the most important row on the panel, not history).
 * Offers that did not load give `loaded: false`, so the panel says it could not tell rather than
 * printing "nobody is joining" over a failed read.
 */
export function joinersArriving(
  offers: readonly OfferRecord[] | undefined,
  todayKey: string,
  windowDays: number = JOINERS_WINDOW_DAYS,
  hireDateByHrId?: ReadonlyMap<string, string>,
): TalentJoiners {
  const toKey = addDaysToKey(todayKey, windowDays);
  return {
    fromKey: todayKey,
    loaded: offers !== undefined,
    rows: offers ? joinersBetween(offers, todayKey, toKey, hireDateByHrId) : [],
    toKey,
  };
}
