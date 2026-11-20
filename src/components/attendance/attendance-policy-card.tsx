import { Clock, Info } from "lucide-react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { LANDING_INK, LandingTitle } from "@/components/employee-portal/landing-kit";
import type { AttendancePolicyExplainer } from "@/lib/attendance/policy-explainer";

/**
 * The attendance policy, shown to the employee it is applied to.
 *
 * Every figure here comes from `buildAttendancePolicyExplainer`, which drives the
 * real payroll engines — nothing on this card is written by hand, so it cannot drift
 * away from what the deduction actually is.
 *
 * Layout follows the fits-the-screen golden rule: `table-fixed` over a `<colgroup>`
 * with no `overflow-x-auto` anywhere, and the six columns collapse to one card per
 * example below `md` rather than being shrunk. Long cell text wraps; nothing is
 * truncated.
 */

const CARD = `min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`;

const COLUMNS = ["Clock in", "Clock out", "Worked", "Late", "Short", "Deduction"] as const;

function DeductionText({ note, value }: { note: string; value: string }) {
  if (value === "None") {
    return <span className="font-bold text-emerald-700">None</span>;
  }
  return (
    <span className={`break-words font-bold ${LANDING_INK}`}>
      {value}
      {note ? <span className="block font-semibold text-slate-500">({note})</span> : null}
    </span>
  );
}

function BracketScale({ items, label }: { items: AttendancePolicyExplainer["lateBrackets"]; label: string }) {
  if (items.length === 0) return null;
  return (
    <div className="min-w-0">
      <p className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">{label}</p>
      <ul className="mt-1.5 divide-y divide-slate-200 border-y border-slate-200">
        {items.map((item) => (
          <li className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5 text-phx-sm" key={`${label}-${item.range}`}>
            <span className="font-semibold tabular-nums text-slate-600">{item.range}</span>
            <span className={`font-bold tabular-nums ${LANDING_INK}`}>{item.deduction}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AttendancePolicyCard({ explainer }: { explainer: AttendancePolicyExplainer }) {
  return (
    <section className={CARD}>
      {/* Header — the policy this person is actually on. */}
      <header className="border-b border-slate-200 px-3 py-2.5 sm:px-4">
        <LandingTitle>How your attendance is judged</LandingTitle>
      </header>
      <div className="border-b border-slate-200 px-3 py-3 sm:px-4">
        <h3 className={`break-words text-phx-base font-black ${LANDING_INK}`}>{explainer.title}</h3>
        <p className="mt-0.5 break-words text-phx-sm font-semibold text-slate-500">{explainer.policyName}</p>

        {/* The headline facts, as hairline tags. */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {explainer.facts.map((fact) => (
            <span
              className={`inline-flex items-center border border-slate-200 px-2.5 py-1 text-phx-sm font-bold ${LANDING_INK}`}
              key={fact}
            >
              {fact}
            </span>
          ))}
        </div>
      </div>

      {/* The rules the table below demonstrates. */}
      <ul className="space-y-1.5 border-b border-slate-200 px-3 py-3 sm:px-4">
        {explainer.rules.map((rule) => (
          <li className="flex gap-2 text-phx-sm font-semibold leading-relaxed text-slate-600" key={rule}>
            <span className="mt-1.5 h-1 w-1 shrink-0 bg-[#08111f]" aria-hidden="true" />
            <span className="min-w-0 break-words">{rule}</span>
          </li>
        ))}
      </ul>

      {/* Mobile: one row per example. Desktop tables never render here — the six
          columns would force a horizontal scroll at 375px. */}
      <div className="divide-y divide-slate-200 md:hidden">
        {explainer.rows.map((row, index) => (
          <div className="px-3 py-3" key={`m-${index}-${row.clockIn}-${row.clockOut}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`inline-flex items-center gap-1.5 text-phx-sm font-bold tabular-nums ${LANDING_INK}`}>
                <Clock aria-hidden="true" className="h-3 w-3 shrink-0 text-slate-400" />
                {row.clockIn} — {row.clockOut}
              </span>
              <span className="text-phx-sm font-bold tabular-nums text-slate-700">{row.worked}</span>
            </div>
            <dl className="mt-2.5 grid grid-cols-3 divide-x divide-slate-200 border-y border-slate-200">
              <div className="min-w-0 px-2 py-1.5">
                <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">Late</dt>
                <dd className="mt-0.5 break-words text-phx-sm font-semibold text-slate-700">{row.late}</dd>
              </div>
              <div className="min-w-0 px-2 py-1.5">
                <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">Short</dt>
                <dd className="mt-0.5 break-words text-phx-sm font-semibold text-slate-700">{row.short}</dd>
              </div>
              <div className="min-w-0 px-2 py-1.5">
                <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">Deduction</dt>
                <dd className="mt-0.5 text-phx-sm">
                  <DeductionText note={row.deductionNote} value={row.deduction} />
                </dd>
              </div>
            </dl>
          </div>
        ))}
      </div>

      {/* Desktop: the full six-column table, fixed so it can never scroll sideways. */}
      <div className="hidden px-3 py-3 sm:px-4 md:block">
        <table className="w-full table-fixed text-phx-md">
          <colgroup>
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[12%]" />
            <col className="w-[21%]" />
            <col className="w-[21%]" />
            <col className="w-[20%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200">
              {COLUMNS.map((column) => (
                <th
                  className="px-3 py-2.5 text-left text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500"
                  key={column}
                  scope="col"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {explainer.rows.map((row, index) => (
              <tr
                className="align-top"
                key={`d-${index}-${row.clockIn}-${row.clockOut}`}
              >
                <td className={`break-words px-3 py-2.5 text-phx-sm font-bold tabular-nums ${LANDING_INK}`}>{row.clockIn}</td>
                <td className={`break-words px-3 py-2.5 text-phx-sm font-bold tabular-nums ${LANDING_INK}`}>{row.clockOut}</td>
                <td className="break-words px-3 py-2.5 text-phx-sm font-bold tabular-nums text-slate-700">{row.worked}</td>
                <td className="break-words px-3 py-2.5 text-phx-sm font-semibold text-slate-600">{row.late}</td>
                <td className="break-words px-3 py-2.5 text-phx-sm font-semibold text-slate-600">{row.short}</td>
                <td className="break-words px-3 py-2.5 text-phx-sm">
                  <DeductionText note={row.deductionNote} value={row.deduction} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The deduction scale actually stored against this policy. */}
      <div className="border-t border-slate-200 px-3 py-3 sm:px-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <BracketScale items={explainer.lateBrackets} label="Late arrival" />
          <BracketScale
            items={explainer.shortBrackets}
            label={explainer.model === "flexible" ? "Short of the required hours" : "Leaving early"}
          />
        </div>
        <p className="mt-3 flex gap-2 text-phx-xs font-semibold leading-relaxed text-slate-500">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
          <span className="min-w-0">
            These examples are generated from your own policy, so they always match the deduction the system
            applies. If your schedule changes, this table changes with it.
          </span>
        </p>
      </div>
    </section>
  );
}
