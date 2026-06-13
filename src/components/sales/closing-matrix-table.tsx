"use client";

import { AlertTriangle } from "lucide-react";
import { useRef } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { cn } from "@/lib/utils";
import { formatNumber, formatPercent } from "@/lib/sales/format";
import type {
  MonthlyClosingCell,
  MonthlyClosingMatrix,
  MonthlyClosingRegionGroup,
} from "@/lib/sales/monthly-distributor-import";

// Shared, read-only render of the monthly closing matrix. Used by the admin
// Source-of-Sales workspace and the employee-portal closing view so both surfaces
// stay pixel-identical. Pure presentation — the caller pre-filters/scopes the matrix.

type RowVariant = "area" | "subtotal" | "grand";

const valueFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const BLANK = "—";

function valueText(value: number) {
  return valueFormatter.format(value || 0);
}

function toneText(variant: RowVariant, dim: boolean) {
  if (variant === "grand") return dim ? "text-slate-500" : "font-semibold text-white";
  if (variant === "subtotal") return dim ? "text-slate-400" : "font-bold text-slate-900";
  return dim ? "text-slate-300" : "text-slate-700";
}

function NumCell({
  bg = "",
  kind = "int",
  muted = false,
  value,
  variant,
}: {
  bg?: string;
  kind?: "int" | "value";
  muted?: boolean;
  value: number | null;
  variant: RowVariant;
}) {
  const base = "whitespace-nowrap px-3 py-2 text-right tabular-nums";
  if (value === null) {
    return <td className={cn(base, bg, variant === "grand" ? "text-slate-500" : "text-slate-300")}>{BLANK}</td>;
  }
  const dim = muted || value === 0;
  const text = kind === "value" ? valueText(value) : formatNumber(value);
  return <td className={cn(base, bg, toneText(variant, dim))}>{text}</td>;
}

function AchCell({ bg = "", value, variant }: { bg?: string; value: number | null; variant: RowVariant }) {
  const base = "whitespace-nowrap px-3 py-2 text-right tabular-nums";
  if (value === null) {
    return <td className={cn(base, bg, variant === "grand" ? "text-slate-500" : "text-slate-300")}>{BLANK}</td>;
  }
  return <td className={cn(base, bg, variant === "grand" ? "font-semibold text-white" : "text-slate-600")}>{formatPercent(value, { input: "ratio" })}</td>;
}

// Darker-orange tint for the Achievement % column so it reads as its own axis.
function achBgFor(variant: RowVariant) {
  if (variant === "area") return "bg-orange-100";
  if (variant === "subtotal") return "bg-orange-200/80";
  return "";
}

// Stronger-orange tint for the rightmost Grand Total block.
function totalBgFor(variant: RowVariant) {
  if (variant === "area") return "bg-[#FBD8A6]";
  if (variant === "subtotal") return "bg-[#F4C078]";
  return "";
}

function ProductCells({ bandTint, cell, rowBg, variant }: { bandTint: boolean; cell: MonthlyClosingCell; rowBg?: string; variant: RowVariant }) {
  const bg = rowBg ?? (variant === "area" && bandTint ? "bg-orange-50/50" : "");
  const achBg = rowBg ?? achBgFor(variant);
  return (
    <>
      <NumCell bg={bg} value={cell.salesUnits} variant={variant} />
      <NumCell bg={bg} kind="value" value={cell.salesValue} variant={variant} />
      <NumCell bg={bg} muted value={cell.targetUnits} variant={variant} />
      <NumCell bg={bg} kind="value" muted value={cell.targetValue} variant={variant} />
      <AchCell bg={achBg} value={cell.achievement} variant={variant} />
    </>
  );
}

function TotalCells({ cell, rowBg, variant }: { cell: MonthlyClosingCell; rowBg?: string; variant: RowVariant }) {
  const bg = rowBg ?? totalBgFor(variant);
  return (
    <>
      <NumCell bg={bg} kind="value" value={cell.salesValue} variant={variant} />
      <NumCell bg={bg} kind="value" muted value={cell.targetValue} variant={variant} />
      <AchCell bg={bg} value={cell.achievement} variant={variant} />
    </>
  );
}

function MetricHeaders() {
  const cell = "sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle";
  return (
    <>
      <th className={cell} style={{ top: 44 }}>Units</th>
      <th className={cell} style={{ top: 44 }}>Value</th>
      <th className={`${cell} font-normal opacity-60`} style={{ top: 44 }}>Tgt Units</th>
      <th className={`${cell} font-normal opacity-60`} style={{ top: 44 }}>Tgt Value</th>
      <th className={`${cell} phx-ach`} style={{ top: 44 }}>Ach %</th>
    </>
  );
}

