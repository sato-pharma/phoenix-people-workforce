/**
 * Which area does this pharmacy really belong to — the owner's decision sheet.
 *
 * WHY THIS EXISTS. `public.source_of_sales_customer_map` decides which area (and therefore which
 * District Manager) is credited for every customer's sales. On 2026-09-08 the owner reported five
 * pharmacies mapped to the wrong area. All five turned out to share one shape: the address the
 * DISTRIBUTOR sent names a town that is a brick in the company's own brick table, sitting in a
 * DIFFERENT area from the one the customer is mapped to.
 *
 *   المروه الجديده/الباجور   address "الباجور"   mapped to شبين الكوم (Menoufia 1)   -> باجور (Menoufia 2)
 *   الشعب                    address "منفلوط"    mapped to مدينة أسيوط (Assuit 2)    -> منفلوط (Assuit 1)
 *   احمد عوض                 address "قطور"      mapped to باسيون (Gharbia 1)        -> قطور (Gharbia 2)
 *   مولانا                   address "طنطا"      mapped to زفته (Gharbia 2)          -> طنطا (Gharbia 1)
 *   شفيق الجديدة الجمالية    address "الجمالية"  mapped to الدراسة (Cairo 5)         -> الجماليه (Dakahlia 3)
 *
 * Four of the five came from the 2026-07-28 `duplicate-brick-merge` batches, which collapsed
 * duplicate brick names onto a surviving brick and, for these customers, chose the wrong survivor.
 * A first sweep of that batch alone flagged several hundred more. This script puts them in front of
 * the owner.
 *
 * WHY A WORKBOOK AND NOT A LIST IN CHAT. Standing owner rule (AGENTS.md §4): "which of these does
 * each of these belong to" is asked as an XLSX with dropdowns — one row per item, the context that
 * makes the call easy, a locked list of valid answers, and a free-text Note column. Never as prose,
 * and never guessed to avoid asking.
 *
 * WHY NOTHING HERE IS AUTO-APPLIED. An address is EVIDENCE, not proof: it is written by the
 * distributor's data-entry clerk, it frequently names a street rather than a town, and a wholesaler
 * legitimately sells outside the town it sits in (AGENTS.md §4, the city rule). Moving a customer
 * moves money between District Managers. Every rule below is a CANDIDATE FINDER whose only job is to
 * produce a short, ranked list. Nothing in this file writes to the database.
 *
 * THE THREE PRECISION RULES, each bought with a false positive from the 2026-09-08 sample:
 *
 *   1. WHOLE-TOKEN MATCHING. "ترعة السواحل" contains the brick "السواح" as a substring, and
 *      "مساكن التعاونيات" contains "التعاون". Substring matching read both as a town.
 *   2. GENERIC BRICK NAMES ARE DROPPED, measured rather than listed. A brick whose name turns up in
 *      the addresses of more than `GENERIC_AREA_SPREAD` different areas is address filler, not a
 *      town — this is what removes "ش الجلاء", "المحكمة", "السيده زينب" and "ش الكورنيش" without
 *      anybody having to enumerate them. Streets are dropped outright by name shape as well.
 *   3. IF THE CURRENT BRICK IS ALSO NAMED IN THE ADDRESS, THE ROW IS DROPPED. "ش الجلاء 1 طنطا"
 *      matched Cairo's ش الجلاء while the customer sits in طنطا — which the address also says. The
 *      existing mapping agrees with the address, so there is no question to ask.
 *
 * Reads PRODUCTION through `SUPABASE_DB_URL` in `.env.local`. READ-ONLY: SELECT only, plus one
 * `pg_temp` helper function that lives in this session's temp schema and vanishes with the
 * connection.
 *
 * Run:  node --experimental-strip-types --experimental-specifier-resolution=node \
 *         scripts/brick-area-address-questions.ts
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

/**
 * A brick name found in the addresses of more than this many different areas is address filler
 * ("المحكمة", "ش الجلاء"), not a town. Measured, so the list never has to be maintained by hand.
 */
const GENERIC_AREA_SPREAD = 8;

/** Every option list ends with an escape hatch, so a case nobody anticipated is still answerable. */
const MOVE_OPTIONS =
  '"Move it — the address is right,'
  + "Leave it — the area it is on now is right,"
  + "Neither — I have written the right area in my note,"
  + "Not sure — I need to check,"
  + 'Other — see my note"';

