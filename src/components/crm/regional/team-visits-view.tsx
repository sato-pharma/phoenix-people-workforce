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
import { cairoDate } from "@/lib/format/cairo-datetime";
import { regionGroupCaption, regionManagerTitle } from "@/lib/phoenix-crm/region-manager-groups";
import type { TeamVisitDay, TeamVisitDistrict, TeamVisitsReport } from "@/lib/phoenix-crm/server/team-visits";
import {
  filterTeamVisitReps,
  repsWord,
  sortTeamVisitReps,
  TEAM_VISIT_PHONE_FOLD,
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
  teamVisitVacantLine,
  teamVisitVacantSeats,
  teamVisitWaitingLine,
  type TeamVisitDayKey,
  type TeamVisitShow,
  type TeamVisitSort,
} from "@/lib/phoenix-crm/team-visits-summary";

/**
 * Visits — Yesterday and Today, the Regional Sales Manager's screen. Server-rendered: the page holds no client
 * state and the figures are read on every load. One section per region and its district manager, one row per rep, the two days
 * side by side; on a phone each rep is a card. AM · PM · Pharmacies are always three figures apart.
 *
 * The premium pass (owner, 9 Nov 2026: "eyeball every report in My Team's Reports, premium polish big work, every
 * single component"): a filter and the Excel download on top, four tiles, the teams side by side, when the visits
 * were saved, and the reps to look at — every figure from `team-visits-summary.ts`, the arithmetic the rows and the
 * file read. Each day's square adds the first and last saved time, and tags the visits still waiting for
 * validation, so the "waiting" figure points at real rows. A vacant seat is one line under its team's heading,
 * never a row of zeros.
 */

/**
 * A district manager's own row wears a colour of its own so he never reads as one of the reps (owner, 2026-11-09:
 * "highlight managers different color than reps") — a flat blue ground and a 3px blue rule on its left edge. The
 * reps' rows stay white.
 */
const MANAGER_ROW = "border-l-[3px] border-l-sky-700 bg-sky-50";
const MANAGER_NAME = "text-phx-xs font-black text-sky-900";
const MANAGER_NOTE = "text-phx-2xs font-semibold text-sky-800";

function dayLabel(iso: string): string {
  return cairoDate(`${iso}T12:00:00Z`);
}

function Figures({ day }: { day: TeamVisitDay }) {
  const waiting = teamVisitWaitingLine(day.waiting);
  return (
    <div>
      <p className="text-phx-xs font-black tabular-nums text-slate-900">
        {day.am} AM · {day.pm} PM · {day.pharmacies} Pharmacies
      </p>
      {waiting ? <p className="text-phx-2xs font-semibold text-amber-800">{waiting}</p> : null}
    </div>
  );
}

