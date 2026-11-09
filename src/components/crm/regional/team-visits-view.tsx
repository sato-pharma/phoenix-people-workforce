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
  return (
    <p className="text-phx-xs font-black tabular-nums text-slate-900">
      {day.am} AM · {day.pm} PM · {day.pharmacies} Pharmacies
      {day.waiting > 0 ? <span className="ml-1 font-semibold text-amber-700">· {day.waiting} waiting for validation</span> : null}
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
                <li className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-phx-3xs" key={index}>
                  <span className="font-semibold tabular-nums text-slate-700">{time.savedAt ?? "No time recorded"}</span>
                  <span className="break-words font-semibold text-slate-900">{time.customer ?? "Customer not recorded"}</span>
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
                <tr className={`border-b border-slate-100 align-top ${MANAGER_ROW}`}>
                  <td className="break-words px-4 py-3">
                    <p className={MANAGER_NAME}>{district.managerName}</p>
                    <p className={MANAGER_NOTE}>District manager · the reps&apos; total, then own visits, counted in no rep&apos;s figure</p>
                  </td>
                  <td className="px-4 py-3">
                    <RepsTotal day={district.repsTotal.yesterday} />
                    {district.managerOwn ? <><OwnLabel /><DayCell day={district.managerOwn.yesterday} href={null} /></> : null}
                  </td>
                  <td className="px-4 py-3">
                    <RepsTotal day={district.repsTotal.today} />
                    {district.managerOwn ? <><OwnLabel /><DayCell day={district.managerOwn.today} href={null} /></> : null}
                  </td>
                </tr>
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
              <div className={`grid gap-2 p-4 ${MANAGER_ROW}`}>
                <div>
                  <p className={MANAGER_NAME}>{district.managerName}</p>
                  <p className={MANAGER_NOTE}>District manager · the reps&apos; total, then own visits, counted in no rep&apos;s figure</p>
                </div>
                <p className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">Yesterday · {yesterday}</p>
                <RepsTotal day={district.repsTotal.yesterday} />
                {district.managerOwn ? <><OwnLabel /><DayCell day={district.managerOwn.yesterday} href={null} /></> : null}
                <p className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">Today · {today}</p>
                <RepsTotal day={district.repsTotal.today} />
                {district.managerOwn ? <><OwnLabel /><DayCell day={district.managerOwn.today} href={null} /></> : null}
              </div>
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