const GAP_OPTIONS =
  '"Add the town to the area it is credited to now,'
  + "Move them — the far brick is right after all,"
  + "Leave it alone,"
  + "Not sure — I need to check,"
  + 'Other — see my note"';

const CONFIRM_OPTIONS =
  '"Correct — leave it as I fixed it,Wrong — put it back,Not sure — I need to check,Other — see my note"';

type SheetWithValidations = ExcelJS.Worksheet & {
  dataValidations: { add: (range: string, rule: ExcelJS.DataValidation) => void };
};

type CandidateRow = {
  customer_code: string;
  distributor_code: string;
  customer_name: string | null;
  address: string;
  cur_brick: string | null;
  cur_brick_name: string | null;
  cur_area: string | null;
  cur_area_name: string | null;
  cur_region: string | null;
  sug_brick: string;
  sug_brick_name: string;
  sug_area: string;
  sug_area_name: string | null;
  sug_region: string | null;
  value_2026: string;
  months_seen: string | null;
  frozen_months: string | null;
  map_source: string | null;
  tier: string;
};

/**
 * ONE RULING, MANY CUSTOMERS — and why the workbook leads with this rather than the detail.
 *
 * The candidates cluster hard: "every address that says منفلوط is mapped to Assuit 2" is ONE
 * decision covering dozens of pharmacies, not dozens of decisions. A sheet of 2,000 identical
 * dropdowns is a sheet nobody finishes, and finishing is the whole point — so the owner answers the
 * town once and the detail sheets carry the evidence behind it.
 */
type GroupRow = {
  key: string;
  town: string;
  curArea: string;
  sugArea: string;
  sameRegion: boolean;
  customers: number;
  value: number;
  frozen: number;
  samples: string[];
  verdict: "misfiled" | "brick-gap";
};

/**
 * A BIG CLUSTER IS EVIDENCE AGAINST THE SUGGESTION, NOT FOR IT — the rule this sheet turns on.
 *
 * 70 pharmacies mapped to Fayoum have "سنورس" in their address, and the only سنورس brick sits in
 * Port Said. The naive reading is 70 misfiled pharmacies. The true reading is that Senoures is in
 * Fayoum, the brick table has no Fayoum entry for it, and the single far-away brick of that name is
 * the thing that is wrong. Same for المطريه: 58 Dakahlia pharmacies name it, and the only brick is
 * Cairo's — Dakahlia's Matareya simply has no brick.
 *
 * So a cluster that is BIG and lands in a DIFFERENT REGION is reported as a gap in the brick table,
 * which is a different question with a different answer ("add this town to that area"), and never
 * as a list of pharmacies to move. Within one region the same reshuffle is ordinary and believable —
 * منفلوط moving from Assuit 2 to Assuit 1 is 43 pharmacies and is exactly the defect the owner
 * reported — so region equality, not size alone, is what decides.
 */
const BRICK_GAP_CLUSTER = 5;

