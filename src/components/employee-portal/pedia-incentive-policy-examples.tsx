"use client";

import { Card } from "@/components/ui/card";
import {
  PEDIA_POLICY_CLAUSES,
  PEDIA_POLICY_EXAMPLE_BASIC_SALARY,
  buildPediaPolicyExamples,
  type PediaPolicyExample,
} from "@/lib/incentives/pedia-policy-examples";
import { PEDIA_SATO_HALF_MIN_TOTAL_PERCENT } from "@/lib/incentives/pedia-split";

/**
 * The Pedia incentive policy, written out in full with worked examples (owner, 2026-11-12).
 *
 * Every figure comes from buildPediaPolicyExamples, which calls the live rule — never typed here.
 * Fits the screen at every width: a fixed-layout table once the card itself is wide enough, ruled
 * cards below that (the card measures its own width, because it can sit beside the sidebar).
 * Nothing is truncated; long words wrap.
 */

const amount = (value: number) => Math.round(value).toLocaleString("en-US");
const percent = (value: number) => `${Number.isInteger(value) ? value : value.toFixed(1)}%`;

function HalfCell({ value, curve, withheld }: { value: number; curve: number; withheld?: boolean }) {
  if (withheld) {
    return (
      <span className="block text-right">
        <span className="block font-mono font-black tabular-nums text-slate-900">0</span>
        <span className="block text-phx-xs font-bold leading-snug text-red-700">Not paid: total under {PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}%</span>
      </span>
    );
  }
  return (
    <span className="block text-right">
      <span className="block font-mono font-black tabular-nums text-slate-900">{amount(value)}</span>
      <span className="block text-phx-xs font-medium text-slate-500">{percent(curve)} of a month</span>
    </span>
  );
}

function ExampleMobileCard({ row, index }: { row: PediaPolicyExample; index: number }) {
  return (
    <div className="border border-slate-200 border-l-[3px] border-l-orange-400 bg-white px-3 py-2.5">
      <p className="text-phx-sm font-bold text-slate-800">
        {index + 1}. {row.title}
      </p>
      <p className="mt-0.5 text-phx-sm font-semibold text-slate-600">
        Sato {percent(row.satoAchievementPercent)} · Total {percent(row.totalAchievementPercent)}
      </p>
      <dl className="mt-2 grid grid-cols-3 gap-2 border-t border-slate-100 pt-2">
        <div className="min-w-0">
          <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-400">Sato half</dt>
          <dd className="font-mono text-phx-sm font-black tabular-nums text-slate-900">
            {row.satoHalfWithheld ? "0" : amount(row.satoHalfAmount)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-400">Total half</dt>
          <dd className="font-mono text-phx-sm font-black tabular-nums text-slate-900">{amount(row.totalHalfAmount)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-400">Paid</dt>
          <dd className="font-mono text-phx-sm font-black tabular-nums text-slate-900">{amount(row.payoutAmount)}</dd>
        </div>
      </dl>
      <p className="mt-2 break-words text-phx-sm leading-relaxed text-slate-600">{row.explanation}</p>
    </div>
  );
}

export function PediaIncentivePolicyExamplesCard() {
  const examples = buildPediaPolicyExamples();
  const basic = amount(PEDIA_POLICY_EXAMPLE_BASIC_SALARY);

  return (
    <Card className="@container rounded border border-slate-200 bg-white p-5 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
      <div className="mb-4 flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-sm bg-orange-500" />
        <p className="text-phx-lg font-bold tracking-tight text-slate-900">Pedia Incentive Policy - With Examples</p>
      </div>

      <ol className="grid gap-2 @3xl:grid-cols-2">
        {PEDIA_POLICY_CLAUSES.map((clause, index) => (
          <li className="border border-slate-100 bg-slate-50/60 px-3 py-2.5" key={clause.title}>
            <p className="text-phx-sm font-bold text-slate-800">
              {index + 1}. {clause.title}
            </p>
            <p className="mt-0.5 break-words text-phx-sm leading-relaxed text-slate-600">{clause.body}</p>
          </li>
        ))}
      </ol>

      <div className="mt-5 border-t border-slate-200 pt-4">
        <p className="text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-400">Worked examples</p>
        <p className="mt-1 text-phx-sm leading-relaxed text-slate-600">
          Every example uses a basic salary of EGP {basic}, so one half is worth EGP {basic} at 100% and
          the semester incentive is EGP {amount(PEDIA_POLICY_EXAMPLE_BASIC_SALARY * 2)}. Amounts are in
          EGP. Your own amounts follow the same rule on your own basic salary.
        </p>

        {/* Narrow card: ruled cards, one per example. */}
        <div className="mt-3 space-y-2 @3xl:hidden">
          {examples.map((row, index) => (
            <ExampleMobileCard index={index} key={row.key} row={row} />
          ))}
        </div>

        {/* Wide card: one fixed-layout table that fits its width — no sideways scroll. */}
        <table className="mt-3 hidden w-full table-fixed border-collapse text-phx-sm @3xl:table">
          <colgroup>
            <col className="w-[40%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[14%]" />
            <col className="w-[14%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-400">
              <th className="px-2 py-2 text-left">Example</th>
              <th className="px-2 py-2 text-right">Sato</th>
              <th className="px-2 py-2 text-right">Total</th>
              <th className="px-2 py-2 text-right">Sato half</th>
              <th className="px-2 py-2 text-right">Total half</th>
              <th className="px-2 py-2 text-right">Paid</th>
            </tr>
          </thead>
          <tbody>
            {examples.map((row, index) => (
              <tr className="border-b border-slate-100 align-top even:bg-slate-50/60" key={row.key}>
                <td className="px-2 py-2.5">
                  <p className="font-bold text-slate-800">
                    {index + 1}. {row.title}
                  </p>
                  <p className="mt-0.5 break-words leading-relaxed text-slate-600">{row.explanation}</p>
                </td>
                <td className="px-2 py-2.5 text-right font-semibold tabular-nums text-slate-700">
                  {percent(row.satoAchievementPercent)}
                </td>
                <td className="px-2 py-2.5 text-right font-semibold tabular-nums text-slate-700">
                  {percent(row.totalAchievementPercent)}
                </td>
                <td className="px-2 py-2.5">
                  <HalfCell curve={row.satoCurvePercent} value={row.satoHalfAmount} withheld={row.satoHalfWithheld} />
                </td>
                <td className="px-2 py-2.5">
                  <HalfCell curve={row.totalCurvePercent} value={row.totalHalfAmount} />
                </td>
                <td className="px-2 py-2.5 text-right font-mono font-black tabular-nums text-slate-900">
                  {amount(row.payoutAmount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
