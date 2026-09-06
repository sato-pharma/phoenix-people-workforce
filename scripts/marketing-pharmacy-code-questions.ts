/**
 * Which distributor codes belong to the same pharmacy — the owner's decision sheet.
 *
 * WHY THIS EXISTS. A marketing venue earns ROI credit through ONE distributor code. The realized-ROI
 * builder (`public.phx_refresh_marketing_roi_facts`) joins
 * `marketing_request_pharmacies -> marketing_pharmacy_distributor_codes` on `distributor_code_id`,
 * takes that row's `normalized_pharmacy_code` as the customer code, and then credits only sales rows
 * whose `client_code` equals it. There is no brick-level fallback: `all_hits` is `exact_hits` plus
 * `direct_hits`, nothing else. So every sale the same pharmacy makes through any OTHER distributor
 * is invisible to the request that paid for it — no error, no warning, no "unmatched" marker.
 *
 * 327 of the 335 active marketing venues carry exactly one code. The master map
 * (`source_of_sales_customer_map`) frequently holds several codes for what looks like one pharmacy
 * in one brick. Whether those really are one pharmacy is a business fact only the owner knows.
 *
 * WHY A WORKBOOK AND NOT A LIST IN CHAT. Standing owner rule (AGENTS.md §4): "which of these does
 * each of these belong to" is asked as an XLSX with dropdowns — one row per item, the context that
 * makes the call easy, a locked list of valid answers, and a free-text Note column. Never as prose,
 * and never guessed to avoid asking.
 *
 * WHY IT IS NOT AUTO-MERGED. AGENTS.md §2.3: a shared distributor customer code cannot prove two
 * venues are the same, and identity is never settled on name similarity or on a session's own
 * inference. Every rule below is a CANDIDATE FINDER whose only job is to put a short, ranked list in
 * front of the owner. Nothing here writes to the database.
 *
 * Run:  node --experimental-strip-types --experimental-specifier-resolution=node \
 *         scripts/marketing-pharmacy-code-questions.ts
 *
 * Reads PRODUCTION through `SUPABASE_DB_URL` in `.env.local` (read-only: SELECT plus two `pg_temp`
 * helper functions, which live in this session's temp schema and vanish with the connection).
 *
 * NO IMAGES AND NO OUTLINE GROUPS, deliberately. ExcelJS writes two schema-invalid OOXML fragments
 * that make Excel silently "repair" a workbook: `outlineProperties` together with
 * `pageSetup.fitToPage`, and `ws.addImage`. This sheet triggers neither. Data validation is added
 * ONCE PER CONTIGUOUS BLOCK, never per cell — per-cell rules coalesce into overlapping `sqref`
 * ranges, which is its own repair prompt on open.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";
import postgres from "postgres";

const HEADER_FILL = "FF0F172A";
const ACCENT_FILL = "FF0A6BA6";
const ANSWER_FILL = "FFEFF6FF";
const ALERT_FILL = "FFFFF1F2";

/** Every option list ends with an escape hatch, so a case nobody anticipated is still answerable. */
const SAME_OPTIONS =
  '"Yes — one pharmacy: add this code to it,No — a different pharmacy: leave it,Not sure — I need to check,Other — see my note"';
const LINK_OPTIONS =
  '"Correct — the link is right,Wrong — unlink it,Wrong — I will give the right code in the note,Not sure — I need to check,Other — see my note"';

type SheetWithValidations = ExcelJS.Worksheet & {
  dataValidations: { add: (range: string, rule: ExcelJS.DataValidation) => void };
};

type SiblingRow = {
  area: string | null;
  pharmacy_id: string;
  brick_id: string | null;
  confidence: string;
  display_name: string | null;
  linked_code: string;
  linked_dist: string;
  linked_name: string | null;
  linked_units: string;
  on_live_request: boolean;
  owner_hr_id: string | null;
  sib_code: string;
  sib_dist: string;
  sib_last: string | null;
  sib_name: string | null;
  sib_units: string;
};

