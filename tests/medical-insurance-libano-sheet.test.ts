import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import JSZip from "jszip";

import {
  buildLibanoMovementWorkbook,
  excelDayNumber,
  LIBANO_ADDITIONS_SHEET_ROWS,
  LIBANO_DELETIONS_SHEET_ROWS,
  LIBANO_GRACE_PERIOD_DAYS,
  LIBANO_MOVEMENT_TEMPLATE_PATH,
} from "../src/lib/medical-insurance/libano-movement-sheet.ts";
import type { LibanoMemberLine } from "../src/lib/medical-insurance/workbooks.ts";

// Owner, 20 Nov 2026: additions and deletions go to Libano-Suisse on their own "Additions and Deletions Sheet",
// "perfectly like this, 100%". These pin that the file IS the insurer's workbook (its seven sheets, every part
// but the two filled sheets byte for byte), that the template carries nobody's personal data, and that each
// value lands in the insurer's own cell.

const SHEET_NAMES = ["Add and Del Eng", "Add and Del ِArab", "Interface", "keys", "Deletions sheet", "Additions sheet", "Assumptions"];
const ADDITIONS = "xl/worksheets/sheet6.xml";
const DELETIONS = "xl/worksheets/sheet5.xml";
const ASSUMPTIONS = "xl/worksheets/sheet7.xml";
const POLICY = { endsOn: "2027-11-26", holder: "Sato Pharma", startsOn: "2026-11-22" };

const template = new Uint8Array(readFileSync(LIBANO_MOVEMENT_TEMPLATE_PATH));

function line(overrides: Partial<LibanoMemberLine>): LibanoMemberLine {
  return {
    adherentNumber: null,
    birthDate: "1994-08-30",
    category: "B",
    day: "2026-12-01",
    fullName: "Test Joiner Person",
    gender: "Female",
    memberType: "employee",
    nationalId: "29400000000000",
    phone: "01000000000",
    principalNumber: null,
    staffNumber: "AI-0099",
    ...overrides,
  };
}

/** One cell as written: its style, its value (inline text or number) and whether it holds a formula. */
function cell(xml: string, ref: string): { style: string | null; value: string | null; formula: boolean } {
  const match = new RegExp(`<c r="${ref}"(?=[\\s/>])([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`).exec(xml);
  assert.ok(match, `${ref} exists`);
  const inner = match[2] ?? "";
  const text = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1];
  const number = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
  return { formula: inner.includes("<f"), style: / s="(\d+)"/.exec(match[1])?.[1] ?? null, value: text ?? number ?? null };
}

async function parts(buffer: ArrayBuffer | Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(buffer);
  const out = new Map<string, Uint8Array>();
  for (const name of Object.keys(zip.files)) {
    if (!zip.files[name].dir) out.set(name, await zip.files[name].async("uint8array"));
  }
  return out;
}

const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

