/**
 * Which Delta area does this customer belong to — the owner's decision sheet.
 *
 * WHY THIS EXISTS. The Gharbia 1 / Gharbia 2 sweep on 2026-09-10 found 270 customers counted in the
 * wrong one of the two, and the owner ruled every one of them a reversal. This is the same check
 * widened to all 13 Delta areas across regions D1 and D2.
 *
 * HOW A CANDIDATE IS FOUND, and why it is not the Gharbia script's curated town list. Thirteen areas
 * carry 202 bricks between them, so the town list is DERIVED from the brick names themselves rather
 * than hand-written:
 *
 *   1. Arabic is normalised first — أ إ آ -> ا, ى -> ي, ة -> ه — because the same town is spelled
 *      differently by every distributor and a raw comparison silently misses most of them.
 *   2. A brick name is usable only if it is at least 5 characters and belongs to exactly ONE Delta
 *      area. 27 names are too short to be safe and are dropped; 0 are ambiguous today, but the rule
 *      stays because a future brick can make one so.
 *   3. A customer is flagged only when its address names towns from EXACTLY ONE area and that area
 *      is not the one it is counted in. An address naming its own area's town as well is NOT
 *      flagged, which deliberately errs towards saying nothing.
 *
 * THIS IS NOISIER THAN THE GHARBIA SHEET AND IS MEANT TO BE. A derived list cannot know that a
 * street in one town is named after another, so some rows will be correct as they stand. That is
 * what the dropdown is for.
 *
 * WHY IT IS A QUESTION AND NOT A FIX. Standing owner rule: territory is not geography. An area is
 * who serves the customer, not where the building is. This script FINDS and ASKS; it re-maps only
 * what the owner answered. AGENTS.md §4: one row per item, the context that makes the call easy, a
 * locked list of valid answers, and a free-text Note column.
 *
 * READ-ONLY by default. `--apply <answers.xlsx>` writes to `public.source_of_sales_customer_map`
 * after taking a pre-image in a dated backup schema; `--dry-run` shows the plan without writing.
 *
 * Run:  node --experimental-strip-types --experimental-specifier-resolution=node \
 *         scripts/delta-area-questions.ts
 *
 * NO IMAGES AND NO OUTLINE GROUPS, deliberately — ExcelJS writes two schema-invalid OOXML fragments
 * that make Excel silently "repair" the workbook. Data validation is added ONCE PER CONTIGUOUS
 * BLOCK, never per cell.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";
import postgres from "postgres";

const HEADER_FILL = "FF0F172A";
const ACCENT_FILL = "FF0A6BA6";
const ANSWER_FILL = "FFEFF6FF";
const ALERT_FILL = "FFFFF1F2";

/**
 * ONE list for every row, whatever the pair. A dropdown naming all 13 areas would make him pick the
 * target again on every line when column H already says it; "Move it" plus an escape hatch keeps
 * the answer to one click.
 */
const MOVE_OPTIONS =
  '"Move it — the address is right,Leave it where it is,Not sure — I need to check,Other — see my note"';
const MOVE_ANSWER = "Move it — the address is right";

/** Region prefix -> what to call it on the page and in the file name. */
const SCOPE_LABELS: Record<string, [string, string]> = {
  "D%": ["Delta", "delta"],
  "UE%": ["Upper Egypt", "upper-egypt"],
  "GZ%": ["Giza", "giza"],
  "CA%": ["Cairo", "cairo"],
  "AB%": ["Alexandria", "alexandria"],
  "OT%": ["Others", "others"],
  "%": ["All regions", "all-regions"],
};
function scopeLabel(scope: string): [string, string] {
  return SCOPE_LABELS[scope] ?? [scope.replace(/%$/, ""), scope.replace(/%$/, "").toLowerCase()];
}
/** One sheet name for every scope. The old Delta-specific name is still accepted on --apply. */
const ANSWER_SHEET = "Customers";

/** Jun-Aug EGP above which a row is worth a deliberate look whatever the address says. */
const BIG_MONEY = 50000;

