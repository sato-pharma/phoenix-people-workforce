import { strict as assert } from "node:assert";

import {
  applyNationalIdRead,
  longIsoDate,
  nationalIdNotes,
  readNationalIdForForm,
  type NationalIdFormFields,
} from "../src/lib/employees/national-id-autofill.ts";

/**
 * EMPLOYEE MASTER: TYPE THE NATIONAL ID, THE FIELDS IT STATES FILL THEMSELVES.
 *
 * `parseEgyptianNationalId` already reads the layout and refuses every doubt; this module decides
 * what the FORM does with a reading. What is defended here, in order of what a mistake costs:
 *
 *   1. HR's own typing is never replaced. A birth date somebody typed that disagrees with the ID is
 *      reported, with a click to take the ID's value — never silently corrected, because the stored
 *      date reaches government forms and nothing here knows which of the two is the typo.
 *   2. Correcting a mistyped ID moves what the OLD reading placed — and only that.
 *   3. A half-typed or deleted-into ID changes nothing but the ID box, so deleting a digit never
 *      wipes a date.
 */

// [0] century, [1..2] year, [3..4] month, [5..6] day, [7..8] governorate, [9..12] serial, [13] check.
const DAKAHLIA_1990_MALE = "29001011200015"; // 1990-01-01, Dakahlia (12), digit 13 = 1
const CAIRO_2001_MALE = "30102030101234"; // 2001-02-03, Cairo (01), digit 13 = 3
const CAIRO_2001_FEMALE = "30102030101224"; // same day, digit 13 = 2
const BORN_ABROAD_1990 = "29001018800015"; // governorate code 88

const BLANK: NationalIdFormFields = { nationalId: "", gender: "", birthDate: "", birthPlace: "" };

function testItReadsTheThreeFields(): void {
  assert.deepEqual(readNationalIdForForm(DAKAHLIA_1990_MALE), {
    gender: "male",
    birthDate: "1990-01-01",
    birthPlace: "الدقهلية",
  });
  assert.equal(readNationalIdForForm(CAIRO_2001_FEMALE)?.gender, "female", "an even digit 13 is female");
  assert.equal(readNationalIdForForm(CAIRO_2001_MALE)?.birthDate, "2001-02-03", "century 3 is the 2000s");
  assert.equal(readNationalIdForForm("2900101120001"), null, "thirteen digits reads nothing");
  assert.equal(readNationalIdForForm(""), null, "an empty box reads nothing");
  assert.equal(
    readNationalIdForForm(BORN_ABROAD_1990)?.birthPlace,
    null,
    "born abroad states no governorate — the form must not invent one",
  );
}

function testTypingTheIdFillsTheBlanks(): void {
  const filled = applyNationalIdRead(BLANK, DAKAHLIA_1990_MALE);
  assert.equal(filled.nationalId, DAKAHLIA_1990_MALE);
  assert.equal(filled.gender, "male");
  assert.equal(filled.birthDate, "1990-01-01");
  assert.equal(filled.birthPlace, "الدقهلية");

  const abroad = applyNationalIdRead(BLANK, BORN_ABROAD_1990);
  assert.equal(abroad.birthDate, "1990-01-01", "born abroad still states the date");
  assert.equal(abroad.birthPlace, "", "but never a birthplace");
}

function testWhatHrTypedIsNeverOverwritten(): void {
  // 1: a typed date that disagrees with the ID stays exactly as typed.
  const typed: NationalIdFormFields = { ...BLANK, birthDate: "1990-03-07", gender: "female", birthPlace: "الغربية - زفتي" };
  const after = applyNationalIdRead(typed, DAKAHLIA_1990_MALE);
  assert.equal(after.birthDate, "1990-03-07", "a typed birth date wins over the ID");
  assert.equal(after.gender, "female", "a typed gender wins over the ID");
  assert.equal(after.birthPlace, "الغربية - زفتي", "a typed birthplace wins over the ID");
  assert.equal(after.nationalId, DAKAHLIA_1990_MALE, "only the ID box changed");

  // The same holds when only one box is typed: the others still fill.
  const partly = applyNationalIdRead({ ...BLANK, gender: "male" }, CAIRO_2001_FEMALE);
  assert.equal(partly.gender, "male", "a typed gender is kept even when the ID says otherwise");
  assert.equal(partly.birthDate, "2001-02-03", "the blank date still fills");
}

