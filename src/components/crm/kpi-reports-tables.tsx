/**
 * The owner's two KPI reports per rep, as the last two tabs of the KPIs board.
 *
 * Owner, 2026-09-05: "in phx we want to have 2 separate kpis report / rep the first is call rate
 * frequency and covergae am/pm and the 2nd for pharmacies".
 *
 * ## AM and PM are TWO TABLES, not two halves of one row
 *
 * The rule is "never get average" (2026-09-04): "this two and this ten. Don't never get average."
 * Two tables is the strongest form of that — there is no row on which an AM number and a PM number
 * meet, so no reader can accidentally average them by eye and no future edit can add a "combined"
 * column without first merging the tables, which is a visible change. Where the two DO appear in
 * one string (the tab headline), the separator is " AM · " / " PM" — never a slash, which he read
 * as a fraction.
 *
 * ## NO "use client"
 *
 * Pure markup: no state, no handlers, no effects, exactly like kpis-chrome.tsx. A server component
 * may never hand a FUNCTION to a client one — React cannot serialise it and every load 500s for
 * everyone. tests/rsc-client-function-props.test.ts walks the import graph and guards it.
 *
 * ## Fits the screen, and mobile gets cards
 *
 * Every table is `hidden … md:table` behind a `md:hidden` card list, which is the module-wide rule
 * tests/crm-mobile-table-cards.test.ts enforces by scanning this whole directory. No min-width, no
 * `whitespace-nowrap` over content that can grow, and nothing truncated with an ellipsis — long
 * names WRAP, which is the permitted answer. `table-fixed` + `<colgroup>` rather than
 * `overflow-x-auto` over a min-width floor, because that pattern IS the bug the golden rule names.
 *
 * ## text-phx-* never goes through cn()
 *
 * tailwind-merge silently strips custom named font sizes and only getComputedStyle in a real
 * browser can see that it did. Every class string here is a plain template literal.
 */

import { CAPTION, KpiRepName, NUM, TD, TH } from "@/components/crm/kpis-chrome";
import type { KpiRepRow } from "@/lib/crm/kpis-board";
import {
  unscoredLabel,
  type ListKpiBlock,
  type RepKpiReports,
} from "@/lib/crm/rep-kpi-reports";

/** A rate as the board prints it — two decimals, matching the four tabs beside this one. */
function rate(value: number | null): string {
  return value == null ? "—" : value.toFixed(2);
}

/** A percentage with no decimal, or an em dash when there is nothing to be a percentage OF. */
function pct(value: number | null): string {
  return value == null ? "—" : `${Math.round(value)}%`;
}

/**
 * The verdict under a number.
 *
 * THREE OUTCOMES, THREE DIFFERENT WORDS, and they must never collapse into one "n/a":
 *   "Not applicable" — this rep has no such list. Nothing is wrong (25 of 69 carry no pharmacies).
 *   "Not scored"     — the owner has not set this standard yet. His real figure is still shown.
 *   Met / Below      — a real verdict against a real standard.
 *
 * A rep with no pharmacy list rendered as "Below" would be an accusation the data cannot support,
 * which is the specific mistake the whole two-report split exists to stop.
 */
function Verdict({ block, kind }: { block: ListKpiBlock; kind: "callRate" | "coverage" | "frequency" }) {
  const score = block[kind].score;
  if (!score.scored) return <span className={CAPTION}>{unscoredLabel(score.reason)}</span>;
  return (
    <span className={score.meets ? "text-phx-2xs font-bold text-emerald-700" : "text-phx-2xs font-bold text-rose-700"}>
      {score.meets ? "Met" : "Below"}
    </span>
  );
}

/** One measure: the number, with its verdict under it. */
function MeasureCell({ block, kind, text }: { block: ListKpiBlock; kind: "callRate" | "coverage" | "frequency"; text: string }) {
  return (
    <td className={NUM}>
      {text}
      <span className="mt-0.5 block">
        <Verdict block={block} kind={kind} />
      </span>
    </td>
  );
}

type ReportRow = {
  repKey: string | null;
  repName: string;
  block: ListKpiBlock;
  areaName: string | null;
  lineName: string | null;
  jobTitle: string | null;
  hireDate: string | null;
};

/**
 * One row per rep, in the BOARD's order and carrying the board's area, line and title.
 *
 * The reports come back in the order the data layer built them, which ignores the sort the manager
 * picked on the board, so without this the rows of these two tabs would sit in an order no control on
 * the page explains. A report with no matching board row keeps its place after the matched ones.
 */
