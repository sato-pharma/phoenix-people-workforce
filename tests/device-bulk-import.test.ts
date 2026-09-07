import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import {
  COLUMNS,
  DEVICE_CATEGORY_OPTIONS,
  DEVICE_IMPORT_FIRST_DATA_ROW,
  DEVICE_IMPORT_HEADER_ROW,
  DEVICE_IMPORT_MAX_ROWS,
  buildDeviceImportPreviewFrom,
  extractHrId,
  parseDeviceImportFile,
  personPickerLabel,
  type DeviceImportRow,
  type DirectoryEntry,
  type ExistingRegisterKeys,
} from "../src/lib/devices/bulk-import.ts";

/**
 * The device register's bulk import.
 *
 * THE ONE FAILURE THIS FILE EXISTS FOR is column drift. If the template writer and the parser ever
 * disagree about which column is which, the import does not error — it writes a serial into the
 * IMEI field, and a device the police cannot find looks exactly like a device that was entered
 * correctly. So the headline test builds a real workbook, fills it, parses it back, and asserts
 * every value landed in the field it was typed into.
 *
 * THE VALIDATION RULES ARE TESTED WITHOUT A DATABASE, through `buildDeviceImportPreviewFrom`. That
 * is required rather than tidy: this suite runs with PRODUCTION credentials (AGENTS.md §2.1), so a
 * test that reached the live directory to check duplicate detection would be reading real employee
 * records to assert something about arithmetic.
 */

const EMPTY_KEYS: ExistingRegisterKeys = { tags: new Set(), serials: new Set(), imeis: new Set() };

function directoryOf(entries: DirectoryEntry[]): Map<string, DirectoryEntry> {
  return new Map(entries.map((entry) => [entry.hrId.toLowerCase(), entry]));
}

function rowOf(overrides: Partial<DeviceImportRow> = {}): DeviceImportRow {
  return {
    rowNumber: 6,
    assetTag: "PHX-LAP-0001",
    category: "laptop",
    manufacturer: "Dell",
    model: "Latitude 5440",
    serialNumber: "7XKQ2V3",
    imei: null,
    simNumber: null,
    lineNumber: null,
    estimatedValueEgp: 25000,
    purchasedOn: null,
    heldBy: null,
    issuedOn: null,
    declarationNo: null,
    handoverPlace: null,
    deviceName: null,
    processor: null,
    installedRam: null,
    systemType: null,
    windowsDeviceId: null,
    windowsProductId: null,
    note: null,
    ...overrides,
  };
}

/** Builds a workbook shaped like the template, with the given rows under the real headers. */
async function workbookWith(rows: Array<Record<string, string | number>>): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Devices");

  const headerRow = sheet.getRow(DEVICE_IMPORT_HEADER_ROW);
  COLUMNS.forEach((column, index) => {
    headerRow.getCell(index + 1).value = column.header;
  });

  rows.forEach((values, rowOffset) => {
    const row = sheet.getRow(DEVICE_IMPORT_FIRST_DATA_ROW + rowOffset);
    COLUMNS.forEach((column, index) => {
      const value = values[column.key];
      if (value !== undefined) row.getCell(index + 1).value = value;
    });
  });

  return (await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer;
}

// ---------------------------------------------------------------------------------------------
// Column drift — the failure this file exists for
// ---------------------------------------------------------------------------------------------

/**
 * Every value lands in the field it was typed into.
 *
 * Written as a full round trip rather than as an assertion about `COLUMNS`, because the thing worth
 * proving is not that the array is well-formed — it is that a workbook carrying these headers reads
 * back with each value in its own property. An off-by-one in either half fails here loudly, and
 * fails nowhere else at all.
 */
