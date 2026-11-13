import { CalendarClock } from "lucide-react";

import { DailyDeductionDisputeBox, type DailyLineDisputeState } from "@/components/employee-portal/daily-deduction-dispute-box";
import { Card } from "@/components/ui/card";
import { deductionsCategoryNames } from "@/lib/deductions/types";
import { cairoDateTime, utcDate } from "@/lib/format/cairo-datetime";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import type { DailyDeductionsPortalLine } from "@/lib/daily-deductions/types";

function formatMoney(value: number): string {
  return stableCurrencyFormatter("en-EG", {
    currency: "EGP",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function formatDays(value: number): string {
  const text = new Intl.NumberFormat("en-EG", { maximumFractionDigits: 2 }).format(value);
  return `${text} ${value === 1 ? "day" : "days"}`;
}

/**
 * The daily deductions HR has RELEASED to this employee (owner, 2026-11-07, asked whether the
 * release email's "Open your Deductions page" should lead somewhere that shows them: "Show daily
 * lines"). The lines are the active snapshot's, already self-only from getPortalDailyDeductions; a
 * withdrawn line is deleted from the snapshot, so it disappears here the moment HR withdraws it.
 *
 * It sits ABOVE the month ledger and says what it is: an early notice. Releasing a daily line feeds
 * no salary run — payroll charges from the month module, which the ledger below shows — so a day
 * that appears in both places is charged once. `unavailable` renders a plain sentence instead of an
 * empty list, so a failed read never reads as "nothing released".
 *
 * Every line carries its own Dispute box (owner, 2026-11-13 — the page showed these with no way to
 * argue with them). `disputes` is keyed by line id; null when the disputes could not be read, and then
 * the box is left off rather than offering a second dispute on a line that may already have one.
 */
export function DailyDeductionsPortalSection({
  disputes,
  lines,
  unavailable,
}: {
  disputes: Record<string, NonNullable<DailyLineDisputeState>> | null;
  lines: DailyDeductionsPortalLine[];
  unavailable: boolean;
}) {
  if (!unavailable && lines.length === 0) return null;
  const total = Math.round(lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0) * 100) / 100;

  return (
    <Card className="border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">
            <CalendarClock className="h-4 w-4" />
            Released during the month
          </p>
          <p className="mt-1.5 text-sm text-slate-600">
            HR released these before the month closed, so you know early. Your salary is charged from the monthly
            deductions listed below, so a day that appears in both places is charged once.
          </p>
        </div>
        {!unavailable ? (
          <div className="shrink-0 text-right">
            <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">Released total</p>
            <p className="mt-1 text-xl font-black text-slate-950">{formatMoney(total)}</p>
          </div>
        ) : null}
      </div>

      {unavailable ? (
        <p className="mt-3 text-sm font-semibold text-slate-700">
          Your released daily deductions could not be loaded right now. Please try again in a moment.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
          {lines.map((line) => (
            <li className="py-3" key={line.id}>
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900">{deductionsCategoryNames[line.category]}</p>
                  <p className="mt-0.5 break-words text-xs text-slate-600">
                    {line.dates.length > 0 ? line.dates.map((date) => utcDate(date)).join(" · ") : "No days listed"}
                  </p>
                  <p className="mt-0.5 text-phx-xs font-semibold text-slate-400">Released {cairoDateTime(line.createdAt)} (Cairo)</p>
                </div>
                <div className="shrink-0 sm:text-right">
                  <p className="font-mono text-sm font-black text-slate-950">{formatMoney(Number(line.amount) || 0)}</p>
                  {line.deductionUnit === "days" ? (
                    <p className="text-xs font-semibold text-slate-500">{formatDays(line.daysCount)}</p>
                  ) : null}
                </div>
              </div>
              {disputes ? <DailyDeductionDisputeBox dispute={disputes[line.id] ?? null} lineId={line.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
