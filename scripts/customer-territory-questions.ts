/**
 * Which area does the DISTRIBUTOR'S OWN SHEET put this customer in? — the owner's decision sheet.
 *
 * WHY THIS EXISTS, AND WHY IT REPLACES THE ADDRESS ROUTE. `delta-area-questions.ts` and
 * `gharbia-area-questions.ts` built their candidate list by matching Phoenix brick names against the
 * customer's ADDRESS. Measured against production on 2026-09-11, that route is wrong on the money:
 * of 5,527 customers it flagged, the distributor's own territory column backed the EXISTING mapping
 * 2,162 times (11.7M EGP Jun-Aug) against 43 times for the move (52K EGP). Every one of the ten
 * largest flags was a false positive of the same shape — a business name or a street name that also
 * happens to be a brick somewhere else in Egypt:
 *
 *   "مخزن الفتح للادوية" in Mansoura matched the brick الفتح in Assuit 2            2,539,188 EGP
 *   a Mansoura address on شارع صلاح الدين matched that brick in Alex East           1,103,375 EGP
 *   a Fayoum address on شارع المحكمة matched a Heliopolis brick                       151,904 EGP
 *
 * An address-based sweep had already been reverted in full that morning
 * (`revert-address-based-sheets-2026-09-11`, 1,750 rows). This script reads the one part of the
 * distributor's sheet that IS reliable instead: the territory column it writes itself.
 *
 * HOW A CANDIDATE IS FOUND. Exactly the way `resolveBrick()` in the import pipeline resolves it —
 * the territory text through the BRICK alias table first, then the AREA alias table — so the answer
 * this script proposes is the answer the next import would reach on its own. Backtested over 16,307
 * mapped PS customers: 98.6% correct when the brick alias resolves. A customer is flagged only when
 * that resolution names an area OTHER than the one the customer is counted in.
 *
 * WHY IT IS STILL A QUESTION AND NOT A FIX. Standing owner rule: territory is not geography. His own
 * ruling outranks how a distributor files its rounds, so a row carrying `owner-*`, `final-new-*` or
 * `sheet-verified` is presented as "keep my ruling" and never as a move.
 *
 * READ-ONLY by default. `--apply <answers.xlsx>` writes to `public.source_of_sales_customer_map`
 * after taking a pre-image in a dated backup schema.
 *
 * Run:  node --experimental-strip-types --experimental-specifier-resolution=node \
 *         scripts/customer-territory-questions.ts
 *
 * NO IMAGES AND NO OUTLINE GROUPS, deliberately — ExcelJS writes two schema-invalid OOXML fragments
 * that make Excel silently "repair" the workbook. Data validation is added ONCE PER CONTIGUOUS
 * BLOCK, never per cell.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";
import JSZip from "jszip";
import postgres from "postgres";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "customer-territory-questions",
  entry: import.meta.url,
  known: ["--apply", "--dry-run", "--count-only", "--apply-recommended", "--from", "--to"],
});

const HEADER_FILL = "FF0F172A";
const ACCENT_FILL = "FF0A6BA6";
const ANSWER_FILL = "FFEFF6FF";
const ALERT_FILL = "FFFFF1F2";

/** The batch label written into `source`, and the schema the pre-image lands in. */
const SOURCE_PREFIX = "distributor-territory";
const BACKUP_SCHEMA_PREFIX = "sos_backup";

const TAB_RULED = "You already ruled on these";
const TAB_APPLY = "Safe to apply";
const TAB_WEAK = "Weaker evidence";

const ANSWER_HEADER = "Your answer";
const NOTE_HEADER = "Note";

const OPT_RULED =
  '"Keep my ruling — leave it where it is,Move it to the sheet area,Not sure — I need to check,Other — see my note"';
const OPT_APPLY =
  '"Apply it — the sheet is right,Leave it where it is,Not sure — I need to check,Other — see my note"';

/** The only answer that moves a row. Everything else, blank included, leaves it alone. */
const ANSWER_MOVE_RULED = "Move it to the sheet area";
const ANSWER_MOVE_APPLY = "Apply it — the sheet is right";

