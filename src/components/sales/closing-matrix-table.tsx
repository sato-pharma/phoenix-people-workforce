"use client";

import { AlertTriangle } from "lucide-react";
import { Fragment } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { cn } from "@/lib/utils";
import { formatNumber, formatPercent } from "@/lib/sales/format";
import type {
  MonthlyClosingCell,
  MonthlyClosingColumn,
  MonthlyClosingMatrix,
  MonthlyClosingRegionGroup,
} from "@/lib/sales/monthly-distributor-import";

// Shared, read-only render of the monthly closing matrix. Used by the admin
// Source-of-Sales workspace and the employee-portal closing view so both surfaces
// stay pixel-identical. Pure presentation — the caller pre-filters/scopes the matrix.
//
// Layout: one narrow table PER PRODUCT (plus one per multi-product family, plus a
// final cross-product Grand Total table), stacked vertically — instead of one very
// wide table with 6 columns per product side by side. Every table lists the same
// areas/regions/totals as rows; nothing is hidden, it's just reorganized so no
// individual table needs horizontal scrolling.

type RowVariant = "area" | "subtotal" | "grand";

const valueFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const BLANK = "—";
const DIRECT_BG = "bg-[#CFE0FB]";

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

// Contribution % — share of this row's sales within the product's / row-total's national total.
function ContribCell({ bg = "", value, variant }: { bg?: string; value: number | null; variant: RowVariant }) {
  const base = "whitespace-nowrap px-3 py-2 text-right tabular-nums";
  if (value === null) {
    return <td className={cn(base, bg, variant === "grand" ? "text-slate-500" : "text-slate-300")}>{BLANK}</td>;
  }
  const color =
    variant === "grand" ? "font-semibold text-sky-200" :
    variant === "subtotal" ? "font-bold text-sky-700" :
    "text-sky-600";
  return <td className={cn(base, bg, color)}>{formatPercent(value, { input: "ratio" })}</td>;
}

// Darker-orange tint for the Achievement % column so it reads as its own axis.
function achBgFor(variant: RowVariant) {
  if (variant === "area") return "bg-orange-100";
  if (variant === "subtotal") return "bg-orange-200/80";
  return "";
}

// Sky-blue tint for the Contribution % column — visually distinct from Achievement.
function contrBgFor(variant: RowVariant) {
  if (variant === "area") return "bg-sky-50";
  if (variant === "subtotal") return "bg-sky-100";
  return "";
}

// Stronger-orange tint for the Grand Total table.
function totalBgFor(variant: RowVariant) {
  if (variant === "area") return "bg-[#FBD8A6]";
  if (variant === "subtotal") return "bg-[#F4C078]";
  return "";
}

// Amber tint for the family summary table (display-only, not added to Grand Total).
function famBgFor(variant: RowVariant) {
  if (variant === "area") return "bg-amber-50";
  if (variant === "subtotal") return "bg-amber-100";
  return "";
}

// ── Column grouping ───────────────────────────────────────────────────────────
// Consecutive columns that share the same family name are grouped. Multi-product
// families (isMulti=true) get their own family-total table after their members.

type ColumnGroup = { family: string; indices: number[]; isMulti: boolean };

function groupColumns(columns: MonthlyClosingColumn[]): ColumnGroup[] {
  const groups: ColumnGroup[] = [];
  for (const [idx, col] of columns.entries()) {
    const last = groups[groups.length - 1];
    if (!last || last.family !== col.family) {
      groups.push({ family: col.family, indices: [idx], isMulti: false });
    } else {
      last.indices.push(idx);
    }
  }
  for (const g of groups) g.isMulti = g.indices.length > 1;
  return groups;
}

// ── Cell renderers ────────────────────────────────────────────────────────────

function ProductCells({
  cell,
  productTotal,
  rowBg,
  variant,
}: {
  cell: MonthlyClosingCell;
  productTotal: number | null;
  rowBg?: string;
  variant: RowVariant;
}) {
  const bg = rowBg ?? "";
  const achBg = rowBg ?? achBgFor(variant);
  const contrBg = rowBg ?? contrBgFor(variant);
  const contrib =
    productTotal && productTotal > 0 ? (cell.salesValue ?? 0) / productTotal : null;
  return (
    <>
      <NumCell bg={bg} value={cell.salesUnits} variant={variant} />
      <NumCell bg={bg} kind="value" value={cell.salesValue} variant={variant} />
      <ContribCell bg={contrBg} value={contrib} variant={variant} />
      <NumCell bg={bg} muted value={cell.targetUnits} variant={variant} />
      <NumCell bg={bg} kind="value" muted value={cell.targetValue} variant={variant} />
      <AchCell bg={achBg} value={cell.achievement} variant={variant} />
    </>
  );
}

