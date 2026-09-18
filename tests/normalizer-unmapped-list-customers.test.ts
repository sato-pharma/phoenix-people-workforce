import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  buildUnmappedWorkbook,
  distinctUnknowns,
  parseUnmappedWorkbook,
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
    mappings.find((m) => m.type === "customer"),
    { code: "BR-MN-014", distributorCode: "PS", raw: "00417", type: "customer" },
    "Upload filled list must learn a filled pharmacy row as a customer mapping under the list's distributor — " +
      "before the fix it was dropped on upload",
  );
  assert.deepEqual(
    mappings.find((m) => m.type === "territory"),
    { code: "BR-MN-002", distributorCode: "PS", raw: "Beni Mazar", type: "territory" },
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
    [{ code: "TE", distributorCode: "PS", raw: "TEB30", type: "product" }],
    "an older six-column list still uploads",
  );

  // An unrecognised type is ignored rather than written anywhere.
  const stray = new ExcelJS.Workbook();
  const straySheet = stray.addWorksheet("Unmapped");
  straySheet.addRow(["Type", "Raw code", "Raw name", "Count", "Suggestion code", "Phoenix Code (fill)"]);
  straySheet.addRow(["distributor", "X1", "", 1, "", "PS"]);
  assert.deepEqual(await parseUnmappedWorkbook(await stray.xlsx.writeBuffer(), "PS"), [], "only product, territory and customer rows are learned");
}
