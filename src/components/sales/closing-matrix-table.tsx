"use client";

import { AlertTriangle } from "lucide-react";
import { Fragment, useRef } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { CLOSING_COLUMN_TINT, CLOSING_FONT_STACK, CLOSING_GRID_LINE, CLOSING_IDENTITY } from "@/lib/sales/closing-identity";
import { isSyntheticDirectArea } from "@/lib/sales/closing-direct-area";
import { formatNumber, formatPercent } from "@/lib/sales/format";
import { lineHasOfficeChannel } from "@/lib/sales/office-distributor";
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

// ── The premium workbook's identity, on screen ────────────────────────────────
// Owner, 2026-09-12: "brand the front end closing as the premium xlsx sato identity". Every colour
// below comes from CLOSING_IDENTITY, which is the premium closing workbook's approved palette and
// is pinned against it by tests/closing-screen-identity.test.ts.
//
// COLOUR IS APPLIED AS AN INLINE STYLE, NOT A TAILWIND CLASS, and that is deliberate on this file
// in particular: `cn()` (tailwind-merge) silently drops utilities it does not recognise — it already
// ate every `text-phx-*` size in this repo once, visible only to getComputedStyle in a real browser
// — and a dropped colour here would leave a cell with no ground at all, which on a STICKY cell means
// the rows scroll through it. An inline style cannot be merged away.
//
// WHY THE AXES ARE GROUNDS AND NOT HUES. The old table separated its axes with five unrelated
// colours (sky, orange, amber, violet, and a green the owner rejected on sight). The workbook's
// identity has no such vocabulary: it has two navies, one accent blue, and two grounds, and it tells
// one block from the next by ALTERNATING them — the same device its tab strip uses. So a column's
// axis is carried by its GROUND (white → veryLight → lightBlue, in increasing order of "this figure
// is derived rather than sold") and by its header band, never by tinting the digits themselves.
const INK = {
  /** A measured figure: units sold, value sold. */
  figure: CLOSING_IDENTITY.mainText,
  /** A derived figure: a share, a target, a percentage. */
  derived: CLOSING_IDENTITY.mutedText,
  /** The Target axis — the one column the owner asked to stand out. */
  target: CLOSING_IDENTITY.corporateBlue,
  /** "of which Office" — a component of the figure beside it, never a sale of its own. */
  office: CLOSING_IDENTITY.secondaryNavy,
  /** "Ach %" — the verdict the whole row exists to produce, so it takes the darkest ink there is. */
  verdict: CLOSING_IDENTITY.primaryNavy,
  /** On a navy row, everything inverts. */
  onNavy: CLOSING_IDENTITY.white,
  onNavyMuted: CLOSING_IDENTITY.lightBlue,
} as const;

const GROUND = {
  plain: CLOSING_IDENTITY.white,
  /** The zebra half, and the ground under a derived column. */
  soft: CLOSING_IDENTITY.veryLight,
  /** The ground under a measured-against column (Target, Office, Family, Grand Total). */
  panel: CLOSING_IDENTITY.lightBlue,
  /** "of which Office" — its own ground, so the column can be traced down the whole grid. */
  office: CLOSING_COLUMN_TINT.office,
  /** "Ach %" — likewise, and the bluer of the two because it is the column being looked for. */
  ach: CLOSING_COLUMN_TINT.achievement,
  /** A region subtotal row. */
  subtotal: CLOSING_IDENTITY.lightBlue,
  /** A national total row. */
  total: CLOSING_IDENTITY.primaryNavy,
  /** The second national total row, so the two read as two — the tab strip's alternation. */
  totalAlt: CLOSING_IDENTITY.secondaryNavy,
} as const;

/** Ground for a cell, honouring a row-wide override (Direct rows, total rows). */
function groundOf(rowBg: string | undefined, own: string) {
  return rowBg ?? own;
}

/** Ink for a figure, given its row. A grand-total row inverts everything on it. */
// A role's ink survives a zero — a 0% achievement and a zero target are the two figures on this
// grid somebody is actually hunting for, so greying them out would hide the finding. Everything
// else dims at zero, which is what keeps a sparse product column readable.
function inkFor(variant: RowVariant, role: keyof typeof INK, dim = false) {
  if (variant === "grand") return dim ? INK.onNavyMuted : INK.onNavy;
  if (role === "target" || role === "verdict") return INK[role];
  if (dim) return INK.derived;
  return INK[role];
}

function weightFor(variant: RowVariant) {
  if (variant === "grand") return 600;
  if (variant === "subtotal") return 700;
  return 400;
}