/** The first and the last saved time, and the stretch between — a copied visit with no time is said apart. */
function Timeline({ day }: { day: TeamVisitDay }) {
  const timeline = teamVisitTimeline(day);
  const line = teamVisitTimelineLine(timeline);
  if (!line && timeline.untimed === 0) return null;
  return (
    <p className="mt-0.5 text-phx-2xs tabular-nums text-slate-500">
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
  if (day.times.length === 0) return <p className="mt-1 text-phx-2xs text-slate-400">No visits saved</p>;
  return (
    <div className="mt-1.5 grid gap-1.5">
      {TIME_GROUPS.map((group) => {
        const times = day.times.filter((time) => time.list === group.list);
        if (times.length === 0) return null;
        return (
          <div key={group.list}>
            <p className="text-phx-3xs font-black uppercase tracking-[0.1em] text-slate-500">{group.label}</p>
            <ul className="mt-0.5 grid gap-0.5">
              {times.map((time, index) => (
                <li
                  className={`grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 border px-1.5 py-0.5 text-phx-3xs ${time.waiting ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-slate-50"}`}
                  key={index}
                >
                  <span className="font-semibold tabular-nums text-slate-700">{time.savedAt ?? "No time recorded"}</span>
                  <span className="break-words font-semibold text-slate-900">
                    {time.customer ?? "Customer not recorded"}
                    {time.waiting ? <span className="ml-1 font-black uppercase tracking-[0.08em] text-amber-800">· Waiting for validation</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The district manager's count — the total of his reps' visits that day (owner, 2026-11-09), first in his row and
 * above his own visits, which stay apart.
 */
function RepsTotal({ day }: { day: TeamVisitDay }) {
  return (
    <div className="mb-2 border-b border-sky-200 pb-2">
      <p className="text-phx-3xs font-black uppercase tracking-[0.1em] text-sky-800">Reps&apos; total · {day.am + day.pm} doctor visits</p>
      <Figures day={day} />
    </div>
  );
}

function OwnLabel() {
  return <p className="text-phx-3xs font-black uppercase tracking-[0.1em] text-sky-800">Own visits</p>;
}

/**
 * The district manager's own visits that day — the three figures and the times when there are any, one quiet line
 * when there are none (a row of "0 AM · 0 PM · 0 Pharmacies" over "No visits saved" said the same thing twice).
 */
function OwnDay({ day }: { day: TeamVisitDay }) {
  if (day.times.length === 0 && day.am + day.pm + day.pharmacies === 0) {
    return <p className="text-phx-2xs font-semibold text-sky-800">Own visits · none saved</p>;
  }
  return (
    <>
      <OwnLabel />
      <DayCell day={day} href={null} />
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
          <span className="absolute -translate-x-1/2 text-phx-3xs tabular-nums text-slate-400" key={tick.label} style={{ left: `${tick.left}%` }}>
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
    <p className="mt-0.5 text-phx-2xs tabular-nums text-slate-500">
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
      <summary className="cursor-pointer px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-700">Show the {day.times.length} visits</summary>
      <div className="px-2 pb-2">
        <Times day={day} />
      </div>
    </details>
  );
}

function DayCell({ day, fold = false, href, pace = null }: { day: TeamVisitDay; fold?: boolean; href: string | null; pace?: { today: number; yesterdayBy: number } | null }) {
  return (
    <div className="min-w-0">
      <Figures day={day} />
      <Timeline day={day} />
      <RepPaceLine pace={pace} />
      {href ? <DayStrip day={day} /> : null}
      {fold ? <FoldedTimes day={day} /> : <Times day={day} />}
      {href && day.times.length > 0 ? (
        <Link className="mt-1 inline-block text-phx-3xs font-black uppercase tracking-[0.1em] text-orange-700 hover:underline" href={href}>
          Open the day
        </Link>
      ) : null}
    </div>
  );
}

/** A district manager's phone card: the reps' total each day, then the manager's own visits, apart. */
function ManagerCells({ district, day }: { district: TeamVisitDistrict; day: TeamVisitDayKey }) {
  return (
    <>
      <RepsTotal day={district.repsTotal[day]} />
      {district.managerOwn ? <OwnDay day={district.managerOwn[day]} /> : null}
    </>
  );
}

const MANAGER_NOTE_TEXT = "District manager · the reps' total, then own visits, counted in no rep's figure";
const DAY_HEAD = "text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500";

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
      {notWorking ? <p className="border border-sky-200 bg-sky-50 px-4 py-2 text-phx-2xs font-semibold text-sky-900">{notWorking}</p> : null}
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
      {report.districts.length === 0 ? (
        <p className="border border-slate-200 bg-white p-4 text-phx-xs text-slate-600">No reps under your district managers yet.</p>
      ) : null}
      {report.districts.map((district) => {
        const reps = sortTeamVisitReps(filterTeamVisitReps(district.reps, show, day), sort, day);
        const vacant = teamVisitVacantLine(teamVisitVacantSeats(district));
        return (
          <div className="scroll-mt-4 border border-slate-200" id={teamVisitDistrictAnchor(district)} key={`${district.regionName}|${district.districtName}|${district.managerName}`}>
            <KpiSection description={regionGroupCaption(district.reps.length, district.vacantSeats)} title={regionManagerTitle(district.regionName, district.managerName)}>
              {vacant ? <p className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-phx-2xs font-semibold text-slate-600">{vacant}</p> : null}
              {filtered ? (
                <p className="border-b border-slate-200 bg-white px-4 py-2 text-phx-2xs text-slate-600">
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
                  <tr className="border-b border-slate-200 bg-slate-50 text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">
                    <th className="px-4 py-2" scope="col">Rep</th>
                    <th className="px-4 py-2" scope="col">Yesterday · {yesterday}</th>
                    <th className="px-4 py-2" scope="col">Today so far · {today}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className={`border-b border-slate-100 align-top ${MANAGER_ROW}`}>
                    <td className="break-words px-4 py-3">
                      <p className={MANAGER_NAME}>{district.managerName}</p>
                      <p className={MANAGER_NOTE}>{MANAGER_NOTE_TEXT}</p>
                    </td>
                    <td className="px-4 py-3">
                      <RepsTotal day={district.repsTotal.yesterday} />
                      {district.managerOwn ? <OwnDay day={district.managerOwn.yesterday} /> : null}
                    </td>
                    <td className="px-4 py-3">
                      <RepsTotal day={district.repsTotal.today} />
                      {district.managerOwn ? <OwnDay day={district.managerOwn.today} /> : null}
                    </td>
                  </tr>
                  {reps.map((rep) => (
                    <tr className="scroll-mt-4 border-b border-slate-100 align-top last:border-b-0" id={teamVisitRepAnchor(rep.seatId, "row")} key={rep.seatId}>
                      <td className="break-words px-4 py-3">
                        <p className="text-phx-xs font-black text-slate-900">{rep.person}</p>
                        <p className="text-phx-2xs text-slate-500">{rep.territory}</p>
                      </td>
                      <td className="px-4 py-3"><DayCell day={rep.yesterday} href={dayHref(rep.seatId, report.yesterday)} /></td>
                      <td className="px-4 py-3"><DayCell day={rep.today} href={dayHref(rep.seatId, report.today)} pace={paceOf(rep)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="grid divide-y divide-slate-100 md:hidden">
                <div className={`grid gap-2 p-4 ${MANAGER_ROW}`}>
                  <div>
                    <p className={MANAGER_NAME}>{district.managerName}</p>
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
                      <p className="text-phx-xs font-black text-slate-900">{rep.person}</p>
                      <p className="text-phx-2xs text-slate-500">{rep.territory}</p>
                    </div>
                    <p className={DAY_HEAD}>Yesterday · {yesterday}</p>
                    <DayCell day={rep.yesterday} fold href={dayHref(rep.seatId, report.yesterday)} />
                    <p className={DAY_HEAD}>Today so far · {today}</p>
                    <DayCell day={rep.today} fold href={dayHref(rep.seatId, report.today)} pace={paceOf(rep)} />
                  </div>
                ))}
              </div>
              {filtered && reps.length === 0 ? (
                <p className="border-t border-slate-200 bg-white px-4 py-3 text-phx-2xs text-slate-500">No rep in this team matches the filter.</p>
              ) : null}
            </KpiSection>
          </div>
        );
      })}
    </div>
  );
}