type MislinkRow = {
  area: string | null;
  code_row_id: string;
  pharmacy_id: string;
  display_name: string | null;
  linked_code: string;
  linked_dist: string;
  master_name: string | null;
  on_live_request: boolean;
  owner_hr_id: string | null;
  units: string;
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

/** EGP at factory price. Never a unit count — see the `sales` CTE for why. */
function money(value: string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

/**
 * ARABIC NORMALISATION, and why it is not optional. The same pharmacy is spelled differently by
 * every distributor: أ/إ/آ against ا, ى against ي, ة against ه. Comparing raw strings reports two
 * codes as two pharmacies purely because Ibn Sina writes يحيى where Ramco writes يحيي. `tk()` then
 * drops one- and two-letter tokens, which are the connectors (ن، م، ص) that carry no identity.
 */
const HELPERS = `
create or replace function pg_temp.arn(t text) returns text language sql immutable as $fn$
  select btrim(regexp_replace(regexp_replace(
    translate(lower(coalesce(t,'')),'أإآىةئؤ','ااايهيو'),'[^a-z0-9ء-ي ]',' ','g'),'\\s+',' ','g'))
$fn$;
create or replace function pg_temp.tk(t text) returns text[] language sql immutable as $fn$
  select array(select distinct w from unnest(string_to_array(pg_temp.arn(t),' ')) w where length(w) > 2)
$fn$;
`;

/**
 * THE CANDIDATE FINDER. Two confidence tiers, both anchored on the BRICK — two codes in different
 * bricks are two pharmacies, whatever they are called.
 *
 *   "Same name"     — normalised names are identical. Low false-positive rate.
 *   "Shorter form"  — one name's words are a subset of the other's (حسناء البطاح inside
 *                     حسناء حسن البطاح). Needs at least two real words on the shorter side and at
 *                     most two extra on the longer, or a single common first name matches half a
 *                     brick. This tier is included ONLY where the unlinked code carries real value
 *                     or the venue is on a live request — the loose rule earns its place by the
 *                     money behind it, never by the count.
 *
 * The tiers are reported, never merged: the owner reads the confidence before he reads the answer.
 */
const SIBLING_SQL = `
with norm as (
  select customer_code, distributor_code, brick_id, customer_name
  from public.source_of_sales_customer_map where active
),
linked as (
  select p.id pharmacy_id, p.display_name, p.owner_hr_id,
         c.mapped_customer_code, c.mapped_distributor_code, c.mapped_area_code
  from public.marketing_pharmacy_distributor_codes c
  join public.marketing_pharmacies p on p.id = c.pharmacy_id
  where coalesce(c.active,true) and coalesce(p.active,true) and p.merged_into_pharmacy_id is null
    and coalesce(btrim(c.mapped_customer_code),'') <> ''
),
anchor as (
  select l.*, n.customer_name anchor_name, n.brick_id
  from linked l
  join norm n on n.customer_code = l.mapped_customer_code and n.distributor_code = l.mapped_distributor_code
),
-- VALUE, never summed units. Owner rule: a unit total is valid for ONE product_code only —
-- above that, aggregate by value. These venues each carry several products, so a units column
-- here would add Tebofortin drops to Tebofortin 40 mg and print a number that means nothing.
-- Priced at the product's factory price, which is what the ROI builder itself uses.
sales as (
  select f.client_code, f.distributor_code,
         sum(f.total_qty * coalesce(sp.factory_price,0)) units, max(f.period) last_period
  from public.source_of_sales_fact_rollup f
  left join public.source_of_sales_products sp
    on upper(btrim(sp.product_code)) = upper(btrim(f.product_code))
  group by 1,2
),
pairs as (
  select distinct on (a.pharmacy_id, s.customer_code, s.distributor_code)
    a.pharmacy_id, a.display_name, a.owner_hr_id, a.mapped_area_code area, a.brick_id,
    a.anchor_name linked_name, a.mapped_customer_code linked_code, a.mapped_distributor_code linked_dist,
    s.customer_name sib_name, s.customer_code sib_code, s.distributor_code sib_dist,
    case when pg_temp.arn(s.customer_name) = pg_temp.arn(a.anchor_name)
         then 'Same name' else 'Shorter form' end confidence
  from anchor a
  join norm s
    on s.brick_id = a.brick_id
   and s.customer_code <> a.mapped_customer_code
   and (
     pg_temp.arn(s.customer_name) = pg_temp.arn(a.anchor_name)
     or (
       (pg_temp.tk(s.customer_name) @> pg_temp.tk(a.anchor_name)
        or pg_temp.tk(a.anchor_name) @> pg_temp.tk(s.customer_name))
       and least(array_length(pg_temp.tk(s.customer_name),1),
                 array_length(pg_temp.tk(a.anchor_name),1)) >= 2
       and abs(array_length(pg_temp.tk(s.customer_name),1)
             - array_length(pg_temp.tk(a.anchor_name),1)) <= 2
     )
   )
),
enriched as (
  select p.*, coalesce(ls.units,0) linked_units, coalesce(ss.units,0) sib_units, ss.last_period sib_last,
    exists (
      select 1 from public.marketing_request_pharmacies mrp
      join public.marketing_requests r on r.id = mrp.request_id
      where mrp.pharmacy_id = p.pharmacy_id and r.status not in ('rejected','cancelled')
    ) on_live_request
  from pairs p
  left join sales ls on ls.client_code = p.linked_code and ls.distributor_code = p.linked_dist
  left join sales ss on ss.client_code = p.sib_code and ss.distributor_code = p.sib_dist
)
select pharmacy_id::text, display_name, owner_hr_id, area, brick_id, linked_name, linked_code, linked_dist,
       linked_units::text, sib_name, sib_code, sib_dist, sib_units::text, sib_last,
       on_live_request, confidence
from enriched
where confidence = 'Same name' or sib_units >= 2000 or on_live_request
order by on_live_request desc, sib_units desc, display_name;
`;

/**
 * THE SECOND QUESTION, and it is the more dangerous one. Above, a venue is missing sales. Here the
 * venue's ONE code resolves in the master map to a pharmacy with a completely different name — no
 * word in common — which means the venue may be collecting somebody else's sales as its own ROI.
 * A wrong credit is worse than a missing one: it reads as success.
 *
 * "No word in common" is deliberately strict. Spelling variants, longer legal names and trade names
 * (Tabarak hospital pharmacy / مستشفى تبارك المريوطية) all share a word and are correctly excluded —
 * they are not the owner's problem to adjudicate.
 */
const MISLINK_SQL = `
with linked as (
  select c.id code_row_id, p.id pharmacy_id, p.display_name, p.owner_hr_id,
         c.mapped_customer_code, c.mapped_distributor_code, c.mapped_area_code
  from public.marketing_pharmacy_distributor_codes c
  join public.marketing_pharmacies p on p.id = c.pharmacy_id
  where coalesce(c.active,true) and coalesce(p.active,true) and p.merged_into_pharmacy_id is null
    and coalesce(btrim(c.mapped_customer_code),'') <> ''
),
j as (
  select distinct l.code_row_id, l.pharmacy_id, l.display_name, l.owner_hr_id, l.mapped_area_code area,
         l.mapped_customer_code, l.mapped_distributor_code, m.customer_name master_name
  from linked l
  join public.source_of_sales_customer_map m
    on m.customer_code = l.mapped_customer_code
   and m.distributor_code = l.mapped_distributor_code and m.active
),
sales as (
  select f.client_code, f.distributor_code, sum(f.total_qty * coalesce(sp.factory_price,0)) units
  from public.source_of_sales_fact_rollup f
  left join public.source_of_sales_products sp
    on upper(btrim(sp.product_code)) = upper(btrim(f.product_code))
  group by 1,2
)
select j.pharmacy_id::text, j.code_row_id::text, j.display_name, j.owner_hr_id, j.area, j.master_name,
       j.mapped_customer_code linked_code, j.mapped_distributor_code linked_dist,
       coalesce(s.units,0)::text units,
       exists (
         select 1 from public.marketing_request_pharmacies mrp
         join public.marketing_requests r on r.id = mrp.request_id
         where mrp.pharmacy_id = j.pharmacy_id and r.status not in ('rejected','cancelled')
       ) on_live_request
from j
left join sales s on s.client_code = j.mapped_customer_code and s.distributor_code = j.mapped_distributor_code
where not (pg_temp.tk(j.display_name) && pg_temp.tk(j.master_name))
  and array_length(pg_temp.tk(j.display_name),1) >= 1
  and array_length(pg_temp.tk(j.master_name),1) >= 1
order by coalesce(s.units,0) desc;
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

function buildReadMe(workbook: ExcelJS.Workbook, siblings: SiblingRow[], mislinks: MislinkRow[]): void {
  const sheet = workbook.addWorksheet("Read me", { properties: { tabColor: { argb: ACCENT_FILL } } });
  sheet.columns = [{ width: 34 }, { width: 112 }];

  addTitle(
    sheet,
    2,
    "One pharmacy, several distributor codes — the calls only you can make",
    "A marketing venue earns its ROI through ONE distributor code. Every sale the same pharmacy "
      + "makes through any other distributor is invisible to the request that paid for it. These are "
      + "the venues where that looks like it is happening.",
  );

  const liveSiblings = siblings.filter((row) => row.on_live_request).length;
  const liveMislinks = mislinks.filter((row) => row.on_live_request).length;
  const hiddenValue = siblings.reduce((total, row) => total + money(row.sib_units), 0);

  const rows: [string, string][] = [
    [
      "How the credit actually works",
      "When a request is tracked, the system takes the ONE distributor code on each pharmacy and "
        + "counts only the sales rows carrying that exact customer code, for the products on the "
        + "request, inside the ROI window. There is no fallback to the brick or the area. A pharmacy "
        + "that buys the same box through a second distributor gets no credit for it.",
    ],
    [
      "Sheet 2 — Same pharmacy?",
      `${siblings.length} rows. Each is one marketing venue and one OTHER code sitting in the same `
        + "brick under the same (or a shorter) name. Say whether it is the same pharmacy. 'Yes' means "
        + "the code gets added to that venue so its sales start counting.",
    ],
    [
      "Sheet 3 — Right pharmacy?",
      `${mislinks.length} rows, and these are the more serious ones. The venue's code resolves in the `
        + "master map to a pharmacy with a completely different name. If the link is wrong the venue "
        + "is being credited with somebody else's sales — which reads as success, not as an error.",
    ],
    [
      "Read the Confidence column",
      "'Same name' means the two names are identical once spelling is normalised (أ/ا, ى/ي, ة/ه). "
        + "'Shorter form' means one name's words sit inside the other — those are shown only where "
        + "the unlinked code carries real value or the venue is on a live request.",
    ],
    [
      "What the value means",
      "It is the whole tracked history in the monthly closing for that customer code — every product, "
        + "every month, not just the ones on a request — priced at factory price. It is there to size "
        + "the decision, not to be quoted as a sales figure. It is shown as value and not as units "
        + "because units of different products are never added.",
    ],
    [
      "Nothing here has been changed",
      "This sheet only asks. No code was linked, unlinked, merged or renamed to produce it, and "
        + "nothing will change until you send it back. A blank row stays exactly as it is today, so a "
        + "half-finished sheet is safe to return.",
    ],
    [
      "Why you and not the system",
      "Two distributors issue codes from their own catalogues, so two codes can never be proved to be "
        + "one pharmacy by the codes themselves — and a similar name is not proof either. Every rule "
        + "behind these rows is a way of finding candidates worth your glance, never a verdict.",
    ],
    [
      "What is at stake right now",
      `${liveSiblings} of the Sheet 2 rows and ${liveMislinks} of the Sheet 3 rows sit on venues `
        + `attached to a live marketing request. Around ${hiddenValue.toLocaleString("en-US")} EGP of `
        + "tracked history sits on the unlinked codes in Sheet 2.",
    ],
  ];

  let cursor = 4;
  for (const [label, body] of rows) {
    sheet.getCell(`A${cursor}`).value = label;
    sheet.getCell(`A${cursor}`).font = { bold: true, size: 11 };
    sheet.getCell(`A${cursor}`).alignment = { vertical: "top", wrapText: true };
    sheet.getCell(`B${cursor}`).value = body;
    sheet.getCell(`B${cursor}`).alignment = { vertical: "top", wrapText: true };
    sheet.getRow(cursor).height = 66;
    cursor += 1;
  }
}