const CELL_BASE = "whitespace-nowrap px-3 py-2 text-right tabular-nums";

function Cell({
  bg,
  bold = false,
  ink,
  text,
  variant,
}: {
  bg?: string;
  /** A column that carries the row's verdict. Never lighter than the row's own weight. */
  bold?: boolean;
  ink: string;
  text: string;
  variant: RowVariant;
}) {
  const weight = bold ? Math.max(600, weightFor(variant)) : weightFor(variant);
  return (
    <td className={CELL_BASE} style={{ backgroundColor: bg, color: ink, fontWeight: weight }}>
      {text}
    </td>
  );
}

// `role` is what makes a column identifiable: it picks the ink, and the ground it is given picks the
// band. It replaced a bare `muted` boolean, which could only say "grey" and so had every derived
// column - Office, Contribution, Target - wearing one colour between them.
function NumCell({
  bg,
  kind = "int",
  role = "figure",
  value,
  variant,
}: {
  bg?: string;
  kind?: "int" | "value";
  role?: "figure" | "derived" | "target" | "office";
  value: number | null;
  variant: RowVariant;
}) {
  if (value === null) {
    return <Cell bg={bg} ink={inkFor(variant, "derived", true)} text={BLANK} variant={variant} />;
  }
  const text = kind === "value" ? valueText(value) : formatNumber(value);
  return <Cell bg={bg} ink={inkFor(variant, role, value === 0)} text={text} variant={variant} />;
}

// Achievement % — the column every reader of this grid is actually looking for, and until now it
// wore the same ink and the same ground as the units beside it. It takes the darkest navy in the
// identity, a half-step of weight, and a ground of its own (GROUND.ach).
function AchCell({ bg, value, variant }: { bg?: string; value: number | null; variant: RowVariant }) {
  if (value === null) {
    return <Cell bg={bg} ink={inkFor(variant, "derived", true)} text={BLANK} variant={variant} />;
  }
  return <Cell bg={bg} bold ink={inkFor(variant, "verdict")} text={formatPercent(value, { input: "ratio" })} variant={variant} />;
}

// Contribution % — share of this row's sales within the product's / row-total's national total.
function ContribCell({ bg, value, variant }: { bg?: string; value: number | null; variant: RowVariant }) {
  if (value === null) {
    return <Cell bg={bg} ink={inkFor(variant, "derived", true)} text={BLANK} variant={variant} />;
  }
  return <Cell bg={bg} ink={inkFor(variant, "derived")} text={formatPercent(value, { input: "ratio" })} variant={variant} />;
}

// Target value — the Grand Total block's one axis that had no colour of its own and rendered as
// muted grey, which reads as "not important" beside the figure it is the yardstick for. Owner
// 2026-09-12: "Tgt Value in grand total need another color". It takes the identity's ACCENT BLUE on
// the plain ground, so inside a panel-tinted Grand Total block it inverts against its neighbours —
// which is what makes it the column the eye lands on, without spending a hue the identity does not
// have. (An emerald version of this shipped for about twenty minutes and the owner rejected it.)
function TargetCell({ bg, value, variant }: { bg?: string; value: number | null; variant: RowVariant }) {
  if (value === null) {
    return <Cell bg={bg} ink={inkFor(variant, "derived", true)} text={BLANK} variant={variant} />;
  }
  return <Cell bg={bg} ink={inkFor(variant, "target")} text={valueText(value)} variant={variant} />;
}

// ── Column grounds ────────────────────────────────────────────────────────────
// Three levels only — plain, soft, panel — in increasing order of "this figure is a yardstick rather
// than a sale". A grand-total row is navy end to end, so it takes no column ground at all.

// A grand-total row is navy END TO END, so its cells must take NO ground of their own: a white
// cell ground paints straight over the row and leaves white figures on white, which is not a
// faint bug - the whole national total goes invisible. Every ground helper returns undefined on
// "grand" for that reason, and this is the one for a cell that is otherwise plain.
function plainBgFor(variant: RowVariant) {
  return variant === "grand" ? undefined : GROUND.plain;
}

function softBgFor(variant: RowVariant) {
  return variant === "grand" ? undefined : GROUND.soft;
}

function panelBgFor(variant: RowVariant) {
  return variant === "grand" ? undefined : GROUND.panel;
}

/** Achievement % — the verdict, on the bluest ground of the five so the column is findable. */
function achBgFor(variant: RowVariant) {
  return variant === "grand" ? undefined : GROUND.ach;
}

