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
import type { CalendarGridDay, CalendarItem } from "@/lib/calendar/logic";
import type { InterviewBooking, InterviewCalendarRole } from "@/lib/recruitment/interview-calendar-types";
import { formatTimeRange } from "@/lib/recruitment/interview-calendar-week";
import type { OfferRecord } from "@/lib/offers/types";

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

/** One booking, flattened. The link opens the interview on the calendar she already holds. */
export function toTalentInterview(booking: InterviewBooking): TalentInterview {
  return {
    candidateName: booking.candidateName,
    dateKey: booking.dateKey,
    durationMinutes: booking.durationMinutes,
    href: `/hr/recruitment/interview-calendar?open=${encodeURIComponent(booking.id)}`,
    id: booking.id,
    interviewerName: booking.interviewerName,
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
): TalentJoiner[] {
  return offers
    .filter((offer) => offer.status === "accepted")
    .filter((offer) => {
      const start = (offer.startDate ?? "").slice(0, 10);
      return Boolean(start) && start >= fromKey && start <= toKey;
    })
    .map((offer) => ({
      dateKey: offer.startDate.slice(0, 10),
      href: `/hr/offers?open=${encodeURIComponent(offer.id)}`,
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
 * Her handbook's HIRING QUALITY family — *"Managers get relevant candidates, and new hires pass
 * their probation."* Only the interview-to-offer ratio is drawn; the owner removed the probation
 * retention card from her overview on 2026-10-16.
 */
export function buildHiringQualityKpis(input: {
  offers: readonly OfferRecord[] | undefined;
  /** The windowed interview count, or null when that read failed. See interview-volume.ts. */
  volume: { fromIso: string; interviews: number; people: number; truncated: boolean } | null;
}): TalentKpi[] {
  const kpis: TalentKpi[] = [];

  // ── Interview to offer ────────────────────────────────────────────────────────────────────────
  //
  // DISTINCT PEOPLE on the bottom, OFFER LETTERS on top, over the same 90 days.
  //
  // It counts offer LETTERS (the `offers` module) and not also `ats_offers`, which is what
  // `offersMade` in hiring-analytics.ts adds together. That is a decision: the letter module is the
  // door this seat uses and the one the Job-offers chart beside it plots, while `ats_offers` is the
  // ATS's own governed offer object and is already inside the pipeline chart's Offer column.
  // Measured 2026-10-13 against production: 43 letters against 2 ATS rows. Naming one door in the
  // caption is honest; adding two doors together and dividing by a third table's people is not.
  const volume = input.volume;
  if (volume) {
    const made = (input.offers ?? []).filter((offer) => (offer.createdAt ?? "") >= volume.fromIso)
      .length;
    kpis.push(
      kpi({
        caption:
          `Of the people interviewed in the last ${KPI_WINDOW_DAYS} days, how many were written an offer letter. ` +
          "Both halves count the same period, so this moves when your own work moves — it is not a lifetime total. " +
          "Above 100% means letters went to people interviewed before this period.",
        denominator: volume.people,
        denominatorLabel: "people interviewed",
        emptyLabel: "No interview has been held in this period yet.",
        href: "/hr/recruitment/interview-calendar",
        hrefLabel: "Open the Interview Calendar",
        key: "interview-to-offer",
        label: "Interview to offer",
        numerator: made,
        numeratorLabel: "offer letters written",
      }),
    );
  }

  // Probation retention was on this band until 2026-10-16, when the owner had it removed from her
  // overview ("remove this section from ta overview"). Do not put it back.

  return kpis;
}

/**
 * Her handbook's OFFER CONVERSION family — *"The candidates we choose accept the offer and actually
 * join."*
 */
export function buildOfferConversionKpis(offers: readonly OfferRecord[] | undefined): TalentKpi[] {
  if (!offers) return [];
  const accepted = offers.filter((offer) => offer.status === "accepted");
  const declined = offers.filter((offer) => offer.status === "declined");
  // The joining form is what creates the employee record, so `employeeHrId` is the proof somebody
  // actually joined. It is NULL for an acceptance HR recorded by hand (`acceptedVia: "hr"`), which
  // is most of them today — measured 2026-10-13: 2 of 26 accepted offers carry one. The caption
  // therefore says what the figure counts, because the gap is a RECORDING gap and not a joining
  // gap, and a reader who took it for the latter would be reading a crisis that is not there.
  const joined = accepted.filter((offer) => Boolean(offer.employeeHrId));

  return [
    kpi({
      caption:
        "Of the candidates who answered an offer, how many said yes. Letters still awaiting a reply are in neither " +
        "half — an offer nobody has answered is not a decision yet, and counting it would make a busy week look " +
        "like a bad one.",
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
    kpi({
      caption:
        "Of the accepted offers, how many have an employee record created from the joining form. An acceptance you " +
        "record by hand carries no employee record, so it counts in the bottom half and not the top — a low figure " +
        "here usually means the joining form was not used, not that people did not join.",
      denominator: accepted.length,
      denominatorLabel: "offers accepted",
      emptyLabel: "No offer has been accepted yet.",
      href: "/hr/offers",
      hrefLabel: "Open Job Offers",
      key: "offer-to-join",
      label: "Offer to join",
      numerator: joined.length,
      numeratorLabel: "joined through the form",
    }),
  ];
}
