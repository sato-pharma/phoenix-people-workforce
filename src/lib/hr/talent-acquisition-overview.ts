/**
 * The Talent Acquisition seat's own landing page — built from her handbook, not from her bundle.
 *
 * WHY IT IS NOT `getHrCommandCenterData`. That function composes a page out of a seat's FUNCTION
 * BUNDLE: one group of tiles per function, in the order the permissions declare them. It is the
 * right shape for a seat whose job is "whatever these functions are", and it was what she had. The
 * owner's instruction on 13 October 2026 was to replace it for her alone: *"donot touch photo or
 * identity banner and from scratch build her overview landing page but note i like Live candidates,
 * by pipeline stage / live calendar and Job offers, by status / totally donot show employee
 * requests"*, and, with her handbook attached, *"here is her job description and kpis tailor based
 * on this"*.
 *
 * So the spine of this page is **section 06 of SATO-DIS-2026-01 v1.0** — Yomna Gamal, Talent
 * Acquisition Specialist, first day Sunday 18 October 2026 — and its figures are her own KPI
 * families, in her handbook's order:
 *
 *   Conversion — interview to offer · offer acceptance · offer to join   (three key cards)
 *   The field  — the eight recruiting figures, in three groups: Seats · Candidates · Outcomes
 *
 * REBUILT 2026-10-16 ("from scratch premium polish to her overview landing page"). The two charts
 * he once named (Live candidates by pipeline stage, Job offers by status) are NOT built here any
 * more: he ticked both as duplicates of the cards the same day ("remove duplicates"). In their place
 * this loader carries the three panels he chose that evening — today's interviews, the joiners
 * arriving in the next fourteen days, and the CVs received today.
 *
 * TWO KPI FAMILIES ARE DELIBERATELY ABSENT, and that is the owner's own answer in chat, not an
 * omission to be "completed" later: **Retention support** (early attrition, documented risk cases)
 * and **Employee connection** (case closure time, recurring themes). Neither has an honest source
 * for this seat — the employee directory omits people who have resigned, the Retention Register is
 * a grant the owner withheld from her by name and has never held a row, and `SupportRequestRow`
 * carries no closed-at column at all, so a closure time could only be invented. He was shown that
 * and said to leave both families off the page. Do not add a tile for any of the four.
 *
 * EMPLOYEE REQUESTS IS OFF THE PAGE, NOT OUT OF HER SEAT. "totally donot show employee requests" is
 * about this page. `employee_requests` stays in her bundle, the HR Support Requests row stays on her
 * sidebar, and her grants are untouched — this page renders no group, no fortnight chart and no
 * `answer-support-requests` task, and does not read the source either. Taking the grant away would
 * be a different instruction, and he did not give it.
 *
 * EVERY FIGURE IS THE REPO'S OWN. The tiles come from the SAME builder the generic page uses
 * (`buildRecruitingTiles` in command-center.ts), the personal record from `loadPersonalRecord`,
 * the tasks from `buildHrTodayTasks`, the calendar and today's interviews from the Interview
 * Calendar's own services, the joiners from `joinersBetween` over the offers already loaded, and the
 * CVs received today from the daily CV digest's own `buildTodaysCvDigest`. Nothing here recomputes a
 * figure a page already computes; a faster bespoke count would be the same mistake as an export
 * that does not match the screen.
 *
 * SOURCES ARE STILL GATED ON HER BUNDLE. `sourcesFor(seat)` decides what may be fetched, exactly as
 * it does for the generic page — a bespoke page that read whatever it liked would walk straight past
 * the guarantee at the top of command-center.ts. `workforce_context` gained `vacationsToday`
 * on 2026-10-13 so this page's vacation panel is declared work rather than assumed work. The
 * `probationOutcomes` source stays declared on her bundle, but this page no longer reads it.
 *
 * THE ARITHMETIC IS NOT IN THIS FILE. Every pure part of it — the KPI builders, the week strip, the
 * month marks, the joining days — is in `talent-acquisition-logic.ts`, because the calendar panel
 * refreshes itself in the browser and must lay a booking out exactly as this file did. See that
 * file's header.
 */

