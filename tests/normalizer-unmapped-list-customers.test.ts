import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import {
  buildUnmappedWorkbook,
  distinctUnknowns,
  parseUnmappedWorkbook,
  UNMAPPED_LIST_REJECTED_ROWS_KEPT,
  unmappedListRejectedRecord,
  type InvalidEntry,
} from "../src/lib/sales/normalizer/mapping.ts";
import type { NormalizeException } from "../src/lib/sales/normalizer/types.ts";

// 🔴 THE NORMALIZER'S "DOWNLOAD LIST (EXCEL)" LEFT OUT EVERY UNKNOWN PHARMACY.
//
// SoS audit, confirmed high (normalizer/mapping.ts, buildUnmappedWorkbook). The screen lists three
// kinds of unknown: products, territories and customers (the per-pharmacy crosswalk, the reliable
// path when a distributor's area text is junk). The Excel round-trip wrote only the first two, and
// the upload read back only those two types, so a pharmacy could not be mapped offline at all: it
// was absent from the file, and a customer row typed in by hand was dropped on upload.
//
// Judged on the EMITTED file: built, read back, filled the way a person fills it, then parsed.

function exception(overrides: Partial<NormalizeException>): NormalizeException {
  return {
    rawCustomerAddress: "",
    rawCustomerCode: "",
    rawCustomerName: "",
    rawProduct: "",
    rawProductName: "",
    rawRowNumber: 1,
    rawTerritory: "",
    reason: "brick",
    ...overrides,
  };
}

// One unknown product, one unknown territory, and one unknown pharmacy seen on two rows: the first
// row is sparse, the second carries the name and address, as distributor sheets often do.
const EXCEPTIONS: NormalizeException[] = [
  exception({ rawProduct: "TEB30", rawProductName: "TEBOFORTIN FORTE 30TAB", reason: "product" }),
  exception({ rawTerritory: "Beni Mazar", reason: "brick" }),
  exception({ rawCustomerCode: "00417", rawTerritory: "Minia", reason: "brick" }),
  exception({
    rawCustomerAddress: "12 El Gomhoreya St, Minia",
    rawCustomerCode: "00417",
    rawCustomerName: "صيدلية النور",
    reason: "brick",
  }),
];

async function readBack(buffer: ExcelJS.Buffer): Promise<{ sheet: ExcelJS.Worksheet; workbook: ExcelJS.Workbook }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  assert.ok(sheet, "the unmapped list has a sheet");
  return { sheet, workbook };
}