/** Contribution % — derived. */
const contrBgFor = softBgFor;

/** The rightmost Grand Total block, tinted so it reads as one block. */
const totalBgFor = panelBgFor;

/** The Target column INSIDE the Grand Total block — plain, so it inverts out of the panel. */
function tgtBgFor(variant: RowVariant) {
  return variant === "grand" ? undefined : GROUND.plain;
}

/** The family summary block — derivative, never added to the Grand Total. */
const famBgFor = panelBgFor;

/** "of which Office" — a component of the figure beside it, not a figure of its own. */
function officeBgFor(variant: RowVariant) {
  return variant === "grand" ? undefined : GROUND.office;
}

// ── "of which Office" ─────────────────────────────────────────────────────────
// Office units are not sold by anyone: they are the Office channel's units, spread across areas by
// the owner's value-share rule (src/lib/sales/office-allocation.ts). On CNS July 2026 they are 41%
// of the closing. This block reads the parallel Office matrix — built by the SAME builder over the
// same areas and columns — so every figure below is the Office component of the cell beside it and
// can never be a re-derivation that drifts.
//
// NULL everywhere means the Office grid could not be read, and every cell renders "—". It must
// never render 0: a confident zero would read as "this area took no Office units", which is a
// different and much more damaging statement than "we do not know".

type OfficeLookup = {
  /** The caller wired an Office grid at all. False ⇒ the columns are not rendered on this surface. */
  shown: boolean;
  /**
   * Office units for one row and product. Three states, and they must stay distinct:
   *   undefined — not shown on this surface; the caller renders no cell at all.
   *   null      — shown but unreadable; the cell renders "—".
   *   number    — the Office component. 0 here is a real, asserted zero.
   */
  unitsFor: (rowKey: string, productCode: string) => number | null | undefined;
  /** The same three states for a whole row's Office VALUE. */
  valueFor: (rowKey: string) => number | null | undefined;
  /** A real zero when the grid is readable, matching the three states above. Used by Direct rows. */
  zero: number | null | undefined;
};

