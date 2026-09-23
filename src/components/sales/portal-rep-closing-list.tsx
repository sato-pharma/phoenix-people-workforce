"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { isSyntheticDirectArea } from "@/lib/sales/closing-direct-area";
import { formatNumber, formatPercent } from "@/lib/sales/format";
import type {
  MonthlyClosingAreaRow,
  MonthlyClosingCell,
  MonthlyClosingColumn,
  MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";

// ── A Medical Rep's OWN closing, stacked vertically (owner, 2026-09-23) ─────────
//
// A rep's matrix is already scoped to their own area(s) upstream (medicalRepClosingGeography). Fed
// through the shared ClosingMatrixTable that still means three rows for the one area they own — the
// area row, the region subtotal that merely repeats it, and the "National Grand Total" that repeats
// it a third time — with every product laid across as columns, which is what forces the horizontal
// scroll. The owner's instruction: a rep sees ONLY his own area, and it reads down the page, not
// across it.
//
// So this surface, used for the Medical Rep alone, drops the region and national rollups (both are
// the rep's own area restated, never a sibling's) and stacks each product down the page inside the
// area. It fits a phone and a desktop with no side scroll. Presentation only: the data is the same
// scoped matrix, and the Export XLSX route is untouched — it still emits the rep's full scoped
// workbook exactly as before.

const valueFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const BLANK = "—";

function unitsText(value: number | null): string {
  return value === null ? BLANK : formatNumber(value);
}

function valueText(value: number | null): string {
  return value === null ? BLANK : valueFormatter.format(value || 0);
}

function achText(value: number | null): string {
  return value === null ? BLANK : formatPercent(value, { input: "ratio" });
}

// Achievement is value-based (sales value ÷ target value). A rep at or above target reads green; the
// figure itself carries the rest. Deliberately only two tiers — the grid stays quiet.
function achTone(value: number | null): string {
  if (value === null) return "text-slate-400";
  return value >= 1 ? "text-emerald-700" : "text-slate-900";
}

function Tile({ label, tone, children }: { label: string; tone?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border border-slate-100 bg-slate-50/70 px-3 py-2">
      <span className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</span>
      <span className={cn("text-sm font-semibold tabular-nums", tone ?? "text-slate-900")}>{children}</span>
    </div>
  );
}

function ProductCard({ column, cell }: { column: MonthlyClosingColumn; cell: MonthlyClosingCell }) {
  return (
    <div className="border border-slate-200 bg-white p-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-bold text-slate-900">{column.productName}</p>
        <span className="shrink-0 text-phx-2xs font-semibold uppercase tracking-[0.12em] text-slate-400">
          {column.productCode}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-5">
        <Tile label="Units">{unitsText(cell.salesUnits)}</Tile>
        <Tile label="Value">{valueText(cell.salesValue)}</Tile>
        <Tile label="Tgt Units" tone="text-orange-900">{unitsText(cell.targetUnits)}</Tile>
        <Tile label="Tgt Value" tone="text-orange-900">{valueText(cell.targetValue)}</Tile>
        <Tile label="Ach %" tone={achTone(cell.achievement)}>{achText(cell.achievement)}</Tile>
      </div>
    </div>
  );
}

function AreaBlock({
  area,
  columns,
}: {
  area: MonthlyClosingAreaRow;
  columns: MonthlyClosingColumn[];
}) {
  const total = area.rowTotal;
  return (
    <section className="rounded border border-slate-200 bg-white shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
      {/* Area header — the rep's own area, and its own total. No region, no national. */}
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Your area</span>
          <p className="text-base font-black text-slate-900">
            {area.areaName} <span className="text-sm font-semibold text-slate-400">({area.areaCode})</span>
          </p>
        </div>
        <div className="flex items-end gap-5">
          <div className="flex flex-col gap-0.5 text-right">
            <span className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">Total value</span>
            <span className="text-sm font-bold tabular-nums text-slate-900">{valueText(total.salesValue)}</span>
          </div>
          <div className="flex flex-col gap-0.5 text-right">
            <span className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">Tgt value</span>
            <span className="text-sm font-bold tabular-nums text-orange-900">{valueText(total.targetValue)}</span>
          </div>
          <div className="flex flex-col gap-0.5 text-right">
            <span className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">Ach %</span>
            <span className={cn("text-sm font-bold tabular-nums", achTone(total.achievement))}>
              {achText(total.achievement)}
            </span>
          </div>
        </div>
      </div>

      {/* One card per product, stacked down the page — never across it. */}
      <div className="space-y-2 p-3">
        {columns.map((column, idx) => {
          const cell = area.cells[idx];
          if (!cell) return null;
          return <ProductCard cell={cell} column={column} key={`${area.areaCode}-${column.productCode}`} />;
        })}
      </div>
    </section>
  );
}

export function PortalRepClosingList({ matrix }: { matrix: MonthlyClosingMatrix }) {
  // The rep's own areas — normally one. The synthetic company "Direct" pseudo-area is never theirs;
  // drop it defensively (their upstream scope already excludes it).
  const areas = matrix.regions
    .flatMap((region) => region.areas)
    .filter((area) => !isSyntheticDirectArea(area));

  if (matrix.columns.length === 0 || areas.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-slate-500">
        No closing rows match the current filters.
      </p>
    );
  }

  return (
    <div className="space-y-3 p-4 md:p-5">
      {areas.map((area) => (
        <AreaBlock area={area} columns={matrix.columns} key={area.areaCode} />
      ))}
    </div>
  );
}