/**
 * MY RECOMMENDATION, and what it is allowed to say.
 *
 * The first two rules both answer "Check this one", and they exist because the cost of being wrong
 * is not spread evenly across the rows:
 *
 *   - A row the owner has ALREADY RULED ON carries his decision in `source`. Recommending "Move it"
 *     there is asking him to overturn himself without saying so, and several of these rulings are
 *     about this exact question — `owner-ruling-qena-markaz-address`, `owner-ruling-sohag-city-vs-markaz`.
 *     Territory is not geography, so his ruling outranks the address every time.
 *   - A row carrying real money moves more between two reps than the rest of a sheet combined. One
 *     wholesaler in the Upper Egypt file is 82% of the whole region's exposure.
 *
 * Everything after that is ordinary evidence, strongest first: the customer's own NAME agreeing or
 * disagreeing with the address, then whether the address names the town at district level ("مركز X"
 * or the town first) rather than in passing.
 */
function recommend(row: Row, recentValue: number): [string, string] {
  const source = row.source ?? "";
  const town = row.matched_town ?? "the other area";
  const target = row.named_area_name ?? row.named_area;
  if (/^owner-|^final-new-3-ruling/.test(source)) {
    return ["Check this one", `You ruled this row before (${source}). Your ruling beats the address.`];
  }
  // `sheet-verified` MEANS THE OWNER'S OWN SHEET PUT IT THERE. On 2026-09-08 he listed five
  // pharmacies as mis-mapped, this same address-versus-brick method moved all five, and every one of
  // them was already correct — two of the five carried this source. That sweep's production changes
  // had to be reverted in full. So the source is treated as his ruling, not as a mapping to fix.
  if (source === "sheet-verified") {
    return ["Check this one", `Your own sheet put it here (sheet-verified), so the address may well be beside the point.`];
  }
  if (recentValue >= BIG_MONEY) {
    return ["Check this one", `Large amount. Moving it shifts real money between two reps.`];
  }
  if (row.name_says_own) {
    return ["Leave it where it is", `The customer's own name names the area it is already in.`];
  }
  if (row.name_says_target) {
    return ["Move it", `Both the name and the address say ${town}.`];
  }
  if (row.addr_is_district) {
    return ["Move it", `The address is district-level: ${town}, which is in ${target}.`];
  }
  // A ONE-WORD TOWN MENTIONED IN PASSING IS THE WEAKEST EVIDENCE THERE IS, and it is where this
  // finder goes wrong: "مجمع الفتح الاسلامي" is a building, not the town الفتح. Multi-word names
  // (نجع حمادى, اولاد الياس) do not collide with ordinary Arabic this way, and a district-level
  // mention above is safe whatever the name. So only this case is softened, and it says why.
  if (!town.trim().includes(" ")) {
    return [
      "Move it, less certain",
      `The address mentions ${town} in passing, not as a district, and it is a single word that can `
        + `also be part of a building or street name. Worth a glance.`,
    ];
  }
  return ["Move it", `The address names ${town}, which is in ${target}.`];
}
const LEGACY_ANSWER_SHEET = "Delta customers";

type SheetWithValidations = ExcelJS.Worksheet & {
  dataValidations: { add: (range: string, rule: ExcelJS.DataValidation) => void };
};

type Row = {
  id: string;
  customer_code: string;
  customer_name: string | null;
  distributor_code: string | null;
  address: string | null;
  source: string | null;
  own_area: string;
  own_area_name: string | null;
  own_brick: string | null;
  own_brick_name: string | null;
  named_area: string;
  named_area_name: string | null;
  named_region: string | null;
  matched_town: string | null;
  target_brick: string | null;
  name_says_target: boolean;
  name_says_own: boolean;
  addr_is_district: boolean;
  value_3m: string | null;
  value_all: string | null;
  last_period: string | null;
};

