// The Source-of-Sales mapping, as a workbook that answers questions with NO internet, no Phoenix
// login and no AI — for the field, for an auditor, and for whoever is holding a distributor's file
// at midnight.
//
// It is BUILT ON DEMAND from live production data, never shipped as a checked-in file. A mapping
// workbook that is three weeks stale is worse than none: it answers confidently and wrongly, and
// nothing on its face says which day it stopped being true. Every download carries the stamp it was
// built at, on the first sheet.
//
// ── What it can and cannot do, honestly ──
//
// The Lookup sheet mirrors the online lookup, including its REFUSAL. A customer code used by two
// distributors that land on different bricks is shown as a conflict with both candidates, never
// resolved to one. Excel cannot know better than the database does.
//
// The territory match reduces what you type to the SAME key the pipeline builds — see
// `excelAliasKey` below for the exact list and for the defect that forced it. What it deliberately
// does NOT do is fold ة to ه, because `normalizeAliasKey` does not either. Folding them would report
// matches production never returns, which is the worse failure: a confident wrong answer rather than
// a visible miss.
//
// ── ExcelJS ──
//
// NO outline groups and NO images, deliberately. ExcelJS emits two schema-invalid OOXML fragments —
// `outlineProperties` beside `pageSetup.fitToPage`, and `addImage` always writing `editAs` — and
// either makes Excel silently "repair" the workbook on open. This builder uses neither, so the bytes
// need no post-processing of the .xlsx zip. Same reasoning as
// src/lib/recruitment/manager-engagement-workbook.ts.
//
// The data sheets are written with bulk `addRows` and NO per-cell styling. Styling 68,000 rows cell
// by cell is what turns this from seconds into minutes.

import ExcelJS from "exceljs";

import { normalizeAliasKey } from "@/lib/sales/normalizer/resolvers";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type OfflineLookupStats = {
  areaAliases: number;
  areas: number;
  bricks: number;
  builtAt: string;
  customers: number;
  distributors: number;
  territoryAliases: number;
};

type MapRow = {
  address: string | null;
  area_code: string | null;
  brick_id: string | null;
  confidence: number | null;
  customer_code: string;
  customer_name: string | null;
  distributor_code: string;
  region_code: string | null;
  source: string | null;
};
type BrickRow = { area_code: string | null; block_code: string | null; brick_id: string; brick_name: string | null; region_code: string | null };
type AreaRow = { area_code: string; area_name: string | null; region_code: string | null };
type AliasRow = { alias: string; target_code: string | null; target_type: string | null };
type AreaAliasRow = { alias: string; area_code: string | null };

const SHEET = {
  areaAliases: "AreaAliases",
  areas: "Areas",
  batch: "Batch",
  bricks: "Bricks",
  customers: "CustomerMap",
  lookup: "Lookup",
  start: "Start here",
  territoryAliases: "TerritoryAliases",
} as const;

/** Rows a person can paste into the Batch sheet in one go. */
const BATCH_ROWS = 500;

// The alias sheets store the key `normalizeAliasKey()` produces, which does considerably more than
// trim: it folds Arabic-Indic digits, strips tatweel, unifies the four alef forms, folds ى to ي,
// turns every punctuation run into a space, collapses spaces and lowercases.
//
// So the WORKBOOK has to normalize what a person types the same way, or a name typed exactly as the
// alias is written MISSES. That was a real defect here, caught only by computing the formulas: the
// alias البـاجور carries a tatweel, the stored key does not, and the sheet reported UNRESOLVED for a
// territory the online lookup resolves outright. A workbook that disagrees with the system about
// whether a name is known is worse than no workbook.
//
// Two deliberate exclusions, because Excel has no character classes: the digit fold covers the ten
// Arabic-Indic digits, and the punctuation fold covers the marks that actually appear in these
// names rather than every non-letter in Unicode. What ة and ه do is NOT folded, in either place —
// they are different letters to the pipeline and must stay different here.
const ARABIC_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
const PUNCTUATION = ["-", "_", "/", "\\", ".", ",", "(", ")", "[", "]", ":", ";", "'", '"', "،", "«", "»"];

