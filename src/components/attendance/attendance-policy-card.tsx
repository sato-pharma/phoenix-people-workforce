import { Clock, Fingerprint, Info } from "lucide-react";

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

const CARD = "border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";

const COLUMNS = ["Clock in", "Clock out", "Worked", "Late", "Short", "Deduction"] as const;

function DeductionText({ note, value }: { note: string; value: string }) {
  if (value === "None") {
    return <span className="font-bold text-emerald-600">None</span>;
  }
  return (
    <span className="font-bold text-slate-900">
      {value}
      {note ? <span className="block font-semibold text-slate-400">({note})</span> : null}
    </span>
  );
}

function BracketScale({ items, label }: { items: AttendancePolicyExplainer["lateBrackets"]; label: string }) {
  if (items.length === 0) return null;
  return (
    <div className="min-w-0">
      <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <ul className="mt-1.5 space-y-1">
        {items.map((item) => (
          <li className="flex flex-wrap items-baseline gap-x-2 text-xs" key={`${label}-${item.range}`}>
            <span className="font-mono font-semibold text-slate-600">{item.range}</span>
            <span className="font-bold text-slate-900">{item.deduction}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AttendancePolicyCard({ explainer }: { explainer: AttendancePolicyExplainer }) {
  return (
    <section className={`overflow-hidden ${CARD}`}>
      {/* Header — the policy this person is actually on. */}
      <div className="border-b border-slate-200 bg-slate-50/70 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-slate-900 text-orange-400">
            <Fingerprint className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-400">
              How your attendance is judged
            </p>
            <h2 className="mt-0.5 text-base font-black tracking-tight text-slate-900">{explainer.title}</h2>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">{explainer.policyName}</p>
          </div>
        </div>

        {/* The headline facts, as chips. */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {explainer.facts.map((fact) => (
            <span
              className="inline-flex items-center bg-white px-2.5 py-1 text-xs font-bold text-slate-700 ring-1 ring-slate-200"
              key={fact}
            >
              {fact}
            </span>
          ))}
        </div>
      </div>

      {/* The rules the table below demonstrates. */}
      <ul className="space-y-1.5 border-b border-slate-200 p-4 sm:p-5">
        {explainer.rules.map((rule) => (
          <li className="flex gap-2 text-xs font-semibold leading-relaxed text-slate-600" key={rule}>
            <span className="mt-1.5 h-1 w-1 shrink-0 bg-orange-500" aria-hidden="true" />
            <span className="min-w-0">{rule}</span>
          </li>
        ))}
      </ul>

      {/* Mobile: one card per example. Desktop tables never render here — the six
          columns would force a horizontal scroll at 375px. */}
      <div className="space-y-2 p-4 md:hidden">
        {explainer.rows.map((row, index) => (
          <div className="border border-slate-200 bg-white p-3" key={`m-${index}-${row.clockIn}-${row.clockOut}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-mono text-xs font-bold text-slate-800">
                <Clock className="h-3 w-3 shrink-0 text-slate-400" />
                {row.clockIn} — {row.clockOut}
              </span>
              <span className="bg-slate-100 px-2 py-0.5 font-mono text-xs font-bold text-slate-700">{row.worked}</span>
            </div>
            <dl className="mt-2.5 grid grid-cols-3 gap-2 text-center">
              <div className="min-w-0">
                <dt className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-400">Late</dt>
                <dd className="mt-0.5 text-xs font-semibold text-slate-700">{row.late}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-400">Short</dt>
                <dd className="mt-0.5 text-xs font-semibold text-slate-700">{row.short}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-400">Deduction</dt>
                <dd className="mt-0.5 text-xs">
                  <DeductionText note={row.deductionNote} value={row.deduction} />
                </dd>
              </div>
            </dl>
          </div>
        ))}
      </div>

      {/* Desktop: the full six-column table, fixed so it can never scroll sideways. */}
      <div className="hidden p-4 sm:p-5 md:block">
        <table className="w-full table-fixed text-sm">
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
                  className="px-3 py-2.5 text-left text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500"
                  key={column}
                  scope="col"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {explainer.rows.map((row, index) => (
              <tr
                className={`align-top ${index % 2 === 0 ? "bg-white" : "bg-slate-50/50"}`}
                key={`d-${index}-${row.clockIn}-${row.clockOut}`}
              >
                <td className="break-words px-3 py-2.5 font-mono text-xs font-bold text-slate-800">{row.clockIn}</td>
                <td className="break-words px-3 py-2.5 font-mono text-xs font-bold text-slate-800">{row.clockOut}</td>
                <td className="break-words px-3 py-2.5 font-mono text-xs font-bold text-slate-700">{row.worked}</td>
                <td className="break-words px-3 py-2.5 text-xs font-semibold text-slate-600">{row.late}</td>
                <td className="break-words px-3 py-2.5 text-xs font-semibold text-slate-600">{row.short}</td>
                <td className="break-words px-3 py-2.5 text-xs">
                  <DeductionText note={row.deductionNote} value={row.deduction} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The deduction scale actually stored against this policy. */}
      <div className="border-t border-slate-200 bg-slate-50/70 p-4 sm:p-5">
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