async function testEveryValueLandsInItsOwnField(): Promise<void> {
  const buffer = await workbookWith([
    {
      assetTag: "PHX-LAP-0007",
      category: "laptop",
      manufacturer: "Dell",
      model: "Latitude 5440",
      serialNumber: "7XKQ2V3",
      imei: "",
      simNumber: "8920011234567890123",
      lineNumber: "01001234567",
      estimatedValueEgp: 25000,
      purchasedOn: "2026-01-15",
      heldBy: "Nour Adel (B-155)",
      issuedOn: "2026-02-01",
      declarationNo: "DECL-001",
      handoverPlace: "Head office",
      deviceName: "SATO-LAP-0007",
      processor: "Intel Core i5-1345U",
      installedRam: "16.0 GB",
      systemType: "64-bit operating system",
      windowsDeviceId: "A1B2C3D4-1111-2222-3333-444455556666",
      windowsProductId: "00330-80000-00000-AA123",
      note: "Screen has a scratch",
    },
  ]);

  const rows = await parseDeviceImportFile(buffer);
  assert.equal(rows.length, 1, "one filled row reads back as one row");

  const row = rows[0];
  assert.equal(row.assetTag, "PHX-LAP-0007", "asset tag landed in its own field");
  assert.equal(row.category, "laptop", "category landed in its own field");
  assert.equal(row.manufacturer, "Dell", "manufacturer landed in its own field");
  assert.equal(row.model, "Latitude 5440", "model landed in its own field");
  assert.equal(row.serialNumber, "7XKQ2V3", "the serial must NOT land in the IMEI field");
  assert.equal(row.imei, null, "and an empty IMEI must stay empty");
  assert.equal(row.simNumber, "8920011234567890123", "SIM landed in its own field");
  assert.equal(row.lineNumber, "01001234567", "line number landed in its own field");
  assert.equal(row.estimatedValueEgp, 25000, "estimated value landed in its own field");
  assert.equal(row.purchasedOn, "2026-01-15", "purchase date landed in its own field");
  assert.equal(row.heldBy, "Nour Adel (B-155)", "holder landed in its own field");
  assert.equal(row.issuedOn, "2026-02-01", "issue date landed in its own field");
  assert.equal(row.declarationNo, "DECL-001", "declaration no. landed in its own field");
  assert.equal(row.handoverPlace, "Head office", "handover place landed in its own field");
  assert.equal(row.deviceName, "SATO-LAP-0007", "device name landed in its own field");
  assert.equal(row.processor, "Intel Core i5-1345U", "processor landed in its own field");
  assert.equal(row.installedRam, "16.0 GB", "RAM landed in its own field");
  assert.equal(row.systemType, "64-bit operating system", "system type landed in its own field");
  assert.equal(row.windowsDeviceId, "A1B2C3D4-1111-2222-3333-444455556666", "device ID landed in its own field");
  assert.equal(row.windowsProductId, "00330-80000-00000-AA123", "product ID landed in its own field");
  assert.equal(row.note, "Screen has a scratch", "note landed in its own field");
  assert.equal(row.rowNumber, DEVICE_IMPORT_FIRST_DATA_ROW, "the row number is the one in the user's file");
}

/**
 * A column moved sideways still parses, because matching is by HEADER TEXT and not by position.
 *
 * This is what makes the import survive a file that has been round-tripped, sorted or had a column
 * dragged. The dangerous alternative — reading by index — is what turns a moved column into a
 * silently mis-filed serial.
 */
