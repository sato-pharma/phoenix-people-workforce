import Link from "next/link";
import { Users } from "lucide-react";

import { KpiSection } from "@/components/crm/kpis-chrome";
import { addDaysIso } from "@/lib/crm/dates";
import { cairoDate } from "@/lib/format/cairo-datetime";
import type { DistrictManagersPlans, DistrictPlanHalf } from "@/lib/phoenix-crm/server/manager-plan-bookings";
import { regionGroupCaption, regionManagerTitle } from "@/lib/phoenix-crm/region-manager-groups";

/**
 * District Managers' Plans, the Regional Sales Manager's screen. Server-rendered. One section per district
 * manager, one block per day, the AM and PM halves under it. A chain visit is a neutral sky line with the
 * people icon — never red, never a warning (owner, 2026-10-24). A week he has not sent reads "Not sent yet".
 */

function dayLabel(iso: string): string {
  return cairoDate(`${iso}T12:00:00Z`);
}

function Half({ half }: { half: DistrictPlanHalf }) {
  return (
    <div className="grid min-w-0 gap-1 border-l-2 border-slate-200 pl-3">
      <p className="break-words text-phx-xs font-black text-slate-900">
        <span className="mr-1.5 text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">{half.half}</span>
        {half.text}
        {half.repDay ? <span className="ml-1.5 text-phx-2xs font-semibold text-slate-500">· Rep&apos;s day: {half.repDay}</span> : null}
      </p>
      {half.customers.length > 0 ? (
        <p className="break-words text-phx-2xs text-slate-600">{half.customers.join(" · ")}</p>
      ) : null}
      {half.chainVisits.map((line) => (
        <p className="flex items-start gap-1.5 break-words text-phx-2xs font-semibold text-sky-800" key={line}>
          <Users aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{line}</span>
        </p>
      ))}
    </div>
  );
}

export function DistrictManagerPlansView({ report }: { report: DistrictManagersPlans }) {
  const previous = addDaysIso(report.weekStart, -7);
  const next = addDaysIso(report.weekStart, 7);
  const linkClass = "border border-slate-300 bg-white px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-50";
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 bg-white px-4 py-3">
        <p className="text-phx-xs font-black text-slate-900">
          Week · {dayLabel(report.weekStart)} – {dayLabel(report.weekEnd)}
        </p>
        <div className="flex flex-wrap gap-2">
          <Link className={linkClass} href={`/employee-portals/district-manager-plans?week=${previous}`}>
            Previous week
          </Link>
          <Link className={linkClass} href="/employee-portals/district-manager-plans">
            This week
          </Link>
          <Link className={linkClass} href={`/employee-portals/district-manager-plans?week=${next}`}>
            Next week
          </Link>
        </div>
      </div>
      {report.leaveUnread ? (
        <p className="border border-amber-300 bg-amber-50 px-4 py-2 text-phx-2xs font-semibold text-amber-900">
          Approved leave could not be read just now, so &quot;On leave&quot; is not shown this time.
        </p>
      ) : null}
      {report.weeks.length === 0 ? (
        <p className="border border-slate-200 bg-white p-4 text-phx-xs text-slate-600">No district managers under you yet.</p>
      ) : null}
      {report.weeks.map((week) => (
        <div className="border border-slate-200" key={`${week.regionName}|${week.districtName}|${week.managerName}`}>
          <KpiSection description={`${regionGroupCaption(week.repSeats, week.vacantSeats)} · ${week.statusText}`} title={regionManagerTitle(week.regionName, week.managerName)}>
            {!week.sent ? (
              <p className="px-4 py-3 text-phx-xs font-semibold text-slate-600">Not sent yet</p>
            ) : (
              <div className="grid gap-px bg-slate-100 sm:grid-cols-2 xl:grid-cols-3">
                {week.days.map((day) => (
                  <div className="grid content-start gap-2 bg-white p-4" key={day.date}>
                    <p className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">{day.dateText}</p>
                    {day.halves.length === 0 ? <p className="text-phx-2xs text-slate-400">Nothing planned</p> : null}
                    {day.halves.map((half) => (
                      <Half half={half} key={`${day.date}|${half.half}`} />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </KpiSection>
        </div>
      ))}
    </div>
  );
}
