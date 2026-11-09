import Link from "next/link";
import { Users } from "lucide-react";

import { KpiSection, KpiTile } from "@/components/crm/kpis-chrome";
import { addDaysIso } from "@/lib/crm/dates";
import { regionManagerTitle } from "@/lib/phoenix-crm/region-manager-groups";
import type { DistrictManagersPlans } from "@/lib/phoenix-crm/server/manager-plan-bookings";
import {
  DISTRICT_PLAN_ATTENTION,
  DISTRICT_PLAN_ATTENTION_LABEL,
  DISTRICT_PLAN_KINDS,
  DISTRICT_PLAN_KIND_EDGE,
  DISTRICT_PLAN_KIND_LABEL,
  DISTRICT_PLAN_KIND_SWATCH,
  DISTRICT_PLAN_SHOW,
  DISTRICT_PLAN_SHOW_LABEL,
  DISTRICT_PLAN_STATE_LABEL,
  DISTRICT_PLAN_STATE_SWATCH,
  districtCustomerAShare,
  districtCustomerCountLine,
  districtCustomerGradeLine,
  districtCustomerRepeatedLine,
  districtCustomerSpecialityLine,
  districtPlanAnchor,
  districtPlanAttentionCounts,
  districtPlanDayLabel,
  districtPlanKindBar,
  districtPlanKindsLine,
  districtPlanListedSeats,
  districtPlansAttention,
  districtPlansChainVisits,
  districtPlansCustomerRows,
  districtPlansGrid,
  districtPlanShortDay,
  districtPlanShowCounts,
  districtPlansHref,
  districtPlansRepsAlone,
  districtPlanStateBar,
  districtPlansTeamLine,
  districtPlansTeamTotals,
  districtPlanWeekPositionLine,
  districtRepLeaveLine,
  districtRepsWord,
  halfDaysWord,
  type DistrictCustomerMix,
  type DistrictPlanBarPart,
  type DistrictPlanGridCell,
  type DistrictPlanShow,
} from "@/lib/phoenix-crm/server/district-plans-summary";

/**
 * The panels above the district managers' own sections on District Managers' Plans (owner, 9 Nov 2026: the premium
 * pass on My Team's Reports). Server-rendered, no client state: the week and the filter are links, the export one
 * more.
 *
 * Every figure comes from `district-plans-summary.ts`, the arithmetic the sections below and the Excel file read, so
 * a panel can never disagree with its sections. The finish is the house one: flat colour, square corners, hairline
 * borders — no gradient, glow or drop shadow (owner, 22 Oct 2026). A chain visit is a neutral sky line with the
 * people icon — never red, never a warning (owner, 2026-10-24).
 */

/** The Excel file's address, for the week on the screen. It always holds every seat, whatever the filter. */
export const DISTRICT_PLANS_EXPORT_PATH = "/api/crm/district-manager-plans/export";

export function districtPlansExportHref(weekStart: string): string {
  return `${DISTRICT_PLANS_EXPORT_PATH}?week=${encodeURIComponent(weekStart)}`;
}

export const LINK = "border border-slate-300 bg-white px-3 py-1.5 text-phx-sm font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-50";
export const LINK_ON = "border border-slate-900 bg-slate-900 px-3 py-1.5 text-phx-sm font-black uppercase tracking-[0.1em] text-white";
export const LABEL = "text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500";

/** A quiet name link to a manager's section, only when that section is on the page. */
function ManagerName({ anchor, listed, name }: { anchor: string; listed: boolean; name: string }) {
  return listed ? (
    <a className="text-phx-sm font-black text-slate-900 hover:underline" href={`#${anchor}`}>
      {name}
    </a>
  ) : (
    <span className="text-phx-sm font-black text-slate-900">{name}</span>
  );
}

/**
 * The week and the filter. The three week links keep the filter; each filter carries the count of seats it lists,
 * so a click never lands on an empty screen by surprise. The Excel file always holds every seat.
 */