/** The template is the insurer's workbook with nobody left on it and nobody's name in it. */
async function testTheTemplateIsTheInsurersWorkbookWithNobodyOnIt() {
  const files = await parts(template);
  const workbook = decode(files.get("xl/workbook.xml"));
  assert.deepEqual([...workbook.matchAll(/<sheet [^>]*?name="([^"]+)"/g)].map((m) => m[1]), SHEET_NAMES, "the insurer's seven sheets, in their order");
  assert.match(workbook, /fullCalcOnLoad="1"/, "Excel recalculates the insurer's checks when the file is opened");
  assert.ok(!files.has("xl/calcChain.xml"), "no calculation chain naming old cells");
  assert.equal([...files.keys()].filter((name) => name.startsWith("xl/media/")).length, 4, "the insurer's logos are kept");

  const additions = decode(files.get(ADDITIONS));
  for (let r = 6; r <= 597; r += 1) {
    for (const column of "BCDEFGHIJKLMNOPQ") assert.equal(cell(additions, `${column}${r}`).value, null, `Additions ${column}${r} is empty in the template`);
  }
  const deletions = decode(files.get(DELETIONS));
  for (let r = 6; r <= 400; r += 1) {
    for (const column of "BCDEFG") assert.equal(cell(deletions, `${column}${r}`).value, null, `Deletions ${column}${r} is empty in the template`);
  }
  // No saved formula result is left (one held a date of birth): a formula cell carries its formula alone.
  for (const name of [ADDITIONS, DELETIONS, "xl/worksheets/sheet3.xml"]) {
    assert.doesNotMatch(decode(files.get(name)), /<\/f><v>[^<]/, `${name} keeps no saved formula result`);
  }
  // Nothing that looks like a national ID (14 digits) or an Egyptian mobile (11 digits from 01) anywhere in the text.
  for (const [name, bytes] of files) {
    if (!name.endsWith(".xml")) continue;
    const xml = decode(bytes);
    assert.doesNotMatch(xml, /[>"]\d{14}[<"]/, `${name} holds no national ID`);
    assert.doesNotMatch(xml, /[>"]01\d{9}[<"]/, `${name} holds no mobile number`);
  }
  const core = decode(files.get("docProps/core.xml"));
  assert.match(core, /<dc:creator>Libano-Suisse<\/dc:creator>/);
  assert.match(core, /<cp:lastModifiedBy>Phoenix Workforce<\/cp:lastModifiedBy>/, "no person is named as the last editor");
  assert.doesNotMatch(decode(files.get(ASSUMPTIONS)), /ITS \(SME\)/, "the other company's policy holder is gone");
}

/** Each addition lands in the insurer's own cells, the date of birth as Day, Month and Year, names in capitals. */
async function testAnAdditionFillsTheInsurersOwnCells() {
  const buffer = await buildLibanoMovementWorkbook({
    kind: "additions",
    policy: POLICY,
    rows: [line({}), line({ category: "C", fullName: "Second Joiner", gender: "male", staffNumber: "PD-0098" })],
    template,
  });
  const files = await parts(buffer);
  const before = await parts(template);
  const xml = decode(files.get(ADDITIONS));
  const blank = decode(before.get(ADDITIONS));

  assert.equal(excelDayNumber("2026-04-06"), 46118, "the day number the insurer's own file held for 6 Apr 2026");
  const expected: Record<string, string> = {
    B6: "Sato Pharma",
    C6: String(excelDayNumber("2026-12-01")),
    D6: "AI-0099",
    E6: "TEST",
    F6: "JOINER",
    G6: "PERSON",
    H6: "30",
    I6: "8",
    J6: "1994",
    K6: "F",
    L6: "P",
    M6: "B",
    P6: "01000000000",
    Q6: "29400000000000",
    D7: "PD-0098",
    E7: "SECOND",
    F7: "",
    G7: "JOINER",
    K7: "M",
    M7: "C",
  };
  for (const [ref, value] of Object.entries(expected)) assert.equal(cell(xml, ref).value ?? "", value, `Additions ${ref}`);
  assert.equal(cell(xml, "N6").value, null, "an employee is their own principal: Principal ID stays empty");
  for (const ref of ["C6", "C7", "P6", "Q6", "H6"]) assert.equal(cell(xml, ref).style, cell(blank, ref).style, `${ref} keeps the insurer's style (date and text formats)`);
  assert.equal(cell(xml, "A6").value, "1", "the insurer's serial stays");
  for (const ref of ["S6", "T6", "AA6", "S597"]) assert.ok(cell(xml, ref).formula, `the insurer's check in ${ref} is kept`);
  assert.equal(cell(xml, "B8").value, null, "rows after the last person stay empty");

  // Every part of the workbook but the filled sheet and the policy settings is the insurer's, byte for byte.
  for (const [name, bytes] of before) {
    if (name === ADDITIONS || name === ASSUMPTIONS) continue;
    assert.deepEqual(files.get(name), bytes, `${name} is unchanged`);
  }
}

/** A deletion carries the 8-digit card number as text, the name in capitals and the relation. */
async function testADeletionFillsTheInsurersOwnCells() {
  const buffer = await buildLibanoMovementWorkbook({
    kind: "deletions",
    policy: POLICY,
    rows: [
      line({ adherentNumber: "00012345", day: "2026-11-22", fullName: "Leaving Employee Name", staffNumber: "34" }),
      line({ adherentNumber: "00012346", day: "2026-11-22", fullName: "Their Child", memberType: "child", staffNumber: "34-1" }),
    ],
    template,
  });
  const files = await parts(buffer);
  const xml = decode(files.get(DELETIONS));
  assert.equal(cell(xml, "B6").value, "Sato Pharma");
  assert.equal(cell(xml, "C6").value, String(excelDayNumber("2026-11-22")));
  assert.equal(cell(xml, "D6").value, "00012345", "the card number keeps its leading zeros");
  assert.equal(cell(xml, "E6").value, "34");
  assert.equal(cell(xml, "F6").value, "LEAVING EMPLOYEE NAME");
  assert.equal(cell(xml, "G6").value, "P");
  assert.equal(cell(xml, "E7").value, "34-1", "a family staff number stays text");
  assert.equal(cell(xml, "G7").value, "C");
  assert.deepEqual(files.get(ADDITIONS), (await parts(template)).get(ADDITIONS), "a deletions file leaves the Additions sheet as issued");
}

/** The checks read this year's policy: Sato, its own dates, the rules page's 15 days, plans A, B and C. */
async function testTheChecksReadThisYearsPolicy() {
  const xml = decode((await parts(await buildLibanoMovementWorkbook({ kind: "additions", policy: POLICY, rows: [line({})], template }))).get(ASSUMPTIONS));
  assert.equal(cell(xml, "E4").value, "Sato Pharma");
  assert.equal(cell(xml, "E5").value, String(excelDayNumber("2026-11-22")));
  assert.equal(cell(xml, "E6").value, String(excelDayNumber("2027-11-26")), "the policy's own end, not start plus twelve months");
  assert.equal(cell(xml, "E6").formula, false);
  assert.equal(LIBANO_GRACE_PERIOD_DAYS, 15);
  assert.equal(cell(xml, "E7").value, "15", "the grace period the rules page states");
  assert.deepEqual(["G14", "G15", "G16"].map((ref) => cell(xml, ref).value), ["A", "B", "C"]);
  assert.deepEqual(["H14", "H15", "H16"].map((ref) => cell(xml, ref).value), ["Single room", "Shared room", "Shared room"]);
  for (const [r, plan] of [[49, "A"], [50, "B"], [51, "C"]] as const) {
    assert.deepEqual(["C", "D", "E", "F"].map((column) => cell(xml, `${column}${r}`).value), [plan, "P", "S", "C"], `plan ${plan} takes the employee, spouse and children`);
  }
}

/** More people than the insurer's sheet has rows is refused, never cut short. */
async function testAFileLargerThanTheSheetIsRefused() {
  assert.equal(LIBANO_ADDITIONS_SHEET_ROWS, 592);
  assert.equal(LIBANO_DELETIONS_SHEET_ROWS, 395);
  const many = Array.from({ length: LIBANO_DELETIONS_SHEET_ROWS + 1 }, (_, index) => line({ adherentNumber: String(10_000_000 + index) }));
  await assert.rejects(buildLibanoMovementWorkbook({ kind: "deletions", policy: POLICY, rows: many, template }), /deletions sheet holds 395 people/);
}

export async function runMedicalInsuranceLibanoSheetTests() {
  await testTheTemplateIsTheInsurersWorkbookWithNobodyOnIt();
  await testAnAdditionFillsTheInsurersOwnCells();
  await testADeletionFillsTheInsurersOwnCells();
  await testTheChecksReadThisYearsPolicy();
  await testAFileLargerThanTheSheetIsRefused();
}