function loadLocalEnv(path = ".env.local") {
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
function money(value: string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

const FINDER_SQL = `
with areas as (
  select area_code, area_name, region_code
  from public.source_of_sales_areas
  where active and region_code like $1
),
brick_norm as (
  select b.brick_id, b.area_code, b.brick_name,
         btrim(regexp_replace(regexp_replace(
           translate(b.brick_name,'أإآىةئؤ','ااايهيو'),'[^ء-ي0-9 ]',' ','g'),'\\s+',' ','g')) as nm
  from public.source_of_sales_bricks b
  join areas a on a.area_code = b.area_code
  where b.active
),
usable as (
  -- one row per usable town name: at least 5 characters, belonging to exactly one Delta area
  select nm, min(area_code) as area_code, min(brick_id) as brick_id, min(brick_name) as brick_name
  from brick_norm
  where length(nm) >= 5
  group by nm
  having count(distinct area_code) = 1
),
cust as (
  select m.id, m.area_code, m.customer_code, m.customer_name, m.distributor_code, m.address,
         m.brick_id, m.source,
         btrim(regexp_replace(regexp_replace(
           translate(m.address,'أإآىةئؤ','ااايهيو'),'[^ء-ي0-9 ]',' ','g'),'\\s+',' ','g')) as addr,
         btrim(regexp_replace(regexp_replace(
           translate(coalesce(m.customer_name,''),'أإآىةئؤ','ااايهيو'),'[^ء-ي0-9 ]',' ','g'),'\\s+',' ','g')) as name_norm
  from public.source_of_sales_customer_map m
  join areas a on a.area_code = m.area_code
  where m.active and m.address is not null and btrim(m.address) <> ''
),
-- SELF-MATCH USES A LOOSER BAR THAN THE POSITIVE MATCH, deliberately. A name under 5 characters is
-- too weak to accuse another area with, but it is plenty to EXCUSE a row: "دمرو مركز المحلة الكبرى"
-- sits on the دمرو brick in Kafr El-Sheikh and names its own town first, yet دمرو is 4 characters,
-- so a single shared threshold made that row read as a Mahalla customer filed in the wrong area.
-- Excusing is the safe direction, so it gets the lower bar.
own_hit as (
  select distinct c.id
  from cust c
  join brick_norm b on b.area_code = c.area_code and length(b.nm) >= 4 and position(b.nm in c.addr) > 0
),
hits as (
  select c.id, c.area_code as own_area, u.area_code as named_area,
         min(u.brick_id) as target_brick, min(u.brick_name) as matched_town, min(u.nm) as matched_nm
  from cust c
  join usable u on position(u.nm in c.addr) > 0
  where not exists (select 1 from own_hit o where o.id = c.id)
  group by c.id, c.area_code, u.area_code
),
verdict as (
  select id, own_area, count(*) as areas_named,
         min(named_area) as named_area,
         min(target_brick) as target_brick,
         min(matched_town) as matched_town,
         min(matched_nm) as matched_nm
  from hits group by id, own_area
),
sales as (
  select distributor_code, client_code,
         sum(value) as value_all,
         sum(value) filter (where invoice_period between '2026-06' and '2026-08') as value_3m,
         max(invoice_period) as last_period
  from public.source_of_sales_import_rows group by distributor_code, client_code
)
select c.id::text as id, c.customer_code, c.customer_name, c.distributor_code, c.address, c.source,
       c.area_code as own_area, own_a.area_name as own_area_name,
       c.brick_id as own_brick, own_b.brick_name as own_brick_name,
       v.named_area, new_a.area_name as named_area_name, new_a.region_code as named_region,
       v.matched_town, v.target_brick,
       (position(v.matched_nm in c.name_norm) > 0) as name_says_target,
       exists (select 1 from brick_norm b
                where b.area_code = c.area_code and length(b.nm) >= 4
                  and position(b.nm in c.name_norm) > 0) as name_says_own,
       (c.addr like v.matched_nm || '%' or position('مركز ' || v.matched_nm in c.addr) > 0) as addr_is_district,
       s.value_all::text as value_all, s.value_3m::text as value_3m, s.last_period
from verdict v
join cust c on c.id = v.id
join areas own_a on own_a.area_code = c.area_code
join areas new_a on new_a.area_code = v.named_area
left join public.source_of_sales_bricks own_b on own_b.brick_id = c.brick_id
left join sales s on s.client_code = c.customer_code and s.distributor_code = c.distributor_code
where v.areas_named = 1 and v.named_area <> c.area_code
order by c.area_code, v.named_area, coalesce(s.value_3m,0) desc, coalesce(s.value_all,0) desc
`;

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
  sheet.getRow(2).height = 48;
}

const COLUMNS = 16;

function buildAnswerSheet(workbook: ExcelJS.Workbook, rows: Row[], label: string): void {
  const sheet = workbook.addWorksheet(ANSWER_SHEET);
  sheet.columns = [
    { width: 30 }, { width: 14 }, { width: 10 }, { width: 42 }, { width: 18 },
    { width: 22 }, { width: 18 }, { width: 22 }, { width: 14 }, { width: 14 },
    { width: 11 }, { width: 24 }, { width: 20 }, { width: 52 },
    { width: 30 }, { width: 34 },
  ];

  addTitle(
    sheet,
    COLUMNS,
    `Which ${label} area does this customer belong to? — ${rows.length} to decide`,
    "Column M is your answer, and it is the same four choices on every row: the area the address "
      + "points at is already written in column H. Leave a row blank and nothing changes. Filter on "
      + "columns E and H to answer a whole pair at once.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    "Customer", "Customer code", "Dist.", "Address as recorded", "Counted in now",
    "Brick now", "Town in the address", "The address suggests", "Sales Jun–Aug (EGP)",
    "Sales all time (EGP)", "Last month", "How it was mapped", "My recommendation", "Why",
    "Move it?", "Note",
  ];
  styleHeader(sheet, headerRow, COLUMNS);

  rows.forEach((row, index) => {
    const excelRow = sheet.getRow(headerRow + 1 + index);
    const recent = money(row.value_3m);
    const [verdict, why] = recommend(row, recent);
    excelRow.values = [
      row.customer_name ?? "", row.customer_code, row.distributor_code ?? "", row.address ?? "",
      row.own_area_name ?? row.own_area, row.own_brick_name ?? row.own_brick ?? "",
      row.matched_town ?? "", row.named_area_name ?? row.named_area,
      recent, money(row.value_all), row.last_period ?? "never", row.source ?? "",
      verdict, why, "", "",
    ];
    excelRow.alignment = { vertical: "top", wrapText: true };
    excelRow.height = 30;
    excelRow.getCell(9).numFmt = "#,##0";
    excelRow.getCell(10).numFmt = "#,##0";
    if (recent > 0) {
      excelRow.getCell(9).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ALERT_FILL } };
      excelRow.getCell(9).font = { bold: true };
    }
    excelRow.getCell(13).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
    excelRow.getCell(14).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
  });

  const lastRow = headerRow + rows.length;
  if (rows.length > 0) {
    // ONE rule over the whole answer column — never one per cell (overlapping sqref = repair prompt).
    (sheet as SheetWithValidations).dataValidations.add(`O${headerRow + 1}:O${lastRow}`, {
      type: "list",
      allowBlank: true,
      formulae: [MOVE_OPTIONS],
      showErrorMessage: true,
      errorTitle: "Pick one, or choose Other",
      error: "Choose from the list, or pick 'Other — see my note' and name the area in the Note column.",
    });
  }
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: headerRow }];
  sheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: Math.max(lastRow, headerRow), column: COLUMNS },
  };
}