export function DistrictPlansToolbar({ report, show }: { report: DistrictManagersPlans; show: DistrictPlanShow }) {
  const counts = districtPlanShowCounts(report.weeks);
  const previous = addDaysIso(report.weekStart, -7);
  const next = addDaysIso(report.weekStart, 7);
  return (
    <div className="grid gap-3 border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-phx-md font-black text-slate-900">
            Week · {districtPlanDayLabel(report.weekStart)} – {districtPlanDayLabel(report.weekEnd)}
          </p>
          <p className="text-phx-sm text-slate-500">
            {districtPlanWeekPositionLine(report)} Only sent weeks are shown, half by half; a draft is never read.
          </p>
          <ul aria-label="Half-day colours" className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {DISTRICT_PLAN_KINDS.filter((kind) => kind !== "with_dm").map((kind) => (
              <li className="flex items-center gap-1.5 text-phx-sm font-semibold text-slate-700" key={kind}>
                <span aria-hidden className={`inline-block h-3 w-[3px] ${DISTRICT_PLAN_KIND_SWATCH[kind]}`} />
                {DISTRICT_PLAN_KIND_LABEL[kind]}
              </li>
            ))}
          </ul>
        </div>
        <a className={LINK} href={districtPlansExportHref(report.weekStart)}>
          Download Excel
        </a>
      </div>
      <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={LABEL}>Week</span>
          <Link className={LINK} href={districtPlansHref(previous, show)}>
            Previous week
          </Link>
          <Link className={LINK} href={districtPlansHref(null, show)}>
            This week
          </Link>
          <Link className={LINK} href={districtPlansHref(next, show)}>
            Next week
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={LABEL}>Show</span>
          {DISTRICT_PLAN_SHOW.map((key) => (
            <Link aria-current={key === show ? "true" : undefined} className={key === show ? LINK_ON : LINK} href={districtPlansHref(report.weekStart, key)} key={key}>
              {DISTRICT_PLAN_SHOW_LABEL[key]} · {counts[key]}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Four tiles: the weeks sent, the weeks not sent, the half-days planned, and the reps a manager is with. */
export function DistrictPlansTiles({ report }: { report: DistrictManagersPlans }) {
  const totals = districtPlansTeamTotals(report);
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile
        caption={`${totals.byState.approved} approved · ${totals.byState.waiting} waiting · ${totals.byState.ended} ended undecided`}
        label="Weeks sent"
        value={`${totals.sent} of ${totals.managers}`}
      />
      <KpiTile
        caption={`${totals.late} sent late${totals.vacantManagerSeats > 0 ? ` · ${totals.vacantManagerSeats} vacant ${totals.vacantManagerSeats === 1 ? "seat" : "seats"}, counted in neither` : ""}`}
        label="Not sent"
        value={String(totals.notSent)}
      />
      <KpiTile caption={districtPlanKindsLine(totals.byKind)} label="Half-days planned" value={String(totals.halves)} />
      <KpiTile
        caption={`${totals.reps - totals.repsWithAManager} with nobody this week${totals.vacantRepSeats > 0 ? ` · ${totals.vacantRepSeats} vacant rep ${totals.vacantRepSeats === 1 ? "seat" : "seats"}` : ""}`}
        label="Reps a manager is with"
        value={`${totals.repsWithAManager} of ${totals.reps}`}
      />
    </div>
  );
}

/** One flat bar and its key. The key lists every part with its count, so the bar never has to carry words. */
function Bar<K extends string>({ label, parts, whole }: { label: string; parts: DistrictPlanBarPart<K>[]; whole: string }) {
  return (
    <div className="grid gap-2">
      <p className={LABEL}>
        {label} · {whole}
      </p>
      {parts.length === 0 ? (
        <p className="text-phx-sm text-slate-400">Nothing to show</p>
      ) : (
        <>
          <div aria-hidden className="flex h-3 w-full border border-slate-200 bg-slate-50">
            {parts.map((part) => (
              <span className={`h-full ${part.swatch}`} key={part.key} style={{ width: `${part.percent}%` }} />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {parts.map((part) => (
              <li className="flex items-center gap-1.5 text-phx-sm font-semibold tabular-nums text-slate-700" key={part.key}>
                <span aria-hidden className={`inline-block h-2.5 w-2.5 border border-slate-300 ${part.swatch}`} />
                {part.label} · {part.count}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Where the weeks stand: every seat by its week's state, and every planned half-day by its kind. */
export function DistrictPlansStandPanel({ report }: { report: DistrictManagersPlans }) {
  const totals = districtPlansTeamTotals(report);
  if (report.weeks.length === 0) return null;
  return (
    <div className="border border-slate-200">
      <KpiSection description={districtPlansTeamLine(totals)} title="Where the weeks stand">
        <div className="grid gap-px bg-slate-200 lg:grid-cols-2">
          <div className="bg-white p-4">
            <Bar label="Every district manager seat" parts={districtPlanStateBar(totals)} whole={`${report.weeks.length} ${report.weeks.length === 1 ? "seat" : "seats"}`} />
          </div>
          <div className="bg-white p-4">
            <Bar label="Every planned half-day of the sent weeks" parts={districtPlanKindBar(totals)} whole={halfDaysWord(totals.halves)} />
            {totals.openHalves > 0 ? (
              <p className="mt-2 text-phx-sm text-slate-500">
                {halfDaysWord(totals.openHalves)} from Saturday to Thursday have nothing planned, the managers&apos; own leave left out.
              </p>
            ) : null}
          </div>
        </div>
      </KpiSection>
    </div>
  );
}

function GridCell({ cell }: { cell: DistrictPlanGridCell }) {
  if (cell.state === "unsent") return <span className="text-phx-xs font-semibold text-slate-400">Not sent</span>;
  if (cell.state === "leave") return <span className="text-phx-xs font-black uppercase tracking-[0.1em] text-sky-800">On leave</span>;
  if (cell.state === "open") return <span className="text-phx-xs text-slate-300">Nothing</span>;
  return (
    <span className={`block break-words border-l-2 pl-1.5 text-phx-xs font-semibold leading-4 text-slate-800 ${DISTRICT_PLAN_KIND_EDGE[cell.kind]}`}>
      {cell.text}
      {cell.repOnLeave ? <span className="block font-black text-amber-800">Rep on leave</span> : null}
      {cell.chainVisit ? <Users aria-label="Chain visit" className="ml-1 inline h-3 w-3 text-sky-800" /> : null}
    </span>
  );
}

/**
 * The week at a glance: one row per district manager, one column per day, AM over PM. Saturday to Thursday always;
 * Friday only when a sent week planned it. A table on a wide screen, one card per manager below it — never a
 * sideways scroll.
 */
export function DistrictPlansGridPanel({ report, show }: { report: DistrictManagersPlans; show: DistrictPlanShow }) {
  const grid = districtPlansGrid(report);
  if (grid.rows.length === 0) return null;
  const listed = districtPlanListedSeats(report.weeks, show);
  const dayWidth = `${(82 / grid.days.length).toFixed(2)}%`;
  return (
    <div className="border border-slate-200">
      <KpiSection description="AM over PM. A name is the rep for that half; the people icon is a chain visit, information only." title="The week at a glance">
        <table className="hidden w-full table-fixed text-left lg:table">
          <colgroup>
            <col className="w-[18%]" />
            {grid.days.map((date) => (
              <col key={date} style={{ width: dayWidth }} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
              <th className="px-3 py-2" scope="col">District manager</th>
              {grid.days.map((date) => (
                <th className={`px-2 py-2 ${date === report.cairoToday ? "bg-slate-900 text-white" : ""}`} key={date} scope="col">
                  {districtPlanShortDay(date)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => (
              <tr className="border-b border-slate-100 align-top last:border-b-0" key={row.week.districtSeatId}>
                <th className="break-words px-3 py-2 text-left font-normal" scope="row">
                  <span className="flex items-start gap-1.5">
                    <span aria-hidden className={`mt-1 inline-block h-2.5 w-2.5 shrink-0 ${DISTRICT_PLAN_STATE_SWATCH[row.state]}`} />
                    <span className="min-w-0">
                      <ManagerName anchor={districtPlanAnchor(row.week)} listed={listed.has(row.week.districtSeatId)} name={row.week.managerName} />
                      <span className="block text-phx-xs text-slate-500">{DISTRICT_PLAN_STATE_LABEL[row.state]}</span>
                    </span>
                  </span>
                </th>
                {grid.days.map((date) => (
                  <td className="px-2 py-2" key={date}>
                    <div className="grid gap-1.5">
                      {row.cells
                        .filter((entry) => entry.date === date)
                        .map((entry) => (
                          <div className="grid gap-0.5" key={entry.half}>
                            <span className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">{entry.half}</span>
                            <GridCell cell={entry.cell} />
                          </div>
                        ))}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid divide-y divide-slate-100 lg:hidden">
          {grid.rows.map((row) => (
            <div className="grid gap-2 p-4" key={row.week.districtSeatId}>
              <p className="flex items-center gap-1.5">
                <span aria-hidden className={`inline-block h-2.5 w-2.5 ${DISTRICT_PLAN_STATE_SWATCH[row.state]}`} />
                <ManagerName anchor={districtPlanAnchor(row.week)} listed={listed.has(row.week.districtSeatId)} name={row.week.managerName} />
                <span className="text-phx-xs text-slate-500">· {DISTRICT_PLAN_STATE_LABEL[row.state]}</span>
              </p>
              {row.cells.every((entry) => entry.cell.state === "unsent") ? (
                <p className="text-phx-sm text-slate-500">Not sent yet</p>
              ) : (
                <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1">
                  {grid.days.map((date) => (
                    <div className="contents" key={date}>
                      <dt className={`text-phx-xs font-black uppercase tracking-[0.1em] ${date === report.cairoToday ? "text-slate-900" : "text-slate-500"}`}>{districtPlanShortDay(date)}</dt>
                      <dd className="grid min-w-0 gap-1 sm:grid-cols-2">
                        {row.cells
                          .filter((entry) => entry.date === date)
                          .map((entry) => (
                            <span className="flex min-w-0 items-start gap-1.5" key={entry.half}>
                              <span className="text-phx-xs font-black text-slate-400">{entry.half}</span>
                              <span className="min-w-0">
                                <GridCell cell={entry.cell} />
                              </span>
                            </span>
                          ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          ))}
        </div>
      </KpiSection>
    </div>
  );
}

/** The weeks worth a second look, by reason. Plain facts in plain words; a chain visit is never one of them. */
export function DistrictPlansAttentionPanel({ report, show }: { report: DistrictManagersPlans; show: DistrictPlanShow }) {
  const items = districtPlansAttention(report);
  if (items.length === 0) return null;
  const counts = districtPlanAttentionCounts(items);
  const listed = districtPlanListedSeats(report.weeks, show);
  return (
    <div className="border border-slate-200">
      <KpiSection description="Plain facts about each week, never a judgement. A vacant seat is listed with its team, never here." title="Weeks to look at">
        <ul aria-label="Reasons" className="flex flex-wrap gap-x-4 gap-y-1 border-b border-slate-100 px-4 py-2">
          {DISTRICT_PLAN_ATTENTION.filter((reason) => counts[reason] > 0).map((reason) => (
            <li className="text-phx-sm font-semibold tabular-nums text-slate-700" key={reason}>
              {DISTRICT_PLAN_ATTENTION_LABEL[reason]} · {counts[reason]}
            </li>
          ))}
        </ul>
        <ul className="grid divide-y divide-slate-100">
          {items.map((item) => (
            <li className="grid gap-0.5 px-4 py-2.5 md:grid-cols-[14rem_12rem_1fr] md:gap-3" key={`${item.week.districtSeatId}-${item.reason}`}>
              <p className="min-w-0 break-words">
                <ManagerName anchor={districtPlanAnchor(item.week)} listed={listed.has(item.week.districtSeatId)} name={item.week.managerName} />
                <span className="block text-phx-xs text-slate-500">{item.week.regionName}</span>
              </p>
              <p className={LABEL}>{DISTRICT_PLAN_ATTENTION_LABEL[item.reason]}</p>
              <p className="min-w-0 break-words text-phx-sm text-slate-700">{item.line}</p>
            </li>
          ))}
        </ul>
      </KpiSection>
    </div>
  );
}

/** The reps no manager of any kind is with this week, team by team. */
export function DistrictPlansRepsAlonePanel({ report, show }: { report: DistrictManagersPlans; show: DistrictPlanShow }) {
  const alone = districtPlansRepsAlone(report);
  if (alone.length === 0) return null;
  const listed = districtPlanListedSeats(report.weeks, show);
  const count = alone.reduce((sum, entry) => sum + entry.reps.length, 0);
  return (
    <div className="border border-slate-200">
      <KpiSection
        description={`${districtRepsWord(count)} in a seat with no manager of any kind this week. A rep on leave all six field days is left out.`}
        title="Reps no manager is with this week"
      >
        <div className="grid gap-px bg-slate-200 md:grid-cols-2 xl:grid-cols-3">
          {alone.map((entry) => (
            <div className="grid content-start gap-2 bg-white p-4" key={entry.week.districtSeatId}>
              <p className="min-w-0 break-words">
                <ManagerName anchor={districtPlanAnchor(entry.week)} listed={listed.has(entry.week.districtSeatId)} name={regionManagerTitle(entry.week.regionName, entry.week.managerName)} />
              </p>
              <ul className="grid gap-1">
                {entry.reps.map((rep) => (
                  <li className="border border-slate-200 bg-slate-50 px-2 py-1" key={rep.seatId}>
                    <p className="break-words text-phx-sm font-black text-slate-900">{rep.name}</p>
                    <p className="break-words text-phx-xs text-slate-500">
                      {rep.territory}
                      {districtRepLeaveLine(rep, report.weekStart) ? ` · ${districtRepLeaveLine(rep, report.weekStart)}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </KpiSection>
    </div>
  );
}

/** Every chain visit of the week in one neutral list — sky, the people icon, never a warning. */
export function DistrictPlansChainVisitsPanel({ report }: { report: DistrictManagersPlans }) {
  const chains = districtPlansChainVisits(report);
  if (chains.length === 0) return null;
  return (
    <div className="border border-slate-200">
      <KpiSection description="Two managers with one rep the same day. Information only — it never blocks a plan." title={`Chain visits · ${chains.length}`}>
        <ul className="grid divide-y divide-slate-100">
          {chains.map((chain) => (
            <li className="grid gap-0.5 px-4 py-2.5 md:grid-cols-[6rem_14rem_1fr] md:gap-3" key={`${chain.week.districtSeatId}-${chain.date}-${chain.half}`}>
              <p className={LABEL}>
                {districtPlanShortDay(chain.date)} {chain.half}
              </p>
              <p className="min-w-0 break-words text-phx-sm font-black text-slate-900">{chain.week.managerName}</p>
              {chain.lines.map((line) => (
                <p className="flex min-w-0 items-start gap-1.5 break-words text-phx-sm font-semibold text-sky-800 md:col-start-3" key={line}>
                  <Users aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{line}</span>
                </p>
              ))}
            </li>
          ))}
        </ul>
      </KpiSection>
    </div>
  );
}

function mixCells({ mix }: { mix: DistrictCustomerMix }) {
  const grades = districtCustomerGradeLine(mix);
  const share = districtCustomerAShare(mix);
  return { grades: grades ? `${grades}${share != null ? ` · ${share}% of the graded are A` : ""}` : "None", specialities: districtCustomerSpecialityLine(mix) ?? "None" };
}

/**
 * Whom they will visit (owner, 2026-11-08, Dr. Hany Saad's sixth need): the customers each district manager ticked on
 * the sent week, by grade and by speciality, and the ones ticked on more than one half-day. Customers are counted once
 * however many half-days name them; the ticks are counted apart. Sent weeks only — a draft is never read.
 */
export function DistrictPlansCustomersPanel({ report, show }: { report: DistrictManagersPlans; show: DistrictPlanShow }) {
  const { rows, team } = districtPlansCustomerRows(report);
  if (rows.length === 0) return null;
  const listed = districtPlanListedSeats(report.weeks, show);
  const teamCells = mixCells({ mix: team });
  return (
    <div className="border border-slate-200">
      <KpiSection
        description={`${districtCustomerCountLine(team)} across the sent weeks${team.gone > 0 ? ` · ${team.gone} no longer on file` : ""}${team.ownList > 0 ? ` · ${team.ownList} from the managers' own lists` : ""}.`}
        title="Whom they will visit"
      >
        <table className="hidden w-full table-fixed text-left md:table">
          <colgroup>
            <col className="w-[26%]" />
            <col className="w-[18%]" />
            <col className="w-[24%]" />
            <col className="w-[32%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
              <th className="px-4 py-2" scope="col">District manager</th>
              <th className="px-4 py-2" scope="col">Customers</th>
              <th className="px-4 py-2" scope="col">By grade</th>
              <th className="px-4 py-2" scope="col">Specialities</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ mix, week }) => {
              const cells = mixCells({ mix });
              const repeated = districtCustomerRepeatedLine(mix);
              return (
                <tr className="border-b border-slate-100 align-top last:border-b-0" key={week.districtSeatId}>
                  <th className="break-words px-4 py-2.5 text-left font-normal" scope="row">
                    <ManagerName anchor={districtPlanAnchor(week)} listed={listed.has(week.districtSeatId)} name={week.managerName} />
                    <span className="block text-phx-xs text-slate-500">{week.regionName}</span>
                  </th>
                  <td className="break-words px-4 py-2.5 text-phx-sm tabular-nums text-slate-700">
                    {districtCustomerCountLine(mix)}
                    {mix.gone > 0 ? <span className="block text-slate-500">{mix.gone} no longer on file</span> : null}
                  </td>
                  <td className="break-words px-4 py-2.5 text-phx-sm tabular-nums text-slate-700">{cells.grades}</td>
                  <td className="break-words px-4 py-2.5 text-phx-sm text-slate-700">
                    {cells.specialities}
                    {repeated ? <span className="block text-slate-500">{repeated}</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-300 bg-slate-50 align-top">
              <th className="px-4 py-2.5 text-left text-phx-sm font-black text-slate-900" scope="row">The whole team</th>
              <td className="break-words px-4 py-2.5 text-phx-sm font-semibold tabular-nums text-slate-900">{districtCustomerCountLine(team)}</td>
              <td className="break-words px-4 py-2.5 text-phx-sm font-semibold tabular-nums text-slate-900">{teamCells.grades}</td>
              <td className="break-words px-4 py-2.5 text-phx-sm font-semibold text-slate-900">{teamCells.specialities}</td>
            </tr>
          </tfoot>
        </table>
        <ul className="grid divide-y divide-slate-100 md:hidden">
          {rows.map(({ mix, week }) => {
            const cells = mixCells({ mix });
            const repeated = districtCustomerRepeatedLine(mix);
            return (
              <li className="grid gap-0.5 px-4 py-2.5" key={week.districtSeatId}>
                <p className="min-w-0 break-words">
                  <ManagerName anchor={districtPlanAnchor(week)} listed={listed.has(week.districtSeatId)} name={week.managerName} />
                  <span className="text-phx-xs text-slate-500"> · {week.regionName}</span>
                </p>
                <p className="break-words text-phx-sm tabular-nums text-slate-700">{districtCustomerCountLine(mix)}</p>
                <p className="break-words text-phx-sm tabular-nums text-slate-600">Grades: {cells.grades}</p>
                <p className="break-words text-phx-sm text-slate-600">Specialities: {cells.specialities}</p>
                {repeated ? <p className="break-words text-phx-sm text-slate-500">{repeated}</p> : null}
              </li>
            );
          })}
          <li className="grid gap-0.5 bg-slate-50 px-4 py-2.5">
            <p className="text-phx-sm font-black text-slate-900">The whole team</p>
            <p className="break-words text-phx-sm tabular-nums text-slate-700">{districtCustomerCountLine(team)}</p>
            <p className="break-words text-phx-sm tabular-nums text-slate-600">Grades: {teamCells.grades}</p>
          </li>
        </ul>
      </KpiSection>
    </div>
  );
}
