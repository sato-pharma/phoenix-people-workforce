/**
 * The pending customer-pharmacy links, as the owner's decision sheet.
 *
 * WHY THIS EXISTS. `/admin/customer-pharmacy-mapping` shows every customer and the pharmacies that
 * customer is linked to, and lets a Super Admin approve or reject one link at a time. A link's
 * `validation_status` is not cosmetic: `assertMarketingCustomerHasValidatedVenue` reads only
 * `system_validated` and `sfe_validated`, so a PENDING link makes that pharmacy unusable as a
 * marketing request target, and none of its sales are credited to the campaign that paid for it.
 * A link left pending therefore has the same practical effect as a rejected one.
 *
 * 163 links sit pending in production, 131 of them written by the 2026-07-02 backfill that inferred
 * links from historical marketing requests. Not one approval has ever been recorded on the page —
 * its own loader failed for every caller until 2026-09-10 (PR #3627), so the queue simply grew.
 *
 * WHY A WORKBOOK AND NOT A LIST IN CHAT. Standing owner rule (AGENTS.md §4): a "which of these
 * belongs to which" question is asked as an XLSX with dropdowns — one row per item, the context
 * that makes the call easy, a locked list of valid answers, and a free-text Note column. Never as
 * prose, and never guessed to avoid asking.
 *
 * READ-ONLY. This script runs a single SELECT and writes a file. It decides nothing and mutates
 * nothing: approving or rejecting a link is the owner's call, made in the sheet or on the page.
 *
 * Run:  node --env-file-if-exists=.env.local --experimental-strip-types \
 *         --experimental-specifier-resolution=node scripts/customer-pharmacy-pending-questions.ts \
 *         [output.xlsx]
 *
 * Reads PRODUCTION through `SUPABASE_DB_URL` in `.env.local`.
 *
 * NO IMAGES AND NO OUTLINE GROUPS, deliberately, and data validation is added ONCE PER CONTIGUOUS
 * BLOCK rather than per cell. ExcelJS writes two schema-invalid OOXML fragments that make Excel
 * silently "repair" a workbook — `outlineProperties` with `pageSetup.fitToPage`, and `ws.addImage`
 * — and per-cell validation rules coalesce into overlapping `sqref` ranges, which prompts the same
 * repair. This sheet triggers none of the three.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";
import postgres from "postgres";

const HEADER_FILL = "FF0F172A";
const ACCENT_FILL = "FF0A6BA6";
const ANSWER_FILL = "FFEFF6FF";
const ALERT_FILL = "FFFFF1F2";

/** The option list ends with an escape hatch, so a case nobody anticipated is still answerable. */
const DECISION_OPTIONS =
  '"Approve — this pharmacy really serves this customer,' +
  "Reject — wrong pairing," +
  "Leave pending — I need to check," +
  'Other — see my note"';

type PendingRow = {
  link_id: string;
  customer_name: string | null;
  customer_code: string | null;
  customer_type: string | null;
  area: string | null;
  governorate: string | null;
  pharmacy_name: string | null;
  pharmacy_code: string | null;
  distributor_name: string | null;
  distributor_pharmacy_code: string | null;
  created_at: Date;
  validation_notes: string | null;
  approved_siblings: string;
  total_links: string;
};

const PENDING_SQL = `
select
  l.id::text                      as link_id,
  c.display_name                  as customer_name,
  c.customer_code,
  c.customer_type::text           as customer_type,
  c.extracted_area_name           as area,
  c.extracted_governorate_name    as governorate,
  p.display_name                  as pharmacy_name,
  p.pharmacy_code,
  d.display_name                  as distributor_name,
  dc.distributor_pharmacy_code,
  l.created_at,
  l.validation_notes,
  (select count(*) from public.marketing_customer_pharmacies s
     where s.customer_id = l.customer_id and s.active
       and s.validation_status in ('system_validated', 'sfe_validated'))::text as approved_siblings,
  (select count(*) from public.marketing_customer_pharmacies s
     where s.customer_id = l.customer_id and s.active)::text                   as total_links
from public.marketing_customer_pharmacies l
join public.marketing_customers c
  on c.id = l.customer_id and c.active
left join public.marketing_pharmacies p
  on p.id = l.pharmacy_id
left join public.marketing_pharmacy_distributor_codes dc
  on dc.id = l.distributor_code_id
left join public.marketing_distributors d
  on d.id = dc.distributor_id
where l.active
  and l.validation_status = 'pending'
order by c.display_name, p.display_name;
`;