function groupCandidates(rows: CandidateRow[]): GroupRow[] {
  const groups = new Map<string, GroupRow>();
  for (const row of rows) {
    const key = `${row.cur_area ?? ""}>${row.sug_area}|${row.sug_brick_name}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        town: row.sug_brick_name,
        curArea: `${row.cur_area_name ?? row.cur_area ?? "—"}`,
        sugArea: `${row.sug_area_name ?? row.sug_area}`,
        sameRegion: (row.cur_region ?? "") === (row.sug_region ?? ""),
        customers: 0,
        value: 0,
        frozen: 0,
        samples: [],
        verdict: "misfiled",
      };
      groups.set(key, group);
    }
    group.customers += 1;
    group.value += money(row.value_2026);
    if (row.frozen_months) group.frozen += 1;
    if (group.samples.length < 3 && row.customer_name) group.samples.push(row.customer_name);
  }
  for (const group of groups.values()) {
    group.verdict = !group.sameRegion && group.customers >= BRICK_GAP_CLUSTER ? "brick-gap" : "misfiled";
  }
  return [...groups.values()].sort((a, b) => b.value - a.value || b.customers - a.customers);
}

type AppliedRow = {
  customer_code: string;
  distributor_code: string;
  customer_name: string | null;
  address: string | null;
  was_brick_name: string | null;
  was_area: string | null;
  was_area_name: string | null;
  now_brick_name: string | null;
  now_area: string | null;
  now_area_name: string | null;
  frozen_note: string | null;
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

/** EGP at factory price, rounded — never a unit count (units of different products are never added). */
function money(value: string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

/**
 * ARABIC NORMALISATION, and why it is not optional. The same town is spelled differently by every
 * distributor: أ/إ/آ against ا, ى against ي, ة against ه. Comparing raw strings makes الجماليه and
 * الجمالية two different places. Padding with spaces on both sides is what turns `like` into
 * whole-token matching, which is precision rule 1 above.
 */
const HELPERS = `
create or replace function pg_temp.arn(t text) returns text language sql immutable as $fn$
  select ' ' || btrim(regexp_replace(regexp_replace(
    translate(lower(coalesce(t,'')),'أإآىةئؤ','ااايهيو'),'[^a-z0-9ء-ي ]',' ','g'),'\\s+',' ','g')) || ' '
$fn$;
`;

/**
 * THE CANDIDATE FINDER.
 *
 * `bricks` drops streets by name shape and anything too short to identify a place. `generic` then
 * measures which of the survivors behave like address filler and removes them. `hit` matches a brick
 * name as a whole token sequence inside the address. `agg` keeps only customers whose address points
 * at exactly ONE area, and `final` drops the ones whose current brick the address also names.
 *
 * Two tiers, reported separately and never merged — the owner reads the confidence before the answer:
 *   "Strong"  the matched town is 5+ characters and the customer carries real 2026 money.
 *   "Review"  everything else that survived the three precision rules.
 */
const CANDIDATE_SQL = `
with m as (
  select id, distributor_code, customer_code, customer_name, address, brick_id, area_code, region_code, source,
         pg_temp.arn(address) as addr_n
  from public.source_of_sales_customer_map
  where active and address is not null and length(btrim(address)) > 3
    -- EZ (1011654) and anything else on the even-split roster is deliberately NOT on its own address:
    -- the owner ruled on 2026-08-26 that its units spread across the Cairo+Giza CNS seats, ignoring its
    -- Heliopolis invoice address. It is the single largest customer in the database, so a sheet that
    -- forgot this would put a 1,012,503 EGP "defect" at the top of the list and invite him to undo his
    -- own ruling.
    and regexp_replace(customer_code,'^0+','')
        not in (select regexp_replace(client_code,'^0+','') from public.sos_even_split_customers)
),
bricks as (
  select brick_id, brick_name, area_code, pg_temp.arn(brick_name) as bn,
         length(btrim(brick_name)) as name_len
  from public.source_of_sales_bricks
  where active
    and length(btrim(brick_name)) >= 4
    and brick_name !~ '^\\s*(ش|شارع|طريق|ميدان|حي|حى|كورنيش)\\s'
    and brick_name not like '%ش %'
),
raw_hit as (
  select m.id, b.brick_id, b.brick_name, b.area_code as brick_area, b.bn, b.name_len
  from m join bricks b on m.addr_n like '%' || b.bn || '%'
),
generic as (
  -- Measured filler: one name turning up in the addresses of many different areas is not a town.
  select h.brick_id
  from raw_hit h join m on m.id = h.id
  group by h.brick_id
  having count(distinct m.area_code) > ${GENERIC_AREA_SPREAD}
),
hit as (
  select h.* from raw_hit h where h.brick_id not in (select brick_id from generic)
),
agg as (
  select h.id,
         count(distinct h.brick_area) as n_areas,
         (array_agg(h.brick_id   order by h.name_len desc, h.brick_id))[1] as sug_brick,
         (array_agg(h.brick_name order by h.name_len desc, h.brick_id))[1] as sug_brick_name,
         (array_agg(h.brick_area order by h.name_len desc, h.brick_id))[1] as sug_area,
         max(h.name_len) as best_len
  from hit h group by h.id
),
sales as (
  select regexp_replace(client_code,'^0+','') as code_norm, distributor_code,
         sum(coalesce(value,0)) as value_2026,
         string_agg(distinct invoice_period, ', ' order by invoice_period) as months_seen,
         string_agg(distinct case
              when l.period is not null then invoice_period || ' ' || official_line
              else null end, ', ') as frozen_months
  from public.source_of_sales_import_rows r
  left join public.monthly_closing_locks l
    on l.period = r.invoice_period and l.line = r.official_line and l.unlocked_at is null
  where client_code is not null
  group by 1,2
)
select m.customer_code, m.distributor_code, m.customer_name, m.address,
       m.brick_id as cur_brick, cb.brick_name as cur_brick_name,
       m.area_code as cur_area, ca.name as cur_area_name, m.region_code as cur_region,
       a.sug_brick, a.sug_brick_name, a.sug_area, sa.name as sug_area_name, sb2.region_code as sug_region,
       coalesce(s.value_2026, 0)::text as value_2026,
       s.months_seen, s.frozen_months, m.source as map_source,
       case when a.best_len >= 5 and coalesce(s.value_2026,0) > 0 then 'Strong' else 'Review' end as tier
from agg a
join m on m.id = a.id
left join public.source_of_sales_bricks cb on cb.brick_id = m.brick_id
left join public.source_of_sales_bricks sb2 on sb2.brick_id = a.sug_brick
left join public.areas ca on ca.code = m.area_code
left join public.areas sa on sa.code = a.sug_area
left join sales s on s.code_norm = regexp_replace(m.customer_code,'^0+','')
                 and s.distributor_code = m.distributor_code
where a.n_areas = 1
  and a.sug_area is distinct from m.area_code
  -- Precision rule 3: the address naming the CURRENT brick means the mapping already agrees with it.
  and (cb.brick_name is null or m.addr_n not like '%' || pg_temp.arn(cb.brick_name) || '%')
order by (case when a.best_len >= 5 and coalesce(s.value_2026,0) > 0 then 0 else 1 end),
         coalesce(s.value_2026,0) desc, m.customer_name;
`;

/**
 * The five the owner reported on 2026-09-08, already corrected in the database. They are shown so he
 * can veto any of them — a fix applied from evidence is still a call he is entitled to reverse, and
 * a sheet that hides what was already done invites the same question twice.
 */
const APPLIED_SQL = `
select m.customer_code, m.distributor_code, m.customer_name, m.address,
       pb.brick_name as was_brick_name, p.area_code as was_area, pa.name as was_area_name,
       cb.brick_name as now_brick_name, m.area_code as now_area, ca.name as now_area_name,
       case when m.customer_code like '%1556619'
            then 'August Anti Infective (3 units, 333 EGP) stays on ' || coalesce(pa.name,p.area_code)
                 || ' — that month is published and frozen.'
            else null end as frozen_note
from pharmacy_map_fix_20260908.customer_map_pre p
join public.source_of_sales_customer_map m
  on m.customer_code = p.customer_code and m.distributor_code = p.distributor_code
left join public.source_of_sales_bricks pb on pb.brick_id = p.brick_id
left join public.source_of_sales_bricks cb on cb.brick_id = m.brick_id
left join public.areas pa on pa.code = p.area_code
left join public.areas ca on ca.code = m.area_code
where m.area_code is distinct from p.area_code
order by m.customer_name;
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
  sheet.getRow(2).height = 52;
}

function buildReadMe(
  workbook: ExcelJS.Workbook,
  strong: number,
  review: number,
  applied: number,
  rulings: number,
  gaps: number,
): void {
  const sheet = workbook.addWorksheet("Read me", { properties: { tabColor: { argb: ACCENT_FILL } } });
  sheet.columns = [{ width: 34 }, { width: 112 }];

  addTitle(
    sheet,
    2,
    "Which area does this pharmacy belong to?",
    "Every row is a customer whose address names one town while the system credits its sales to a "
      + "different area — so a District Manager is being paid for sales that belong to someone else, "
      + "or losing sales that are his.",
  );

  const notes: [string, string][] = [
    ["Why you are seeing this", "On 8 September you reported five pharmacies mapped to the wrong area. All five had the same "
      + "shape: the address the distributor sent names a town that sits in a different area from the one "
      + "the customer is mapped to. Most came from the 28 July brick-merge, which collapsed duplicate "
      + "brick names onto a surviving brick and picked the wrong survivor. This sheet is every other "
      + "customer with that same shape."],
    ["What to do", `Go to the 'Answer here' sheet and answer the ${rulings} rulings in column H. Each row `
      + "there is one rule covering every pharmacy with that address town — 'every address that says منفلوط "
      + "while the system credits Assuit 2' is a single decision, not thirty. You should not need the detail "
      + "sheets at all. Leave a row blank to change nothing; a blank is not a 'no', it is simply unanswered, "
      + "and it will come back next time."],
    ["Two different questions", `'Answer here' (${rulings} rulings) is pharmacies on the wrong area. `
      + `'Missing towns' (${gaps} towns) is the opposite finding: a whole group of pharmacies in one area `
      + "name a town whose only brick sits in another region, which means the brick list is missing that "
      + "town rather than the pharmacies being wrong. Answering those two sheets the same way would move "
      + "hundreds of pharmacies across the country, so they are kept apart deliberately."],
    ["The detail sheets", "'Strong' and 'Review' list the individual pharmacies behind those rulings, with "
      + "the address exactly as the distributor sent it. They are there as evidence if a ruling looks wrong, "
      + "and they carry their own dropdown if you want to overrule one pharmacy on its own."],
    ["If neither area is right", "Pick 'Neither — I have written the right area in my note' and write the "
      + "area name in the Note column. That is a better answer than picking the closer of two wrong ones."],
    ["Strong vs Review", `'Strong' (${strong} rows) means the matched town name is long enough to be `
      + `unambiguous and the customer has real 2026 sales behind it. 'Review' (${review} rows) survived the `
      + "same checks but is shorter or has no money on it. Both are worth your time; Strong is worth it first."],
    ["What I already changed", `The 'Already fixed' sheet lists the ${applied} mappings I corrected on 8 `
      + "September from the five you sent. They are live now. If any of them is wrong, say so there and I "
      + "will put it back."],
    ["Published months are not touched", "July, and August Anti Infective, are published and frozen. "
      + "Answering a row here changes the mapping from now on; it does not restate a month you have already "
      + "announced. Where a frozen month is affected the sheet says so, and that part needs your explicit "
      + "instruction before anything moves."],
    ["What this sheet is not", "An address is evidence, not proof. It is typed by the distributor's clerk, "
      + "it often names a street rather than a town, and a wholesaler legitimately sells outside the town it "
      + "sits in. Nothing here has been applied — every row is a question."],
  ];

  let cursor = 4;
  for (const [label, body] of notes) {
    sheet.getCell(`A${cursor}`).value = label;
    sheet.getCell(`A${cursor}`).font = { bold: true, size: 11 };
    sheet.getCell(`A${cursor}`).alignment = { vertical: "top", wrapText: true };
    sheet.getCell(`B${cursor}`).value = body;
    sheet.getCell(`B${cursor}`).alignment = { vertical: "top", wrapText: true };
    sheet.getRow(cursor).height = Math.max(30, Math.ceil(body.length / 95) * 16);
    cursor += 1;
  }
}

function buildCandidateSheet(workbook: ExcelJS.Workbook, name: string, rows: CandidateRow[], blurb: string): void {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [
    { width: 30 }, { width: 13 }, { width: 7 }, { width: 40 },
    { width: 24 }, { width: 24 }, { width: 13 }, { width: 22 }, { width: 26 },
    { width: 34 }, { width: 34 },
  ];

  addTitle(sheet, 11, `${name} — ${rows.length} to decide`, blurb);

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    "Pharmacy", "Customer code", "Dist.", "Address as the distributor sent it",
    "Credited now to", "Address says it is in", "2026 value (EGP)", "Months with sales",
    "Published months affected", "Which area is right?", "Note",
  ];
  styleHeader(sheet, headerRow, 11);

  rows.forEach((row, index) => {
    const excelRow = sheet.getRow(headerRow + 1 + index);
    excelRow.values = [
      row.customer_name ?? "(no name on file)",
      row.customer_code,
      row.distributor_code,
      row.address,
      `${row.cur_brick_name ?? row.cur_brick ?? "—"} — ${row.cur_area_name ?? row.cur_area ?? "—"}`,
      `${row.sug_brick_name} — ${row.sug_area_name ?? row.sug_area}`,
      money(row.value_2026),
      row.months_seen ?? "no sales on file",
      row.frozen_months ?? "none",
      "",
      "",
    ];
    excelRow.alignment = { vertical: "top", wrapText: true };
    excelRow.height = 30;
    if (row.frozen_months) {
      excelRow.getCell(9).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ALERT_FILL } };
      excelRow.getCell(9).font = { bold: true };
    }
    excelRow.getCell(10).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
    excelRow.getCell(11).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
  });

  const lastRow = headerRow + rows.length;
  if (rows.length > 0) {
    // ONE rule over the whole answer column — never one per cell (overlapping sqref = repair prompt).
    (sheet as SheetWithValidations).dataValidations.add(`J${headerRow + 1}:J${lastRow}`, {
      type: "list",
      allowBlank: true,
      formulae: [MOVE_OPTIONS],
      showErrorMessage: true,
      errorTitle: "Pick one, or choose Other",
      error: "Choose from the list, or pick 'Neither' / 'Other' and write what you mean in the Note column.",
    });
  }
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: Math.max(lastRow, headerRow), column: 11 } };
}

function buildGroupSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  groups: GroupRow[],
  title: string,
  blurb: string,
  question: string,
  options: string,
): void {
  const sheet = workbook.addWorksheet(name, { properties: { tabColor: { argb: ACCENT_FILL } } });
  sheet.columns = [
    { width: 24 }, { width: 24 }, { width: 24 }, { width: 12 },
    { width: 15 }, { width: 14 }, { width: 46 }, { width: 34 }, { width: 34 },
  ];

  addTitle(sheet, 9, title, blurb);

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    "Address says this town", "Credited now to", "Address says it is in", "Pharmacies",
    "2026 value (EGP)", "Frozen months", "For example", question, "Note",
  ];
  styleHeader(sheet, headerRow, 9);

  groups.forEach((group, index) => {
    const excelRow = sheet.getRow(headerRow + 1 + index);
    excelRow.values = [
      group.town, group.curArea, group.sugArea, group.customers, group.value,
      group.frozen > 0 ? `${group.frozen} of ${group.customers}` : "none",
      group.samples.join(" · ") || "(no names on file)",
      "", "",
    ];
    excelRow.alignment = { vertical: "top", wrapText: true };
    excelRow.height = 30;
    if (group.frozen > 0) {
      excelRow.getCell(6).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ALERT_FILL } };
      excelRow.getCell(6).font = { bold: true };
    }
    excelRow.getCell(8).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
    excelRow.getCell(9).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
  });

  const lastRow = headerRow + groups.length;
  if (groups.length > 0) {
    (sheet as SheetWithValidations).dataValidations.add(`H${headerRow + 1}:H${lastRow}`, {
      type: "list",
      allowBlank: true,
      formulae: [options],
      showErrorMessage: true,
      errorTitle: "Pick one, or choose Other",
      error: "Choose from the list, or pick 'Other — see my note' and write what you mean in the Note column.",
    });
  }
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: Math.max(lastRow, headerRow), column: 9 } };
}

