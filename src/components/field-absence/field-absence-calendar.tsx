"use client";

/**
 * Field Absence Calendar — the screen both doors draw (`/admin/field-absence` and its portal twin).
 *
 * Everything that decides who is listed was decided on the server (`src/lib/field-absence/`); this
 * file only lays it out three ways — Month, Week and Detail — and narrows it by a name search. The
 * period, the view and the line live in the address, so the server renders each one and a link
 * opens exactly what the sender saw.
 *
 * One thing is decided here and only here: a National Sales Manager may hide HIMSELF from his own
 * line's calendar (owner, 2026-10-18: *"he sees himself, but he may have a toggle to hide himself and
 * show his scope"*). Hiding takes him out of every box AND out of every day's "of N", using the days
 * he was judged on, so the counts stay true to what is drawn.
 *
 * House rules: square corners, nothing scrolls sideways (the month grid turns into day cards when
 * its own box is narrow, tables turn into cards below `md`), and names wrap in full — never cut short.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { countText, dayLabel, dayLabelLong, monthLabel, plural } from "@/components/phoenix-crm/format";
import {
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmCheck,
  CrmChoice,
  CrmEmpty,
  CrmFacts,
  CrmField,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmSearchField,
  CrmSelect,
  CrmStat,
  CrmStatGrid,
  CrmTable,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import {
  addDays,
  FIELD_ABSENCE_SOURCE_LABELS,
  fieldAbsenceWeekStart,
  type FieldAbsenceDay,
  type FieldAbsenceEntry,
  type FieldAbsencePageData,
  type FieldAbsencePersonSummary,
  type FieldAbsenceSource,
  type FieldAbsenceView,
} from "@/lib/field-absence/rules";
import { cn } from "@/lib/utils";

/** How many names a month box shows before "Show all"; the week view and the day list show every one. */
const MONTH_BOX_NAMES = 6;
const WEEKDAYS = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"] as const;
const SOURCES = Object.keys(FIELD_ABSENCE_SOURCE_LABELS) as FieldAbsenceSource[];

const linkButtonClassName =
  "inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-none border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 md:min-h-9";

function hrefFor(basePath: string, query: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const text = params.toString();
  return text ? `${basePath}?${text}` : basePath;
}

function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function placeText(entry: Pick<FieldAbsenceEntry, "lineName" | "areaName">): string {
  return [entry.lineName, entry.areaName].filter(Boolean).join(" · ") || "No line on the seat";
}

/** The one line under a day's date. */
function dayStatusText(day: FieldAbsenceDay, judged: boolean): string {
  if (day.kind === "future") return "Not yet";
  if (day.kind === "weekly-off") return "Weekly off";
  if (day.kind === "holiday") return "National holiday";
  if (!judged) return "Not judged";
  if (day.expected === 0) return "Nobody expected";
  if (day.notSeen.length === 0) return `All ${countText(day.expected)} seen`;
  return `${countText(day.notSeen.length)} not seen of ${countText(day.expected)}`;
}

function DayTags({ day }: { day: FieldAbsenceDay }) {
  if (day.kind !== "working" || (!day.halfDay && !day.provisional)) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {day.halfDay ? <CrmPill>Half day</CrmPill> : null}
      {day.provisional ? <CrmPill tone="info">So far</CrmPill> : null}
    </span>
  );
}

function NameButton({ entry, onOpen }: { entry: FieldAbsenceEntry; onOpen: () => void }) {
  return (
    <button
      className={
        entry.wholePeriod
          ? "flex w-full min-w-0 flex-wrap items-start gap-x-1.5 rounded-none border border-transparent px-1 py-0.5 text-left text-xs font-bold leading-5 text-rose-800 hover:border-slate-200 hover:bg-white"
          : "flex w-full min-w-0 flex-wrap items-start gap-x-1.5 rounded-none border border-transparent px-1 py-0.5 text-left text-xs font-bold leading-5 text-slate-800 hover:border-slate-200 hover:bg-white"
      }
      onClick={onOpen}
      type="button"
    >
      <span className="min-w-0 break-words">{entry.name}</span>
      <span className="pt-px text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-500">{entry.tierLabel}</span>
    </button>
  );
}