function buildSiblingSheet(workbook: ExcelJS.Workbook, rows: SiblingRow[]): void {
  const sheet = workbook.addWorksheet("Same pharmacy");
  sheet.columns = [
    { width: 26 }, { width: 10 }, { width: 8 }, { width: 11 }, { width: 14 },
    { width: 26 }, { width: 13 }, { width: 8 }, { width: 26 }, { width: 14 },
    { width: 8 }, { width: 11 }, { width: 10 }, { width: 13 }, { width: 34 }, { width: 34 },
  ];

  addTitle(
    sheet,
    16,
    `Is this the same pharmacy? — ${rows.length} to decide`,
    "Column O is your answer. 'Yes' adds the unlinked code to that venue so its sales start counting "
      + "towards the venue's marketing ROI. Leave a row blank to change nothing.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    "Marketing venue", "Rep", "Area", "Brick", "On a live request?",
    "Name on the LINKED code", "Linked code", "Dist.", "Name on the UNLINKED code", "Unlinked code",
    "Dist.", "Its value (EGP)", "Last seen", "Confidence", "Same pharmacy?", "Note",
  ];
  styleHeader(sheet, headerRow, 16);

  rows.forEach((row, index) => {
    const excelRow = sheet.getRow(headerRow + 1 + index);
    excelRow.values = [
      row.display_name ?? "", row.owner_hr_id ?? "—", row.area ?? "", row.brick_id ?? "",
      row.on_live_request ? "YES" : "no",
      row.linked_name ?? "", row.linked_code, row.linked_dist,
      row.sib_name ?? "", row.sib_code, row.sib_dist,
      money(row.sib_units), row.sib_last ?? "never", row.confidence, "", "",
    ];
    excelRow.alignment = { vertical: "top", wrapText: true };
    excelRow.height = 30;
    if (row.on_live_request) {
      excelRow.getCell(5).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ALERT_FILL } };
      excelRow.getCell(5).font = { bold: true };
    }
    excelRow.getCell(15).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
    excelRow.getCell(16).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
  });

  const lastRow = headerRow + rows.length;
  if (rows.length > 0) {
    // ONE rule over the whole answer column — never one per cell (overlapping sqref = repair prompt).
    (sheet as SheetWithValidations).dataValidations.add(`O${headerRow + 1}:O${lastRow}`, {
      type: "list",
      allowBlank: true,
      formulae: [SAME_OPTIONS],
      showErrorMessage: true,
      errorTitle: "Pick one, or choose Other",
      error: "Choose from the list, or pick 'Other — see my note' and write what you mean in the Note column.",
    });
  }
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: Math.max(lastRow, headerRow), column: 16 } };
}