function buildAppliedSheet(workbook: ExcelJS.Workbook, rows: AppliedRow[]): void {
  const sheet = workbook.addWorksheet("Already fixed");
  sheet.columns = [
    { width: 30 }, { width: 13 }, { width: 7 }, { width: 38 },
    { width: 24 }, { width: 24 }, { width: 40 }, { width: 30 }, { width: 34 },
  ];

  addTitle(
    sheet,
    9,
    `The five you reported — ${rows.length} mappings corrected on 8 September`,
    "These are live. Every one was settled by the address the distributor sent, matched against the "
      + "company's own brick table. If any is wrong, say so in column H and I will put it back — a "
      + "pre-image of every row is saved.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    "Pharmacy", "Customer code", "Dist.", "Address as the distributor sent it",
    "Was credited to", "Now credited to", "Anything still frozen", "Is this right?", "Note",
  ];
  styleHeader(sheet, headerRow, 9);

  rows.forEach((row, index) => {
    const excelRow = sheet.getRow(headerRow + 1 + index);
    excelRow.values = [
      row.customer_name ?? "(no name on file)",
      row.customer_code,
      row.distributor_code,
      row.address ?? "(no address on this distributor's row)",
      `${row.was_brick_name ?? "—"} — ${row.was_area_name ?? row.was_area ?? "—"}`,
      `${row.now_brick_name ?? "—"} — ${row.now_area_name ?? row.now_area ?? "—"}`,
      row.frozen_note ?? "nothing — every month it sells in is still open",
      "",
      "",
    ];
    excelRow.alignment = { vertical: "top", wrapText: true };
    excelRow.height = 34;
    if (row.frozen_note) {
      excelRow.getCell(7).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ALERT_FILL } };
      excelRow.getCell(7).font = { bold: true };
    }
    excelRow.getCell(8).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
    excelRow.getCell(9).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
  });

  const lastRow = headerRow + rows.length;
  if (rows.length > 0) {
    (sheet as SheetWithValidations).dataValidations.add(`H${headerRow + 1}:H${lastRow}`, {
      type: "list",
      allowBlank: true,
      formulae: [CONFIRM_OPTIONS],
      showErrorMessage: true,
      errorTitle: "Pick one, or choose Other",
      error: "Choose from the list, or pick 'Other — see my note' and write what you mean in the Note column.",
    });
  }
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: Math.max(lastRow, headerRow), column: 9 } };
}

