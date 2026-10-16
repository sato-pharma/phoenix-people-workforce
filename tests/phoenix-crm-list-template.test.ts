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
  locateExistingColumns,
  readTemplateHoursRows,
  readTemplateRows,
  TEMPLATE_COLUMNS,
  TEMPLATE_EXISTING_REQUIRED_KEYS,
  TEMPLATE_REQUIRED_KEYS,
  TEMPLATE_SEAT_LABEL,
  TEMPLATE_SHEET,
  type TemplateColumnKey,
  type TemplateExistingColumnKey,
} from "../src/lib/phoenix-crm/list-template-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the SFE's list template (owner's ask, 2026-10-02): he sends the rep a sheet, the rep
 * fills in his list, SFE uploads it and the list appears.
 *
 * The rules worth having: the grade and the potential are OPTIONAL (owner, 2026-10-03 — a pharmacy
 * carries neither, and an ungraded doctor loads and waits to be validated); the sheet may not carry a
 * place; it may not reach a territory it was not built for; and it may not put a customer on the list
 * without the rep still standing at his door.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

const MIGRATION = "supabase/migrations/20261003000753_phoenix_crm_list_template_bulk_add.sql";
const MIGRATION_HOURS = "supabase/migrations/20261005221500_phoenix_crm_list_sheet_days_and_hours.sql";

function cells(overrides: Partial<Record<TemplateColumnKey, unknown>> = {}): Partial<Record<TemplateColumnKey, unknown>> {
  return { grade: "A", listType: "PM", name: "Dr Ahmed Shalaby", potentialGrade: "AB", ...overrides };
}