import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import { HR_ROLE_BUNDLES, type HrBundleName } from "@/lib/auth/hr-functions";
import { hrefOutsideSeatFence } from "@/lib/auth/seat-page-fences";
import { buildMonthGrid } from "@/lib/calendar/logic";
import { getCompanyCalendarWorkspace } from "@/lib/calendar/service";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  buildRecruitingTiles,
  hrBundleForRole,
  loadPersonalRecord,
  safe,
  SOURCE_LABELS,
  sourcesFor,
  type HrCommandSources,
  type HrCommandTile,
  type HrPersonalRecord,
  type SourceKey,
} from "@/lib/hr/command-center";
import {
  buildHiringQualityKpis,
  buildMonthMarks,
  buildOfferConversionKpis,
  cairoMinutesNow,
  joinersArriving,
  joinersBetween,
  KPI_WINDOW_DAYS,
  RECRUITING_TASK_KEYS,
  TALENT_ACQUISITION_SEAT,
  toTalentInterview,
  type TalentCalendar,
  type TalentCvToday,
  type TalentJoiners,
  type TalentKpi,
  type TalentToday,
} from "@/lib/hr/talent-acquisition-logic";
import { buildHrTodayTasks, type HrTask } from "@/lib/hr/today-tasks";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { listOffers } from "@/lib/offers/service";
import type { OfferRecord } from "@/lib/offers/types";
import {
  getRecruitmentDashboard,
  resolveHiredWindow,
  type HiredWindow,
} from "@/lib/recruitment/dashboard";
import {
  interviewCalendarAbilities,
  interviewCalendarCaller,
  listInterviewCalendarDay,
  listInterviewCalendarWeek,
  listMyUpcomingInterviews,
  mayRequestInterviews,
  resolveInterviewCalendarRole,
  type InterviewCalendarCaller,
} from "@/lib/recruitment/interview-calendar";
import {
  cairoDateKey,
  upcomingWeekStart,
  weekStartFor,
} from "@/lib/recruitment/interview-calendar-week";
import { buildTodaysCvDigest } from "@/lib/recruitment/inbound/daily-cv-digest";
import { countInterviewVolume } from "@/lib/recruitment/interview-volume";
import { listOnVacationToday, type OnVacationTodayRow } from "@/lib/vacation/on-vacation-today";
import { isZoomConfigured } from "@/lib/zoom/meetings";

export { TALENT_ACQUISITION_SEAT, KPI_WINDOW_DAYS, RECRUITING_TASK_KEYS };

export type TalentAcquisitionOverviewData = {
  calendar: TalentCalendar;
  /**
   * The CVs that arrived today (Cairo), counted by the daily digest's own builder. Three states, not
   * two: a seat that may not read candidates gets no panel at all, and a FAILED read is said — never
   * drawn as "0 CVs today", which is the one wrong answer a count of arrivals can give.
   */
  cvToday: TalentCvToday;
  /** Responsibilities 01-04: the recruiting figures and the Hired card's window. */
  field: { hiredWindow: HiredWindow; tiles: HrCommandTile[] };
  hiringQuality: TalentKpi[];
  /** Accepted offers starting from today to fourteen days ahead. */
  joiners: TalentJoiners;
  offerConversion: TalentKpi[];
  onVacationToday: OnVacationTodayRow[] | null;
  personal: HrPersonalRecord;
  seat: HrBundleName;
  /** Her recruiting queues only — never the support desk. See `RECRUITING_TASK_KEYS`. */
  tasks: HrTask[];
  /** Every interview on the calendar today that her seat may read, with the server's Cairo clock. */
  today: TalentToday;
  unavailableSources: string[];
};

/** Re-point a link at a page the seat can actually open, or drop it. The rule the tiles follow. */
function fenced<T extends { href: string }>(seat: HrBundleName, rows: readonly T[]): T[] {
  return rows.flatMap((row) => {
    const href = hrefOutsideSeatFence(seat, row.href);
    return href ? [{ ...row, href }] : [];
  });
}

/**
 * Every interview on the month grid, as one read per grid week, in parallel.
 *
 * The Interview Calendar's reader is WEEK-SHAPED and its gate is week-shaped with it
 * (`requireCalendarAccess(caller, "view", weekStart)`), so asking it six times is how this stays
 * inside the calendar's own permission model instead of reaching past it into the table. Each read
 * that refuses contributes nothing and the others still draw. Six reads is the price of the month
 * view being instant rather than a navigation; they are parallel, and the grid's weeks are already
 * Sunday-started so `weekStartFor` only normalises them.
 */
async function listMonthInterviews(caller: InterviewCalendarCaller, weekStarts: string[]) {
  const results = await Promise.all(
    weekStarts.map((start) => listInterviewCalendarWeek(caller, start).catch(() => null)),
  );
  return results.flatMap((result) => (result?.bookings ?? []).map(toTalentInterview));
}

