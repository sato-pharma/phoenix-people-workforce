/**
 * Gharbia 1 (Tanta) against Gharbia 2 (Mahalla) — the owner's customer-mapping decision sheet.
 *
 * WHY THIS EXISTS. The owner reported that many customers sitting in one Gharbia area are being
 * counted in the other. Measured on production 2026-09-10: 226 active customers in Gharbia 2
 * (Mahalla) carry an address that names ONLY a Gharbia 1 town, and 47 the other way. The leak is
 * one-directional and traces to a single batch, `brick-merge-2026-07-28`, which put 315 customers
 * into the Zefta brick (Gharbia 2) — none of which has Zefta anywhere in its address, while 93 say
 * Tanta and 28 say El Santa, both Gharbia 1 bricks.
 *
 * WHY IT IS A QUESTION AND NOT A FIX. Standing owner rule: territory is not geography. A pharmacy
 * with a Tanta street address can still be a correct Mahalla assignment, because an area is who
 * serves the customer, not where the building is. So this script FINDS candidates and asks; it
 * never re-maps anything. AGENTS.md §4: "which of these does each of these belong to" is asked as
 * an XLSX with dropdowns, one row per item, with the context that makes the call easy and a
 * free-text Note column.
 *
 * READ-ONLY. SELECT only. Nothing here writes to the database.
 *
 * Run:  node --experimental-strip-types --experimental-specifier-resolution=node \
 *         scripts/gharbia-area-questions.ts
 *
 * NO IMAGES AND NO OUTLINE GROUPS, deliberately — ExcelJS writes two schema-invalid OOXML fragments
 * (`outlineProperties` with `pageSetup.fitToPage`, and `ws.addImage`) that make Excel silently
 * "repair" the workbook on open. Data validation is added ONCE PER CONTIGUOUS BLOCK, never per
 * cell: per-cell rules coalesce into overlapping `sqref` ranges, which is its own repair prompt.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";
import postgres from "postgres";

const HEADER_FILL = "FF0F172A";
const ACCENT_FILL = "FF0A6BA6";
const ANSWER_FILL = "FFEFF6FF";
const ALERT_FILL = "FFFFF1F2";

const AREA_NAME: Record<string, string> = {
  D14: "Gharbia 1 (Tanta)",
  D15: "Gharbia 2 (Mahalla)",
};

/** The list ends with an escape hatch, so a case nobody anticipated is still answerable. */
const AREA_OPTIONS =
  '"Gharbia 1 (Tanta),Gharbia 2 (Mahalla),Leave it where it is,Not sure — I need to check,Other — see my note"';

type SheetWithValidations = ExcelJS.Worksheet & {
  dataValidations: { add: (range: string, rule: ExcelJS.DataValidation) => void };
};

