import Link from "next/link";

import { KpiSection } from "@/components/crm/kpis-chrome";
import { cairoDate } from "@/lib/format/cairo-datetime";
import { regionManagerTitle } from "@/lib/phoenix-crm/region-manager-groups";
import type { TeamVisitsReport } from "@/lib/phoenix-crm/server/team-visits";
import {
  repsWord,
  TEAM_VISIT_DAYS,
  TEAM_VISIT_SHOW,
  TEAM_VISIT_ORIGINS,
  TEAM_VISIT_ORIGIN_LABEL,
  TEAM_VISIT_ORIGIN_SWATCH,
  TEAM_VISIT_SHOW_LABEL,
  TEAM_VISIT_SORT,
  TEAM_VISIT_SORT_LABEL,
  TEAM_VISITS_NO_TIME,
  teamVisitAttention,
  teamVisitBarWidth,
  teamVisitDayHeading,
  teamVisitDistrictAnchor,
  teamVisitDistrictRollups,
  teamVisitFiguresLine,
  teamVisitFilterHref,
  teamVisitHourSpread,
  teamVisitManagersInField,
  teamVisitPace,
  teamVisitListedSeatIds,
  teamVisitPaceLine,
  teamVisitRepAnchor,
  teamVisitSignedDifference,
  teamVisitTeamPace,
  teamVisitShowCounts,
  teamVisitTimelineLine,
  teamVisitWaitingLine,
  isVacantTeamVisitRep,
  type TeamVisitDayKey,
  type TeamVisitDayRollup,
  type TeamVisitManagerDay,
  type TeamVisitShow,
  type TeamVisitSort,
} from "@/lib/phoenix-crm/server/team-visits-summary";

/**
 * The panels above the rep tables on Visits — Yesterday and Today (owner, 9 Nov 2026: the premium pass on My Team's
 * Reports). Server-rendered, no client state: the filter is two links, the export one more.
 *
 * Every figure comes from `team-visits-summary.ts`, the arithmetic the rows below and the Excel file read, so a
 * panel can never disagree with its rows. The finish is the house one: flat colour, square corners, hairline
 * borders — no gradient, glow or drop shadow (owner, 22 Oct 2026).
 */

/** The Excel file's address. It always holds every rep, whatever the screen's filter. */
export const TEAM_VISITS_EXPORT_HREF = "/api/crm/team-visits/export";

const LINK = "border border-slate-300 bg-white px-3 py-1.5 text-phx-sm font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-50";
const LINK_ON = "border border-slate-900 bg-slate-900 px-3 py-1.5 text-phx-sm font-black uppercase tracking-[0.1em] text-white";
const LABEL = "text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500";

function dayLabel(iso: string): string {
  return cairoDate(`${iso}T12:00:00Z`);
}

function dayIso(report: Pick<TeamVisitsReport, "today" | "yesterday">, day: TeamVisitDayKey): string {
  return day === "today" ? report.today : report.yesterday;
}

/**
 * The filter and the download. "Judge by" picks the day the two narrowing filters read, and each filter carries the
 * count of reps it lists, so a click never lands on an empty screen by surprise. The Excel file always holds every
 * rep, whatever is chosen here.
 */
