import type { ProbationSalesEvidence } from "@/lib/probation/intelligence/sales-evidence";

function egp(value: number): string {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

function percent(value: number | null): string {
  return value === null ? "No target" : `${Math.round(value)}%`;
}

/**
 * The territory's sales against target over the probation months. Display only. Three columns merged
 * from four on a phone (sales and target ride together) rather than a scroller.
 */
export function ProbationSalesEvidencePanel({ evidence }: { evidence: ProbationSalesEvidence }) {
  return (
    <section className="border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Sales against target</h2>
      <p className="mt-1 text-xs text-slate-500">
        The territory&rsquo;s figure from the published Monthly Closing, for the months this person held the seat. A
        new rep inherits it, so read it as context. It is not part of any score.
      </p>
      {evidence.state === "unavailable" ? (
        <p className="mt-3 text-sm font-semibold text-slate-700">The sales figures could not be read just now.</p>
      ) : evidence.months.length === 0 ? (
        <p className="mt-3 text-sm font-semibold text-slate-700">No probation start date on record, so no months to show.</p>
      ) : (
        <table className="mt-3 w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[26%]" />
            <col className="w-[44%]" />
            <col className="w-[30%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 text-xs font-bold uppercase tracking-wide text-slate-500">
              <th className="py-1.5 pr-2" scope="col">Month</th>
              <th className="py-1.5 pr-2" scope="col">Sales / target</th>
              <th className="py-1.5" scope="col">Achieved</th>
            </tr>
          </thead>
          <tbody>
            {evidence.months.map((row) => (
              <tr className="border-b border-slate-100 align-top" key={row.month}>
                <td className="py-1.5 pr-2 font-semibold text-slate-800">{row.label}</td>
                {row.kind === "figure" ? (
                  <>
                    <td className="break-words py-1.5 pr-2 text-slate-700">
                      {egp(row.sales)} / {row.target === null ? "no target" : egp(row.target)}
                    </td>
                    <td className="py-1.5 font-bold text-slate-900">{percent(row.achievementPct)}</td>
                  </>
                ) : (
                  <td className="py-1.5 text-slate-500" colSpan={2}>
                    {row.kind === "not_published" ? "Not published yet" : "No published figure for this seat"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {evidence.state === "ready" && evidence.achievementPct !== null ? (
        <p className="mt-2 text-sm font-semibold text-slate-800">
          Over the months with a target: {Math.round(evidence.achievementPct)}%
        </p>
      ) : null}
    </section>
  );
}
