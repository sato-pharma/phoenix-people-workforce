"use client";

import { AlertTriangle, CheckCircle2, Loader2, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { ClosingCorrectionsResult } from "@/lib/sales/closing-corrections";

const UNITS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const EGP = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

type Props = {
  initialData: ClosingCorrectionsResult | null;
  initialError: string | null;
};

const headerCell = "px-3 py-2 text-left text-phx-2xs font-bold uppercase tracking-[0.14em] text-slate-500";
const bodyCell = "px-3 py-2.5 text-sm text-slate-700 align-top";

function SectionTable({
  columns,
  rows,
  emptyText,
}: {
  columns: string[];
  rows: (string | number)[][];
  emptyText: string;
}) {
  if (rows.length === 0) {
    return <p className="px-4 py-3 text-sm text-slate-500 md:px-5">{emptyText}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-separate border-spacing-0">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/70">
            {columns.map((column) => (
              <th className={headerCell} key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, index) => (
            <tr className={index % 2 === 1 ? "bg-slate-50/50" : undefined} key={index}>
              {cells.map((cell, cellIndex) => (
                <td className={bodyCell} key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ClosingCorrectionsView({ initialData, initialError }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const data = initialData;
  const period = data?.period ?? "";
  const availablePeriods = data?.availablePeriods ?? [];
  const findingsCount = data
    ? data.reversalPairs.length + data.netNegatives.length + data.lateReturns.length
    : 0;

  const switchPeriod = (next: string) => {
    startTransition(() => {
      router.push(`/sales/closing-corrections?period=${encodeURIComponent(next)}`);
    });
  };

  return (
    <div className="min-h-[calc(100vh-7rem)] space-y-7">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>Month: {period || "No validated data"}</AdminInsightChip>
            <AdminInsightChip tone={findingsCount > 0 ? "orange" : "emerald"}>
              {findingsCount > 0 ? `${findingsCount} situations found` : "Nothing distorts this month"}
            </AdminInsightChip>
          </>
        )}
        description="Situations where the data is booked exactly as the distributor sent it and one month still reads wrong: corrections that span two months, returns bigger than the month's sales, and returns landing long after their sale. Nothing here is a system error — this page names what to keep in mind while reading the closing."
        eyebrow="Sales"
        icon={<Undo2 className="h-4 w-4" />}
        title="Closing Corrections"
      />

      <AdminTableShell
        action={(
          <label className="flex flex-col gap-1 sm:w-44">
            <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Month</span>
            <SearchableSelect
              className="h-11 w-full rounded-2xl border border-phx-line bg-phx-paper px-3.5 text-sm font-semibold text-phx-ink outline-none transition focus:border-phx-accent-line focus:ring-4 focus:ring-phx-accent/10 disabled:opacity-60"
              disabled={isPending || availablePeriods.length === 0}
              onChange={(event) => switchPeriod(event.target.value)}
              value={period}
            >
              {availablePeriods.length === 0 ? (
                <option value="">No validated month</option>
              ) : (
                availablePeriods.map((entry) => (
                  <option key={entry} value={entry}>{entry}</option>
                ))
              )}
            </SearchableSelect>
          </label>
        )}
        description="Each row explains itself in plain language. Thresholds keep everyday small returns off this page."
        title={`Corrections touching ${period || "—"}`}
      >
        {initialError ? (
          <div className="p-4 md:p-5">
            <AdminCallout tone="danger">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>{initialError}</p>
            </AdminCallout>
          </div>
        ) : !data || !data.period ? (
          <div className="p-4 md:p-5">
            <AdminCallout tone="neutral">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>No validated Source of Sales data yet. Upload and validate distributor sheets first.</p>
            </AdminCallout>
          </div>
        ) : (
          <div className="space-y-6 pb-4">
            {isPending ? (
              <div className="flex items-center gap-2 px-4 pt-4 text-sm text-slate-500 md:px-5">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading {"the selected month"}…
              </div>
            ) : null}
            {data.isEmpty ? (
              <div className="p-4 md:p-5">
                <AdminCallout tone="success">
                  <CheckCircle2 className="mt-0.5 h-4 w-4" />
                  <p>
                    No cross-month reversals, oversized returns, or late returns touch {data.period}.
                    Nothing on this page distorts the month&apos;s closing.
                  </p>
                </AdminCallout>
              </div>
            ) : (
              <>
                <section>
                  <h3 className="px-4 pt-4 text-sm font-bold text-[#0B0B0B] md:px-5">
                    Corrections that span two months
                  </h3>
                  <p className="px-4 pb-2 text-xs text-slate-500 md:px-5">
                    A distributor posted units in one month and took them back the next — the first
                    month reads high, the second reads low.
                  </p>
                  <SectionTable
                    columns={["Distributor", "Line", "Area", "Product", "Added", "Taken back", "What it means"]}
                    emptyText={`No two-month corrections touch ${data.period}.`}
                    rows={data.reversalPairs.map((pair) => [
                      pair.distributorName,
                      pair.line,
                      `${pair.areaName} (${pair.areaCode})`,
                      pair.productName,
                      `${pair.positivePeriod}: +${UNITS.format(pair.positiveUnits)} u / ${EGP.format(pair.positiveValue)}`,
                      `${pair.negativePeriod}: ${UNITS.format(pair.negativeUnits)} u / ${EGP.format(pair.negativeValue)}`,
                      pair.impact,
                    ])}
                  />
                </section>

                <section>
                  <h3 className="px-4 pt-2 text-sm font-bold text-[#0B0B0B] md:px-5">
                    Returns bigger than the month&apos;s sales
                  </h3>
                  <p className="px-4 pb-2 text-xs text-slate-500 md:px-5">
                    The area×product cell nets below zero this month — the closing shows a negative
                    there, which is real, not a bug.
                  </p>
                  <SectionTable
                    columns={["Distributor", "Line", "Area", "Product", "Net units", "Net EGP", "What it means"]}
                    emptyText={`No cell of ${data.period} nets negative beyond the noise floor.`}
                    rows={data.netNegatives.map((cell) => [
                      cell.distributorName,
                      cell.line,
                      `${cell.areaName} (${cell.areaCode})`,
                      cell.productName,
                      UNITS.format(cell.units),
                      EGP.format(cell.value),
                      cell.impact,
                    ])}
                  />
                </section>

                <section>
                  <h3 className="px-4 pt-2 text-sm font-bold text-[#0B0B0B] md:px-5">
                    Returns landing long after their sale
                  </h3>
                  <p className="px-4 pb-2 text-xs text-slate-500 md:px-5">
                    A customer&apos;s return this month, traced to the month they actually bought —
                    the credit drags this month for a sale an earlier month enjoyed.
                  </p>
                  <SectionTable
                    columns={["Customer", "Distributor", "Line", "Area", "Product", "Returned", "What it means"]}
                    emptyText={`No late returns land in ${data.period}.`}
                    rows={data.lateReturns.map((entry) => [
                      entry.clientName,
                      entry.distributorName,
                      entry.line,
                      `${entry.areaName} (${entry.areaCode})`,
                      entry.productName,
                      `${UNITS.format(entry.units)} u / ${EGP.format(entry.value)}`,
                      entry.impact,
                    ])}
                  />
                </section>
              </>
            )}
          </div>
        )}
      </AdminTableShell>
    </div>
  );
}