function buildPairSheet(workbook: ExcelJS.Workbook, rows: Row[]): void {
  const sheet = workbook.addWorksheet("By pair", { properties: { tabColor: { argb: ACCENT_FILL } } });
  sheet.columns = [{ width: 26 }, { width: 26 }, { width: 12 }, { width: 18 }, { width: 18 }];

  addTitle(
    sheet,
    5,
    "Where the crossings are",
    "Every pair of Delta areas with at least one customer whose address points at the other. "
      + "Biggest first. Use it to decide which pairs are worth your time before answering.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    "Counted in now", "The address suggests", "Customers", "Sales Jun–Aug (EGP)", "Sales all time (EGP)",
  ];
  styleHeader(sheet, headerRow, 5);

  const pairs = new Map<string, { from: string; to: string; count: number; v3: number; vall: number }>();
  for (const row of rows) {
    const key = `${row.own_area}>${row.named_area}`;
    const entry = pairs.get(key) ?? {
      from: row.own_area_name ?? row.own_area,
      to: row.named_area_name ?? row.named_area,
      count: 0, v3: 0, vall: 0,
    };
    entry.count += 1;
    entry.v3 += money(row.value_3m);
    entry.vall += money(row.value_all);
    pairs.set(key, entry);
  }

  [...pairs.values()]
    .sort((a, b) => b.count - a.count)
    .forEach((pair, index) => {
      const row = sheet.getRow(headerRow + 1 + index);
      row.values = [pair.from, pair.to, pair.count, pair.v3, pair.vall];
      row.getCell(4).numFmt = "#,##0";
      row.getCell(5).numFmt = "#,##0";
    });
}

