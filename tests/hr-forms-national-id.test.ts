import { strict as assert } from "node:assert";

import {
  NATIONAL_ID_GOVERNORATE_CODES,
  describeNationalIdConflict,
  derivedBirthDate,
  derivedBirthPlaceAr,
  fillFromNationalId,
  governorateEnglishForCode,
  parseEgyptianNationalId,
  unrecognisedGovernorateNames,
} from "../src/lib/hiring-pack/national-id.ts";

/**
 * READING THE NATIONAL ID SO NOBODY TYPES IT TWICE.
 *
 * The contract prints تاريخ الميلاد and محل الميلاد and `collectHiringPackGaps` blocks on both. In
 * production 103 of 108 active employees had no hiring profile, so they were blocked on two values
 * the employees table was already holding inside the national ID. This module reads them out.
 *
 * What these tests are actually defending, in order of what it costs to get wrong:
 *
 *   1. A WRONG governorate reaching محل الميلاد. Blank is chased; wrong is signed and filed with the
 *      Social Insurance Authority. So every doubt has to return null, and the boundary cases below
 *      are the ones that would otherwise sail through: a month of 13, a February 30th, a governorate
 *      code the Authority does not issue, a birth date in the future.
 *   2. A derived value OVERWRITING a typed one. The module is a fallback and nothing more. If it
 *      ever prefers its own reading to a stored answer, it silently rewrites somebody's identity on
 *      a legal document, and the only sign is that the paper is wrong.
 *   3. The English governorate names DRIFTING from `@/lib/geo/egypt-locations`. The repo already
 *      carries one Egyptian place vocabulary; a second one that spells Menoufia differently is how
 *      a person's birthplace stops matching everything else about them. The last test pins it.
 */

// 1990-01-01, Dakahlia (12). Laid out digit by digit because every test below leans on the layout:
// [0] century, [1..2] year, [3..4] month, [5..6] day, [7..8] governorate, [9..12] serial, [13] check.
const DAKAHLIA_1990 = "29001011200015";
// 2001-02-03, Cairo (01) — the other century, so the century digit is exercised in both directions.
const CAIRO_2001 = "30102030101234";

function testItReadsTheDateAndTheGovernorate(): void {
  const older = parseEgyptianNationalId(DAKAHLIA_1990);
  assert.ok(older, "a well-formed 1900s id must parse");
  assert.equal(older?.birthDate, "1990-01-01", "century digit 2 must read as 19xx");
  assert.equal(older?.governorateCode, "12", "digits 8-9 are the governorate code");
  assert.equal(older?.governorateEn, "Dakahlia", "code 12 is Dakahlia");
  assert.equal(older?.governorateAr, "الدقهلية", "the Arabic must be the spelling a contract prints");

  const newer = parseEgyptianNationalId(CAIRO_2001);
  assert.ok(newer, "a well-formed 2000s id must parse");
  assert.equal(newer?.birthDate, "2001-02-03", "century digit 3 must read as 20xx");
  assert.equal(newer?.governorateEn, "Cairo", "code 01 is Cairo");

  // The two thin wrappers the callers actually use must agree with the parse rather than
  // reimplementing it.
  assert.equal(derivedBirthDate(CAIRO_2001), "2001-02-03", "derivedBirthDate must match the parse");
  assert.equal(derivedBirthPlaceAr(DAKAHLIA_1990), "الدقهلية", "derivedBirthPlaceAr must match the parse");
}