async function testColumnsAreMatchedByHeaderNotByPosition(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Devices");

  // Deliberately REVERSED, so every column is in the wrong place by index.
  const reversed = [...COLUMNS].reverse();
  const headerRow = sheet.getRow(DEVICE_IMPORT_HEADER_ROW);
  reversed.forEach((column, index) => {
    headerRow.getCell(index + 1).value = column.header;
  });

  const dataRow = sheet.getRow(DEVICE_IMPORT_FIRST_DATA_ROW);
  reversed.forEach((column, index) => {
    if (column.key === "assetTag") dataRow.getCell(index + 1).value = "PHX-TAB-0042";
    if (column.key === "category") dataRow.getCell(index + 1).value = "tablet";
    if (column.key === "imei") dataRow.getCell(index + 1).value = "356938035643809";
  });

  const rows = await parseDeviceImportFile(
    (await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer,
  );
  assert.equal(rows.length, 1, "a reversed sheet still yields one row");
  assert.equal(rows[0].assetTag, "PHX-TAB-0042", "a reversed sheet still reads the asset tag");
  assert.equal(rows[0].imei, "356938035643809", "and the IMEI, from a completely different column");
  assert.equal(rows[0].serialNumber, null, "with nothing bleeding into the serial");
}

/** A file that is not the template fails loudly, rather than reading whatever is in column 1. */
async function testAForeignFileIsRefusedWithAnExplanation(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.getRow(1).getCell(1).value = "Some other report";
  sheet.getRow(2).getCell(1).value = "totally unrelated";

  await assert.rejects(
    () => parseDeviceImportFile((workbook.xlsx.writeBuffer() as unknown) as never),
    /device import template|no sheets/i,
    "a foreign file must be named as such, not parsed into nonsense",
  );

  const buffer = (await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer;
  await assert.rejects(
    () => parseDeviceImportFile(buffer),
    /does not look like the device import template/,
    "and the message must tell the user to download the template",
  );
}

/** Styled-but-empty template rows are skipped silently, not reported as 12 problems. */
async function testEmptyRowsAreSkippedSilently(): Promise<void> {
  const buffer = await workbookWith([
    { assetTag: "PHX-LAP-0001", category: "laptop", serialNumber: "AAA111" },
    {},
    {},
    { assetTag: "PHX-LAP-0002", category: "laptop", serialNumber: "BBB222" },
  ]);
  const rows = await parseDeviceImportFile(buffer);
  assert.equal(rows.length, 2, "two filled rows out of four");
  assert.deepEqual(
    rows.map((row) => row.assetTag),
    ["PHX-LAP-0001", "PHX-LAP-0002"],
  );
}

// ---------------------------------------------------------------------------------------------
// The validation rules
// ---------------------------------------------------------------------------------------------

/** The identity rule — the register's whole reason for existing. */
function testARowWithNoSerialAndNoImeiIsRefused(): void {
  const preview = buildDeviceImportPreviewFrom(
    [rowOf({ serialNumber: null, imei: null })],
    directoryOf([]),
    EMPTY_KEYS,
  );
  assert.equal(
    preview.rows[0].canImport,
    false,
    "a row with neither a serial nor an IMEI must be refused",
  );
  assert.ok(
    preview.rows[0].errors.some((message) => /serial number or an IMEI is required/i.test(message)),
    "and it says why in words the person filling the sheet can act on",
  );

  // Either one alone is enough.
  for (const identity of [{ serialNumber: "AAA111", imei: null }, { serialNumber: null, imei: "35693803564" }]) {
    const ok = buildDeviceImportPreviewFrom([rowOf(identity)], directoryOf([]), EMPTY_KEYS);
    assert.equal(ok.rows[0].canImport, true, `one of the two identifiers is enough (${JSON.stringify(identity)})`);
  }
}

function testAnUnknownCategoryIsRefused(): void {
  const preview = buildDeviceImportPreviewFrom([rowOf({ category: "desktop" })], directoryOf([]), EMPTY_KEYS);
  assert.equal(preview.rows[0].canImport, false, "an unknown category must be refused");
  assert.ok(
    preview.rows[0].errors.some((message) => message.includes(DEVICE_CATEGORY_OPTIONS.join(", "))),
    "and the message lists what IS allowed rather than only what is not",
  );
}

/**
 * A duplicate inside the FILE is caught, and BOTH halves are reported.
 *
 * Telling somebody row 40 is a duplicate without telling them of what is half an answer — they then
 * have to find the other one by eye in an 85-row sheet.
 */
function testDuplicatesWithinTheFileAreCaughtOnBothRows(): void {
  const preview = buildDeviceImportPreviewFrom(
    [
      rowOf({ rowNumber: 6, assetTag: "PHX-LAP-0001", serialNumber: "AAA111" }),
      rowOf({ rowNumber: 7, assetTag: "PHX-LAP-0001", serialNumber: "BBB222" }),
      rowOf({ rowNumber: 8, assetTag: "PHX-LAP-0003", serialNumber: "AAA111" }),
    ],
    directoryOf([]),
    EMPTY_KEYS,
  );

  assert.equal(preview.rows[0].canImport, false, "the FIRST duplicate is flagged too, not only the second");
  assert.equal(
    preview.rows[1].canImport,
    false,
    "the SECOND row of a duplicate ASSET TAG pair is refused, even when its own serial is unique",
  );
  assert.equal(preview.rows[2].canImport, false, "a duplicate serial is caught as well as a duplicate tag");
  assert.equal(preview.summary.canImport, 0, "no row of a duplicate set is importable");
}

/** A collision with what the register ALREADY holds is caught before anything is written. */
function testDuplicatesAgainstTheRegisterAreCaught(): void {
  const existing: ExistingRegisterKeys = {
    tags: new Set(["phx-lap-0001"]),
    serials: new Set(["aaa111"]),
    imeis: new Set(["35693803564"]),
  };

  const tag = buildDeviceImportPreviewFrom([rowOf({ serialNumber: "ZZZ999" })], directoryOf([]), existing);
  assert.ok(tag.rows[0].errors.some((m) => /already in the register/.test(m)), "asset tag collision");

  const serial = buildDeviceImportPreviewFrom(
    [rowOf({ assetTag: "PHX-NEW-1", serialNumber: "AAA111" })],
    directoryOf([]),
    existing,
  );
  assert.ok(serial.rows[0].errors.some((m) => /already in the register/.test(m)), "serial collision");

  // Matched case-insensitively on both sides: a sticker typed in caps is the same device.
  const cased = buildDeviceImportPreviewFrom(
    [rowOf({ assetTag: "phx-LAP-0001", serialNumber: "aaa111" })],
    directoryOf([]),
    existing,
  );
  assert.equal(cased.rows[0].canImport, false, "casing must not let a duplicate through");
}

/** hr_id is mixed case in this database, so a holder must resolve either way. */
function testAHolderResolvesRegardlessOfCasing(): void {
  const directory = directoryOf([{ hrId: "B-155", name: "Nour Adel", hasLeft: false }]);

  for (const heldBy of ["B-155", "b-155", "Nour Adel (B-155)", "Nour Adel (b-155)"]) {
    const preview = buildDeviceImportPreviewFrom([rowOf({ heldBy })], directory, EMPTY_KEYS);
    assert.equal(preview.rows[0].canImport, true, `"${heldBy}" must resolve`);
    assert.equal(
      preview.rows[0].resolvedHolderHrId,
      "B-155",
      "and resolve to the DIRECTORY's casing, not the sheet's",
    );
    assert.equal(preview.rows[0].resolvedHolderName, "Nour Adel");
  }
}

function testAnUnknownHolderIsRefused(): void {
  const preview = buildDeviceImportPreviewFrom(
    [rowOf({ heldBy: "Somebody Who Left Years Ago (X-999)" })],
    directoryOf([{ hrId: "B-155", name: "Nour Adel", hasLeft: false }]),
    EMPTY_KEYS,
  );
  assert.equal(preview.rows[0].canImport, false, "an unknown holder must be refused");
  assert.ok(
    preview.rows[0].errors.some((m) => /does not match anybody/.test(m)),
    "and it must say the name matched nobody",
  );
}

/**
 * A LEAVER may hold a device, and the row imports.
 *
 * This is the single most valuable row in the file — a device out with somebody who has already
 * left is the exposure the register was built to surface. Refusing it would hide exactly what the
 * owner asked to see, so it warns instead.
 */
function testALeaverMayHoldADeviceAndIsWarnedAbout(): void {
  const preview = buildDeviceImportPreviewFrom(
    [rowOf({ heldBy: "Omar Tamer (AI-0010)" })],
    directoryOf([{ hrId: "AI-0010", name: "Omar Tamer", hasLeft: true }]),
    EMPTY_KEYS,
  );

  assert.equal(preview.rows[0].canImport, true, "a leaver's device MUST import — it is the point");
  assert.equal(preview.rows[0].holderHasLeft, true);
  assert.ok(
    preview.rows[0].warnings.some((m) => /has already left/.test(m)),
    "and it is warned about, loudly, so nobody enters one by accident",
  );
  assert.equal(preview.summary.heldByLeavers, 1);
  assert.equal(preview.summary.willBeIssued, 1);
}

/** A device with no value is importable, and counted — البند (10) can recover nothing against it. */
function testNoEstimatedValueIsAWarningNotAnError(): void {
  const preview = buildDeviceImportPreviewFrom(
    [rowOf({ estimatedValueEgp: null })],
    directoryOf([]),
    EMPTY_KEYS,
  );
  assert.equal(
    preview.rows[0].canImport,
    true,
    "a device with no estimated value still imports - the value is a warning, not a bar",
  );
  assert.ok(
    preview.rows[0].warnings.some((m) => /nothing can be recovered|caps any recovery/i.test(m)),
    "and it must say nothing could be recovered against it",
  );
  assert.equal(preview.summary.withoutValue, 1);

  const negative = buildDeviceImportPreviewFrom(
    [rowOf({ estimatedValueEgp: -1 })],
    directoryOf([]),
    EMPTY_KEYS,
  );
  assert.equal(negative.rows[0].canImport, false, "a negative value is an error, not a warning");
}

/** Handover details with nobody named would be silently dropped, so the preview says so. */
function testHandoverDetailsWithNoHolderAreCalledOut(): void {
  const preview = buildDeviceImportPreviewFrom(
    [rowOf({ heldBy: null, declarationNo: "DECL-009" })],
    directoryOf([]),
    EMPTY_KEYS,
  );
  assert.equal(preview.rows[0].canImport, true, "handover details without a holder still import");
  assert.ok(
    preview.rows[0].warnings.some((m) => /names nobody/.test(m)),
    "and the dropped details must be called out",
  );
}

function testTheSummaryAddsUp(): void {
  const directory = directoryOf([
    { hrId: "B-155", name: "Nour Adel", hasLeft: false },
    { hrId: "AI-0010", name: "Omar Tamer", hasLeft: true },
  ]);
  const preview = buildDeviceImportPreviewFrom(
    [
      rowOf({ rowNumber: 6, assetTag: "A1", serialNumber: "S1", heldBy: "B-155", estimatedValueEgp: 25000 }),
      rowOf({ rowNumber: 7, assetTag: "A2", serialNumber: "S2", heldBy: "AI-0010", estimatedValueEgp: 9000 }),
      rowOf({ rowNumber: 8, assetTag: "A3", serialNumber: "S3", estimatedValueEgp: null }),
      rowOf({ rowNumber: 9, assetTag: "A4", serialNumber: null, imei: null }),
    ],
    directory,
    EMPTY_KEYS,
  );

  assert.equal(preview.summary.total, 4);
  assert.equal(preview.summary.canImport, 3, "the identity-less row is the only one refused");
  assert.equal(preview.summary.withErrors, 1);
  assert.equal(preview.summary.willBeIssued, 2);
  assert.equal(preview.summary.heldByLeavers, 1);
  assert.equal(preview.summary.withoutValue, 1);
  assert.equal(
    preview.summary.totalValueEgp,
    34000,
    "and the value totals only what will actually be written",
  );
}

// ---------------------------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------------------------

function testTheHolderLabelIsReadableAndParsesBack(): void {
  const label = personPickerLabel({ hrId: "B-155", name: "Nour Adel" });
  assert.equal(label, "Nour Adel (B-155)", "human-readable name first — the owner's standing rule");
  assert.equal(extractHrId(label), "B-155", "and it must parse back to the id");
  assert.equal(extractHrId("B-155"), "B-155", "a bare id typed by hand is accepted too");
  assert.equal(extractHrId("  b-155  "), "b-155", "a padded bare id is trimmed, not mangled");
  assert.equal(extractHrId(null), null, "nothing in, nothing out");
  assert.equal(extractHrId(""), null, "an empty cell names nobody");
  // A name that itself contains brackets must not confuse the last-bracket rule.
  assert.equal(extractHrId("Ahmed (Acting) (A-8)"), "A-8");
}

/** The route caps the file, and the template's dropdowns must cover at least what it accepts. */
function testTheRowCapIsSane(): void {
  assert.ok(DEVICE_IMPORT_MAX_ROWS >= 100, "a fleet of ~85 must fit in one import");
  assert.ok(DEVICE_IMPORT_MAX_ROWS <= 5000, "and an unbounded cap is a wrong file, not a request");
}

/**
 * The template must not carry a filled sample row.
 *
 * The obvious way to show somebody the shape is an example row under the headers, and every such
 * template eventually imports its own example — a fictional laptop with a fictional serial, in a
 * register whose entire value is that its contents are evidence. This asserts on the SOURCE rather
 * than by generating the workbook, because generating it needs the employee directory and this
 * suite runs against production.
 */
function testTheTemplateHasNoSampleDataRow(): void {
  const source = readFileSync("src/lib/devices/bulk-import.ts", "utf8");
  const generator = source.slice(
    source.indexOf("export async function generateDeviceImportTemplate"),
    source.indexOf("// ---", source.indexOf("export async function generateDeviceImportTemplate")),
  );
  assert.ok(generator.length > 0, "could not find the template generator");

  // The note row carries the examples. Nothing may write a value into a DATA row.
  assert.ok(
    !/getRow\(DEVICE_IMPORT_FIRST_DATA_ROW[^)]*\)[\s\S]{0,200}\.value\s*=/.test(generator),
    "the generator writes a value into a data row — that example will be imported as a real device",
  );
  assert.ok(
    /houseBodyStyle\(row\.getCell/.test(generator),
    "the empty data rows are styled but carry no values",
  );
}

export async function runDeviceBulkImportTests(): Promise<void> {
  await testEveryValueLandsInItsOwnField();
  await testColumnsAreMatchedByHeaderNotByPosition();
  await testAForeignFileIsRefusedWithAnExplanation();
  await testEmptyRowsAreSkippedSilently();
  testARowWithNoSerialAndNoImeiIsRefused();
  testAnUnknownCategoryIsRefused();
  testDuplicatesWithinTheFileAreCaughtOnBothRows();
  testDuplicatesAgainstTheRegisterAreCaught();
  testAHolderResolvesRegardlessOfCasing();
  testAnUnknownHolderIsRefused();
  testALeaverMayHoldADeviceAndIsWarnedAbout();
  testNoEstimatedValueIsAWarningNotAnError();
  testHandoverDetailsWithNoHolderAreCalledOut();
  testTheSummaryAddsUp();
  testTheHolderLabelIsReadableAndParsesBack();
  testTheRowCapIsSane();
  testTheTemplateHasNoSampleDataRow();
  assert.equal(DEVICE_IMPORT_HEADER_ROW, 5, "the header row is the shared constant both halves read");
}