/**
 * Her calendar: the real Interview Calendar's own props, her own next three weeks, and the month.
 *
 * THE WEEK IS NOT BUILT HERE ANY MORE (13 October 2026 — "FULL INTERVIW CALENDAR FEAATURES"). The
 * week tab mounts `InterviewCalendarView`, which reads its own weeks from
 * `/api/recruitment/interview-calendar/bookings`; this function resolves the four answers that
 * component takes — her role, her abilities, whether she may request, and whether Zoom is wired —
 * the same four the recruitment page resolves, by the same functions.
 *
 * Each part still fails ALONE and says so. A dead company-calendar table costs the holidays and the
 * leave and leaves the month grid standing; no role at all costs the week and says that too.
 * Nothing here renders an absence as an empty day.
 */
async function loadCalendar(
  access: AccessContext,
  offers: readonly OfferRecord[] | undefined,
  options: { month?: { month: number; year: number } | null; now: Date; week?: string | null },
): Promise<{ calendar: TalentCalendar; today: TalentToday }> {
  const now = options.now;
  const todayKey = cairoDateKey(now);
  // THE SAME WEEK THE REAL CALENDAR PAGE OPENS ON — `upcomingWeekStart`, not the week today sits in.
  // The two differ on a FRIDAY and a SATURDAY, which are not working days here: the week containing
  // today is then Sunday-to-Thursday entirely in the past, so her landing page would open every
  // weekend on a week that is over, with the next one a click away and nothing saying so. A deep
  // link (`?taWeek=`) still wins — it is somebody asking for a particular week by name.
  const weekStart =
    options.week && /^\d{4}-\d{2}-\d{2}$/.test(options.week)
      ? weekStartFor(options.week)
      : upcomingWeekStart(now);
  const { year, month } = options.month ?? currentCairoDateParts();

  const caller = await interviewCalendarCaller(access).catch(() => null);
  const [mine, todays, workspace, role, abilities, canRequest] = await Promise.all([
    caller ? listMyUpcomingInterviews(caller, now).catch(() => null) : null,
    // Today's interviews, read through the calendar's own DAY reader and its own gate — the same
    // bookings the week grid draws, never a second query of the table.
    caller ? listInterviewCalendarDay(caller, todayKey).catch(() => null) : null,
    getCompanyCalendarWorkspace(access, year, month).catch(() => null),
    resolveInterviewCalendarRole(access).catch(() => null),
    interviewCalendarAbilities(access).catch(() => ({
      canAddToRecruitment: false,
      canSearchCandidates: false,
    })),
    mayRequestInterviews(access).catch(() => false),
  ]);

  // The grid is arithmetic, so it exists whether or not the company calendar answered.
  const weeks = workspace?.weeks ?? buildMonthGrid(year, month);
  const gridDates = weeks
    .flatMap((row) => row.map((day) => day.date))
    .filter((date): date is string => Boolean(date))
    .sort();
  const monthWeekStarts = [
    ...new Set(
      weeks
        .map((row) => row.find((day) => day.date)?.date)
        .filter((date): date is string => Boolean(date))
        .map((date) => weekStartFor(date)),
    ),
  ];
  const monthInterviews = caller ? await listMonthInterviews(caller, monthWeekStarts) : [];
  const monthJoiners = joinersBetween(
    offers ?? [],
    gridDates[0] ?? `${year}-${String(month).padStart(2, "0")}-01`,
    gridDates[gridDates.length - 1] ?? gridDates[0] ?? "",
  );
  const calendar: TalentCalendar = {
    interviewCalendar: role ? { abilities, canRequest, role, zoomConnected: isZoomConfigured() } : null,
    mine: (mine ?? []).map(toTalentInterview),
    mineLoaded: mine !== null,
    month: {
      label: new Intl.DateTimeFormat("en-GB", {
        month: "long",
        timeZone: "UTC",
        year: "numeric",
      }).format(new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00Z`)),
      marksByDay: buildMonthMarks(weeks, workspace?.items ?? [], monthInterviews, monthJoiners),
      month,
      weeks,
      year,
    },
    monthItemsLoaded: workspace !== null && workspace.schemaReady,
    todayKey,
    weekStart,
  };
  return {
    calendar,
    today: {
      interviews: (todays?.bookings ?? []).map(toTalentInterview),
      loaded: todays !== null,
      nowMinutes: cairoMinutesNow(now),
    },
  };
}

export async function getTalentAcquisitionOverview(
  access: AccessContext,
  options: {
    hiredWindow?: { from?: string | null; to?: string | null };
    month?: { month: number; year: number } | null;
    now?: Date;
    week?: string | null;
  } = {},
): Promise<TalentAcquisitionOverviewData | null> {
  const seat = hrBundleForRole(access.role);
  if (seat !== TALENT_ACQUISITION_SEAT) return null;

  const now = options.now ?? new Date();
  const hiredWindow = resolveHiredWindow(options.hiredWindow ?? {});

  // Gated on her bundle, exactly as the generic page is. `supportRequests` is in that set, because
  // `employee_requests` is still her function — and this page deliberately never asks for it, so
  // the band cannot come back by accident and the read is not paid for either.
  const needed = new Set(sourcesFor(seat));
  const failures: SourceKey[] = [];
  const loaded: HrCommandSources = {};

  const personalPromise = loadPersonalRecord(access);

  await Promise.all([
    needed.has("recruitment")
      ? safe("recruitment", () => getRecruitmentDashboard(access, { hiredWindow }), failures).then(
          (value) => {
            loaded.recruitment = value;
          },
        )
      : null,
    needed.has("offers")
      ? safe("offers", () => listOffers(), failures).then((value) => {
          loaded.offers = value;
        })
      : null,
    needed.has("directory")
      ? safe("directory", () => getEmployeeDirectory(), failures).then((value) => {
          loaded.directory = value;
        })
      : null,
    needed.has("vacationsToday")
      ? safe("vacationsToday", () => listOnVacationToday(), failures).then((value) => {
          loaded.vacationsToday = value;
        })
      : null,
  ]);

  /**
   * The reads this page owns outright, named in the words a person reads.
   *
   * NOT routed through `safe()`, deliberately. That helper records a **`SourceKey`**, and a
   * SourceKey is a DECLARED source of the generic command centre — widening that union to carry
   * "the interview volume this one page counts" would push a bespoke page's private read into the
   * catalogue every HR seat's loader is built from. These are named here instead and still reach
   * the same notice at the foot of the page, which is the part that matters: a read that failed is
   * SAID, never drawn as a zero or as an empty week.
   */
  const pageUnavailable: string[] = [];

  // The calendar waits for the offers, because the joining days on it come from the accepted ones.
  const [volume, personal, { calendar, today }, cvToday] = await Promise.all([
    countInterviewVolume(KPI_WINDOW_DAYS, now).catch(() => {
      pageUnavailable.push("Interviews held");
      return null;
    }),
    personalPromise,
    loadCalendar(access, loaded.offers, {
      month: options.month ?? null,
      now,
      week: options.week ?? null,
    }),
    // The CVs received today, by the daily digest's own builder — the same count the 18:00 summary
    // sends, so the panel and that summary can never disagree. Asked only when her seat may read
    // candidates; a refusal or a failed read is NULL, and NULL is named below, never drawn as zero.
    canAccess(access, "candidates", "read")
      .then(async (allowed): Promise<TalentCvToday> =>
        allowed ? { digest: await buildTodaysCvDigest(now), status: "loaded" } : { status: "hidden" },
      )
      .catch((): TalentCvToday => {
        pageUnavailable.push("CVs received today");
        return { status: "failed" };
      }),
  ]);
  // The week is the real calendar component and reads itself, so what this page can still fail to
  // get is her ROLE on it (no role, no week at all) and her OWN agenda. Either one is named here,
  // because the unavailable-sources line is the page's one honest account of what it could not read.
  if (!calendar.interviewCalendar) pageUnavailable.push("Interview calendar");
  if (!calendar.mineLoaded) pageUnavailable.push("Your own interviews");
  if (!calendar.monthItemsLoaded) pageUnavailable.push("Company calendar");
  if (!today.loaded) pageUnavailable.push("Today's interviews");

  return {
    calendar,
    cvToday,
    field: {
      hiredWindow,
      tiles: fenced(seat, buildRecruitingTiles(loaded) ?? []),
    },
    hiringQuality: buildHiringQualityKpis({
      offers: loaded.offers,
      volume,
    }),
    joiners: joinersArriving(loaded.offers, calendar.todayKey),
    offerConversion: buildOfferConversionKpis(loaded.offers),
    onVacationToday: loaded.vacationsToday ?? null,
    personal,
    seat,
    tasks: fenced(
      seat,
      buildHrTodayTasks(loaded, seat).filter((task) => RECRUITING_TASK_KEYS.includes(task.key)),
    ).map((task) => ({
      ...task,
      // An item whose own page is fenced falls back to the task's href rather than vanishing — the
      // row is still work she must do, and the count above it already said so. Same rule as
      // buildHrCommandGroups.
      items: task.items.map((item) => ({
        ...item,
        href: hrefOutsideSeatFence(seat, item.href) ?? task.href,
      })),
    })),
    today,
    unavailableSources: [
      ...new Set([...failures.map((key) => SOURCE_LABELS[key]), ...pageUnavailable]),
    ].sort(),
  };
}

/** Exported for the test: the seat's functions, so a new one cannot arrive here unnoticed. */
export const TALENT_ACQUISITION_FUNCTIONS = HR_ROLE_BUNDLES[TALENT_ACQUISITION_SEAT];
