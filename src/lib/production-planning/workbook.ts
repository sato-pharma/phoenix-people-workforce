import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import {
  applyRightToLeftSheet,
  bandHeader,
  BLACK,
  F,
  gridBorder,
  MUTED,
  PCT_FMT,
  SLATE,
  UNITS_FMT,
  VALUE_FMT,
  type CellValue,
  writeTable,
} from "@/lib/sales/sales-workbook-kit";

import { shownUnitWeights } from "./display-weights";
import { MEASURE_UNITS_PER_LARGE } from "./rules";
import {
  coerceProductionPlanningLanguage,
  formatNumberLatin,
  PACKAGING_BOX_CODE,
  packagingBoxName,
  PRODUCTION_PLANNING_WORKBOOK_FONT,
  productionPlanningStrings,
} from "./strings";
import type { WirePlan, WirePlanRow, WireWorkspace } from "./wire";

/**
 * The Production Planner's Excel export — a working model, not a printout of today's answer.
 *
 * The owner asked for the formulas themselves: "فيها برضو الفورمولاز". So every figure he types on
 * the screen is a YELLOW cell here, and every figure the module derives is a real Excel formula over
 * those cells. Changing the box count, the samples, the run volume, the recipe, the overage, the
 * stock at either location or a price recalculates the whole sheet inside Excel, with no round trip
 * to Phoenix. That is the difference between an export and a report, and it is the whole point of
 * this file.
 *
 * ── Why the cached result is written too, and why it is not the authority ─────────────────────────
 *
 * Excel recalculates on open, so every formula cell also carries the result the ENGINE computed.
 * Two reasons: the file is correct the instant it opens (before any recalculation), and a cached
 * result that disagrees with the formula is a defect the readback test can catch. ExcelJS drops a
 * cached result of exactly 0, which is why `tests/production-planning-workbook.test.ts` EVALUATES
 * the formulas rather than reading the cache.
 *
 * 🔴 EVERY NUMBER IN THIS FILE BECOMES A DOUBLE, because a spreadsheet has no other numeric type.
 * The module's own arithmetic is BigInt over micro units precisely to avoid that, so the SCREEN is
 * the authority on a quantity and this sheet is the model: potassium sorbate for nine runs reads
 * `15.52725` on the screen and in `formatNumberLatin`, and Excel will print the same digits at this
 * number format, but a chain of edits inside Excel is Excel's arithmetic from then on.
 *
 * ── One sheet, three blocks, and NO cross-sheet references ────────────────────────────────────────
 *
 * Inputs, the materials table and the purchase cost all sit on one sheet. A second sheet would need
 * every formula to quote an ARABIC sheet name (`'الخطة'!$H$25`), and a single reference Excel will
 * not parse takes the whole workbook to the repair dialog — for no gain, since the three blocks are
 * read together anyway.
 */

/** The yellow of a cell he is meant to type in. Distinct from the kit's AMBER total band. */
const INPUT_FILL = "FFFFF2B2";
/** How many columns the material table spans, and therefore how wide the brand band is. */
const COLUMN_COUNT = 14;

/** A decimal string from the wire as a spreadsheet number. Never used for the module's arithmetic. */
function num(text: string | null | undefined, fallback = 0): number {
  if (text === null || text === undefined || text === "") return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}

/** A percentage on the wire is a percent ("3" = 3%); Excel wants the fraction behind `0.0%`. */
function pctFraction(text: string | null | undefined): number {
  return num(text) / 100;
}

/**
 * A material's name on the sheet. The packaging material is stored as `Box`, and this sheet also says
 * `Total boxes` for the product count, so two different things would share one word — the packaging
 * row is spelled out here, in the export only. The stored name (and the screen) stay `Box`.
 */
function sheetMaterialName(S: ReturnType<typeof productionPlanningStrings>, planRow: WirePlanRow): string {
  if (planRow.code === PACKAGING_BOX_CODE) return packagingBoxName(S.lang);
  return S.name(planRow);
}

function labelCell(sheet: ExcelJS.Worksheet, row: number, text: string) {
  const cell = sheet.getCell(row, 1);
  cell.value = text;
  cell.font = { bold: true, color: { argb: SLATE }, size: 10.5 };
  cell.alignment = { vertical: "middle" };
  return cell;
}

