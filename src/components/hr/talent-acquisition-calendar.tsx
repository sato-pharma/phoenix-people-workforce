"use client";

/**
 * The Talent Acquisition seat's calendar panel — one panel, three views.
 *
 * WHY THREE AND NOT ONE. The owner asked for a "live calendar" on her page, was shown the three
 * things that could mean, and answered **"all above"** on 13 October 2026:
 *
 *   WEEK  — THE INTERVIEW CALENDAR ITSELF, mounted here, with everything it can do
 *   MINE  — her own next three weeks as an agenda, the interviews she is personally on
 *   MONTH — the company month: holidays, leave, events and birthdays, with her interviews over them
 *
 * They are tabs rather than three stacked blocks because they answer the same question at three
 * zooms, and stacking them would put the same interview on the screen three times.
 *
 * 🔴 THE WEEK TAB IS `InterviewCalendarView`, NOT A COPY OF IT — "FULL INTERVIW CALENDAR FEAATURES"
 * (owner, 13 October 2026, after three week layouts written for this page were rejected in one day:
 * a card per booking, a ruled list, then a time canvas — "2 OUT OF 10", then "BULLSHIT ,, AUDIT THE
 * INTERVIEW CALENDER"). So the week is now the real component the whole recruitment team books in:
 * its week navigation and week picker, Export PDF and Export Excel, Request an interview and the
 * request panels, every name opening that candidate's CV, the interview detail with its Zoom link,
 * panel, outcome and notes, the sessions, and its own phone cards. Nothing of it is re-implemented
 * here, and nothing of it is hidden: what her tier cannot do, the component does not offer and the
 * server refuses anyway. A SECOND WEEK GRID MUST NEVER BE WRITTEN IN THIS FILE AGAIN.
 *
 * THE JOINING DAYS ARE ON THE MONTH, where `buildMonthMarks` draws them from the accepted offers.
 * They were on the old week strip; the real calendar holds interviews only, so the month is the one
 * place they are marked and the only place they would ever have been complete — it draws all seven
 * days, and the week strip was Sunday to Thursday.
 *
 * NAVIGATION GOES THROUGH THE URL for the MONTH, not through state: its marks are built from the
 * company calendar and six weeks of bookings, and rebuilding that in the browser would be a second
 * implementation of `buildMonthMarks`. So the month arrows push `?taYear=&taMonth=`. The week needs
 * no such plumbing — the embedded calendar owns its own week and keeps it in the address itself.
 *
 * SQUARE EDGES (owner's golden rule). The month grid is written here from scratch rather than lifted
 * from `company-calendar.tsx`, which carries `rounded-xl` — copying that file would have imported a
 * forbidden corner. Nothing below has a `rounded-*` class except the legend and mark dots and the
 * panel's own icon medallion, which are the same three exceptions `hr-command-charts.tsx` carries.
 *
 * NEVER A HORIZONTAL SCROLL (owner's golden rule). No `min-width` and no `overflow-x-auto`
 * anywhere. The month is a `grid-cols-7` whose cells get narrower, never wider; at 375px each day
 * shows its marks as counted dots and from `sm` up it shows their names, wrapped. The week obeys it
 * the way the interview calendar does, because it IS the interview calendar: a `table-fixed` grid
 * on desktop and one card per day below `md`.
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
import { useMemo, useState } from "react";

import { InterviewCalendarView } from "@/components/recruitment/interview-calendar/interview-calendar-view";
import type { TalentCalendar, TalentMonthMark } from "@/lib/hr/talent-acquisition-logic";
import { formatShortDate, weekdayShort } from "@/lib/recruitment/interview-calendar-week";

type View = "week" | "mine" | "month";

const VIEWS: readonly { key: View; label: string }[] = [
  { key: "week", label: "Week" },
  { key: "mine", label: "Mine" },
  { key: "month", label: "Month" },
];

/** Sunday-first, because the company week is (`CALENDAR_WEEKDAYS` is 0..4 plus the weekend). */
const MONTH_COLUMN_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * The panel's controls, in THE PAGE'S OWN premium language rather than a flat local one.
 *
 * They are the same three devices `MetricTile` on her page is built from — a 180° white-to-#F7F9FC
 * wash, a 1px `slate-200/90` edge and a 1px shadow that lifts on hover — written once here because
 * the panel has six of them (two week arrows, two month arrows, "This week", three tabs) and six
 * hand-written copies is how a toolbar ends up with five slightly different buttons. Square, of
 * course: a gradient is depth, a rounded corner is a corner.
 */
