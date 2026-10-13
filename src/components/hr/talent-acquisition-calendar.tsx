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
 * forbidden corner. Nothing below has a `rounded-*` class except the legend and mark dots and the
 * panel's own icon medallion, which are the same three exceptions `hr-command-charts.tsx` carries.
 *
 * AND THE WEEK IS THE INTERVIEW CALENDAR'S OWN GRID — the half-hour slot table the whole
 * recruitment team books in, not a second calendar invented for this page. The owner's 2026-10-13
 * "i want her calender to show like real calender" and his "AUDIT THE INTERVIEW CALENDER" the same
 * day both landed in `WeekSlotTable`, where what they replaced is written down in full.
 *
 * NEVER A HORIZONTAL SCROLL (owner's golden rule). No `min-width` and no `overflow-x-auto`
 * anywhere. The month is a `grid-cols-7` whose cells get narrower, never wider; at 375px each day
 * shows its marks as counted dots and from `sm` up it shows their names, wrapped. The week is a
 * `table-fixed` with a `colgroup`, so its columns divide the width they are given; below `md` it is
 * one card per day, which is the sibling's own answer and the owner's desktop-tables/mobile-cards
 * rule — five time columns at 375px would be 66px a day, which cannot hold a name without cutting it.
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
  adminPanelDepthClassName,
  adminPanelHeaderClassName,
} from "@/components/admin/admin-design-tokens";
import {
  bookingsInSlot,
  buildWeekDays,
  outsideWorkdayInterviews,
  toTalentInterview,
  type TalentCalendar,
  type TalentCalendarDay,
  type TalentInterview,
  type TalentJoiner,
  type TalentMonthMark,
} from "@/lib/hr/talent-acquisition-logic";
import {
  addDays,
  formatShortDate,
  formatTimeOfDay,
  formatWeekRange,
  SLOT_MINUTES,
  slotStarts,
  weekdayName,
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

/**
 * 🔴 HER WEEK IS THE INTERVIEW CALENDAR'S OWN GRID — the owner, 13 October 2026, after looking at
 * both: "AUDIT THE INTERVIEW CALENDER".
 *
 * WHAT THIS REPLACED, AND WHY IT HAD TO GO. Between those two instructions this panel drew a week
 * of its own invention: a time canvas at 84px an hour, every booking absolutely positioned by its
 * start minute and sized by its duration, overlaps laned side by side, a 48px rail of 9px hours.
 * It was a competent calendar and it was the wrong one. `interview-calendar-view.tsx` already holds
 * THE week grid of this product — the one the whole recruitment team books in every day — and the
 * owner's standing rule is that new UI wears its sibling's exact design identity and never invents
 * a one-off look. Two calendars in one product is how two calendars start disagreeing.
 *
 * SO EVERY DEVICE BELOW IS THAT FILE'S, NOT A LOCAL ONE:
 *
 *   A `w-full table-fixed` TABLE with a `colgroup` — a `w-[5.75rem]` time column and one column per
 *   day. The fits-the-screen golden rule is then structural rather than something to measure: the
 *   columns divide the width they are given and there is no `min-width` to overflow.
 *   HALF-HOUR ROWS, 9:00 to 17:00 (`slotStarts()`), each `h-[46px]`, odd rows on `bg-slate-50/70`.
 *   Every row is a SLOT she can book into, which is what makes an empty sheet read as a booking
 *   sheet rather than as the empty paint the owner rejected on the canvas version.
 *   THE SHARED DARK HEAD BAND (`adminPanelHeaderClassName`), today's column in `bg-orange-600` —
 *   the same band the Approvals Hub and the Coverage Report wear.
 *   THE BOOKING CHIP — a 3px `orange-600` left edge on `bg-orange-100`, the name at 12px bold, the
 *   interviewer under it, the time and platform under that. Byte for byte the sibling's chip.
 *   A CONTINUATION BAR for an interview still running through a later slot, so an hour-long booking
 *   is one interview over two rows and not two interviews.
 *
 * WHAT IS NOT THE SIBLING'S, AND WHY EACH ONE EARNED ITS PLACE:
 *
 *   THE ALL-DAY ROW. Joining days have no time — a start date is a day, not an appointment — and
 *   the interview calendar has no such thing to copy. It is drawn only when the week holds one.
 *   THE NOW LINE, inside today's current cell at the right fraction of it. The sibling has no clock
 *   at all; this is her landing page, where "where am I in the day" is the question it answers.
 *   THE OUTSIDE-THE-WORKING-DAY ROW (`outsideWorkdayInterviews`). A fixed 9-to-5 grid has no row
 *   for an 8:30 screening, and a booking a diary does not draw is worse than no diary.
 *
 * A PHONE GETS CARDS, which is both the sibling's answer (`md:hidden`) and the owner's standing
 * rule — desktop shows full tables, mobile gets cards. Five time columns at 375px would be 66px a
 * day, which cannot hold a candidate's name without cutting it, and cutting text is forbidden.
 */

/**
 * What minute of the day it is IN CAIRO, whatever the reader's own clock says.
 *
 * The whole calendar is a Cairo calendar — the bookings, the week, `todayKey` the server sent — so a
 * now line taken from `Date.getHours()` would stand in the wrong place for anybody whose laptop is
 * on another timezone, and in the wrong place for everybody during a Cairo DST change.
 */
function cairoMinutesOfDay(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: "Africa/Cairo",
  }).formatToParts(at);
  const read = (type: "hour" | "minute") =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  // `en-GB` with `hour12: false` answers "24" at midnight, not "00".
  return (read("hour") % 24) * 60 + read("minute");
}

