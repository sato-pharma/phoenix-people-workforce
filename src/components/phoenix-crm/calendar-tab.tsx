"use client";

import { useMemo, useState } from "react";

import { crmUrl, useCrmGet } from "@/components/phoenix-crm/api";
import { CrmBlock, CrmEmpty, CrmField, CrmLoadError, CrmLoading, CrmNote, CrmPanel, CrmSelect, CrmStat, CrmStatGrid, CrmTable } from "@/components/phoenix-crm/ui";
import { awaitingValidationNote } from "@/lib/crm/call-rate";
import { dayActivityLabel } from "@/lib/phoenix-crm/day-activities";
import { opensForMissedRecords } from "@/lib/phoenix-crm/missed-records";
import { PHOENIX_CRM_PORTAL_BASE } from "@/lib/phoenix-crm/modules";
import { LEAVE_UNREAD_NOTE } from "@/lib/phoenix-crm/plan-leave";
import type { DayShape, TeamCalendarDay, TeamCalendarRow } from "@/lib/phoenix-crm/team-calendar";
import { emptyVisitCountSplit, mergeVisitCountSplits, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";
import { cn } from "@/lib/utils";

/**
 * Phoenix CRM — the team's month, as its own tab.
 *
 * 🔴 ITS OWN TAB, NOT A SECTION OF REPORTS (owner, 2026-09-30: "build the team calendar into a
 * separate tab inside the button of the Phoenix CRM"). It sits beside Team in the chooser, because
 * it answers over a month what Team answers for a day.
 *
 * 🔴 IT IS HIS OWN GRID, REBUILT — one row per person, one column per day, and the CELL'S COLOUR
 * saying which halves of the day he worked (his legend, off the 2026-09-29 recording: AM only cyan,
 * PM only orange, AM + PM green, Annual Vacation blue, Campaign pink, Friday black). The palette is
 * deliberately his and not Phoenix's orange: a design he hands over is final, and a manager who
 * knows the old grid must not have to relearn the colours.
 *
 * 🔴 TWO FIGURES IN A BOTH-HALVES CELL, NEVER ONE. His grid prints a single number, which on a
 * both-halves day is AM + PM added — and the AM · PM · Pharmacies golden rule reports every count
 * apart. So a cell carries the one figure its colour already names, or the two stacked. There is no
 * combined number anywhere on this screen.
 *
 * 🔴 AND IT FITS THE SCREEN. His own grid scrolls sideways across 31 day columns, which Phoenix
 * bans outright. The 31 columns live in a `table-fixed` grid with a percentage `colgroup`, so they
 * fit whatever the width from `lg` up, and below that the four identity columns MERGE into one card
 * per person holding the month as a seven-wide calendar. Nothing here is `overflow-x-auto` over a
 * `min-width`, which is the bug the rule names.
 */

const CALENDAR_PATH = "/api/phoenix-crm/reports";

type CalendarView = {
  month: string;
  rows: TeamCalendarRow[];
  totals: VisitCountSplit;
  days: string[];
  isTest: boolean;
  /** `own` when the reader is a rep seeing himself, `team` when he is reading other people. */
  scope: "own" | "team";
  /** The Super Admin's: the last day and the territories he may enter a missed record on. Null for everyone else. */
  missedRecords: { through: string; seatIds: string[] } | null;
  /** HR's leave could not be read, so an approved vacation draws as blank days — said, never swallowed. */
  leaveUnread: boolean;
};

/** His legend, as ink. Square edges, and one class string per shape so nothing is composed at runtime. */
const SHAPE_INK: Record<DayShape, string> = {
  activity: "border-pink-300 bg-pink-100 text-pink-900",
  am: "border-sky-300 bg-sky-100 text-sky-900",
  both: "border-emerald-400 bg-emerald-100 text-emerald-900",
  leave: "border-blue-400 bg-blue-200 text-blue-900",
  none: "border-slate-200 bg-white text-slate-300",
  pm: "border-orange-300 bg-orange-100 text-orange-900",
  rest: "border-slate-900 bg-slate-900 text-white",
};

const SHAPE_WORD: Record<DayShape, string> = {
  activity: "Other activity",
  am: "AM only",
  both: "AM + PM",
  leave: "On leave",
  none: "Nothing",
  pm: "PM only",
  rest: "Friday",
};

/** The order the legend reads in — the three worked shapes first, then the three reasons a day is blank. */
const LEGEND: readonly DayShape[] = ["am", "pm", "both", "leave", "activity", "rest"];

/** Saturday first — the field week, as every other Phoenix CRM surface reads it. */
const WEEKDAYS = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"] as const;

function weekdayColumn(iso: string): number {
  // A date-only string has no time of day to place in a zone, so it is read as UTC: that is what
  // keeps the weekday from sliding by one for anyone west of Cairo.
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 1) % 7; // Saturday becomes 0
}

