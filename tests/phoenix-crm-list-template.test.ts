import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { checkWorkbook } from "../scripts/check-workbook-integrity.mjs";
import { buildPhoenixCrmListTemplate } from "../src/lib/phoenix-crm/server/list-template-workbook.ts";
import { excelCellText, loadExcelWorkbook } from "../src/lib/uploads/exceljs-rows.ts";

import {
  foldHeader,
  isTemplateHintRow,
  locateTemplateColumns,
  parseTemplateRow,
  readListTypeCell,
  readTemplateRows,
  TEMPLATE_COLUMNS,
  TEMPLATE_REQUIRED_KEYS,
  TEMPLATE_SEAT_LABEL,
  TEMPLATE_SHEET,
  type TemplateColumnKey,
} from "../src/lib/phoenix-crm/list-template-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the SFE's list template (owner's ask, 2026-10-02): he sends the rep a sheet, the rep
 * fills in his list, SFE uploads it and the list appears.
 *
 * The rules worth having are all about what the sheet may NOT do: it may not carry a place, it may not
 * grade a pharmacy, it may not reach a territory it was not built for, and it may not put a customer on
 * the list without the rep still standing at his door.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

const MIGRATION = "supabase/migrations/20261003000753_phoenix_crm_list_template_bulk_add.sql";

function cells(overrides: Partial<Record<TemplateColumnKey, unknown>> = {}): Partial<Record<TemplateColumnKey, unknown>> {
  return { grade: "A", listType: "PM", name: "Dr Ahmed Shalaby", potentialGrade: "AB", ...overrides };
}

// ── The column contract, shared by the builder and the parser ────────────────────────────────────
function checkColumns(): void {
  assert.deepEqual(
    TEMPLATE_COLUMNS.map((column) => column.key),
    ["listType", "name", "speciality", "grade", "potentialGrade", "phone", "whereToFind", "note"],
    "the sheet's columns, in order — the builder writes these and the parser reads them back",
  );
  // 🔴 NO PLACE COLUMN, EVER. A place is validated once at the door from a live photo and a GPS read,
  //    and its address, brick, area and region are resolved server-side from that point. A latitude in
  //    a spreadsheet is a typed location, which is the one thing that rule forbids.
  for (const forbidden of ["lat", "lon", "latitude", "longitude", "coordinates", "brick", "area", "region", "photo"]) {
    assert.ok(
      !TEMPLATE_COLUMNS.some((column) => column.key.toLowerCase().includes(forbidden) || foldHeader(column.label).includes(forbidden)),
      `the sheet must not carry a "${forbidden}" column — the place is captured at the door, never typed`,
    );
  }
  assert.deepEqual([...TEMPLATE_REQUIRED_KEYS], ["listType", "name"], "a sheet is this template when it names a list and a customer");

  // The parser finds a column by any of its aliases, folded, so a sheet somebody rebuilt still reads.
  const located = locateTemplateColumns(["list", "CUSTOMER NAME", "specialty", " Grade ", "potential", "mobile", "address", "notes"]);
  for (const column of TEMPLATE_COLUMNS) assert.ok(located.has(column.key), `${column.key} is found through its aliases`);
  assert.equal(locateTemplateColumns(["something", "else"]).size, 0, "and a sheet that is not the template matches nothing");
}

// ── The List cell ────────────────────────────────────────────────────────────────────────────────
function checkListCell(): void {
  assert.equal(readListTypeCell("AM"), "AM", "AM is AM");
  assert.equal(readListTypeCell("pm"), "PM", "and a lower-case pm is PM");
  // 🔴 THE REASON THIS FUNCTION EXISTS. `parseListType` answers PM for anything it does not recognise,
  //    which is right for a stored value and catastrophic for a typed cell: a pharmacy typed in lower
  //    case would be filed among the doctors, counted in their KPIs, with nothing going red.
  assert.equal(readListTypeCell("pharmacy"), "Pharmacy", "a lower-case pharmacy is a PHARMACY, never a PM doctor");
  assert.equal(readListTypeCell(" Pharmacy "), "Pharmacy", "spaces do not change what it is");
  assert.equal(readListTypeCell("rubbish"), null, "and a cell that is not one of the three is refused, never guessed");
  assert.equal(readListTypeCell(""), null, "an empty cell is not a list");
}

