import Link from "next/link";

import type { ExpenseFinding, ExpenseReconciliationRow } from "@/lib/automated-payroll/expense-reconciliation";
import type { ExpensePeriod, ExpenseReconciliationResult } from "@/lib/automated-payroll/expense-reconciliation-server";

/**
 * APPROVED EXPENSES AGAINST THE PAYSLIPS — the third tab on Expense Command (owner, 2026-11-03). Reads
 * only and offers no action: a difference is a thing to look at, never a thing to fix from here. The
 * rules are in `src/lib/automated-payroll/expense-reconciliation.ts`.
 *
 * The owner's two locked looks: square edges, and fits the screen. `w-full table-fixed` with a colgroup
 * totalling 100%, the person's note merged into the person's cell, a card list under `md`, every cell
 * wrapping, no sideways scroll and no ellipsis.
 */

const THEAD = "px-3 py-2.5 text-left align-bottom text-phx-2xs font-black uppercase tracking-[0.12em] text-white";
const THEAD_NUMBER = "px-3 py-2.5 text-right align-bottom text-phx-2xs font-black uppercase tracking-[0.12em] text-white";
const CELL = "break-words px-3 py-2.5 align-top text-xs leading-5 text-slate-700";
const NUMBER = "break-words px-3 py-2.5 align-top text-right text-xs font-bold leading-5 tabular-nums text-slate-900";

const FINDING: Record<ExpenseFinding, { label: string; text: string }> = {
  "approved not paid": { label: "Approved, not on the payslip", text: "text-rose-700" },
  "no approved trip this month": { label: "On the payslip, no approved trip this month", text: "text-amber-700" },
  "different amount": { label: "Different amount", text: "text-amber-700" },
  "may have been carried": { label: "May have been carried", text: "text-sky-700" },
  "held at publish": { label: "Held at publish", text: "text-slate-600" },
};

const money = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

function monthLabel(period: ExpensePeriod): string {
  return new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC", year: "numeric" }).format(
    new Date(Date.UTC(period.year, period.month - 1, 1)),
  );
}

function monthKey(period: ExpensePeriod): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

function MonthPicker({ months, selected }: { months: readonly ExpensePeriod[]; selected: ExpensePeriod }) {
  return (
    <nav aria-label="Month" className="flex flex-wrap gap-2">
      {months.map((period) => {
        const active = monthKey(period) === monthKey(selected);
        return (
          <Link
            key={monthKey(period)}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "border border-phx-ink bg-phx-ink px-3 py-1.5 text-xs font-bold text-white"
                : "border border-phx-line bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
            }
            href={`/admin/outstation/expense-command?tab=reconcile&reconcileMonth=${monthKey(period)}`}
          >
            {monthLabel(period)}
          </Link>
        );
      })}
    </nav>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-phx-line bg-white px-3 py-2.5">
      <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-1 break-words text-base font-black tabular-nums text-slate-950">{value}</p>
    </div>
  );
}

function FindingCell({ row }: { row: ExpenseReconciliationRow }) {
  const finding = FINDING[row.finding];
  return (
    <>
      <p className={`break-words text-xs font-bold leading-5 ${finding.text}`}>{finding.label}</p>
      {row.note ? <p className="mt-0.5 break-words text-phx-xs leading-5 text-slate-600">{row.note}</p> : null}
      {row.pending > 0 ? (
        <p className="mt-0.5 break-words text-phx-xs leading-5 text-slate-600">Undecided trips: {money(row.pending)}</p>
      ) : null}
    </>
  );
}

function Rows({ rows }: { rows: readonly ExpenseReconciliationRow[] }) {
  return (
    <>
      <div className="hidden border border-phx-line bg-white md:block">
        <table className="w-full table-fixed">
          <colgroup>
            <col style={{ width: "28%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "34%" }} />
          </colgroup>
          <thead className="bg-phx-ink">
            <tr>
              <th className={THEAD} scope="col">Person</th>
              <th className={THEAD_NUMBER} scope="col">Approved trips</th>
              <th className={THEAD_NUMBER} scope="col">On the payslip</th>
              <th className={THEAD_NUMBER} scope="col">Gap</th>
              <th className={THEAD} scope="col">Finding</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-phx-line">
            {rows.map((row) => (
              <tr key={row.compact}>
                <td className={`${CELL} font-bold text-slate-900`} dir="auto">{row.fullName}</td>
                <td className={NUMBER}>{money(row.approved)}</td>
                <td className={NUMBER}>{money(row.paid)}</td>
                <td className={NUMBER}>{money(row.gap)}</td>
                <td className={CELL}><FindingCell row={row} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((row) => (
          <li key={row.compact} className="border border-phx-line bg-white p-3">
            <p className="break-words text-sm font-bold text-slate-900" dir="auto">{row.fullName}</p>
            <div className="mt-1"><FindingCell row={row} /></div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div><dt className="text-slate-500">Approved</dt><dd className="break-words font-bold tabular-nums text-slate-900">{money(row.approved)}</dd></div>
              <div><dt className="text-slate-500">Payslip</dt><dd className="break-words font-bold tabular-nums text-slate-900">{money(row.paid)}</dd></div>
              <div><dt className="text-slate-500">Gap</dt><dd className="break-words font-bold tabular-nums text-slate-900">{money(row.gap)}</dd></div>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

export function ExpensePayslipReconciliationPanel({
  error,
  months,
  result,
  selected,
}: {
  error: string | null;
  months: readonly ExpensePeriod[];
  result: ExpenseReconciliationResult | null;
  selected: ExpensePeriod;
}) {
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-black tracking-tight text-slate-950">Approved expenses against the payslips</h2>
        <p className="text-sm leading-6 text-slate-600">
          What was approved for this payout month beside what the published payslip paid. A difference is something to
          look at, not a mistake: HR can type a different amount on purpose.
        </p>
      </header>
      <MonthPicker months={months} selected={selected} />

      {error ? (
        <div className="border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
          Could not read {monthLabel(selected)}, so nothing can be said about it. {error}
        </div>
      ) : null}

      {result?.status === "not_published" ? (
        <div className="border border-phx-line bg-white p-4 text-sm leading-6 text-slate-700">
          {monthLabel(selected)} is not published yet, so there is no payslip to compare. Approved so far:{" "}
          <span className="font-bold tabular-nums">{money(result.undecidedApproved)}</span>.
        </div>
      ) : null}

      {result?.status === "published" ? (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Stat label="Approved trips" value={money(result.report.approvedTotal)} />
            <Stat label="On the payslips" value={money(result.report.paidTotal)} />
            <Stat label="People who match" value={String(result.report.matches)} />
            <Stat label="To look at" value={String(result.report.rows.length)} />
          </div>
          {result.typedByHand ? (
            <p className="text-sm leading-6 text-slate-600">
              This month&apos;s expense figures were typed into the sheet by hand, so differences are expected here.
            </p>
          ) : null}
          {result.importedHistoryTrips > 0 ? (
            <p className="text-sm leading-6 text-slate-600">
              {result.importedHistoryTrips} trip(s) in this month are imported history, dated before Phoenix approvals began.
            </p>
          ) : null}
          {result.report.rows.length === 0 ? (
            <div className="border border-phx-line bg-white p-4 text-sm leading-6 text-slate-700">
              Every approved figure this month matches the payslip.
            </div>
          ) : (
            <Rows rows={result.report.rows} />
          )}
          <p className="text-phx-xs leading-5 text-slate-500">
            Final settlements are not read here, and carried amounts are an inference. This screen changes nothing.
          </p>
        </>
      ) : null}
    </section>
  );
}