const CONTROL_SKIN =
  "border border-slate-200/90 bg-[linear-gradient(180deg,#FFFFFF_0%,#F7F9FC_100%)]"
  + " shadow-[0_1px_2px_rgba(15,23,42,0.045)] transition-all duration-200 hover:border-orange-200"
  + " hover:text-orange-600 hover:shadow-[0_6px_14px_rgba(15,23,42,0.09)]"
  + " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500";
const ARROW_BUTTON = `inline-flex shrink-0 items-center p-2 text-slate-500 ${CONTROL_SKIN}`;
const TAB_BASE =
  "relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 text-[10px]"
  + " font-black uppercase tracking-[0.12em]";
/** The chosen view wears the band's orange edge along its top — the page's own way of saying "this
 *  one". A filled orange tab would be the ink rule's filled area, and louder than the week. */
const TAB_ON =
  "border border-orange-200 bg-[linear-gradient(180deg,#FFF7ED_0%,#FFF1E3_100%)] text-orange-700"
  + " shadow-[0_1px_2px_rgba(249,115,22,0.12)] focus-visible:outline-none focus-visible:ring-2"
  + " focus-visible:ring-orange-500";
const TAB_OFF = `text-slate-500 ${CONTROL_SKIN}`;

/**
 * How each kind of mark is drawn on the month grid: its colour, its icon and its name.
 *
 * ONE PLACE, because the grid draws a mark twice — as a dot at 375px and as a named row from `sm`
 * up — and a dot whose colour disagreed with the row underneath it would be worse than either.
 *
 * PHOENIX TONES ONLY (owner, 2026-10-16: "stick to phx identity", and the month grid was the one part
 * of her page still painting sky, fuchsia, indigo and green). The kinds are told apart by lightness
 * within the Phoenix palette — ink, ember, orange, amber, slate — and by the named legend and the
 * titled rows beside every dot, so no kind depends on its hue alone.
 */
const MARK_STYLES: Record<
  TalentMonthMark["kind"],
  { dot: string; icon: LucideIcon; label: string; text: string }
