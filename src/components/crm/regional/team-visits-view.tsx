import Link from "next/link";

import { KpiSection, KpiTile } from "@/components/crm/kpis-chrome";
import {
  TeamVisitsAttentionPanel,
  TeamVisitsHoursPanel,
  TeamVisitsJumpList,
  TeamVisitsManagersPanel,
  TeamVisitsPacePanel,
  TeamVisitsRollupPanel,
  TeamVisitsToolbar,
} from "@/components/crm/regional/team-visits-panels";
import { cairoDate, utcDate } from "@/lib/format/cairo-datetime";
import { regionGroupCaption, regionManagerTitle } from "@/lib/phoenix-crm/region-manager-groups";
import type { TeamVisitDay, TeamVisitDistrict, TeamVisitManagerDay, TeamVisitRep, TeamVisitsReport } from "@/lib/phoenix-crm/server/team-visits";
import {
  filterTeamVisitReps,
  repsWord,
  sortTeamVisitReps,
  TEAM_VISIT_ORIGIN_EDGE,
  TEAM_VISIT_ORIGIN_INK,
  TEAM_VISIT_ORIGIN_LABEL,
  TEAM_VISIT_PHONE_FOLD,
  teamVisitDistanceText,
  teamVisitNonWorkingNotice,
  teamVisitRepAnchor,
  TEAM_VISIT_SHOW_LABEL,
  TEAM_VISITS_NO_TIME,
  teamVisitDayHeading,
  teamVisitDayStrip,
  teamVisitDistrictAnchor,
  teamVisitPace,
  teamVisitRepPace,
  TEAM_VISIT_STRIP_TICKS,
  teamVisitTeamRollup,
  teamVisitTimeline,
  teamVisitTimelineLine,
  teamVisitWaitingLine,
  type TeamVisitDayKey,
  type TeamVisitShow,
  type TeamVisitSort,
} from "@/lib/phoenix-crm/server/team-visits-summary";

/**
 * Visits — Yesterday and Today, the Regional Sales Manager's screen. Server-rendered: the page holds no client
 * state and the figures are read on every load. One section per region and its district manager, one row per rep, the two days
 * side by side; on a phone each rep is a card. AM · PM · Pharmacies are always three figures apart.
 *
 * The premium pass (owner, 9 Nov 2026: "eyeball every report in My Team's Reports, premium polish big work, every
 * single component"): a filter and the Excel download on top, four tiles, the teams side by side, when the visits
 * were saved, and the reps to look at — every figure from `team-visits-summary.ts`, the arithmetic the rows and the
 * file read. Each day's square adds the first and last saved time, and tags the visits still waiting for
 * validation, so the "waiting" figure points at real rows. A vacant seat keeps its row in a light colour of its own
 * and says it is vacant, never a row of zeros.
 */

/**
 * A district manager's own row wears a colour of its own so he never reads as one of the reps (owner, 2026-11-09:
 * "highlight managers different color than reps") — a flat blue ground and a 3px blue rule on its left edge. The
 * reps' rows stay white.
 */
const MANAGER_ROW = "border-l-[3px] border-l-sky-700 bg-sky-50";
const MANAGER_NAME = "text-phx-md font-black text-sky-900";
const MANAGER_NOTE = "text-phx-sm font-semibold text-sky-800";

/**
 * A vacant seat — a rep seat or a district manager seat with nobody in it — wears a light colour of its own (owner,
 * 2026-11-09: "if a seat a vacant color in light color"): a flat pale amber ground, the name in amber.
 */
const VACANT_ROW = "bg-amber-50";
const VACANT_NAME = "text-phx-md font-black text-amber-800";

/** "Hired 1 Nov 2026", the KPIs pages' own words (owner, 2026-11-09: "also show hiring date"); nothing when unknown. */
function Hired({ dates }: { dates: ReadonlyArray<string | null> }) {
  const shown = dates.flatMap((date) => (date && /^\d{4}-\d{2}-\d{2}/.test(date) ? [utcDate(date.slice(0, 10))] : []));
  if (shown.length === 0) return null;
  return <p className="text-phx-sm tabular-nums text-slate-500">Hired {shown.join(" · ")}</p>;
}