function inputCell(sheet: ExcelJS.Worksheet, row: number, value: number, numFmt: string) {
  const cell = sheet.getCell(row, 2);
  cell.value = value;
  cell.numFmt = numFmt;
  cell.font = { bold: true, color: { argb: BLACK }, size: 10.5 };
  cell.fill = { fgColor: { argb: INPUT_FILL }, pattern: "solid", type: "pattern" };
  cell.border = gridBorder();
  cell.alignment = { vertical: "middle" };
  return cell;
}

function formulaCell(sheet: ExcelJS.Worksheet, row: number, formula: string, result: number, numFmt: string) {
  const cell = sheet.getCell(row, 2);
  cell.value = { formula, result };
  cell.numFmt = numFmt;
  cell.font = { color: { argb: BLACK }, size: 10.5 };
  cell.border = gridBorder();
  cell.alignment = { vertical: "middle" };
  return cell;
}

function sectionTitle(sheet: ExcelJS.Worksheet, row: number, text: string) {
  sheet.mergeCells(row, 1, row, COLUMN_COUNT);
  const cell = sheet.getCell(row, 1);
  cell.value = text;
  cell.font = { bold: true, color: { argb: "FFF97316" }, size: 12 };
  cell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
  cell.alignment = { vertical: "middle" };
  sheet.getRow(row).height = 22;
}

function noteRow(sheet: ExcelJS.Worksheet, row: number, text: string) {
  sheet.mergeCells(row, 1, row, COLUMN_COUNT);
  const cell = sheet.getCell(row, 1);
  cell.value = text;
  cell.font = { color: { argb: MUTED }, italic: true, size: 9.5 };
  cell.alignment = { vertical: "middle", wrapText: true };
}

/**
 * Paint a cell he is meant to type in.
 *
 * `writeTable` styles a whole table uniformly — zebra rows, one border, one face — so the columns
 * that are INPUTS have to be marked afterwards. Without this the sheet's own note ("تعديل أي خانة
 * صفراء يُعيد الحساب") points at nothing inside the table, and the recipe, the overage, the stock at
 * each location and what he decides to deliver all read as results rather than as his to change.
 * Deliberately overrides the zebra fill: the yellow is the instruction.
 */
function paintInput(sheet: ExcelJS.Worksheet, row: number, column: number) {
  const cell = sheet.getCell(row, column);
  cell.fill = { fgColor: { argb: INPUT_FILL }, pattern: "solid", type: "pattern" };
  cell.font = { ...(cell.font ?? {}), bold: true };
}

/**
 * What he has to buy, as Excel — including the purchasable rounding when the material carries one.
 *
 * The plain shortfall is `MAX(0, needed - (factory + own store))`. A material with a minimum order
 * or a purchase increment is not bought in that quantity, though: the engine rounds it UP to what a
 * supplier will actually sell (`roundQtyUpToPurchasable`), so the sheet has to do the same or the
 * formula and the cached figure beside it disagree the day one of those is typed in. Nothing seeded
 * today has either, which is exactly why this is written now rather than discovered later.
 *
 * `<=0` rather than `=0` so the whole expression stays inside the arithmetic the readback test's
 * evaluator can follow.
 */
function purchaseFormula(excelRow: number, minOrder: number | null, increment: number | null): string {
  const shortfall = `MAX(0,H${excelRow}-(I${excelRow}+J${excelRow}))`;
  if (!minOrder && !increment) return shortfall;
  let rounded = minOrder ? `MAX(${shortfall},${minOrder})` : shortfall;
  if (increment) rounded = `CEILING(${rounded},${increment})`;
  return `IF(${shortfall}<=0,0,${rounded})`;
}

/** The derived cell a material's basis count reads, chosen by what the recipe is written per. */
function basisCountRef(
  row: WirePlanRow,
  refs: { boxes: string; doses: string; goodUnits: string; packagingSets: string; samples: string; strips: string | null },
) {
  switch (row.basis) {
    case "per_dose":
      return refs.doses;
    case "per_packaging_set":
      // Its OWN cell since Guamusin — `goodUnits + samples`, because a sample consumes a full set.
      // It used to point at the box count, which is the same number only while `unitsPerBox` is 1.
      return refs.packagingSets;
    case "per_good_unit":
      return refs.goodUnits;
    case "per_sample_unit":
      return refs.samples;
    case "per_box":
      // The CARTON count, which is `goodUnits / unitsPerBox` — Guamusin's box holds twelve sachets,
      // so the carton and the sticker are consumed once per box and not once per sachet. For a
      // product whose `unitsPerBox` is 1 this is the same cell as `per_packaging_set`.
      return refs.boxes;
    case "per_strip":
      return refs.strips;
    default:
      return null;
  }
}