// ── The column contract, shared by the builder and the parser ────────────────────────────────────
function checkColumns(): void {
  assert.deepEqual(
    TEMPLATE_COLUMNS.map((column) => column.key),
    ["listType", "name", "speciality", "grade", "potentialGrade", "phone", "daysAndHours", "whereToFind", "note"],
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
  const located = locateTemplateColumns(["list", "CUSTOMER NAME", "specialty", " Grade ", "potential", "mobile", " TIMINGS ", "address", "notes"]);
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

  // 🔴 THE GRADE AND THE POTENTIAL ARE OPTIONAL (owner, 2026-10-03): no row is refused over either one.
  //    A doctor with neither loads with both left null — he waits under To validate, and the grade is
  //    set later through the admission door, which is where it was always decided.
  const noGrade = parseTemplateRow(2, cells({ grade: "", potentialGrade: "" }));
  assert.equal(noGrade.kind, "row", "a doctor with no grade and no potential loads, it is not refused");
  if (noGrade.kind === "row") {
    assert.equal(noGrade.value.grade, null, "and the missing grade is stored null");
    assert.equal(noGrade.value.potentialGrade, null, "and the missing potential null");
  }
  // An unrecognised value is DROPPED to null, never a refusal: the function still cannot write a junk
  // grade, it simply no longer blocks the row over one.
  const junk = parseTemplateRow(2, cells({ grade: "D", potentialGrade: "CC" }));
  assert.equal(junk.kind, "row", "a doctor with a value that is not a grade still loads");
  if (junk.kind === "row") {
    assert.equal(junk.value.grade, null, "the non-grade 'D' is dropped to null");
    assert.equal(junk.value.potentialGrade, null, "and the non-potential 'CC' too");
  }
  // A real grade and potential still survive, so optional is not the same as ignored.
  const graded = parseTemplateRow(2, cells({ grade: "B", potentialGrade: "BC" }));
  assert.equal(graded.kind === "row" ? graded.value.grade : null, "B", "a real grade is kept");
  assert.equal(graded.kind === "row" ? graded.value.potentialGrade : null, "BC", "and a real potential");

  // 🔴 A PHARMACY CARRIES NEITHER, AND A GRADE TYPED ON ONE IS IGNORED, NOT REFUSED (owner, 2026-10-03:
  //    "ignore it, let them load"). It is in no KPI and has no target, so the value means nothing — the
  //    row loads with both null rather than being blocked.
  const pharmacy = parseTemplateRow(4, { grade: "", listType: "Pharmacy", name: "El Ezaby Pharmacy", potentialGrade: "" });
  assert.equal(pharmacy.kind, "row", "a pharmacy with no grade is fine");
  if (pharmacy.kind === "row") {
    assert.equal(pharmacy.value.listType, "Pharmacy");
    assert.equal(pharmacy.value.grade, null);
    assert.equal(pharmacy.value.potentialGrade, null);
  }
  const gradedPharmacy = parseTemplateRow(4, { grade: "A", listType: "Pharmacy", name: "El Ezaby Pharmacy", potentialGrade: "AB" });
  assert.equal(gradedPharmacy.kind, "row", "a pharmacy with a grade typed on it loads — the grade is ignored, not refused");
  if (gradedPharmacy.kind === "row") {
    assert.equal(gradedPharmacy.value.grade, null, "and the ignored grade is stored null");
    assert.equal(gradedPharmacy.value.potentialGrade, null, "and the ignored potential too");
  }
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
  assert.deepEqual(
    customers.map((customer) => customer.name),
    ["Dr One", "Dr Two", "Dr One"],
    "a PM Dr One, the now-optional ungraded Dr Two, and an AM Dr One all load",
  );
  assert.deepEqual(
    refused.map((entry) => entry.row),
    [9],
    "only the second PM Dr One is refused — the ungraded doctor now loads, not refused",
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
  // Since the shared places landed (2026-10-09) the evidence is one of TWO doors — a captured `place`
  // at the customer's own clinic, or a `seated` row inside a validated polyclinic — so the payload
  // spreads `...at` instead of naming `place`. What this pins is unchanged: the listed save carries
  // the evidence and the phone and NOTHING the SFE set, and `at` is exactly those two keys.
  // 🔴 And only the SEATING may carry a null photo (owner, 2026-10-10) — the own-door branch goes
  // through `photoAtOwnDoor`, which keeps a signboard non-null in `placePayload`'s own signature.
  assert.match(
    screens,
    /const at =\s*\n?\s*door === "shared" \? \{ seated: seatedPayload\(photo, seated\) \} : \{ place: placePayload\(photoAtOwnDoor\(photo\), draft\) \};/,
    "the evidence is one door or the other: a captured place, or a seat in a shared place",
  );
  assert.match(
    screens,
    /if \(subject\.mode === "listed"\) return \{ seatId, test, mode: "listed", customerId: subject\.customerId, phone: phoneValue, \.\.\.at \};/,
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
 * 🔴 THE GRADE AND THE POTENTIAL ARE OPTIONAL ON THE SHEET (owner, 2026-10-03: "make the grade and the
 * potential optional, not required").
 *
 * An SFE's 170-row sheet came back "0 of 170 loaded" — the doctor rows refused for an empty Potential
 * and the pharmacy rows for a typed Grade. The owner made both optional, and chose, asked directly, that
 * a grade typed on a pharmacy is IGNORED rather than refused ("ignore it, let them load"). This replaces
 * the `grade_required` guard added hours earlier in 20261003075335, which was itself correct for the
 * rule as it stood then.
 *
 * The loosening is the BULK SHEET alone. The admission door is untouched: `phoenix_crm_decide_request`
 * still raises `potential_grade_required` before a district manager approves an add — pinned by
 * phoenix-crm-list-admission.test.ts.
 *
 * Pinned on BOTH halves, the lesson of the guard it replaces: the SQL (20261003090000) sanitises grade
 * and potential to null with no `grade_required` or `pharmacy_has_no_grade` skip, and the caller refuses
 * none of the shapes the sheet can carry — each loads with the value it should store.
 */
function checkGradeOptional(): void {
  const live = readFileSync("supabase/migrations/20261003090000_phoenix_crm_load_list_optional_grade.sql", "utf8");
  assert.doesNotMatch(live, /'grade_required'/, "the loader no longer refuses a doctor over a missing grade");
  assert.doesNotMatch(live, /'pharmacy_has_no_grade'/, "nor a pharmacy over a typed one");
  assert.match(
    live,
    /coalesce\(v_row ->> 'grade', ''\) in \('A', 'B', 'C'\)/,
    "a doctor's grade is kept only when it is a real one",
  );
  assert.match(
    live,
    /coalesce\(v_row ->> 'potential_grade', ''\) in \('AA', 'AB', 'AC', 'BA', 'BB', 'BC'\)/,
    "and his potential only when it is a real one — anything else is written null, never refused",
  );
  assert.match(live, /v_list_type <> 'Pharmacy'/, "a pharmacy carries neither, whatever the sheet typed");

  // The caller loads every shape the live probe once sent, each with the value it should store. None is
  // a refusal any more — grade and potential are optional and sanitised, never a reason to drop the row.
  const base = { listType: "PM", name: "Dr Mahmoud Fathy", speciality: "Pediatrics" } as const;
  const shapes: ReadonlyArray<readonly [string, Partial<Record<TemplateColumnKey, unknown>>, string | null, string | null]> = [
    ["no grade and no potential", { ...base }, null, null],
    ["a grade but no potential", { ...base, grade: "B" }, "B", null],
    ["a potential but no grade", { ...base, potentialGrade: "BB" }, null, "BB"],
    ["a value that is not a grade", { ...base, grade: "X", potentialGrade: "AA" }, null, "AA"],
  ];
  for (const [what, cells, grade, potential] of shapes) {
    const verdict = parseTemplateRow(30, cells);
    assert.equal(verdict.kind, "row", `a doctor with ${what} loads — grade and potential are optional`);
    if (verdict.kind === "row") {
      assert.equal(verdict.value.grade, grade, `and stores grade ${grade ?? "null"}`);
      assert.equal(verdict.value.potentialGrade, potential, `and potential ${potential ?? "null"}`);
    }
  }
  // A fully graded doctor keeps both, so optional is not the same as ignored.
  const full = parseTemplateRow(31, { ...base, grade: "A", potentialGrade: "AC" });
  assert.equal(full.kind === "row" ? full.value.grade : null, "A", "a fully graded doctor keeps his grade");
  assert.equal(full.kind === "row" ? full.value.potentialGrade : null, "AC", "and his potential");
  // A pharmacy loads whether or not a grade was typed on it; the grade is dropped either way.
  assert.equal(parseTemplateRow(32, { listType: "Pharmacy", name: "El Ezaby Pharmacy" }).kind, "row", "a pharmacy needs no grade");
  const gradedPharmacy = parseTemplateRow(33, { listType: "Pharmacy", name: "El Ezaby Pharmacy", grade: "A" });
  assert.equal(gradedPharmacy.kind, "row", "and one with a grade typed on it still loads — ignored, not refused");
  assert.equal(gradedPharmacy.kind === "row" ? gradedPharmacy.value.grade : "x", null, "the pharmacy's grade is dropped to null");
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
    existing: [
      // One already validated: his hours are the rep's, and the sheet must not invite them to be retyped.
      { acceptsHours: false, daysAndHours: "Sat 5:00 PM – 8:00 PM", grade: "A", listType: "PM", name: "Dr Already There", speciality: "Pediatrics", status: "On the list" },
      // One still waiting, with nothing known: this is the row the SFE writes the hours on.
      { acceptsHours: true, daysAndHours: null, grade: "B", listType: "AM", name: "Dr Waiting To Be Seen", speciality: "Internal medicine", status: "Waiting to be validated" },
      // Validated with no hours recorded: the cell must say it will do nothing, or the sheet invites
      // work the upload silently drops.
      { acceptsHours: false, daysAndHours: null, grade: "C", listType: "PM", name: "Dr Validated No Hours", speciality: "Cardiology", status: "On the list" },
    ],
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

  // ── The second sheet, as the upload actually reads it ──────────────────────────────────────────
  //
  // 🔴 THE EMITTED WORKBOOK, NOT THE BUILDER'S SOURCE. This sheet is an INPUT now, and the two ways it
  // could fail are both invisible in the code: a header the locator does not recognise, and Excel
  // reading "5:00 PM - 8:00 PM" as a date and handing the upload a serial number where a clinic's
  // evening should be. Both only show up by reading the bytes back through the real readers.
  const second = workbook.getWorksheet("Already on the list");
  assert.ok(second, "the workbook carries the Already on the list sheet");
  if (!second) return;

  let existingHeader: { row: number; columns: Map<TemplateExistingColumnKey, number> } | null = null;
  for (let rowNumber = 1; rowNumber <= 6; rowNumber += 1) {
    const row = second.getRow(rowNumber);
    const values: unknown[] = [];
    for (let column = 1; column <= 8; column += 1) values.push(excelCellText(row.getCell(column).value));
    const columns = locateExistingColumns(values);
    if (!existingHeader && TEMPLATE_EXISTING_REQUIRED_KEYS.every((key) => columns.has(key))) {
      existingHeader = { columns, row: rowNumber };
    }
  }
  assert.ok(existingHeader, "and its header row names both the customer and his hours, so the upload can read it");
  if (!existingHeader) return;

  const existingRows: Array<{ row: number; cells: Partial<Record<TemplateExistingColumnKey, unknown>> }> = [];
  for (let rowNumber = existingHeader.row + 1; rowNumber <= second.rowCount; rowNumber += 1) {
    const row = second.getRow(rowNumber);
    const line: Partial<Record<TemplateExistingColumnKey, unknown>> = {};
    for (const [key, index] of existingHeader.columns) line[key] = excelCellText(row.getCell(index + 1).value);
    existingRows.push({ cells: line, row: rowNumber });
  }

  // The customer who already HAS hours: they are printed, and they survive the trip through Excel. If
  // this drifts, re-uploading an untouched sheet rewrites a clinic's evening and nothing notices.
  const hoursAsRead = readTemplateHoursRows(existingRows);
  const alreadyThere = hoursAsRead.find((entry) => entry.name === "Dr Already There");
  assert.ok(alreadyThere, "the hours printed for a customer who has them read back off the emitted sheet");
  assert.deepEqual(
    alreadyThere?.timings.map((timing) => `${timing.weekday}:${timing.startMinute}-${timing.endMinute}`),
    ["6:1020-1200"],
    "as the same Saturday evening, not as a date Excel invented",
  );
  assert.ok(
    !hoursAsRead.some((entry) => entry.name === "Dr Waiting To Be Seen"),
    "and the one with an empty cell yields nothing at all — the sheet prints every customer, few get hours",
  );

  // The customer past validating with no hours recorded: the cell SAYS it will do nothing, rather than
  // sitting blank and inviting an entry the upload would silently drop.
  const closed = existingRows.find((entry) => String(entry.cells.name ?? "") === "Dr Validated No Hours");
  assert.ok(closed, "a validated customer with no hours is still printed");
  assert.match(
    String(closed?.cells.daysAndHours ?? ""),
    /hours are the rep's now/,
    "and that cell says the hours are the rep's, so nobody writes into one the upload will not read",
  );
  assert.ok(
    !hoursAsRead.some((entry) => entry.name === "Dr Validated No Hours"),
    "and that sentence is not itself read back as a clinic's hours",
  );

  // And the cell the SFE actually fills: written onto the pending row, it reads back as his hours.
  const waiting = existingRows.find((entry) => String(entry.cells.name ?? "") === "Dr Waiting To Be Seen");
  assert.ok(waiting, "the customer waiting to be validated is printed on that sheet");
  if (!waiting) return;
  const hoursIndex = existingHeader.columns.get("daysAndHours");
  assert.ok(hoursIndex !== undefined, "and the hours column is locatable on it");
  if (hoursIndex === undefined) return;
  second.getRow(waiting.row).getCell(hoursIndex + 1).value = "Sun, Tue 10-12";
  const filledLine: Partial<Record<TemplateExistingColumnKey, unknown>> = {};
  for (const [key, index] of existingHeader.columns) filledLine[key] = excelCellText(second.getRow(waiting.row).getCell(index + 1).value);
  const filledRead = readTemplateHoursRows([{ cells: filledLine, row: waiting.row }]);
  assert.equal(filledRead.length, 1, "hours typed beside a waiting customer are read");
  assert.equal(filledRead[0]?.listType, "AM", "on his own list");
  assert.deepEqual(
    filledRead[0]?.timings.map((timing) => `${timing.weekday}:${timing.startMinute}-${timing.endMinute}`),
    ["0:600-720", "2:600-720"],
    "with both days sharing the one window he wrote",
  );
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

  // (b) The picker's customer counts can never be cut short by PostgREST's 1,000-row cap. `.limit(n)`
  // cannot raise it, so an unpaged row read counted the first page and the territories sorting after
  // it read 0 — and a 0 there invites the SFE to load a list that already exists, twice. Since
  // 2026-10-16 the count is the database's own (one jsonb object, which the cap cannot touch) rather
  // than ~11,500 rows fetched a thousand at a time only to be counted here.
  assert.doesNotMatch(service, /\.limit\(\s*\d{4,}\s*\)/, "never a four-figure .limit(), which reads as a ceiling it cannot set");
  const counting = service.slice(service.indexOf("async function countCustomersPerSeat("), service.indexOf("export type ListTemplateImportResult"));
  assert.match(
    counting,
    /callPhoenixCrm<[^(]*>\("phoenix_crm_customer_counts_by_seat", \{\s*p_seat_ids: \[\.\.\.seatIds\],?\s*\}\)/,
    "the per-seat counts are one aggregate call with every seat in the request body",
  );
  assert.doesNotMatch(counting, /\.from\("phoenix_crm_customers"\)/, "and never a row read of the customers table counted in the page server");
  assert.doesNotMatch(counting, /\.catch\(|try \{/, "a failed count fails loudly — a count the picker PRINTS must never read low");
  // The aggregate keeps the page's own filter, so every territory prints the number it printed before.
  const counts = readFileSync("supabase/migrations/20261016180400_phoenix_crm_customer_counts_by_seat.sql", "utf8");
  assert.match(counts, /returns jsonb/, "one object, never a set of rows the 1,000-row cap could cut");
  assert.match(counts, /c\.seat_id = any \(p_seat_ids\)/, "the seats asked about");
  assert.match(counts, /c\.is_test = false/, "real customers only");
  assert.match(counts, /c\.status in \('active', 'pending', 'outside'\)/, "on the list, waiting to be validated, or waiting to be added — the same three");
  assert.match(
    counts,
    /revoke execute on function public\.phoenix_crm_customer_counts_by_seat\(text\[\]\) from public, anon, authenticated;\s*grant execute on function public\.phoenix_crm_customer_counts_by_seat\(text\[\]\) to service_role;/,
    "the service role alone may call it, like every sibling read function",
  );

  // (c) A sheet that does not say which territory it is for is REFUSED. The marker is the only thing
  // between a whole graded list and the wrong rep; accepting a null one threw it away in exactly the
  // case it exists for.
  const importer = service.slice(service.indexOf("export async function importListTemplate("));
  assert.match(importer, /if \(!marked\) \{\s*throw validationError\(/, "a missing marker is refused, not just a mismatched one");
  assert.match(importer, /if \(marked !== seat\.seatId\) \{/, "and a mismatched one still names both territories");
}

/**
 * ── Days and hours: a column on the sheet, a DRAFT on the customer, never a place ────────────────
 *
 * Owner, 2026-10-05: *"put the clinic days and hours in the SFE's list-template sheet."* The audit
 * counted 1,238 presses of the timings editor's weekday buttons against 554 recorded calls — about three
 * day-and-hour rows typed by hand per customer, at the door. The cell's own grammar is pinned in
 * `phoenix-crm-list-sheet-hours.test.ts`; what is pinned HERE is the wiring: the column exists and is
 * optional, the second sheet is readable, and the loader writes one column and nothing else.
 */
function checkDaysAndHours(): void {
  const hours = TEMPLATE_COLUMNS.find((column) => column.key === "daysAndHours");
  assert.ok(hours, "the sheet carries a Days and hours column");
  assert.match(hours?.hint ?? "", /optional/i, "and says on the sheet itself that it is optional");

  // 🔴 OPTIONAL IN THE SAME WAY THE GRADE IS (owner, 2026-10-03, on this very sheet). A row with an
  // unreadable time cell LOADS, with no hours — a sheet that refused 170 rows over a free-text time
  // column would cost far more than the column saves.
  const readable = parseTemplateRow(7, cells({ daysAndHours: "Sat 5:00 PM - 8:00 PM" }));
  assert.equal(readable.kind, "row", "a row with hours loads");
  assert.equal(readable.kind === "row" ? readable.value.timings?.length : null, 1, "and carries them");
  for (const unreadable of ["", "   ", "ask the rep", "whenever he is free"]) {
    const verdict = parseTemplateRow(8, cells({ daysAndHours: unreadable }));
    assert.equal(verdict.kind, "row", `"${unreadable}" does not refuse the row`);
    assert.equal(verdict.kind === "row" ? verdict.value.timings : "missing", null, "and reads as no hours at all, never as a refusal");
  }

  // The second sheet is an INPUT for this one column, and silent about everything else.
  assert.deepEqual([...TEMPLATE_EXISTING_REQUIRED_KEYS], ["name", "daysAndHours"], "the second sheet is read when it names a customer and his hours");
  const readBack = readTemplateHoursRows([
    { cells: { daysAndHours: "Sat 17:00-20:00", listType: "PM", name: "Dr Already There" }, row: 3 },
    // Every one of these is an ordinary line on a real sheet, and every one must produce NOTHING rather
    // than a refusal — the sheet prints every customer the seat holds and only some get hours written.
    { cells: { daysAndHours: "", listType: "PM", name: "Dr Nobody Filled In" }, row: 4 },
    { cells: { daysAndHours: "ask him", listType: "PM", name: "Dr Unreadable Cell" }, row: 5 },
    { cells: { daysAndHours: "Sat 17:00-20:00", listType: "", name: "Dr No List Printed" }, row: 6 },
    { cells: { daysAndHours: "Sat 17:00-20:00", listType: "PM", name: "" }, row: 7 },
    { cells: { daysAndHours: "Mon 18:00-20:00", listType: "PM", name: "Dr Already There" }, row: 8 },
  ]);
  assert.deepEqual(
    readBack.map((entry) => entry.row),
    [3],
    "only a row with a name, a list and readable hours is read — and a customer printed twice keeps the first reading",
  );
  assert.equal(readBack[0]?.listType, "PM", "canonicalised through the module's own list parser");
  assert.equal(readBack[0]?.timings.length, 1, "with the hours the cell named");

  const service = stripComments(readFileSync("src/lib/phoenix-crm/server/list-template.ts", "utf8"));
  // 🔴 THE RAW STATUS, NEVER THE LABEL. `standing()` returns what the sheet PRINTS — "Waiting to be
  // validated" — so comparing it to "pending" is always false and every row reads as closed to hours,
  // which is the whole feature silently doing nothing. Caught before the first upload, 2026-10-05.
  assert.match(service, /acceptsHours: row\.status === "pending" && places\.length === 0/, "the sheet asks the raw status whether hours may still be written");
  assert.doesNotMatch(service, /acceptsHours: standing\(/, "never the printed label, which can never equal a status");
  assert.match(service, /hours: hours\.map\(hoursPayload\)/, "the upload sends the second sheet's hours with the load");
  assert.match(service, /intake_timings: customer\.timings/, "and the first sheet's hours travel on the customer");
  // A sheet downloaded before this column existed has no such sheet, or has it with no hours column.
  // Neither may throw: the upload it belongs to must still load its customers.
  const reader = service.slice(service.indexOf("function readExistingHours("));
  assert.match(reader, /if \(!sheet\) return \[\];/, "a workbook without that sheet reads as no hours");
  assert.match(reader, /if \(!header\) return \[\];/, "and one without its header row too");

  const migration = read(MIGRATION_HOURS);
  // 🔴 THE SECOND PASS WRITES ONE COLUMN. It inserts no customer, so the same-name guard above keeps its
  // whole job; it is the only way hours reach the ~8,700 customers minted from iReports360 rather than
  // loaded from a sheet, who are nearly everyone waiting to be validated.
  const pass = migration.slice(migration.indexOf("if jsonb_typeof(p -> 'hours') = 'array' then"));
  assert.match(
    pass,
    /update public\.phoenix_crm_customers\s+set intake_timings = v_timings, updated_at = now\(\)/,
    "it writes intake_timings and the stamp, and nothing else",
  );
  for (const forbidden of ["set status", "set grade", "set name", "set list_type", "insert into public.phoenix_crm_customers"]) {
    assert.ok(!pass.includes(forbidden), `the hours pass must never "${forbidden}"`);
  }
  // 🔴 PENDING AND PLACELESS: the window in which nothing has read the draft yet. Once the rep has
  // validated him the hours are HIS, on his place, and a re-upload must not reach back and disagree
  // with what he confirmed standing at the door.
  assert.match(pass, /and c\.status = 'pending'/, "and only reaches a customer still waiting to be validated");
  assert.match(pass, /not exists \(select 1 from public\.phoenix_crm_places pl where pl\.customer_id = c\.id\)/, "who has no place captured yet");

  // The place is still only what the rep confirmed: the screen OFFERS the draft, it never saves it.
  const screens = stripComments(readFileSync("src/components/phoenix-crm/list-screens.tsx", "utf8"));
  assert.match(screens, /timings: listed\?\.intake\?\.timings \?\? \[\]/, "the validate screen opens with the sheet's hours already ticked");
  assert.match(screens, /Days and hours from the sheet/, "and says where they came from, so a wrong one is corrected rather than trusted");

  // 🔴 AND THE SHEET STILL CANNOT WRITE A PLACE. The frozen-place rule is about a POSITION; this is the
  // assertion that stops this column being widened into one later.
  for (const forbidden of ["lat", "lon", "latitude", "longitude", "brick", "photo"]) {
    assert.ok(
      !TEMPLATE_COLUMNS.some((column) => foldHeader(column.label).includes(forbidden)),
      `the sheet must not carry a "${forbidden}" column — days and hours are not a position`,
    );
  }
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
  checkGradeOptional();
  checkDaysAndHours();
  await checkBuildsAndReadsBack();
}