> = {
  birthday: { dot: "bg-orange-300", icon: CakeSlice, label: "Birthday", text: "text-orange-600" },
  event: { dot: "bg-slate-500", icon: CalendarDays, label: "Event", text: "text-slate-700" },
  holiday: { dot: "bg-slate-900", icon: PartyPopper, label: "Holiday", text: "text-slate-900" },
  interview: { dot: "bg-orange-500", icon: Users, label: "Interview", text: "text-orange-700" },
  joining: { dot: "bg-orange-800", icon: UserRoundCheck, label: "Joining", text: "text-orange-900" },
  leave: { dot: "bg-amber-400", icon: Plane, label: "On leave", text: "text-amber-700" },
  plan: { dot: "bg-slate-300", icon: Target, label: "Plan", text: "text-slate-600" },
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
  if (!date) return <div className="min-h-16 bg-slate-50/70 sm:min-h-24" />;

  const ordered = MARK_ORDER.flatMap((kind) => marks.filter((mark) => mark.kind === kind));

  return (
    // No border of its own: the grid's `gap-px` over a hairline ground draws every rule in the
    // month exactly once, which is what removes the doubled 2px lines the bordered cells left.
    <div
      className={`relative min-h-16 min-w-0 p-1 sm:min-h-24 sm:p-1.5 ${
        isToday ? "bg-orange-50/50" : inMonth ? "bg-white" : "bg-slate-50/70"
      }`}
    >
      {isToday ? (
        // The same 2px orange edge the week's today column wears, so the two views agree.
        <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-orange-500" />
      ) : null}
      <div className="flex items-baseline justify-between gap-1">
        <span
          className={`font-display text-[12px] font-black leading-none tabular-nums sm:text-[13px] ${
            isToday ? "text-orange-700" : inMonth ? "text-slate-900" : "text-slate-400"
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
                className={`h-1.5 w-1.5 ${MARK_STYLES[mark.kind].dot}`}
                key={`${mark.kind}-${index}`}
              />
            ))}
            {/* Six dots fit; a seventh mark is COUNTED, never silently dropped. */}
            {ordered.length > 6 ? (
              <span className="text-[8px] font-black leading-none tabular-nums text-slate-500">
                +{ordered.length - 6}
              </span>
            ) : null}
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
          <p className="text-[9px] font-black uppercase tracking-[0.1em] text-slate-500">
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

  function go(params: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [key, value] of Object.entries(params)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    // `scroll: false`: moving between months must not throw her back to the top of the page.
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
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

  // Today as the SERVER saw it — see the note on `TalentCalendar.todayKey`. Computing it in the
  // browser would make the first client render disagree with the server across a Cairo midnight,
  // and the embedded calendar is handed the same key for the same reason.
  const todayKey = calendar.todayKey;

  return (
    <section className="border-t border-slate-100" id="hr-group-calendar">
      <div className="flex flex-wrap items-start gap-3 border-b border-slate-200/70 bg-gradient-to-b from-white to-slate-50/60 px-5 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-orange-200 bg-gradient-to-br from-orange-50 to-orange-100 text-orange-600 shadow-[0_4px_10px_rgba(249,115,22,0.14)]">
          <CalendarDays aria-hidden="true" className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-950">
            The calendar
          </h2>
          <p className="mt-1 break-words text-[11px] font-semibold leading-relaxed text-slate-500">
            The Interview Calendar itself, in full — move between weeks, press a free time, open a
            candidate&rsquo;s CV, export the week, ask for an interview — then your own next three
            weeks, and the company month with its holidays, leave, events, birthdays and the days
            your new joiners arrive.
          </p>
        </div>

        {/* Square tab buttons, in the page's own button language. `aria-pressed` rather than a
            tablist, because each view is a filtered look at one panel, not three documents. */}
        <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
          {VIEWS.map((one) => (
            <button
              aria-pressed={view === one.key}
              className={`${TAB_BASE} ${view === one.key ? TAB_ON : TAB_OFF}`}
              key={one.key}
              onClick={() => setView(one.key)}
              type="button"
            >
              {view === one.key ? (
                <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-orange-500" />
              ) : null}
              {one.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── WEEK: THE INTERVIEW CALENDAR ITSELF ──────────────────────────────────────────────────
          Mounted, not copied — see the header. It brings its own week navigation, week picker,
          exports, request flow, CV previews, interview detail and phone cards, and it keeps its own
          week state, so this file hands it four server answers and gets out of the way. No wrapper
          frame around it either: its sections carry their own, and a panel inside a panel inside a
          panel is exactly the stacked chrome the owner rejected. */}
      {view === "week" ? (
        <div className="px-5 py-5">
          {calendar.interviewCalendar ? (
            <InterviewCalendarView
              abilities={calendar.interviewCalendar.abilities}
              canReadRequests={calendar.interviewCalendar.canReadRequests}
              canRequest={calendar.interviewCalendar.canRequest}
              initialOpen={null}
              initialWeek={calendar.weekStart}
              refreshToken={calendar.refreshedAt}
              role={calendar.interviewCalendar.role}
              todayKey={todayKey}
              zoomConnected={calendar.interviewCalendar.zoomConnected}
            />
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
          {!calendar.mineLoaded ? (
            <CouldNotLoad what="Your own interviews" />
          ) : calendar.mine.length === 0 ? (
            <p className="px-5 py-10 text-center text-[12px] font-semibold text-slate-400">
              You are not on an interview in the next three weeks. An interview reaches this list
              when you are its interviewer, on its panel, or the person who asked for it.
            </p>
          ) : (
            // HER OWN DIARY IS A RULED LEDGER, not a stack of cards — the same pass the week got.
            // The date sits in a fixed gutter so the whole column of dates lines up and a day that
            // carries two interviews reads as two rules under one date rather than two identical
            // boxes; the day is said once and the second row leaves the gutter empty.
            <div className="p-5">
              <ul className="border border-slate-200 bg-white">
                {calendar.mine.map((interview, index) => {
                  const sameDayAsAbove =
                    index > 0 && calendar.mine[index - 1]?.dateKey === interview.dateKey;

                  return (
                    <li className="min-w-0" key={interview.id}>
                      <Link
                        className={`group/mine flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 transition-colors hover:bg-orange-50/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-orange-500 ${
                          index === 0
                            ? ""
                            : sameDayAsAbove
                              ? "border-t border-slate-100"
                              : "border-t border-slate-200/80"
                        }`}
                        href={interview.href}
                      >
                        <span
                          aria-hidden={sameDayAsAbove ? "true" : undefined}
                          className="w-[72px] shrink-0 whitespace-nowrap text-[9px] font-black uppercase tracking-[0.14em] text-slate-500 tabular-nums"
                        >
                          {sameDayAsAbove
                            ? ""
                            : `${weekdayShort(interview.dateKey)} ${formatShortDate(interview.dateKey)}`}
                        </span>
                        <span className="whitespace-nowrap text-[9.5px] font-black uppercase tracking-[0.1em] text-orange-700 tabular-nums">
                          {interview.timeLabel}
                        </span>
                        {/* `grow basis-40`, not `flex-1`: a zero basis never drops to its own line, so
                            at 375px a name was squeezed into ~38px beside the time. 10rem is the
                            least it will take before the row wraps and gives it the whole line. */}
                        <span className="min-w-0 grow basis-40 break-words text-[12px] font-black text-slate-900" dir="auto">
                          {interview.candidateName}
                        </span>
                        <span className="break-words text-[9px] font-black uppercase tracking-[0.16em] text-slate-500">
                          {interview.platformLabel}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      ) : null}

      {/* ── MONTH ─────────────────────────────────────────────────────────────────────────────── */}
      {view === "month" ? (
        <div>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200/70 bg-slate-50/60 px-5 py-3">
            <button
              aria-label="The month before"
              className={ARROW_BUTTON}
              onClick={() =>
                go({ taMonth: String(previousMonth.month), taYear: String(previousMonth.year) })
              }
              type="button"
            >
              <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
            <span className="font-display break-words text-[13px] font-black leading-none tracking-[0.01em] text-slate-950 tabular-nums">
              {calendar.month.label}
            </span>
            <button
              aria-label="The month after"
              className={ARROW_BUTTON}
              onClick={() => go({ taMonth: String(nextMonth.month), taYear: String(nextMonth.year) })}
              type="button"
            >
              <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
            </button>

            {legendKinds.length > 0 ? (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:ml-auto">
                {legendKinds.map((kind) => {
                  const style = MARK_STYLES[kind];
                  return (
                    <span className="inline-flex items-center gap-1.5" key={kind}>
                      <span
                        aria-hidden="true"
                        className={`h-2 w-2 shrink-0 ${style.dot}`}
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
            <div className="grid grid-cols-7 gap-px border border-slate-200 bg-slate-200/80 shadow-[0_1px_2px_rgba(15,23,42,0.045)]">
              {MONTH_COLUMN_LABELS.map((label) => (
                <div
                  className="min-w-0 bg-white px-1 py-1.5 text-center text-[8.5px] font-black uppercase tracking-[0.18em] text-slate-500"
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