function dayNumber(iso: string): number {
  return Number(iso.slice(8, 10));
}

function monthLabel(month: string): string {
  const at = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(at.getTime())
    ? month
    : at.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC", year: "numeric" });
}

/** "Wednesday 30 September 2026" — the long form the rest of the module prints a day in. */
function dayLabel(iso: string): string {
  const at = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC", weekday: "long", year: "numeric" });
}

function shiftMonth(month: string, by: number): string {
  const at = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + by, 1));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "AM 3 · PM 9 · Pharmacies 2" — three figures apart, never one combined number. */
function splitText(counts: VisitCountSplit): string {
  return `AM ${counts.am} · PM ${counts.pm} · Pharmacies ${counts.pharmacies}`;
}

/** The whole sentence a cell means, for its tooltip and for a screen reader. Nothing is left cryptic. */
function dayTitle(person: string, day: TeamCalendarDay, opens: boolean): string {
  const parts = [`${person} · ${day.day}`, SHAPE_WORD[day.shape]];
  if (day.shape === "am" || day.shape === "both" || day.shape === "pm") parts.push(splitText(day.counts));
  if (day.activity) parts.push(dayActivityLabel(day.activity));
  if (day.onLeave && day.shape !== "leave") parts.push("HR has approved leave on this day");
  if (opens) {
    parts.push(
      opensTheDay(day)
        ? "Opens the day in full, in a new tab"
        : "Opens the day in a new tab, to enter a record they missed",
    );
  }
  return parts.join(" — ");
}

/**
 * 🔴 A DAY WITH WORK ON IT OPENS IN A NEW TAB (owner, 2026-09-30: "when I press on any day that
 * have activity, I am redirected to a new tab with the full detail of this day").
 *
 * "Activity" is read as HIS four working shapes — the halves he worked, or a recorded day activity.
 * A Friday, an approved leave day and an empty day have no day to open: pressing one still says why
 * it is blank, in the panel below the grid, rather than spending a tab on a page that would only
 * repeat the cell. The test is the SHAPE and never arithmetic on the counts, which is what keeps
 * AM and PM from being added here to decide it.
 */
function opensTheDay(day: TeamCalendarDay): boolean {
  return day.shape === "am" || day.shape === "pm" || day.shape === "both" || day.shape === "activity";
}

/**
 * 🔴 AND FOR THE SUPER ADMIN, EVERY DAY THAT HAS BEGUN OPENS, the empty ones included (owner,
 * 2026-10-01: "admin can enter manual record for anyone, anytime, anywhere"). An empty day is exactly
 * where a missed record belongs, and the day's page is where he enters it. Only on the territories the
 * server named (`missedRecords.seatIds`) — a vacant seat, or a line that has not opened, has nothing
 * to enter for — and never a day still to come.
 */
function opensForEntry(entrySeats: ReadonlySet<string>, through: string | null, seatId: string, day: TeamCalendarDay): boolean {
  return entrySeats.has(seatId) && opensForMissedRecords(day.day, through);
}

/**
 * The day's own address. `test` rides along so a test-mode calendar opens the test-mode day.
 *
 * 🔴 A MANAGER'S ROW OPENS HIS OWN PAGE (owner, 2026-10-20: his visits were a bare count — "I want full
 * details"). A manager's seat is no territory, so `/day/<seat>` would refuse it; `/manager-day/<seat>` lists
 * his own single visits and the visits he rode with a rep, card by card.
 */
function dayHref(row: { seatId: string; kind?: "rep" | "manager" }, day: string, test: boolean): string {
  const page = row.kind === "manager" ? "manager-day" : "day";
  return `${PHOENIX_CRM_PORTAL_BASE}/${page}/${encodeURIComponent(row.seatId)}/${day}${test ? "?test=1" : ""}`;
}

/**
 * Whether a cell is a link. A rep's cell opens on a working day (or, for the Super Admin, to enter what was
 * missed); a manager's opens only on a day he worked, because there is no record to enter on a manager's seat.
 * A product manager's row opens nothing (owner, 2026-10-20): he holds no seat, so there is no day page to open
 * on it — his cell explains the day in the panel below the grid, and each visit he rode is on the rep's day.
 */