function buildReadMe(workbook: ExcelJS.Workbook, rows: Row[], label: string): void {
  const sheet = workbook.addWorksheet("Read me", { properties: { tabColor: { argb: ACCENT_FILL } } });
  sheet.columns = [{ width: 34 }, { width: 112 }];

  addTitle(
    sheet,
    2,
    `Which ${label} area does this customer belong to?`,
    `One row per customer whose address points at a different ${label} area from the one it is counted `
      + `in. Answer in column M on the ${ANSWER_SHEET} sheet. Nothing has been changed in the system.`,
  );

  const total3m = rows.reduce((sum, row) => sum + money(row.value_3m), 0);
  const totalAll = rows.reduce((sum, row) => sum + money(row.value_all), 0);
  const areas = new Set(rows.map((row) => row.own_area)).size;

  const lines: Array<[string, string]> = [
    ["What this is", `The Gharbia customer-mapping check you answered, run across every ${label} area.`],
    ["What it found", `${rows.length} customers across ${areas} areas, carrying `
      + `${total3m.toLocaleString("en-US")} EGP of June to August sales and `
      + `${totalAll.toLocaleString("en-US")} EGP all time.`],
    ["How a row got here", `The town names come from the areas' own brick names, not from a list I wrote. Arabic `
      + `spelling is normalised first, because every distributor spells the same town differently. A name is used `
      + `only if it is at least 5 characters and belongs to exactly one ${label} area.`],
    ["When a row is NOT flagged", "If the address also names a town in the area it is already counted in, it is "
      + "left alone. The check deliberately says nothing rather than guess."],
    ["Expect some false alarms", "This list is noisier than the Gharbia one, because a derived town list cannot "
      + "know that a street in one town is named after another. That is what 'Leave it where it is' is for."],
    ["How to answer", "Column M is the same four choices on every row. The area the address points at is already "
      + "in column H, so you never have to type an area. Filter columns E and H to answer a whole pair at once."],
    ["The By pair sheet", "Shows which pairs of areas cross into each other, biggest first, so you can see where "
      + "the real problem is before reading every row."],
    ["What happens next", "Send the file back and I move only the rows you marked 'Move it', after taking a "
      + "pre-image, then refresh the rollups."],
    ["What it will NOT touch", "Months that are locked keep their published numbers. Today that is July on all "
      + "three lines and August on Anti Infective and Pedia."],
  ];

  let rowNumber = 4;
  for (const [label, text] of lines) {
    const row = sheet.getRow(rowNumber);
    row.values = [label, text];
    row.getCell(1).font = { bold: true, color: { argb: "FF0F172A" } };
    row.getCell(1).alignment = { vertical: "top", wrapText: true };
    row.getCell(2).alignment = { vertical: "top", wrapText: true };
    row.height = Math.max(30, Math.ceil(text.length / 95) * 16 + 14);
    rowNumber += 1;
  }
}