function testEveryDoubtReturnsNull(): void {
  // Each of these would otherwise produce a plausible-looking value on a government form.
  const refused: [string, string][] = [
    ["", "an empty string"],
    ["2900101120001", "thirteen digits"],
    ["290010112000155", "fifteen digits"],
    ["19001011200015", "a century digit of 1"],
    ["49001011200015", "a century digit of 4"],
    ["2900101120001X", "a non-digit in the serial"],
    ["29013011200015", "month 13"],
    ["29000011200015", "month 00"],
    ["29002301200015", "the 30th of February"],
    ["29001321200015", "day 32"],
    ["39901011200015", "a birth date in the future"],
  ];

  for (const [id, why] of refused) {
    assert.equal(parseEgyptianNationalId(id), null, `${why} must not parse: ${id}`);
  }

  // Spelled out rather than folded into the loop, because it is the one refusal a reader is most
  // likely to think is over-strict: the date inside it is perfectly valid.
  assert.equal(
    parseEgyptianNationalId("29001019900015"),
    null,
    "a governorate code the Authority does not issue must refuse the whole id, valid date or not",
  );
}

function testBornAbroadIsAnAnswerNotAGap(): void {
  // Code 88 — outside the Republic. A real answer with no governorate behind it.
  const abroad = parseEgyptianNationalId("29001018800015");
  assert.ok(abroad, "code 88 is a valid, issued code and must parse");
  assert.equal(abroad?.governorateEn, null, "born abroad resolves to no English governorate");
  assert.equal(abroad?.governorateAr, "خارج الجمهورية", "the Arabic answer is خارج الجمهورية");

  // The birth date is still known, so it still fills. The birthplace is not a governorate, so the
  // gap must stand and the person must be asked — filling محل الميلاد with "outside the Republic"
  // answers a different question than the form asks.
  const filled = fillFromNationalId({ nationalId: "29001018800015", birthDate: null, birthPlace: null });
  assert.equal(filled.birthDate, "1990-01-01", "a birth date is derivable even when born abroad");
  assert.equal(filled.birthPlace, null, "born abroad must not fill the birthplace");
  assert.deepEqual(filled.derived, ["birthDate"], "only the date may be reported as derived");
}

function testArabicIndicDigitsAreTheSameNumber(): void {
  // A scanned card pasted from a phone keyboard arrives in Arabic-Indic digits. Refusing it would
  // report a national ID the company holds as missing.
  const arabicIndic = "٢٩٠٠١٠١١٢٠٠٠١٥";
  const parsed = parseEgyptianNationalId(arabicIndic);
  assert.ok(parsed, "Arabic-Indic digits must parse");
  assert.equal(parsed?.birthDate, "1990-01-01", "the value must match the ASCII spelling of the same id");
  assert.equal(parsed?.governorateEn, "Dakahlia", "and so must the governorate");

  // Extended Arabic-Indic (U+06F0..) is the same number written with the other code block.
  const extended = "۲۹۰۰۱۰۱۱۲۰۰۰۱۵";
  assert.equal(
    parseEgyptianNationalId(extended)?.birthDate,
    "1990-01-01",
    "extended Arabic-Indic digits must parse identically",
  );

  // Leniency about the KEYBOARD is not leniency about the FORMAT.
  assert.equal(parseEgyptianNationalId("٢٩٠٠١٠١"), null, "a short Arabic-Indic id must still refuse");
}