/** Excel text that reduces `ref` to the same key the alias sheets store. */
function excelAliasKey(ref: string): string {
  let expr = ref;
  // A double quote inside an Excel string literal must be DOUBLED. Emitting it raw produced
  // `SUBSTITUTE(x,""," ")` — an empty string argument — which broke the whole chain and rendered
  // Err:501 in every territory cell. Invisible in the source; obvious the moment the sheet computes.
  const lit = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const sub = (from: string, to: string) => { expr = `SUBSTITUTE(${expr},${lit(from)},${lit(to)})`; };
  ARABIC_DIGITS.forEach((digit, i) => sub(digit, String(i)));
  sub("ـ", "");                                  // tatweel
  for (const alef of ["إ", "أ", "آ"]) sub(alef, "ا");
  sub("ى", "ي");
  for (const mark of PUNCTUATION) sub(mark, " ");
  // TRIM both strips the ends AND collapses internal runs of spaces to one, which is the
  // `\s+ -> " "` step. LOWER is last, matching the order in normalizeAliasKey.
  return `LOWER(TRIM(${expr}))`;
}

// ── loading ──────────────────────────────────────────────────────────────────────────────────────

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Read a whole table in pages, six at a time.
 *
 * `order` is REQUIRED and load-bearing, not cosmetic: pages are fetched CONCURRENTLY, and without a
 * total order Postgres may return any row in any page, so rows get both duplicated and dropped
 * between pages. Same rule as selectAllOneBatch in src/lib/sales/master-workbook.ts.
 *
 * An unbounded `.select()` silently stops at 1,000 rows with no marker, so every page is explicit.
 * A page that errors THROWS rather than becoming `[]`, and the row count is checked against the
 * table's own count at the end — a workbook that cannot be complete must fail loudly instead of
 * shipping a short customer map that looks perfectly fine.
 */
