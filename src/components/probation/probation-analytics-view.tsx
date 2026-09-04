"use client";

import type { OutcomesAnalytics, OutcomeGroup } from "@/lib/probation/intelligence/outcomes-analytics";

// Historical outcomes analytics view (Enhancement E4). Read-only. Shows pass/terminate rates + average
// frozen score by line, manager, and decision month, plus evaluator predictiveness. Names, never codes.

const REC_LABEL: Record<string, string> = {
  on_track: "On track",
  needs_improvement: "Needs improvement",
  serious_concern: "Serious concern",
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function OutcomeTable({ title, groups, firstColLabel }: { title: string; groups: OutcomeGroup[]; firstColLabel: string }) {
  if (groups.length === 0) return null;
  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <h2 className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700">{title}</h2>
      {/*
        Fits-the-screen golden rule (AGENTS.md §4). This was `overflow-x-auto` over a
        `min-w-[560px]` floor with no mobile alternative anywhere in this file, so on a 375px
        phone the pass rate and average score — the two numbers the table exists to show — were
        off the right edge behind a scroll.

        Every cell here is a short label or a number, so `table-fixed` + `<colgroup>` fits all
        six columns at any width; the headers wrap on a narrow screen, which is the rule's
        permitted answer. No column is dropped and no type is shrunk.
      */}
      <div>
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[26%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[17%]" />
            <col className="w-[16%]" />
            <col className="w-[15%]" />
          </colgroup>
          <thead className="bg-slate-50 text-left text-phx-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="break-words px-3 py-2">{firstColLabel}</th>
              <th className="break-words px-3 py-2">Decided</th>
              <th className="break-words px-3 py-2">Passed</th>
              <th className="break-words px-3 py-2">Terminated</th>
              <th className="break-words px-3 py-2">Pass rate</th>
              <th className="break-words px-3 py-2">Avg score</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key} className="border-t border-slate-100">
                <td className="break-words px-3 py-2 font-medium text-slate-800">{g.label}</td>
                <td className="px-3 py-2 text-slate-700">{g.total}</td>
                <td className="px-3 py-2 text-emerald-700">{g.passCount}</td>
                <td className="px-3 py-2 text-rose-700">{g.terminateCount}</td>
                <td className="px-3 py-2 text-slate-700">{pct(g.passRate)}</td>
                <td className="px-3 py-2 text-slate-700">{g.avgScore ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ProbationAnalyticsView({ data }: { data: OutcomesAnalytics }) {
  const o = data.overall;

  if (data.totalDecided === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        No probation cases have been decided yet. Outcome analytics appear once cases reach a pass/terminate decision.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Headline tiles */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: "Decided", value: String(o.total), tone: "text-slate-800" },
          { label: "Passed", value: String(o.passCount), tone: "text-emerald-700" },
          { label: "Terminated", value: String(o.terminateCount), tone: "text-rose-700" },
          { label: "Pass rate", value: pct(o.passRate), tone: "text-slate-800" },
        ].map((t) => (
          <div key={t.label} className="rounded border border-slate-200 bg-white p-3">
            <div className={`text-xl font-semibold ${t.tone}`}>{t.value}</div>
            <div className="text-phx-xs text-slate-500">{t.label}</div>
          </div>
        ))}
      </div>

      <OutcomeTable title="By line" groups={data.byLine} firstColLabel="Line" />
      <OutcomeTable title="By manager" groups={data.byManager} firstColLabel="Manager" />
      <OutcomeTable title="By decision month" groups={data.byMonth} firstColLabel="Month" />

      {/* Evaluator predictiveness */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <h2 className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700">
          Evaluator predictiveness
          <span className="ml-2 font-normal text-slate-400">
            how often a feedback recommendation matched the eventual decision
          </span>
        </h2>
        {/* Same fix as the outcome table above: no floor, fixed columns, headers wrap. */}
        <div>
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-[30%]" />
              <col className="w-[15%]" />
              <col className="w-[17%]" />
              <col className="w-[20%]" />
              <col className="w-[18%]" />
            </colgroup>
            <thead className="bg-slate-50 text-left text-phx-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="break-words px-3 py-2">Recommendation</th>
                <th className="break-words px-3 py-2">Feedbacks</th>
                <th className="break-words px-3 py-2">→ Passed</th>
                <th className="break-words px-3 py-2">→ Terminated</th>
                <th className="break-words px-3 py-2">Alignment</th>
              </tr>
            </thead>
            <tbody>
              {data.predictiveness.map((p) => (
                <tr key={p.recommendation} className="border-t border-slate-100">
                  <td className="break-words px-3 py-2 font-medium text-slate-800">{REC_LABEL[p.recommendation] ?? p.recommendation}</td>
                  <td className="px-3 py-2 text-slate-700">{p.total}</td>
                  <td className="px-3 py-2 text-emerald-700">{p.endedInPass}</td>
                  <td className="px-3 py-2 text-rose-700">{p.endedInTerminate}</td>
                  <td className="px-3 py-2 text-slate-700">{p.total > 0 ? pct(p.alignmentRate) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-phx-xs text-slate-400">
        {data.totalDecided} decided case{data.totalDecided === 1 ? "" : "s"} · scores frozen at decision time · generated{" "}
        {data.generatedAt.slice(0, 16).replace("T", " ")}
      </p>
    </div>
  );
}