function nextFreePath(slug: string): string {
  // Africa/Cairo, never `toISOString()`.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const base = resolve("xlsx", `${slug}-area-decisions-${today}`);
  const first = `${base}.xlsx`;
  if (!existsSync(first)) return first;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}.xlsx`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Too many area-decision workbooks written today — clear xlsx/ before rerunning.");
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (Array.isArray(record.richText)) {
      return (record.richText as Array<{ text: string }>).map((part) => part.text).join("");
    }
    if (record.result != null) return String(record.result);
  }
  return String(value);
}

async function runApply(sql: postgres.Sql, answerPath: string, dryRun: boolean, scope: string, slug: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(answerPath);
  const sheet = workbook.getWorksheet(ANSWER_SHEET) ?? workbook.getWorksheet(LEGACY_ANSWER_SHEET);
  if (!sheet) throw new Error(`The workbook has no '${ANSWER_SHEET}' sheet.`);

  // FIND THE ANSWER COLUMN BY ITS HEADER, never by a fixed index. Adding the recommendation column
  // moved it from M to O, and a sheet answered before that change is still a valid answer sheet.
  const headerRow = sheet.getRow(4);
  let answerColumn = 0;
  for (let column = 1; column <= 24; column += 1) {
    if (cellText(headerRow.getCell(column).value).trim() === "Move it?") { answerColumn = column; break; }
  }
  if (!answerColumn) throw new Error("The workbook has no 'Move it?' column.");

  const wanted = new Set<string>();
  const otherAnswers = new Map<string, number>();
  for (let rowNumber = 5; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const code = cellText(row.getCell(2).value).trim();
    const dist = cellText(row.getCell(3).value).trim();
    const area = cellText(row.getCell(5).value).trim();
    const answer = cellText(row.getCell(answerColumn).value).trim();
    if (!code || !answer) continue;
    if (answer === MOVE_ANSWER) wanted.add(`${area}|${code}|${dist}`);
    else otherAnswers.set(answer, (otherAnswers.get(answer) ?? 0) + 1);
  }
  for (const [answer, count] of otherAnswers) {
    console.log(`  ${count} rows answered "${answer}" — left exactly as they are.`);
  }
  console.log(`Read ${wanted.size} rows marked to move.`);
  if (wanted.size === 0) {
    console.log("Nothing to apply.");
    return;
  }

  // Live re-run — the sheet records a question, never current state.
  const live = (await sql.unsafe(FINDER_SQL, [scope])) as unknown as Row[];
  const planned: Row[] = [];
  const seen = new Set<string>();
  for (const row of live) {
    const key = `${row.own_area_name ?? row.own_area}|${row.customer_code}|${row.distributor_code ?? ""}`;
    if (!wanted.has(key) || seen.has(key)) continue;
    if (!row.target_brick) continue;
    seen.add(key);
    planned.push(row);
  }
  const missing = wanted.size - planned.length;
  console.log(`  ${planned.length} map rows will move.`);
  if (missing > 0) console.log(`  ${missing} answered rows no longer match a live row and are SKIPPED.`);
  if (dryRun) {
    console.log("DRY RUN — nothing written.");
    return;
  }

  const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date()).replace(/-/g, "");
  const schema = `sos_backup_${stamp}`;
  const table = `${schema}.customer_map_${slug.replace(/-/g, "_")}_pre`;
  const ids = planned.map((row) => row.id);
  const areasTo = planned.map((row) => row.named_area);
  const bricksTo = planned.map((row) => row.target_brick as string);
  const regionsTo = planned.map((row) => row.named_region ?? "");

  const result = await sql.begin(async (tx) => {
    await tx.unsafe(`create schema if not exists ${schema}`);
    await tx.unsafe(`drop table if exists ${table}`);
    await tx.unsafe(`
      create table ${table} as
      select m.*, now() as captured_at
      from public.source_of_sales_customer_map m
      where m.id = any($1::bigint[])
    `, [ids]);

    const updated = await tx.unsafe(`
      update public.source_of_sales_customer_map m
      set area_code = p.area_to,
          brick_id = p.brick_to,
          region_code = p.region_to,
          source = 'owner-sheet-${slug}-${stamp}',
          updated_at = now()
      from unnest($1::bigint[], $2::text[], $3::text[], $4::text[]) as p(id, area_to, brick_to, region_to)
      where m.id = p.id and m.active
      returning m.id
    `, [ids, areasTo, bricksTo, regionsTo]);

    const preimage = await tx.unsafe(`select count(*)::int as n from ${table}`);
    return {
      updated: (updated as unknown as Array<{ id: string }>).length,
      preimage: (preimage as unknown as Array<{ n: number }>)[0].n,
    };
  });

  console.log(`  Pre-image rows captured in ${table}: ${result.preimage}`);
  console.log(`  Map rows updated: ${result.updated}`);
  const remaining = (await sql.unsafe(FINDER_SQL, [scope])) as unknown as Row[];
  console.log(`  Finder now returns ${remaining.length} flagged rows (was ${live.length}).`);
  console.log(`  To reverse: update public.source_of_sales_customer_map m set area_code = p.area_code,`);
  console.log(`    brick_id = p.brick_id, region_code = p.region_code, source = p.source`);
  console.log(`    from ${table} p where p.id = m.id;`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const applyIndex = args.indexOf("--apply");
  const answerPath = applyIndex >= 0 ? args[applyIndex + 1] : undefined;
  const dryRun = args.includes("--dry-run");
  // '--all-regions' widens the sweep past Delta to every active area in the country.
  // --scope <pattern> runs one region at a time (e.g. "CA%"); --all-regions is every area at once,
  // which on 58k addressed customers against ~700 town names exceeds the server statement timeout.
  const scopeIndex = args.indexOf("--scope");
  const scope = scopeIndex >= 0 ? String(args[scopeIndex + 1] ?? "D%") : args.includes("--all-regions") ? "%" : "D%";
  const countOnly = args.includes("--count-only");
  const [label, slug] = scopeLabel(scope);

  const env = loadLocalEnv();
  const databaseUrl = env.SUPABASE_DB_URL;
  if (!databaseUrl) throw new Error("SUPABASE_DB_URL is missing from .env.local.");
  const sql = postgres(databaseUrl, {
    connect_timeout: 20,
    max: 1,
    ssl: "require",
    connection: { statement_timeout: "600000" },
  });

  try {
    if (answerPath) {
      await runApply(sql, answerPath, dryRun, scope, slug);
      return;
    }

    const rows = (await sql.unsafe(FINDER_SQL, [scope])) as unknown as Row[];
    if (countOnly) {
      const byRegion = new Map<string, { n: number; v: number }>();
      for (const row of rows) {
        const key = (row.named_region ?? "?").slice(0, 1);
        const entry = byRegion.get(key) ?? { n: 0, v: 0 };
        entry.n += 1; entry.v += money(row.value_3m);
        byRegion.set(key, entry);
      }
      console.log(`scope=${scope} flagged=${rows.length}`);
      for (const [key, entry] of [...byRegion].sort((a, b) => b[1].n - a[1].n)) {
        console.log(`   region ${key}: ${entry.n} customers, ${entry.v.toLocaleString("en-US")} EGP Jun-Aug`);
      }
      return;
    }
    if (rows.length === 0) {
      console.log(`Nothing to decide — no ${label} customer's address points at another ${label} area.`);
      return;
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Phoenix Workforce — Delta area decisions";
    workbook.created = new Date();

    buildReadMe(workbook, rows, label);
    buildPairSheet(workbook, rows);
    buildAnswerSheet(workbook, rows, label);

    const outputPath = nextFreePath(slug);
    mkdirSync(dirname(outputPath), { recursive: true });
    await workbook.xlsx.writeFile(outputPath);

    const areas = new Set(rows.map((row) => row.own_area)).size;
    console.log(`Wrote ${outputPath}`);
    console.log(`  ${rows.length} customers across ${areas} ${label} areas`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
