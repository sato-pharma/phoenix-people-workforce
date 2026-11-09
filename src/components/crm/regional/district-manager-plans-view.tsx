import Link from "next/link";
import { Users } from "lucide-react";

import {
  DistrictPlansAttentionPanel,
  DistrictPlansChainVisitsPanel,
  DistrictPlansCustomersPanel,
  DistrictPlansGridPanel,
  DistrictPlansRepsAlonePanel,
  DistrictPlansStandPanel,
  DistrictPlansTiles,
  DistrictPlansToolbar,
  LABEL,
  LINK,
} from "@/components/crm/regional/district-manager-plans-panels";
import { KpiSection } from "@/components/crm/kpis-chrome";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { managerSlotKindLabel } from "@/lib/phoenix-crm/manager-plan-rules";
import type { DistrictManagersPlans, DistrictManagerWeek, DistrictPlanHalf, DistrictTeamRep } from "@/lib/phoenix-crm/server/manager-plan-bookings";
import { regionGroupCaption, regionManagerTitle } from "@/lib/phoenix-crm/region-manager-groups";
import {
  DISTRICT_PLAN_KIND_EDGE,
  DISTRICT_PLAN_REP_WEEK_LABEL,
  DISTRICT_PLAN_STATE_EDGE,
  customersWord,
  districtPlanAnchor,
  districtPlanKindsLine,
  districtPlanSentLine,
  districtPlansHref,
  districtPlanWeekFigures,
  districtRepLeaveLine,
  districtRepManagersLine,
  districtRepsWord,
  filterDistrictPlanWeeks,
  halfDaysWord,
  isRepWeekMissing,
  type DistrictPlanShow,
} from "@/lib/phoenix-crm/server/district-plans-summary";

/**
 * District Managers' Plans, the Regional Sales Manager's screen (owner, 2026-11-08; the premium pass, 9 Nov 2026).
 * Server-rendered. The panels on top read the whole team; then one section per district manager, grouped by region
 * and manager, each day's AM and PM halves under it, and his team's reps with who is with them this week.
 *
 * A chain visit is a neutral sky line with the people icon — never red, never a warning (owner, 2026-10-24). A week
 * he has not sent reads "Not sent yet" and when it was due; its draft is never shown. A week sent and not decided
 * before its Thursday passed reads "Ended before it was approved". A day he is on approved leave reads "On leave"
 * (owner, 2026-11-09: "if vacation put it"); a vacant seat wears the lightest colour.
 */

const REP_WEEK_TONE: Record<DistrictTeamRep["weekState"], string> = {
  no_plan: "text-slate-500",
  not_sent: "text-amber-800",
  old_crm: "text-slate-600",
  sent: "text-emerald-800",
};

function Half({ half }: { half: DistrictPlanHalf }) {
  const repWeekMissing = half.kind === "with_rep" && !half.repOnLeave && isRepWeekMissing(half.repWeekState);
  return (
    <div className={`grid min-w-0 gap-1 border-l-2 pl-3 ${DISTRICT_PLAN_KIND_EDGE[half.kind]}`}>
      <p className="break-words text-phx-md font-black text-slate-900">
        <span className="mr-1.5 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">{half.half}</span>
        {half.text}
      </p>
      <p className="break-words text-phx-xs font-semibold uppercase tracking-[0.1em] text-slate-400">{managerSlotKindLabel(half.kind)}</p>
      {half.repDay ? (
        <p className={`break-words text-phx-sm font-semibold ${half.repOnLeave ? "text-amber-800" : repWeekMissing ? "text-amber-800" : "text-slate-500"}`}>
          Rep&apos;s day: {half.repDay}
        </p>
      ) : null}
      {half.customers.length > 0 ? (
        <p className="break-words text-phx-sm text-slate-600">
          <span className="font-semibold text-slate-700">{customersWord(half.customers.length)}:</span> {half.customers.join(" · ")}
        </p>
      ) : null}
      {half.goneCustomers > 0 ? (
        <p className="break-words text-phx-sm font-semibold text-slate-500">
          {customersWord(half.goneCustomers)} no longer on file
        </p>
      ) : null}
      {half.chainVisits.map((line) => (
        <p className="flex items-start gap-1.5 break-words text-phx-sm font-semibold text-sky-800" key={line}>
          <Users aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{line}</span>
        </p>
      ))}
    </div>
  );
}