type Group = "ruled" | "apply" | "weak";

type Row = {
  id: string;
  distributor_code: string;
  customer_code: string;
  customer_name: string | null;
  address: string | null;
  source: string | null;
  own_area: string;
  own_area_name: string | null;
  own_region: string | null;
  own_brick: string | null;
  own_brick_name: string | null;
  territory: string;
  route: string;
  territory_area: string;
  territory_area_name: string | null;
  territory_region: string | null;
  brick_from_alias: string | null;
  territory_brick_name: string | null;
  value_3m: string | null;
  last_period: string | null;
};

type SheetWithValidations = ExcelJS.Worksheet & {
  dataValidations: { add: (range: string, rule: ExcelJS.DataValidation) => void };
};

/**
 * The finder. Every CTE is MATERIALIZED on purpose: without it Postgres inlines the alias keys and
 * re-derives them per row, and the whole query moves from seconds to past the statement timeout.
 *
 * `normalizeAliasKey`, matched here in SQL, is NOT `phx_normalize_arabic`. It keeps spaces and does
 * not fold `ة`; the database function does the opposite on both counts. Using the wrong one silently
 * misses — `كفرالدوار` and `كفر الدوار` are different keys here and the same key there.
 */
const FINDER_SQL = `
with akey as materialized (
  select btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           lower(a.alias),'ـ','','g'),'[إأآا]','ا','g'),'ى','ي','g'),'[^[:alnum:]]+',' ','g')) as k,
         b.area_code, b.brick_id
  from public.source_of_sales_territory_aliases a
  join public.source_of_sales_bricks b on b.brick_id = a.target_code
  where a.active and a.target_type = 'brick' and b.active
),
akey1 as materialized (
  select k, min(area_code) as area_code, min(brick_id) as brick_id,
         count(distinct area_code) as n_area, count(distinct brick_id) as n_brick
  from akey group by k
),
qraw as materialized (
  select btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           lower(a.alias),'ـ','','g'),'[إأآا]','ا','g'),'ى','ي','g'),'[^[:alnum:]]+',' ','g')) as k,
         a.area_code
  from public.source_of_sales_area_aliases a where a.active
),
qkey1 as materialized (
  select k, min(area_code) as area_code, count(distinct area_code) as n_area from qraw group by k
),
terr as materialized (
  select distributor_code, client_code, mode() within group (order by t) as territory
  from (
    select distributor_code, client_code, nullif(btrim(coalesce(
             raw_row->>'Sal. Dist. Desc.', raw_row->>'Brick Name', raw_row->>'bricks',
             raw_row->>'MRKZ_N', raw_row->>'TerritoryName', raw_row->>'المنطقة', raw_row->>'منطقة')),'') as t
    from public.source_of_sales_import_rows
  ) x where t is not null group by distributor_code, client_code
),
res as materialized (
  select t.distributor_code, t.client_code, t.territory,
         case when ak.n_area = 1 and ak.n_brick = 1 then ak.brick_id end as brick_from_alias,
         coalesce(case when ak.n_area = 1 then ak.area_code end,
                  case when qk.n_area = 1 then qk.area_code end) as territory_area,
         case when ak.n_area = 1 then 'brick alias'
              when qk.n_area = 1 then 'area alias' end as route
  from (select distributor_code, client_code, territory,
               btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
                 lower(territory),'ـ','','g'),'[إأآا]','ا','g'),'ى','ي','g'),'[^[:alnum:]]+',' ','g')) as k
        from terr) t
  left join akey1 ak on ak.k = t.k
  left join qkey1 qk on qk.k = t.k
),
sales as materialized (
  select distributor_code, client_code,
         sum(value) filter (where invoice_period between $1 and $2) as v3,
         max(invoice_period) as last_period
  from public.source_of_sales_import_rows group by distributor_code, client_code
)
select m.id::text as id, m.distributor_code, m.customer_code, m.customer_name, m.address, m.source,
       m.area_code as own_area, oa.area_name as own_area_name, oa.region_code as own_region,
       m.brick_id as own_brick, ob.brick_name as own_brick_name,
       r.territory, r.route, r.territory_area,
       ta.area_name as territory_area_name, ta.region_code as territory_region,
       r.brick_from_alias, tb.brick_name as territory_brick_name,
       round(coalesce(s.v3, 0))::text as value_3m, s.last_period
from public.source_of_sales_customer_map m
join public.source_of_sales_areas oa on oa.area_code = m.area_code
left join public.source_of_sales_bricks ob on ob.brick_id = m.brick_id
join res r on r.distributor_code = m.distributor_code and r.client_code = m.customer_code
join public.source_of_sales_areas ta on ta.area_code = r.territory_area
left join public.source_of_sales_bricks tb on tb.brick_id = r.brick_from_alias
left join sales s on s.distributor_code = m.distributor_code and s.client_code = m.customer_code
where m.active and r.territory_area is distinct from m.area_code
order by coalesce(s.v3, 0) desc
`;