function testCorrectingTheIdMovesOnlyWhatTheOldReadingPlaced(): void {
  const first = applyNationalIdRead(BLANK, CAIRO_2001_MALE);
  const second = applyNationalIdRead(first, CAIRO_2001_FEMALE);
  assert.equal(second.gender, "female", "a value the previous reading placed follows the corrected ID");

  const toOther = applyNationalIdRead(first, DAKAHLIA_1990_MALE);
  assert.equal(toOther.birthDate, "1990-01-01");
  assert.equal(toOther.birthPlace, "الدقهلية");

  // HR then edits the date by hand; a further ID change must leave HER date alone.
  const edited = { ...toOther, birthDate: "1991-05-05" };
  const again = applyNationalIdRead(edited, CAIRO_2001_MALE);
  assert.equal(again.birthDate, "1991-05-05", "a hand-edited date is no longer the ID's to move");
}

function testAnUnreadableIdChangesNothingButTheBox(): void {
  const filled = applyNationalIdRead(BLANK, DAKAHLIA_1990_MALE);
  const deleted = applyNationalIdRead(filled, DAKAHLIA_1990_MALE.slice(0, 13));
  assert.equal(deleted.nationalId, DAKAHLIA_1990_MALE.slice(0, 13));
  assert.equal(deleted.birthDate, "1990-01-01", "deleting a digit never wipes the date");
  assert.equal(deleted.gender, "male");

  // A month of 13 is not a date: the reader refuses, so nothing fills.
  const nonsense = applyNationalIdRead(BLANK, "29013011200015");
  assert.equal(nonsense.birthDate, "", "an impossible date fills nothing");
}

function testNotesSayWhereAValueCameFromAndWhereItDiffers(): void {
  const filled = applyNationalIdRead(BLANK, DAKAHLIA_1990_MALE);
  const clean = nationalIdNotes(filled);
  assert.deepEqual(
    clean.map((note) => `${note.field}:${note.kind}`),
    ["gender:fromId", "birthDate:fromId", "birthPlace:fromId"],
  );

  // A typed date that disagrees: reported with the ID's value ready to take, in words.
  const differing = nationalIdNotes({ ...filled, birthDate: "1990-03-07" });
  const date = differing.find((note) => note.field === "birthDate");
  assert.equal(date?.kind, "differs");
  assert.equal(date?.value, "1990-01-01", "the click writes the ID's value");
  assert.equal(date?.text, "The national ID reads 1 January 1990.");

  // A birthplace carrying a district is HR's own wording — never reported as a disagreement.
  const district = nationalIdNotes({ ...filled, birthPlace: "الدقهلية - ميت غمر" });
  assert.equal(
    district.find((note) => note.field === "birthPlace"),
    undefined,
    "a typed birthplace is not second-guessed",
  );

  // A blank birthplace beside a readable ID is offered, not silently filled.
  const blankPlace = nationalIdNotes({ ...filled, birthPlace: "" });
  assert.equal(blankPlace.find((note) => note.field === "birthPlace")?.kind, "differs");

  assert.deepEqual(nationalIdNotes(BLANK), [], "no readable ID, no notes");
  assert.equal(longIsoDate("1994-07-03"), "3 July 1994");
}

export function runEmployeeNationalIdAutofillTests(): void {
  testItReadsTheThreeFields();
  testTypingTheIdFillsTheBlanks();
  testWhatHrTypedIsNeverOverwritten();
  testCorrectingTheIdMovesOnlyWhatTheOldReadingPlaced();
  testAnUnreadableIdChangesNothingButTheBox();
  testNotesSayWhereAValueCameFromAndWhereItDiffers();
}
