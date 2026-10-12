"use client";

/**
 * The Talent Acquisition seat's calendar panel — one panel, three views.
 *
 * WHY THREE AND NOT ONE. The owner asked for a "live calendar" on her page, was shown the three
 * things that could mean, and answered **"all above"** on 13 October 2026:
 *
 *   WEEK  — the interview week she works in, Sunday to Thursday, with the joining days on it
 *   MINE  — her own next three weeks as an agenda, the interviews she is personally on
 *   MONTH — the company month: holidays, leave, events and birthdays, with her interviews over them
 *
 * They are tabs rather than three stacked blocks because they answer the same question at three
 * zooms, and stacking them would put the same interview on the screen three times. Every view
 * arrives SERVER-RENDERED in the page's one pass, so switching tab draws immediately and costs no
 * request — and `interviewsLoaded` / `monthItemsLoaded` let each view say when its read failed
 * rather than drawing an empty week, which on a diary reads as "you have nothing on".
 *
 * THE WEEK IS LIVE, AND ONLY THE WEEK. It re-reads
 * `/api/recruitment/interview-calendar/bookings?week=` every 60 seconds while the Week tab is the
 * one on screen and the browser tab is actually visible, so an interview booked by somebody else
 * appears without a reload. The other two views do not poll: the month is a six-week read and her
 * own agenda changes when she books, which she did herself. A hidden tab polls nothing.
 *
 * THE REFRESH USES THE SERVER'S OWN LAYOUT FUNCTIONS. `toTalentInterview` and `buildWeekDays` are
 * imported from `@/lib/hr/talent-acquisition-logic` — the same two the server called for the first
 * paint. A second copy of that layout here is precisely how a live refresh starts disagreeing with
 * the page it refreshes.
 *
 * NAVIGATION GOES THROUGH THE URL, not through state. A different week or month needs the SERVER:
 * the month's marks are built from the company calendar and six weeks of bookings, and rebuilding
 * that in the browser would be a second implementation of `buildMonthMarks`. So the arrows push
 * `?taWeek=` / `?taYear=&taMonth=`, which also makes a week she is looking at shareable and
 * survivable across a reload.
 *
 * SQUARE EDGES (owner's golden rule). The month grid is written here from scratch rather than lifted
 * from `company-calendar.tsx`, which carries `rounded-xl` — copying that file would have imported a
 * forbidden corner. Nothing below has a `rounded-*` class except the 2px legend dots, which is the
 * same exception `hr-command-charts.tsx` carries.
 *
 * NEVER A HORIZONTAL SCROLL (owner's golden rule). No `min-width` and no `overflow-x-auto`
 * anywhere. The month is a `grid-cols-7` whose cells get narrower, never wider; at 375px each day
 * shows its marks as counted dots and from `sm` up it shows their names, wrapped. The week strip is
 * one column on a phone and five from `lg` up — a five-column week at 375px would be 75px a day,
 * which cannot hold a name without truncating it, and truncation is forbidden.
 */

