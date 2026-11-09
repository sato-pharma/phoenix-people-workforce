"use client";

import type { ReactNode } from "react";

import { formatPeriod } from "@/components/sales/target-visuals";
import { cn } from "@/lib/utils";
import { isSyntheticDirectArea } from "@/lib/sales/closing-direct-area";
import { formatNumber, formatPercent } from "@/lib/sales/format";
import type {
  MonthlyClosingAreaRow,
  MonthlyClosingCell,
  MonthlyClosingColumn,
  MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";

// ── A Medical Rep's OWN closing, premium and vertical (owner, 2026-09-23) ───────
//
// A rep's matrix is already scoped to their own area(s) upstream (medicalRepClosingGeography). Fed
// through the shared ClosingMatrixTable that still means three rows for the one area they own — the
// area row, the region subtotal that merely repeats it, and the "National Grand Total" that repeats
// it a third time — with every product laid across as columns, which is what forces the horizontal
// scroll. The owner's instruction: a rep sees ONLY his own area, reading down the page, not across it.
//
// So this surface, used for the Medical Rep alone, drops the region and national rollups (both are
// the rep's own area restated, never a sibling's) and stacks the closing down the page: a black
// executive hero per area carrying its achievement against target, then one card per product with its
// own achievement bar and figures. Phoenix black-and-orange, square edges, depth from shadow only —
// the closing SCREEN's own identity, never the Sato workbook's. It fits a phone and a desktop with no
// side scroll. Presentation only: the data is the same scoped matrix, and the Details tab and the
// Export XLSX route are untouched — the export still emits the rep's full scoped workbook as before.

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

// Achievement is value-based (sales value ÷ target value). At or above target reads green; the figure
// carries the rest. Deliberately only two tiers — the bar does the visual work, the grid stays quiet.
function achTone(value: number | null): string {
  if (value === null) return "text-slate-400";
  return value >= 1 ? "text-emerald-600" : "text-slate-900";
}

// The achievement track. Fill is capped at 100% so an over-target product never overruns its own row;
// the green figure beside it already says "past target". `—` (no target) shows an empty track, never
// a full or a zero one, which would each assert something the data does not.
function AchievementBar({
  achievement,
  dark = false,
  tall = false,
}: {
  achievement: number | null;
  dark?: boolean;
  tall?: boolean;
}) {
  const track = dark ? "bg-white/10" : "bg-slate-100";
  const pct = achievement === null ? 0 : Math.max(0, Math.min(achievement, 1)) * 100;
  return (
    <div className={cn("w-full overflow-hidden", tall ? "h-2" : "h-1.5", track)}>
      {achievement === null ? null : (
        <div
          className={cn("h-full", achievement >= 1 ? "bg-emerald-500" : "bg-[#F97316]")}
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
}

function Tile({ label, tone, children }: { label: string; tone?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border border-slate-100 bg-slate-50/70 px-3 py-2.5">
      <span className="text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-500">{label}</span>
      <span className={cn("text-sm font-bold tabular-nums", tone ?? "text-slate-900")}>{children}</span>
    </div>
  );
}

function ProductCard({ column, cell }: { column: MonthlyClosingColumn; cell: MonthlyClosingCell }) {
  return (
    <div className="group border border-slate-200 bg-white p-4 transition-shadow hover:border-[#fbcfa8] hover:shadow-[0_12px_30px_rgba(249,115,22,0.12)]">
      {/* The product by name only: its code is a raw ID a rep never needs (names, never codes). */}
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 break-words text-sm font-bold text-slate-900">{column.productName}</p>
        <span className={cn("shrink-0 text-lg font-black leading-none tabular-nums", achTone(cell.achievement))}>
          {achText(cell.achievement)}
        </span>
      </div>

      <div className="mt-3">
        <AchievementBar achievement={cell.achievement} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Units">{unitsText(cell.salesUnits)}</Tile>
        <Tile label="Value">{valueText(cell.salesValue)}</Tile>
        <Tile label="Target units" tone="text-orange-900">{unitsText(cell.targetUnits)}</Tile>
        <Tile label="Target value" tone="text-orange-900">{valueText(cell.targetValue)}</Tile>
      </div>
    </div>
  );
}

function AreaBlock({
  area,
  columns,
  line,
  period,
}: {
  area: MonthlyClosingAreaRow;
  columns: MonthlyClosingColumn[];
  line: string | null;
  period: string | null;
}) {
  const total = area.rowTotal;
  // Line and month in words ("Pedia · Aug 2026") — never the area code or a raw "2026-08".
  const context = [line, period ? formatPeriod(period) : null].filter(Boolean).join(" · ");
  const overTarget = total.achievement !== null && total.achievement >= 1;
  return (
    <section className="overflow-hidden border border-slate-200 bg-white shadow-[0_18px_44px_rgba(15,23,42,0.10)]">
      {/* Black executive hero — the rep's own area and its own achievement. No region, no national. */}
      <div className="bg-[#0B0B0B] px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <span className="text-phx-sm font-bold uppercase tracking-[0.24em] text-[#F97316]">Your area</span>
            <p className="mt-1 break-words text-xl font-black leading-tight text-white">{area.areaName}</p>
            {/* slate-400, not 500: 10px slate-500 on the #0B0B0B hero is about 4:1, under AA for small text. */}
            <span className="text-phx-sm font-semibold uppercase tracking-[0.16em] text-slate-400">{context}</span>
          </div>
          <div className="text-right">
            <span className="text-phx-sm font-bold uppercase tracking-[0.18em] text-slate-400">Achievement</span>
            <p className={cn("text-3xl font-black leading-none tabular-nums", overTarget ? "text-emerald-400" : "text-white")}>
              {achText(total.achievement)}
            </p>
          </div>
        </div>
        <div className="mt-4">
          <AchievementBar achievement={total.achievement} dark tall />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 text-xs font-semibold tabular-nums text-slate-400">
            <span>
              Value <span className="ml-1 text-sm font-bold text-white">{valueText(total.salesValue)}</span>
            </span>
            <span>
              Target <span className="ml-1 text-sm font-bold text-[#FDBA74]">{valueText(total.targetValue)}</span>
            </span>
          </div>
        </div>
      </div>

      {/* One card per product, stacked down the page — never across it. */}
      <div className="space-y-2 bg-slate-50/40 p-3 md:p-4">
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
    <div className="space-y-4 p-4 md:p-5">
      {areas.map((area) => (
        <AreaBlock area={area} columns={matrix.columns} key={area.areaCode} line={matrix.line} period={matrix.period} />
      ))}
    </div>
  );
}