// ── One row ──────────────────────────────────────────────────────────────────────────────────────
function checkRow(): void {
  const good = parseTemplateRow(9, cells({ note: "Mornings only", phone: "0100 123 4567", speciality: "Pediatrics", whereToFind: "Above the pharmacy" }));
  assert.equal(good.kind, "row");
  if (good.kind !== "row") return;
  assert.equal(good.value.row, 9, "a refusal and a row both name the sheet's own row number");
  // Exactly what `parseCustomerPhone` does with one the rep types: spaces out, digits kept, and only a
  // leading 00 turned into a +. Asserted against the real behaviour rather than a guess at it.
  assert.equal(good.value.phone, "01001234567", "the phone is read the way the app reads one he types");
  const international = parseTemplateRow(3, cells({ phone: "0020 100 123 4567" }));
  assert.equal(international.kind === "row" ? international.value.phone : null, "+201001234567", "and a 00 prefix becomes a +");
  assert.equal(parseTemplateRow(3, cells({ phone: "12" })).kind, "refused", "a phone too short to be one is refused");
  assert.equal(good.value.whereToFind, "Above the pharmacy");

  assert.equal(parseTemplateRow(2, {}).kind, "blank", "the sheet's spare rows are skipped in silence");
  assert.equal(parseTemplateRow(2, cells({ name: "" })).kind, "refused", "a row with no name is refused");
  assert.equal(parseTemplateRow(2, cells({ name: "Dr" })).kind, "refused", "and so is a name too short to be one");
  assert.equal(parseTemplateRow(2, cells({ listType: "" })).kind, "refused", "a row with no list is refused");
  assert.equal(parseTemplateRow(2, cells({ listType: "Doctors" })).kind, "refused", "and one whose list is not one of the three");

  // 🔴 A REP NEVER SETS A GRADE, SO THE SHEET MUST CARRY ONE. A doctor with no grade and no potential
  //    is the rep's own proposal with nobody's decision on it, which is what this route exists to avoid.
  assert.equal(parseTemplateRow(2, cells({ grade: "" })).kind, "refused", "a doctor with no grade is refused");
  assert.equal(parseTemplateRow(2, cells({ potentialGrade: "" })).kind, "refused", "and one with no potential");
  assert.equal(parseTemplateRow(2, cells({ grade: "D" })).kind, "refused", "D is not a grade");
  assert.equal(parseTemplateRow(2, cells({ potentialGrade: "CC" })).kind, "refused", "CC is not a potential");

  // 🔴 AND A PHARMACY CARRIES NEITHER. It is in no KPI, has no frequency and no target, so a grade on
  //    one is a number nothing reads — refused rather than dropped, because silently ignoring a cell
  //    somebody filled is how a sheet and a list come to disagree.
  const pharmacy = parseTemplateRow(4, { grade: "", listType: "Pharmacy", name: "El Ezaby Pharmacy", potentialGrade: "" });
  assert.equal(pharmacy.kind, "row", "a pharmacy with no grade is fine");
  if (pharmacy.kind === "row") {
    assert.equal(pharmacy.value.listType, "Pharmacy");
    assert.equal(pharmacy.value.grade, null);
    assert.equal(pharmacy.value.potentialGrade, null);
  }
  assert.equal(
    parseTemplateRow(4, { grade: "A", listType: "Pharmacy", name: "El Ezaby Pharmacy" }).kind,
    "refused",
    "a graded pharmacy is refused, not quietly stripped",
  );
}