export async function runNormalizerUnmappedListCustomersTests() {
  const distinct = distinctUnknowns(EXCEPTIONS, []);
  assert.equal(distinct.customers.length, 1, "fixture sanity: the screen shows one unknown pharmacy");

  const { sheet, workbook: filledBook } = await readBack(await buildUnmappedWorkbook(distinct));
  const header = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
  const col = (label: string) => {
    const index = header.indexOf(label);
    assert.ok(index >= 0, `the unmapped list has a "${label}" column`);
    return index + 1;
  };
  const rows = new Map<string, ExcelJS.Row>();
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    rows.set(`${row.getCell(col("Type")).text}|${row.getCell(col("Raw code")).text}`, row);
  }

  // ── HEADLINE: the unknown pharmacy is in the file, with what a person needs to pick its brick ──
  const pharmacy = rows.get("customer|00417");
  assert.ok(
    pharmacy,
    "Download list (Excel) must carry every unknown pharmacy the screen shows: a row typed customer, keyed by the " +
      "distributor's own customer code — before the fix the file held products and territories only",
  );
  assert.equal(pharmacy.getCell(col("Raw name")).text, "صيدلية النور", "the pharmacy's name, lifted from a later row when the first was sparse");
  assert.equal(pharmacy.getCell(col("Raw address")).text, "12 El Gomhoreya St, Minia", "its address, the main clue to its brick");
  assert.equal(pharmacy.getCell(col("Raw area")).text, "Minia", "the distributor's own area text");
  assert.equal(pharmacy.getCell(col("Count")).value, 2, "the rows it would unblock");
  assert.equal(pharmacy.getCell(col("Phoenix Code (fill)")).text, "", "left blank for the person to fill with a Brick ID");
  assert.equal(pharmacy.getCell(col("Raw code")).text, "00417", "the code keeps its leading zeros — it is text, not a number");

  // The existing two kinds are unchanged, in their original six columns.
  assert.deepEqual(
    header.slice(0, 6),
    ["Type", "Raw code", "Raw name", "Count", "Suggestion code", "Phoenix Code (fill)"],
    "the original six columns keep their order, so a list filled before this change still uploads",
  );
  assert.ok(rows.get("product|TEB30"), "an unknown product is still listed");
  assert.ok(rows.get("territory|Beni Mazar"), "an unknown territory is still listed");

  // ── The round trip: fill the codes the way a person does, upload, and every row is learned ──
  pharmacy.getCell(col("Phoenix Code (fill)")).value = "BR-MN-014";
  rows.get("territory|Beni Mazar")!.getCell(col("Phoenix Code (fill)")).value = "BR-MN-002";
  // The product row arrives pre-filled from its suggestion; blank it so only what a person filled counts.
  rows.get("product|TEB30")!.getCell(col("Phoenix Code (fill)")).value = "";
  const mappings = await parseUnmappedWorkbook(await filledBook.xlsx.writeBuffer(), "PS");

  assert.deepEqual(
    mappings.map((m) => `${m.type}@${m.row}`).sort(),
    [`customer@${pharmacy.number}`, `territory@${rows.get("territory|Beni Mazar")!.number}`],
    "every learned mapping names the sheet row it came from, so a rejection can say which line to fix",
  );

  assert.deepEqual(
    mappings.find((m) => m.type === "customer"),
    { code: "BR-MN-014", distributorCode: "PS", raw: "00417", row: pharmacy.number, type: "customer" },
    "Upload filled list must learn a filled pharmacy row as a customer mapping under the list's distributor — " +
      "before the fix it was dropped on upload",
  );
  assert.deepEqual(
    mappings.find((m) => m.type === "territory"),
    { code: "BR-MN-002", distributorCode: "PS", raw: "Beni Mazar", row: rows.get("territory|Beni Mazar")!.number, type: "territory" },
    "a filled territory row is still learned",
  );
  assert.equal(mappings.length, 2, "a row left blank teaches nothing");

  // A list downloaded before this change has six columns and no customer rows: it still parses.
  const legacy = new ExcelJS.Workbook();
  const legacySheet = legacy.addWorksheet("Unmapped");
  legacySheet.addRow(["Type", "Raw code", "Raw name", "Count", "Suggestion code", "Phoenix Code (fill)"]);
  legacySheet.addRow(["product", "TEB30", "TEBOFORTIN FORTE 30TAB", 1, "TE", "TE"]);
  assert.deepEqual(
    await parseUnmappedWorkbook(await legacy.xlsx.writeBuffer(), "PS"),
    [{ code: "TE", distributorCode: "PS", raw: "TEB30", row: 2, type: "product" }],
    "an older six-column list still uploads",
  );

  // An unrecognised type is ignored rather than written anywhere.
  const stray = new ExcelJS.Workbook();
  const straySheet = stray.addWorksheet("Unmapped");
  straySheet.addRow(["Type", "Raw code", "Raw name", "Count", "Suggestion code", "Phoenix Code (fill)"]);
  straySheet.addRow(["distributor", "X1", "", 1, "", "PS"]);
  assert.deepEqual(await parseUnmappedWorkbook(await stray.xlsx.writeBuffer(), "PS"), [], "only product, territory and customer rows are learned");

  // ── THE REJECTED ROWS ARE SAVED WITH EACH UPLOAD, NOT JUST COUNTED ──
  //
  // "Upload filled list" reported "N invalid" and nothing more: which rows and why reached the
  // browser once, the notice printed the count alone, and no record kept them — a mistyped Brick ID
  // on a filled list could not be found again. Each parsed mapping now names its sheet row, and the
  // rejections ride on the upload's own history record, the way the customer map import keeps its
  // blocked rows.
  assert.deepEqual(
    unmappedListRejectedRecord([]),
    { note: "", values: { rejectedRows: [], rejectedRowsKept: 0 } },
    "an upload that rejected nothing records an empty list and no note",
  );

  const record = unmappedListRejectedRecord([
    { raw: "00931", reason: 'Brick ID "BR-XX-999" not found in master', row: 23, type: "customer" },
    { raw: "Beni Mazar", reason: 'Brick ID "BR-MN-777" not found in master', row: 3, type: "territory" },
    { raw: "TEB30", reason: 'Product code "TX" not found in master', row: 9, type: "product" },
  ]);
  assert.deepEqual(
    record.values.rejectedRows.map((e) => e.row),
    [3, 9, 23],
    "Upload filled list must keep every rejected row in its history record, in sheet order by row number — " +
      "before the fix no record held them and the screen showed only the count",
  );
  assert.deepEqual(
    record.values.rejectedRows[0],
    { raw: "Beni Mazar", reason: 'Brick ID "BR-MN-777" not found in master', row: 3, type: "territory" },
    "each keeps what the row said, its kind and why it was rejected",
  );
  assert.equal(record.values.rejectedRowsKept, 3);
  assert.equal(record.note, " (each listed in this record)", "the summary says the list is complete");
  assert.deepEqual(
    unmappedListRejectedRecord([{ raw: "X1", reason: "Missing distributor code", type: "product" }]).values.rejectedRows,
    [{ raw: "X1", reason: "Missing distributor code", type: "product" }],
    "a rejection from a caller with no file keeps no invented row number",
  );

  // A pathological sheet is capped so the record itself always saves, and the note says it was.
  const flood: InvalidEntry[] = Array.from({ length: UNMAPPED_LIST_REJECTED_ROWS_KEPT + 7 }, (_, i) => ({
    raw: `C${i}`,
    reason: 'Brick ID "X" not found in master',
    row: UNMAPPED_LIST_REJECTED_ROWS_KEPT + 8 - i,
    type: "customer",
  }));
  const capped = unmappedListRejectedRecord(flood);
  assert.equal(capped.values.rejectedRows.length, UNMAPPED_LIST_REJECTED_ROWS_KEPT, "a flood is capped");
  assert.equal(capped.values.rejectedRows[0].row, 2, "the cap keeps the FIRST rows of the sheet, not the last read");
  assert.equal(capped.values.rejectedRowsKept, UNMAPPED_LIST_REJECTED_ROWS_KEPT);
  assert.equal(capped.note, ` (the first ${UNMAPPED_LIST_REJECTED_ROWS_KEPT} listed in this record)`, "a capped list says so");
  const long = unmappedListRejectedRecord([{ raw: "R".repeat(500), reason: "W".repeat(1000), row: 4, type: "customer" }]).values.rejectedRows[0];
  assert.equal(long.raw.length, 200, "a runaway cell is trimmed, never dropped");
  assert.equal(long.reason.length, 400, "a runaway reason is trimmed, never dropped");

  // The wiring. saveMappings is the one place a rejection is decided, and it needs the database, so
  // the source is pinned: every rejection carries the row, and the upload writes the record.
  const source = readFileSync("src/lib/sales/normalizer/mapping.ts", "utf8");
  const save = source.slice(source.indexOf("export async function saveMappings("), source.indexOf("// Guard the crosswalk BEFORE the upsert"));
  const pushes = save.match(/invalidEntries\.push\(\{/g) ?? [];
  assert.ok(pushes.length >= 9, "fixture sanity: saveMappings rejects in at least nine places");
  assert.equal(
    (save.match(/invalidEntries\.push\(\{ \.\.\.sheetRow, /g) ?? []).length,
    pushes.length,
    "every rejection saveMappings records names the sheet row it came from",
  );
  const learn = source.slice(source.indexOf("export async function learnFromUploadedMappings("));
  assert.match(learn, /const rejectedRecord = unmappedListRejectedRecord\(result\.invalidEntries\);/, "the upload builds its record from saveMappings' own rejections");
  assert.match(
    learn,
    /newValues: \{[^}]*\.\.\.rejectedRecord\.values[^}]*source: "unmapped_list_upload"/,
    "the rejected rows ride on the upload's history record",
  );
  assert.match(learn, /\$\{result\.invalid\} rejected\$\{rejectedRecord\.note\}/, "its summary says whether the list is complete");
  assert.match(
    readFileSync("app/api/sales/normalizer/mappings/learn/route.ts", "utf8"),
    /learnFromUploadedMappings\(await file\.arrayBuffer\(\), distributorCode, actorLoginId\)/,
    "the record names who uploaded the list",
  );
}