// Family summary: Sales Value + Target Value + Contr % (family share of national GT).
// These 3 columns are purely derivative — the Grand Total rowTotal is NOT affected.
function FamilyCells({
  cells,
  grandTotalValue,
  group,
  rowBg,
  variant,
}: {
  cells: MonthlyClosingCell[];
  grandTotalValue: number;
  group: ColumnGroup;
  rowBg?: string;
  variant: RowVariant;
}) {
  const bg = rowBg ?? famBgFor(variant);
  const famValue = group.indices.reduce((s, i) => s + (cells[i]?.salesValue ?? 0), 0);
  const famTargetRaw = group.indices.reduce((s, i) => s + (cells[i]?.targetValue ?? 0), 0);
  const famTarget = famTargetRaw > 0 ? famTargetRaw : null;
  const famContr = grandTotalValue > 0 ? famValue / grandTotalValue : null;
  return (
    <>
      <NumCell bg={bg} kind="value" value={famValue} variant={variant} />
      <NumCell bg={bg} kind="value" muted value={famTarget} variant={variant} />
      <ContribCell bg={bg} value={famContr} variant={variant} />
    </>
  );
}

function TotalCells({
  cell,
  grandTotal,
  rowBg,
  variant,
}: {
  cell: MonthlyClosingCell;
  grandTotal: number | null;
  rowBg?: string;
  variant: RowVariant;
}) {
  const bg = rowBg ?? totalBgFor(variant);
  const contrib =
    grandTotal && grandTotal > 0 ? (cell.salesValue ?? 0) / grandTotal : null;
  return (
    <>
      <NumCell bg={bg} kind="value" value={cell.salesValue} variant={variant} />
      <ContribCell bg={bg} value={contrib} variant={variant} />
      <NumCell bg={bg} kind="value" muted value={cell.targetValue} variant={variant} />
      <AchCell bg={bg} value={cell.achievement} variant={variant} />
    </>
  );
}

// ── Label cells (Area / Area Name — first two columns of every table) ────────

function LabelCell({ children, className }: { children: React.ReactNode; className: string }) {
  return <td className={cn("sticky left-0 z-10 whitespace-nowrap px-3 py-2.5 font-semibold", className)}>{children}</td>;
}

function NameCell({ children, className }: { children: React.ReactNode; className: string }) {
  return <td className={cn("truncate px-3 py-2.5", className)}>{children}</td>;
}

function areaLabelClass(isDirect: boolean | undefined) {
  return isDirect ? `${DIRECT_BG} uppercase tracking-wide text-[#1D4ED8]` : "bg-white text-slate-900";
}

function areaNameClass(isDirect: boolean | undefined) {
  return isDirect ? `${DIRECT_BG} font-bold text-[#1D4ED8]` : "bg-white text-slate-600";
}

// ── Header helpers ─────────────────────────────────────────────────────────────
// Each mini-table has a single sticky header row (no more two-row offset math).

function AreaHeaderCells() {
  return (
    <>
      <th className="sticky left-0 top-0 z-20 whitespace-nowrap px-3 py-2 text-left align-middle">Area</th>
      <th className="sticky top-0 z-10 whitespace-nowrap px-3 py-2 text-left align-middle">Area Name</th>
    </>
  );
}

function MetricHeaders() {
  const cell = "sticky top-0 z-10 whitespace-nowrap px-2 py-1.5 align-middle";
  return (
    <>
      <th className={cell}>Units</th>
      <th className={cell}>Value</th>
      <th className={`${cell} phx-contr`}>Contr %</th>
      <th className={`${cell} font-normal opacity-60`}>Tgt Units</th>
      <th className={`${cell} font-normal opacity-60`}>Tgt Value</th>
      <th className={`${cell} phx-ach`}>Ach %</th>
    </>
  );
}

// Sub-headers for the family-total table: Value (amber) | Tgt Value (amber) | Contr % (dark-blue).
function FamilySubHeaders() {
  const cell = "sticky top-0 z-10 whitespace-nowrap px-2 py-1.5 align-middle phx-family";
  return (
    <>
      <th className={cell}>Value</th>
      <th className={`${cell} font-normal opacity-70`}>Tgt Value</th>
      <th className="sticky top-0 z-10 whitespace-nowrap px-2 py-1.5 align-middle phx-contr">Contr %</th>
    </>
  );
}