// ── The whole sheet ──────────────────────────────────────────────────────────────────────────────
function checkSheet(): void {
  const { customers, refused } = readTemplateRows([
    { cells: cells({ name: "Dr One" }), row: 7 },
    { cells: {}, row: 8 },
    { cells: cells({ name: "Dr One" }), row: 9 },
    { cells: cells({ grade: "", name: "Dr Two" }), row: 10 },
    { cells: cells({ listType: "AM", name: "Dr One" }), row: 11 },
  ]);
  assert.deepEqual(customers.map((customer) => customer.name), ["Dr One", "Dr One"], "one PM Dr One and one AM Dr One are two people");
  assert.deepEqual(
    refused.map((entry) => entry.row),
    [9, 10],
    "the second PM Dr One and the ungraded row are refused, each by its own row number",
  );
  assert.match(refused[0]!.reason, /row 7/, "and a duplicate names the row it duplicates, so the SFE can see both");
}

// ── The sheet names its own territory ────────────────────────────────────────────────────────────
function checkSeatMarker(): void {
  const service = read("src/lib/phoenix-crm/server/list-template.ts");
  assert.match(service, /function seatMarkerOf/, "the sheet carries the territory it was built for");
  // 🔴 This pinned `if (marked && marked !== seat.seatId)` — the defective shape, where a sheet with NO
  // marker was waved through onto whichever territory was picked. The `marked &&` was the bug, and the
  // test held it in place. Both arms are now separate and both refuse; `checkReviewEdges` pins them.
  assert.match(
    service,
    /if \(marked !== seat\.seatId\)/,
    "and an upload against another territory is refused — nothing downstream would ever notice that slip",
  );
  const workbook = read("src/lib/phoenix-crm/server/list-template-workbook.ts");
  assert.match(workbook, /TEMPLATE_SEAT_LABEL/, "the builder writes the marker the parser reads");
  assert.ok(TEMPLATE_SEAT_LABEL.length > 0 && TEMPLATE_SHEET === "Customers", "both are the shared contract, not a literal in two files");
}