function loadLocalEnv(path = ".env.local"): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/** EGP at factory price. Never a unit count — units of different products are never added. */
function money(value: string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

const fmt = (value: number): string => value.toLocaleString("en-US");

/** A row the owner placed himself. His ruling outranks how a distributor files its rounds. */
function isRuled(row: Row): boolean {
  const source = row.source ?? "";
  return /^(owner-|final-new-)/.test(source) || source === "sheet-verified";
}

function groupOf(row: Row): Group {
  if (isRuled(row)) return "ruled";
  return row.route === "brick alias" && row.brick_from_alias ? "apply" : "weak";
}

function recommend(row: Row, group: Group): [string, string] {
  if (group === "ruled") {
    return [
      "Keep my ruling — leave it where it is",
      `You placed this row yourself (${row.source}). Your ruling outranks how a distributor files its own rounds.`,
    ];
  }
  if (group === "apply") {
    return [
      ANSWER_MOVE_APPLY,
      `The distributor files this customer under ${row.territory}, which is a brick in `
        + `${row.territory_area_name ?? row.territory_area}. Nothing of yours contradicts it.`,
    ];
  }
  return [
    "Not sure — I need to check",
    `The territory text ${row.territory} resolves only as far as the area, never to a single brick, `
      + `so it is the weakest evidence in this file.`,
  ];
}

const COLUMNS = 15;
const WIDTHS = [30, 15, 9, 40, 20, 22, 24, 20, 16, 11, 30, 24, 52, 30, 34];
const HEADERS = [
  "Customer", "Customer code", "Dist.", "Address as recorded", "Counted in now", "Brick now",
  "The sheet's own territory text", "The sheet points at", "Sales (EGP)", "Last month",
  "How it was mapped", "My recommendation", "Why", ANSWER_HEADER, NOTE_HEADER,
];

function styleHeader(sheet: ExcelJS.Worksheet, rowNumber: number, columns: number): void {
  const row = sheet.getRow(rowNumber);
  for (let column = 1; column <= columns; column += 1) {
    const cell = row.getCell(column);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  }
  row.height = 32;
}

function addTitle(sheet: ExcelJS.Worksheet, columns: number, title: string, subtitle: string): void {
  sheet.mergeCells(1, 1, 1, columns);
  const titleCell = sheet.getCell("A1");
  titleCell.value = title;
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_FILL } };
  titleCell.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
  titleCell.alignment = { horizontal: "left", vertical: "middle" };
  sheet.getRow(1).height = 30;

  sheet.mergeCells(2, 1, 2, columns);
  const subtitleCell = sheet.getCell("A2");
  subtitleCell.value = subtitle;
  subtitleCell.font = { size: 10, color: { argb: "FF475569" } };
  subtitleCell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  sheet.getRow(2).height = 58;
}