// ── Product table (one per product — Area, Area Name, Units, Value, Contr %,
//    Tgt Units, Tgt Value, Ach %) ────────────────────────────────────────────

function ProductAreaRows({
  idx,
  productTotal,
  region,
}: {
  idx: number;
  productTotal: number | null;
  region: MonthlyClosingRegionGroup;
}) {
  return (
    <>
      {region.areas.map((area) => (
        <tr className={area.isDirect ? undefined : "transition-colors hover:bg-orange-50/40"} key={area.areaCode}>
          <LabelCell className={areaLabelClass(area.isDirect)}>{area.isDirect ? "◆ Direct" : area.areaCode}</LabelCell>
          <NameCell className={areaNameClass(area.isDirect)}>{area.isDirect ? "Direct orders (company)" : area.areaName}</NameCell>
          <ProductCells cell={area.cells[idx]} productTotal={productTotal} rowBg={area.isDirect ? DIRECT_BG : undefined} variant="area" />
        </tr>
      ))}
      <tr className="bg-[#FDEAD0]">
        <LabelCell className="bg-[#FDEAD0] font-black uppercase tracking-wide text-slate-900">{region.regionCode}</LabelCell>
        <NameCell className="bg-[#FDEAD0] font-black text-slate-900">{region.regionName}</NameCell>
        <ProductCells cell={region.subtotal.cells[idx]} productTotal={productTotal} variant="subtotal" />
      </tr>
    </>
  );
}