function dayLabel(iso: string): string {
  return cairoDate(`${iso}T12:00:00Z`);
}

/**
 * The three figures as three counted boxes, AM · PM · Pharmacies apart (the golden rule). "2 AM · 10 PM" printed on
 * one line read as two clock times beside the saved times under it, so each count sits under its own label. A zero
 * is drawn pale so the figures that are there stand out.
 */
const FIGURE_CELLS = [
  { key: "am", label: "AM" },
  { key: "pm", label: "PM" },
  { key: "pharmacies", label: "Pharmacies" },
] as const;

function Figures({ day }: { day: TeamVisitDay }) {
  const waiting = teamVisitWaitingLine(day.waiting);
  return (
    <div>
      <dl className="grid w-full max-w-[22rem] grid-cols-3 border border-slate-200 bg-white">
        {FIGURE_CELLS.map((cell, index) => {
          const value = day[cell.key];
          return (
            <div className={`min-w-0 px-2 py-1 ${index > 0 ? "border-l border-slate-200" : ""}`} key={cell.key}>
              <dt className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">{cell.label}</dt>
              <dd className={`text-phx-lg font-black leading-tight tabular-nums ${value === 0 ? "text-slate-300" : "text-slate-900"}`}>{value}</dd>
            </div>
          );
        })}
      </dl>
      {waiting ? <p className="mt-1 text-phx-sm font-semibold text-amber-800">{waiting}</p> : null}
    </div>
  );
}

/** The first and the last saved time, and the stretch between — a copied visit with no time is said apart. */
function Timeline({ day }: { day: TeamVisitDay }) {
  const timeline = teamVisitTimeline(day);
  const line = teamVisitTimelineLine(timeline);
  if (!line && timeline.untimed === 0) return null;
  return (
    <p className="mt-0.5 text-phx-sm tabular-nums text-slate-500">
      {line}
      {line && timeline.untimed > 0 ? " · " : ""}
      {timeline.untimed > 0 ? `${timeline.untimed} copied, ${TEAM_VISITS_NO_TIME.toLowerCase()}` : ""}
    </p>
  );
}

const TIME_GROUPS: ReadonlyArray<{ list: TeamVisitDay["times"][number]["list"]; label: string }> = [
  { label: "AM", list: "AM" },
  { label: "PM", list: "PM" },
  { label: "Pharmacies", list: "Pharmacy" },
];

/**
 * Each visit as its time and the customer beside it, grouped AM · PM · Pharmacies inside the day's square, earliest
 * first (owner, 2026-11-09: "in the same square gp by am/pm put customer name and beside the visit time sort
 * ascending"). The loader already sorts by the saved instant; a copied old-CRM visit has none and comes last.
 */