export type ProductionPlanningWorkbookStats = {
  readonly builtAt: string;
  readonly materials: number;
  readonly pricedMaterials: number;
  readonly runs: string;
};

/**
 * The language comes in as an option rather than being read from the catalogue at import time: the
 * owner picks the module's language with a toggle, and a sheet in the other language from the screen
 * that produced it is the one thing this export must not be.
 */
export async function buildProductionPlanningWorkbook(
  workspace: WireWorkspace,
  options: { actorName?: string | null; lang?: unknown } = {},
): Promise<{
  buffer: Buffer;
  stats: ProductionPlanningWorkbookStats;
}> {
  const S = productionPlanningStrings(coerceProductionPlanningLanguage(options.lang));
  const PPL = S.t;
  const plan: WirePlan | null = workspace.plan;
  if (!plan) throw new Error("No plan to export.");
  const product = workspace.products.find((candidate) => candidate.id === plan.productId) ?? workspace.products[0];
  // The unit pair the labels follow. From the PLAN and not the product, so a plan exported for the
  // powder cannot be labelled with the syrup's millilitres even if the product lookup above fell back.
  const measure = S.measureUnitLabels(plan.measureUnit);
  // How many small units make one large one, for the two cells that convert between them. A literal
  // 1,000 was right while the only pairs were ml→L and g→kg; a milligram geometry divided by it
  // writes Royanoxicam's 31 kg batch into the sheet as 31,000 kg, inside a live FORMULA he can see.
  const perLarge = Number(MEASURE_UNITS_PER_LARGE[plan.measureUnit]);
  // Built once: the per-dose label states the product's own dose, so it cannot be a flat constant.
  // The weights he READS (Royafloxacin's 847.6 mg tablet), never the core the cells below count at.
  const shownUnits = product ? shownUnitWeights(product) : { dose: "0", goodUnit: "0", sampleUnit: "0" };
  const basisLabels = S.basisLabels({
    dose: formatNumberLatin(shownUnits.dose),
    goodUnit: formatNumberLatin(shownUnits.goodUnit),
    measureUnit: plan.measureUnit,
    sampleUnit: formatNumberLatin(shownUnits.sampleUnit),
  });
  const materialById = new Map(workspace.materials.map((material) => [material.id, material]));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(PPL.sheetName);

  bandHeader(sheet, COLUMN_COUNT, `${PPL.moduleTitle} — ${product ? S.name(product) : ""}`.trim(), plan.sentence);

  // ── The typed inputs ───────────────────────────────────────────────────────────────────────────
  let row = 5;
  sectionTitle(sheet, row, PPL.sheetInputsTitle);
  row += 1;
  labelCell(sheet, row, PPL.productLabel);
  const productCell = sheet.getCell(row, 2);
  productCell.value = product ? S.name(product) : "";
  productCell.font = { bold: true, color: { argb: BLACK }, size: 10.5 };
  productCell.border = gridBorder();
  row += 1;

  const requestedRow = row;
  labelCell(sheet, requestedRow, PPL.sheetRequestedBoxes);
  inputCell(sheet, requestedRow, num(plan.requestedBoxes), UNITS_FMT);
  row += 1;

  const samplesRow = row;
  labelCell(sheet, samplesRow, PPL.sampleUnitsLabel);
  inputCell(sheet, samplesRow, num(plan.sampleUnits), UNITS_FMT);
  row += 1;

  // 🔴 THIS CELL STAYS IN THE SMALL UNIT — grams for the powder — BECAUSE THE FORMULAS DIVIDE IT BY
  // THE DOSE. The total-doses cell is `$B$<runs>*RUN_VOLUME/DOSE_ML` and DOSE_ML is in grams, so
  // writing 100 here instead of 100,000 would divide the whole sheet by a thousand while every
  // figure still looked like a plausible quantity. The LABEL is what was wrong: "حجم" is a volume,
  // and the owner said so plainly — *"1 run is 100kg not liter"* (2026-10-08).
  const runVolumeRow = row;
  labelCell(sheet, runVolumeRow, `${S.runSizeLabel(plan.measureUnit)} (${measure.small})`);
  inputCell(sheet, runVolumeRow, num(product?.runVolumeMl), UNITS_FMT);
  row += 1;

  // The same batch in the unit he says out loud, as a FORMULA over the cell above so the two cannot
  // drift apart. 100,000 جم and 100 كجم are one batch; he asked to read the second.
  const runSizeLargeRow = row;
  labelCell(sheet, runSizeLargeRow, `${S.runSizeLabel(plan.measureUnit)} (${measure.large})`);
  formulaCell(
    sheet,
    runSizeLargeRow,
    `$B$${runVolumeRow}/${perLarge}`,
    num(product?.runVolumeMl) / perLarge,
    VALUE_FMT,
  );
  row += 1;

  // The STATED weights (owner, 2026-11-11, Royafloxacin "847.6 mg, 70 kg as stated") travel as TEXT
  // in the label column, never as a number in column B: every non-yellow number on this sheet is a
  // live formula, and these two are labels the engine never counts with. Absent for every product
  // that does not carry them, so no other sheet's rows move.
  if (product?.batchWeightDisplay) {
    labelCell(sheet, row, `${PPL.settingsBatchWeightShown}: ${formatNumberLatin(product.batchWeightDisplay)} ${measure.large}`);
    row += 1;
  }
  if (product?.unitWeightDisplay) {
    labelCell(sheet, row, `${PPL.settingsUnitWeightShown}: ${formatNumberLatin(product.unitWeightDisplay)} ${measure.small}`);
    row += 1;
  }

  const goodMlRow = row;
  labelCell(sheet, goodMlRow, `${PPL.sheetGoodUnitSize} (${measure.small})`);
  inputCell(sheet, goodMlRow, num(product?.goodUnitMl), UNITS_FMT);
  row += 1;

  const sampleMlRow = row;
  labelCell(sheet, sampleMlRow, `${PPL.sheetSampleUnitSize} (${measure.small})`);
  inputCell(sheet, sampleMlRow, num(product?.sampleUnitMl), UNITS_FMT);
  row += 1;

  const doseMlRow = row;
  labelCell(sheet, doseMlRow, `${PPL.sheetDose} (${measure.small})`);
  inputCell(sheet, doseMlRow, num(product?.doseMl), VALUE_FMT);
  row += 1;

  // One of these is 1 today and may not always be. The engine divides by `units_per_box` and so does
  // this sheet, because a model that assumed a box is one bottle would silently disagree with the
  // screen the day that changes.
  const unitsPerBoxRow = row;
  const unitsPerBoxValue = Math.max(1, num(product?.unitsPerBox, 1));
  labelCell(sheet, unitsPerBoxRow, PPL.sheetUnitsPerBox);
  inputCell(sheet, unitsPerBoxRow, unitsPerBoxValue, UNITS_FMT);
  row += 1;

  // Only a product that counts strips gets this row, so every other product's sheet is unchanged.
  const stripsPerBoxValue = num(product?.stripsPerBox, 0);
  let stripsPerBoxRow: number | null = null;
  if (stripsPerBoxValue > 0) {
    stripsPerBoxRow = row;
    labelCell(sheet, stripsPerBoxRow, PPL.sheetStripsPerBox);
    inputCell(sheet, stripsPerBoxRow, stripsPerBoxValue, UNITS_FMT);
    row += 1;
  }

  const fxRow = row;
  labelCell(sheet, fxRow, PPL.fxRate);
  inputCell(sheet, fxRow, num(plan.totals.fxRate), VALUE_FMT);
  row += 2;

  const REQUESTED = `$B$${requestedRow}`;
  const SAMPLES = `$B$${samplesRow}`;
  const RUN_VOLUME = `$B$${runVolumeRow}`;
  const GOOD_ML = `$B$${goodMlRow}`;
  const SAMPLE_ML = `$B$${sampleMlRow}`;
  const DOSE_ML = `$B$${doseMlRow}`;
  const UNITS_PER_BOX = `$B$${unitsPerBoxRow}`;
  const FX = `$B$${fxRow}`;

  // ── What the module derives from them ──────────────────────────────────────────────────────────
  sectionTitle(sheet, row, PPL.sheetOutputsTitle);
  row += 1;

  // A sample in its own box takes a whole box out of the total and is never a part of a saleable one,
  // so four cells below read differently for that product. Every other product's sheet is unchanged.
  const sampleInOwnBox = product?.sampleInOwnBox === true;
  const goodRequestedValue = sampleInOwnBox
    ? (num(plan.requestedBoxes) - num(plan.sampleUnits)) * unitsPerBoxValue
    : num(plan.requestedBoxes) * unitsPerBoxValue - num(plan.sampleUnits);

  const goodRequestedRow = row;
  labelCell(sheet, goodRequestedRow, PPL.sheetGoodUnitsRequested);
  formulaCell(
    sheet,
    goodRequestedRow,
    sampleInOwnBox ? `(${REQUESTED}-${SAMPLES})*${UNITS_PER_BOX}` : `${REQUESTED}*${UNITS_PER_BOX}-${SAMPLES}`,
    goodRequestedValue,
    UNITS_FMT,
  );
  row += 1;

  const neededVolumeRow = row;
  labelCell(sheet, neededVolumeRow, `${PPL.sheetNeededVolume} (${measure.small})`);
  formulaCell(
    sheet,
    neededVolumeRow,
    `$B$${goodRequestedRow}*${GOOD_ML}+${SAMPLES}*${SAMPLE_ML}`,
    goodRequestedValue * num(product?.goodUnitMl) + num(plan.sampleUnits) * num(product?.sampleUnitMl),
    UNITS_FMT,
  );
  row += 1;

  // The rounding leads, because it is the one thing he will not take on trust. ROUNDUP, not ROUND:
  // a run is whole, and 7.52 runs is eight runs — which is where the surplus two rows down comes
  // from and why the planner reports it rather than quietly answering for a different order.
  const runsRow = row;
  labelCell(sheet, runsRow, PPL.tileRuns);
  formulaCell(sheet, runsRow, `ROUNDUP($B$${neededVolumeRow}/${RUN_VOLUME},0)`, num(plan.runs), UNITS_FMT);
  row += 1;

  const yieldRow = row;
  labelCell(sheet, yieldRow, PPL.tileYield);
  formulaCell(
    sheet,
    yieldRow,
    `FLOOR(($B$${runsRow}*${RUN_VOLUME}-${SAMPLES}*${SAMPLE_ML})/${GOOD_ML},1)`,
    num(plan.goodUnits),
    UNITS_FMT,
  );
  row += 1;

  // 🔴 PACKAGING SETS AND BOXES ARE TWO DIFFERENT CELLS, and they were one cell until Guamusin.
  //
  // A packaging set is consumed once per saleable unit (`goodUnits + samples`); a box is the carton
  // he counts in (`packagingSets / unitsPerBox`). Ivyronc's `unitsPerBox` is 1, so the two were the
  // same number and one cell served both — but Guamusin's carton holds twelve sachets, so a formula
  // reading the BOX count for a per-packaging-set material would have understated its film by 12×.
  const packagingSetsRow = row;
  // Named in the product's OWN saleable unit, so this row and the carton row below it cannot be read
  // as the same quantity — which is exactly what the owner could not tell apart on the screen. The
  // suffix follows the same rule as the bracket: at one unit a box it says nothing and is left off,
  // which is also what keeps Ivyronc's sheet byte-identical.
  labelCell(
    sheet,
    packagingSetsRow,
    unitsPerBoxValue === 1
      ? PPL.sheetPackagingSets
      : `${PPL.sheetPackagingSets} (${S.saleableUnitWord(plan.measureUnit)})`,
  );
  formulaCell(
    sheet,
    packagingSetsRow,
    sampleInOwnBox ? `$B$${yieldRow}+${SAMPLES}*${SAMPLE_ML}/${GOOD_ML}` : `$B$${yieldRow}+${SAMPLES}`,
    num(plan.packagingSets),
    UNITS_FMT,
  );
  row += 1;

  // The box a `per_box` material counts, when the samples wear a different one.
  let saleableBoxesRow: number | null = null;
  if (sampleInOwnBox) {
    saleableBoxesRow = row;
    labelCell(sheet, saleableBoxesRow, PPL.sheetSaleableBoxes);
    formulaCell(
      sheet,
      saleableBoxesRow,
      `ROUNDUP($B$${yieldRow}/${UNITS_PER_BOX},0)`,
      Math.ceil(num(plan.goodUnits) / unitsPerBoxValue),
      UNITS_FMT,
    );
    row += 1;
  }

  const boxesRow = row;
  labelCell(sheet, boxesRow, PPL.sheetTotalBoxes);
  formulaCell(
    sheet,
    boxesRow,
    // ROUNDUP, as the engine does: a part-box is still a carton (owner, 2026-10-24).
    saleableBoxesRow === null
      ? `ROUNDUP($B$${packagingSetsRow}/${UNITS_PER_BOX},0)`
      : `$B$${saleableBoxesRow}+${SAMPLES}`,
    num(plan.totalBoxes),
    UNITS_FMT,
  );
  row += 1;

  const surplusRow = row;
  labelCell(sheet, surplusRow, PPL.tileSurplus);
  formulaCell(
    sheet,
    surplusRow,
    `$B$${boxesRow}-${REQUESTED}`,
    num(plan.totalBoxes) - num(plan.requestedBoxes),
    UNITS_FMT,
  );
  row += 1;

  const litresRow = row;
  labelCell(sheet, litresRow, `${PPL.sheetTotalVolume} (${measure.large})`);
  formulaCell(
    sheet,
    litresRow,
    `$B$${runsRow}*${RUN_VOLUME}/${perLarge}`,
    num(plan.totalVolumeLitres),
    VALUE_FMT,
  );
  row += 1;

  const dosesRow = row;
  labelCell(sheet, dosesRow, PPL.sheetTotalDoses);
  formulaCell(sheet, dosesRow, `$B$${runsRow}*${RUN_VOLUME}/${DOSE_ML}`, num(plan.totalDoses), UNITS_FMT);
  row += 1;

  // What a `per_strip` material counts: the engine's `stripCount`. A sample adds its one strip only
  // when it wears its own box, because any other sample is already inside the box count.
  let totalStripsRow: number | null = null;
  if (stripsPerBoxRow !== null) {
    totalStripsRow = row;
    labelCell(sheet, totalStripsRow, PPL.sheetTotalStrips);
    const stripsFromBoxes = `$B$${saleableBoxesRow ?? boxesRow}*$B$${stripsPerBoxRow}`;
    formulaCell(
      sheet,
      totalStripsRow,
      sampleInOwnBox ? `${stripsFromBoxes}+${SAMPLES}` : stripsFromBoxes,
      sampleInOwnBox
        ? Math.ceil(num(plan.goodUnits) / unitsPerBoxValue) * stripsPerBoxValue + num(plan.sampleUnits)
        : num(plan.totalBoxes) * stripsPerBoxValue,
      UNITS_FMT,
    );
    row += 1;
  }
  row += 1;

  const refs = {
    boxes: `$B$${saleableBoxesRow ?? boxesRow}`,
    doses: `$B$${dosesRow}`,
    goodUnits: `$B$${yieldRow}`,
    packagingSets: `$B$${packagingSetsRow}`,
    samples: SAMPLES,
    strips: totalStripsRow === null ? null : `$B$${totalStripsRow}`,
  };

  // ── The materials ──────────────────────────────────────────────────────────────────────────────
  //
  // `writeTable` puts the title on `startRow`, the headers on the next row and the first data row
  // after that, so every formula below is written against `materialsFirstRow + index`. The columns
  // are named without a unit: the rows are a mix of kilograms and pieces, so each material's own
  // unit travels in its name cell exactly as it does on the screen.
  const materialsFirstRow = row + 2;
  const tableRows: CellValue[][] = plan.rows.map((planRow, index) => {
    const material = materialById.get(planRow.materialId);
    const excelRow = materialsFirstRow + index;
    const basePerDisplay = Math.max(1, num(material?.basePerDisplay, 1));
    // A Sato material with no formula line whose amount is MEASURED from recorded runs is a per-batch
    // figure: its quantity is what one batch really consumed, counted against the runs cell, with
    // no overage on top (the engine's own rule — the actual already holds the loss).
    const measuredRow = planRow.basis === null && planRow.amountSource === "measured";
    const countRef = measuredRow ? `$B$${runsRow}` : basisCountRef(planRow, refs);
    const basisCount = num(planRow.basisCount);
    const qtyPerBasis = measuredRow ? num(planRow.measuredPerRun) : num(material?.composition?.qtyPerBasis);
    const rawNeeded = num(planRow.rawNeeded);
    const needed = num(planRow.needed);
    const heldFactory = num(planRow.heldAtFactory);
    const heldElsewhere = num(planRow.heldElsewhere);
    const willSend = num(planRow.willSend);

    const basisText = planRow.basis
      ? `${basisLabels[planRow.basis]} (${S.unitLabel(material?.baseUnit)})`.trim()
      : measuredRow
        ? `${PPL.amountMeasuredRuns} (${S.unitLabel(material?.baseUnit)})`.trim()
        : PPL.chipNoComposition;

    return [
      `${sheetMaterialName(S, planRow)} (${S.unitLabel(planRow.displayUnit)})`,
      planRow.supplier ? S.supplierLabels[planRow.supplier] : PPL.chipNoComposition,
      basisText,
      qtyPerBasis,
      countRef ? F(countRef, basisCount) : 0,
      F(`D${excelRow}*E${excelRow}/${basePerDisplay}`, rawNeeded),
      pctFraction(planRow.overagePct),
      F(`F${excelRow}*(1+G${excelRow})`, needed),
      heldFactory,
      heldElsewhere,
      // Only a material SATO supplies becomes a purchase. A factory-supplied or unsettled one is not
      // a zero — a zero reads as "nothing to buy", and the owner has to settle it before it is true.
      planRow.contributesToBuyList
        ? F(
            purchaseFormula(excelRow, num(material?.minOrderQty, 0) || null, num(material?.purchaseIncrement, 0) || null),
            num(planRow.toBuy),
          )
        : "—",
      willSend,
      // What is left AT THE FACTORY when the run is over: what it holds, plus what he sends, minus
      // what the run eats. His own store is not in it — he sends FROM there, the run does not reach
      // it — and a material he does not supply is not reduced by the run at all. Both are the
      // engine's own rule (`balanceAfterQty` in requirements.ts), and a sheet that subtracted the
      // requirement from everything would show the unsettled preservative as a shortage he owes.
      planRow.contributesToBuyList
        ? F(`I${excelRow}+L${excelRow}-H${excelRow}`, num(planRow.balanceAfter))
        : F(`I${excelRow}+L${excelRow}`, num(planRow.balanceAfter)),
      // Cover is what he HOLDS divided by one run's worth, not what is left afterwards.
      F(`IFERROR((I${excelRow}+J${excelRow})/(H${excelRow}/$B$${runsRow}),0)`, num(planRow.coverRuns)),
    ];
  });

  const afterMaterials = writeTable(sheet, row, {
    columns: [
      { label: PPL.colMaterial, width: 30 },
      { label: PPL.sheetColSupplier, width: 16 },
      { label: PPL.sheetColBasisLabel, width: 22 },
      { label: PPL.sheetColQtyPerBasis, numFmt: "#,##0.000000", width: 15 },
      { label: PPL.sheetColBasisCount, numFmt: UNITS_FMT, width: 14 },
      { label: PPL.beforeOverage, numFmt: VALUE_FMT, width: 14 },
      { label: PPL.overageLabel, numFmt: PCT_FMT, width: 11 },
      { label: PPL.colNeeded, numFmt: VALUE_FMT, width: 14 },
      { label: `${PPL.colAvailable} — ${PPL.atFactory}`, numFmt: VALUE_FMT, width: 14 },
      { label: `${PPL.colAvailable} — ${PPL.atOwnStore}`, numFmt: VALUE_FMT, width: 14 },
      { label: PPL.toBuy, numFmt: VALUE_FMT, width: 14 },
      { label: PPL.willSend, numFmt: VALUE_FMT, width: 14 },
      { label: PPL.balanceAfter, numFmt: VALUE_FMT, width: 16 },
      { label: PPL.coverRuns, numFmt: VALUE_FMT, width: 12 },
    ],
    note: PPL.exportHint,
    rows: tableRows,
    title: PPL.sheetMaterialsTitle,
  });

  // D the recipe · G the overage · I and J the stock at each location · L what he decides to deliver.
  for (let index = 0; index < tableRows.length; index += 1) {
    for (const column of [4, 7, 9, 10, 12]) paintInput(sheet, materialsFirstRow + index, column);
  }

  // ── What it costs to buy ───────────────────────────────────────────────────────────────────────
  //
  // Only the rows that actually become a purchase, and the quantity is the TO-BUY cell above rather
  // than the requirement: he already owns the rest. Each row's two cost cells are the same product
  // read in both currencies, so the one he typed is the multiply and the other goes through the rate
  // — never two stored prices for one number.
  const purchaseRows = plan.rows
    .map((planRow, index) => ({ excelRow: materialsFirstRow + index, planRow }))
    .filter((entry) => entry.planRow.contributesToBuyList);

  const costFirstRow = afterMaterials + 2;
  const costRows: CellValue[][] = purchaseRows.map((entry, index) => {
    const material = materialById.get(entry.planRow.materialId);
    const excelRow = costFirstRow + index;
    const price = num(entry.planRow.pricePerDisplayUnit ?? material?.price?.pricePerDisplayUnit);
    const currency = entry.planRow.priceCurrency ?? material?.price?.currency ?? null;
    const usdFormula =
      currency === "EGP" ? `IFERROR(B${excelRow}*C${excelRow}/${FX},0)` : `B${excelRow}*C${excelRow}`;
    const egpFormula =
      currency === "EGP" ? `B${excelRow}*C${excelRow}` : `B${excelRow}*C${excelRow}*${FX}`;
    return [
      `${sheetMaterialName(S, entry.planRow)} (${S.unitLabel(entry.planRow.displayUnit)})`,
      F(`K${entry.excelRow}`, num(entry.planRow.toBuy)),
      price,
      currency === "EGP" ? PPL.currencyEgp : currency === "USD" ? PPL.currencyUsd : "—",
      F(usdFormula, num(entry.planRow.costUsd)),
      F(egpFormula, num(entry.planRow.costEgp)),
    ];
  });

  const costLastRow = costFirstRow + Math.max(0, costRows.length - 1);
  const afterCost = writeTable(sheet, afterMaterials, {
    columns: [
      { label: PPL.colMaterial, width: 30 },
      { label: PPL.toBuy, numFmt: VALUE_FMT, width: 14 },
      { label: PPL.sheetColPrice, numFmt: VALUE_FMT, width: 14 },
      { label: PPL.priceCurrency, width: 12 },
      { label: PPL.sheetColCostUsd, numFmt: VALUE_FMT, width: 16 },
      { label: PPL.sheetColCostEgp, numFmt: VALUE_FMT, width: 16 },
    ],
    note: PPL.sheetUnpricedNote,
    rows: costRows,
    title: PPL.sheetCostTitle,
    totals:
      costRows.length > 0
        ? [
            PPL.costTotal,
            null,
            null,
            null,
            F(`SUM(E${costFirstRow}:E${costLastRow})`, num(plan.totals.costUsd)),
            F(`SUM(F${costFirstRow}:F${costLastRow})`, num(plan.totals.costEgp)),
          ]
        : undefined,
  });

  // C the price. The quantity beside it is a reference to the purchase column above, not a second
  // typed figure: two places to type the same number is how a workbook starts disagreeing with itself.
  for (let index = 0; index < costRows.length; index += 1) paintInput(sheet, costFirstRow + index, 3);

  const stampRow = afterCost;
  noteRow(
    sheet,
    stampRow,
    `${PPL.sheetGeneratedOn}: ${new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date())}` +
      ` — ${PPL.sheetGeneratedBy}: ${options.actorName ?? systemIdentity.appName}`,
  );

  // The direction and the face LAST, so every cell written above is covered by the one pass.
  //
  // The kit's helper is used for BOTH languages and then the view is flipped for English, rather
  // than skipped: its other half is what normalises every cell's font to one family and strips the
  // physical `left`/`right` alignments that fight a sheet's own direction, and an English sheet needs
  // that pass just as much. Tahoma stays the face in both — it is the one family in the browser
  // stack that ships with Excel everywhere, and Excel has no fallback list.
  applyRightToLeftSheet(sheet, { fontFace: PRODUCTION_PLANNING_WORKBOOK_FONT });
  if (S.dir === "ltr") {
    sheet.views = (sheet.views as ExcelJS.WorksheetView[]).map((view) => ({ ...view, rightToLeft: false }));
  }
  sheet.getColumn(1).width = 34;
  sheet.getColumn(2).width = 18;

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    buffer,
    stats: {
      builtAt: new Date().toISOString(),
      materials: plan.rows.length,
      pricedMaterials: costRows.length,
      runs: formatNumberLatin(plan.runs),
    },
  };
}

/** The download's filename: the product, the run count and the Cairo date, so a mailed copy is dateable. */
export function productionPlanningWorkbookFilename(plan: WirePlan): string {
  const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  // ASCII only: the name travels in a Content-Disposition header, where an Arabic letter is not a
  // legal byte, and a filename should read the same whichever language asked for the sheet.
  const code = plan.productNameEn.replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/ +/g, "-");
  return `production-plan-${code || "plan"}-${plan.runs}-runs-${stamp}.xlsx`;
}

/** Re-exported so the route can name the media type without reaching into the client helper. */
export const PRODUCTION_PLANNING_WORKBOOK_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