export function TeamVisitsToolbar({ day, report, show, sort = "territory" }: { day: TeamVisitDayKey; report: TeamVisitsReport; show: TeamVisitShow; sort?: TeamVisitSort }) {
  const counts = teamVisitShowCounts(report, day);
  return (
    <div className="grid gap-3 border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-phx-md font-black text-slate-900">
            {dayLabel(report.yesterday)} and {dayLabel(report.today)}
          </p>
          <p className="text-phx-sm text-slate-500">
            Today is the visit day still running, so its figures grow until it closes. The times are when each visit was saved, Cairo time. Beside each
            customer, the metres from where the visit was logged to the place&apos;s validated live photo.
          </p>
          <ul aria-label="Visit colours" className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {TEAM_VISIT_ORIGINS.map((origin) => (
              <li className="flex items-center gap-1.5 text-phx-sm font-semibold text-slate-700" key={origin}>
                <span aria-hidden className={`inline-block h-3 w-[3px] ${TEAM_VISIT_ORIGIN_SWATCH[origin]}`} />
                {TEAM_VISIT_ORIGIN_LABEL[origin]}
              </li>
            ))}
          </ul>
        </div>
        <a className={LINK} href={TEAM_VISITS_EXPORT_HREF}>
          Download Excel
        </a>
      </div>
      <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={LABEL}>Judge by</span>
          {TEAM_VISIT_DAYS.map((key) => (
            <Link aria-current={key === day ? "true" : undefined} className={key === day ? LINK_ON : LINK} href={teamVisitFilterHref(show, key, sort)} key={key}>
              {teamVisitDayHeading(key)}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={LABEL}>Show</span>
          {TEAM_VISIT_SHOW.map((key) => (
            <Link aria-current={key === show ? "true" : undefined} className={key === show ? LINK_ON : LINK} href={teamVisitFilterHref(key, day, sort)} key={key}>
              {TEAM_VISIT_SHOW_LABEL[key]} · {counts[key]}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={LABEL}>Order</span>
          {TEAM_VISIT_SORT.map((key) => (
            <Link aria-current={key === sort ? "true" : undefined} className={key === sort ? LINK_ON : LINK} href={teamVisitFilterHref(show, day, key)} key={key}>
              {TEAM_VISIT_SORT_LABEL[key]}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One day of a team's line: doctor visits, the three figures apart, who saved a visit, and the stretch of the day. */
function RollupDay({ rollup }: { rollup: TeamVisitDayRollup }) {
  const waiting = teamVisitWaitingLine(rollup.waiting);
  const timeline = teamVisitTimelineLine(rollup.timeline);
  return (
    <div className="grid gap-0.5">
      <p className="text-phx-lg font-black tabular-nums text-slate-900">
        {rollup.doctorVisits} <span className="text-phx-sm font-semibold text-slate-500">doctor visits</span>
      </p>
      <p className="text-phx-sm font-semibold tabular-nums text-slate-700">{teamVisitFiguresLine(rollup)}</p>
      <p className="text-phx-sm tabular-nums text-slate-600">
        {rollup.reps === 0 ? "No rep in a seat" : `${rollup.repsWithVisits} of ${repsWord(rollup.reps)} saved a visit`}
        {rollup.doctorVisitsPerActiveRep != null ? ` · ${rollup.doctorVisitsPerActiveRep} doctor visits each` : ""}
      </p>
      {waiting ? <p className="text-phx-sm font-semibold text-amber-800">{waiting}</p> : null}
      {timeline ? <p className="text-phx-sm tabular-nums text-slate-500">{timeline}</p> : null}
    </div>
  );
}

/**
 * The teams side by side: one line per region and district manager, both days. Printed only when there are two teams
 * or more — with one, the team's own section below already says it. A team's name jumps to its section.
 */
export function TeamVisitsRollupPanel({ report }: { report: TeamVisitsReport }) {
  const rollups = teamVisitDistrictRollups(report);
  if (rollups.length < 2) return null;
  const yesterday = dayLabel(report.yesterday);
  const today = dayLabel(report.today);
  return (
    <div className="border border-slate-200">
      <KpiSection description="One line per region and district manager. Doctor visits are AM + PM; pharmacies and visits waiting for validation are counted apart." title="The teams side by side">
        <table className="hidden w-full table-fixed text-left md:table">
          <colgroup>
            <col className="w-[30%]" />
            <col className="w-[35%]" />
            <col className="w-[35%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
              <th className="px-4 py-2" scope="col">Team</th>
              <th className="px-4 py-2" scope="col">Yesterday · {yesterday}</th>
              <th className="px-4 py-2" scope="col">Today so far · {today}</th>
            </tr>
          </thead>
          <tbody>
            {rollups.map((rollup, index) => (
              <tr className="border-b border-slate-100 align-top last:border-b-0" key={rollup.key}>
                <th className="break-words px-4 py-3 text-left font-normal" scope="row">
                  <a className="text-phx-md font-black text-slate-900 hover:underline" href={`#${teamVisitDistrictAnchor(report.districts[index])}`}>
                    {regionManagerTitle(rollup.regionName, rollup.managerName)}
                  </a>
                  <p className="text-phx-sm text-slate-500">
                    {repsWord(rollup.yesterday.reps)}
                    {rollup.vacantSeats > 0 ? ` · ${rollup.vacantSeats} vacant ${rollup.vacantSeats === 1 ? "seat" : "seats"}` : ""}
                  </p>
                </th>
                <td className="px-4 py-3">
                  <RollupDay rollup={rollup.yesterday} />
                </td>
                <td className="px-4 py-3">
                  <RollupDay rollup={rollup.today} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid divide-y divide-slate-100 md:hidden">
          {rollups.map((rollup, index) => (
            <div className="grid gap-2 p-4" key={rollup.key}>
              <div>
                <a className="text-phx-md font-black text-slate-900 hover:underline" href={`#${teamVisitDistrictAnchor(report.districts[index])}`}>
                  {regionManagerTitle(rollup.regionName, rollup.managerName)}
                </a>
                <p className="text-phx-sm text-slate-500">
                  {repsWord(rollup.yesterday.reps)}
                  {rollup.vacantSeats > 0 ? ` · ${rollup.vacantSeats} vacant ${rollup.vacantSeats === 1 ? "seat" : "seats"}` : ""}
                </p>
              </div>
              <p className={LABEL}>Yesterday · {yesterday}</p>
              <RollupDay rollup={rollup.yesterday} />
              <p className={LABEL}>Today so far · {today}</p>
              <RollupDay rollup={rollup.today} />
            </div>
          ))}
        </div>
      </KpiSection>
    </div>
  );
}

/**
 * When the reps saved their visits, two hours at a time, each day — every visit the reps saved, waiting ones
 * included; the district managers' own visits are not in it. A copied old-CRM visit recorded no time and is counted
 * on its own line, never in an hour. Flat bars against the fuller of the two days, so the days compare by eye.
 */
export function TeamVisitsHoursPanel({ report }: { report: TeamVisitsReport }) {
  const reps = report.districts.flatMap((district) => district.reps).filter((rep) => !isVacantTeamVisitRep(rep));
  const spreads = TEAM_VISIT_DAYS.map((key) => ({ key, spread: teamVisitHourSpread(reps.map((rep) => rep[key])) }));
  const peak = Math.max(0, ...spreads.map((entry) => entry.spread.peak));
  if (spreads.every((entry) => entry.spread.timed + entry.spread.untimed === 0)) return null;
  return (
    <div className="border border-slate-200">
      <KpiSection description="Every visit the reps saved, by the Cairo time it was saved, two hours at a time. Visits waiting for validation are in it; the district managers' own visits are not." title="When the visits were saved">
        <div className="grid gap-px bg-slate-200 md:grid-cols-2">
          {spreads.map(({ key, spread }) => (
            <div className="grid content-start gap-2 bg-white p-4" key={key}>
              <p className={LABEL}>
                {teamVisitDayHeading(key)} · {dayLabel(dayIso(report, key))} · {spread.timed + spread.untimed} saved
              </p>
              <ul className="grid gap-1.5">
                {spread.blocks.map(({ block, visits }) => (
                  <li className="grid grid-cols-[8.75rem_minmax(0,1fr)_3rem] items-center gap-2" key={block.key}>
                    <span className="text-phx-sm font-semibold text-slate-600">{block.label}</span>
                    <span aria-hidden className="block h-2.5 bg-slate-100">
                      <span className="block h-full bg-sky-700" style={{ width: `${teamVisitBarWidth(visits, peak)}%` }} />
                    </span>
                    <span className="text-right text-phx-sm font-black tabular-nums text-slate-900">{visits}</span>
                  </li>
                ))}
              </ul>
              {spread.untimed > 0 ? (
                <p className="text-phx-sm text-slate-500">
                  {spread.untimed} copied from the old CRM · {TEAM_VISITS_NO_TIME.toLowerCase()}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </KpiSection>
    </div>
  );
}

/**
 * The reps to look at on the chosen day: a rep in a seat who saved nothing, a rep whose every visit still waits for
 * validation, and every rep with a visit waiting. Facts, worded as facts — no rank, no verdict. A vacant seat is
 * never here. Today's list is left to "Judge by: Today so far", because early in the day every rep is still at zero.
 */
export function TeamVisitsAttentionPanel({ day, report, show = "all" }: { day: TeamVisitDayKey; report: TeamVisitsReport; show?: TeamVisitShow }) {
  const attention = teamVisitAttention(report, day);
  const listed = teamVisitListedSeatIds(report, show, day);
  if (attention.none.length + attention.waitingOnly.length + attention.waiting.length === 0) return null;
  const heading = day === "today" ? "today so far" : "yesterday";
  const groups: Array<{ key: string; title: string; reps: Array<{ seatId: string; person: string; territory: string; managerName: string; regionName: string; note?: string }> }> = [
    { key: "none", reps: attention.none, title: `No visits saved ${heading}` },
    { key: "waiting-only", reps: attention.waitingOnly, title: `Every visit waiting for validation ${heading}` },
    {
      key: "waiting",
      reps: attention.waiting.map((rep) => ({ ...rep, note: teamVisitWaitingLine(rep.waiting) ?? undefined })),
      title: `Visits waiting for validation ${heading}`,
    },
  ];
  return (
    <div className="border border-slate-200">
      <KpiSection description={`Read from ${dayLabel(dayIso(report, day))}. A vacant seat is listed with its team, never here.`} title="Reps to look at">
        <div className="grid gap-px bg-slate-200 lg:grid-cols-3">
          {groups.map((group) => (
            <div className="grid content-start gap-2 bg-white p-4" key={group.key}>
              <p className={LABEL}>
                {group.title} · {group.reps.length}
              </p>
              {group.reps.length === 0 ? (
                <p className="text-phx-sm text-slate-400">Nobody</p>
              ) : (
                <ul className="grid gap-1">
                  {group.reps.map((rep) => (
                    <li className="border border-slate-200 bg-slate-50 px-2 py-1" key={`${group.key}-${rep.seatId}`}>
                      {listed.has(rep.seatId) ? (
                        <p className="break-words text-phx-sm font-black text-slate-900">
                          <a className="hidden hover:underline md:inline" href={`#${teamVisitRepAnchor(rep.seatId, "row")}`}>
                            {rep.person}
                          </a>
                          <a className="hover:underline md:hidden" href={`#${teamVisitRepAnchor(rep.seatId, "card")}`}>
                            {rep.person}
                          </a>
                        </p>
                      ) : (
                        <p className="break-words text-phx-sm font-black text-slate-900">{rep.person}</p>
                      )}
                      <p className="break-words text-phx-xs text-slate-500">
                        {rep.territory} · {rep.managerName}
                        {rep.note ? ` · ${rep.note}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </KpiSection>
    </div>
  );
}

function PaceSide({ label, side, reps }: { label: string; side: { saved: number; doctorVisits: number; reps: number }; reps: number }) {
  return (
    <div className="grid content-start gap-0.5 bg-white p-4">
      <p className={LABEL}>{label}</p>
      <p className="text-[1.7rem] font-black leading-none tabular-nums text-slate-900">{side.saved}</p>
      <p className="text-phx-sm font-semibold tabular-nums text-slate-700">visits saved · {side.doctorVisits} doctor visits</p>
      <p className="text-phx-sm tabular-nums text-slate-500">
        {side.reps} of {repsWord(reps)} had saved a visit
      </p>
    </div>
  );
}

/**
 * Today so far against yesterday at the same hour — the fair way to read a day still running (owner, 9 Nov 2026,
 * the premium pass). Yesterday is cut at the same visit-day minute as now; a copied visit with no time is in neither
 * side. Printed only while today's visit day is running, and the difference is a count, never a verdict.
 */
export function TeamVisitsPacePanel({ nowIso, report }: { nowIso: string; report: TeamVisitsReport }) {
  const pace = teamVisitPace(report, nowIso);
  if (!pace) return null;
  const tone = pace.difference > 0 ? "text-emerald-800" : pace.difference < 0 ? "text-amber-800" : "text-slate-700";
  return (
    <div className="border border-slate-200">
      <KpiSection description={`Read at ${pace.cutoffLabel}, Cairo. Yesterday is counted only up to the same time of its own visit day; visits waiting for validation are in "saved", not in "doctor visits".`} title="Today so far against yesterday at this time">
        <div className="grid gap-px bg-slate-200 sm:grid-cols-3">
          <PaceSide label={`Yesterday by ${pace.cutoffLabel}`} reps={pace.repsInSeats} side={pace.yesterdayBy} />
          <PaceSide label={`Today by ${pace.cutoffLabel}`} reps={pace.repsInSeats} side={pace.today} />
          <div className="grid content-start gap-0.5 bg-white p-4">
            <p className={LABEL}>The difference</p>
            <p className={`text-[1.7rem] font-black leading-none tabular-nums ${tone}`}>{teamVisitSignedDifference(pace.difference)}</p>
            <p className="text-phx-sm font-semibold text-slate-700">{teamVisitPaceLine(pace.difference)}</p>
          </div>
        </div>
        <TeamPaceTable nowIso={nowIso} report={report} />
      </KpiSection>
    </div>
  );
}

function paceTone(difference: number): string {
  return difference > 0 ? "text-emerald-800" : difference < 0 ? "text-amber-800" : "text-slate-700";
}

function PaceCount({ side }: { side: { saved: number; doctorVisits: number; reps: number } }) {
  return (
    <div className="grid gap-0.5">
      <p className="text-phx-md font-black tabular-nums text-slate-900">{side.saved} saved</p>
      <p className="text-phx-sm tabular-nums text-slate-500">
        {side.doctorVisits} doctor visits · {side.reps} {side.reps === 1 ? "rep" : "reps"}
      </p>
    </div>
  );
}

/**
 * The pace again, one line per team — printed only when there are two teams or more, as the roll-up is. The rows add
 * up to the three figures above them; a team whose seats are all vacant says so instead of printing zeros.
 */
function TeamPaceTable({ nowIso, report }: { nowIso: string; report: TeamVisitsReport }) {
  const pace = teamVisitTeamPace(report, nowIso);
  if (!pace || pace.teams.length < 2) return null;
  return (
    <div className="mt-4 border-t border-slate-200 pt-3">
      <p className={LABEL}>Team by team, at {pace.cutoffLabel}</p>
      <table className="mt-2 hidden w-full table-fixed text-left md:table">
        <colgroup>
          <col className="w-[34%]" />
          <col className="w-[22%]" />
          <col className="w-[22%]" />
          <col className="w-[22%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
            <th className="px-4 py-2" scope="col">Team</th>
            <th className="px-4 py-2" scope="col">Yesterday by {pace.cutoffLabel}</th>
            <th className="px-4 py-2" scope="col">Today by {pace.cutoffLabel}</th>
            <th className="px-4 py-2" scope="col">The difference</th>
          </tr>
        </thead>
        <tbody>
          {pace.teams.map((team) => (
            <tr className="border-b border-slate-100 align-top last:border-b-0" key={team.key}>
              <th className="break-words px-4 py-3 text-left font-normal" scope="row">
                <a className="text-phx-md font-black text-slate-900 hover:underline" href={`#${team.anchor}`}>
                  {regionManagerTitle(team.regionName, team.managerName)}
                </a>
                <p className="text-phx-sm text-slate-500">{team.repsInSeats === 0 ? "Every seat is vacant" : repsWord(team.repsInSeats)}</p>
              </th>
              <td className="px-4 py-3">{team.repsInSeats === 0 ? null : <PaceCount side={team.yesterdayBy} />}</td>
              <td className="px-4 py-3">{team.repsInSeats === 0 ? null : <PaceCount side={team.today} />}</td>
              <td className="px-4 py-3">
                {team.repsInSeats === 0 ? null : (
                  <>
                    <p className={`text-phx-md font-black tabular-nums ${paceTone(team.difference)}`}>{teamVisitSignedDifference(team.difference)}</p>
                    <p className="text-phx-sm text-slate-500">{teamVisitPaceLine(team.difference)}</p>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 grid divide-y divide-slate-100 border border-slate-200 md:hidden">
        {pace.teams.map((team) => (
          <div className="grid gap-1.5 p-3" key={team.key}>
            <a className="text-phx-md font-black text-slate-900 hover:underline" href={`#${team.anchor}`}>
              {regionManagerTitle(team.regionName, team.managerName)}
            </a>
            {team.repsInSeats === 0 ? (
              <p className="text-phx-sm text-slate-500">Every seat is vacant</p>
            ) : (
              <>
                <p className="text-phx-sm tabular-nums text-slate-700">
                  Yesterday by {pace.cutoffLabel}: {team.yesterdayBy.saved} saved · Today: {team.today.saved} saved
                </p>
                <p className={`text-phx-sm font-black tabular-nums ${paceTone(team.difference)}`}>
                  {teamVisitSignedDifference(team.difference)} · {teamVisitPaceLine(team.difference)}
                </p>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ManagerFieldDay({ day }: { day: TeamVisitManagerDay | null }) {
  if (!day || day.saved === 0) return <p className="text-phx-sm text-slate-400">None saved</p>;
  const timeline = teamVisitTimelineLine(day.timeline);
  return (
    <div className="grid gap-0.5">
      <p className="text-phx-md font-black tabular-nums text-slate-900">{teamVisitFiguresLine(day)}</p>
      {timeline ? <p className="text-phx-sm tabular-nums text-slate-500">{timeline}</p> : null}
    </div>
  );
}

/**
 * The district managers' own visits side by side — what each saved in person, counted in no rep's figure. Printed
 * when at least one district manager sits in a seat. A team with nobody in the seat says so.
 */
export function TeamVisitsManagersPanel({ report }: { report: TeamVisitsReport }) {
  const rows = teamVisitManagersInField(report);
  if (rows.length === 0 || rows.every((row) => row.noManager)) return null;
  const yesterday = dayLabel(report.yesterday);
  const today = dayLabel(report.today);
  return (
    <div className="border border-slate-200">
      <KpiSection description="The visits each district manager saved in person. They are counted in no rep's figure and in none of the team's tiles." title="The district managers' own visits">
        <table className="hidden w-full table-fixed text-left md:table">
          <colgroup>
            <col className="w-[30%]" />
            <col className="w-[35%]" />
            <col className="w-[35%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
              <th className="px-4 py-2" scope="col">District manager</th>
              <th className="px-4 py-2" scope="col">Yesterday · {yesterday}</th>
              <th className="px-4 py-2" scope="col">Today so far · {today}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-b border-slate-100 align-top last:border-b-0" key={row.key}>
                <th className="break-words px-4 py-3 text-left font-normal" scope="row">
                  <a className="text-phx-md font-black text-sky-900 hover:underline" href={`#${row.anchor}`}>
                    {row.managerName}
                  </a>
                  <p className="text-phx-sm text-slate-500">{row.noManager ? `${row.regionName} · nobody in the district manager's seat` : row.regionName}</p>
                </th>
                <td className="px-4 py-3">{row.noManager ? null : <ManagerFieldDay day={row.yesterday} />}</td>
                <td className="px-4 py-3">{row.noManager ? null : <ManagerFieldDay day={row.today} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid divide-y divide-slate-100 md:hidden">
          {rows.map((row) => (
            <div className="grid gap-2 p-4" key={row.key}>
              <div>
                <a className="text-phx-md font-black text-sky-900 hover:underline" href={`#${row.anchor}`}>
                  {row.managerName}
                </a>
                <p className="text-phx-sm text-slate-500">{row.noManager ? `${row.regionName} · nobody in the district manager's seat` : row.regionName}</p>
              </div>
              {row.noManager ? null : (
                <>
                  <p className={LABEL}>Yesterday · {yesterday}</p>
                  <ManagerFieldDay day={row.yesterday} />
                  <p className={LABEL}>Today so far · {today}</p>
                  <ManagerFieldDay day={row.today} />
                </>
              )}
            </div>
          ))}
        </div>
      </KpiSection>
    </div>
  );
}

/** The jump list: one link per team, for a long page on a phone as much as on a desk. */
export function TeamVisitsJumpList({ report }: { report: TeamVisitsReport }) {
  if (report.districts.length < 2) return null;
  return (
    <nav aria-label="Jump to a team" className="flex flex-wrap items-center gap-2 border border-slate-200 bg-white px-4 py-3">
      <span className={LABEL}>Jump to</span>
      {report.districts.map((district) => (
        <a className={LINK} href={`#${teamVisitDistrictAnchor(district)}`} key={`${district.regionName}|${district.districtName}|${district.managerName}`}>
          {regionManagerTitle(district.regionName, district.managerName)}
        </a>
      ))}
    </nav>
  );
}