/**
 * Where a link came from, read from the note markers rather than from a column — there is no
 * `source` column, and both backfill note variants carry the same substring. The wording matters to
 * the reader: "the system guessed this" and "a rep stood in front of the shop" are different levels
 * of evidence, and the whole point of the sheet is that the owner can tell them apart at a glance.
 */
function describeOrigin(notes: string | null): string {
  const text = notes ?? "";
  if (text.includes("not GPS field-validated")) return "System guess from old marketing requests (2 July)";
  if (text.includes("no field GPS or live photo")) return "Entered at a desk, location picked from a map";
  return "Captured by a rep in the field";
}

const cairoDate = (value: Date): string =>
  value.toLocaleDateString("en-GB", { timeZone: "Africa/Cairo", day: "2-digit", month: "short", year: "numeric" });

function daysWaiting(value: Date): number {
  return Math.max(0, Math.floor((Date.now() - value.getTime()) / 86_400_000));
}

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
  sheet.getRow(2).height = 60;
}

function buildReadMe(workbook: ExcelJS.Workbook, rows: PendingRow[]): void {
  const sheet = workbook.addWorksheet("Read me", { properties: { tabColor: { argb: ACCENT_FILL } } });
  sheet.columns = [{ width: 30 }, { width: 108 }];

  const guessed = rows.filter((row) => describeOrigin(row.validation_notes).startsWith("System guess")).length;
  const customers = new Set(rows.map((row) => row.customer_name ?? "")).size;

  const lines: Array<[string, string]> = [
    ["What this is", `Every customer-and-pharmacy pairing that is still waiting for your decision: ${rows.length} pairings across ${customers} customers.`],
    ["Why it matters", "A pairing you have not decided counts for nothing. The pharmacy cannot be chosen when someone creates a marketing request, so none of its sales are credited to the campaign that paid for it. Leaving it pending has the same effect as rejecting it."],
    ["Approve means", "Yes, this customer really does buy through this pharmacy. From then on the pharmacy can be chosen on a marketing request and its sales count toward the campaign."],
    ["Reject means", "No, this pairing is wrong. The row is kept as a record, with your reason on it, but the pharmacy can never be chosen and its sales never count. Nothing is deleted."],
    ["Where these came from", `${guessed} of them were not typed in by anyone. On 2 July the system read old marketing requests and worked the pairing out by itself. The rest were captured by a rep in the field or entered at a desk. The "Where it came from" column says which.`],
    ["How to answer", "Fill the Decision column from its dropdown. If you reject one, write why in the Reason column — the reason is stored on the record. Leave a row blank to decide it later."],
    ["What happens next", "Send the file back and the answers are applied to the same links, one at a time, exactly as if you had clicked them on the page. Nothing is applied until you send it back."],
    ["Nothing here was decided for you", "This sheet lists and explains. It does not approve, reject, or guess a single pairing."],
  ];

  let cursor = 1;
  for (const [label, text] of lines) {
    sheet.getCell(`A${cursor}`).value = label;
    sheet.getCell(`A${cursor}`).font = { bold: true, size: 11 };
    sheet.getCell(`A${cursor}`).alignment = { vertical: "top", wrapText: true };
    sheet.getCell(`B${cursor}`).value = text;
    sheet.getCell(`B${cursor}`).alignment = { vertical: "top", wrapText: true };
    sheet.getRow(cursor).height = 46;
    cursor += 1;
  }
}