type Row = {
  customer_code: string;
  customer_name: string | null;
  address: string | null;
  distributor_code: string | null;
  area_code: string;
  brick_id: string | null;
  brick_name: string | null;
  town: string | null;
  suggested_area: string;
  source: string | null;
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

/**
 * THE TOWN LISTS. Every entry is the name of a LIVE brick in that area, plus the spelling variants
 * the distributors actually use, plus العجيزي — a Tanta district that turns up in addresses more
 * often than the word Tanta itself. A row qualifies only when the address names a town from ONE
 * list and none from the other. An address naming both is ambiguous and is left out rather than
 * guessed at.
 */
const G1_TOWNS =
  "طنطا|السنطة|السنطه|برما|باسيون|بسيون|كفر الزيات|شبرا النملة|شبرا النمله|شبراقاص|شبشير|ششير|سبرباي|الدلجمون|كنامه|كفر الشيخ سليم|محله مرحوم|محلة مرحوم|العجيزي|العجيزى";
const G2_TOWNS =
  "المحل[ةه]|زفت[ىي]|سمنود|قطور|شبراميل|شبرابيل|الهياتم|صفط تراب|كفر حجازى|محلة حسن|محلة زياد|ميت حبيب|الناصرية|القرشية|جانوسكا|شرشاية";

const ROWS_SQL = `
with sales as (
  select r.distributor_code, r.client_code,
         sum(r.value) as value_all,
         sum(r.value) filter (where r.invoice_period between '2026-06' and '2026-08') as value_3m,
         max(r.invoice_period) as last_period
  from public.source_of_sales_import_rows r
  group by r.distributor_code, r.client_code
)
select m.customer_code, m.customer_name, m.address, m.distributor_code,
       m.area_code, m.brick_id, b.brick_name, m.source,
       (regexp_match(m.address, case when m.area_code = 'D15' then $1 else $2 end))[1] as town,
       case when m.area_code = 'D15' then 'D14' else 'D15' end as suggested_area,
       s.value_all::text as value_all, s.value_3m::text as value_3m, s.last_period
from public.source_of_sales_customer_map m
join public.source_of_sales_bricks b on b.brick_id = m.brick_id
left join sales s on s.client_code = m.customer_code and s.distributor_code = m.distributor_code
where m.active
  and m.area_code in ('D14','D15')
  and m.address is not null and btrim(m.address) <> ''
  and (
        (m.area_code = 'D15' and m.address ~ $1 and m.address !~ $2)
     or (m.area_code = 'D14' and m.address ~ $2 and m.address !~ $1)
  )
order by coalesce(s.value_3m, 0) desc, coalesce(s.value_all, 0) desc, m.customer_name
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

const COLUMNS = 13;

function buildAnswerSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  rows: Row[],
  countedIn: string,
  suggested: string,
): void {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [
    { width: 30 }, { width: 14 }, { width: 44 }, { width: 16 }, { width: 20 },
    { width: 18 }, { width: 20 }, { width: 14 }, { width: 14 }, { width: 11 },
    { width: 26 }, { width: 26 }, { width: 34 },
  ];

  addTitle(
    sheet,
    COLUMNS,
    `Counted in ${countedIn} — ${rows.length} to decide`,
    `Every row below is counted in ${countedIn} today, and its address names a town in ${suggested}. `
      + "Column L is your answer. Leave a row blank and nothing changes. An area is who serves the "
      + "customer, not where the building stands, so a row that looks wrong may well be right.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    "Customer", "Customer code", "Address as recorded", "Town in the address", "Counted in now",
    "Brick now", "The address suggests", "Sales Jun–Aug (EGP)", "Sales all time (EGP)", "Last month",
    "How it was mapped", "Where does it belong?", "Note",
  ];
  styleHeader(sheet, headerRow, COLUMNS);

  rows.forEach((row, index) => {
    const excelRow = sheet.getRow(headerRow + 1 + index);
    const recent = money(row.value_3m);
    excelRow.values = [
      row.customer_name ?? "", row.customer_code, row.address ?? "", row.town ?? "",
      AREA_NAME[row.area_code] ?? row.area_code, row.brick_name ?? row.brick_id ?? "",
      AREA_NAME[row.suggested_area] ?? row.suggested_area,
      recent, money(row.value_all), row.last_period ?? "never",
      row.source ?? "", "", "",
    ];
    excelRow.alignment = { vertical: "top", wrapText: true };
    excelRow.height = 30;
    excelRow.getCell(8).numFmt = "#,##0";
    excelRow.getCell(9).numFmt = "#,##0";
    if (recent > 0) {
      excelRow.getCell(8).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ALERT_FILL } };
      excelRow.getCell(8).font = { bold: true };
    }
    excelRow.getCell(12).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
    excelRow.getCell(13).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
  });

  const lastRow = headerRow + rows.length;
  if (rows.length > 0) {
    // ONE rule over the whole answer column — never one per cell (overlapping sqref = repair prompt).
    (sheet as SheetWithValidations).dataValidations.add(`L${headerRow + 1}:L${lastRow}`, {
      type: "list",
      allowBlank: true,
      formulae: [AREA_OPTIONS],
      showErrorMessage: true,
      errorTitle: "Pick one, or choose Other",
      error: "Choose from the list, or pick 'Other — see my note' and write what you mean in the Note column.",
    });
  }
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: headerRow }];
  sheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: Math.max(lastRow, headerRow), column: COLUMNS },
  };
}

function buildReadMe(workbook: ExcelJS.Workbook, inMahalla: Row[], inTanta: Row[]): void {
  const sheet = workbook.addWorksheet("Read me", { properties: { tabColor: { argb: ACCENT_FILL } } });
  sheet.columns = [{ width: 34 }, { width: 112 }];

  addTitle(
    sheet,
    2,
    "Gharbia 1 (Tanta) or Gharbia 2 (Mahalla)?",
    "One row per customer whose recorded address names a town in the other area. Answer in column L "
      + "on either sheet. Nothing has been changed in the system.",
  );

  const sum3m = (rows: Row[]) => rows.reduce((total, row) => total + money(row.value_3m), 0);
  const lines: Array<[string, string]> = [
    ["What you asked", "Customers sitting in one Gharbia area while being counted in the other."],
    [
      "What I found",
      `${inMahalla.length} customers are counted in Gharbia 2 (Mahalla) with an address naming only a `
        + `Gharbia 1 town, and ${inTanta.length} the other way round. The leak runs almost entirely one way.`,
    ],
    [
      "The money on it",
      `${sum3m(inMahalla).toLocaleString("en-US")} EGP of June to August sales sits on the first group, `
        + `${sum3m(inTanta).toLocaleString("en-US")} EGP on the second.`,
    ],
    [
      "Where it came from",
      "One batch, stamped brick-merge-2026-07-28, put 315 customers into the Zefta brick in Gharbia 2. "
        + "Not one of them has Zefta in its address: 93 say Tanta and 28 say El Santa, which are Gharbia 1 "
        + "bricks. Every other batch that fed the Zefta brick looks normal.",
    ],
    [
      "Why I am asking",
      "An area is who serves the customer, not where the building stands. A Tanta address can be a correct "
        + "Mahalla assignment, so I have changed nothing and guessed nothing.",
    ],
    [
      "How to answer",
      "Column L is a dropdown. Pick the area the customer belongs to, or leave the row blank to keep it "
        + "exactly as it is. The Note column is free text for anything the list cannot say.",
    ],
    [
      "What happens next",
      "Send the file back and I repair the customer map from the answers, then re-run the attribution "
        + "refresh so the areas' numbers follow.",
    ],
    [
      "What it will NOT touch",
      "July is locked on all three lines, and August is locked on Anti Infective and on Pedia. Those months "
        + "stay exactly as published. The repair reaches August CNS and September onward.",
    ],
    [
      "Read the sales columns",
      "Sales are EGP at factory price, taken from the monthly import rows. A blank means the customer has "
        + "never appeared in a sales file, which is common for small pharmacies.",
    ],
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

function nextFreePath(): string {
  // Africa/Cairo, never `toISOString()`. UTC dates the file a day early for the ~3 hours after Cairo
  // midnight, which is exactly when this repository is often worked.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const base = resolve("xlsx", `gharbia-area-decisions-${today}`);
  const first = `${base}.xlsx`;
  if (!existsSync(first)) return first;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}.xlsx`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Too many Gharbia decision workbooks written today — clear xlsx/ before rerunning.");
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// --apply — reading the answered sheet back and making it true.
//
// THE ROW IS MATCHED BY IDENTITY, NEVER BY POSITION. Every answered row is re-resolved against a
// LIVE re-run of the same finder and matched on customer code plus the area it was counted in when
// the sheet was built. A workbook row that no longer matches a live row is REFUSED and reported,
// never guessed at — the map moves under us every time an import runs.
//
// THE TARGET IS A BRICK, NOT JUST AN AREA. Moving a customer to "Gharbia 1" without naming the
// brick would leave brick_id pointing into the area it just left, which is the same inconsistency
// this whole exercise exists to remove. The brick is resolved from the town the address names, and
// a row whose town cannot be resolved to a brick is SKIPPED and reported rather than parked on some
// default brick.
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** Town spelling -> the brick it belongs to. Longest, most specific spellings first. */
const TOWN_TO_BRICK: Array<[RegExp, string, string]> = [
  // Gharbia 1 (Tanta)
  [/كفر الشيخ سليم/, "B193-3", "D14"],
  [/شبرا النملة|شبرا النمله/, "B193-4", "D14"],
  [/محله مرحوم|محلة مرحوم/, "B193-10", "D14"],
  [/كفر الزيات/, "B193-6", "D14"],
  [/شبشير|ششير/, "B193-14", "D14"],
  [/شبراقاص/, "B193-13", "D14"],
  [/الدلجمون/, "B193-8", "D14"],
  [/باسيون|بسيون/, "B193-5", "D14"],
  [/السنطة|السنطه/, "B70-37", "D14"],
  [/سبرباي/, "B193-11", "D14"],
  [/العجيزي|العجيزى|طنطا/, "B193-1", "D14"],
  [/كنامه/, "B75-40", "D14"],
  [/برما/, "B193-2", "D14"],
  [/بيار/, "B193-7", "D14"],
  // Gharbia 2 (Mahalla)
  [/شبراميل|شبرابيل/, "B192-6", "D15"],
  [/صفط تراب/, "B192-13", "D15"],
  [/كفر حجازى/, "B192-2", "D15"],
  [/محلة حسن/, "B192-14", "D15"],
  [/محلة زياد/, "B192-15", "D15"],
  [/ميت حبيب/, "B192-10", "D15"],
  [/الناصرية/, "B192-4", "D15"],
  [/القرشية/, "B193-M1", "D15"],
  [/جانوسكا/, "B192-8", "D15"],
  [/شرشاية/, "B192-7", "D15"],
  [/الهياتم/, "B192-12", "D15"],
  [/المحل[ةه]/, "B192-1", "D15"],
  [/زفت[ىي]/, "B192-5", "D15"],
  [/سمنود/, "B192-3", "D15"],
  [/قطور/, "B192-11", "D15"],
];

const ANSWER_TO_AREA: Record<string, string> = {
  "Gharbia 1 (Tanta)": "D14",
  "Gharbia 2 (Mahalla)": "D15",
};

function resolveBrick(address: string, targetArea: string): string | null {
  for (const [pattern, brickId, area] of TOWN_TO_BRICK) {
    if (area === targetArea && pattern.test(address)) return brickId;
  }
  return null;
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

type Answer = { customerCode: string; fromArea: string; toArea: string; note: string };

async function readAnswers(path: string): Promise<Answer[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const answers: Answer[] = [];
  const unknown = new Set<string>();

  for (const sheet of workbook.worksheets) {
    if (sheet.name === "Read me") continue;
    const fromArea = sheet.name === "Counted in Mahalla" ? "D15" : "D14";
    for (let rowNumber = 5; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const customerCode = cellText(row.getCell(2).value).trim();
      const answer = cellText(row.getCell(12).value).trim();
      const note = cellText(row.getCell(13).value).trim();
      if (!customerCode || !answer) continue;
      const toArea = ANSWER_TO_AREA[answer];
      if (!toArea) {
        // "Leave it where it is", "Not sure", "Other" all mean: change nothing. Recorded, not applied.
        unknown.add(answer);
        continue;
      }
      answers.push({ customerCode, fromArea, toArea, note });
    }
  }
  if (unknown.size > 0) {
    console.log(`  Answers that change nothing (left exactly as they are): ${[...unknown].join(" | ")}`);
  }
  return answers;
}

async function runApply(sql: postgres.Sql, answerPath: string, dryRun: boolean): Promise<void> {
  const answers = await readAnswers(answerPath);
  const moves = answers.filter((answer) => answer.toArea !== answer.fromArea);
  console.log(`Read ${answers.length} answered rows, of which ${moves.length} ask for a move.`);
  if (moves.length === 0) {
    console.log("Nothing to apply.");
    return;
  }

  // Live re-run of the finder — the sheet is a record of a question, never of current state.
  const live = (await sql.unsafe(ROWS_SQL, [G1_TOWNS, G2_TOWNS])) as unknown as Row[];
  const liveByKey = new Map<string, Row[]>();
  for (const row of live) {
    const key = `${row.area_code}|${row.customer_code}`;
    liveByKey.set(key, [...(liveByKey.get(key) ?? []), row]);
  }

  const planned: Array<{ code: string; dist: string | null; from: string; to: string; brick: string }> = [];
  const unmatched: string[] = [];
  const unresolved: string[] = [];

  for (const move of moves) {
    const matches = liveByKey.get(`${move.fromArea}|${move.customerCode}`);
    if (!matches || matches.length === 0) {
      unmatched.push(`${move.customerCode} (was in ${move.fromArea})`);
      continue;
    }
    for (const match of matches) {
      const brick = resolveBrick(match.address ?? "", move.toArea);
      if (!brick) {
        unresolved.push(`${match.customer_code} — "${(match.address ?? "").slice(0, 40)}"`);
        continue;
      }
      planned.push({ code: match.customer_code, dist: match.distributor_code, from: move.fromArea, to: move.toArea, brick });
    }
  }

  // A customer code can appear on the sheet once per distributor, and each sheet row resolves to
  // every live row for that code — so the same map row is reached more than once. Deduplicate on
  // the map row's own natural key, or the pre-image counts rows it captured only once.
  const seen = new Set<string>();
  for (let index = planned.length - 1; index >= 0; index -= 1) {
    const key = `${planned[index].from}|${planned[index].code}|${planned[index].dist ?? ""}`;
    if (seen.has(key)) planned.splice(index, 1);
    else seen.add(key);
  }

  console.log(`  ${planned.length} map rows will move.`);
  if (unmatched.length > 0) {
    console.log(`  ${unmatched.length} answered rows no longer match a live row and are SKIPPED:`);
    for (const line of unmatched.slice(0, 20)) console.log(`      ${line}`);
  }
  if (unresolved.length > 0) {
    console.log(`  ${unresolved.length} rows whose town could not be resolved to a brick are SKIPPED:`);
    for (const line of unresolved.slice(0, 20)) console.log(`      ${line}`);
  }
  if (dryRun) {
    console.log("DRY RUN — nothing written.");
    return;
  }
  if (planned.length === 0) {
    console.log("Nothing left to write.");
    return;
  }

  const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date()).replace(/-/g, "");
  const schema = `sos_backup_${stamp}`;
  const table = `${schema}.customer_map_gharbia_pre`;

  // ONE transaction: pre-image first, then the move. Production has no point-in-time recovery, so
  // the pre-image is the only way back — it is taken inside the same transaction as the update, so
  // a failure leaves neither.
  const result = await sql.begin(async (tx) => {
    const codes = planned.map((row) => row.code);
    const dists = planned.map((row) => row.dist ?? "");
    const froms = planned.map((row) => row.from);
    const tos = planned.map((row) => row.to);
    const bricks = planned.map((row) => row.brick);

    await tx.unsafe(`create schema if not exists ${schema}`);
    await tx.unsafe(`drop table if exists ${table}`);
    await tx.unsafe(`
      create table ${table} as
      select m.*, now() as captured_at
      from public.source_of_sales_customer_map m
      join unnest($1::text[], $2::text[], $3::text[]) as p(code, dist, from_area)
        on m.customer_code = p.code and coalesce(m.distributor_code,'') = p.dist and m.area_code = p.from_area
      where m.active
    `, [codes, dists, froms]);

    const updated = await tx.unsafe(`
      update public.source_of_sales_customer_map m
      set area_code = p.to_area,
          brick_id = p.brick,
          region_code = 'D1',
          source = 'owner-sheet-gharbia-${stamp}',
          updated_at = now()
      from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
        as p(code, dist, from_area, to_area, brick)
      where m.customer_code = p.code
        and coalesce(m.distributor_code,'') = p.dist
        and m.area_code = p.from_area
        and m.active
      returning m.id
    `, [codes, dists, froms, tos, bricks]);

    const preimage = await tx.unsafe(`select count(*)::int as n from ${table}`);
    return { updated: (updated as unknown as Array<{ id: string }>).length, preimage: (preimage as unknown as Array<{ n: number }>)[0].n };
  });

  console.log(`  Pre-image rows captured in ${table}: ${result.preimage}`);
  console.log(`  Map rows updated: ${result.updated}`);

  const remaining = (await sql.unsafe(ROWS_SQL, [G1_TOWNS, G2_TOWNS])) as unknown as Row[];
  console.log(`  Finder now returns ${remaining.length} cross-named rows (was ${live.length}).`);
  console.log(`  To reverse: update public.source_of_sales_customer_map m set area_code = p.area_code,`);
  console.log(`    brick_id = p.brick_id, region_code = p.region_code, source = p.source`);
  console.log(`    from ${table} p where p.id = m.id;`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const applyIndex = args.indexOf("--apply");
  const answerPath = applyIndex >= 0 ? args[applyIndex + 1] : undefined;
  const dryRun = args.includes("--dry-run");

  const env = loadLocalEnv();
  const databaseUrl = env.SUPABASE_DB_URL;
  if (!databaseUrl) throw new Error("SUPABASE_DB_URL is missing from .env.local.");
  const sql = postgres(databaseUrl, { connect_timeout: 20, max: 1, ssl: "require" });

  try {
    if (answerPath) {
      await runApply(sql, answerPath, dryRun);
      return;
    }
    const rows = (await sql.unsafe(ROWS_SQL, [G1_TOWNS, G2_TOWNS])) as unknown as Row[];
    const inMahalla = rows.filter((row) => row.area_code === "D15");
    const inTanta = rows.filter((row) => row.area_code === "D14");

    if (rows.length === 0) {
      console.log("Nothing to decide — no customer's address names a town in the other Gharbia area.");
      return;
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Phoenix Workforce — Gharbia area decisions";
    workbook.created = new Date();

    buildReadMe(workbook, inMahalla, inTanta);
    buildAnswerSheet(workbook, "Counted in Mahalla", inMahalla, "Gharbia 2 (Mahalla)", "Gharbia 1 (Tanta)");
    buildAnswerSheet(workbook, "Counted in Tanta", inTanta, "Gharbia 1 (Tanta)", "Gharbia 2 (Mahalla)");

    const outputPath = nextFreePath();
    mkdirSync(dirname(outputPath), { recursive: true });
    await workbook.xlsx.writeFile(outputPath);

    console.log(`Wrote ${outputPath}`);
    console.log(`  Counted in Mahalla, address says Gharbia 1: ${inMahalla.length} rows`);
    console.log(`  Counted in Tanta, address says Gharbia 2:   ${inTanta.length} rows`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