function rowsFor(
  reports: readonly RepKpiReports[],
  pick: (report: RepKpiReports) => ListKpiBlock,
  reps: readonly KpiRepRow[] = [],
): ReportRow[] {
  const position = new Map<string, number>();
  const rowOf = new Map<string, KpiRepRow>();
  reps.forEach((rep, index) => {
    if (rep.coverageRepKey == null) return;
    position.set(rep.coverageRepKey, index);
    rowOf.set(rep.coverageRepKey, rep);
  });
  const rank = (report: RepKpiReports) =>
    (report.repKey != null ? position.get(report.repKey) : undefined) ?? Number.MAX_SAFE_INTEGER;
  return reports
    .map((report, index) => ({ report, index }))
    .sort((a, b) => rank(a.report) - rank(b.report) || a.index - b.index)
    .map(({ report }) => {
      const rep = report.repKey != null ? rowOf.get(report.repKey) : undefined;
      return {
        repKey: report.repKey,
        repName: report.repName,
        block: pick(report),
        areaName: rep?.areaName ?? null,
        lineName: rep?.lineName ?? null,
        jobTitle: rep?.jobTitle ?? null,
        hireDate: rep?.hireDate ?? null,
      };
    });
}

const MEASURES = [
  { kind: "callRate", label: "Call rate" },
  { kind: "coverage", label: "Coverage" },
  { kind: "frequency", label: "Frequency" },
] as const;

/**
 * How many reps are Met, Below and without a verdict on each measure, said once under a table.
 *
 * COUNTS, NEVER A MEAN. The call rate is not averaged (owner, 2026-09-04) and a team percentage made
 * from reps with different list sizes would be the same mistake one level up, so the tally says how
 * many reps cleared the standard and leaves the figures in the rows. A rep with no such list lands in
 * "no verdict", which is not Below.
 */
