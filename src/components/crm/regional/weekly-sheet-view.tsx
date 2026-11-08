import Link from "next/link";

import { KpiSection } from "@/components/crm/kpis-chrome";
import { DOCTOR_FAMILY_LABEL, DOCTORS_PER_SPECIALITY } from "@/lib/crm/account-doctor-notes";
import { addDaysIso } from "@/lib/crm/dates";
import type { WeeklySheet, WeeklySheetAccount, WeeklySheetRep } from "@/lib/crm/weekly-sheet";

/**
 * The Weekly Sheet, the Regional Sales Manager's screen. Server-rendered; each rep's accounts open under the rep
 * (a plain disclosure, no client state). Desktop shows tables, a phone shows cards. "Met" and "Below" are words,
 * never a colour alone; a comment naming no doctor says so instead of a zero.
 */

function Result({ met }: { met: boolean }) {
  return met ? (
    <span className="border border-emerald-300 bg-emerald-50 px-1.5 py-px text-phx-3xs font-black uppercase tracking-wide text-emerald-800">Met</span>
  ) : (
    <span className="border border-amber-300 bg-amber-50 px-1.5 py-px text-phx-3xs font-black uppercase tracking-wide text-amber-800">Below</span>
  );
}

function Figure({ value, target }: { value: number; target: number }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-phx-xs font-black tabular-nums text-slate-900">
        {value} of {target}
      </span>
      <Result met={value >= target} />
    </span>
  );
}

function Depth({ account, family }: { account: WeeklySheetAccount; family: "pediatrics" | "internal" | "ent" }) {
  const value = account.depth[family];
  return <span className={`tabular-nums ${value >= DOCTORS_PER_SPECIALITY ? "font-black text-slate-900" : "font-semibold text-amber-800"}`}>{value}</span>;
}