function testItFillsBlanksAndNeverOverwrites(): void {
  const blank = fillFromNationalId({ nationalId: DAKAHLIA_1990, birthDate: null, birthPlace: null });
  assert.equal(blank.birthDate, "1990-01-01", "a blank birth date must fill from the id");
  assert.equal(blank.birthPlace, "الدقهلية", "a blank birthplace must fill from the id");
  assert.deepEqual(blank.derived.sort(), ["birthDate", "birthPlace"], "both must be reported as derived");

  // THE RULE. A stored answer wins even when the id disagrees with it — see the module header.
  const stored = fillFromNationalId({
    nationalId: DAKAHLIA_1990,
    birthDate: "1988-07-14",
    birthPlace: "الجيزة",
  });
  assert.equal(stored.birthDate, "1988-07-14", "a typed birth date must survive a disagreeing id");
  assert.equal(stored.birthPlace, "الجيزة", "a typed birthplace must survive a disagreeing id");
  assert.deepEqual(stored.derived, [], "nothing was derived, so nothing may be reported as derived");

  // Whitespace is not an answer.
  const whitespace = fillFromNationalId({ nationalId: DAKAHLIA_1990, birthDate: "  ", birthPlace: "  " });
  assert.equal(whitespace.birthDate, "1990-01-01", "a whitespace-only birth date counts as blank");
  assert.equal(whitespace.birthPlace, "الدقهلية", "a whitespace-only birthplace counts as blank");

  // An unreadable id changes nothing at all, in either direction.
  const noId = fillFromNationalId({ nationalId: "not-an-id", birthDate: null, birthPlace: null });
  assert.equal(noId.birthDate, null, "an unreadable id must leave the birth date blank");
  assert.equal(noId.birthPlace, null, "an unreadable id must leave the birthplace blank");
  assert.deepEqual(noId.derived, [], "an unreadable id derives nothing");

  // Running it on its own output must be a no-op — the fill is applied on every page load.
  const twice = fillFromNationalId({
    nationalId: DAKAHLIA_1990,
    birthDate: blank.birthDate,
    birthPlace: blank.birthPlace,
  });
  assert.equal(twice.birthDate, blank.birthDate, "re-filling must not change a derived birth date");
  assert.deepEqual(twice.derived, [], "on the second pass nothing is newly derived");
}

function testADisagreementIsReportedNotResolved(): void {
  assert.equal(
    describeNationalIdConflict(DAKAHLIA_1990, "1990-01-01"),
    null,
    "agreeing values have nothing to report",
  );
  assert.equal(describeNationalIdConflict(DAKAHLIA_1990, null), null, "no stored date is not a conflict");
  assert.equal(describeNationalIdConflict("not-an-id", "1990-01-01"), null, "no readable id is not a conflict");

  const conflict = describeNationalIdConflict(DAKAHLIA_1990, "1988-07-14");
  assert.ok(conflict, "a disagreement must be reported");
  assert.ok(conflict?.includes("1988-07-14"), "the message must name the stored date");
  assert.ok(conflict?.includes("1990-01-01"), "the message must name the id's own date");

  // A timestamp stored where a date was expected must not read as a disagreement with itself.
  assert.equal(
    describeNationalIdConflict(DAKAHLIA_1990, "1990-01-01T00:00:00.000Z"),
    null,
    "a timestamp on the same day is not a conflict",
  );
}

function testTheNamesStillMatchTheOnePlaceVocabulary(): void {
  // THE PIN. Every English governorate this table borrows must still round-trip through
  // `resolveGovernorate`. A rename in egypt-locations fails here rather than silently printing a
  // birthplace the rest of the system cannot match back to a governorate.
  assert.deepEqual(
    unrecognisedGovernorateNames(),
    [],
    "every governorate name must round-trip through @/lib/geo/egypt-locations",
  );

  // 27 governorates plus code 88. A code quietly dropped from the table turns a parseable id into a
  // refusal, which reads on the board as "this person has no national ID".
  assert.equal(NATIONAL_ID_GOVERNORATE_CODES.length, 28, "27 governorates plus born-abroad");
  assert.equal(governorateEnglishForCode("88"), null, "88 must resolve to no governorate");
  assert.equal(governorateEnglishForCode("17"), "Menoufia", "code 17 is Menoufia");
  assert.equal(governorateEnglishForCode("15"), "Kafr El-Sheikh", "code 15 is Kafr El-Sheikh");
  assert.equal(governorateEnglishForCode("99"), null, "an unissued code resolves to nothing");
}

export function runHrFormsNationalIdTests(): void {
  testItReadsTheDateAndTheGovernorate();
  testEveryDoubtReturnsNull();
  testBornAbroadIsAnAnswerNotAGap();
  testArabicIndicDigitsAreTheSameNumber();
  testItFillsBlanksAndNeverOverwrites();
  testADisagreementIsReportedNotResolved();
  testTheNamesStillMatchTheOnePlaceVocabulary();
}