// ── Who may do it, and what it writes ───────────────────────────────────────────────────────────
function checkGateAndWrite(): void {
  const service = read("src/lib/phoenix-crm/server/list-template.ts");
  assert.match(
    service,
    /if \(!canReadIntegrityBoard\(viewer\)\)/,
    "the gate is the integrity board's own two-reader predicate — never a second copy of the role list",
  );
  // `canApprove`, never `canUpdate`: SFE holds read and approve only, so an update gate would refuse
  // the one person the owner's ask names. Same verb as moving a place, the module's other two-reader act.
  assert.match(service, /if \(!viewer\.canApprove\)/, "and the right it asks for is the one SFE actually holds");
  assert.match(service, /assertListLoader\(viewer\);/, "every entry point asks it");

  const page = read("app/(admin)/admin/phoenix-crm/list-template/page.tsx");
  assert.match(page, /canReadIntegrityBoard\(viewer\)/, "the page gates on the same predicate");
  assert.match(page, /redirect\("\/admin"\)/, "and refuses by redirect, so it never describes itself to somebody who may not read it");
  assert.match(page, /!viewer\.canApprove/, "the page asks for the same right as the service");

  const migration = readFileSync(new URL(MIGRATION, ROOT), "utf8").replace(/\r\n/g, "\n");
  // 🔴 LOADED, NOT VALIDATED. The whole design rests on this one word: the customer appears under To
  //    validate and the rep still captures the photo and the location at his door.
  assert.match(migration, /values \(\s*\n?\s*v_seat, v_line, v_list_type, left\(v_name, 200\)/, "the loader inserts the customer");
  assert.match(migration, /'new', 'pending',/, "as pending, and as origin new — he came from a sheet, not from iReports360");
  assert.match(migration, /null, null, v_actor, v_is_test, v_phone,/, "with validated_at and validated_by left NULL");
  assert.match(migration, /raise exception 'phoenix_crm:too_many_rows'/, "and a sheet cannot load a book at a territory");
  assert.match(migration, /'already_on_the_list'/, "a customer already on the list is skipped by name, not by aborting the load");
  assert.match(migration, /revoke execute on function public\.phoenix_crm_load_list_customers\(jsonb\) from public, anon, authenticated;/, "the loader is service-role only");

  // The validate mode a loaded customer needs, and the one thing it must refuse.
  assert.match(migration, /elsif v_mode = 'listed' then/, "a customer on the list with no vendor contact can be validated at the door");
  assert.match(migration, /if v_customer\.status = 'dropped' then\s+--[^\n]*\n\s+raise exception 'phoenix_crm:archived';/, "and never one in the frozen Archive");
  assert.match(migration, /if v_customer\.status <> 'pending' then\s+raise exception 'phoenix_crm:already_validated';/, "nor one already validated");
  assert.doesNotMatch(migration, /elsif v_mode = 'restore' then/, "the retired restore mode does not come back with it");
}

// ── The rep's own screens reach him ─────────────────────────────────────────────────────────────
function checkRepCanValidate(): void {
  const board = read("src/components/phoenix-crm/customer-list-board.tsx");
  // 🔴 THE OLD FALLBACK WOULD HAVE STRANDED EVERY LOADED CUSTOMER. `rowActionFor` offered Open for a
  //    pending row with no iReports360 contact, because the Validate screen could only open on a live
  //    vendor entry — so a customer loaded from a sheet would have sat on the list with no way off it.
  assert.match(
    board,
    /if \(action === "validate" && !canValidate\) return "open";/,
    "a pending row carries Validate whether or not iReports360 ever knew him",
  );
  assert.doesNotMatch(board, /customer\.referenceContactCrmId === null\) return "open"/, "the contact-id fallback is gone");

  const tab = read("src/components/phoenix-crm/list-tab.tsx");
  assert.match(tab, /go\(\{ name: "validate-listed", customerId: customer\.customerId \}\);/, "and the press opens the listed subject");
  const screens = read("src/components/phoenix-crm/list-screens.tsx");
  assert.match(screens, /\| \{ mode: "listed"; customerId: string \}/, "which is the third validate subject");
  assert.match(
    screens,
    /if \(subject\.mode === "listed"\) return \{ seatId, test, mode: "listed", customerId: subject\.customerId, phone: phoneValue, place \};/,
    "the save sends the place and the phone, and never the name or the grades the SFE set",
  );
  assert.match(screens, /intake\?\.where/, "and the rep is shown where to find a customer he has never visited");

  // 🔴 THE CHAIN, END TO END — THE SEAM NOTHING WAS CHECKING AND WHERE THE FEATURE DIED.
  //
  // The screen sent `listed`, the SQL had its `listed` branch, and `validateCustomer` in between knew
  // only reference / new / outside, so every press fell through to "Reload the page and try again."
  // and every loaded customer sat in To validate for ever. Both ends were pinned on their own and both
  // were green; the link between them was pinned by nothing. Found in review, 2026-10-03.
  //
  // So this walks all three in one assertion block: the mode the SCREEN sends, the arm the SERVICE
  // takes for it, and the branch the SQL answers with. A mode added to one end and not the others
  // fails here rather than in a rep's hand at a clinic door.
  const service = read("src/lib/phoenix-crm/server/list.ts");
  const validate = service.slice(service.indexOf("export async function validateCustomer("), service.indexOf("payload.place = await placePayload("));
  const sent = [...screens.matchAll(/mode: "(reference|listed|new|outside)"/g)].map((match) => match[1]!);
  for (const mode of new Set(sent)) {
    assert.ok(
      new RegExp(`mode === "${mode}"`).test(validate),
      `the service has an arm for "${mode}" — the mode the Validate screen actually sends, or the press dies on "Reload the page and try again."`,
    );
  }
  assert.match(validate, /payload\.mode = "listed";\s*\n\s*payload\.customer_id = body\.customerId;/, "and listed forwards the customer id the SQL branch reads");
  assert.match(validate, /if \(!isUuid\(body\.customerId\)\) throw validationError\(/, "checked as a uuid first, so a bad id is words and not a 500");

  const sql = readFileSync("supabase/migrations/20261003000753_phoenix_crm_list_template_bulk_add.sql", "utf8");
  assert.match(sql, /elsif v_mode = 'listed' then/, "and the SQL the service calls has that branch");
  assert.match(sql, /\(p ->> 'customer_id'\)::uuid/, "reading the very key the service sends");
}

/**
 * 🔴 THE LOADER'S GRADE GUARD NEVER FIRED, AND ONLY A LIVE RUN COULD SHOW IT.
 *
 * `if v_list_type <> 'Pharmacy' and (v_grade not in ('A','B','C') or v_potential not in (...))`
 *
 * An empty sheet cell leaves `v_grade` NULL, and in SQL `NULL not in (...)` is NULL, not TRUE. `NULL or
 * NULL` is NULL, `if NULL then` does not fire — so an UNGRADED doctor was INSERTED onto a rep's list as
 * `pending` with `grade = NULL`, breaking the owner's locked rule that every doctor on a list carries
 * A/B/C and a potential set by his district manager or by SFE.
 *
 * Measured on PRODUCTION on 2026-10-03 by loading a test-world sheet: the row came back `loaded`, while
 * the three verdicts either side of it were right, which is why nothing looked wrong. `parseTemplateRow`
 * refuses the same row before the RPC is called, so the upload path was safe and the whole suite stayed
 * green — and this function, whose own comment calls itself the authority, was not one. Fixed by
 * migration 20261003075335 with `coalesce(..., '')`, which is a real value and compares as one.
 *
 * Pinned on BOTH halves, because either alone would have passed while the defect shipped:
 * the SQL must use `coalesce`, and `parseTemplateRow` must refuse every shape the SQL refuses.
 */
function checkGradeGuard(): void {
  const fix = readFileSync("supabase/migrations/20261003075335_phoenix_crm_load_list_grade_guard.sql", "utf8");
  assert.match(
    fix,
    /coalesce\(v_grade, ''\) not in \('A', 'B', 'C'\)\s*\n?\s*or coalesce\(v_potential, ''\) not in/,
    "the SQL guard compares a real value, never a bare NULL column",
  );
  assert.doesNotMatch(fix, /\(\s*v_grade not in \('A', 'B', 'C'\)/, "and the NULL-swallowing form is gone");

  // The caller refuses every shape the database refuses — the four the live probe sent after the fix.
  const base = { listType: "PM", name: "Dr Mahmoud Fathy", speciality: "Pediatrics" } as const;
  const shapes: ReadonlyArray<readonly [string, Partial<Record<TemplateColumnKey, unknown>>]> = [
    ["no grade and no potential", { ...base }],
    ["a grade but no potential", { ...base, grade: "B" }],
    ["a potential but no grade", { ...base, potentialGrade: "BB" }],
    ["a grade that is not one", { ...base, grade: "X", potentialGrade: "AA" }],
  ];
  for (const [what, cells] of shapes) {
    const verdict = parseTemplateRow(30, cells);
    assert.equal(verdict.kind, "refused", `a doctor with ${what} is refused by the caller too`);
  }
  // And the one good shape still loads, so the guard is not simply refusing everything.
  assert.equal(parseTemplateRow(31, { ...base, grade: "A", potentialGrade: "AC" }).kind, "row", "a fully graded doctor still loads");
  // A pharmacy takes none of it, which is the other side of the same branch.
  assert.equal(parseTemplateRow(32, { listType: "Pharmacy", name: "El Ezaby Pharmacy" }).kind, "row", "a pharmacy needs no grade");
  assert.equal(parseTemplateRow(33, { listType: "Pharmacy", name: "El Ezaby Pharmacy", grade: "A" }).kind, "refused", "and may not carry one");
}

/**
 * The layer no source assertion can stand in for: BUILD the workbook, check the bytes, then read it
 * back through the parser's own contract.
 *
 * 🔴 A WORKBOOK BUILDER IS VERIFIED IN LAYERS BECAUSE EACH ONE MISSES WHAT THE OTHERS CATCH. The
 * source says what it meant to write; the integrity check says the file is a valid .xlsx at all; only a
 * readback says the sheet the builder wrote is the sheet the parser can read. The builder and the parser
 * share their tokens through `list-template-rules.ts` precisely so this can be asserted rather than
 * hoped for.
 */
async function checkBuildsAndReadsBack(): Promise<void> {
  const bytes = await buildPhoenixCrmListTemplate({
    existing: [{ grade: "A", listType: "PM", name: "Dr Already There", speciality: "Pediatrics", status: "On the list" }],
    generatedAtIso: "2026-10-03T06:00:00.000Z",
    lineName: "Pedia",
    preparedFor: "Omar Gawish",
    repName: "A Rep",
    seatId: "SEAT-PED-REP-AB1",
    territoryName: "Alex / Beheira 1 · Pedia",
  });
  assert.ok(bytes.length > 4000, "the template is a real workbook, not an empty one");

  const problems = await checkWorkbook(bytes, { quiet: true });
  assert.deepEqual(problems, [], "and the emitted bytes pass the repo's own workbook integrity check");

  // Read it back the way the upload does: find the sheet, the seat marker and the header row.
  const workbook = await loadExcelWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const sheet = workbook.getWorksheet(TEMPLATE_SHEET);
  assert.ok(sheet, `the fillable sheet is named ${TEMPLATE_SHEET}, which is what the parser asks for`);
  if (!sheet) return;

  let marker: string | null = null;
  let header: { row: number; columns: Map<TemplateColumnKey, number> } | null = null;
  for (let rowNumber = 1; rowNumber <= 14; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values: unknown[] = [];
    for (let column = 1; column <= 10; column += 1) values.push(excelCellText(row.getCell(column).value));
    if (foldHeader(values[0]) === foldHeader(TEMPLATE_SEAT_LABEL)) marker = String(values[1] ?? "");
    const columns = locateTemplateColumns(values);
    if (!header && TEMPLATE_REQUIRED_KEYS.every((key) => columns.has(key))) header = { columns, row: rowNumber };
  }
  assert.equal(marker, "SEAT-PED-REP-AB1", "the territory it was built for is readable from beside its own label");
  assert.ok(header, "and the header row is found within the rows the parser scans");
  if (!header) return;
  for (const column of TEMPLATE_COLUMNS) {
    assert.ok(header.columns.has(column.key), `${column.key} is where the parser expects to find it`);
  }

  // 🔴 THE HINT ROW IS BLANK, NOT REFUSED — and this assertion USED TO SAY `refused`, which is how the
  // defect shipped green. "Not loaded as a customer" was true of a refusal too, so the test never looked
  // at what the SFE is TOLD: every upload of an untouched template came back with one refused row,
  // telling him to go and fix the instruction line Phoenix wrote for him. Found in review, 2026-10-03.
  const hintRow = sheet.getRow(header.row + 1);
  const hintCells: Partial<Record<TemplateColumnKey, unknown>> = {};
  for (const [key, index] of header.columns) hintCells[key] = excelCellText(hintRow.getCell(index + 1).value);
  assert.equal(parseTemplateRow(header.row + 1, hintCells).kind, "blank", "the sheet's own hint row is passed over in silence, never reported to the SFE as his mistake");

  // The whole sheet as the importer reads it: every row after the header, nothing typed in. An
  // untouched template must load nothing AND refuse nothing — a refusal here is a sentence a real SFE
  // would read on a good upload, which is the thing the per-row check above cannot see.
  const untouched: Array<{ row: number; cells: Partial<Record<TemplateColumnKey, unknown>> }> = [];
  for (let rowNumber = header.row + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const cells: Partial<Record<TemplateColumnKey, unknown>> = {};
    for (const [key, index] of header.columns) cells[key] = excelCellText(row.getCell(index + 1).value);
    untouched.push({ cells, row: rowNumber });
  }
  const asRead = readTemplateRows(untouched);
  assert.deepEqual(asRead.refused, [], "an untouched template refuses NOTHING — the SFE is never told his own blank sheet is wrong");
  assert.deepEqual(asRead.customers, [], "and it loads nothing either");

  // And a row filled in the way a rep fills one survives the round trip.
  const filled = sheet.getRow(header.row + 2);
  const write = (key: TemplateColumnKey, value: string) => {
    const index = header?.columns.get(key);
    if (index !== undefined) filled.getCell(index + 1).value = value;
  };
  write("listType", "pharmacy");
  write("name", "El Ezaby Pharmacy");
  const cellsBack: Partial<Record<TemplateColumnKey, unknown>> = {};
  for (const [key, index] of header.columns) cellsBack[key] = excelCellText(filled.getCell(index + 1).value);
  const verdict = parseTemplateRow(header.row + 2, cellsBack);
  assert.equal(verdict.kind, "row", "a row typed into the sheet reads back as a customer");
  assert.equal(verdict.kind === "row" ? verdict.value.listType : null, "Pharmacy", "and a lower-case pharmacy survives as a PHARMACY");
}

/**
 * The three things the 2026-10-03 review caught, each of which read as correct in the source it sat in.
 */
function checkReviewEdges(): void {
  // (a) The hint row is recognised by VALUE, against the builder's own hints — so the sheet and the
  // parser cannot drift. A row where the SFE typed over SOME columns is not the hint row.
  const hintsOnly = Object.fromEntries(TEMPLATE_COLUMNS.map((column) => [column.key, column.hint])) as Record<TemplateColumnKey, string>;
  assert.equal(isTemplateHintRow(hintsOnly), true, "the untouched guidance row is recognised");
  assert.equal(isTemplateHintRow({ ...hintsOnly, name: "Dr Mahmoud Fathy" }), false, "but one he has typed a real name into is judged as a customer");
  const empty = Object.fromEntries(TEMPLATE_COLUMNS.map((column) => [column.key, ""])) as Record<TemplateColumnKey, string>;
  assert.equal(isTemplateHintRow(empty), false, "and an empty row is blank on its own account, never 'the hint row'");

  const service = stripComments(readFileSync("src/lib/phoenix-crm/server/list-template.ts", "utf8"));

  // (b) The picker's customer counts are PAGED. `.limit(n)` cannot raise PostgREST's 1,000-row cap, so
  // an unpaged read counted the first page and the territories sorting after it read 0 — and a 0 there
  // invites the SFE to load a list that already exists, twice.
  assert.match(service, /readEveryPage</, "the per-seat counts are read through the module's pager");
  assert.doesNotMatch(service, /\.limit\(\s*\d{4,}\s*\)/, "never a four-figure .limit(), which reads as a ceiling it cannot set");
  const counting = service.slice(service.indexOf("async function countCustomersPerSeat("), service.indexOf("export type ListTemplateImportResult"));
  assert.match(counting, /whenFull:\s*"refuse"/, "and a count the picker PRINTS fails loudly rather than reading low");
  assert.match(counting, /\.order\("id"/, "paged on a total order, or the walk repeats and skips rows");

  // (c) A sheet that does not say which territory it is for is REFUSED. The marker is the only thing
  // between a whole graded list and the wrong rep; accepting a null one threw it away in exactly the
  // case it exists for.
  const importer = service.slice(service.indexOf("export async function importListTemplate("));
  assert.match(importer, /if \(!marked\) \{\s*throw validationError\(/, "a missing marker is refused, not just a mismatched one");
  assert.match(importer, /if \(marked !== seat\.seatId\) \{/, "and a mismatched one still names both territories");
}

export async function runPhoenixCrmListTemplateTests() {
  checkColumns();
  checkListCell();
  checkRow();
  checkSheet();
  checkSeatMarker();
  checkGateAndWrite();
  checkRepCanValidate();
  checkReviewEdges();
  checkGradeGuard();
  await checkBuildsAndReadsBack();
}