function Accounts({ rep }: { rep: WeeklySheetRep }) {
  if (rep.accounts.length === 0) return <p className="px-4 py-3 text-phx-2xs text-slate-500">No AM accounts visited this week.</p>;
  return (
    <>
      <table className="hidden w-full table-fixed text-left md:table">
        <colgroup>
          <col className="w-[34%]" />
          <col className="w-[8%]" />
          <col className="w-[13%]" />
          <col className="w-[17%]" />
          <col className="w-[10%]" />
          <col className="w-[18%]" />
        </colgroup>
        <thead>
          <tr className="border-y border-slate-200 bg-slate-50 text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">
            <th className="px-4 py-2">Account</th>
            <th className="px-2 py-2">Visits</th>
            <th className="px-2 py-2">{DOCTOR_FAMILY_LABEL.pediatrics}</th>
            <th className="px-2 py-2">{DOCTOR_FAMILY_LABEL.internal}</th>
            <th className="px-2 py-2">{DOCTOR_FAMILY_LABEL.ent}</th>
            <th className="px-4 py-2">3 of each</th>
          </tr>
        </thead>
        <tbody>
          {rep.accounts.map((account) => (
            <tr className="border-b border-slate-100 align-top text-phx-xs last:border-b-0" key={account.customerId}>
              <td className="break-words px-4 py-2 font-semibold text-slate-900" dir="auto">
                {account.name}
              </td>
              <td className="px-2 py-2 tabular-nums">{account.visits}</td>
              {account.depth.noDoctorsWritten ? (
                <td className="px-2 py-2 text-phx-2xs font-semibold text-slate-500" colSpan={3}>
                  No doctors written in the comment
                </td>
              ) : (
                <>
                  <td className="px-2 py-2">
                    <Depth account={account} family="pediatrics" />
                  </td>
                  <td className="px-2 py-2">
                    <Depth account={account} family="internal" />
                  </td>
                  <td className="px-2 py-2">
                    <Depth account={account} family="ent" />
                  </td>
                </>
              )}
              <td className="px-4 py-2">
                <Result met={account.depth.met} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid divide-y divide-slate-100 border-t border-slate-200 md:hidden">
        {rep.accounts.map((account) => (
          <div className="grid gap-1 px-4 py-3" key={account.customerId}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 break-words text-phx-xs font-black text-slate-900" dir="auto">
                {account.name}
              </p>
              <Result met={account.depth.met} />
            </div>
            <p className="text-phx-2xs text-slate-600">
              {account.visits} {account.visits === 1 ? "visit" : "visits"}
            </p>
            {account.depth.noDoctorsWritten ? (
              <p className="text-phx-2xs font-semibold text-slate-500">No doctors written in the comment</p>
            ) : (
              <p className="text-phx-2xs text-slate-700">
                {DOCTOR_FAMILY_LABEL.pediatrics} <Depth account={account} family="pediatrics" /> · {DOCTOR_FAMILY_LABEL.internal}{" "}
                <Depth account={account} family="internal" /> · {DOCTOR_FAMILY_LABEL.ent} <Depth account={account} family="ent" />
              </p>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function RepBlock({ rep }: { rep: WeeklySheetRep }) {
  return (
    <details className="group border-b border-slate-100 last:border-b-0">
      <summary className="grid cursor-pointer list-none gap-2 px-4 py-3 hover:bg-slate-50 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1fr)] md:items-start md:gap-3">
        <div className="min-w-0">
          <p className="break-words text-phx-xs font-black text-slate-900">{rep.person}</p>
          <p className="break-words text-phx-2xs text-slate-500">
            {rep.territory} · {rep.workingDays} working {rep.workingDays === 1 ? "day" : "days"}
            {rep.leaveDays > 0 ? ` · ${rep.leaveDays} on leave` : ""}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500 md:hidden">PM</p>
          <Figure target={rep.pmTarget} value={rep.pm} />
        </div>
        <div className="min-w-0">
          <p className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500 md:hidden">AM</p>
          <Figure target={rep.amTarget} value={rep.am} />
        </div>
        <div className="min-w-0">
          <p className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500 md:hidden">Pharmacies</p>
          <p className="text-phx-xs font-black tabular-nums text-slate-900">{rep.pharmacies}</p>
          {rep.waiting > 0 ? <p className="text-phx-3xs font-semibold text-amber-700">{rep.waiting} waiting for validation</p> : null}
        </div>
        <div className="min-w-0">
          <p className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500 md:hidden">Accounts with 3 of each</p>
          <p className="text-phx-xs font-black tabular-nums text-slate-900">
            {rep.accountsMet} of {rep.accounts.length}
          </p>
          <p className="text-phx-3xs font-black uppercase tracking-[0.1em] text-orange-700 group-open:hidden">Show accounts</p>
          <p className="hidden text-phx-3xs font-black uppercase tracking-[0.1em] text-orange-700 group-open:block">Hide accounts</p>
        </div>
      </summary>
      <Accounts rep={rep} />
    </details>
  );
}

export function WeeklySheetView({ sheet }: { sheet: WeeklySheet }) {
  const linkClass = "border border-slate-300 bg-white px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-50";
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 bg-white px-4 py-3">
        <div>
          <p className="text-phx-xs font-black text-slate-900">Week · {sheet.label}</p>
          <p className="text-phx-2xs text-slate-500">
            Target per working day: 10 PM and 2 AM — 50 PM and 10 AM in a full week. Leave and national holidays come out of the target.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className={linkClass} href={`/employee-portals/weekly-sheet?week=${addDaysIso(sheet.weekStart, -7)}`}>
            Previous week
          </Link>
          <Link className={linkClass} href={`/employee-portals/weekly-sheet?week=${addDaysIso(sheet.weekStart, 7)}`}>
            Next week
          </Link>
          <a className={linkClass} href={`/api/crm/weekly-sheet/export?week=${sheet.weekStart}`}>
            Download Excel
          </a>
        </div>
      </div>
      {sheet.targetsUncertain ? (
        <p className="border border-amber-300 bg-amber-50 px-4 py-2 text-phx-2xs font-semibold text-amber-900">
          The holiday calendar or approved leave could not be read just now, so a target may be one day too high.
        </p>
      ) : null}
      {sheet.districts.length === 0 ? <p className="border border-slate-200 bg-white p-4 text-phx-xs text-slate-600">No reps under your district managers yet.</p> : null}
      {sheet.districts.map((district) => (
        <div className="border border-slate-200" key={`${district.districtName}|${district.managerName}`}>
          <KpiSection description={district.districtName} title={district.managerName}>
            <div className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1fr)] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500 md:grid">
              <span>Rep</span>
              <span>PM</span>
              <span>AM</span>
              <span>Pharmacies</span>
              <span>Accounts with 3 of each</span>
            </div>
            {district.reps.map((rep) => (
              <RepBlock key={rep.seatId} rep={rep} />
            ))}
          </KpiSection>
        </div>
      ))}
    </div>
  );
}