/** How tall one half-hour row is, in CSS pixels — the sibling's `h-[46px]`, named for the now line. */
const SLOT_PX = 46;

/**
 * One interview in a slot cell — the interview calendar's own `BookingChip`.
 *
 * It is a `Link` rather than that file's `button` for the one reason that file cannot be copied
 * outright: there is no dialog on this page to open. The href is the calendar itself, opened on
 * this booking, so a click lands exactly where the chip looks like it leads.
 */
function SlotBooking({ interview }: { interview: TalentInterview }) {
  return (
    <Link
      className="block w-full border-l-[3px] border-l-orange-600 bg-orange-100 px-1.5 py-1 text-left transition-colors hover:bg-orange-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-orange-700"
      href={interview.href}
      title={`Open ${interview.candidateName}'s interview`}
    >
      <span className="block break-words text-[12px] font-bold leading-tight text-slate-900">
        {interview.candidateName}
      </span>
      {/* A NAME or the honest absence of one — never blank, which reads as "nobody has to be there". */}
      <span className="mt-0.5 block break-words text-[10.5px] font-semibold leading-tight text-slate-700">
        {interview.interviewerName ?? "No interviewer named"}
      </span>
      <span className="mt-0.5 block break-words text-[10.5px] leading-tight text-slate-600">
        {interview.timeLabel} · {interview.platformLabel}
      </span>
    </Link>
  );
}

/** One day's cell in one slot row: what starts here, what is still running, and today's now line. */
function SlotCell({
  day,
  isToday,
  nowMinutes,
  slotStartMinutes,
}: {
  day: TalentCalendarDay;
  isToday: boolean;
  /** The Cairo minute, or null off this week / before the first client tick. */
  nowMinutes: number | null;
  slotStartMinutes: number;
}) {
  const { running, starting } = bookingsInSlot(day.interviews, slotStartMinutes);
  const nowHere =
    nowMinutes !== null
    && isToday
    && nowMinutes >= slotStartMinutes
    && nowMinutes < slotStartMinutes + SLOT_MINUTES;

  return (
    <td
      className={`relative h-[46px] border-r border-slate-200 p-1 align-top last:border-r-0 ${
        isToday ? "bg-orange-50/40" : ""
      }`}
    >
      {/* THE CONTINUATION, first: an interview that began in an earlier slot and has not ended. A
          2px bar rather than a second chip — the booking is one booking, and the bar is what says
          the hour is still occupied. */}
      {running.map((interview) => (
        <Link
          className="mb-1 block h-2 w-full bg-orange-300 transition-colors hover:bg-orange-500"
          href={interview.href}
          key={interview.id}
          title={`${interview.candidateName} — ${interview.timeLabel}`}
        >
          <span className="sr-only">
            {interview.candidateName}, still running at {formatTimeOfDay(slotStartMinutes)}
          </span>
        </Link>
      ))}
      <div className="flex flex-col gap-1">
        {starting.map((interview) => (
          <SlotBooking interview={interview} key={interview.id} />
        ))}
      </div>
      {/* NOW, at its real fraction of the half hour rather than at the top of it — a line that can
          only stand on a slot boundary is a line that is wrong for 29 of every 30 minutes. It is
          client state, so the server's HTML never carries it and nothing can mismatch. */}
      {nowHere && nowMinutes !== null ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 z-20 h-px bg-orange-600"
          style={{ top: ((nowMinutes - slotStartMinutes) / SLOT_MINUTES) * SLOT_PX }}
        >
          <span className="absolute -left-px -top-[3px] h-[7px] w-[7px] bg-orange-600" />
        </span>
      ) : null}
    </td>
  );
}