/** His team under his days: each rep's own week, leave, and who is with the rep this week. Table on md, cards below. */
function TeamReps({ week, weekStart }: { week: DistrictManagerWeek; weekStart: string }) {
  if (week.reps.length === 0) return null;
  const vacant = week.reps.filter((rep) => rep.vacant);
  const occupied = week.reps.filter((rep) => !rep.vacant);
  return (
    <div className="border-t border-slate-200">
      <p className={`px-4 pt-3 ${LABEL}`}>The team this week · {districtRepsWord(occupied.length)}</p>
      {occupied.length > 0 ? (
        <>
          <table className="mt-2 hidden w-full table-fixed text-left md:table">
            <colgroup>
              <col className="w-[26%]" />
              <col className="w-[14%]" />
              <col className="w-[18%]" />
              <col className="w-[30%]" />
              <col className="w-[12%]" />
            </colgroup>
            <thead>
              <tr className="border-y border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
                <th className="px-4 py-2" scope="col">Rep</th>
                <th className="px-4 py-2" scope="col">Own week</th>
                <th className="px-4 py-2" scope="col">Leave</th>
                <th className="px-4 py-2" scope="col">Managers with the rep</th>
                <th className="px-4 py-2 text-right" scope="col">Half-days</th>
              </tr>
            </thead>
            <tbody>
              {occupied.map((rep) => (
                <tr className="border-b border-slate-100 align-top last:border-b-0" key={rep.seatId}>
                  <th className="break-words px-4 py-2 text-left font-normal" scope="row">
                    <span className="block text-phx-sm font-black text-slate-900">{rep.name}</span>
                    <span className="block text-phx-xs text-slate-500">{rep.territory}</span>
                  </th>
                  <td className={`px-4 py-2 text-phx-sm font-semibold ${REP_WEEK_TONE[rep.weekState]}`}>{DISTRICT_PLAN_REP_WEEK_LABEL[rep.weekState]}</td>
                  <td className="break-words px-4 py-2 text-phx-sm text-slate-600">{districtRepLeaveLine(rep, weekStart) ?? "None"}</td>
                  <td className={`break-words px-4 py-2 text-phx-sm ${rep.managers.length ? "text-slate-700" : "font-semibold text-slate-500"}`}>{districtRepManagersLine(rep)}</td>
                  <td className="px-4 py-2 text-right text-phx-sm font-semibold tabular-nums text-slate-900">{rep.managerHalves}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="mt-2 grid divide-y divide-slate-100 md:hidden">
            {occupied.map((rep) => (
              <li className="grid gap-0.5 px-4 py-2" key={rep.seatId}>
                <p className="break-words text-phx-sm font-black text-slate-900">{rep.name}</p>
                <p className="break-words text-phx-xs text-slate-500">{rep.territory}</p>
                <p className="break-words text-phx-sm">
                  <span className={`font-semibold ${REP_WEEK_TONE[rep.weekState]}`}>Own week: {DISTRICT_PLAN_REP_WEEK_LABEL[rep.weekState]}</span>
                  {districtRepLeaveLine(rep, weekStart) ? <span className="text-slate-600"> · {districtRepLeaveLine(rep, weekStart)}</span> : null}
                </p>
                <p className="break-words text-phx-sm text-slate-700">
                  {districtRepManagersLine(rep)}
                  {rep.managerHalves > 0 ? ` · ${halfDaysWord(rep.managerHalves)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {vacant.length > 0 ? (
        <p className="border-t border-slate-100 bg-slate-50 px-4 py-2 text-phx-sm text-slate-500">
          {vacant.length === 1 ? "Vacant seat" : `${vacant.length} vacant seats`}: {vacant.map((rep) => rep.territory).join(" · ")}
        </p>
      ) : (
        <div className="pb-1" />
      )}
    </div>
  );
}

function ManagerSection({ week, weekStart }: { week: DistrictManagerWeek; weekStart: string }) {
  const figures = districtPlanWeekFigures(week, weekStart);
  const open = figures.sent ? week.planHref : null;
  return (
    <div className={`scroll-mt-4 border border-l-4 border-slate-200 ${DISTRICT_PLAN_STATE_EDGE[figures.state]}`} id={districtPlanAnchor(week)}>
      <KpiSection
        action={
          open ? (
            <Link className="border border-slate-500 px-3 py-1.5 text-phx-sm font-black uppercase tracking-[0.1em] text-white hover:bg-slate-800" href={open}>
              Open the week
            </Link>
          ) : null
        }
        description={`${regionGroupCaption(week.repSeats, week.vacantSeats)} · ${week.statusText}`}
        title={regionManagerTitle(week.regionName, week.managerName)}
      >
        <div className={`grid gap-1 border-b border-slate-100 px-4 py-3 ${figures.state === "vacant" ? "bg-slate-50" : "bg-white"}`}>
          <p className="break-words text-phx-sm font-semibold text-slate-700">{districtPlanSentLine(week, cairoDateTime)}</p>
          {figures.sent ? (
            <p className="break-words text-phx-sm tabular-nums text-slate-600">
              {halfDaysWord(figures.halves)} · {districtPlanKindsLine(figures.byKind)}
              {figures.openHalves > 0 ? ` · ${halfDaysWord(figures.openHalves)} with nothing planned` : ""}
              {` · with ${figures.repsWith} of ${districtRepsWord(figures.repsInTeam)}`}
              {figures.customers > 0 ? ` · ${customersWord(figures.customers)} ticked` : ""}
            </p>
          ) : null}
          {week.managerLeaveDays.length > 0 ? (
            <p className="text-phx-sm font-semibold text-sky-800">
              On approved leave {week.managerLeaveDays.length === 1 ? "one day" : `${week.managerLeaveDays.length} days`} this week
            </p>
          ) : null}
        </div>
        {figures.state === "vacant" ? (
          <p className="bg-slate-50 px-4 py-3 text-phx-md font-semibold text-slate-500">Nobody is in this seat, so there is no week to show.</p>
        ) : !figures.sent ? (
          <p className="px-4 py-3 text-phx-md font-semibold text-slate-600">Not sent yet</p>
        ) : (
          <div className="grid gap-px bg-slate-100 sm:grid-cols-2 xl:grid-cols-3">
            {week.days.map((day) => (
              <div className="grid content-start gap-2 bg-white p-4" key={day.date}>
                <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">{day.dateText}</p>
                {day.halves.length === 0 ? (
                  day.managerOnLeave ? (
                    <p className="text-phx-sm font-black uppercase tracking-[0.1em] text-sky-800">On leave</p>
                  ) : (
                    <p className="text-phx-sm text-slate-400">Nothing planned</p>
                  )
                ) : null}
                {day.halves.length > 0 && day.managerOnLeave ? <p className="text-phx-sm font-semibold text-sky-800">The district manager is on approved leave this day</p> : null}
                {day.halves.map((half) => (
                  <Half half={half} key={`${day.date}|${half.half}`} />
                ))}
              </div>
            ))}
          </div>
        )}
        {figures.state === "vacant" ? null : <TeamReps week={week} weekStart={weekStart} />}
      </KpiSection>
    </div>
  );
}

export function DistrictManagerPlansView({ report, show = "all" }: { report: DistrictManagersPlans; show?: DistrictPlanShow }) {
  const listed = filterDistrictPlanWeeks(report.weeks, show);
  return (
    <div className="grid gap-4">
      <DistrictPlansToolbar report={report} show={show} />
      {report.leaveUnread ? (
        <p className="border border-amber-300 bg-amber-50 px-4 py-2 text-phx-sm font-semibold text-amber-900">
          Approved leave could not be read just now, so &quot;On leave&quot; is not shown this time.
        </p>
      ) : null}
      {report.weeks.length === 0 ? (
        <p className="border border-slate-200 bg-white p-4 text-phx-md text-slate-600">No district managers under you yet.</p>
      ) : (
        <>
          <DistrictPlansTiles report={report} />
          <DistrictPlansStandPanel report={report} />
          <DistrictPlansGridPanel report={report} show={show} />
          <DistrictPlansAttentionPanel report={report} show={show} />
          <DistrictPlansCustomersPanel report={report} show={show} />
          <DistrictPlansRepsAlonePanel report={report} show={show} />
          <DistrictPlansChainVisitsPanel report={report} />
        </>
      )}
      {show !== "all" && report.weeks.length > 0 ? (
        <p className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 bg-white px-4 py-2 text-phx-sm text-slate-600">
          <span>
            Listing {listed.length} of {report.weeks.length} district manager seats. The figures above are the whole team&apos;s.
          </span>
          <Link className={LINK} href={districtPlansHref(report.weekStart, "all")}>
            Every seat
          </Link>
        </p>
      ) : null}
      {show !== "all" && listed.length === 0 && report.weeks.length > 0 ? (
        <p className="border border-slate-200 bg-white p-4 text-phx-md text-slate-600">No district manager seat matches this filter this week.</p>
      ) : null}
      {listed.map((week) => (
        <ManagerSection key={`${week.regionName}|${week.districtName}|${week.managerName}|${week.districtSeatId}`} week={week} weekStart={report.weekStart} />
      ))}
    </div>
  );
}
