"use client";

import { CalendarRange, Loader2, Package, TrendingUp } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { ClosingMatrixTable } from "@/components/sales/closing-matrix-table";
import { formatCurrency, formatNumber, periodLabel } from "@/lib/sales/format";
import type { MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";
import type { PortalClosingTrendPoint } from "@/lib/sales/monthly-closing-portal";
import { SearchableSelect } from "@/components/ui/searchable-select";


type Props = {
  awaitingPublish: boolean;
  availablePeriods: string[];
  /** Route the period/year selector navigates to. Defaults to the publish-gated monthly-closing
   *  page; the live Sales-Intelligence monthly page passes its own route. */
  basePath?: string;
  /** Empty-state copy shown when there is nothing to display. Defaults to the publish-gated wording. */
  emptyMessage?: string;
  emptyTitle?: string;
  line: string | null;
  matrix: MonthlyClosingMatrix | null;
  productScoped: boolean;
  selectedPeriod: string | null;
  trend: PortalClosingTrendPoint[];
};

function splitPeriod(period: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period.trim());
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

function labelFor(period: string): string {
  const parts = splitPeriod(period);
  return parts ? periodLabel(parts.year, parts.month) : period;
}

function KpiCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-orange-50 text-[#F97316]">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">{label}</p>
        <p className="truncate text-lg font-black tabular-nums text-slate-900">{value}</p>
      </div>
    </div>
  );
}

function TrendStrip({ points }: { points: PortalClosingTrendPoint[] }) {
  const max = Math.max(1, ...points.map((point) => point.salesValue));
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-[#F97316]" />
        <h3 className="text-sm font-black text-slate-900">Month-over-month trend</h3>
        <span className="text-xs font-semibold text-slate-400">sales value (EGP)</span>
      </div>
      <div className="flex items-end gap-3 overflow-x-auto pb-1">
        {points.map((point) => {
          const height = Math.max(6, Math.round((point.salesValue / max) * 120));
          return (
            <div className="flex min-w-[58px] flex-1 flex-col items-center gap-1.5" key={point.period}>
              <span className="text-[10px] font-bold tabular-nums text-slate-500">{formatCurrency(point.salesValue)}</span>
              <div
                className="w-full rounded-t-lg bg-gradient-to-t from-[#F97316] to-[#FDBA74] transition-all"
                style={{ height }}
                title={`${labelFor(point.period)} • ${formatNumber(point.salesUnits)} units`}
              />
              <span className="text-[10px] font-black uppercase tracking-wide text-slate-600">{labelFor(point.period)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MonthlyClosingPortalView({
  awaitingPublish,
  availablePeriods,
  basePath = "/employee-portals/monthly-closing",
  emptyMessage,
  emptyTitle,
  line,
  matrix,
  productScoped,
  selectedPeriod,
  trend,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingPeriod, setPendingPeriod] = useState<string | null>(null);

  const years = useMemo(() => {
    const set = new Set<number>();
    for (const period of availablePeriods) {
      const parts = splitPeriod(period);
      if (parts) set.add(parts.year);
    }
    return [...set].sort((left, right) => right - left);
  }, [availablePeriods]);

  const selected = selectedPeriod ? splitPeriod(selectedPeriod) : null;
  const selectedYear = selected?.year ?? years[0] ?? null;

  const monthsForYear = useMemo(() => {
    return availablePeriods
      .map(splitPeriod)
      .filter((parts): parts is { year: number; month: number } => Boolean(parts) && parts!.year === selectedYear)
      .sort((left, right) => right.month - left.month);
  }, [availablePeriods, selectedYear]);

  function navigateTo(period: string) {
    if (!period || period === selectedPeriod) return;
    setPendingPeriod(period);
    startTransition(() => {
      router.push(`${basePath}?period=${period}`);
    });
  }

  function onYearChange(year: number) {
    // Jump to the newest published month within the chosen year.
    const newest = availablePeriods
      .map(splitPeriod)
      .filter((parts): parts is { year: number; month: number } => Boolean(parts) && parts!.year === year)
      .sort((left, right) => right.month - left.month)[0];
    if (newest) navigateTo(`${newest.year}-${String(newest.month).padStart(2, "0")}`);
  }

  const selectClassName =
    "h-11 w-full rounded-2xl border border-slate-200 bg-white px-3.5 text-sm font-semibold text-slate-900 outline-none transition focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10 disabled:opacity-60";

  if (!line) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm font-semibold text-amber-800">
        We could not resolve your sales line from your HR profile. Please contact HR so your line is set on your employee record.
      </div>
    );
  }

  if (awaitingPublish || availablePeriods.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <CalendarRange className="mx-auto h-8 w-8 text-slate-300" />
        <p className="mt-3 text-base font-black text-slate-900">{emptyTitle ?? "No published closing yet"}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          {emptyMessage ?? (
            <>
              The monthly closing for the <span className="font-semibold text-slate-700">{line}</span> line will appear here once HR
              publishes it. Months still being uploaded are not shown.
            </>
          )}
        </p>
      </div>
    );
  }

  const totalValue = matrix?.grandTotal.rowTotal.salesValue ?? 0;
  const totalUnits = matrix?.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0) ?? 0;
  const productCount = matrix?.columns.length ?? 0;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard icon={<CalendarRange className="h-4 w-4" />} label="Line" value={line} />
        <KpiCard icon={<TrendingUp className="h-4 w-4" />} label="Sales value" value={formatCurrency(totalValue)} />
        <KpiCard icon={<Package className="h-4 w-4" />} label="Sales units" value={formatNumber(totalUnits)} />
        <KpiCard
          icon={<Package className="h-4 w-4" />}
          label={productScoped ? "Your products" : "Products"}
          value={String(productCount)}
        />
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-end">
        <label className="flex flex-col gap-1 sm:w-40">
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Year</span>
          <SearchableSelect
            className={selectClassName}
            disabled={isPending}
            onChange={(event) => onYearChange(Number(event.target.value))}
            value={selectedYear ?? ""}
          >
            {years.map((year) => (
              <option key={year} value={year}>{year}</option>
            ))}
          </SearchableSelect>
        </label>
        <label className="flex flex-col gap-1 sm:w-48">
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Month</span>
          <SearchableSelect
            className={selectClassName}
            disabled={isPending}
            onChange={(event) => navigateTo(event.target.value)}
            value={selectedPeriod ?? ""}
          >
            {monthsForYear.map((parts) => {
              const period = `${parts.year}-${String(parts.month).padStart(2, "0")}`;
              return (
                <option key={period} value={period}>{periodLabel(parts.year, parts.month)}</option>
              );
            })}
          </SearchableSelect>
        </label>
        {isPending ? (
          <span className="flex items-center gap-2 pb-3 text-xs font-semibold text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading {pendingPeriod ? labelFor(pendingPeriod) : ""}…
          </span>
        ) : null}
      </div>

      {trend.length > 1 ? <TrendStrip points={trend} /> : null}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-3 md:px-5">
          <h2 className="text-sm font-black text-slate-900">
            Closing matrix — {selectedPeriod ? labelFor(selectedPeriod) : ""}
          </h2>
          <p className="text-xs text-slate-500">
            {productScoped
              ? "Your assigned products, by area and region, rolled up to national."
              : "Your line, by area and region, rolled up to national."}
          </p>
        </div>
        {matrix ? (
          <ClosingMatrixTable matrix={matrix} />
        ) : (
          <div className="p-6 text-sm text-slate-500">No data for this month.</div>
        )}
      </div>
    </div>
  );
}