function buildPendingSheet(workbook: ExcelJS.Workbook, rows: PendingRow[]): void {
  const sheet = workbook.addWorksheet("Waiting for you");
  sheet.columns = [
    { width: 30 }, // customer
    { width: 15 }, // type
    { width: 16 }, // area
    { width: 18 }, // governorate
    { width: 30 }, // pharmacy
    { width: 18 }, // distributor
    { width: 16 }, // distributor code
    { width: 42 }, // where it came from
    { width: 12 }, // waiting since
    { width: 10 }, // days
    { width: 26 }, // this customer already has
    { width: 46 }, // decision
    { width: 40 }, // reason
    { width: 38 }, // link id
  ];

  const columns = 14;
  addTitle(
    sheet,
    columns,
    `Customer pharmacy pairings waiting for your decision — ${rows.length}`,
    "One row per pairing. Fill the Decision column from its dropdown, and write a reason when you reject. " +
      "A pairing left undecided counts for nothing: the pharmacy cannot be chosen on a marketing request, " +
      "and its sales are not credited to the campaign. Nothing in this file changes anything until you send it back.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    "Customer",
    "Type",
    "Area",
    "Governorate",
    "Pharmacy",
    "Distributor",
    "Distributor's code",
    "Where it came from",
    "Waiting since",
    "Days",
    "This customer already has",
    "Decision",
    "Reason (required if you reject)",
    "Reference",
  ];
  styleHeader(sheet, headerRow, columns);

  rows.forEach((row, index) => {
    const approved = Number(row.approved_siblings);
    const total = Number(row.total_links);
    const excelRow = sheet.getRow(headerRow + 1 + index);
    excelRow.values = [
      row.customer_name ?? "(unnamed customer)",
      row.customer_type ?? "—",
      row.area ?? "—",
      row.governorate ?? "—",
      row.pharmacy_name ?? "(unnamed pharmacy)",
      row.distributor_name ?? "No distributor account",
      row.distributor_pharmacy_code ?? "—",
      describeOrigin(row.validation_notes),
      cairoDate(row.created_at),
      daysWaiting(row.created_at),
      approved > 0
        ? `${approved} approved pharmac${approved === 1 ? "y" : "ies"} of ${total}`
        : `no approved pharmacy at all (${total} waiting)`,
      "",
      "",
      row.link_id,
    ];
    excelRow.alignment = { vertical: "top", wrapText: true };
    excelRow.height = 30;

    // A customer with NO approved pharmacy cannot be used on a marketing request at all, so these
    // rows are the ones where a decision actually unblocks somebody. Flagged, never sorted to the
    // top — the sheet stays in customer order so he can work down it the way he reads it.
    if (approved === 0) {
      excelRow.getCell(11).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ALERT_FILL } };
      excelRow.getCell(11).font = { bold: true };
    }
    excelRow.getCell(12).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
    excelRow.getCell(13).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
  });

  const lastRow = headerRow + rows.length;
  if (rows.length > 0) {
    // ONE rule over the whole answer column — never one per cell (overlapping sqref = repair prompt).
    (sheet as ExcelJS.Worksheet & {
      dataValidations: { add: (range: string, rule: ExcelJS.DataValidation) => void };
    }).dataValidations.add(`L${headerRow + 1}:L${lastRow}`, {
      type: "list",
      allowBlank: true,
      formulae: [DECISION_OPTIONS],
      showErrorMessage: true,
      errorTitle: "Pick one, or choose Other",
      error: "Choose from the list, or pick 'Other — see my note' and write what you mean in the Reason column.",
    });
  }

  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: Math.max(lastRow, headerRow), column: columns } };
}

async function main(): Promise<void> {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) throw new Error("SUPABASE_DB_URL is not set — load .env.local.");

  const outputPath = resolve(
    process.argv[2] ?? `xlsx/customer-pharmacy-pending-${new Date().toISOString().slice(0, 10)}.xlsx`,
  );

  const sql = postgres(connectionString, { max: 1, prepare: false });
  let rows: PendingRow[];
  try {
    rows = (await sql.unsafe(PENDING_SQL)) as unknown as PendingRow[];
  } finally {
    await sql.end({ timeout: 5 });
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();
  buildReadMe(workbook, rows);
  buildPendingSheet(workbook, rows);

  mkdirSync(dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);

  const guessed = rows.filter((row) => describeOrigin(row.validation_notes).startsWith("System guess")).length;
  const stranded = rows.filter((row) => Number(row.approved_siblings) === 0).length;
  console.log(`pending links      : ${rows.length}`);
  console.log(`customers involved : ${new Set(rows.map((row) => row.customer_name ?? "")).size}`);
  console.log(`system guesses     : ${guessed}`);
  console.log(`customers with no approved pharmacy at all: ${stranded} rows`);
  console.log(`written            : ${outputPath}`);
}

await main();