// ── Month ─────────────────────────────────────────────────────────────────────────────────────────

function MonthBox({
  day,
  judged,
  matches,
  onOpenDay,
  onOpenPerson,
}: {
  day: FieldAbsenceDay;
  judged: boolean;
  matches: (entry: FieldAbsenceEntry) => boolean;
  onOpenDay: () => void;
  onOpenPerson: (key: string) => void;
}) {
  const names = day.notSeen.filter(matches);
  const shown = names.slice(0, MONTH_BOX_NAMES);
  const quiet = day.kind !== "working";
  return (
    <div
      className={cn(
        "flex min-h-28 min-w-0 flex-col gap-1.5 border border-slate-200 p-2",
        quiet ? "bg-slate-50 text-slate-400" : "bg-white",
        day.provisional && "border-sky-300",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-1">
        <span className={cn("text-sm font-black", quiet ? "text-slate-400" : "text-slate-950")}>{Number(day.date.slice(8, 10))}</span>
        <DayTags day={day} />
      </div>
      <p className={cn("break-words text-xs font-bold leading-4", day.kind === "working" && judged && day.notSeen.length > 0 ? "text-rose-700" : "text-slate-500")}>
        {dayStatusText(day, judged)}
      </p>
      {shown.length > 0 ? (
        <div className="grid min-w-0 gap-0.5">
          {shown.map((entry) => (
            <NameButton entry={entry} key={entry.key} onOpen={() => onOpenPerson(entry.key)} />
          ))}
        </div>
      ) : null}
      {day.kind === "working" && names.length > 0 ? (
        <button
          className="mt-auto rounded-none border border-slate-200 bg-white px-1.5 py-1 text-left text-xs font-black text-orange-700 hover:border-slate-300"
          onClick={onOpenDay}
          type="button"
        >
          {names.length > shown.length ? `Show all ${countText(names.length)}` : "Open the day"}
        </button>
      ) : null}
    </div>
  );
}

function MonthView({
  days,
  judged,
  matches,
  onOpenDay,
  onOpenPerson,
}: {
  days: FieldAbsenceDay[];
  judged: boolean;
  matches: (entry: FieldAbsenceEntry) => boolean;
  onOpenDay: (date: string) => void;
  onOpenPerson: (key: string, date: string | null) => void;
}) {
  if (days.length === 0) return null;
  const leading = (() => {
    const out: string[] = [];
    for (let at = fieldAbsenceWeekStart(days[0].date); at < days[0].date; at = addDays(at, 1)) out.push(at);
    return out;
  })();
  const trailing = (() => {
    const out: string[] = [];
    const last = days[days.length - 1].date;
    for (let at = addDays(last, 1); at <= addDays(fieldAbsenceWeekStart(last), 6); at = addDays(at, 1)) out.push(at);
    return out;
  })();
  // A phone reads the most recent day first, and skips the days nobody is judged on.
  const phoneDays = days.filter((day) => day.kind === "working" || day.kind === "holiday").reverse();

  return (
    <div className="@container min-w-0">
      <div className="hidden min-w-0 @min-[760px]:block">
        <div className="grid gap-px" style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr)) minmax(0, 0.6fr)" }}>
          {WEEKDAYS.map((name) => (
            <div className="px-2 py-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500" key={name}>
              {name}
            </div>
          ))}
          {leading.map((date) => (
            <div aria-hidden className="min-h-28 border border-slate-100 bg-slate-50/60" key={date} />
          ))}
          {days.map((day) => (
            <MonthBox
              day={day}
              judged={judged}
              key={day.date}
              matches={matches}
              onOpenDay={() => onOpenDay(day.date)}
              onOpenPerson={(key) => onOpenPerson(key, day.date)}
            />
          ))}
          {trailing.map((date) => (
            <div aria-hidden className="min-h-28 border border-slate-100 bg-slate-50/60" key={date} />
          ))}
        </div>
      </div>
      <div className="grid min-w-0 gap-2 @min-[760px]:hidden">
        <p className="text-xs font-semibold text-slate-500">Newest day first. Weekly days off and days still to come are left out.</p>
        {phoneDays.map((day) => {
          const names = day.notSeen.filter(matches);
          return (
            <div className="min-w-0 border border-slate-200 bg-white p-3" key={day.date}>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-black text-slate-950">{dayLabel(day.date)}</span>
                <DayTags day={day} />
              </div>
              <p className={cn("mt-1 text-xs font-bold", judged && day.notSeen.length > 0 ? "text-rose-700" : "text-slate-500")}>
                {dayStatusText(day, judged)}
              </p>
              {names.length > 0 ? (
                <div className="mt-2 grid min-w-0 gap-0.5">
                  {names.map((entry) => (
                    <NameButton entry={entry} key={entry.key} onOpen={() => onOpenPerson(entry.key, day.date)} />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── A day's list: the week view, and the day opened from a month box ─────────────────────────────────

function DayList({
  entries,
  onOpenPerson,
}: {
  entries: FieldAbsenceEntry[];
  onOpenPerson: (key: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <>
      <CrmTable columns={["36%", "34%", "30%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>Name</th>
            <th className={crmThClassName}>Line · area</th>
            <th className={crmThClassName}>Manager</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.key}>
              <td className={crmTdClassName}>
                <button
                  className="break-words text-left font-black text-slate-950 underline decoration-slate-300 underline-offset-4 hover:decoration-orange-500"
                  onClick={() => onOpenPerson(entry.key)}
                  type="button"
                >
                  {entry.name}
                </button>
                <span className="mt-1 flex flex-wrap gap-1">
                  <CrmPill>{entry.tierLabel}</CrmPill>
                  {entry.wholePeriod ? <CrmPill tone="bad">Not seen on any day</CrmPill> : null}
                </span>
              </td>
              <td className={crmTdClassName}>{placeText(entry)}</td>
              <td className={crmTdClassName}>{entry.managerName ?? "No manager seat above"}</td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
      <CrmCardsOnPhone>
        {entries.map((entry) => (
          <CrmCard
            accent={entry.wholePeriod ? "border-l-rose-500" : "border-l-slate-300"}
            actions={
              <CrmButton onClick={() => onOpenPerson(entry.key)} size="sm">
                What was checked
              </CrmButton>
            }
            key={entry.key}
            meta={`${placeText(entry)} · ${entry.managerName ?? "No manager seat above"}`}
            status={
              <>
                <CrmPill>{entry.tierLabel}</CrmPill>
                {entry.wholePeriod ? <CrmPill tone="bad">Not seen on any day</CrmPill> : null}
              </>
            }
            title={entry.name}
          />
        ))}
      </CrmCardsOnPhone>
    </>
  );
}

function WeekView({
  days,
  judged,
  matches,
  onOpenPerson,
}: {
  days: FieldAbsenceDay[];
  judged: boolean;
  matches: (entry: FieldAbsenceEntry) => boolean;
  onOpenPerson: (key: string, date: string | null) => void;
}) {
  return (
    <div className="divide-y divide-slate-200 border-t border-slate-200">
      {days.map((day) => {
        const names = day.notSeen.filter(matches);
        return (
          <section className="min-w-0" key={day.date}>
            <div
              className={cn(
                "flex min-w-0 flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5",
                day.kind === "working" ? "bg-white" : "bg-slate-50",
              )}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className={cn("text-sm font-black", day.kind === "working" ? "text-slate-950" : "text-slate-500")}>{dayLabelLong(day.date)}</h3>
                <DayTags day={day} />
              </div>
              <span className={cn("text-xs font-black", day.kind === "working" && judged && day.notSeen.length > 0 ? "text-rose-700" : "text-slate-500")}>
                {dayStatusText(day, judged)}
              </span>
            </div>
            {names.length > 0 ? <DayList entries={names} onOpenPerson={(key) => onOpenPerson(key, day.date)} /> : null}
          </section>
        );
      })}
    </div>
  );
}

// ── Detail: one row per person ───────────────────────────────────────────────────────────────────────

function datesText(dates: readonly string[]): string {
  return dates.map((date) => dayLabel(date)).join(", ");
}

function lastSeenText(person: FieldAbsencePersonSummary): string {
  if (!person.lastSeen) return "Nothing recorded this period";
  return person.lastSeenLabel ? `${dayLabel(person.lastSeen)} — ${person.lastSeenLabel}` : dayLabel(person.lastSeen);
}

function DetailView({
  onOpenPerson,
  people,
  seenEveryDay,
}: {
  onOpenPerson: (key: string) => void;
  people: FieldAbsencePersonSummary[];
  seenEveryDay: number;
}) {
  return (
    <div className="min-w-0 border-t border-slate-200">
      {people.length === 0 ? (
        <CrmEmpty message="Nobody matches, or everyone on a field seat was seen on every working day of this month." title="Nobody to list" />
      ) : (
        <>
          <CrmTable columns={["30%", "16%", "34%", "20%"]}>
            <thead>
              <tr>
                <th className={crmThClassName}>Person</th>
                <th className={crmThClassName}>Not seen</th>
                <th className={crmThClassName}>The days</th>
                <th className={crmThClassName}>Last record</th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.key}>
                  <td className={crmTdClassName}>
                    <button
                      className="break-words text-left font-black text-slate-950 underline decoration-slate-300 underline-offset-4 hover:decoration-orange-500"
                      onClick={() => onOpenPerson(person.key)}
                      type="button"
                    >
                      {person.name}
                    </button>
                    <span className="mt-1 flex flex-wrap gap-1">
                      <CrmPill>{person.tierLabel}</CrmPill>
                      {person.wholePeriod ? <CrmPill tone="bad">Not seen on any day</CrmPill> : null}
                    </span>
                    <span className="mt-1 block text-xs font-semibold text-slate-500">{placeText(person)}</span>
                    <span className="block text-xs font-semibold text-slate-500">Manager: {person.managerName ?? "no manager seat above"}</span>
                  </td>
                  <td className={crmTdClassName}>
                    <span className="block text-base font-black text-rose-700">{countText(person.notSeenDates.length)}</span>
                    <span className="block text-xs font-semibold text-slate-500">of {plural(person.expectedDays, "working day", "working days")}</span>
                    <span className="mt-1 block text-xs font-semibold text-slate-500">Longest run: {plural(person.longestRun, "day", "days")}</span>
                  </td>
                  <td className={crmTdClassName}>{datesText(person.notSeenDates)}</td>
                  <td className={crmTdClassName}>{lastSeenText(person)}</td>
                </tr>
              ))}
            </tbody>
          </CrmTable>
          <CrmCardsOnPhone>
            {people.map((person) => (
              <CrmCard
                accent={person.wholePeriod ? "border-l-rose-500" : "border-l-orange-400"}
                actions={
                  <CrmButton onClick={() => onOpenPerson(person.key)} size="sm">
                    What was checked
                  </CrmButton>
                }
                key={person.key}
                meta={`${placeText(person)} · Manager: ${person.managerName ?? "no manager seat above"}`}
                status={
                  <>
                    <CrmPill>{person.tierLabel}</CrmPill>
                    {person.wholePeriod ? <CrmPill tone="bad">Not seen on any day</CrmPill> : null}
                  </>
                }
                title={person.name}
              >
                <CrmFacts
                  facts={[
                    { label: "Not seen", value: `${countText(person.notSeenDates.length)} of ${plural(person.expectedDays, "working day", "working days")}` },
                    { label: "Longest run", value: plural(person.longestRun, "day", "days") },
                    { label: "Last record", value: lastSeenText(person) },
                    { label: "The days", value: datesText(person.notSeenDates) },
                  ]}
                />
              </CrmCard>
            ))}
          </CrmCardsOnPhone>
        </>
      )}
      {seenEveryDay > 0 ? (
        <p className="border-t border-slate-100 px-4 py-3 text-xs font-semibold text-slate-500 sm:px-5">
          {plural(seenEveryDay, "other person was", "other people were")} seen on every working day they were expected.
        </p>
      ) : null}
    </div>
  );
}

// ── The person opened from any view ─────────────────────────────────────────────────────────────────

function PersonPanel({
  date,
  judged,
  onClose,
  person,
  today,
}: {
  date: string | null;
  judged: boolean;
  onClose: () => void;
  person: FieldAbsencePersonSummary;
  /** The Cairo day the server judged as today. */
  today: string;
}) {
  const sources = SOURCES.map((source) => FIELD_ABSENCE_SOURCE_LABELS[source]);
  const notSeenThatDay = date ? person.notSeenDates.includes(date) || (date === today && person.notSeenToday) : false;
  return (
    <CrmPanel
      actions={
        <CrmButton onClick={onClose} size="sm" variant="ghost">
          <X aria-hidden className="h-4 w-4" />
          Close
        </CrmButton>
      }
      description={`${person.tierLabel} · ${placeText(person)} · Manager: ${person.managerName ?? "no manager seat above"}`}
      eyebrow="What was checked"
      title={person.name}
    >
      <div className="grid min-w-0 gap-3 px-4 py-4 sm:px-5">
        {!judged ? (
          <CrmNote tone="bad">This period could not be judged, so nothing is said about this person.</CrmNote>
        ) : date && notSeenThatDay ? (
          <CrmNote tone="warn" title={dayLabelLong(date)}>
            Nothing was recorded for this person in the {listText(sources)}
            {date === today ? ", so far today" : ""}.
          </CrmNote>
        ) : null}
        <CrmFacts
          facts={[
            { label: "Working days judged", value: countText(person.expectedDays) },
            { label: "Not seen", value: countText(person.notSeenDates.length) },
            { label: "Longest run in a row", value: plural(person.longestRun, "day", "days") },
            { label: "Last record", value: lastSeenText(person) },
          ]}
        />
        {person.notSeenDates.length > 0 ? (
          <div className="min-w-0">
            <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Not seen on</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {person.notSeenDates.map((day) => (
                <CrmPill key={day} tone={day === date ? "orange" : "neutral"}>
                  {dayLabel(day)}
                </CrmPill>
              ))}
            </div>
          </div>
        ) : null}
        <p className="text-xs font-semibold leading-5 text-slate-500">
          A day counts as seen when any one of these holds a record for it: the {listText(sources)}. A weekly plan never counts.
        </p>
      </div>
    </CrmPanel>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────────────────────────

export function FieldAbsenceCalendarView({ basePath, data }: { basePath: string; data: FieldAbsencePageData }) {
  const router = useRouter();
  const { calendar, period } = data;
  const [search, setSearch] = useState("");
  const [hideSelf, setHideSelf] = useState(false);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [openPerson, setOpenPerson] = useState<{ key: string; date: string | null } | null>(null);
  const focusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (openPerson || openDay) focusRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [openPerson, openDay]);

  const hidden = hideSelf && data.viewerKey ? data.viewerKey : null;

  const { days, people } = useMemo(() => {
    if (!hidden) return { days: calendar.days, people: calendar.people };
    const hiddenPerson = calendar.people.find((person) => person.key === hidden);
    const judgedOn = new Set(hiddenPerson?.judgedDates ?? []);
    // Today is not a judged day, but he still sits in today's "so far" count.
    const countedOn = (day: { date: string; provisional: boolean }) =>
      judgedOn.has(day.date) || (day.provisional && hiddenPerson?.expectedToday === true);
    return {
      days: calendar.days.map((day) => ({
        ...day,
        expected: day.expected - (countedOn(day) ? 1 : 0),
        notSeen: day.notSeen.filter((entry) => entry.key !== hidden),
      })),
      people: calendar.people.filter((person) => person.key !== hidden),
    };
  }, [calendar, hidden]);

  const needle = search.trim().toLowerCase();
  const matches = (entry: { name: string }) => !needle || entry.name.toLowerCase().includes(needle);

  const peopleByKey = useMemo(() => new Map(people.map((person) => [person.key, person])), [people]);
  const notSeenPeople = people.filter((person) => person.notSeenDates.length > 0);
  const wholePeriodPeople = people.filter((person) => person.wholePeriod);
  const today = days.find((day) => day.date === calendar.today && day.kind === "working");
  const lastFinished = [...days].reverse().find((day) => day.kind === "working" && !day.provisional);
  const headlineDay = today ?? lastFinished ?? null;
  const personDays = days.reduce((sum, day) => sum + day.notSeen.length, 0);

  const viewQuery = (view: FieldAbsenceView, line: string | null) =>
    view === "week"
      ? { line, view, week: period.weekStart }
      : { line, month: period.month, view: view === "month" ? null : view };
  const shiftHref = (direction: "previous" | "next") =>
    hrefFor(
      basePath,
      period.view === "week"
        ? { line: data.line, view: "week", week: period[direction].week }
        : { line: data.line, month: period[direction].month, view: period.view === "month" ? null : period.view },
    );
  const currentHref = hrefFor(basePath, { line: data.line, view: period.view === "month" ? null : period.view });
  const periodTitle = period.view === "week" ? `${dayLabel(period.start)} – ${dayLabel(period.end)}` : monthLabel(period.month);
  const holdsToday = calendar.today >= period.start && calendar.today <= period.end;

  if (data.scope === "none") {
    return (
      <CrmPanel>
        <CrmEmpty
          message="The calendar shows the line of the National Sales Manager seat you hold in the organogram, and no such seat is held under your name."
          title="No line to show"
        />
      </CrmPanel>
    );
  }

  const openPersonSummary = openPerson ? peopleByKey.get(openPerson.key) ?? null : null;
  const openDayRow = openDay ? days.find((day) => day.date === openDay) ?? null : null;

  let focus: ReactNode = null;
  if (openPersonSummary) {
    focus = (
      <PersonPanel
        date={openPerson?.date ?? null}
        judged={calendar.judged}
        onClose={() => setOpenPerson(null)}
        person={openPersonSummary}
        today={calendar.today}
      />
    );
  } else if (openDayRow) {
    focus = (
      <CrmPanel
        actions={
          <CrmButton onClick={() => setOpenDay(null)} size="sm" variant="ghost">
            <X aria-hidden className="h-4 w-4" />
            Close
          </CrmButton>
        }
        description={dayStatusText(openDayRow, calendar.judged)}
        eyebrow="One day"
        title={dayLabelLong(openDayRow.date)}
      >
        <DayList
          entries={openDayRow.notSeen.filter(matches)}
          onOpenPerson={(key) => {
            setOpenDay(null);
            setOpenPerson({ date: openDayRow.date, key });
          }}
        />
      </CrmPanel>
    );
  }

  return (
    <div className="grid min-w-0 gap-4">
      <CrmPanel>
        <div className="grid min-w-0 gap-3 px-4 py-4 sm:px-5">
          <CrmChoice<FieldAbsenceView>
            label="View"
            onChange={(view) => router.push(hrefFor(basePath, viewQuery(view, data.line)))}
            options={[
              { label: "Month", note: "Every day of the month", value: "month" },
              { label: "Week", note: "Saturday to Friday, in full", value: "week" },
              { label: "Detail", note: "One row per person", value: "detail" },
            ]}
            value={period.view}
          />
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Link aria-label="Previous period" className={linkButtonClassName} href={shiftHref("previous")}>
                <ChevronLeft aria-hidden className="h-4 w-4" />
                Previous
              </Link>
              <h2 className="min-w-0 break-words px-1 text-lg font-black text-slate-950">{periodTitle}</h2>
              <Link aria-label="Next period" className={linkButtonClassName} href={shiftHref("next")}>
                Next
                <ChevronRight aria-hidden className="h-4 w-4" />
              </Link>
            </div>
            {holdsToday ? null : (
              <Link className={linkButtonClassName} href={currentHref}>
                {period.view === "week" ? "This week" : "This month"}
              </Link>
            )}
          </div>
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            <CrmSearchField id="field-absence-search" label="Find a name" onChange={setSearch} placeholder="Type part of a name" value={search} />
            {data.lines.length > 1 ? (
              <CrmField htmlFor="field-absence-line" label="Line">
                <CrmSelect
                  id="field-absence-line"
                  onChange={(event) => router.push(hrefFor(basePath, viewQuery(period.view, event.target.value || null)))}
                  value={data.line ?? ""}
                >
                  <option value="">Every line</option>
                  {data.lines.map((line) => (
                    <option key={line.code} value={line.code}>
                      {line.name}
                    </option>
                  ))}
                </CrmSelect>
              </CrmField>
            ) : null}
          </div>
          {data.viewerKey ? (
            <CrmCheck checked={hideSelf} onChange={setHideSelf}>
              Hide myself and show only my line&apos;s team
            </CrmCheck>
          ) : null}
        </div>
      </CrmPanel>

      {!calendar.judged ? (
        <CrmNote title="Nobody is listed: a source could not be read" tone="bad">
          The {listText(calendar.unreadable.map((source) => FIELD_ABSENCE_SOURCE_LABELS[source]))} could not be read just now, so the
          calendar cannot say who was not seen. Reload the page in a few minutes.
        </CrmNote>
      ) : null}
      {!calendar.holidaysComplete ? (
        <CrmNote tone="warn">
          The national holiday calendar could not be read in full, so a holiday may show here as a working day with names in it.
        </CrmNote>
      ) : null}
      {days.some((day) => day.provisional) ? (
        <CrmNote tone="info">
          Today is shown so far: a name drops off the moment any record arrives, and the day is final tomorrow morning.
        </CrmNote>
      ) : null}

      <CrmStatGrid>
        <CrmStat
          label={today ? "Not seen today, so far" : "Not seen on the last working day"}
          note={headlineDay ? `${dayLabel(headlineDay.date)} · of ${countText(headlineDay.expected)} expected` : "No working day yet"}
          tone={headlineDay && calendar.judged && headlineDay.notSeen.length > 0 ? "bad" : "neutral"}
          value={headlineDay && calendar.judged ? countText(headlineDay.notSeen.length) : "—"}
        />
        <CrmStat
          label="Days not seen"
          note="One person on one working day counts once"
          value={calendar.judged ? countText(personDays) : "—"}
        />
        <CrmStat
          label="People not seen at least once"
          note={`Of ${plural(people.length, "person", "people")} on a field seat`}
          value={calendar.judged ? countText(notSeenPeople.length) : "—"}
        />
        <CrmStat
          label="Not seen on any working day"
          note="Three finished working days or more"
          tone={wholePeriodPeople.length > 0 ? "bad" : "neutral"}
          value={calendar.judged ? countText(wholePeriodPeople.length) : "—"}
        />
      </CrmStatGrid>

      {wholePeriodPeople.length > 0 ? (
        <CrmNote title="Not seen on any working day of this period" tone="warn">
          <span className="block">
            Usually a CRM login that is not linked to the employee record, or a long absence nobody recorded. They are also listed in every
            box below.
          </span>
          <span className="mt-2 flex flex-wrap gap-1.5">
            {wholePeriodPeople.map((person) => (
              <button
                className="rounded-none border border-amber-300 bg-white px-2 py-1 text-left text-xs font-black text-amber-900 hover:border-amber-400"
                key={person.key}
                onClick={() => setOpenPerson({ date: null, key: person.key })}
                type="button"
              >
                {person.name} · {person.tierLabel}
              </button>
            ))}
          </span>
        </CrmNote>
      ) : null}

      <div className="min-w-0 scroll-mt-4" ref={focusRef}>
        {focus}
      </div>

      <CrmPanel
        description={
          period.view === "detail"
            ? "Everyone not seen on at least one working day, most days first. Open a name for what was checked."
            : "Each box lists the people the system did not see at all that day. Open a name for what was checked."
        }
        title={period.view === "detail" ? "Who was not seen, and when" : "Who was not seen"}
      >
        {period.view === "month" ? (
          <div className="px-2 pb-3 sm:px-3">
            <MonthView
              days={days}
              judged={calendar.judged}
              matches={matches}
              onOpenDay={(date) => {
                setOpenPerson(null);
                setOpenDay(date);
              }}
              onOpenPerson={(key, date) => {
                setOpenDay(null);
                setOpenPerson({ date, key });
              }}
            />
          </div>
        ) : period.view === "week" ? (
          <WeekView days={days} judged={calendar.judged} matches={matches} onOpenPerson={(key, date) => setOpenPerson({ date, key })} />
        ) : (
          <DetailView
            onOpenPerson={(key) => setOpenPerson({ date: null, key })}
            people={notSeenPeople.filter(matches)}
            seenEveryDay={people.length - notSeenPeople.length}
          />
        )}
      </CrmPanel>
    </div>
  );
}