// Fixed column widths (px) — generous like the workbook so numbers breathe and the table
// scrolls horizontally instead of squashing 30 columns into one screen width.
const COL = { ach: 64, area: 92, gtAch: 64, gtTgt: 96, gtValue: 110, name: 196, tgtUnits: 66, tgtValue: 96, units: 70, value: 102 };
const PRODUCT_GROUP_WIDTH = COL.units + COL.value + COL.tgtUnits + COL.tgtValue + COL.ach;
const STICKY1 = "sticky left-0 z-20";
const STICKY2 = "sticky z-20";

function RegionBlock({ region }: { region: MonthlyClosingRegionGroup }) {
  return (
    <>
      {region.areas.map((area) => {
        // Direct (company) rows get a distinct blue band across the WHOLE row so they stand
        // apart from the orange area/region palette.
        const directBg = "bg-[#CFE0FB]";
        return (
          <tr className={area.isDirect ? "" : "transition-colors hover:bg-orange-50/40"} key={area.areaCode}>
            <td className={`${STICKY1} whitespace-nowrap px-3 py-2.5 font-semibold ${area.isDirect ? `${directBg} uppercase tracking-wide text-[#1D4ED8]` : "bg-white text-slate-900"}`}>{area.isDirect ? "◆ Direct" : area.areaCode}</td>
            <td className={`${STICKY2} truncate px-3 py-2.5 ${area.isDirect ? `${directBg} font-bold text-[#1D4ED8]` : "bg-white text-slate-600"}`} style={{ left: COL.area }}>{area.isDirect ? "Direct orders (company)" : area.areaName}</td>
            {area.cells.map((cell, index) => (
              <ProductCells bandTint={index % 2 === 1} cell={cell} key={`${area.areaCode}-${index}`} rowBg={area.isDirect ? directBg : undefined} variant="area" />
            ))}
            <TotalCells cell={area.rowTotal} rowBg={area.isDirect ? directBg : undefined} variant="area" />
          </tr>
        );
      })}
      <tr className="bg-[#FDEAD0]">
        <td className={`${STICKY1} whitespace-nowrap bg-[#FDEAD0] px-3 py-2.5 font-black uppercase tracking-wide text-slate-900`}>{region.regionCode}</td>
        <td className={`${STICKY2} truncate bg-[#FDEAD0] px-3 py-2.5 font-black text-slate-900`} style={{ left: COL.area }}>{region.regionName}</td>
        {region.subtotal.cells.map((cell, index) => (
          <ProductCells bandTint={index % 2 === 1} cell={cell} key={`sub-${region.regionCode}-${index}`} variant="subtotal" />
        ))}
        <TotalCells cell={region.subtotal.rowTotal} variant="subtotal" />
      </tr>
    </>
  );
}

export function ClosingMatrixTable({ matrix }: { matrix: MonthlyClosingMatrix }) {
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  function syncScroll(source: HTMLDivElement | null, target: HTMLDivElement | null) {
    if (!source || !target || syncing.current) return;
    syncing.current = true;
    target.scrollLeft = source.scrollLeft;
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  }

  if (matrix.columns.length === 0) {
    return (
      <div className="p-4 md:p-5">
        <AdminCallout tone="warning">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <p>No products match the current filters for this line.</p>
        </AdminCallout>
      </div>
    );
  }

  const tableWidth = COL.area + COL.name + matrix.columns.length * PRODUCT_GROUP_WIDTH + COL.gtValue + COL.gtTgt + COL.gtAch;
  const bandHeader = "whitespace-nowrap px-3 align-middle";

  return (
    <div className="p-4 md:p-5">
      {/* Solid black header band + crisp light-orange grid (matches the exported workbook).
          Scoped to this table with table-level specificity so it is opaque on scroll (the
          sticky header must cover the rows beneath it) regardless of the global shell rules. */}
      <style>{`
        table.phx-closing-grid th, table.phx-closing-grid td { border: 1px solid #F4B66E !important; }
        table.phx-closing-grid thead th { background-color: #0B0B0B !important; color: #F1F5F9 !important; box-shadow: inset 0 -2px 0 #F97316; }
      `}</style>

      {/* Top horizontal scrollbar (synced proxy) */}
      <div
        className="overflow-x-auto overflow-y-hidden border-x border-t border-[#E2E8F0]"
        onScroll={() => syncScroll(topRef.current, bodyRef.current)}
        ref={topRef}
        style={{ height: 14 }}
      >
        <div style={{ height: 1, width: tableWidth }} />
      </div>

      <div
        className="max-h-[72vh] overflow-auto border border-[#E2E8F0]"
        onScroll={() => syncScroll(bodyRef.current, topRef.current)}
        ref={bodyRef}
      >
        <table className="phx-closing-grid text-sm" style={{ tableLayout: "fixed", width: tableWidth }}>
          <colgroup>
            <col style={{ width: COL.area }} />
            <col style={{ width: COL.name }} />
            {matrix.columns.flatMap((column, index) => [
              <col key={`u${index}`} style={{ width: COL.units }} />,
              <col key={`v${index}`} style={{ width: COL.value }} />,
              <col key={`tu${index}`} style={{ width: COL.tgtUnits }} />,
              <col key={`tv${index}`} style={{ width: COL.tgtValue }} />,
              <col key={`a${index}`} style={{ width: COL.ach }} />,
            ])}
            <col style={{ width: COL.gtValue }} />
            <col style={{ width: COL.gtTgt }} />
            <col style={{ width: COL.gtAch }} />
          </colgroup>
          <thead>
            <tr>
              <th className={`${bandHeader} ${STICKY1} top-0 z-40 h-11`} rowSpan={2}>Area</th>
              <th className={`${bandHeader} ${STICKY2} top-0 z-40 h-11`} rowSpan={2} style={{ left: COL.area }}>Area Name</th>
              {matrix.columns.map((column) => (
                <th className={`${bandHeader} sticky top-0 z-30 h-11`} colSpan={5} key={column.productCode}>
                  <span className="block truncate text-[12px] font-black leading-tight" style={{ color: "#FDBA74" }}>{column.productName}</span>
                  <span className="block text-[10px] font-normal" style={{ color: "#CBD5E1" }}>{column.productCode}</span>
                </th>
              ))}
              <th className={`${bandHeader} phx-gt sticky top-0 z-30 h-11`} colSpan={3}>Grand Total</th>
            </tr>
            <tr>
              {matrix.columns.map((column) => (
                <MetricHeaders key={`m-${column.productCode}`} />
              ))}
              <th className="phx-gt sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle" style={{ top: 44 }}>Value</th>
              <th className="phx-gt sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle font-normal opacity-60" style={{ top: 44 }}>Tgt Value</th>
              <th className="phx-gt phx-ach sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle" style={{ top: 44 }}>Ach %</th>
            </tr>
          </thead>
          <tbody>
            {matrix.regions.map((region) => (
              <RegionBlock key={region.regionCode} region={region} />
            ))}
            <tr className="bg-[#0B0B0B]">
              <td className={`${STICKY1} whitespace-nowrap bg-[#0B0B0B] px-3 py-3 font-black uppercase tracking-wide text-white`}>NAT</td>
              <td className={`${STICKY2} whitespace-nowrap bg-[#0B0B0B] px-3 py-3 font-black text-white`} style={{ left: COL.area }}>National Grand Total</td>
              {matrix.grandTotal.cells.map((cell, index) => (
                <ProductCells bandTint={index % 2 === 1} cell={cell} key={`gt-${matrix.columns[index]?.productCode ?? index}`} variant="grand" />
              ))}
              <TotalCells cell={matrix.grandTotal.rowTotal} variant="grand" />
            </tr>
            {matrix.directNational ? (
              <tr>
                <td className={`${STICKY1} whitespace-nowrap bg-[#B6CEF8] px-3 py-2.5 font-black uppercase tracking-wide text-[#1E3A8A]`}>◆ DIR</td>
                <td className={`${STICKY2} whitespace-nowrap bg-[#B6CEF8] px-3 py-2.5 font-black text-[#1E3A8A]`} style={{ left: COL.area }}>Direct – National</td>
                {matrix.directNational.cells.map((cell, index) => (
                  <ProductCells bandTint={index % 2 === 1} cell={cell} key={`dn-${matrix.columns[index]?.productCode ?? index}`} rowBg="bg-[#B6CEF8]" variant="subtotal" />
                ))}
                <TotalCells cell={matrix.directNational.rowTotal} rowBg="bg-[#B6CEF8]" variant="subtotal" />
              </tr>
            ) : null}
            {matrix.companyTotal ? (
              <tr className="bg-[#0B0B0B]">
                <td className={`${STICKY1} whitespace-nowrap bg-[#0B0B0B] px-3 py-3 font-black uppercase tracking-wide text-[#FDBA74]`}>TOT</td>
                <td className={`${STICKY2} whitespace-nowrap bg-[#0B0B0B] px-3 py-3 font-black text-[#FDBA74]`} style={{ left: COL.area }}>Grand Total (incl. Direct)</td>
                {matrix.companyTotal.cells.map((cell, index) => (
                  <ProductCells bandTint={index % 2 === 1} cell={cell} key={`ct-${matrix.columns[index]?.productCode ?? index}`} variant="grand" />
                ))}
                <TotalCells cell={matrix.companyTotal.rowTotal} variant="grand" />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Values in EGP, computed as Qty × factory price × (1 − discount). Region rows and the national total are
        roll-ups of their areas — each area is counted once. Target and Achievement populate after the targets upload.
      </p>
    </div>
  );
}