function Times({ day }: { day: TeamVisitDay }) {
  if (day.times.length === 0) return <p className="mt-1.5 text-phx-sm text-slate-400">No visits saved</p>;
  return (
    <div className="mt-2 grid gap-2">
      {TIME_GROUPS.map((group) => {
        const times = day.times.filter((time) => time.list === group.list);
        if (times.length === 0) return null;
        return (
          <div key={group.list}>
            <p className="flex items-baseline justify-between border-b border-slate-200 pb-0.5 text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
              <span>{group.label}</span>
              <span className="tabular-nums text-slate-400">{times.length}</span>
            </p>
            <ul className="divide-y divide-slate-100 border-x border-b border-slate-200">
              {times.map((time, index) => (
                <VisitLine key={index} time={time} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One saved visit: the time, the customer, and the metres in a column of their own on the right. The customer's
 * name is bidi-isolated — an Arabic name beside "30 m" pulled the number into the Arabic run and printed it on the
 * wrong side. The left edge carries the colour (planned, unplanned, logged by admin); the word is printed only for
 * the two that are not the usual planned visit, so the exceptions are the words on the square.
 */
function VisitLine({ time }: { time: TeamVisitDay["times"][number] }) {
  const distance = teamVisitDistanceText(time);
  const metres = typeof time.metres === "number" ? time.metres : null;
  const note = metres === null ? distance : null;
  const tagged = time.origin !== "planned";
  return (
    <li
      className={`grid grid-cols-[4.75rem_minmax(0,1fr)_auto] items-baseline gap-x-2 border-l-[3px] px-2 py-1 ${TEAM_VISIT_ORIGIN_EDGE[time.origin]} ${time.waiting ? "bg-amber-50" : "bg-white"}`}
    >
      <span className="text-phx-xs font-semibold tabular-nums text-slate-500">{time.savedAt ?? "No time recorded"}</span>
      <span className="min-w-0">
        <span className="block break-words text-phx-sm font-semibold text-slate-900">
          <bdi>{time.customer ?? "Customer not recorded"}</bdi>
        </span>
        {tagged || note || time.waiting ? (
          <span className="flex flex-wrap gap-x-2 text-phx-xs">
            {tagged ? <span className={`font-black uppercase tracking-[0.08em] ${TEAM_VISIT_ORIGIN_INK[time.origin]}`}>{TEAM_VISIT_ORIGIN_LABEL[time.origin]}</span> : null}
            {time.waiting ? <span className="font-black uppercase tracking-[0.08em] text-amber-800">Waiting for validation</span> : null}
            {note ? <span className="font-semibold text-slate-400">{note}</span> : null}
          </span>
        ) : null}
      </span>
      <span className="text-right text-phx-xs font-black tabular-nums text-slate-700" title={distance ?? undefined}>
        {metres !== null ? (
          <>
            {metres.toLocaleString("en-US")} m<span className="sr-only"> from the live photo</span>
          </>
        ) : null}
      </span>
    </li>
  );
}

/**
 * The district manager's count — the total of his reps' visits that day (owner, 2026-11-09), first in his row and
 * above his own visits, which stay apart.
 */
function RepsTotal({ day }: { day: TeamVisitDay }) {
  return (
    <div className="mb-2 grid gap-1 border-b border-sky-200 pb-2">
      <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-sky-800">All reps together · {day.am + day.pm} doctor visits</p>
      <Figures day={day} />
    </div>
  );
}

/**
 * Was the district manager's day double or single — double with whom, single where (owner, 2026-11-09). Read from
 * his own week; a week not sent yet says so, because the day may still change.
 */
function ManagerDayPlan({ day }: { day: TeamVisitManagerDay }) {
  return (
    <div className="mb-2 border-b border-sky-200 pb-2">
      <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-sky-800">Day planned · {day.headline}</p>
      {day.halves.map((line) => (
        <p className="break-words text-phx-sm font-semibold text-slate-900" key={line}>{line}</p>
      ))}
      {day.unsent ? <p className="text-phx-sm font-semibold text-amber-700">Plan not sent yet · {day.unsent}</p> : null}
    </div>
  );
}

function OwnLabel() {
  return <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-sky-800">Visits made alone · not added to any rep</p>;
}

/**
 * Leave and a recorded day activity (Admin work, Training…) are printed INSTEAD of visits (owner, 2026-11-09: "if a
 * day for dm or rep has admin work put it instead of visits and if vacation put it"). A day with visits as well —
 * a half-day leave, a half-day meeting — prints both, the day's reason first.
 */
function Away({ lines }: { lines: readonly string[] }) {
  return (
    <div className="grid gap-0.5">
      {lines.map((line) => (
        <p className="break-words border-l-[3px] border-l-violet-700 bg-violet-50 px-1.5 py-0.5 text-phx-md font-black text-violet-900" key={line}>
          {line}
        </p>
      ))}
    </div>
  );
}

/**
 * The district manager's own visits that day — the three figures and the times when there are any, one quiet line
 * when there are none (a row of "0 AM · 0 PM · 0 Pharmacies" over "No visits saved" said the same thing twice).
 */
function OwnDay({ day }: { day: TeamVisitDay }) {
  if (day.times.length === 0 && day.am + day.pm + day.pharmacies === 0) {
    return <p className="text-phx-sm font-semibold text-sky-800">Visits made alone · none saved</p>;
  }
  // The manager's leave or day activity heads the cell already, so it is not printed a second time here.
  return (
    <>
      <OwnLabel />
      <DayCell day={{ ...day, away: [] }} href={null} />
    </>
  );
}

/**
 * The rep's day on one line, 7 AM to midnight: a mark per saved visit at the time it was saved — AM deep blue, PM
 * mid blue, a pharmacy slate, a visit waiting for validation amber. Flat marks on a flat track; positions, not a score.
 */
const STRIP_MARK: Record<TeamVisitDay["times"][number]["list"], string> = { AM: "bg-sky-900", PM: "bg-sky-500", Pharmacy: "bg-slate-500" };

function DayStrip({ day }: { day: TeamVisitDay }) {
  const strip = teamVisitDayStrip(day);
  if (strip.marks.length === 0) return null;
  return (
    <div aria-hidden className="mt-1.5">
      <div className="relative h-3 border border-slate-200 bg-slate-50">
        {strip.marks.map((mark, index) => (
          <span
            className={`absolute inset-y-0 w-[3px] -translate-x-1/2 ${mark.waiting ? "bg-amber-500" : STRIP_MARK[mark.list]}`}
            key={index}
            style={{ left: `${mark.left}%` }}
            title={mark.savedAt ?? undefined}
          />
        ))}
      </div>
      <div className="relative h-3">
        {TEAM_VISIT_STRIP_TICKS.map((tick) => (
          <span className="absolute -translate-x-1/2 text-phx-xs tabular-nums text-slate-400" key={tick.label} style={{ left: `${tick.left}%` }}>
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Today's square only: what the rep had saved yesterday by this same time, so a day still running reads fairly. */
function RepPaceLine({ pace }: { pace: { today: number; yesterdayBy: number } | null }) {
  if (!pace) return null;
  return (
    <p className="mt-0.5 text-phx-sm tabular-nums text-slate-500">
      Yesterday by this time · {pace.yesterdayBy} saved
    </p>
  );
}

/**
 * A phone card's list of visits, folded behind one line when the day is long — a native `<details>`, so it opens
 * without any script and the times are still in the page for a screen reader.
 */
function FoldedTimes({ day }: { day: TeamVisitDay }) {
  if (day.times.length <= TEAM_VISIT_PHONE_FOLD) return <Times day={day} />;
  return (
    <details className="mt-1.5 border border-slate-200 bg-white">
      <summary className="cursor-pointer px-2 py-1 text-phx-sm font-black uppercase tracking-[0.1em] text-slate-700">Show the {day.times.length} visits</summary>
      <div className="px-2 pb-2">
        <Times day={day} />
      </div>
    </details>
  );
}

function DayCell({ day, fold = false, href, pace = null }: { day: TeamVisitDay; fold?: boolean; href: string | null; pace?: { today: number; yesterdayBy: number } | null }) {
  const away = day.away ?? [];
  const worked = day.am + day.pm + day.pharmacies + day.waiting > 0 || day.times.length > 0;
  if (away.length > 0 && !worked) {
    return (
      <div className="min-w-0">
        <Away lines={away} />
      </div>
    );
  }
  return (
    <div className="min-w-0">
      {away.length > 0 ? <Away lines={away} /> : null}
      <Figures day={day} />
      <Timeline day={day} />
      <RepPaceLine pace={pace} />
      {href ? <DayStrip day={day} /> : null}
      {fold ? <FoldedTimes day={day} /> : <Times day={day} />}
      {href && day.times.length > 0 ? (
        <Link
          className="mt-2 inline-block border border-slate-300 bg-white px-2.5 py-1 text-phx-xs font-black uppercase tracking-[0.1em] text-slate-800 hover:border-slate-900 hover:bg-slate-50"
          href={href}
        >
          Open the day →
        </Link>
      ) : null}
    </div>
  );
}

/**
 * A district manager's cell, one day, on the desktop row and the phone card alike: the day's leave or recorded
 * activity first, then the day planned (double with whom, single where), the reps all together, and the visits the
 * manager made alone, apart.
 */
function ManagerCells({ district, day }: { district: TeamVisitDistrict; day: TeamVisitDayKey }) {
  const away = district.managerOwn?.[day].away ?? [];
  return (
    <>
      {away.length ? <div className="mb-2"><Away lines={away} /></div> : null}
      {district.managerDay ? (day === "today" ? <ManagerDayPlan day={district.managerDay.today} /> : <ManagerDayPlan day={district.managerDay.yesterday} />) : null}
      {day === "today" ? <RepsTotal day={district.repsTotal.today} /> : <RepsTotal day={district.repsTotal.yesterday} />}
      {district.managerOwn ? <OwnDay day={district.managerOwn[day]} /> : null}
    </>
  );
}

/** What a vacant seat's row says in place of the two days — there is no rep, so there is nothing to count. */
const TEAM_VISIT_VACANT_CELL = "Seat is vacant · nobody to count on either day";

/** A team's vacant seats, by territory, for the light-coloured rows after the reps. */
function teamVisitVacantRows(reps: readonly TeamVisitRep[]): TeamVisitRep[] {
  return reps.filter((rep) => rep.vacant).sort((left, right) => left.territory.localeCompare(right.territory));
}

const MANAGER_NOTE_TEXT = "District manager";
const DAY_HEAD = "text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500";

export function TeamVisitsView({
  day = "yesterday",
  nowIso = null,
  report,
  show = "all",
  sort = "territory",
}: {
  day?: TeamVisitDayKey;
  /** The time the page was read; the pace panel and each rep's "by this time" read against it. */
  nowIso?: string | null;
  report: TeamVisitsReport;
  show?: TeamVisitShow;
  /** The order of the reps inside each team, judged on `day`. */
  sort?: TeamVisitSort;
}) {
  const yesterday = dayLabel(report.yesterday);
  const today = dayLabel(report.today);
  // `from=team-visits` gives the day page its "Back to all reps" bar, back to this screen.
  const dayHref = (seatId: string, on: string) => `/employee-portals/field-crm/day/${encodeURIComponent(seatId)}/${on}?from=team-visits`;
  const team = { today: teamVisitTeamRollup(report, "today"), yesterday: teamVisitTeamRollup(report, "yesterday") };
  const filtered = show !== "all";
  const notWorking = teamVisitNonWorkingNotice(report);
  // "By this time" is only fair while today's visit day is running; the pace panel says the same thing for the team.
  const running = nowIso && teamVisitPace(report, nowIso) ? nowIso : null;
  const paceOf = (rep: TeamVisitsReport["districts"][number]["reps"][number]) => (running ? teamVisitRepPace(rep, report, running) : null);
  return (
    <div className="grid gap-4">
      <TeamVisitsToolbar day={day} report={report} show={show} sort={sort} />
      {notWorking ? <p className="border border-sky-200 bg-sky-50 px-4 py-2 text-phx-sm font-semibold text-sky-900">{notWorking}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          caption={`${report.totals.yesterday.am} AM · ${report.totals.yesterday.pm} PM · ${report.totals.yesterday.pharmacies} Pharmacies`}
          label={`Yesterday · ${yesterday}`}
          value={String(report.totals.yesterday.am + report.totals.yesterday.pm)}
        />
        <KpiTile
          caption={`${report.totals.today.am} AM · ${report.totals.today.pm} PM · ${report.totals.today.pharmacies} Pharmacies`}
          label={`Today so far · ${today}`}
          value={String(report.totals.today.am + report.totals.today.pm)}
        />
        <KpiTile
          caption={`${team.yesterday.repsWithNone} saved none yesterday · ${team.today.repsWithVisits} saved one today so far`}
          label="Reps who saved a visit yesterday"
          value={`${team.yesterday.repsWithVisits} of ${team.yesterday.reps}`}
        />
        <KpiTile
          caption={`${team.yesterday.waiting} yesterday · ${team.today.waiting} today — real visits, in none of the figures until validated`}
          label="Waiting for validation"
          value={String(team.yesterday.waiting + team.today.waiting)}
        />
      </div>
      {nowIso ? <TeamVisitsPacePanel nowIso={nowIso} report={report} /> : null}
      <TeamVisitsRollupPanel report={report} />
      <TeamVisitsHoursPanel report={report} />
      <TeamVisitsManagersPanel report={report} />
      <TeamVisitsAttentionPanel day={day} report={report} show={show} />
      <TeamVisitsJumpList report={report} />
      {report.leaveUnread || report.activitiesUnread ? (
        <p className="border border-amber-300 bg-amber-50 p-3 text-phx-md font-semibold text-amber-900">
          {report.leaveUnread ? "Approved leave could not be read just now, so a day on leave may show as no visits. " : ""}
          {report.activitiesUnread ? "Recorded admin work and other day activities could not be read just now." : ""}
        </p>
      ) : null}
      {report.districts.length === 0 ? (
        <p className="border border-slate-200 bg-white p-4 text-phx-md text-slate-600">No reps on your team yet.</p>
      ) : null}
      {report.districts.map((district) => {
        const reps = sortTeamVisitReps(filterTeamVisitReps(district.reps, show, day), sort, day);
        // A vacant seat keeps its row, in its own light colour (owner, 2026-11-09), after the reps and with no
        // figures — never a row of zeros. A filter lists reps only, so it leaves the vacant rows out.
        const vacantRows = filtered ? [] : teamVisitVacantRows(district.reps);
        return (
          <div className="scroll-mt-4 border border-slate-200" id={teamVisitDistrictAnchor(district)} key={`${district.regionName}|${district.districtName}|${district.managerName}`}>
            <KpiSection description={regionGroupCaption(district.reps.length, district.vacantSeats)} title={regionManagerTitle(district.regionName, district.managerName)}>
              {filtered ? (
                <p className="border-b border-slate-200 bg-white px-4 py-2 text-phx-sm text-slate-600">
                  {TEAM_VISIT_SHOW_LABEL[show]} · {teamVisitDayHeading(day).toLowerCase()}: {repsWord(reps.length)} listed. The district manager&apos;s figures are still the whole team&apos;s.
                </p>
              ) : null}
              <table className="hidden w-full table-fixed text-left md:table">
                <colgroup>
                  <col className="w-[26%]" />
                  <col className="w-[37%]" />
                  <col className="w-[37%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
                    <th className="px-4 py-2" scope="col">Rep</th>
                    <th className="px-4 py-2" scope="col">Yesterday · {yesterday}</th>
                    <th className="px-4 py-2" scope="col">Today so far · {today}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className={`border-b border-slate-100 align-top ${district.managerHrId ? MANAGER_ROW : VACANT_ROW}`}>
                    <td className="break-words px-4 py-3">
                      <p className={district.managerHrId ? MANAGER_NAME : VACANT_NAME}>{district.managerName}</p>
                      <Hired dates={[district.managerHireDate]} />
                      <p className={MANAGER_NOTE}>{MANAGER_NOTE_TEXT}</p>
                    </td>
                    <td className="px-4 py-3">
                      <ManagerCells day="yesterday" district={district} />
                    </td>
                    <td className="px-4 py-3">
                      <ManagerCells day="today" district={district} />
                    </td>
                  </tr>
                  {reps.map((rep) => (
                    <tr className="scroll-mt-4 border-b border-slate-100 align-top last:border-b-0" id={teamVisitRepAnchor(rep.seatId, "row")} key={rep.seatId}>
                      <td className="break-words px-4 py-3">
                        <p className="text-phx-md font-black text-slate-900">{rep.person}</p>
                        <Hired dates={rep.hireDates} />
                        <p className="text-phx-sm text-slate-500">{rep.territory}</p>
                      </td>
                      <td className="px-4 py-3"><DayCell day={rep.yesterday} href={dayHref(rep.seatId, report.yesterday)} /></td>
                      <td className="px-4 py-3"><DayCell day={rep.today} href={dayHref(rep.seatId, report.today)} pace={paceOf(rep)} /></td>
                    </tr>
                  ))}
                  {vacantRows.map((rep) => (
                    <tr className={`border-b border-slate-100 align-top last:border-b-0 ${rep.vacant ? VACANT_ROW : ""}`} key={rep.seatId}>
                      <td className="break-words px-4 py-3">
                        <p className={rep.vacant ? VACANT_NAME : "text-phx-md font-black text-slate-900"}>{rep.person}</p>
                        <p className="text-phx-sm text-slate-500">{rep.territory}</p>
                      </td>
                      <td className="px-4 py-3 text-phx-sm font-semibold text-amber-800" colSpan={2}>{TEAM_VISIT_VACANT_CELL}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="grid divide-y divide-slate-100 md:hidden">
                <div className={`grid gap-2 p-4 ${district.managerHrId ? MANAGER_ROW : VACANT_ROW}`}>
                  <div>
                    <p className={district.managerHrId ? MANAGER_NAME : VACANT_NAME}>{district.managerName}</p>
                    <Hired dates={[district.managerHireDate]} />
                    <p className={MANAGER_NOTE}>{MANAGER_NOTE_TEXT}</p>
                  </div>
                  <p className={DAY_HEAD}>Yesterday · {yesterday}</p>
                  <ManagerCells day="yesterday" district={district} />
                  <p className={DAY_HEAD}>Today so far · {today}</p>
                  <ManagerCells day="today" district={district} />
                </div>
                {reps.map((rep) => (
                  <div className="grid scroll-mt-4 gap-2 p-4" id={teamVisitRepAnchor(rep.seatId, "card")} key={rep.seatId}>
                    <div>
                      <p className="text-phx-md font-black text-slate-900">{rep.person}</p>
                      <Hired dates={rep.hireDates} />
                      <p className="text-phx-sm text-slate-500">{rep.territory}</p>
                    </div>
                    <p className={DAY_HEAD}>Yesterday · {yesterday}</p>
                    <DayCell day={rep.yesterday} fold href={dayHref(rep.seatId, report.yesterday)} />
                    <p className={DAY_HEAD}>Today so far · {today}</p>
                    <DayCell day={rep.today} fold href={dayHref(rep.seatId, report.today)} pace={paceOf(rep)} />
                  </div>
                ))}
                {vacantRows.map((rep) => (
                  <div className={`grid gap-1 p-4 ${rep.vacant ? VACANT_ROW : ""}`} key={rep.seatId}>
                    <p className={rep.vacant ? VACANT_NAME : "text-phx-md font-black text-slate-900"}>{rep.person}</p>
                    <p className="text-phx-sm text-slate-500">{rep.territory}</p>
                    <p className="text-phx-sm font-semibold text-amber-800">{TEAM_VISIT_VACANT_CELL}</p>
                  </div>
                ))}
              </div>
              {filtered && reps.length === 0 ? (
                <p className="border-t border-slate-200 bg-white px-4 py-3 text-phx-sm text-slate-500">No rep in this team matches the filter.</p>
              ) : null}
            </KpiSection>
          </div>
        );
      })}
    </div>
  );
}