function buildMislinkSheet(workbook: ExcelJS.Workbook, rows: MislinkRow[]): void {
  const sheet = workbook.addWorksheet("Right pharmacy");
  sheet.columns = [
    { width: 30 }, { width: 10 }, { width: 8 }, { width: 16 },
    { width: 34 }, { width: 14 }, { width: 8 }, { width: 12 }, { width: 36 }, { width: 34 },
  ];

  addTitle(
    sheet,
    10,
    `Is this venue pointed at the right pharmacy? — ${rows.length} to check`,
    "The venue the rep registered and the pharmacy its code resolves to share no word at all. If the "
      + "link is wrong, this venue is being credited with another pharmacy's sales.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    "Marketing venue (what the rep registered)", "Rep", "Area", "On a live request?",
    "Pharmacy the code actually is (master map)", "Code", "Dist.", "Its value (EGP)",
    "Is the link right?", "Note — if wrong, the right code",
  ];
  styleHeader(sheet, headerRow, 10);

  rows.forEach((row, index) => {
    const excelRow = sheet.getRow(headerRow + 1 + index);
    excelRow.values = [
      row.display_name ?? "", row.owner_hr_id ?? "—", row.area ?? "",
      row.on_live_request ? "YES" : "no",
      row.master_name ?? "", row.linked_code, row.linked_dist, money(row.units), "", "",
    ];
    excelRow.alignment = { vertical: "top", wrapText: true };
    excelRow.height = 30;
    if (row.on_live_request) {
      excelRow.getCell(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ALERT_FILL } };
      excelRow.getCell(4).font = { bold: true };
    }
    excelRow.getCell(9).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
    excelRow.getCell(10).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
  });

  const lastRow = headerRow + rows.length;
  if (rows.length > 0) {
    (sheet as SheetWithValidations).dataValidations.add(`I${headerRow + 1}:I${lastRow}`, {
      type: "list",
      allowBlank: true,
      formulae: [LINK_OPTIONS],
      showErrorMessage: true,
      errorTitle: "Pick one, or choose Other",
      error: "Choose from the list, or pick 'Other — see my note' and write what you mean in the Note column.",
    });
  }
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: Math.max(lastRow, headerRow), column: 10 } };
}