import {
  CakeSlice,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  PartyPopper,
  Plane,
  Target,
  TriangleAlert,
  UserRoundCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { InterviewBooking } from "@/lib/recruitment/interview-calendar-types";
import {
  buildWeekDays,
  toTalentInterview,
  type TalentCalendar,
  type TalentCalendarDay,
  type TalentInterview,
  type TalentMonthMark,
} from "@/lib/hr/talent-acquisition-logic";
import {
  addDays,
  formatShortDate,
  formatWeekRange,
  weekdayShort,
} from "@/lib/recruitment/interview-calendar-week";

type View = "week" | "mine" | "month";

const VIEWS: readonly { key: View; label: string }[] = [
  { key: "week", label: "Week" },
  { key: "mine", label: "Mine" },
  { key: "month", label: "Month" },
];

/** How often the Week view re-reads its own week. See the header — it polls only while visible. */
const REFRESH_MS = 60_000;

/** Sunday-first, because the company week is (`CALENDAR_WEEKDAYS` is 0..4 plus the weekend). */
const MONTH_COLUMN_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * How each kind of mark is drawn on the month grid: its colour, its icon and its name.
 *
 * ONE PLACE, because the grid draws a mark twice — as a dot at 375px and as a named row from `sm`
 * up — and a dot whose colour disagreed with the row underneath it would be worse than either.
 */
const MARK_STYLES: Record<
  TalentMonthMark["kind"],
  { dot: string; icon: LucideIcon; label: string; text: string }
> = {
  birthday: { dot: "bg-fuchsia-400", icon: CakeSlice, label: "Birthday", text: "text-fuchsia-700" },
  event: { dot: "bg-sky-400", icon: CalendarDays, label: "Event", text: "text-sky-700" },
  holiday: { dot: "bg-emerald-500", icon: PartyPopper, label: "Holiday", text: "text-emerald-700" },
  interview: { dot: "bg-orange-500", icon: Users, label: "Interview", text: "text-orange-700" },
  joining: { dot: "bg-indigo-500", icon: UserRoundCheck, label: "Joining", text: "text-indigo-700" },
  leave: { dot: "bg-amber-400", icon: Plane, label: "On leave", text: "text-amber-700" },
  plan: { dot: "bg-slate-400", icon: Target, label: "Plan", text: "text-slate-600" },
};

/** The order the legend and each day's marks read in — the company's facts before her own. */
const MARK_ORDER: readonly TalentMonthMark["kind"][] = [
  "holiday",
  "leave",
  "event",
  "birthday",
  "plan",
  "interview",
  "joining",
];

/**
 * A read that refused, said rather than drawn.
 *
 * The one thing this panel must never do is render a failed read as a quiet day — see the header.
 */
function CouldNotLoad({ what }: { what: string }) {
  return (
    <div className="m-4 flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3">
      <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <p className="text-[11px] font-semibold leading-relaxed text-amber-900">
        {what} could not be read just now, so this view is showing nothing rather than showing an
        empty week. Reload the page to try again.
      </p>
    </div>
  );
}

function InterviewRow({ interview }: { interview: TalentInterview }) {
  return (
    <Link
      className="group/row block border border-slate-200 bg-white px-2.5 py-2 transition-colors hover:border-orange-200 hover:bg-orange-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
      href={interview.href}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="whitespace-nowrap text-[10px] font-black uppercase tracking-[0.1em] text-orange-700 tabular-nums">
          {interview.timeLabel}
        </span>
        <span className="whitespace-nowrap border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.1em] text-slate-500">
          {interview.platformLabel}
        </span>
      </div>
      <p className="mt-1 break-words text-[12px] font-black leading-snug text-slate-900">
        {interview.candidateName}
      </p>
      {/* The interviewer is a NAME or the honest absence of one — never a code, and never blank,
          which would read as "nobody has to be there". */}
      <p className="mt-0.5 break-words text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
        {interview.interviewerName ?? "No interviewer chosen yet"}
      </p>
    </Link>
  );
}

function DayColumn({ day }: { day: TalentCalendarDay }) {
  return (
    <div
      className={`min-w-0 border p-2.5 ${
        day.isToday ? "border-orange-300 bg-orange-50/40" : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 border-b border-slate-200/70 pb-2">
        <span className="break-words text-[10px] font-black uppercase tracking-[0.12em] text-slate-950">
          {day.shortLabel} {day.dateKey.slice(8)}
        </span>
        {day.isToday ? (
          <span className="whitespace-nowrap border border-orange-300 bg-white px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.1em] text-orange-700">
            Today
          </span>
        ) : null}
      </div>

      <div className="mt-2 space-y-1.5">
        {/* The joining days first: somebody starting is the fact that governs the day. */}
        {day.joiners.map((joiner) => (
          <Link
            className="block border border-indigo-200 bg-indigo-50/70 px-2.5 py-2 transition-colors hover:bg-indigo-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            href={joiner.href}
            key={joiner.id}
          >
            <span className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.12em] text-indigo-700">
              <UserRoundCheck aria-hidden="true" className="h-3 w-3 shrink-0" />
              Joins today
            </span>
            <p className="mt-1 break-words text-[12px] font-black leading-snug text-indigo-900">
              {joiner.name}
            </p>
            <p className="mt-0.5 break-words text-[10px] font-bold uppercase tracking-[0.1em] text-indigo-400">
              {joiner.title}
            </p>
          </Link>
        ))}
        {day.interviews.map((interview) => (
          <InterviewRow interview={interview} key={interview.id} />
        ))}
        {day.interviews.length === 0 && day.joiners.length === 0 ? (
          <p className="py-3 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-slate-300">
            Nothing booked
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** One month cell. Named marks from `sm` up, counted dots below it — see the header. */
function MonthCell({
  date,
  inMonth,
  isToday,
  marks,
}: {
  date: string | null;
  inMonth: boolean;
  isToday: boolean;
  marks: TalentMonthMark[];
}) {
  if (!date) return <div className="min-h-16 border border-slate-100 bg-slate-50/40" />;

  const ordered = MARK_ORDER.flatMap((kind) => marks.filter((mark) => mark.kind === kind));

  return (
    <div
      className={`min-h-16 min-w-0 border p-1 sm:min-h-24 sm:p-1.5 ${
        isToday
          ? "border-orange-300 bg-orange-50/50"
          : inMonth
            ? "border-slate-200 bg-white"
            : "border-slate-100 bg-slate-50/50"
      }`}
    >
      <div className="flex items-baseline justify-between gap-1">
        <span
          className={`text-[10px] font-black tabular-nums ${
            isToday ? "text-orange-700" : inMonth ? "text-slate-900" : "text-slate-300"
          }`}
        >
          {date.slice(8)}
        </span>
        {/* The dots are the WHOLE answer at 375px, where a name cannot fit without being cut — and
            cutting text is forbidden. They stay on from `sm` up as the day's shape at a glance. */}
        {ordered.length > 0 ? (
          <span className="flex flex-wrap items-center justify-end gap-0.5">
            {ordered.slice(0, 6).map((mark, index) => (
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${MARK_STYLES[mark.kind].dot}`}
                key={`${mark.kind}-${index}`}
              />
            ))}
          </span>
        ) : null}
      </div>

      <div className="mt-1 hidden space-y-0.5 sm:block">
        {ordered.slice(0, 3).map((mark, index) => (
          <p
            className={`break-words text-[9px] font-bold leading-tight ${MARK_STYLES[mark.kind].text}`}
            key={`${mark.kind}-${index}-${mark.title}`}
          >
            {mark.title}
          </p>
        ))}
        {/* A count, never an ellipsis. "+2 more" says there are two; "…" says nothing at all. */}
        {ordered.length > 3 ? (
          <p className="text-[9px] font-black uppercase tracking-[0.1em] text-slate-400">
            +{ordered.length - 3} more
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function TalentAcquisitionCalendar({ calendar }: { calendar: TalentCalendar }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [view, setView] = useState<View>("week");

  /**
   * The last live refresh, CARRYING THE WEEK IT BELONGS TO — one piece of state, and no effect.
   *
   * The server is the source of truth for the first paint of every week. Because this state knows
   * which week it is for, a `weekStart` that no longer matches is simply ignored and `calendar.days`
   * wins on its own; nothing has to be reset when the week changes.
   *
   * It was a `useEffect` keyed on `weekStart` that called two setters, and that is a cascading
   * render React's own `react-hooks/set-state-in-effect` rule refuses — it failed `checks` on
   * 2026-10-13. It also had to silence `exhaustive-deps`, because `calendar.days` is a fresh array
   * identity on every render of the parent and depending on it would have thrown away a
   * just-refreshed week. Deriving it in render removes both problems rather than muting them.
   */
  const [liveWeek, setLiveWeek] = useState<{
    at: Date;
    days: TalentCalendarDay[];
    weekStart: string;
  } | null>(null);
  const live = liveWeek && liveWeek.weekStart === calendar.weekStart ? liveWeek : null;
  const weekDaysState = live?.days ?? calendar.days;
  /** When the week last came back from the API. Null until the first refresh of THIS week lands. */
  const refreshedAt = live?.at ?? null;

  const serverDays = calendar.days;

  /** The joining days never move between refreshes — an offer's start date is not a live figure. */
  const joiners = useMemo(() => serverDays.flatMap((day) => day.joiners), [serverDays]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/recruitment/interview-calendar/bookings?week=${encodeURIComponent(calendar.weekStart)}`,
        { cache: "no-store", headers: { accept: "application/json" } },
      );
      if (!response.ok) return;
      const payload: unknown = await response.json();
      const bookings = (payload as { bookings?: InterviewBooking[] } | null)?.bookings;
      if (!Array.isArray(bookings)) return;
      // The server's own two functions, not a second layout. See the header.
      setLiveWeek({
        at: new Date(),
        days: buildWeekDays(
          calendar.weekStart,
          bookings.map(toTalentInterview),
          joiners,
          new Date(),
        ),
        weekStart: calendar.weekStart,
      });
    } catch {
      // A refresh that fails leaves the week exactly as the server drew it. Silent on purpose:
      // this is a background top-up of a view that is already correct, not a read somebody asked
      // for, and a banner for it would cry wolf on every passing network blip.
    }
  }, [calendar.weekStart, joiners]);

  // Only while the Week tab is the one on screen, and only while the browser tab is visible — a
  // backgrounded landing page should not read the calendar once a minute all day.
  useEffect(() => {
    if (view !== "week" || !calendar.interviewsLoaded) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [calendar.interviewsLoaded, refresh, view]);

  function go(params: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [key, value] of Object.entries(params)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  const { month, year } = calendar.month;
  const previousMonth = month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
  const nextMonth = month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };

  /** Only the kinds actually on this month's grid — a legend for an absent kind teaches nothing. */
  const legendKinds = useMemo(() => {
    const present = new Set<TalentMonthMark["kind"]>();
    for (const marks of Object.values(calendar.month.marksByDay)) {
      for (const mark of marks) present.add(mark.kind);
    }
    return MARK_ORDER.filter((kind) => present.has(kind));
  }, [calendar.month.marksByDay]);

  // Today as the SERVER saw it — see the note on `TalentCalendar.todayKey`. Deriving it from the
  // week strip would lose today as soon as she paged to another week, which is also the one week
  // where the month grid's "today" matters most.
  const todayKey = calendar.todayKey;
  const showingThisWeek = weekDaysState.some((day) => day.dateKey === todayKey);

  return (
    <section className="border-t border-slate-100" id="hr-group-calendar">
      <div className="flex flex-wrap items-start gap-3 border-b border-slate-200/70 bg-gradient-to-b from-white to-slate-50/60 px-5 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-orange-200 bg-gradient-to-br from-orange-50 to-orange-100 text-orange-600 shadow-[0_4px_10px_rgba(249,115,22,0.14)]">
          <CalendarDays aria-hidden="true" className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-950">
            The calendar
          </h2>
          <p className="mt-1 break-words text-[11px] font-semibold leading-relaxed text-slate-500">
            Your interview week, your own next three weeks, and the company month — holidays, leave,
            events and birthdays, with every interview and joining day laid over them. The week
            re-reads itself every minute while you are looking at it.
          </p>
        </div>

        {/* Square tab buttons, in the page's own button language. `aria-pressed` rather than a
            tablist, because each view is a filtered look at one panel, not three documents. */}
        <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
          {VIEWS.map((one) => (
            <button
              aria-pressed={view === one.key}
              className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                view === one.key
                  ? "border-orange-300 bg-orange-50 text-orange-700"
                  : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
              }`}
              key={one.key}
              onClick={() => setView(one.key)}
              type="button"
            >
              {one.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── WEEK ──────────────────────────────────────────────────────────────────────────────── */}
      {view === "week" ? (
        <div>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200/70 bg-slate-50/60 px-5 py-3">
            <button
              aria-label="The week before"
              className="inline-flex shrink-0 items-center border border-slate-200 bg-white p-2 text-slate-500 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              onClick={() => go({ taWeek: addDays(calendar.weekStart, -7) })}
              type="button"
            >
              <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
            <span className="break-words text-[10px] font-black uppercase tracking-[0.12em] text-slate-950">
              {formatWeekRange(calendar.weekStart)}
            </span>
            <button
              aria-label="The week after"
              className="inline-flex shrink-0 items-center border border-slate-200 bg-white p-2 text-slate-500 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              onClick={() => go({ taWeek: addDays(calendar.weekStart, 7) })}
              type="button"
            >
              <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
            {showingThisWeek ? null : (
              <button
                className="inline-flex shrink-0 items-center border border-slate-200 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                onClick={() => go({ taWeek: null })}
                type="button"
              >
                This week
              </button>
            )}
            {refreshedAt ? (
              <span className="whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">
                Updated{" "}
                {new Intl.DateTimeFormat("en-GB", {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: "Africa/Cairo",
                }).format(refreshedAt)}
              </span>
            ) : null}
          </div>

          {calendar.interviewsLoaded ? (
            <>
              {/* Her seat sees the whole calendar, so this does not render for her — it exists
                  because the tier is resolved at runtime, and a narrowed week that LOOKS quiet is
                  the one wrong answer a diary can give. */}
              {calendar.ownOnly ? (
                <p className="border-b border-slate-200/70 bg-slate-50/60 px-5 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">
                  Showing only the interviews you are on
                </p>
              ) : null}
              <div className="grid grid-cols-1 gap-2 p-5 sm:grid-cols-2 lg:grid-cols-5">
                {weekDaysState.map((day) => (
                  <DayColumn day={day} key={day.dateKey} />
                ))}
              </div>
            </>
          ) : (
            <CouldNotLoad what="The interview calendar" />
          )}
        </div>
      ) : null}

      {/* ── MINE ──────────────────────────────────────────────────────────────────────────────── */}
      {view === "mine" ? (
        <div>
          <p className="border-b border-slate-200/70 bg-slate-50/60 px-5 py-3 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
            The next three weeks, interviews you are on
          </p>
          {!calendar.interviewsLoaded ? (
            <CouldNotLoad what="Your own interviews" />
          ) : calendar.mine.length === 0 ? (
            <p className="px-5 py-10 text-center text-[12px] font-semibold text-slate-400">
              You are not on an interview in the next three weeks. An interview reaches this list
              when you are its interviewer, on its panel, or the person who asked for it.
            </p>
          ) : (
            <ul className="space-y-2 p-5">
              {calendar.mine.map((interview) => (
                <li className="min-w-0" key={interview.id}>
                  <Link
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border border-slate-200 bg-white px-3 py-2.5 transition-colors hover:border-orange-200 hover:bg-orange-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                    href={interview.href}
                  >
                    <span className="whitespace-nowrap border border-slate-200 bg-slate-50 px-2 py-1 text-[9px] font-black uppercase tracking-[0.1em] text-slate-600 tabular-nums">
                      {weekdayShort(interview.dateKey)} {formatShortDate(interview.dateKey)}
                    </span>
                    <span className="whitespace-nowrap text-[10px] font-black uppercase tracking-[0.1em] text-orange-700 tabular-nums">
                      {interview.timeLabel}
                    </span>
                    <span className="min-w-0 break-words text-[12px] font-black text-slate-900">
                      {interview.candidateName}
                    </span>
                    <span className="break-words text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
                      {interview.platformLabel}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {/* ── MONTH ─────────────────────────────────────────────────────────────────────────────── */}
      {view === "month" ? (
        <div>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200/70 bg-slate-50/60 px-5 py-3">
            <button
              aria-label="The month before"
              className="inline-flex shrink-0 items-center border border-slate-200 bg-white p-2 text-slate-500 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              onClick={() =>
                go({ taMonth: String(previousMonth.month), taYear: String(previousMonth.year) })
              }
              type="button"
            >
              <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
            <span className="break-words text-[10px] font-black uppercase tracking-[0.12em] text-slate-950">
              {calendar.month.label}
            </span>
            <button
              aria-label="The month after"
              className="inline-flex shrink-0 items-center border border-slate-200 bg-white p-2 text-slate-500 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              onClick={() => go({ taMonth: String(nextMonth.month), taYear: String(nextMonth.year) })}
              type="button"
            >
              <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
            </button>

            {legendKinds.length > 0 ? (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {legendKinds.map((kind) => {
                  const style = MARK_STYLES[kind];
                  return (
                    <span className="inline-flex items-center gap-1.5" key={kind}>
                      <span
                        aria-hidden="true"
                        className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`}
                      />
                      <span className="whitespace-nowrap text-[9px] font-black uppercase tracking-[0.12em] text-slate-500">
                        {style.label}
                      </span>
                    </span>
                  );
                })}
              </span>
            ) : null}
          </div>

          {/* The company half of the grid is what can fail; the grid, her interviews and the
              joining days on it are standing either way, so this is a notice above a real month
              rather than a replacement for it. */}
          {calendar.monthItemsLoaded ? null : (
            <CouldNotLoad what="The company calendar (holidays, leave, events and birthdays)" />
          )}

          <div className="p-5">
            <div className="grid grid-cols-7 gap-px">
              {MONTH_COLUMN_LABELS.map((label) => (
                <div
                  className="min-w-0 border-b border-slate-200 bg-slate-50/60 px-1 py-1.5 text-center text-[9px] font-black uppercase tracking-[0.1em] text-slate-500"
                  key={label}
                >
                  {label}
                </div>
              ))}
              {calendar.month.weeks.flat().map((day, index) => (
                <MonthCell
                  date={day.date}
                  inMonth={day.inMonth}
                  isToday={Boolean(day.date) && day.date === todayKey}
                  key={day.date ?? `blank-${index}`}
                  marks={day.date ? (calendar.month.marksByDay[day.date] ?? []) : []}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