async function readAll<T>(supabase: Supa, table: string, columns: string, order: string): Promise<T[]> {
  const { count, error: countError } = await supabase.from(table).select("*", { count: "exact", head: true });
  if (countError) throw countError;
  const total = count ?? 0;
  const pageSize = 1000;
  const concurrency = 6;

  const offsets: number[] = [];
  for (let from = 0; from < total; from += pageSize) offsets.push(from);

  const pages: T[][] = new Array(offsets.length);
  for (let i = 0; i < offsets.length; i += concurrency) {
    const slice = offsets.slice(i, i + concurrency);
    const fetched = await Promise.all(slice.map(async (from) => {
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .order(order, { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      return (data ?? []) as unknown as T[];
    }));
    fetched.forEach((page, j) => { pages[i + j] = page; });
  }

  const rows = pages.flat();
  if (rows.length !== total) {
    throw new Error(`${table}: read ${rows.length} rows but the table holds ${total} — refusing to build a short workbook.`);
  }
  return rows;
}

export type OfflineLookupData = {
  areaAliases: AreaAliasRow[];
  areas: AreaRow[];
  bricks: BrickRow[];
  customers: MapRow[];
  territoryAliases: AliasRow[];
};

export async function loadOfflineLookupData(): Promise<OfflineLookupData> {
  const supabase = getSupabaseAdmin();
  const [areas, bricks, territoryAliases, areaAliases, customers] = await Promise.all([
    readAll<AreaRow>(supabase, "source_of_sales_areas", "area_code, area_name, region_code", "area_code"),
    readAll<BrickRow>(supabase, "source_of_sales_bricks", "brick_id, brick_name, block_code, area_code, region_code", "brick_id"),
    readAll<AliasRow>(supabase, "source_of_sales_territory_aliases", "alias, target_type, target_code", "id"),
    readAll<AreaAliasRow>(supabase, "source_of_sales_area_aliases", "alias, area_code", "id"),
    readAll<MapRow>(
      supabase,
      "source_of_sales_customer_map",
      "distributor_code, customer_code, customer_name, address, brick_id, area_code, region_code, confidence, source",
      "id",
    ),
  ]);
  return { areaAliases, areas, bricks, customers, territoryAliases };
}

// ── building ─────────────────────────────────────────────────────────────────────────────────────

const HEAD_FILL: ExcelJS.Fill = { fgColor: { argb: "FF020617" }, pattern: "solid", type: "pattern" };

function headerRow(ws: ExcelJS.Worksheet, labels: string[], widths: number[]): void {
  ws.columns = labels.map((_, i) => ({ width: widths[i] ?? 18 }));
  const row = ws.addRow(labels);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = HEAD_FILL;
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

function label(ws: ExcelJS.Worksheet, cell: string, text: string): void {
  const c = ws.getCell(cell);
  c.value = text;
  c.font = { bold: true, size: 9 };
}

export function buildOfflineLookupWorkbook(data: OfflineLookupData): { stats: OfflineLookupStats; workbook: ExcelJS.Workbook } {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  // Sheets are created in the order they should APPEAR. ExcelJS has no supported way to reorder
  // them afterwards — `orderNo` is not in its typings and `workbook.worksheets` is a derived array,
  // so sorting it silently did nothing and shipped a workbook opening on 68,000 raw rows instead of
  // the instructions. Creation order IS the tab order; keep it that way.
  const TAB_ORDER = [SHEET.start, SHEET.lookup, SHEET.batch, SHEET.bricks, SHEET.areas, SHEET.territoryAliases, SHEET.areaAliases, SHEET.customers];
  for (const name of TAB_ORDER) workbook.addWorksheet(name);
  const sheet = (name: string): ExcelJS.Worksheet => {
    const ws = workbook.getWorksheet(name);
    if (!ws) throw new Error(`offline workbook: sheet ${name} was never created`);
    return ws;
  };

  const distributors = [...new Set(data.customers.map((row) => row.distributor_code))].filter(Boolean).sort();
  const areaName = new Map(data.areas.map((a) => [a.area_code, a.area_name ?? ""]));
  const brickById = new Map(data.bricks.map((b) => [b.brick_id, b]));

  // ── data sheets first: the formulas below point at them by name ──

  // CustomerMap. Column C is a composite key so one MATCH answers "this distributor's this code",
  // and column B alone answers "who else uses this code" — the two questions the online lookup asks.
  const cm = sheet(SHEET.customers);
  headerRow(cm, ["Distributor", "Customer code", "Key", "Customer name", "Address", "Brick", "Brick name", "Area", "Area name", "Region", "Confidence", "Source"],
    [12, 16, 26, 34, 34, 12, 20, 10, 18, 10, 11, 12]);
  cm.addRows(data.customers.map((row) => {
    // The brick NAME is not on the customer row — it lives on the brick master, so it is joined in
    // here. Without it the sheet would show only an opaque id like B128-4, which is exactly the
    // "never show a raw code" failure this workbook exists to avoid.
    const brick = row.brick_id ? brickById.get(row.brick_id) : undefined;
    // `brick_id` is an EMPTY STRING on unmapped rows here, not null — reading it as "populated"
    // because it is non-null is a mistake that has produced a wrong forecast before.
    const brickId = (row.brick_id ?? "").trim();
    return [
      row.distributor_code,
      row.customer_code,
      `${row.distributor_code}|${row.customer_code}`,
      row.customer_name ?? "",
      row.address ?? "",
      brickId,
      brick?.brick_name ?? "",
      row.area_code ?? "",
      areaName.get(row.area_code ?? "") ?? "",
      row.region_code ?? "",
      row.confidence ?? "",
      row.source ?? "",
    ];
  }));

  const br = sheet(SHEET.bricks);
  headerRow(br, ["Brick", "Brick name", "Block", "Area", "Area name", "Region"], [14, 26, 12, 10, 20, 10]);
  br.addRows(data.bricks.map((b) => [b.brick_id, b.brick_name ?? "", b.block_code ?? "", b.area_code ?? "", areaName.get(b.area_code ?? "") ?? "", b.region_code ?? ""]));

  const ar = sheet(SHEET.areas);
  headerRow(ar, ["Area", "Area name", "Region"], [10, 26, 12]);
  ar.addRows(data.areas.map((a) => [a.area_code, a.area_name ?? "", a.region_code ?? ""]));

  // Alias sheets carry the RAW alias and the key the pipeline actually matches on, so a miss is
  // explicable: you can see the exact string the system is comparing against.
  const ta = sheet(SHEET.territoryAliases);
  headerRow(ta, ["Alias (as written)", "Match key", "Target type", "Target", "Brick name", "Area", "Area name"], [26, 26, 12, 14, 24, 10, 20]);
  ta.addRows(data.territoryAliases.map((a) => {
    const brick = a.target_type === "brick" && a.target_code ? brickById.get(a.target_code) : undefined;
    return [
      a.alias,
      normalizeAliasKey(a.alias),
      a.target_type ?? "",
      a.target_code ?? "",
      brick?.brick_name ?? "",
      brick?.area_code ?? "",
      areaName.get(brick?.area_code ?? "") ?? "",
    ];
  }));

  const aa = sheet(SHEET.areaAliases);
  headerRow(aa, ["Alias (as written)", "Match key", "Area", "Area name", "Region"], [26, 26, 10, 22, 12]);
  aa.addRows(data.areaAliases.map((a) => [a.alias, normalizeAliasKey(a.alias), a.area_code ?? "", areaName.get(a.area_code ?? "") ?? "", ""]));

  // ── Lookup: the interactive sheet ──
  const lk = sheet(SHEET.lookup);
  lk.views = [{ showGridLines: false, state: "frozen", ySplit: 1 }];
  lk.columns = [{ width: 3 }, { width: 24 }, { width: 3 }, { width: 20 }, { width: 46 }];

  lk.getCell("B2").value = "LOOK IT UP";
  lk.getCell("B2").font = { bold: true, size: 14 };
  lk.getCell("B3").value = "Type in the yellow cells. Everything else fills itself in.";
  lk.getCell("B3").font = { size: 9 };

  const input = (cell: string) => {
    const c = lk.getCell(cell);
    c.fill = { fgColor: { argb: "FFFFF7D6" }, pattern: "solid", type: "pattern" };
    c.border = { bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, top: { style: "thin" } };
  };

  // 1) code -> who uses it
  label(lk, "B5", "1. CUSTOMER CODE");
  label(lk, "B6", "Customer code");
  input("C6");
  lk.getCell("C6").value = "2029";

  const N = data.customers.length + 1; // header row offset
  const codeCol = `${SHEET.customers}!$B$2:$B$${N}`;
  const distCol = `${SHEET.customers}!$A$2:$A$${N}`;
  const keyCol = `${SHEET.customers}!$C$2:$C$${N}`;
  const nameCol = `${SHEET.customers}!$D$2:$D$${N}`;
  const addrCol = `${SHEET.customers}!$E$2:$E$${N}`;
  const brickCol = `${SHEET.customers}!$F$2:$F$${N}`;
  const brickNmCol = `${SHEET.customers}!$G$2:$G$${N}`;
  const areaCol = `${SHEET.customers}!$H$2:$H$${N}`;
  const areaNmCol = `${SHEET.customers}!$I$2:$I$${N}`;
  const regionCol = `${SHEET.customers}!$J$2:$J$${N}`;

  // FIRST and LAST occurrence of the code, never "first and the one after it". `LOOKUP(2,1/(…))`
  // returns the LAST row matching a condition and needs no array entry. Production says a code is
  // used by at most TWO distributors — 3,156 pairs, zero triples — so first plus last IS the whole
  // candidate set. When only one row matches, first and last are the same row, which reads correctly
  // rather than duplicating an answer.
  const first = (col: string) => `INDEX(${col},MATCH($C$6,${codeCol},0))`;
  const last = (col: string) => `LOOKUP(2,1/(${codeCol}=$C$6),${col})`;

  label(lk, "B8", "Used by");
  lk.getCell("C8").value = { formula: `=IF($C$6="","",COUNTIF(${codeCol},$C$6)&" row(s) in the map")`, result: undefined } as ExcelJS.CellFormulaValue;

  const block = (top: number, heading: string, pick: (col: string) => string): void => {
    label(lk, `B${top}`, heading);
    const put = (row: number, text: string, col: string, suffix = "") => {
      label(lk, `B${row}`, text);
      lk.getCell(`C${row}`).value = { formula: `=IF($C$6="","",IFERROR(${pick(col)}${suffix},"—"))`, result: undefined } as ExcelJS.CellFormulaValue;
    };
    put(top + 1, "  Distributor", distCol);
    put(top + 2, "  Customer", nameCol);
    put(top + 3, "  Brick", brickNmCol);
    label(lk, `B${top + 4}`, "  Area");
    lk.getCell(`C${top + 4}`).value = {
      formula: `=IF($C$6="","",IFERROR(${pick(areaNmCol)}&" ("&${pick(areaCol)}&")","—"))`,
      result: undefined,
    } as ExcelJS.CellFormulaValue;
  };
  block(10, "FIRST MATCH", first);
  block(16, "SECOND MATCH (blank when only one)", last);

  // Hidden helpers the verdict compares. The BRICK is what gets written to a mapping, so the brick
  // is what decides — this is the same rule as classifyCustomerCodeCandidates() in
  // src/lib/sales/mapping-lookup.ts. Comparing AREAS instead would call two different bricks in one
  // area "safe", and the brick is precisely what a person would then copy out wrongly.
  lk.getCell("E13").value = { formula: `=IFERROR(${first(brickCol)},"")`, result: undefined } as ExcelJS.CellFormulaValue;
  lk.getCell("E19").value = { formula: `=IFERROR(${last(brickCol)},"")`, result: undefined } as ExcelJS.CellFormulaValue;
  for (const c of ["E13", "E19"]) lk.getCell(c).font = { color: { argb: "FFCCCCCC" }, size: 8 };

  label(lk, "B22", "VERDICT");
  lk.getCell("C22").value = {
    formula: `=IF($C$6="","Type a code in C6.",IF(COUNTIF(${codeCol},$C$6)=0,"NOT FOUND — no customer in the map carries this code.",IF(COUNTIF(${codeCol},$C$6)=1,"RESOLVED — one distributor uses this code.",IF($E$13=$E$19,"SAME BRICK — two distributors, but the territory is identical either way.","CHOOSE — two distributors on DIFFERENT bricks. This cannot be answered from the code alone."))))`,
    result: undefined,
  } as ExcelJS.CellFormulaValue;
  lk.getCell("C22").font = { bold: true };
  lk.mergeCells("C22:E22");

  label(lk, "B23", "Leading zeros");
  lk.getCell("C23").value = {
    formula: `=IF($C$6="","",IF(COUNTIF(${codeCol},$C$6)>0,"Leading zeros are part of a code, never formatting.",IF(COUNTIF(${codeCol},TEXT($C$6,"0000000000"))>0,"Try "&TEXT($C$6,"0000000000")&" — that spelling EXISTS, and it is a DIFFERENT customer until you confirm otherwise.","No padded spelling exists either.")))`,
    result: undefined,
  } as ExcelJS.CellFormulaValue;
  lk.mergeCells("C23:E23");

  // 2) territory text
  label(lk, "B26", "2. DISTRICT OR BRICK TEXT");
  label(lk, "B27", "Territory text");
  input("C27");
  lk.getCell("C27").value = "الباجور";

  const tN = data.territoryAliases.length + 1;
  const aN = data.areaAliases.length + 1;
  const taKey = `${SHEET.territoryAliases}!$B$2:$B$${tN}`;
  const taTarget = `${SHEET.territoryAliases}!$D$2:$D$${tN}`;
  const taBrickName = `${SHEET.territoryAliases}!$E$2:$E$${tN}`;
  const taArea = `${SHEET.territoryAliases}!$F$2:$F$${tN}`;
  const taAreaNm = `${SHEET.territoryAliases}!$G$2:$G$${tN}`;
  const aaKey = `${SHEET.areaAliases}!$B$2:$B$${aN}`;
  // What the person typed, reduced to the key the alias sheets actually store.
  const KEY27 = excelAliasKey("$C$27");
  const aaArea = `${SHEET.areaAliases}!$C$2:$C$${aN}`;
  const aaAreaNm = `${SHEET.areaAliases}!$D$2:$D$${aN}`;

  label(lk, "B29", "Brick");
  lk.getCell("C29").value = { formula: `=IFERROR(INDEX(${taBrickName},MATCH(${KEY27},${taKey},0))&" ("&INDEX(${taTarget},MATCH(${KEY27},${taKey},0))&")","—")`, result: undefined } as ExcelJS.CellFormulaValue;
  label(lk, "B30", "Area");
  lk.getCell("C30").value = {
    formula: `=IFERROR(INDEX(${taAreaNm},MATCH(${KEY27},${taKey},0))&" ("&INDEX(${taArea},MATCH(${KEY27},${taKey},0))&")",IFERROR(INDEX(${aaAreaNm},MATCH(${KEY27},${aaKey},0))&" ("&INDEX(${aaArea},MATCH(${KEY27},${aaKey},0))&")","—"))`,
    result: undefined,
  } as ExcelJS.CellFormulaValue;
  // "Ambiguous" is a real answer, not a failure: production drops an alias key that points at two
  // different targets, so the pipeline refuses it too. Saying "unknown" instead would send someone
  // hunting for a missing alias that was deliberately withheld.
  label(lk, "B32", "VERDICT");
  lk.getCell("C32").value = {
    formula: `=IF($C$27="","Type a district or brick name in C27.",IF(COUNTIF(${taKey},${KEY27})>1,"AMBIGUOUS — this name is used by more than one territory. It needs a decision, not a lookup.",IF(COUNTIF(${taKey},${KEY27})=1,"BRICK — a brick alias answers this outright.",IF(COUNTIF(${aaKey},${KEY27})>0,"AREA ONLY — write the area; the brick is still an open question.","UNRESOLVED — nothing in either alias table matches. Spacing and ة / ه both count."))))`,
    result: undefined,
  } as ExcelJS.CellFormulaValue;
  lk.getCell("C32").font = { bold: true };
  lk.mergeCells("C32:E32");

  // ── Batch: paste many at once ──
  const bt = sheet(SHEET.batch);
  bt.getCell("A1").value = `Paste a distributor code in A and a customer code in B, up to ${BATCH_ROWS} rows. Columns C onward fill themselves.`;
  bt.getCell("A1").font = { bold: true, size: 10 };
  bt.getRow(3).values = ["Distributor", "Customer code", "Customer name", "Address", "Brick", "Brick name", "Area name", "Region", "Used by", "Verdict"];
  bt.getRow(3).font = { bold: true, color: { argb: "FFFFFFFF" } };
  bt.getRow(3).fill = HEAD_FILL;
  bt.columns = [{ width: 12 }, { width: 16 }, { width: 32 }, { width: 32 }, { width: 12 }, { width: 20 }, { width: 18 }, { width: 10 }, { width: 9 }, { width: 46 }];
  bt.views = [{ state: "frozen", ySplit: 3 }];
  for (let r = 4; r < 4 + BATCH_ROWS; r++) {
    const key = `$A${r}&"|"&$B${r}`;
    const put = (col: string, formula: string) => {
      bt.getCell(`${col}${r}`).value = { formula, result: undefined } as ExcelJS.CellFormulaValue;
    };
    const hit = (col: string) => `=IF($B${r}="","",IFERROR(INDEX(${col},MATCH(${key},${keyCol},0)),""))`;
    put("C", `=IF($B${r}="","",IFERROR(INDEX(${nameCol},MATCH(${key},${keyCol},0)),"— not found for that distributor —"))`);
    put("D", hit(addrCol));
    put("E", hit(brickCol));
    put("F", hit(brickNmCol));
    put("G", hit(areaNmCol));
    put("H", hit(regionCol));
    put("I", `=IF($B${r}="","",COUNTIF(${codeCol},$B${r}))`);
    // Column A may be left blank on purpose — that is the "I only have a code" case, and the honest
    // answer is then how many distributors use it, never a guess at which one was meant.
    put("J", `=IF($B${r}="","",IF($I${r}=0,"NOT FOUND",IF($A${r}<>"",IF(COUNTIF(${keyCol},${key})=0,"NOT under that distributor — check column A","RESOLVED for the distributor you named"),IF($I${r}=1,"RESOLVED — only one distributor uses this code","CHOOSE — "&$I${r}&" distributors use it; name one in column A"))))`);
  }

  // ── Start here, written last but moved to the front ──
  const st = sheet(SHEET.start);
  st.views = [{ showGridLines: false }];
  st.columns = [{ width: 3 }, { width: 104 }];
  const stats: OfflineLookupStats = {
    areaAliases: data.areaAliases.length,
    areas: data.areas.length,
    bricks: data.bricks.length,
    builtAt: new Date().toISOString(),
    customers: data.customers.length,
    distributors: distributors.length,
    territoryAliases: data.territoryAliases.length,
  };
  const lines: [string, boolean][] = [
    ["Source of Sales — offline mapping lookup", true],
    ["", false],
    [`Built from live Phoenix data on ${stats.builtAt.slice(0, 10)} at ${stats.builtAt.slice(11, 16)} UTC.`, false],
    [`${stats.customers.toLocaleString("en-US")} customers · ${stats.bricks} bricks · ${stats.areas} areas · ${stats.territoryAliases} brick aliases · ${stats.areaAliases} area aliases · ${stats.distributors} distributors.`, false],
    ["", false],
    ["THIS IS A SNAPSHOT. It stops being true the moment someone changes a mapping in Phoenix.", true],
    ["Download it again whenever the answer matters. Nothing in the file can tell you it has gone stale.", false],
    ["", false],
    ["How to use it", true],
    ["  Lookup sheet — type a customer code in C6, or a district / brick name in C21. Read the VERDICT.", false],
    ["  Batch sheet — paste up to 500 rows: distributor code in A, customer code in B. The rest fills in.", false],
    ["  The other sheets are the reference data itself, if you would rather read it directly.", false],
    ["", false],
    ["Two things it will refuse to guess, on purpose", true],
    ["  A customer code used by two distributors in different territories. Both are shown; you choose.", false],
    ["  Leading zeros are part of a code, never formatting. 0001503279 and 1503279 are two different", false],
    ["  pharmacies in two different governorates. The sheet will never merge them for you.", false],
    ["", false],
    ["Why a district name sometimes finds nothing", true],
    ["  The match is exact after trimming spaces, because that is what the import pipeline does.", false],
    ["  ة and ه are different letters here, and internal spacing counts. A near miss is a real miss:", false],
    ["  the Match key column on the alias sheets shows the exact text being compared.", false],
  ];
  lines.forEach(([text, bold], i) => {
    const cell = st.getCell(`B${i + 2}`);
    cell.value = text;
    if (bold) cell.font = { bold: true, size: i === 0 ? 14 : 10 };
  });


  return { stats, workbook };
}

export async function buildOfflineLookupWorkbookBuffer(): Promise<{ buffer: ArrayBuffer; stats: OfflineLookupStats }> {
  const data = await loadOfflineLookupData();
  const { stats, workbook } = buildOfflineLookupWorkbook(data);
  const buffer = (await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer;
  return { buffer, stats };
}