// `undefined` and `null` mean different things and must not be collapsed:
//   undefined — this surface does not carry the Office breakdown. Render exactly as before.
//   null      — this surface does carry it, but it could not be read. Render "—" and say so.
// Collapsing them would put a warning banner on a surface that never asked for the feature.
function buildOfficeLookup(office: MonthlyClosingMatrix | null | undefined): OfficeLookup {
  if (office === undefined) {
    return { shown: false, unitsFor: () => undefined, valueFor: () => undefined, zero: undefined };
  }
  if (!office) {
    return { shown: true, unitsFor: () => null, valueFor: () => null, zero: null };
  }
  const units = new Map<string, number>();
  const rowValue = new Map<string, number>();
  const codes = office.columns.map((c) => c.productCode);
  const put = (rowKey: string, cells: MonthlyClosingCell[], total: MonthlyClosingCell) => {
    cells.forEach((cell, idx) => {
      const code = codes[idx];
      if (code) units.set(`${rowKey}|${code}`, cell.salesUnits ?? 0);
    });
    rowValue.set(rowKey, total.salesValue ?? 0);
  };
  for (const region of office.regions) {
    for (const area of region.areas) put(`A:${area.areaCode}`, area.cells, area.rowTotal);
    put(`R:${region.regionCode}`, region.subtotal.cells, region.subtotal.rowTotal);
  }
  put("NAT", office.grandTotal.cells, office.grandTotal.rowTotal);
  return {
    shown: true,
    // A row/product absent from the Office grid genuinely took no Office units — 0, not unknown.
    unitsFor: (rowKey, productCode) => units.get(`${rowKey}|${productCode}`) ?? 0,
    valueFor: (rowKey) => rowValue.get(rowKey) ?? 0,
    zero: 0,
  };
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
  officeUnits,
  productTotal,
  rowBg,
  variant,
}: {
  bandTint: boolean;
  cell: MonthlyClosingCell;
  /** Office component of this cell's units. undefined ⇒ no cell; null ⇒ "—"; number ⇒ the figure. */
  officeUnits: number | null | undefined;
  productTotal: number | null;
  rowBg?: string;
  variant: RowVariant;
}) {
  // The product band's own alternation, matching the header band above it: every second product
  // sits on the soft ground so the eye can see where one product's columns end without a rule.
  const bg = groundOf(rowBg, variant === "area" && bandTint ? GROUND.soft : plainBgFor(variant));
  const achBg = groundOf(rowBg, achBgFor(variant) ?? bg);
  const contrBg = groundOf(rowBg, contrBgFor(variant) ?? bg);
  const officeBg = groundOf(rowBg, officeBgFor(variant) ?? bg);
  const tgtBg = groundOf(rowBg, panelBgFor(variant) ?? bg);
  const contrib =
    productTotal && productTotal > 0 ? (cell.salesValue ?? 0) / productTotal : null;
  return (
    <>
      <NumCell bg={bg} value={cell.salesUnits} variant={variant} />
      {officeUnits !== undefined ? <NumCell bg={officeBg} role="office" value={officeUnits} variant={variant} /> : null}
      <NumCell bg={bg} kind="value" value={cell.salesValue} variant={variant} />
      <ContribCell bg={contrBg} value={contrib} variant={variant} />
      <NumCell bg={tgtBg} role="target" value={cell.targetUnits} variant={variant} />
      <NumCell bg={tgtBg} kind="value" role="target" value={cell.targetValue} variant={variant} />
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
  const bg = groundOf(rowBg, famBgFor(variant) ?? plainBgFor(variant));
  const famValue = group.indices.reduce((s, i) => s + (cells[i]?.salesValue ?? 0), 0);
  const famTargetRaw = group.indices.reduce((s, i) => s + (cells[i]?.targetValue ?? 0), 0);
  const famTarget = famTargetRaw > 0 ? famTargetRaw : null;
  const famContr = grandTotalValue > 0 ? famValue / grandTotalValue : null;
  return (
    <>
      <NumCell bg={bg} kind="value" value={famValue} variant={variant} />
      <NumCell bg={bg} kind="value" role="target" value={famTarget} variant={variant} />
      <ContribCell bg={bg} value={famContr} variant={variant} />
    </>
  );
}

function TotalCells({
  cell,
  grandTotal,
  officeValue,
  rowBg,
  variant,
}: {
  cell: MonthlyClosingCell;
  grandTotal: number | null;
  /** Office component of this row's total VALUE — the axis this block is measured on. */
  officeValue: number | null | undefined;
  rowBg?: string;
  variant: RowVariant;
}) {
  const bg = groundOf(rowBg, totalBgFor(variant) ?? plainBgFor(variant));
  const officeBg = groundOf(rowBg, officeBgFor(variant) ?? bg);
  const contrBg = groundOf(rowBg, contrBgFor(variant) ?? bg);
  const achBg = groundOf(rowBg, achBgFor(variant) ?? bg);
  // Deliberately NOT the row override: inside the Grand Total block the Target column is the one
  // that has to stand out, and on a Direct row (which supplies a rowBg for every other cell) taking
  // that ground would put it straight back to being indistinguishable from the value beside it.
  const tgtBg = tgtBgFor(variant) ?? rowBg;
  const contrib =
    grandTotal && grandTotal > 0 ? (cell.salesValue ?? 0) / grandTotal : null;
  return (
    <>
      <NumCell bg={bg} kind="value" value={cell.salesValue} variant={variant} />
      {officeValue !== undefined ? <NumCell bg={officeBg} kind="value" role="office" value={officeValue} variant={variant} /> : null}
      <ContribCell bg={contrBg} value={contrib} variant={variant} />
      <TargetCell bg={tgtBg} value={cell.targetValue} variant={variant} />
      <AchCell bg={achBg} value={cell.achievement} variant={variant} />
    </>
  );
}

// ── Header helpers ─────────────────────────────────────────────────────────────

function MetricHeaders({ showOffice }: { showOffice: boolean }) {
  const cell = "sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle";
  return (
    <>
      <th className={cell} style={{ top: 44 }}>Units</th>
      {showOffice ? <th className={`${cell} phx-office`} style={{ top: 44 }}>of wh. Office</th> : null}
      <th className={cell} style={{ top: 44 }}>Value</th>
      <th className={`${cell} phx-contr`} style={{ top: 44 }}>Contr %</th>
      <th className={`${cell} phx-tgt font-normal`} style={{ top: 44 }}>Tgt Units</th>
      <th className={`${cell} phx-tgt font-normal`} style={{ top: 44 }}>Tgt Value</th>
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
      <th className={`${cell} phx-family phx-tgt font-normal`} style={{ top: 44 }}>Tgt Value</th>
      <th className={`${cell} phx-contr`} style={{ top: 44 }}>Contr %</th>
    </>
  );
}

// ── Column widths ──────────────────────────────────────────────────────────────

const COL = {
  ach: 64, area: 92,
  contr: 68,
  gtAch: 64, gtContr: 68,
  gtOffice: 110, gtTgt: 96, gtValue: 110,
  // Family summary block (3 columns, no Units/Ach axis)
  famContr: 68, famTgt: 96, famValue: 102,
  // "of wh. Office" — wide enough for the longest header, which never wraps (owner's rule).
  office: 92,
  name: 196, tgtUnits: 66, tgtValue: 96, units: 70, value: 102,
};
const PRODUCT_GROUP_WIDTH = COL.units + COL.value + COL.contr + COL.tgtUnits + COL.tgtValue + COL.ach;
const FAMILY_GROUP_WIDTH = COL.famValue + COL.famTgt + COL.famContr;
const STICKY1 = "sticky left-0 z-20";
const STICKY2 = "sticky z-20";

// ── RegionBlock ────────────────────────────────────────────────────────────────

function RegionBlock({
  columns,
  columnGroups,
  grandTotalValue,
  office,
  productTotals,
  region,
}: {
  columns: MonthlyClosingColumn[];
  columnGroups: ColumnGroup[];
  grandTotalValue: number;
  office: OfficeLookup;
  productTotals: number[];
  region: MonthlyClosingRegionGroup;
}) {
  const officeUnits = (rowKey: string, idx: number) => office.unitsFor(rowKey, columns[idx]?.productCode ?? "");
  const officeValue = (rowKey: string) => office.valueFor(rowKey);
  return (
    <>
      {region.areas.map((area) => {
        const directBg = CLOSING_IDENTITY.lightBlue;
        // The anonymous "◆ Direct / Direct orders (company)" identity belongs ONLY to the synthetic
        // pseudo-area. Since July 2026's direct orders were restated to area grain, `area.isDirect`
        // is also true for REAL areas that absorbed direct money — Dakahlia 1 is still Dakahlia 1,
        // and reading the raw flag here erased the name of every area that earned a direct order.
        const synthetic = isSyntheticDirectArea(area);
        return (
          <tr className={synthetic ? "" : "phx-closing-row transition-colors"} key={area.areaCode}>
            <td
              className={`${STICKY1} whitespace-nowrap px-3 py-2.5 font-semibold ${synthetic ? "uppercase tracking-wide" : ""}`}
              style={{ backgroundColor: synthetic ? directBg : GROUND.plain, color: synthetic ? INK.target : CLOSING_IDENTITY.mainText }}
            >{synthetic ? "◆ Direct" : area.areaCode}</td>
            <td
              className={`${STICKY2} truncate px-3 py-2.5 ${synthetic ? "font-bold" : ""}`}
              style={{ backgroundColor: synthetic ? directBg : GROUND.plain, color: synthetic ? INK.target : CLOSING_IDENTITY.mutedText, left: COL.area }}
            >{synthetic ? "Direct orders (company)" : area.areaName}</td>
            {columnGroups.map((group, gi) => (
              <Fragment key={gi}>
                {group.indices.map((idx) => (
                  <ProductCells
                    bandTint={idx % 2 === 1}
                    cell={area.cells[idx]}
                    key={`${area.areaCode}-${idx}`}
                    officeUnits={officeUnits(`A:${area.areaCode}`, idx)}
                    productTotal={productTotals[idx] ?? null}
                    rowBg={synthetic ? directBg : undefined}
                    variant="area"
                  />
                ))}
                {group.isMulti && (
                  <FamilyCells
                    cells={area.cells}
                    grandTotalValue={grandTotalValue}
                    group={group}
                    key={`fam-${area.areaCode}-${gi}`}
                    rowBg={synthetic ? directBg : undefined}
                    variant="area"
                  />
                )}
              </Fragment>
            ))}
            <TotalCells cell={area.rowTotal} grandTotal={grandTotalValue} officeValue={officeValue(`A:${area.areaCode}`)} rowBg={synthetic ? directBg : undefined} variant="area" />
          </tr>
        );
      })}
      <tr style={{ backgroundColor: GROUND.subtotal }}>
        <td className={`${STICKY1} whitespace-nowrap px-3 py-2.5 font-black uppercase tracking-wide`} style={{ backgroundColor: GROUND.subtotal, color: CLOSING_IDENTITY.primaryNavy }}>{region.regionCode}</td>
        <td className={`${STICKY2} truncate px-3 py-2.5 font-black`} style={{ backgroundColor: GROUND.subtotal, color: CLOSING_IDENTITY.primaryNavy, left: COL.area }}>{region.regionName}</td>
        {columnGroups.map((group, gi) => (
          <Fragment key={gi}>
            {group.indices.map((idx) => (
              <ProductCells
                bandTint={idx % 2 === 1}
                cell={region.subtotal.cells[idx]}
                key={`sub-${region.regionCode}-${idx}`}
                officeUnits={officeUnits(`R:${region.regionCode}`, idx)}
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
        <TotalCells cell={region.subtotal.rowTotal} grandTotal={grandTotalValue} officeValue={officeValue(`R:${region.regionCode}`)} variant="subtotal" />
      </tr>
    </>
  );
}

// ── Main export ────────────────────────────────────────────────────────────────

export function ClosingMatrixTable({
  matrix,
  office,
}: {
  matrix: MonthlyClosingMatrix;
  /**
   * The Office slice of `matrix`, on the same grid — see MonthlyClosingParts.office. Undefined on a
   * surface that has not been wired for it yet, null when the Office grid could not be read; both
   * render every "of wh. Office" as "—" and raise the callout below, never a silent 0.
   */
  office?: MonthlyClosingMatrix | null;
}) {
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
  // Owner's rule, 2026-08-25: the Office breakdown belongs to CNS ONLY. Gated HERE rather than at
  // each caller so a future surface cannot forget it — both the admin workspace and the portal view
  // render through this one component. `undefined` (not null) is what removes the columns
  // outright; null would keep them and print "—" plus the "could not be read" callout, which on a
  // line that has no Office channel would report an outage that does not exist.
  const officeLookup = buildOfficeLookup(lineHasOfficeChannel(matrix.line) ? office : undefined);
  // Direct money carries no Office by construction, so the national Office figures serve both the
  // retail grand total and the "incl. Direct" total unchanged.
  const natOfficeUnits = (idx: number) => officeLookup.unitsFor("NAT", matrix.columns[idx]?.productCode ?? "");
  const natOfficeValue = officeLookup.valueFor("NAT");

  // Per-product national totals for contribution % — derived from the grand total row.
  const productTotals = matrix.grandTotal.cells.map((c) => c.salesValue ?? 0);
  const grandTotalValue = matrix.grandTotal.rowTotal.salesValue ?? 0;

  const tableWidth =
    COL.area + COL.name +
    matrix.columns.length * (PRODUCT_GROUP_WIDTH + (officeLookup.shown ? COL.office : 0)) +
    multiCount * FAMILY_GROUP_WIDTH +
    COL.gtValue + (officeLookup.shown ? COL.gtOffice : 0) + COL.gtContr + COL.gtTgt + COL.gtAch;

  const bandHeader = "whitespace-nowrap px-3 align-middle";

  return (
    <div className="p-4 md:p-5">
      {/* The premium closing workbook's identity, scoped to this grid.
          Two navies alternating band by band, one accent blue on the Target axis, and a hairline
          rule - the same vocabulary closing-executive-look.ts paints the .xlsx with, so the screen
          and the download read as one document (owner, 2026-09-12).
          Table-level specificity is what lets a sticky header cover the rows scrolling under it. */}
      <style>{`
        table.phx-closing-grid { font-family: ${CLOSING_FONT_STACK}; }
        table.phx-closing-grid th, table.phx-closing-grid td { border: 1px solid ${CLOSING_GRID_LINE} !important; }
        table.phx-closing-grid thead th { background-color: ${CLOSING_IDENTITY.secondaryNavy} !important; color: ${CLOSING_IDENTITY.white} !important; box-shadow: inset 0 -2px 0 ${CLOSING_IDENTITY.corporateBlue}; font-weight: 600; letter-spacing: .01em; }
        /* BLOCK bands first - which group of columns this is. */
        table.phx-closing-grid thead th.phx-band { background-color: ${CLOSING_IDENTITY.primaryNavy} !important; }
        table.phx-closing-grid thead th.phx-family { background-color: ${CLOSING_IDENTITY.primaryNavy} !important; color: ${CLOSING_IDENTITY.lightBlue} !important; box-shadow: inset 0 -2px 0 ${CLOSING_IDENTITY.mutedText}; }
        table.phx-closing-grid thead th.phx-gt { background-color: ${CLOSING_IDENTITY.primaryNavy} !important; color: ${CLOSING_IDENTITY.white} !important; box-shadow: inset 0 -2px 0 ${CLOSING_IDENTITY.corporateBlue}; }
        /* COLUMN roles second, and the ORDER is the whole point: every one of these also appears
           inside the Grand Total block, where it carries phx-gt as well. Equal specificity means
           source order decides, so a role listed after phx-gt keeps its own colour there - which is
           what makes "Tgt Value" and "Ach %" the same columns at the far right as they are in every
           product band (owner, 2026-09-12: colours for identification). Moving one of these lines
           above phx-gt silently hands that column back to the block. */
        table.phx-closing-grid thead th.phx-office { background-color: ${CLOSING_IDENTITY.secondaryNavy} !important; color: ${CLOSING_IDENTITY.lightBlue} !important; box-shadow: inset 0 -2px 0 ${CLOSING_IDENTITY.mutedText}; font-weight: 400; }
        table.phx-closing-grid thead th.phx-contr { color: ${CLOSING_IDENTITY.lightBlue} !important; box-shadow: inset 0 -2px 0 ${CLOSING_IDENTITY.lightBlue}; font-weight: 400; }
        table.phx-closing-grid thead th.phx-tgt { background-color: ${CLOSING_IDENTITY.corporateBlue} !important; color: ${CLOSING_IDENTITY.white} !important; box-shadow: inset 0 -2px 0 ${CLOSING_IDENTITY.lightBlue}; }
        table.phx-closing-grid thead th.phx-ach { background-color: ${CLOSING_IDENTITY.primaryNavy} !important; color: ${CLOSING_IDENTITY.white} !important; box-shadow: inset 0 -2px 0 ${CLOSING_IDENTITY.white}; }
        table.phx-closing-grid tbody tr.phx-closing-row:hover td { background-color: ${CLOSING_IDENTITY.lightBlue} !important; }
      `}</style>

      {officeLookup.shown && officeLookup.valueFor("NAT") === null ? (
        <div className="mb-3">
          <AdminCallout tone="warning">
            <AlertTriangle className="mt-0.5 h-4 w-4" />
            <p>
              The Office breakdown could not be read for this line and month, so every
              &ldquo;of wh. Office&rdquo; column shows &mdash;. The sales figures beside them are
              unaffected and still include the Office units.
            </p>
          </AdminCallout>
        </div>
      ) : null}

      {/* Top horizontal scrollbar (synced proxy) */}
      <div
        className="overflow-x-auto overflow-y-hidden border-x border-t border-phx-line"
        onScroll={() => syncScroll(topRef.current, bodyRef.current)}
        ref={topRef}
        style={{ height: 14 }}
      >
        <div style={{ height: 1, width: tableWidth }} />
      </div>

      <div
        className="max-h-[72vh] overflow-auto border border-phx-line"
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
                ...(officeLookup.shown ? [<col key={`o-${gi}-${iInGroup}`} style={{ width: COL.office }} />] : []),
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
            {officeLookup.shown ? <col style={{ width: COL.gtOffice }} /> : null}
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
                  <th className={`${bandHeader} ${idx % 2 === 1 ? "phx-band" : ""} sticky top-0 z-30 h-11`} colSpan={officeLookup.shown ? 7 : 6} key={`ph-${gi}-${idx}`}>
                    <span className="block truncate text-phx-sm font-black leading-tight" style={{ color: CLOSING_IDENTITY.white }}>{matrix.columns[idx].productName}</span>
                    <span className="block text-phx-2xs font-normal" style={{ color: CLOSING_IDENTITY.lightBlue }}>{matrix.columns[idx].productCode}</span>
                  </th>
                )),
                ...(group.isMulti ? [
                  <th className={`${bandHeader} phx-family sticky top-0 z-30 h-11`} colSpan={3} key={`fh-${gi}`}>
                    <span className="block truncate text-phx-sm font-black leading-tight">{group.family}</span>
                    <span className="block text-phx-2xs font-normal opacity-70">Family Total</span>
                  </th>,
                ] : []),
              ])}
              <th className={`${bandHeader} phx-gt sticky top-0 z-30 h-11`} colSpan={officeLookup.shown ? 5 : 4}>Grand Total</th>
            </tr>
            {/* Row 2: per-column metric sub-headers */}
            <tr>
              {columnGroups.flatMap((group, gi) => [
                ...group.indices.map((idx) => (
                  <MetricHeaders key={`mh-${gi}-${idx}`} showOffice={officeLookup.shown} />
                )),
                ...(group.isMulti ? [<FamilySubHeaders key={`fsh-${gi}`} />] : []),
              ])}
              <th className="phx-gt sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle" style={{ top: 44 }}>Value</th>
              {officeLookup.shown ? <th className="phx-gt phx-office sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle" style={{ top: 44 }}>of wh. Office</th> : null}
              <th className="phx-gt phx-contr sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle" style={{ top: 44 }}>Contr %</th>
              <th className="phx-gt phx-tgt sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle" style={{ top: 44 }}>Tgt Value</th>
              <th className="phx-gt phx-ach sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle" style={{ top: 44 }}>Ach %</th>
            </tr>
          </thead>
          <tbody>
            {matrix.regions.map((region) => (
              <RegionBlock
                columnGroups={columnGroups}
                columns={matrix.columns}
                grandTotalValue={grandTotalValue}
                key={region.regionCode}
                office={officeLookup}
                productTotals={productTotals}
                region={region}
              />
            ))}

            {/* National Grand Total — family columns shown here too but rowTotal is unchanged */}
            <tr style={{ backgroundColor: GROUND.total }}>
              <td className={`${STICKY1} whitespace-nowrap px-3 py-3 font-black uppercase tracking-wide`} style={{ backgroundColor: GROUND.total, color: CLOSING_IDENTITY.white }}>NAT</td>
              <td className={`${STICKY2} whitespace-nowrap px-3 py-3 font-black`} style={{ backgroundColor: GROUND.total, color: CLOSING_IDENTITY.white, left: COL.area }}>National Grand Total</td>
              {columnGroups.map((group, gi) => (
                <Fragment key={gi}>
                  {group.indices.map((idx) => (
                    <ProductCells
                      bandTint={idx % 2 === 1}
                      cell={matrix.grandTotal.cells[idx]}
                      key={`gt-${idx}`}
                      officeUnits={natOfficeUnits(idx)}
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
              <TotalCells cell={matrix.grandTotal.rowTotal} grandTotal={grandTotalValue} officeValue={natOfficeValue} variant="grand" />
            </tr>

            {matrix.directNational ? (
              <tr>
                <td className={`${STICKY1} whitespace-nowrap px-3 py-2.5 font-black uppercase tracking-wide`} style={{ backgroundColor: GROUND.soft, color: INK.target }}>◆ DIR</td>
                <td className={`${STICKY2} whitespace-nowrap px-3 py-2.5 font-black`} style={{ backgroundColor: GROUND.soft, color: INK.target, left: COL.area }}>Direct – National</td>
                {columnGroups.map((group, gi) => (
                  <Fragment key={gi}>
                    {group.indices.map((idx) => (
                      <ProductCells
                        bandTint={idx % 2 === 1}
                        cell={matrix.directNational!.cells[idx]}
                        key={`dn-${idx}`}
                        officeUnits={officeLookup.zero}
                        productTotal={productTotals[idx] ?? null}
                        rowBg={GROUND.soft}
                        variant="subtotal"
                      />
                    ))}
                    {group.isMulti && (
                      <FamilyCells
                        cells={matrix.directNational!.cells}
                        grandTotalValue={grandTotalValue}
                        group={group}
                        key={`dn-fam-${gi}`}
                        rowBg={GROUND.soft}
                        variant="subtotal"
                      />
                    )}
                  </Fragment>
                ))}
                <TotalCells cell={matrix.directNational.rowTotal} grandTotal={grandTotalValue} officeValue={officeLookup.zero} rowBg={GROUND.soft} variant="subtotal" />
              </tr>
            ) : null}

            {/* The SECOND national total, so it takes the alternate navy - the same two-tone
                alternation the workbook's tab strip uses to show where one group ends. */}
            {matrix.companyTotal ? (
              <tr style={{ backgroundColor: GROUND.totalAlt }}>
                <td className={`${STICKY1} whitespace-nowrap px-3 py-3 font-black uppercase tracking-wide`} style={{ backgroundColor: GROUND.totalAlt, color: CLOSING_IDENTITY.white }}>TOT</td>
                <td className={`${STICKY2} whitespace-nowrap px-3 py-3 font-black`} style={{ backgroundColor: GROUND.totalAlt, color: CLOSING_IDENTITY.white, left: COL.area }}>Grand Total (incl. Direct)</td>
                {columnGroups.map((group, gi) => (
                  <Fragment key={gi}>
                    {group.indices.map((idx) => (
                      <ProductCells
                        bandTint={idx % 2 === 1}
                        cell={matrix.companyTotal!.cells[idx]}
                        key={`ct-${idx}`}
                        officeUnits={natOfficeUnits(idx)}
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
                <TotalCells cell={matrix.companyTotal.rowTotal} grandTotal={grandTotalValue} officeValue={natOfficeValue} variant="grand" />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
