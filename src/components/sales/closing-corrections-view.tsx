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
import { closingCorrectionsHeadline } from "@/lib/sales/closing-corrections-headline";

const UNITS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const EGP = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

type Props = {
  initialData: ClosingCorrectionsResult | null;
  initialError: string | null;
};

const headerCell = "px-3 py-2 text-left text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-500";
const bodyCell = "px-3 py-2.5 text-sm text-slate-700 align-top break-words";

function SectionTable({
  columns,
  rows,
  emptyText,
  widths,
}: {
  columns: string[];
  rows: (string | number)[][];
  emptyText: string;
  /** One percentage per column, adding up to 100. */
  widths: number[];
}) {
  if (rows.length === 0) {
    return <p className="px-4 py-3 text-sm text-slate-500 md:px-5">{emptyText}</p>;
  }
  // Each section passes its own percentage widths (adding up to 100) for the colgroup, so the
  // table fits whatever holds it and the long "What it means" column takes the room.
  //
  // Even shares are enough on a laptop and NOT on a phone: measured at 375px, the seven-column
  // section gave each column 49px and clipped every header ("Distributor" wanted 112px). So below
  // `md` the same rows render as cards, which is the admin shell's own rule — desktop tables,
  // mobile cards — with each cell carrying its column's name, so nothing is dropped.
  return (
    <div>
      <div className="divide-y divide-slate-200 md:hidden">
        {rows.map((cells, index) => (
          <div className={`px-4 py-3 ${index % 2 === 1 ? "bg-slate-50/50" : ""}`} key={index}>
            {cells.map((cell, cellIndex) => (
              <div className="flex gap-2 py-0.5" key={cellIndex}>
                <span className="w-24 shrink-0 pt-0.5 text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-500">
                  {columns[cellIndex]}
                </span>
                <span className="min-w-0 break-words text-sm text-slate-700">{cell}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <table className="hidden w-full table-fixed border-collapse md:table">
        <colgroup>
          {widths.map((width, index) => (
            <col key={index} style={{ width: `${width}%` }} />
          ))}
        </colgroup>
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

/**
 * One event seen by several detectors must READ as one event.
 *
 * A late return that is also a reversal pair and also drags its cell negative appears in three
 * sections at three different magnitudes. Production 2026-07: D21/RO001 and D21/SA001 each
 * appear in ALL THREE, and summing their sentences suggested ~62,000 EGP of July distortion for
 * a return whose real effect on the closing cell is -12,559.95. The number in each section is
 * correct for what that section measures; what was missing was that they are the same return.
 */
function withCrossReference(impact: string, alsoSeenIn: readonly string[]): string {
  if (alsoSeenIn.length === 0) return impact;
  const quoted = alsoSeenIn.map((label) => `“${label}”`).join(" and ");
  return (
    `${impact} The same area and product is also listed under ${quoted} — ` +
    `one situation seen ${alsoSeenIn.length + 1} ways, not ${alsoSeenIn.length + 1} separate ones.`
  );
}

/**
 * The area cell as the page prints it: the area's name, never its code. A region's company Direct
 * row has no area code and prints its name the same way.
 */
function areaLabel(areaName: string, _areaCode: string): string {
  return areaName;
}

export function ClosingCorrectionsView({ initialData, initialError }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const data = initialData;
  const period = data?.period ?? "";
  const availablePeriods = data?.availablePeriods ?? [];
  // DISTINCT situations, never the three section lengths added together.
  //
  // One return routinely trips two or three detectors — a late return that is also a reversal pair
  // and also drags its cell negative is ONE event seen three ways. Summing the sections counted it
  // three times: production 2026-07 announced "17 situations found" for 12 real ones, with the same
  // money printed three times at three different magnitudes and nothing saying they were one event.
  // This page exists to size how far a month reads wrong before sign-off, so an inflated headline
  // inflates exactly the judgement it is there to inform. Pinned by tests/closing-corrections-one-event.test.ts.
  // A failed load has no count at all, so the green "nothing distorts" is earned only by a load
  // that ran (closing-corrections-headline.ts).
  const headline = closingCorrectionsHeadline({
    loadError: initialError,
    period,
    situationCount: data?.situationCount,
  });

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
            <AdminInsightChip tone={headline.tone}>{headline.text}</AdminInsightChip>
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
            <span className="text-phx-sm font-bold uppercase tracking-[0.16em] text-slate-500">Month</span>
            <SearchableSelect
              className="w-full px-3.5"
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
                    Smaller ones fall below this page&apos;s thresholds and are not listed.
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
                    month reads high, the second reads low. Returns are matched pharmacy by pharmacy,
                    so the second month&apos;s other sales cannot hide one.
                  </p>
                  <SectionTable
                    columns={["Distributor", "Line", "Area", "Product", "Added", "Taken back", "What it means"]}
                    emptyText={`No two-month corrections touch ${data.period}.`}
                    widths={[11, 7, 12, 13, 13, 13, 31]}
                    rows={data.reversalPairs.map((pair) => [
                      pair.distributorName,
                      pair.line,
                      areaLabel(pair.areaName, pair.areaCode),
                      pair.productName,
                      `${pair.positivePeriod}: +${UNITS.format(pair.positiveUnits)} u / ${EGP.format(pair.positiveValue)}`,
                      `${pair.negativePeriod}: ${UNITS.format(pair.negativeUnits)} u / ${EGP.format(pair.negativeValue)}`,
                      withCrossReference(pair.impact, pair.alsoSeenIn),
                    ])}
                  />
                </section>

                <section>
                  <h3 className="px-4 pt-2 text-sm font-bold text-[#0B0B0B] md:px-5">
                    Returns bigger than the month&apos;s sales
                  </h3>
                  <p className="px-4 pb-2 text-xs text-slate-500 md:px-5">
                    The area×product cell nets below zero this month, across every distributor —
                    the closing shows a negative there, which is real, not a bug.
                  </p>
                  {/*
                    NO DISTRIBUTOR COLUMN HERE, and it must not come back. This row is the whole
                    cell, exactly as the closing groups it; it has no single distributor. The
                    column used to exist because the RPC grouped by distributor too, which made
                    each row one distributor's share labelled as the cell — 7 of 10 rows on
                    production disagreed with the closing, three of them in sign. Pinned by
                    tests/closing-corrections-cell.test.ts.
                  */}
                  <SectionTable
                    columns={["Line", "Area", "Product", "Net units", "Net EGP", "What it means"]}
                    emptyText={`No cell of ${data.period} nets negative beyond the noise floor.`}
                    widths={[8, 16, 18, 10, 12, 36]}
                    rows={data.netNegatives.map((cell) => [
                      cell.line,
                      areaLabel(cell.areaName, cell.areaCode),
                      cell.productName,
                      UNITS.format(cell.units),
                      EGP.format(cell.value),
                      withCrossReference(cell.impact, cell.alsoSeenIn),
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
                    widths={[14, 11, 6, 12, 13, 13, 31]}
                    rows={data.lateReturns.map((entry) => [
                      entry.clientName,
                      entry.distributorName,
                      entry.line,
                      areaLabel(entry.areaName, entry.areaCode),
                      entry.productName,
                      `${UNITS.format(entry.units)} u / ${EGP.format(entry.value)}`,
                      withCrossReference(entry.impact, entry.alsoSeenIn),
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
