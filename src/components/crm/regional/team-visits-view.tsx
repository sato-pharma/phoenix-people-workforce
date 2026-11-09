import Link from "next/link";

import { KpiSection, KpiTile } from "@/components/crm/kpis-chrome";
import { cairoDate } from "@/lib/format/cairo-datetime";
import { regionGroupCaption, regionManagerTitle } from "@/lib/phoenix-crm/region-manager-groups";
import type { TeamVisitDay, TeamVisitsReport } from "@/lib/phoenix-crm/server/team-visits";

/**
 * Visits — Yesterday and Today, the Regional Sales Manager's screen. Server-rendered: the page holds no client
 * state and the figures are read on every load. One section per region and its district manager, one row per rep, the two days
 * side by side; on a phone each rep is a card. AM · PM · Pharmacies are always three figures apart.
 */

function dayLabel(iso: string): string {
  return cairoDate(`${iso}T12:00:00Z`);
}

function Figures({ day }: { day: TeamVisitDay }) {
  return (
    <p className="text-phx-xs font-black tabular-nums text-slate-900">
      {day.am} AM · {day.pm} PM · {day.pharmacies} Pharmacies
      {day.waiting > 0 ? <span className="ml-1 font-semibold text-amber-700">· {day.waiting} waiting for validation</span> : null}
    </p>
  );
}

function Times({ day }: { day: TeamVisitDay }) {
  if (day.times.length === 0) return <p className="mt-1 text-phx-2xs text-slate-400">No visits saved</p>;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1">
      {day.times.map((time, index) => (
        <li className="border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-phx-3xs font-semibold tabular-nums text-slate-700" key={index}>
          {time.savedAt ?? "No time recorded"} · {time.list}
        </li>
      ))}
    </ul>
  );
}

function DayCell({ day, href }: { day: TeamVisitDay; href: string | null }) {
  return (
    <div className="min-w-0">
      <Figures day={day} />
      <Times day={day} />
      {href && day.times.length > 0 ? (
        <Link className="mt-1 inline-block text-phx-3xs font-black uppercase tracking-[0.1em] text-orange-700 hover:underline" href={href}>
          Open the day
        </Link>
      ) : null}
    </div>
  );
}

export function TeamVisitsView({ report }: { report: TeamVisitsReport }) {
  const yesterday = dayLabel(report.yesterday);
  const today = dayLabel(report.today);
  // `from=team-visits` gives the day page its "Back to all reps" bar, back to this screen.
  const dayHref = (seatId: string, on: string) => `/employee-portals/field-crm/day/${encodeURIComponent(seatId)}/${on}?from=team-visits`;
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <KpiTile
          caption={`${report.totals.yesterday.am} AM · ${report.totals.yesterday.pm} PM · ${report.totals.yesterday.pharmacies} Pharmacies`}
          label={`Yesterday · ${yesterday}`}
          value={String(report.totals.yesterday.am + report.totals.yesterday.pm)}
        />
        <KpiTile
          caption={`${report.totals.today.am} AM · ${report.totals.today.pm} PM · ${report.totals.today.pharmacies} Pharmacies`}
          label={`Today · ${today}`}
          value={String(report.totals.today.am + report.totals.today.pm)}
        />
      </div>
      {report.districts.length === 0 ? (
        <p className="border border-slate-200 bg-white p-4 text-phx-xs text-slate-600">No reps under your district managers yet.</p>
      ) : null}
      {report.districts.map((district) => (
        <div className="border border-slate-200" key={`${district.regionName}|${district.districtName}|${district.managerName}`}>
          <KpiSection description={regionGroupCaption(district.reps.length, district.vacantSeats)} title={regionManagerTitle(district.regionName, district.managerName)}>
            <table className="hidden w-full table-fixed text-left md:table">
              <colgroup>
                <col className="w-[26%]" />
                <col className="w-[37%]" />
                <col className="w-[37%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">
                  <th className="px-4 py-2">Rep</th>
                  <th className="px-4 py-2">Yesterday · {yesterday}</th>
                  <th className="px-4 py-2">Today · {today}</th>
                </tr>
              </thead>
              <tbody>
                {district.managerOwn ? (
                  <tr className="border-b border-slate-100 bg-orange-50/40 align-top">
                    <td className="break-words px-4 py-3">
                      <p className="text-phx-xs font-black text-slate-900">{district.managerName}</p>
                      <p className="text-phx-2xs text-slate-500">District manager · own visits, counted in no rep&apos;s figure</p>
                    </td>
                    <td className="px-4 py-3"><DayCell day={district.managerOwn.yesterday} href={null} /></td>
                    <td className="px-4 py-3"><DayCell day={district.managerOwn.today} href={null} /></td>
                  </tr>
                ) : null}
                {district.reps.map((rep) => (
                  <tr className="border-b border-slate-100 align-top last:border-b-0" key={rep.seatId}>
                    <td className="break-words px-4 py-3">
                      <p className="text-phx-xs font-black text-slate-900">{rep.person}</p>
                      <p className="text-phx-2xs text-slate-500">{rep.territory}</p>
                    </td>
                    <td className="px-4 py-3"><DayCell day={rep.yesterday} href={dayHref(rep.seatId, report.yesterday)} /></td>
                    <td className="px-4 py-3"><DayCell day={rep.today} href={dayHref(rep.seatId, report.today)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="grid divide-y divide-slate-100 md:hidden">
              {district.managerOwn ? (
                <div className="grid gap-2 bg-orange-50/40 p-4">
                  <div>
                    <p className="text-phx-xs font-black text-slate-900">{district.managerName}</p>
                    <p className="text-phx-2xs text-slate-500">District manager · own visits, counted in no rep&apos;s figure</p>
                  </div>
                  <p className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">Yesterday · {yesterday}</p>
                  <DayCell day={district.managerOwn.yesterday} href={null} />
                  <p className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">Today · {today}</p>
                  <DayCell day={district.managerOwn.today} href={null} />
                </div>
              ) : null}
              {district.reps.map((rep) => (
                <div className="grid gap-2 p-4" key={rep.seatId}>
                  <div>
                    <p className="text-phx-xs font-black text-slate-900">{rep.person}</p>
                    <p className="text-phx-2xs text-slate-500">{rep.territory}</p>
                  </div>
                  <p className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">Yesterday · {yesterday}</p>
                  <DayCell day={rep.yesterday} href={dayHref(rep.seatId, report.yesterday)} />
                  <p className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">Today · {today}</p>
                  <DayCell day={rep.today} href={dayHref(rep.seatId, report.today)} />
                </div>
              ))}
            </div>
          </KpiSection>
        </div>
      ))}
    </div>
  );
}