function ProductMatrixTable({
  column,
  idx,
  matrix,
  productTotal,
}: {
  column: MonthlyClosingColumn;
  idx: number;
  matrix: MonthlyClosingMatrix;
  productTotal: number | null;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="truncate text-[13px] font-black text-slate-950">{column.productName}</h3>
        <span className="text-[11px] font-medium text-slate-400">{column.productCode}</span>
      </div>
      <div className="overflow-x-auto border border-[#E2E8F0]">
        <table className="phx-closing-grid w-full text-sm">
          <thead>
            <tr>
              <AreaHeaderCells />
              <MetricHeaders />
            </tr>
          </thead>
          <tbody>
            {matrix.regions.map((region) => (
              <ProductAreaRows idx={idx} key={region.regionCode} productTotal={productTotal} region={region} />
            ))}
            <tr className="bg-[#0B0B0B]">
              <LabelCell className="bg-[#0B0B0B] font-black uppercase tracking-wide text-white">NAT</LabelCell>
              <NameCell className="bg-[#0B0B0B] font-black text-white">National Grand Total</NameCell>
              <ProductCells cell={matrix.grandTotal.cells[idx]} productTotal={productTotal} variant="grand" />
            </tr>
            {matrix.directNational ? (
              <tr>
                <LabelCell className={`${DIRECT_BG} uppercase tracking-wide text-[#1E3A8A]`}>◆ DIR</LabelCell>
                <NameCell className={`${DIRECT_BG} font-black text-[#1E3A8A]`}>Direct – National</NameCell>
                <ProductCells cell={matrix.directNational.cells[idx]} productTotal={productTotal} rowBg={DIRECT_BG} variant="subtotal" />
              </tr>
            ) : null}
            {matrix.companyTotal ? (
              <tr className="bg-[#0B0B0B]">
                <LabelCell className="bg-[#0B0B0B] font-black uppercase tracking-wide text-[#FDBA74]">TOT</LabelCell>
                <NameCell className="bg-[#0B0B0B] font-black text-[#FDBA74]">Grand Total (incl. Direct)</NameCell>
                <ProductCells cell={matrix.companyTotal.cells[idx]} productTotal={productTotal} variant="grand" />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Family-total table (one per multi-product family — Area, Area Name, Value,
//    Tgt Value, Contr %) ──────────────────────────────────────────────────────

function FamilyAreaRows({
  grandTotalValue,
  group,
  region,
}: {
  grandTotalValue: number;
  group: ColumnGroup;
  region: MonthlyClosingRegionGroup;
}) {
  return (
    <>
      {region.areas.map((area) => (
        <tr className={area.isDirect ? undefined : "transition-colors hover:bg-amber-50/40"} key={area.areaCode}>
          <LabelCell className={areaLabelClass(area.isDirect)}>{area.isDirect ? "◆ Direct" : area.areaCode}</LabelCell>
          <NameCell className={areaNameClass(area.isDirect)}>{area.isDirect ? "Direct orders (company)" : area.areaName}</NameCell>
          <FamilyCells cells={area.cells} grandTotalValue={grandTotalValue} group={group} rowBg={area.isDirect ? DIRECT_BG : undefined} variant="area" />
        </tr>
      ))}
      <tr className="bg-[#FDEAD0]">
        <LabelCell className="bg-[#FDEAD0] font-black uppercase tracking-wide text-slate-900">{region.regionCode}</LabelCell>
        <NameCell className="bg-[#FDEAD0] font-black text-slate-900">{region.regionName}</NameCell>
        <FamilyCells cells={region.subtotal.cells} grandTotalValue={grandTotalValue} group={group} variant="subtotal" />
      </tr>
    </>
  );
}

function FamilyMatrixTable({
  grandTotalValue,
  group,
  matrix,
}: {
  grandTotalValue: number;
  group: ColumnGroup;
  matrix: MonthlyClosingMatrix;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="truncate text-[13px] font-black text-amber-800">{group.family}</h3>
        <span className="text-[11px] font-medium text-amber-700/70">Family Total</span>
      </div>
      <div className="overflow-x-auto border border-[#E2E8F0]">
        <table className="phx-closing-grid w-full text-sm">
          <thead>
            <tr>
              <AreaHeaderCells />
              <FamilySubHeaders />
            </tr>
          </thead>
          <tbody>
            {matrix.regions.map((region) => (
              <FamilyAreaRows grandTotalValue={grandTotalValue} group={group} key={region.regionCode} region={region} />
            ))}
            <tr className="bg-[#0B0B0B]">
              <LabelCell className="bg-[#0B0B0B] font-black uppercase tracking-wide text-white">NAT</LabelCell>
              <NameCell className="bg-[#0B0B0B] font-black text-white">National Grand Total</NameCell>
              <FamilyCells cells={matrix.grandTotal.cells} grandTotalValue={grandTotalValue} group={group} variant="grand" />
            </tr>
            {matrix.directNational ? (
              <tr>
                <LabelCell className={`${DIRECT_BG} uppercase tracking-wide text-[#1E3A8A]`}>◆ DIR</LabelCell>
                <NameCell className={`${DIRECT_BG} font-black text-[#1E3A8A]`}>Direct – National</NameCell>
                <FamilyCells cells={matrix.directNational.cells} grandTotalValue={grandTotalValue} group={group} rowBg={DIRECT_BG} variant="subtotal" />
              </tr>
            ) : null}
            {matrix.companyTotal ? (
              <tr className="bg-[#0B0B0B]">
                <LabelCell className="bg-[#0B0B0B] font-black uppercase tracking-wide text-[#FDBA74]">TOT</LabelCell>
                <NameCell className="bg-[#0B0B0B] font-black text-[#FDBA74]">Grand Total (incl. Direct)</NameCell>
                <FamilyCells cells={matrix.companyTotal.cells} grandTotalValue={grandTotalValue} group={group} variant="grand" />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Grand Total table (across ALL products — Area, Area Name, Value, Contr %,
//    Tgt Value, Ach %) ────────────────────────────────────────────────────────

function GrandTotalAreaRows({
  grandTotalValue,
  region,
}: {
  grandTotalValue: number;
  region: MonthlyClosingRegionGroup;
}) {
  return (
    <>
      {region.areas.map((area) => (
        <tr className={area.isDirect ? undefined : "transition-colors hover:bg-orange-50/40"} key={area.areaCode}>
          <LabelCell className={areaLabelClass(area.isDirect)}>{area.isDirect ? "◆ Direct" : area.areaCode}</LabelCell>
          <NameCell className={areaNameClass(area.isDirect)}>{area.isDirect ? "Direct orders (company)" : area.areaName}</NameCell>
          <TotalCells cell={area.rowTotal} grandTotal={grandTotalValue} rowBg={area.isDirect ? DIRECT_BG : undefined} variant="area" />
        </tr>
      ))}
      <tr className="bg-[#FDEAD0]">
        <LabelCell className="bg-[#FDEAD0] font-black uppercase tracking-wide text-slate-900">{region.regionCode}</LabelCell>
        <NameCell className="bg-[#FDEAD0] font-black text-slate-900">{region.regionName}</NameCell>
        <TotalCells cell={region.subtotal.rowTotal} grandTotal={grandTotalValue} variant="subtotal" />
      </tr>
    </>
  );
}

function GrandTotalMatrixTable({
  grandTotalValue,
  matrix,
}: {
  grandTotalValue: number;
  matrix: MonthlyClosingMatrix;
}) {
  const cell = "sticky top-0 z-10 whitespace-nowrap px-2 py-1.5 align-middle phx-gt";
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-[13px] font-black text-slate-950">Grand Total</h3>
        <span className="text-[11px] font-medium text-slate-400">All products combined</span>
      </div>
      <div className="overflow-x-auto border border-[#E2E8F0]">
        <table className="phx-closing-grid w-full text-sm">
          <thead>
            <tr>
              <AreaHeaderCells />
              <th className={cell}>Value</th>
              <th className={`${cell} phx-contr`}>Contr %</th>
              <th className={`${cell} font-normal opacity-60`}>Tgt Value</th>
              <th className={`${cell} phx-ach`}>Ach %</th>
            </tr>
          </thead>
          <tbody>
            {matrix.regions.map((region) => (
              <GrandTotalAreaRows grandTotalValue={grandTotalValue} key={region.regionCode} region={region} />
            ))}
            <tr className="bg-[#0B0B0B]">
              <LabelCell className="bg-[#0B0B0B] font-black uppercase tracking-wide text-white">NAT</LabelCell>
              <NameCell className="bg-[#0B0B0B] font-black text-white">National Grand Total</NameCell>
              <TotalCells cell={matrix.grandTotal.rowTotal} grandTotal={grandTotalValue} variant="grand" />
            </tr>
            {matrix.directNational ? (
              <tr>
                <LabelCell className={`${DIRECT_BG} uppercase tracking-wide text-[#1E3A8A]`}>◆ DIR</LabelCell>
                <NameCell className={`${DIRECT_BG} font-black text-[#1E3A8A]`}>Direct – National</NameCell>
                <TotalCells cell={matrix.directNational.rowTotal} grandTotal={grandTotalValue} rowBg={DIRECT_BG} variant="subtotal" />
              </tr>
            ) : null}
            {matrix.companyTotal ? (
              <tr className="bg-[#0B0B0B]">
                <LabelCell className="bg-[#0B0B0B] font-black uppercase tracking-wide text-[#FDBA74]">TOT</LabelCell>
                <NameCell className="bg-[#0B0B0B] font-black text-[#FDBA74]">Grand Total (incl. Direct)</NameCell>
                <TotalCells cell={matrix.companyTotal.rowTotal} grandTotal={grandTotalValue} variant="grand" />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────────

export function ClosingMatrixTable({ matrix }: { matrix: MonthlyClosingMatrix }) {
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

  const columnGroups = groupColumns(matrix.columns);

  // Per-product national totals for contribution % — derived from the grand total row.
  const productTotals = matrix.grandTotal.cells.map((c) => c.salesValue ?? 0);
  const grandTotalValue = matrix.grandTotal.rowTotal.salesValue ?? 0;

  return (
    <div className="space-y-8 p-4 md:p-5">
      {/* Solid black header band + crisp light-orange grid, shared by every stacked
          table below via the phx-closing-grid class. Family headers use amber so
          they read as a separate axis; Contr %/Ach % headers get their own tint. */}
      <style>{`
        table.phx-closing-grid th, table.phx-closing-grid td { border: 1px solid #F4B66E !important; }
        table.phx-closing-grid thead th { background-color: #0B0B0B !important; color: #F1F5F9 !important; box-shadow: inset 0 -2px 0 #F97316; }
        table.phx-closing-grid thead th.phx-family { background-color: #78350f !important; color: #fef3c7 !important; box-shadow: inset 0 -2px 0 #d97706; }
        table.phx-closing-grid .phx-contr { background-color: #0c3352 !important; }
      `}</style>

      {columnGroups.map((group, gi) => (
        <Fragment key={gi}>
          {group.indices.map((idx) => (
            <ProductMatrixTable
              column={matrix.columns[idx]}
              idx={idx}
              key={idx}
              matrix={matrix}
              productTotal={productTotals[idx] ?? null}
            />
          ))}
          {group.isMulti && (
            <FamilyMatrixTable grandTotalValue={grandTotalValue} group={group} matrix={matrix} />
          )}
        </Fragment>
      ))}

      <GrandTotalMatrixTable grandTotalValue={grandTotalValue} matrix={matrix} />
    </div>
  );
}