function nextFreePath(): string {
  // Africa/Cairo, never `toISOString()`. UTC dates the file a day early for the ~3 hours after Cairo
  // midnight, which is exactly when this repository is often worked, and every date the owner sees
  // is Cairo local by standing rule.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const base = resolve("xlsx", `marketing-pharmacy-code-decisions-${today}`);
  const first = `${base}.xlsx`;
  if (!existsSync(first)) return first;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}.xlsx`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Too many code-decision workbooks written today — clear xlsx/ before rerunning.");
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// --apply — reading the answered sheet back and making it true.
//
// A sheet the owner fills in is only half the job; the other half is somebody typing the answers
// into the database, and that somebody should not be him.
//
// THE ROW IS MATCHED BY IDENTITY, NEVER BY CODE. `348325` is linked to TWO different venues
// (جميلة and ريهام) and only one of them is the one he judged — "unlink the row with that code"
// would have taken out the correct link as well. Every decision is therefore re-resolved against a
// LIVE re-run of the same finder and matched on the whole natural key, venue name and area included.
// A workbook row that no longer matches exactly one live row is REFUSED and reported, never guessed.
// ───────────────────────────────────────────────────────────────────────────────────────────────

type Decision = { answer: string; key: string; note: string };

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object") {
    const rich = value as { richText?: { text: string }[]; text?: string };
    if (rich.richText) return rich.richText.map((part) => part.text).join("").trim();
    if (rich.text) return String(rich.text).trim();
  }
  return String(value).trim();
}

/**
 * A CONTROL CHARACTER, not a comma or a slash. Every field in the key is free text somebody typed,
 * and a venue legitimately named "عمر / الهرم" would otherwise forge another row's key. Written as
 * an escape rather than a literal byte so an editor cannot silently strip it.
 */
const SEP = "";

const siblingKey = (row: SiblingRow) =>
  [row.display_name ?? "", row.area ?? "", row.linked_code, row.linked_dist, row.sib_code, row.sib_dist].join(SEP);
const mislinkKey = (row: MislinkRow) =>
  [row.display_name ?? "", row.area ?? "", row.linked_code, row.linked_dist].join(SEP);

async function readAnswers(path: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const siblings = new Map<string, Decision>();
  const mislinks = new Map<string, Decision>();

  const same = workbook.getWorksheet("Same pharmacy");
  if (same) {
    for (let n = 5; n <= same.rowCount; n += 1) {
      const values = same.getRow(n).values as ExcelJS.CellValue[];
      const answer = cellText(values[15]);
      if (!answer) continue;
      const key = [cellText(values[1]), cellText(values[3]), cellText(values[7]),
        cellText(values[8]), cellText(values[10]), cellText(values[11])].join(SEP);
      siblings.set(key, { answer, key, note: cellText(values[16]) });
    }
  }
  const right = workbook.getWorksheet("Right pharmacy");
  if (right) {
    for (let n = 5; n <= right.rowCount; n += 1) {
      const values = right.getRow(n).values as ExcelJS.CellValue[];
      const answer = cellText(values[9]);
      if (!answer) continue;
      const key = [cellText(values[1]), cellText(values[3]), cellText(values[6]), cellText(values[7])].join(SEP);
      mislinks.set(key, { answer, key, note: cellText(values[10]) });
    }
  }
  return { mislinks, siblings };
}

type AddPlan = {
  code: string;
  distributorId: number;
  pharmacyId: string;
  sosDist: string;
  venue: string;
};

const ADD_NOTE =
  "Added on the owner's answer, marketing-pharmacy-code-decisions sheet: same pharmacy as its existing code.";

async function runApply(sql: postgres.Sql, answerPath: string, dryRun: boolean): Promise<void> {
  const { mislinks, siblings } = await readAnswers(answerPath);
  await sql.unsafe(HELPERS);
  const liveSiblings = (await sql.unsafe(SIBLING_SQL)) as unknown as SiblingRow[];
  const liveMislinks = (await sql.unsafe(MISLINK_SQL)) as unknown as MislinkRow[];

  // Fan each key out to EVERY live row it hits, so an ambiguous key is visible rather than silent.
  const siblingIndex = new Map<string, SiblingRow[]>();
  for (const row of liveSiblings) {
    const key = siblingKey(row);
    siblingIndex.set(key, [...(siblingIndex.get(key) ?? []), row]);
  }
  const mislinkIndex = new Map<string, MislinkRow[]>();
  for (const row of liveMislinks) {
    const key = mislinkKey(row);
    mislinkIndex.set(key, [...(mislinkIndex.get(key) ?? []), row]);
  }

  // SoS distributor code -> the marketing distributor owning its family (IS-S belongs to Ibn Sina).
  const rollup = (await sql`
    select r.sos_distributor_code, d.id, d.display_name
    from public.marketing_roi_distributor_rollup r
    join public.marketing_distributors d on d.normalized_name = r.marketing_normalized_name
  `) as unknown as { display_name: string; id: number; sos_distributor_code: string }[];
  const distributorFor = new Map(rollup.map((row) => [row.sos_distributor_code, row]));

  const adds: AddPlan[] = [];
  const unlinks: { code: string; id: string; venue: string }[] = [];
  const refused: string[] = [];
  let untouched = 0;

  for (const [key, decision] of siblings) {
    if (!decision.answer.startsWith("Yes")) { untouched += 1; continue; }
    const matches = siblingIndex.get(key) ?? [];
    if (matches.length !== 1) {
      refused.push(`Same pharmacy: "${key.split(SEP).join(" / ")}" matched ${matches.length} live rows`);
      continue;
    }
    const row = matches[0]!;
    const distributor = distributorFor.get(row.sib_dist);
    if (!distributor) {
      refused.push(`Same pharmacy: no marketing distributor for SoS code ${row.sib_dist} (${row.display_name})`);
      continue;
    }
    adds.push({
      code: row.sib_code, distributorId: distributor.id,
      pharmacyId: row.pharmacy_id, sosDist: row.sib_dist, venue: row.display_name ?? "",
    });
  }

  for (const [key, decision] of mislinks) {
    if (!decision.answer.startsWith("Wrong — unlink")) { untouched += 1; continue; }
    const matches = mislinkIndex.get(key) ?? [];
    if (matches.length !== 1) {
      refused.push(`Right pharmacy: "${key.split(SEP).join(" / ")}" matched ${matches.length} live rows`);
      continue;
    }
    const row = matches[0]!;
    unlinks.push({ code: row.linked_code, id: row.code_row_id, venue: row.display_name ?? "" });
  }

  // The unique key is (pharmacy, distributor, code), and IS and IS-S collapse onto ONE marketing
  // distributor — so two answered rows can legitimately be one insert. De-duplicate before writing.
  const deduped = new Map<string, AddPlan>();
  for (const add of adds) deduped.set(`${add.pharmacyId}|${add.distributorId}|${add.code}`, add);
  const plan = [...deduped.values()];

  console.log(`Answers read from ${answerPath}`);
  console.log(`  code links to ADD:        ${plan.length} (from ${adds.length} answered rows; ${adds.length - plan.length} collapsed by distributor family)`);
  console.log(`  code links to DEACTIVATE: ${unlinks.length}`);
  console.log(`  answers needing nothing:  ${untouched}`);
  for (const row of unlinks) console.log(`      deactivate ${row.code} on ${row.venue} (${row.id})`);
  if (refused.length > 0) {
    console.log(`  REFUSED, not applied:     ${refused.length}`);
    for (const line of refused) console.log(`      ${line}`);
  }

  if (dryRun) { console.log("\nDRY RUN — nothing was written."); return; }
  if (plan.length === 0 && unlinks.length === 0) { console.log("\nNothing to apply."); return; }

  // PRE-IMAGE FIRST. Production has no PITR — seven daily physical backups are the whole recovery
  // story, and restoring one rolls the WHOLE database back to about 07:30 Cairo that day. So the
  // rollback for this change has to be carried by the change itself: every row deactivated is copied
  // whole beforehand, and every row inserted records its id. Both halves reverse by primary key.
  const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date()).replace(/-/g, "");
  const schema = `marketing_code_apply_backup_${stamp}`;

  const inserted = await sql.begin(async (tx) => {
    await tx.unsafe(`create schema if not exists ${schema}`);
    await tx.unsafe(`create table if not exists ${schema}.codes_pre
      (like public.marketing_pharmacy_distributor_codes including defaults)`);
    await tx.unsafe(`create table if not exists ${schema}.codes_added
      (id uuid primary key, added_at timestamptz not null default now())`);

    if (unlinks.length > 0) {
      const ids = unlinks.map((row) => row.id);
      await tx.unsafe(
        `insert into ${schema}.codes_pre
         select * from public.marketing_pharmacy_distributor_codes where id = any($1::uuid[])`,
        [ids],
      );
      await tx.unsafe(
        `update public.marketing_pharmacy_distributor_codes
         set active = false, updated_at = now(),
             validation_notes = concat_ws(' | ', nullif(validation_notes,''), $2::text)
         where id = any($1::uuid[])`,
        [ids, `Unlinked ${stamp}: owner decided this venue is not this pharmacy (marketing-pharmacy-code-decisions sheet).`],
      );
    }

    const added: string[] = [];
    for (const add of plan) {
      const rows = (await tx.unsafe(
        `insert into public.marketing_pharmacy_distributor_codes
           (pharmacy_id, distributor_id, distributor_pharmacy_code, normalized_pharmacy_code,
            reference_status, master_match_kind, master_resolved_at, active, validation_notes,
            mapped_customer_code, mapped_distributor_code, mapped_brick_id, mapped_area_code, mapped_region_code)
         select $1::uuid, $2::bigint, $3::text, $3::text,
                'manual_approved', 'exact', now(), true, $5::text,
                m.customer_code, m.distributor_code, m.brick_id, m.area_code, m.region_code
         from public.source_of_sales_customer_map m
         where m.customer_code = $3::text and m.distributor_code = $4::text and m.active
         limit 1
         on conflict (pharmacy_id, distributor_id, normalized_pharmacy_code) do nothing
         returning id`,
        [add.pharmacyId, add.distributorId, add.code, add.sosDist, ADD_NOTE],
      )) as unknown as { id: string }[];
      if (rows.length > 0) added.push(rows[0]!.id);
    }
    if (added.length > 0) {
      await tx.unsafe(`insert into ${schema}.codes_added (id) select unnest($1::uuid[]) on conflict (id) do nothing`, [added]);
    }
    return added;
  });

  console.log("\nApplied.");
  console.log(`  inserted    ${inserted.length} code links (${plan.length - inserted.length} already existed, skipped)`);
  console.log(`  deactivated ${unlinks.length} code links`);
  console.log(`  pre-image:  ${schema}.codes_pre (${unlinks.length} rows) / ${schema}.codes_added (${inserted.length} rows)`);
  console.log(`  to reverse: delete from public.marketing_pharmacy_distributor_codes where id in (select id from ${schema}.codes_added);`);
  console.log(`              update public.marketing_pharmacy_distributor_codes c set active = true`);
  console.log(`                from ${schema}.codes_pre p where p.id = c.id;`);
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
    await buildWorkbook(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function buildWorkbook(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(HELPERS);
  const siblings = (await sql.unsafe(SIBLING_SQL)) as unknown as SiblingRow[];
  const mislinks = (await sql.unsafe(MISLINK_SQL)) as unknown as MislinkRow[];

  // A SHEET WITH NOTHING LEFT ON IT IS NOT WRITTEN AT ALL. Handing somebody a form that re-asks
  // answered questions is how the answers stop coming back.
  if (siblings.length === 0 && mislinks.length === 0) {
    console.log("Nothing outstanding — every marketing venue's codes are settled. No workbook written.");
    return;
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce — marketing pharmacy code decisions";
  workbook.created = new Date();

  buildReadMe(workbook, siblings, mislinks);
  buildSiblingSheet(workbook, siblings);
  buildMislinkSheet(workbook, mislinks);

  const outputPath = nextFreePath();
  mkdirSync(dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);

  const liveSiblings = siblings.filter((row) => row.on_live_request).length;
  const liveMislinks = mislinks.filter((row) => row.on_live_request).length;
  console.log(`Wrote ${outputPath}`);
  console.log(`  Same pharmacy?  ${siblings.length} rows (${liveSiblings} on a live request)`);
  console.log(`  Right pharmacy? ${mislinks.length} rows (${liveMislinks} on a live request)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