function buildTab(
  workbook: ExcelJS.Workbook, name: string, rows: Row[], group: Group,
  title: string, subtitle: string, options: string,
): void {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = WIDTHS.map((width) => ({ width }));
  addTitle(sheet, COLUMNS, title, subtitle);

  const headerRow = 4;
  sheet.getRow(headerRow).values = HEADERS;
  styleHeader(sheet, headerRow, COLUMNS);

  rows.forEach((row, index) => {
    const excelRow = sheet.getRow(headerRow + 1 + index);
    const [verdict, why] = recommend(row, group);
    const recent = money(row.value_3m);
    excelRow.values = [
      row.customer_name ?? "", row.customer_code, row.distributor_code, row.address ?? "",
      `${row.own_area_name ?? row.own_area} (${row.own_region ?? "?"})`,
      row.own_brick_name ?? row.own_brick ?? "",
      row.territory,
      `${row.territory_area_name ?? row.territory_area} (${row.territory_region ?? "?"})`,
      recent, row.last_period ?? "never", row.source ?? "", verdict, why, "", "",
    ];
    excelRow.alignment = { vertical: "top", wrapText: true };
    excelRow.height = 30;
    excelRow.getCell(9).numFmt = "#,##0";
    if (recent > 0) {
      excelRow.getCell(9).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ALERT_FILL } };
      excelRow.getCell(9).font = { bold: true };
    }
    excelRow.getCell(12).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
    excelRow.getCell(13).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
  });

  const lastRow = headerRow + rows.length;
  if (rows.length > 0) {
    // ONE rule over the whole answer column — never one per cell (overlapping sqref = repair prompt).
    (sheet as SheetWithValidations).dataValidations.add(`N${headerRow + 1}:N${lastRow}`, {
      type: "list",
      allowBlank: true,
      formulae: [options],
      showErrorMessage: true,
      errorTitle: "Pick one, or choose Other",
      error: "Choose from the list, or pick 'Other — see my note' and say what you want in the Note column.",
    });
  }
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: headerRow }];
  sheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: Math.max(lastRow, headerRow), column: COLUMNS },
  };
}

function buildWorkbook(rows: Row[], agreed: number, window: string): ExcelJS.Workbook {
  const ruled = rows.filter((row) => groupOf(row) === "ruled");
  const apply = rows.filter((row) => groupOf(row) === "apply");
  const weak = rows.filter((row) => groupOf(row) === "weak");
  const total = (list: Row[]): number => list.reduce((sum, row) => sum + money(row.value_3m), 0);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce — distributor territory decisions";
  workbook.created = new Date();

  const start = workbook.addWorksheet("Start here");
  start.columns = [{ width: 46 }, { width: 14 }, { width: 22 }, { width: 78 }];
  addTitle(
    start, 4,
    "Where the distributor's own sheet disagrees with our mapping",
    "I read the territory column each distributor writes on its own sheet and resolved it the same way "
      + `the import pipeline does. It agrees with the mapping we already have on ${fmt(agreed)} customers. `
      + `It disagrees on ${fmt(rows.length)}, and those are the three tabs in this file. Answer the top rows `
      + "of each tab first, because the money is very concentrated. Leave a row blank and nothing changes.",
  );
  start.getRow(4).values = ["Tab", "Customers", `Sales ${window} (EGP)`, "What it is"];
  styleHeader(start, 4, 4);
  const summary: Array<[string, number, number, string]> = [
    [TAB_RULED, ruled.length, total(ruled),
      "The distributor files them somewhere else, but you placed them yourself. Your ruling wins unless you say otherwise."],
    [TAB_APPLY, apply.length, total(apply),
      "The distributor's territory text resolves to one brick and nothing of yours contradicts it. This is the set I recommend applying."],
    [TAB_WEAK, weak.length, total(weak),
      "The territory text resolves only as far as an area, never to a single brick. The weakest evidence in this file."],
  ];
  summary.forEach((entry, index) => {
    const row = start.getRow(5 + index);
    row.values = [entry[0], entry[1], entry[2], entry[3]];
    row.alignment = { vertical: "top", wrapText: true };
    row.height = 48;
    row.getCell(3).numFmt = "#,##0";
  });
  start.views = [{ state: "frozen", ySplit: 4 }];

  buildTab(
    workbook, TAB_RULED, ruled, "ruled",
    `${TAB_RULED} — ${ruled.length} rows, ${fmt(total(ruled))} EGP`,
    "On every row here the distributor files the customer in a different area from the one you put it in. "
      + "I recommend keeping your ruling everywhere, because your own decision outranks how a distributor "
      + "files its rounds. Biggest money first. Column L is my recommendation, column N is your answer.",
    OPT_RULED,
  );
  buildTab(
    workbook, TAB_APPLY, apply, "apply",
    `${TAB_APPLY} — ${apply.length} rows, ${fmt(total(apply))} EGP`,
    "Nothing of yours placed these rows, and the distributor's territory text resolves cleanly to a single "
      + "brick. That route is right roughly 99 times in 100. I recommend applying all of them.",
    OPT_APPLY,
  );
  buildTab(
    workbook, TAB_WEAK, weak, "weak",
    `${TAB_WEAK} — ${weak.length} rows, ${fmt(total(weak))} EGP`,
    "The distributor's territory text resolves only as far as an area here, never to a single brick, so it "
      + "is the weakest evidence in this file. Listed for completeness rather than because it needs a decision.",
    OPT_APPLY,
  );
  return workbook;
}