function cellOpens(
  row: { seatId: string; kind?: "rep" | "manager"; seatless?: boolean },
  day: TeamCalendarDay,
  entrySeats: ReadonlySet<string>,
  entryThrough: string | null,
): boolean {
  if (row.seatless) return false;
  if (row.kind === "manager") return opensTheDay(day);
  return opensTheDay(day) || opensForEntry(entrySeats, entryThrough, row.seatId, day);
}

/** What a cell prints: the figure its colour names, the two stacked, or his letter. */
function CellFace({ day }: { day: TeamCalendarDay }) {
  if (day.shape === "both") {
    return (
      <span className="block leading-[1.1]">
        <span className="block tabular-nums">{day.counts.am}</span>
        <span className="block border-t border-black/15 tabular-nums">{day.counts.pm}</span>
      </span>
    );
  }
  if (day.shape === "am") return <span className="tabular-nums">{day.counts.am}</span>;
  if (day.shape === "pm") return <span className="tabular-nums">{day.counts.pm}</span>;
  if (day.shape === "rest") return <span aria-hidden>F</span>;
  if (day.shape === "activity") return <span aria-hidden>•</span>;
  return <span aria-hidden>{day.shape === "leave" ? "—" : ""}</span>;
}

export function CalendarTab({ cairoToday, test }: { cairoToday: string; test: boolean }) {
  // 🔴 NULL UNTIL HE PICKS ONE, AND THAT IS THE WHOLE MECHANISM. `crmUrl` drops a null, so the
  //    first request names no month and the SERVER answers with the last month that has work in
  //    it (owner, 2026-10-01). Choosing here instead would need a second fetch — the client
  //    cannot know which month has work until something has been read — and would flash an empty
  //    current month on the way. Once an arrow is pressed this holds a real month and the server
  //    stops choosing.
  const [picked, setPicked] = useState<string | null>(null);
  const [open, setOpen] = useState<{ seatId: string; day: string } | null>(null);
  // The rep whose calendar is the only one drawn; empty is everyone. It is a SEAT, because a person
  // can hold two (a district manager who also covers a rep seat) and each has a calendar of its own.
  const [repSeat, setRepSeat] = useState("");
  const view = useCrmGet<CalendarView>(
    // `crmUrl` drops a false flag, and the server reads "true" — so test mode is on only when sent.
    crmUrl(CALENDAR_PATH, { includeTest: test, month: picked, section: "calendar" }),
    "report",
  );
  // What the heading and the arrows work from: his choice, else the month the server chose, else
  // this month while the first read is still in flight.
  const month = picked ?? view.data?.month ?? cairoToday.slice(0, 7);

  const allRows = useMemo(() => view.data?.rows ?? [], [view.data]);
  // 🔴 A CHOSEN REP WHO IS NOT IN THIS MONTH'S ROWS FALLS BACK TO EVERYONE rather than an empty
  //    screen: the rows are re-read on every month step, and a seat that left the scope would
  //    otherwise leave a filter nobody can see and nothing to draw under it.
  const filtered = repSeat !== "" && allRows.some((row) => row.seatId === repSeat);
  const rows = useMemo(
    () => (filtered ? allRows.filter((row) => row.seatId === repSeat) : allRows),
    [allRows, filtered, repSeat],
  );
  // The month's three figures follow whoever is drawn. Unfiltered they are the server's own,
  // untouched; filtered they are that rep's row totals, summed by the merge the server uses.
  const totals = useMemo(() => {
    if (!filtered || !view.data) return view.data?.totals ?? emptyVisitCountSplit();
    return rows.reduce((sum, row) => mergeVisitCountSplits(sum, row.totals), emptyVisitCountSplit());
  }, [filtered, rows, view.data]);
  // Visits saved this month that count in nothing yet, because the customer is not validated.
  // Summed here rather than carried on the view: the grid already holds every day it draws.
  const waitingThisMonth = useMemo(
    () => rows.reduce((sum, row) => sum + row.days.reduce((inDay, day) => inDay + day.awaitingValidation, 0), 0),
    [rows],
  );
  const days = useMemo(() => view.data?.days ?? [], [view.data]);
  // The Super Admin's: which territories open on any day that has begun, to enter a missed record.
  const entryThrough = view.data?.missedRecords?.through ?? null;
  const entrySeats = useMemo(() => new Set(view.data?.missedRecords?.seatIds ?? []), [view.data]);
  // A rep reads only himself here (owner, 2026-10-01), so the heading says so rather than calling
  // one person a team. It follows the SERVICE's own `scope`, never the row count — a district
  // manager down to one rep still reads a team, and a count would rename his screen as people
  // join and leave.
  const own = view.data?.scope === "own";
  // A picker of one is no picker: a rep reads only himself, and a team of one has nobody to choose.
  const canChooseRep = !own && allRows.length > 1;
  const hasManagers = allRows.some((row) => row.kind === "manager");
  const chosen = useMemo(() => {
    if (!open) return null;
    const row = rows.find((entry) => entry.seatId === open.seatId);
    const day = row?.days.find((entry) => entry.day === open.day);
    return row && day ? { day, row } : null;
  }, [open, rows]);

  function pick(seatId: string, day: string) {
    setOpen((current) => (current?.seatId === seatId && current.day === day ? null : { day, seatId }));
  }

  return (
    <CrmPanel
      actions={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {[
            { by: -1, label: "Previous month" },
            { by: 1, label: "Next month" },
          ].map((step) => (
            <button
              className="min-h-11 rounded-none border border-slate-300 bg-white px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-700 transition hover:border-slate-400"
              key={step.label}
              onClick={() => {
                // From the month on screen, which on the first press is the one the server chose
                // — stepping from `picked` would jump back to this month from wherever he landed.
                setPicked(shiftMonth(month, step.by));
                setOpen(null);
              }}
              type="button"
            >
              {step.label}
            </button>
          ))}
        </div>
      }
      description={
        own
          ? "One column a day. The colour says which halves of the day you worked; the figures stay apart."
          : "One row a person, one column a day, managers first. The colour says which halves of the day were worked; the figures stay apart."
      }
      eyebrow="Phoenix CRM"
      title={`${own ? "Your month" : "The team's month"} · ${monthLabel(month)}`}
    >
      {view.error ? <CrmLoadError message={view.error} onRetry={view.reload} /> : null}
      {!view.data && !view.error ? <CrmLoading label="Reading the month" /> : null}

      {view.data && rows.length === 0 ? (
        <CrmEmpty
          message="A territory shows here once its line opens in Phoenix CRM."
          title="No territory to show"
        />
      ) : null}

      {view.data && rows.length > 0 ? (
        <>
          <CrmBlock title="The month">
            {canChooseRep ? (
              <CrmField className="mb-3 sm:max-w-md" htmlFor="calendar-rep" label="Person">
                <CrmSelect
                  id="calendar-rep"
                  onChange={(event) => {
                    setRepSeat(event.target.value);
                    setOpen(null);
                  }}
                  value={filtered ? repSeat : ""}
                >
                  <option value="">{`Everyone (${allRows.length})`}</option>
                  {allRows.map((row) => (
                    <option key={row.seatId} value={row.seatId}>
                      {`${row.person} · ${row.territory}`}
                    </option>
                  ))}
                </CrmSelect>
              </CrmField>
            ) : null}
            {/* 🔴 Three figures apart, as everywhere. There is no combined total on this screen. */}
            <CrmStatGrid>
              <CrmStat label="AM" value={totals.am} />
              <CrmStat label="PM" value={totals.pm} />
              <CrmStat label="Pharmacies" note="Counted apart, never inside AM or PM" value={totals.pharmacies} />
              <CrmStat label="People" note={`${days.length} days each`} value={rows.length} />
            </CrmStatGrid>
            {/* 🔴 A manager's row repeats the visits he rode with a rep, so the three figures above are
                the REPS' alone — said where a manager reads them, or his row would look uncounted. */}
            {hasManagers && !filtered ? (
              <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-600">
                The AM, PM and Pharmacies figures count the reps&apos; visits only. A manager&apos;s row shows the
                days they worked: their own single visits and the visits they joined a rep on, which are
                already in that rep&apos;s row.
              </p>
            ) : null}
            {/* A cell that looks empty because the customer is not validated yet, not because the
                rep stayed home. The same sentence the reports and both call-rate boards print. */}
            {awaitingValidationNote({ awaitingValidation: waitingThisMonth }) ? (
              <div className="mt-3">
                <CrmNote title="Some days look emptier than they were" tone="info">
                  {awaitingValidationNote({ awaitingValidation: waitingThisMonth })}
                </CrmNote>
              </div>
            ) : null}
            {/* 🔴 A failed leave read is SAID, never swallowed. Without it an approved vacation draws
                as a run of blank white cells, which a manager reads as a week the rep did nothing. */}
            {view.data.leaveUnread ? (
              <div className="mt-3">
                <CrmNote title="Leave could not be read" tone="warn">
                  {LEAVE_UNREAD_NOTE}
                </CrmNote>
              </div>
            ) : null}
            <div className="mt-3 flex min-w-0 flex-wrap gap-1.5">
              {LEGEND.map((shape) => (
                <span
                  className={cn(
                    "inline-flex min-w-0 items-center gap-1.5 rounded-none border px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em]",
                    SHAPE_INK[shape],
                  )}
                  key={shape}
                >
                  {SHAPE_WORD[shape]}
                </span>
              ))}
            </div>
            {entryThrough !== null ? (
              <p className="mt-3 break-words text-xs font-semibold leading-5 text-slate-600">
                Any day up to today opens for you, an empty one included, to enter a visit or a day&apos;s activity a rep
                missed. It is marked as entered by the Super Admin wherever it shows.
              </p>
            ) : null}
          </CrmBlock>

          {/* ── From `lg`: his grid, one row a person ───────────────────────────────────────── */}
          <CrmBlock className="max-lg:hidden" title="Day by day">
            {/* 🔴 THROUGH `CrmTable`, NEVER A RAW <table>. It is what carries `w-full table-fixed`
                and the <colgroup> the fits-the-screen rule asks for, and every table in this module
                goes through it — `tests/phoenix-crm-fits-the-screen` refuses a hand-rolled one, and
                it caught this grid. `desktopOnly` is off because the wrapper above already hides it
                below `lg`, where the cards take over. */}
            <CrmTable columns={["22%", ...days.map(() => `${78 / Math.max(1, days.length)}%`)]} desktopOnly={false}>
              <thead>
                <tr>
                  <th className="border border-slate-200 bg-slate-50 px-2 py-1.5 text-left text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-500">
                    Person
                  </th>
                  {days.map((day) => (
                    <th
                      className="border border-slate-200 bg-slate-50 px-0 py-1.5 text-center text-phx-3xs font-black tabular-nums text-slate-500"
                      key={day}
                      scope="col"
                    >
                      {String(dayNumber(day)).padStart(2, "0")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.seatId}>
                    <th className="border border-slate-200 bg-white px-2 py-1.5 text-left align-top" scope="row">
                      <span className="block break-words text-xs font-black leading-5 text-slate-900" dir="auto">
                        {row.person}
                      </span>
                      <span className="block break-words text-phx-3xs font-semibold leading-4 text-slate-500" dir="auto">
                        {row.territory}
                      </span>
                      {row.manager ? (
                        <span className="block break-words text-phx-3xs font-semibold leading-4 text-slate-400" dir="auto">
                          Under {row.manager}
                        </span>
                      ) : null}
                    </th>
                    {row.days.map((day) => {
                      const opens = cellOpens(row, day, entrySeats, entryThrough);
                      const face = cn(
                        "flex h-11 w-full items-center justify-center rounded-none border-0 px-0 text-center text-phx-3xs font-black transition",
                        SHAPE_INK[day.shape],
                        open?.seatId === row.seatId && open.day === day.day ? "ring-2 ring-inset ring-slate-900" : "",
                        opens ? "cursor-pointer hover:brightness-95" : "",
                      );
                      return (
                        <td className="border border-slate-200 p-0 align-middle" key={day.day}>
                          {opens ? (
                            // A NEW TAB, his own word: the calendar he is reading stays where it is.
                            // `rel` is the pair that keeps the opened page from reaching back.
                            <a
                              aria-label={dayTitle(row.person, day, true)}
                              className={face}
                              href={dayHref(row, day.day, test)}
                              rel="noopener noreferrer"
                              target="_blank"
                              title={dayTitle(row.person, day, true)}
                            >
                              <CellFace day={day} />
                            </a>
                          ) : (
                            <button
                              aria-label={dayTitle(row.person, day, false)}
                              className={face}
                              onClick={() => pick(row.seatId, day.day)}
                              title={dayTitle(row.person, day, false)}
                              type="button"
                            >
                              <CellFace day={day} />
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </CrmTable>
          </CrmBlock>

          {/* ── Below `lg`: the identity columns MERGE into a card, and the month becomes a seven-wide
                 calendar. This is the fits-the-screen rule's "merge, never shrink" in practice. ── */}
          <CrmBlock className="lg:hidden" title="Day by day">
            <div className="grid min-w-0 gap-3">
              {rows.map((row) => (
                <div className="min-w-0 rounded-none border border-slate-200 bg-white p-3" key={row.seatId}>
                  <p className="break-words text-sm font-black leading-5 text-slate-900" dir="auto">
                    {row.person}
                  </p>
                  <p className="break-words text-xs font-semibold leading-5 text-slate-500" dir="auto">
                    {row.territory}
                    {row.manager ? ` · under ${row.manager}` : ""}
                  </p>
                  <p className="mt-1 break-words text-xs font-black leading-5 text-slate-700">{splitText(row.totals)}</p>
                  <p className="break-words text-phx-2xs font-semibold uppercase tracking-[0.08em] leading-5 text-slate-500">
                    {`AM only ${row.amOnlyDays} · PM only ${row.pmOnlyDays} · Both ${row.bothDays}`}
                  </p>
                  <div className="mt-2 grid grid-cols-7 gap-px">
                    {WEEKDAYS.map((name) => (
                      <div
                        className="px-0 py-1 text-center text-phx-3xs font-black uppercase tracking-[0.06em] text-slate-400"
                        key={name}
                      >
                        {name}
                      </div>
                    ))}
                    {Array.from({ length: row.days[0] ? weekdayColumn(row.days[0].day) : 0 }, (_, index) => (
                      <div key={`lead-${index}`} />
                    ))}
                    {row.days.map((day) => {
                      const opens = cellOpens(row, day, entrySeats, entryThrough);
                      const face = cn(
                        "flex min-h-11 min-w-0 flex-col items-center justify-center rounded-none border px-0 py-1 text-center text-phx-3xs font-black transition",
                        SHAPE_INK[day.shape],
                        open?.seatId === row.seatId && open.day === day.day ? "ring-2 ring-inset ring-slate-900" : "",
                      );
                      const inside = (
                        <>
                          <span className="block text-phx-3xs font-black tabular-nums opacity-70">{dayNumber(day.day)}</span>
                          <CellFace day={day} />
                        </>
                      );
                      // The same rule as the grid above: a day with work on it opens in a new tab — and,
                      // for the Super Admin, any day that has begun, to enter what was missed.
                      return opens ? (
                        <a
                          aria-label={dayTitle(row.person, day, true)}
                          className={face}
                          href={dayHref(row, day.day, test)}
                          key={day.day}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          {inside}
                        </a>
                      ) : (
                        <button
                          aria-label={dayTitle(row.person, day, false)}
                          className={face}
                          key={day.day}
                          onClick={() => pick(row.seatId, day.day)}
                          type="button"
                        >
                          {inside}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </CrmBlock>

          {chosen ? (
            <CrmBlock title={`${chosen.row.person} · ${dayLabel(chosen.day.day)}`}>
              <p className="break-words text-sm font-black text-slate-900">{SHAPE_WORD[chosen.day.shape]}</p>
              <p className="mt-1 break-words text-sm font-black text-slate-900">{splitText(chosen.day.counts)}</p>
              <p className="mt-1 break-words text-xs font-semibold leading-5 text-slate-600">
                {chosen.day.counts.pharmacies > 0
                  ? "Pharmacies are counted apart and never colour the day — a pharmacy is not a contact."
                  : "No pharmacy feedback was recorded on this day."}
              </p>
              {chosen.day.activity ? (
                <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-600">
                  Recorded as a day activity: {dayActivityLabel(chosen.day.activity)}.
                </p>
              ) : null}
              {chosen.day.onLeave ? (
                <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-600">
                  HR has approved leave covering this day.
                </p>
              ) : null}
              {chosen.row.seatless ? (
                <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-600">
                  A product manager&apos;s day: their own single visits plus the visits a rep logged naming them as
                  the product manager. They hold no territory, so the day has no page of its own: each visit they
                  joined opens from that rep&apos;s row. Counted in none of the month&apos;s totals.
                </p>
              ) : chosen.row.kind === "manager" ? (
                <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-600">
                  A manager&apos;s day: their own single visits plus the visits they joined a rep on. A day with
                  either opens in full, in a new tab. A day spent on admin, a meeting or travel is not drawn here.
                </p>
              ) : null}
            </CrmBlock>
          ) : null}
        </>
      ) : null}
    </CrmPanel>
  );
}