/**
 * The week, on the interview calendar's grid. Desktop only — a phone gets `WeekDayCards`.
 */
function WeekSlotTable({
  days,
  nowMinutes,
  todayKey,
}: {
  days: readonly TalentCalendarDay[];
  nowMinutes: number | null;
  todayKey: string;
}) {
  const slots = slotStarts();
  const anyJoiner = days.some((day) => day.joiners.length > 0);
  const outside = days.map((day) => ({
    day,
    interviews: outsideWorkdayInterviews(day.interviews),
  }));
  const anyOutside = outside.some((one) => one.interviews.length > 0);

  return (
    <div
      className={`hidden border border-slate-200 bg-white md:block ${adminPanelDepthClassName}`}
    >
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-[5.75rem]" />
          {days.map((day) => (
            <col key={day.dateKey} />
          ))}
        </colgroup>
        <thead>
          <tr className={`${adminPanelHeaderClassName} text-white`}>
            <th
              className="border-r border-slate-700 px-2 py-2 text-left text-[11px] font-bold uppercase tracking-wide"
              scope="col"
            >
              Time
            </th>
            {days.map((day) => (
              <th
                className={`border-r border-slate-700 px-2 py-2 text-left last:border-r-0 ${
                  day.dateKey === todayKey ? "bg-orange-600" : ""
                }`}
                key={day.dateKey}
                scope="col"
              >
                <span className="block text-[13px] font-bold">{weekdayName(day.dateKey)}</span>
                <span className="block text-[11px] font-semibold opacity-80">
                  {formatShortDate(day.dateKey)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* THE ALL-DAY ROW, and only when something is in it. A permanent empty strip above the
              hours is a frame that says nothing — the fault he burned down. */}
          {anyJoiner ? (
            <tr className="border-t border-slate-200">
              <th
                className="border-r border-slate-200 px-2 py-1.5 text-left align-top text-[11px] font-bold uppercase tracking-wide text-slate-500"
                scope="row"
              >
                All day
              </th>
              {days.map((day) => (
                <td
                  className={`border-r border-slate-200 p-1 align-top last:border-r-0 ${
                    day.dateKey === todayKey ? "bg-orange-50/40" : ""
                  }`}
                  key={day.dateKey}
                >
                  <div className="flex flex-col gap-1">
                    {day.joiners.map((joiner) => (
                      <JoinerChip joiner={joiner} key={joiner.id} />
                    ))}
                  </div>
                </td>
              ))}
            </tr>
          ) : null}
          {slots.map((minutes, rowIndex) => (
            <tr
              className={`border-t border-slate-200 ${rowIndex % 2 === 1 ? "bg-slate-50/70" : ""}`}
              key={minutes}
            >
              <th
                className="border-r border-slate-200 px-2 py-1.5 text-left align-top text-[12px] font-semibold tabular-nums text-slate-500"
                scope="row"
              >
                {formatTimeOfDay(minutes)}
              </th>
              {days.map((day) => (
                <SlotCell
                  day={day}
                  isToday={day.dateKey === todayKey}
                  key={day.dateKey}
                  nowMinutes={nowMinutes}
                  slotStartMinutes={minutes}
                />
              ))}
            </tr>
          ))}
          {/* OUTSIDE THE WORKING DAY — see `outsideWorkdayInterviews`. The grid has no row for an
              8:30 screening or a 6pm overseas call, and a booking a diary does not draw at all is
              worse than no diary. */}
          {anyOutside ? (
            <tr className="border-t border-slate-200">
              <th
                className="border-r border-slate-200 px-2 py-1.5 text-left align-top text-[11px] font-bold uppercase leading-tight tracking-wide text-slate-500"
                scope="row"
              >
                Outside 9–5
              </th>
              {outside.map(({ day, interviews }) => (
                <td
                  className={`border-r border-slate-200 p-1 align-top last:border-r-0 ${
                    day.dateKey === todayKey ? "bg-orange-50/40" : ""
                  }`}
                  key={day.dateKey}
                >
                  <div className="flex flex-col gap-1">
                    {interviews.map((interview) => (
                      <SlotBooking interview={interview} key={interview.id} />
                    ))}
                  </div>
                </td>
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The week on a phone: one card per day, the interview calendar's own mobile answer.
 *
 * A day with nothing on it still gets its card and says so in words. A week of five cards, two of
 * them reading "No interviews", is the shape of her week — five cards that silently skip the quiet
 * days is a week that looks fuller than it is.
 */
function WeekDayCards({
  days,
  todayKey,
}: {
  days: readonly TalentCalendarDay[];
  todayKey: string;
}) {
  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {days.map((day) => {
        const interviews = [...day.interviews].sort(
          (left, right) =>
            left.startMinutes - right.startMinutes
            || left.candidateName.localeCompare(right.candidateName),
        );
        return (
          <li
            className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}
            key={day.dateKey}
          >
            <p
              className={`flex items-baseline justify-between gap-2 px-3 py-2 text-white ${
                day.dateKey === todayKey ? "bg-orange-600" : "bg-slate-900"
              }`}
            >
              <span className="text-[14px] font-bold">{weekdayName(day.dateKey)}</span>
              <span className="text-[12px] font-semibold opacity-80">
                {formatShortDate(day.dateKey)}
              </span>
            </p>
            {day.joiners.length > 0 ? (
              <div className="flex flex-col gap-1 border-b border-slate-100 p-2">
                {day.joiners.map((joiner) => (
                  <JoinerChip joiner={joiner} key={joiner.id} />
                ))}
              </div>
            ) : null}
            {interviews.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-slate-500">
                {day.joiners.length > 0 ? "No interviews." : "Nothing booked."}
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {interviews.map((interview) => (
                  <li key={interview.id}>
                    <Link
                      className="flex w-full items-start gap-3 bg-orange-50 px-3 py-2.5 text-left transition-colors hover:bg-orange-100"
                      href={interview.href}
                    >
                      <span className="w-[4.75rem] shrink-0 text-[12px] font-bold tabular-nums text-slate-700">
                        {formatTimeOfDay(interview.startMinutes)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-[12px] font-bold leading-tight text-slate-900">
                          {interview.candidateName}
                        </span>
                        <span className="mt-0.5 block break-words text-[10.5px] font-semibold leading-tight text-slate-700">
                          {interview.interviewerName ?? "No interviewer named"}
                        </span>
                        <span className="mt-0.5 block break-words text-[10.5px] leading-tight text-slate-600">
                          {interview.timeLabel} · {interview.platformLabel}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A joining day in the all-day row — the booking chip's own shape in indigo.
 *
 * SAME SHAPE, DIFFERENT COLOUR, is the point. A start date and an interview are two different kinds
 * of fact, so the edge changes colour and the word "Joins" names it; everything else — the 3px left
 * edge, the flat 100-weight fill, the 12px name — is the chip beside it, because two chips on one
 * sheet that differ in shape read as two unrelated systems.
 */
function JoinerChip({ joiner }: { joiner: TalentJoiner }) {
  return (
    <Link
      className="block w-full border-l-[3px] border-l-indigo-600 bg-indigo-100 px-1.5 py-1 text-left transition-colors hover:bg-indigo-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-indigo-700"
      href={joiner.href}
    >
      <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-indigo-700">
        <UserRoundCheck aria-hidden="true" className="h-3 w-3 shrink-0" />
        Joins
      </span>
      <span className="mt-0.5 block break-words text-[12px] font-bold leading-tight text-slate-900">
        {joiner.name}
      </span>
      <span className="mt-0.5 block break-words text-[10.5px] font-semibold leading-tight text-slate-700">
        {joiner.title}
      </span>
    </Link>
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
            isToday ? "text-orange-600" : inMonth ? "text-slate-900" : "text-slate-300"
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

  /**
   * The current Cairo minute, for the now line — CLIENT-ONLY, and deliberately absent on the server.
   *
   * A clock rendered on the server is the minute the page was BUILT, which would then sit frozen on
   * the grid for as long as the tab is open and be wrong for every later reader of a cached page. It
   * is read on a timeout rather than in the effect body so no setter runs synchronously during the
   * effect (the rule that failed `checks` once already on this component).
   */
  const [nowMinutes, setNowMinutes] = useState<number | null>(null);
  useEffect(() => {
    const read = () => setNowMinutes(cairoMinutesOfDay(new Date()));
    const first = setTimeout(read, 0);
    const id = setInterval(read, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  /**
   * The minute the grid draws its now line at — null on any week that does not hold today.
   *
   * A "now" drawn on next week's sheet is a lie, and it is the kind a tired reader believes.
   */
  const gridNowMinutes = showingThisWeek ? nowMinutes : null;

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
            Your interview week on a real timetable — every booking sits at the hour it runs and is
            as tall as it is long — then your own next three weeks, and the company month with its
            holidays, leave, events and birthdays. The week re-reads itself every minute while you
            are looking at it, and the orange line is now.
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

      {/* ── WEEK ──────────────────────────────────────────────────────────────────────────────── */}
      {view === "week" ? (
        <div>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200/70 bg-slate-50/60 px-5 py-3">
            <button
              aria-label="The week before"
              className={ARROW_BUTTON}
              onClick={() => go({ taWeek: addDays(calendar.weekStart, -7) })}
              type="button"
            >
              <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
            {/* The week she is looking at, set in the display serif — the one line in the toolbar
                that has to be read, so it is the one line that is not in small caps. */}
            <span className="font-display break-words text-[13px] font-black leading-none tracking-[0.01em] text-slate-950 tabular-nums">
              {formatWeekRange(calendar.weekStart)}
            </span>
            <button
              aria-label="The week after"
              className={ARROW_BUTTON}
              onClick={() => go({ taWeek: addDays(calendar.weekStart, 7) })}
              type="button"
            >
              <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
            {showingThisWeek ? null : (
              <button
                className={`inline-flex shrink-0 items-center px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-slate-600 ${CONTROL_SKIN}`}
                onClick={() => go({ taWeek: null })}
                type="button"
              >
                This week
              </button>
            )}
            {refreshedAt ? (
              <span className="ml-auto whitespace-nowrap text-[8.5px] font-black uppercase tracking-[0.16em] text-slate-300">
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
              {/* A week with nothing in it is said in WORDS as well as drawn. An empty grid is the
                  honest picture of a free week, but it is also what a failed read would look like
                  if `interviewsLoaded` ever stopped being checked — so the week says which it is. */}
              {weekDaysState.every(
                (day) => day.interviews.length === 0 && day.joiners.length === 0,
              ) ? (
                <p className="border-b border-slate-200/70 bg-slate-50/60 px-5 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                  Nothing booked this week
                </p>
              ) : null}

              <div className="p-5">
                <WeekSlotTable
                  days={weekDaysState}
                  nowMinutes={gridNowMinutes}
                  todayKey={todayKey}
                />
                <WeekDayCards days={weekDaysState} todayKey={todayKey} />
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
                          className="w-[72px] shrink-0 whitespace-nowrap text-[9px] font-black uppercase tracking-[0.14em] text-slate-400 tabular-nums"
                        >
                          {sameDayAsAbove
                            ? ""
                            : `${weekdayShort(interview.dateKey)} ${formatShortDate(interview.dateKey)}`}
                        </span>
                        <span className="whitespace-nowrap text-[9.5px] font-black uppercase tracking-[0.1em] text-orange-600 tabular-nums">
                          {interview.timeLabel}
                        </span>
                        <span className="min-w-0 flex-1 break-words text-[12px] font-black text-slate-900">
                          {interview.candidateName}
                        </span>
                        <span className="break-words text-[8.5px] font-black uppercase tracking-[0.16em] text-slate-300">
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
            <div className="grid grid-cols-7 gap-px border border-slate-200 bg-slate-200/80 shadow-[0_1px_2px_rgba(15,23,42,0.045)]">
              {MONTH_COLUMN_LABELS.map((label) => (
                <div
                  className="min-w-0 bg-white px-1 py-1.5 text-center text-[8.5px] font-black uppercase tracking-[0.18em] text-slate-400"
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