function cairoToday(): string {
  // Africa/Cairo, never `toISOString()`.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

function nextFreePath(): string {
  const base = resolve("xlsx", `customer-territory-decisions-${cairoToday()}`);
  const first = `${base}.xlsx`;
  if (!existsSync(first)) return first;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}.xlsx`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Too many territory-decision workbooks written today — clear xlsx/ before rerunning.");
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object" && "richText" in value) {
    return (value.richText ?? []).map((part) => part.text).join("");
  }
  if (typeof value === "object" && "text" in value) return String(value.text ?? "");
  return String(value);
}

type Answer = { distributor: string; code: string; answer: string; note: string };

/**
 * Read the answers back.
 *
 * ExcelJS FIRST, then a raw-OOXML fallback — and the fallback is not paranoia. On 2026-09-11 an
 * answered workbook came back written with `x:`-prefixed elements, which ExcelJS cannot load at all
 * (`TypeError: Cannot read properties of undefined (reading 'sheets')`). Some viewers and phone
 * spreadsheet apps rewrite a file that way on save. Failing there costs a whole round trip with the
 * owner, so read it by hand rather than asking him to save it again.
 */
async function readAnswers(answerPath: string): Promise<Map<string, Answer>> {
  try {
    return await readAnswersWithExcelJs(answerPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`  ExcelJS could not load the workbook (${reason}) — reading the OOXML directly.`);
    return await readAnswersFromRawXml(answerPath);
  }
}

function answerKey(distributor: string, code: string): string {
  // Codes are TEXT. Leading zeros are part of the code and are never stripped: of 97 codes that
  // collide once they are removed, 74 point at different bricks.
  return `${distributor.trim()}|${code.trim()}`;
}

async function readAnswersWithExcelJs(answerPath: string): Promise<Map<string, Answer>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(answerPath);
  const answers = new Map<string, Answer>();

  for (const name of [TAB_RULED, TAB_APPLY, TAB_WEAK]) {
    const sheet = workbook.getWorksheet(name);
    if (!sheet) continue;

    // FIND THE COLUMNS BY HEADER, never by a fixed index — a column added later shifts every one.
    const headerRow = sheet.getRow(4);
    let answerColumn = 0;
    let noteColumn = 0;
    let distColumn = 0;
    let codeColumn = 0;
    for (let column = 1; column <= 24; column += 1) {
      const text = cellText(headerRow.getCell(column).value).trim();
      if (text === ANSWER_HEADER) answerColumn = column;
      if (text === NOTE_HEADER) noteColumn = column;
      if (text === "Dist.") distColumn = column;
      if (text === "Customer code") codeColumn = column;
    }
    if (!answerColumn || !distColumn || !codeColumn) {
      throw new Error(`Sheet '${name}' has no ${ANSWER_HEADER} / Dist. / Customer code header row.`);
    }

    for (let rowNumber = 5; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const distributor = cellText(row.getCell(distColumn).value).trim();
      const code = cellText(row.getCell(codeColumn).value).trim();
      if (!distributor || !code) continue;
      answers.set(answerKey(distributor, code), {
        distributor,
        code,
        answer: cellText(row.getCell(answerColumn).value).trim(),
        note: noteColumn ? cellText(row.getCell(noteColumn).value).trim() : "",
      });
    }
  }
  return answers;
}

async function readAnswersFromRawXml(answerPath: string): Promise<Map<string, Answer>> {
  const zip = await JSZip.loadAsync(readFileSync(answerPath));
  const readPart = async (name: string): Promise<string> => {
    const file = zip.file(name);
    if (!file) throw new Error(`The workbook has no ${name}.`);
    return file.async("string");
  };

  const decode = (text: string): string =>
    text
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCharCode(Number(digits)))
      .replace(/&amp;/g, "&");

  const shared: string[] = [];
  const sharedFile = zip.file("xl/sharedStrings.xml");
  if (sharedFile) {
    const xml = await sharedFile.async("string");
    for (const item of xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)) {
      const parts = [...item[1].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => m[1]);
      shared.push(decode(parts.join("")));
    }
  }

  const workbookXml = await readPart("xl/workbook.xml");
  const relsXml = await readPart("xl/_rels/workbook.xml.rels");
  // ATTRIBUTE ORDER IS NOT GUARANTEED. The writer that produced the 2026-09-11 workbook emits
  // Type, then Target, then Id; a single regex demanding Id before Target matches nothing and the
  // whole reader returns zero rows with no error. Pull each attribute out of the tag separately.
  const targetById = new Map<string, string>();
  for (const rel of relsXml.matchAll(/<Relationship\b[^>]*?\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(rel[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(rel[0])?.[1];
    if (!id || !target) continue;
    targetById.set(id, target.replace(/^\/?xl\//, "").replace(/^\.\//, ""));
  }

  const answers = new Map<string, Answer>();
  for (const sheetTag of workbookXml.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = /name="([^"]+)"/.exec(sheetTag[0])?.[1];
    const relId = /r:id="([^"]+)"/.exec(sheetTag[0])?.[1];
    if (!name || !relId) continue;
    if (![TAB_RULED, TAB_APPLY, TAB_WEAK].includes(decode(name))) continue;
    const target = targetById.get(relId);
    if (!target) continue;

    const sheetXml = await readPart(`xl/${target}`);
    const cells = new Map<number, Record<string, string>>();
    for (const cell of sheetXml.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const ref = /r="([A-Z]+)(\d+)"/.exec(cell[1]);
      if (!ref) continue;
      const type = /t="([^"]+)"/.exec(cell[1])?.[1];
      const body = cell[2] ?? "";
      let value: string;
      if (type === "s") {
        const index = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
        value = index != null ? (shared[Number(index)] ?? "") : "";
      } else if (type === "inlineStr" || type === "str") {
        value = decode([...body.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => m[1]).join(""));
      } else {
        value = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1] ?? "";
      }
      const rowNumber = Number(ref[2]);
      if (!cells.has(rowNumber)) cells.set(rowNumber, {});
      (cells.get(rowNumber) as Record<string, string>)[ref[1]] = value.trim();
    }

    const header = cells.get(4) ?? {};
    const columnFor = (label: string): string | undefined =>
      Object.keys(header).find((letter) => header[letter] === label);
    const answerColumn = columnFor(ANSWER_HEADER);
    const noteColumn = columnFor(NOTE_HEADER);
    const distColumn = columnFor("Dist.");
    const codeColumn = columnFor("Customer code");
    if (!answerColumn || !distColumn || !codeColumn) continue;

    for (const [rowNumber, row] of cells) {
      if (rowNumber < 5) continue;
      const distributor = row[distColumn] ?? "";
      const code = row[codeColumn] ?? "";
      if (!distributor || !code) continue;
      answers.set(answerKey(distributor, code), {
        distributor,
        code,
        answer: row[answerColumn] ?? "",
        note: noteColumn ? (row[noteColumn] ?? "") : "",
      });
    }
  }
  return answers;
}

type ApplyOptions = { dryRun: boolean; applyRecommended: boolean };

async function runApply(
  sql: postgres.Sql, rows: Row[], answerPath: string, options: ApplyOptions,
): Promise<void> {
  const answers = await readAnswers(answerPath);
  const answered = [...answers.values()].filter((entry) => entry.answer !== "").length;
  console.log(`Read ${answers.size} rows from ${answerPath}, ${answered} of them answered.`);

  if (answered === 0 && !options.applyRecommended) {
    // 2026-09-11: a workbook came back named ANSWERED with every answer cell empty, because the app
    // that opened it did not save the selections. Blank must never read as consent.
    console.log("");
    console.log("  Nothing to apply — every answer cell is blank.");
    console.log("  A blank answer deliberately means 'leave it alone', so this is a no-op, not a failure.");
    console.log("  If the answers were lost on save, re-answer in Excel. To apply my recommendation on");
    console.log("  the 'Safe to apply' tab without ticking each row, pass --apply-recommended.");
    return;
  }

  const wanted: Row[] = [];
  for (const row of rows) {
    const group = groupOf(row);
    const entry = answers.get(answerKey(row.distributor_code, row.customer_code));
    const answer = entry?.answer ?? "";
    const explicit = group === "ruled" ? answer === ANSWER_MOVE_RULED : answer === ANSWER_MOVE_APPLY;
    const implied = options.applyRecommended && answer === "" && group === "apply";
    if (!explicit && !implied) continue;
    if (!row.brick_from_alias) {
      console.log(`  skipped ${row.distributor_code} / ${row.customer_code}: the territory text names an area, not a single brick.`);
      continue;
    }
    wanted.push(row);
  }

  console.log(`  ${wanted.length} rows to move.`);
  if (wanted.length === 0) return;
  const value = wanted.reduce((sum, row) => sum + money(row.value_3m), 0);
  console.log(`  ${fmt(value)} EGP rides on them.`);
  for (const row of wanted.slice(0, 10)) {
    console.log(`    ${row.distributor_code} / ${row.customer_code}  ${row.own_area_name} -> ${row.territory_area_name}  (${fmt(money(row.value_3m))} EGP)`);
  }
  if (wanted.length > 10) console.log(`    and ${wanted.length - 10} more.`);

  if (options.dryRun) {
    console.log("  --dry-run: nothing written.");
    return;
  }

  const stamp = cairoToday().replace(/-/g, "");
  const schema = `${BACKUP_SCHEMA_PREFIX}_${stamp}`;
  const table = `${schema}.customer_map_pre_territory_${Date.now()}`;
  const source = `${SOURCE_PREFIX}-${cairoToday()}`;
  const ids = wanted.map((row) => row.id);
  const bricks = wanted.map((row) => row.brick_from_alias as string);

  await sql.unsafe(`create schema if not exists ${schema}`);
  await sql.unsafe(
    `create table ${table} as select m.*, now() as captured_at
       from public.source_of_sales_customer_map m where m.id = any($1::bigint[])`,
    [ids],
  );
  const preimage = (await sql.unsafe(`select count(*)::int as n from ${table}`)) as unknown as Array<{ n: number }>;
  console.log(`  Pre-image: ${preimage[0].n} rows in ${table}`);

  const updated = (await sql.unsafe(
    `update public.source_of_sales_customer_map m
        set brick_id = b.brick_id, area_code = b.area_code, region_code = b.region_code,
            source = $3, mapped_by = 'distributor-territory-column', confidence = 90, updated_at = now()
       from unnest($1::bigint[], $2::text[]) as t(id, brick_id)
       join public.source_of_sales_bricks b on b.brick_id = t.brick_id and b.active
      where m.id = t.id and m.active and m.area_code is distinct from b.area_code
      returning m.id`,
    [ids, bricks, source],
  )) as unknown as Array<{ id: string }>;

  await sql.unsafe(
    `insert into public.source_of_sales_mapping_audit
       (entity_type, entity_key, distributor_code, action, actor, before_json, after_json)
     select 'customer_map', p.distributor_code || ' / ' || p.customer_code, p.distributor_code, 'edit', $1,
            jsonb_build_object('source', p.source, 'brick_id', p.brick_id, 'area_code', p.area_code,
                               'region_code', p.region_code, 'confidence', p.confidence, 'mapped_by', p.mapped_by),
            jsonb_build_object('source', m.source, 'brick_id', m.brick_id, 'area_code', m.area_code,
                               'region_code', m.region_code, 'confidence', m.confidence, 'mapped_by', m.mapped_by)
       from ${table} p
       join public.source_of_sales_customer_map m on m.id = p.id
      where m.brick_id is distinct from p.brick_id`,
    [`${source} (owner decision sheet ${answerPath})`],
  );

  console.log("");
  console.log(`  Asked to move: ${wanted.length}`);
  console.log(`  Actually moved: ${updated.length}`);
  console.log("");
  console.log(`  To reverse: update public.source_of_sales_customer_map m`);
  console.log(`    set area_code = p.area_code, brick_id = p.brick_id, region_code = p.region_code,`);
  console.log(`        source = p.source, mapped_by = p.mapped_by, confidence = p.confidence`);
  console.log(`    from ${table} p where p.id = m.id;`);
}

function reportCounts(rows: Row[], agreed: number, window: string): void {
  const groups: Array<[string, Group]> = [[TAB_APPLY, "apply"], [TAB_RULED, "ruled"], [TAB_WEAK, "weak"]];
  console.log(`Territory column agrees with the current mapping on ${fmt(agreed)} customers.`);
  console.log(`It disagrees on ${fmt(rows.length)}:`);
  for (const [label, group] of groups) {
    const list = rows.filter((row) => groupOf(row) === group);
    const value = list.reduce((sum, row) => sum + money(row.value_3m), 0);
    console.log(`  ${label.padEnd(28)} ${String(list.length).padStart(5)}   ${fmt(value).padStart(12)} EGP ${window}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const applyIndex = args.indexOf("--apply");
  const answerPath = applyIndex >= 0 ? args[applyIndex + 1] : undefined;
  const dryRun = args.includes("--dry-run");
  const countOnly = args.includes("--count-only");
  const applyRecommended = args.includes("--apply-recommended");
  const fromIndex = args.indexOf("--from");
  const toIndex = args.indexOf("--to");
  const from = fromIndex >= 0 ? String(args[fromIndex + 1]) : "2026-06";
  const to = toIndex >= 0 ? String(args[toIndex + 1]) : "2026-08";

  const env = loadLocalEnv();
  const databaseUrl = env.SUPABASE_DB_URL;
  if (!databaseUrl) throw new Error("SUPABASE_DB_URL is missing from .env.local.");
  const sql = postgres(databaseUrl, {
    connect_timeout: 20,
    max: 1,
    ssl: "require",
    // A NUMBER, not a string. The finder scans every alias key against every mapped customer and
    // runs well past the server default; the untracked scripts this replaces wrote it as a string,
    // which typechecks nowhere because CI never saw them.
    connection: { statement_timeout: 900_000 },
  });

  try {
    const rows = (await sql.unsafe(FINDER_SQL, [from, to])) as unknown as Row[];
    const agreedRow = (await sql.unsafe(
      `select count(*)::int as n from public.source_of_sales_customer_map where active`,
    )) as unknown as Array<{ n: number }>;
    const agreed = agreedRow[0].n - rows.length;
    const window = `${from}..${to}`;

    if (answerPath) {
      await runApply(sql, rows, answerPath, { dryRun, applyRecommended });
      return;
    }
    if (countOnly) {
      reportCounts(rows, agreed, window);
      return;
    }
    if (rows.length === 0) {
      console.log("Nothing to decide — no distributor's territory column disagrees with our mapping.");
      return;
    }

    const workbook = buildWorkbook(rows, agreed, window);
    const outputPath = nextFreePath();
    mkdirSync(dirname(outputPath), { recursive: true });
    await workbook.xlsx.writeFile(outputPath);

    console.log(`Wrote ${outputPath}`);
    reportCounts(rows, agreed, window);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
