"use client";

import { AlertTriangle } from "lucide-react";
import { Fragment, useRef } from "react";

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

// Stronger-orange tint for the rightmost Grand Total block.
function totalBgFor(variant: RowVariant) {
  if (variant === "area") return "bg-[#FBD8A6]";
  if (variant === "subtotal") return "bg-[#F4C078]";
  return "";
}

// Amber tint for the family summary columns (display-only, not added to Grand Total).
function famBgFor(variant: RowVariant) {
  if (variant === "area") return "bg-amber-50";
  if (variant === "subtotal") return "bg-amber-100";
  return "";
}

// ── Column grouping ───────────────────────────────────────────────────────────
// Consecutive columns that share the same family name are grouped. Multi-product
// families (isMulti=true) get a 3-column family summary block after their members.

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
  bandTint,
  cell,
  productTotal,
  rowBg,
  variant,
}: {
  bandTint: boolean;
  cell: MonthlyClosingCell;
  productTotal: number | null;
  rowBg?: string;
  variant: RowVariant;
}) {
  const bg = rowBg ?? (variant === "area" && bandTint ? "bg-orange-50/50" : "");
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

// ── Header helpers ─────────────────────────────────────────────────────────────

function MetricHeaders() {
  const cell = "sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle";
  return (
    <>
      <th className={cell} style={{ top: 44 }}>Units</th>
      <th className={cell} style={{ top: 44 }}>Value</th>
      <th className={`${cell} phx-contr`} style={{ top: 44 }}>Contr %</th>
      <th className={`${cell} font-normal opacity-60`} style={{ top: 44 }}>Tgt Units</th>
      <th className={`${cell} font-normal opacity-60`} style={{ top: 44 }}>Tgt Value</th>
      <th className={`${cell} phx-ach`} style={{ top: 44 }}>Ach %</th>
    </>
  );
}

// Sub-headers for the family summary block: Value (amber) | Tgt Value (amber) | Contr % (dark-blue).
function FamilySubHeaders() {
  const cell = "sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle";
  return (
    <>
      <th className={`${cell} phx-family`} style={{ top: 44 }}>Value</th>
      <th className={`${cell} phx-family font-normal opacity-70`} style={{ top: 44 }}>Tgt Value</th>
      <th className={`${cell} phx-contr`} style={{ top: 44 }}>Contr %</th>
    </>
  );
}

// ── Column widths ──────────────────────────────────────────────────────────────

const COL = {
  ach: 64, area: 92,
  contr: 68,
  gtAch: 64, gtContr: 68,
  gtTgt: 96, gtValue: 110,
  // Family summary block (3 columns, no Units/Ach axis)
  famContr: 68, famTgt: 96, famValue: 102,
  name: 196, tgtUnits: 66, tgtValue: 96, units: 70, value: 102,
};
const PRODUCT_GROUP_WIDTH = COL.units + COL.value + COL.contr + COL.tgtUnits + COL.tgtValue + COL.ach;
const FAMILY_GROUP_WIDTH = COL.famValue + COL.famTgt + COL.famContr;
const STICKY1 = "sticky left-0 z-20";
const STICKY2 = "sticky z-20";

// ── RegionBlock ────────────────────────────────────────────────────────────────

function RegionBlock({
  columnGroups,
  grandTotalValue,
  productTotals,
  region,
}: {
  columnGroups: ColumnGroup[];
  grandTotalValue: number;
  productTotals: number[];
  region: MonthlyClosingRegionGroup;
}) {
  return (
    <>
      {region.areas.map((area) => {
        const directBg = "bg-[#CFE0FB]";
        return (
          <tr className={area.isDirect ? "" : "transition-colors hover:bg-orange-50/40"} key={area.areaCode}>
            <td className={`${STICKY1} whitespace-nowrap px-3 py-2.5 font-semibold ${area.isDirect ? `${directBg} uppercase tracking-wide text-[#1D4ED8]` : "bg-white text-slate-900"}`}>{area.isDirect ? "◆ Direct" : area.areaCode}</td>
            <td className={`${STICKY2} truncate px-3 py-2.5 ${area.isDirect ? `${directBg} font-bold text-[#1D4ED8]` : "bg-white text-slate-600"}`} style={{ left: COL.area }}>{area.isDirect ? "Direct orders (company)" : area.areaName}</td>
            {columnGroups.map((group, gi) => (
              <Fragment key={gi}>
                {group.indices.map((idx) => (
                  <ProductCells
                    bandTint={idx % 2 === 1}
                    cell={area.cells[idx]}
                    key={`${area.areaCode}-${idx}`}
                    productTotal={productTotals[idx] ?? null}
                    rowBg={area.isDirect ? directBg : undefined}
                    variant="area"
                  />
                ))}
                {group.isMulti && (
                  <FamilyCells
                    cells={area.cells}
                    grandTotalValue={grandTotalValue}
                    group={group}
                    key={`fam-${area.areaCode}-${gi}`}
                    rowBg={area.isDirect ? directBg : undefined}
                    variant="area"
                  />
                )}
              </Fragment>
            ))}
            <TotalCells cell={area.rowTotal} grandTotal={grandTotalValue} rowBg={area.isDirect ? directBg : undefined} variant="area" />
          </tr>
        );
      })}
      <tr className="bg-[#FDEAD0]">
        <td className={`${STICKY1} whitespace-nowrap bg-[#FDEAD0] px-3 py-2.5 font-black uppercase tracking-wide text-slate-900`}>{region.regionCode}</td>
        <td className={`${STICKY2} truncate bg-[#FDEAD0] px-3 py-2.5 font-black text-slate-900`} style={{ left: COL.area }}>{region.regionName}</td>
        {columnGroups.map((group, gi) => (
          <Fragment key={gi}>
            {group.indices.map((idx) => (
              <ProductCells
                bandTint={idx % 2 === 1}
                cell={region.subtotal.cells[idx]}
                key={`sub-${region.regionCode}-${idx}`}
                productTotal={productTotals[idx] ?? null}
                variant="subtotal"
              />
            ))}
            {group.isMulti && (
              <FamilyCells
                cells={region.subtotal.cells}
                grandTotalValue={grandTotalValue}
                group={group}
                key={`sub-fam-${region.regionCode}-${gi}`}
                variant="subtotal"
              />
            )}
          </Fragment>
        ))}
        <TotalCells cell={region.subtotal.rowTotal} grandTotal={grandTotalValue} variant="subtotal" />
      </tr>
    </>
  );
}

// ── Main export ────────────────────────────────────────────────────────────────

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

  const columnGroups = groupColumns(matrix.columns);
  const multiCount = columnGroups.filter((g) => g.isMulti).length;

  // Per-product national totals for contribution % — derived from the grand total row.
  const productTotals = matrix.grandTotal.cells.map((c) => c.salesValue ?? 0);
  const grandTotalValue = matrix.grandTotal.rowTotal.salesValue ?? 0;

  const tableWidth =
    COL.area + COL.name +
    matrix.columns.length * PRODUCT_GROUP_WIDTH +
    multiCount * FAMILY_GROUP_WIDTH +
    COL.gtValue + COL.gtContr + COL.gtTgt + COL.gtAch;

  const bandHeader = "whitespace-nowrap px-3 align-middle";

  return (
    <div className="p-4 md:p-5">
      {/* Solid black header band + crisp light-orange grid.
          Family block headers use amber (#78350f) so they read as a separate axis.
          Scoped to this table with table-level specificity so sticky header covers rows. */}
      <style>{`
        table.phx-closing-grid th, table.phx-closing-grid td { border: 1px solid #F4B66E !important; }
        table.phx-closing-grid thead th { background-color: #0B0B0B !important; color: #F1F5F9 !important; box-shadow: inset 0 -2px 0 #F97316; }
        table.phx-closing-grid thead th.phx-family { background-color: #78350f !important; color: #fef3c7 !important; box-shadow: inset 0 -2px 0 #d97706; }
        table.phx-closing-grid .phx-contr { background-color: #0c3352 !important; }
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
            {columnGroups.flatMap((group, gi) => [
              ...group.indices.flatMap((_, iInGroup) => [
                <col key={`u-${gi}-${iInGroup}`} style={{ width: COL.units }} />,
                <col key={`v-${gi}-${iInGroup}`} style={{ width: COL.value }} />,
                <col key={`c-${gi}-${iInGroup}`} style={{ width: COL.contr }} />,
                <col key={`tu-${gi}-${iInGroup}`} style={{ width: COL.tgtUnits }} />,
                <col key={`tv-${gi}-${iInGroup}`} style={{ width: COL.tgtValue }} />,
                <col key={`a-${gi}-${iInGroup}`} style={{ width: COL.ach }} />,
              ]),
              ...(group.isMulti ? [
                <col key={`fv-${gi}`} style={{ width: COL.famValue }} />,
                <col key={`ft-${gi}`} style={{ width: COL.famTgt }} />,
                <col key={`fc-${gi}`} style={{ width: COL.famContr }} />,
              ] : []),
            ])}
            <col style={{ width: COL.gtValue }} />
            <col style={{ width: COL.gtContr }} />
            <col style={{ width: COL.gtTgt }} />
            <col style={{ width: COL.gtAch }} />
          </colgroup>
          <thead>
            {/* Row 1: product names + family group banners + Grand Total */}
            <tr>
              <th className={`${bandHeader} ${STICKY1} top-0 z-40 h-11`} rowSpan={2}>Area</th>
              <th className={`${bandHeader} ${STICKY2} top-0 z-40 h-11`} rowSpan={2} style={{ left: COL.area }}>Area Name</th>
              {columnGroups.flatMap((group, gi) => [
                ...group.indices.map((idx) => (
                  <th className={`${bandHeader} sticky top-0 z-30 h-11`} colSpan={6} key={`ph-${gi}-${idx}`}>
                    <span className="block truncate text-[12px] font-black leading-tight" style={{ color: "#FDBA74" }}>{matrix.columns[idx].productName}</span>
                    <span className="block text-[10px] font-normal" style={{ color: "#CBD5E1" }}>{matrix.columns[idx].productCode}</span>
                  </th>
                )),
                ...(group.isMulti ? [
                  <th className={`${bandHeader} phx-family sticky top-0 z-30 h-11`} colSpan={3} key={`fh-${gi}`}>
                    <span className="block truncate text-[12px] font-black leading-tight">{group.family}</span>
                    <span className="block text-[10px] font-normal opacity-70">Family Total</span>
                  </th>,
                ] : []),
              ])}
              <th className={`${bandHeader} phx-gt sticky top-0 z-30 h-11`} colSpan={4}>Grand Total</th>
            </tr>
            {/* Row 2: per-column metric sub-headers */}
            <tr>
              {columnGroups.flatMap((group, gi) => [
                ...group.indices.map((idx) => (
                  <MetricHeaders key={`mh-${gi}-${idx}`} />
                )),
                ...(group.isMulti ? [<FamilySubHeaders key={`fsh-${gi}`} />] : []),
              ])}
              <th className="phx-gt sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle" style={{ top: 44 }}>Value</th>
              <th className="phx-gt phx-contr sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle" style={{ top: 44 }}>Contr %</th>
              <th className="phx-gt sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle font-normal opacity-60" style={{ top: 44 }}>Tgt Value</th>
              <th className="phx-gt phx-ach sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle" style={{ top: 44 }}>Ach %</th>
            </tr>
          </thead>
          <tbody>
            {matrix.regions.map((region) => (
              <RegionBlock
                columnGroups={columnGroups}
                grandTotalValue={grandTotalValue}
                key={region.regionCode}
                productTotals={productTotals}
                region={region}
              />
            ))}

            {/* National Grand Total — family columns shown here too but rowTotal is unchanged */}
            <tr className="bg-[#0B0B0B]">
              <td className={`${STICKY1} whitespace-nowrap bg-[#0B0B0B] px-3 py-3 font-black uppercase tracking-wide text-white`}>NAT</td>
              <td className={`${STICKY2} whitespace-nowrap bg-[#0B0B0B] px-3 py-3 font-black text-white`} style={{ left: COL.area }}>National Grand Total</td>
              {columnGroups.map((group, gi) => (
                <Fragment key={gi}>
                  {group.indices.map((idx) => (
                    <ProductCells
                      bandTint={idx % 2 === 1}
                      cell={matrix.grandTotal.cells[idx]}
                      key={`gt-${idx}`}
                      productTotal={productTotals[idx] ?? null}
                      variant="grand"
                    />
                  ))}
                  {group.isMulti && (
                    <FamilyCells
                      cells={matrix.grandTotal.cells}
                      grandTotalValue={grandTotalValue}
                      group={group}
                      key={`gt-fam-${gi}`}
                      variant="grand"
                    />
                  )}
                </Fragment>
              ))}
              {/* rowTotal is the unmodified sum of all individual products — no family duplication */}
              <TotalCells cell={matrix.grandTotal.rowTotal} grandTotal={grandTotalValue} variant="grand" />
            </tr>

            {matrix.directNational ? (
              <tr>
                <td className={`${STICKY1} whitespace-nowrap bg-[#B6CEF8] px-3 py-2.5 font-black uppercase tracking-wide text-[#1E3A8A]`}>◆ DIR</td>
                <td className={`${STICKY2} whitespace-nowrap bg-[#B6CEF8] px-3 py-2.5 font-black text-[#1E3A8A]`} style={{ left: COL.area }}>Direct – National</td>
                {columnGroups.map((group, gi) => (
                  <Fragment key={gi}>
                    {group.indices.map((idx) => (
                      <ProductCells
                        bandTint={idx % 2 === 1}
                        cell={matrix.directNational!.cells[idx]}
                        key={`dn-${idx}`}
                        productTotal={productTotals[idx] ?? null}
                        rowBg="bg-[#B6CEF8]"
                        variant="subtotal"
                      />
                    ))}
                    {group.isMulti && (
                      <FamilyCells
                        cells={matrix.directNational!.cells}
                        grandTotalValue={grandTotalValue}
                        group={group}
                        key={`dn-fam-${gi}`}
                        rowBg="bg-[#B6CEF8]"
                        variant="subtotal"
                      />
                    )}
                  </Fragment>
                ))}
                <TotalCells cell={matrix.directNational.rowTotal} grandTotal={grandTotalValue} rowBg="bg-[#B6CEF8]" variant="subtotal" />
              </tr>
            ) : null}

            {matrix.companyTotal ? (
              <tr className="bg-[#0B0B0B]">
                <td className={`${STICKY1} whitespace-nowrap bg-[#0B0B0B] px-3 py-3 font-black uppercase tracking-wide text-[#FDBA74]`}>TOT</td>
                <td className={`${STICKY2} whitespace-nowrap bg-[#0B0B0B] px-3 py-3 font-black text-[#FDBA74]`} style={{ left: COL.area }}>Grand Total (incl. Direct)</td>
                {columnGroups.map((group, gi) => (
                  <Fragment key={gi}>
                    {group.indices.map((idx) => (
                      <ProductCells
                        bandTint={idx % 2 === 1}
                        cell={matrix.companyTotal!.cells[idx]}
                        key={`ct-${idx}`}
                        productTotal={productTotals[idx] ?? null}
                        variant="grand"
                      />
                    ))}
                    {group.isMulti && (
                      <FamilyCells
                        cells={matrix.companyTotal!.cells}
                        grandTotalValue={grandTotalValue}
                        group={group}
                        key={`ct-fam-${gi}`}
                        variant="grand"
                      />
                    )}
                  </Fragment>
                ))}
                <TotalCells cell={matrix.companyTotal.rowTotal} grandTotal={grandTotalValue} variant="grand" />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Values in EGP, computed as Qty × factory price × (1 − discount). Contr % = this row&apos;s share of the national total for that product / grand total. Amber family columns sum all concentrations in the family — Contr % is the family&apos;s share of the national grand total. Family columns are display-only and not counted again in the Grand Total. Region rows and the national total are roll-ups of their areas — each area is counted once.
      </p>
    </div>
  );
}