function Tally({ rows }: { rows: ReportRow[] }) {
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-1 gap-3 border-t border-slate-100 px-4 py-3 sm:grid-cols-3 sm:px-5">
      {MEASURES.map(({ kind, label }) => {
        let met = 0;
        let below = 0;
        let none = 0;
        for (const row of rows) {
          const score = row.block[kind].score;
          if (!score.scored) none += 1;
          else if (score.meets) met += 1;
          else below += 1;
        }
        return (
          <div key={kind}>
            <dt className={CAPTION}>{label}</dt>
            <dd className="text-sm font-semibold text-slate-900">
              <span className="text-emerald-700">{met} met</span>
              <span className="text-slate-300"> · </span>
              <span className="text-rose-700">{below} below</span>
              <span className="text-slate-300"> · </span>
              <span className="text-slate-500">{none} no verdict</span>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * One list's table — rep, call rate, coverage, frequency.
 *
 * FOUR COLUMNS, deliberately. Seven (AM's three beside PM's three) would fit a laptop and crush a
 * tablet, and the fits-the-screen rule is measured at 375px as well as at desktop. Splitting AM
 * from PM into two tables keeps every column wide enough to hold a wrapped rep name.
 */
function ListTable({ caption, rateHeading, rows }: { caption: string; rateHeading: string; rows: ReportRow[] }) {
  return (
    <table className="hidden w-full table-fixed md:table">
      <caption className={`px-4 pb-2 pt-4 text-left text-phx-xs font-black uppercase tracking-[0.12em] text-slate-900 sm:px-5`}>
        {caption}
      </caption>
      <colgroup>
        <col style={{ width: "40%" }} />
        <col style={{ width: "20%" }} />
        <col style={{ width: "20%" }} />
        <col style={{ width: "20%" }} />
      </colgroup>
      <thead className="border-y border-slate-200 bg-slate-50">
        <tr>
          <th className={TH} scope="col">
            Rep
          </th>
          <th className={TH} scope="col">
            Call rate
            <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">
              {rateHeading}
            </span>
          </th>
          <th className={TH} scope="col">
            Coverage
            <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">
              Seen at least once ÷ their list
            </span>
          </th>
          <th className={TH} scope="col">
            Frequency
            <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">
              Met the grade&apos;s own norm
            </span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row, index) => (
          <tr key={row.repKey ?? `${row.repName}-${index}`}>
            <td className={TD}>
              <KpiRepName areaName={row.areaName} hireDate={row.hireDate} jobTitle={row.jobTitle} lineName={row.lineName} name={row.repName} />
              <span className={`mt-0.5 block ${CAPTION}`}>
                {row.block.applicable
                  ? `${row.block.coverage.panel} on their list`
                  : "No list of this kind"}
              </span>
            </td>
            <MeasureCell block={row.block} kind="callRate" text={rate(row.block.callRate.perWorkingDay)} />
            <MeasureCell block={row.block} kind="coverage" text={pct(row.block.coverage.pct)} />
            <MeasureCell block={row.block} kind="frequency" text={pct(row.block.frequency.pct)} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The phone view of one list — the same four facts, stacked. */
function ListCards({ caption, rows }: { caption: string; rows: ReportRow[] }) {
  return (
    <div className="md:hidden">
      <p className="px-4 pb-2 pt-4 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-900">{caption}</p>
      <div className="divide-y divide-slate-100 border-t border-slate-100">
        {rows.map((row, index) => (
          <div className="px-4 py-3" key={row.repKey ?? `${row.repName}-${index}`}>
            <KpiRepName areaName={row.areaName} hireDate={row.hireDate} jobTitle={row.jobTitle} lineName={row.lineName} name={row.repName} />
            <p className={`mt-0.5 ${CAPTION}`}>
              {row.block.applicable ? `${row.block.coverage.panel} on their list` : "No list of this kind"}
            </p>
            <dl className="mt-2 grid grid-cols-3 gap-2">
              <div>
                <dt className={CAPTION}>Call rate</dt>
                <dd className="text-sm font-semibold tabular-nums text-slate-900">
                  {rate(row.block.callRate.perWorkingDay)}
                </dd>
                <Verdict block={row.block} kind="callRate" />
              </div>
              <div>
                <dt className={CAPTION}>Coverage</dt>
                <dd className="text-sm font-semibold tabular-nums text-slate-900">{pct(row.block.coverage.pct)}</dd>
                <Verdict block={row.block} kind="coverage" />
              </div>
              <div>
                <dt className={CAPTION}>Frequency</dt>
                <dd className="text-sm font-semibold tabular-nums text-slate-900">{pct(row.block.frequency.pct)}</dd>
                <Verdict block={row.block} kind="frequency" />
              </div>
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * REPORT 1 — AM and PM, apart.
 *
 * Both tables render even when one list is empty for everyone, because an empty AM table is itself
 * the finding: every rep is expected to carry AM/PM, and a blank one says the lists never synced.
 */
export function AmPmKpiReportTables({
  reports,
  reps,
}: {
  reports: readonly RepKpiReports[];
  reps?: readonly KpiRepRow[];
}) {
  const amRows = rowsFor(reports, (report) => report.ampm.am, reps);
  const pmRows = rowsFor(reports, (report) => report.ampm.pm, reps);
  return (
    <div>
      <ListCards caption="AM — accounts" rows={amRows} />
      <ListTable caption="AM — accounts" rateHeading="Accounts a working day" rows={amRows} />
      <Tally rows={amRows} />
      <div className="mt-4 border-t border-slate-100">
        <ListCards caption="PM — clinics" rows={pmRows} />
        <ListTable caption="PM — clinics" rateHeading="Clinics a working day" rows={pmRows} />
        <Tally rows={pmRows} />
      </div>
    </div>
  );
}

/**
 * REPORT 2 — Pharmacies.
 *
 * A rep with no pharmacy list is shown, reading "Not applicable" on all three measures. He is NOT
 * hidden and NOT zeroed: 25 of 69 reps carry no pharmacies, and dropping them would make this tab
 * quietly shorter than the five beside it with nothing saying why.
 */
export function PharmacyKpiReportTables({
  reports,
  reps,
}: {
  reports: readonly RepKpiReports[];
  reps?: readonly KpiRepRow[];
}) {
  const rows = rowsFor(reports, (report) => report.pharmacies.pharmacies, reps);
  return (
    <div>
      <ListCards caption="Pharmacies" rows={rows} />
      <ListTable caption="Pharmacies" rateHeading="Pharmacies a working day" rows={rows} />
      <Tally rows={rows} />
    </div>
  );
}

/**
 * Off-list work, printed under both reports rather than folded into either.
 *
 * Measured on production for August 2026: 867 of 14,076 regular Sat–Wed visits (6.2%) went to a
 * contact on none of that rep's lists. They can be attributed to no `list_type`, so counting them
 * into PM would inflate the doctor number and dropping them would understate call rate. Saying so
 * is the only honest option — "an export must MATCH the screen; label it, never drop it silently".
 */
export function OffListNote({ reports }: { reports: readonly RepKpiReports[] }) {
  const total = reports.reduce((sum, report) => sum + report.offListVisits, 0);
  if (total === 0) return null;
  return (
    <p className={`px-4 py-3 sm:px-5 ${CAPTION}`}>
      {total} regular {total === 1 ? "visit" : "visits"} in this window went to a contact on none of that rep&apos;s
      lists, so {total === 1 ? "it belongs" : "they belong"} to neither report. Counted here rather than added to
      either one.
    </p>
  );
}