function nextFreePath(): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = resolve(
      process.env.PHOENIX_XLSX_DIR ?? "xlsx",
      `pharmacy-area-questions-${stamp}${suffix === 0 ? "" : `-${suffix + 1}`}.xlsx`,
    );
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Could not find a free output filename — clear some old copies first.");
}

async function main(): Promise<void> {
  const env = loadLocalEnv();
  const databaseUrl = env.SUPABASE_DB_URL;
  if (!databaseUrl) throw new Error("SUPABASE_DB_URL is missing from .env.local.");
  const sql = postgres(databaseUrl, { connect_timeout: 20, max: 1, ssl: "require" });
  try {
    await buildWorkbook(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function buildWorkbook(sql: postgres.Sql): Promise<void> {
  await sql.unsafe("set statement_timeout = '600s'");
  await sql.unsafe(HELPERS);

  const candidates = (await sql.unsafe(CANDIDATE_SQL)) as unknown as CandidateRow[];
  const applied = (await sql.unsafe(APPLIED_SQL)) as unknown as AppliedRow[];

  const strong = candidates.filter((row) => row.tier === "Strong");
  const review = candidates.filter((row) => row.tier !== "Strong");

  // A SHEET WITH NOTHING LEFT ON IT IS NOT WRITTEN AT ALL. Handing somebody a form that re-asks
  // answered questions is how the answers stop coming back.
  if (candidates.length === 0) {
    console.log("Nothing outstanding — no customer's address contradicts its area. No workbook written.");
    return;
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce — pharmacy area decisions";
  workbook.created = new Date();

  const groups = groupCandidates(candidates);
  const misfiled = groups.filter((group) => group.verdict === "misfiled");
  const brickGaps = groups.filter((group) => group.verdict === "brick-gap");

  buildReadMe(workbook, strong.length, review.length, applied.length, misfiled.length, brickGaps.length);
  buildGroupSheet(
    workbook,
    "Answer here",
    misfiled,
    `Answer the town once — ${misfiled.length} rulings`,
    "Each row is one rule, not one pharmacy. 'Every customer whose address says منفلوط while the "
      + "system credits Assuit 2' is a single decision covering all of them. Answer column H and the "
      + "detail sheets follow automatically — you should not need to open them unless you want to.",
    "Which area is right?",
    MOVE_OPTIONS,
  );
  buildGroupSheet(
    workbook,
    "Missing towns",
    brickGaps,
    `The brick list looks incomplete — ${brickGaps.length} towns`,
    "These are NOT pharmacies to move. In each row a group of pharmacies in one area all give the same "
      + "town in their address, but the only brick with that name sits in a different region — so the town "
      + "is almost certainly missing from the brick list for the area they are already on. 70 Fayoum "
      + "pharmacies say سنورس and the only سنورس brick is under Port Said. Adding the town is usually the "
      + "answer; moving 70 pharmacies to Port Said is not.",
    "What should happen?",
    GAP_OPTIONS,
  );
  buildCandidateSheet(
    workbook,
    "Strong",
    strong,
    "The address names a town of five characters or more, that town is a brick in a different area, "
      + "and this customer has real 2026 sales riding on the answer. Start here.",
  );
  buildCandidateSheet(
    workbook,
    "Review",
    review,
    "Same checks, but the matched town name is short or the customer has no 2026 sales on file. Worth "
      + "a look once the Strong sheet is done.",
  );
  buildAppliedSheet(workbook, applied);

  const outputPath = nextFreePath();
  mkdirSync(dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);

  const frozen = candidates.filter((row) => row.frozen_months).length;
  console.log(`Wrote ${outputPath}`);
  console.log(`  Answer here   ${misfiled.length} rulings  <- this is what he fills in`);
  console.log(`  Missing towns ${brickGaps.length} towns    <- brick list gaps, a different question`);
  console.log(`  Strong        ${strong.length} rows`);
  console.log(`  Review        ${review.length} rows`);
  console.log(`  Already fixed ${applied.length} rows`);
  console.log(`  ${frozen} of the ${candidates.length} candidates touch a published, frozen month.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
