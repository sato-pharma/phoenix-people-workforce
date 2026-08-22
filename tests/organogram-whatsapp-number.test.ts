import assert from "node:assert/strict";

import {
  hasWhatsAppNumber,
  toWhatsAppNumber,
  whatsAppChatUrl,
} from "../src/lib/reports/organogram-whatsapp.ts";

export function runOrganogramWhatsAppNumberTests() {
  const EXPECTED = "201012345678";

  // The three shapes production actually holds. The first is the common case by a wide
  // margin (124 of 175 active employees on 2026-08-22) — a leading zero lost to a
  // spreadsheet import, which is why it must be accepted rather than treated as junk.
  assert.equal(toWhatsAppNumber("1012345678"), EXPECTED, "10 digits, leading zero lost");
  assert.equal(toWhatsAppNumber("01012345678"), EXPECTED, "11-digit local form");
  assert.equal(toWhatsAppNumber("201012345678"), EXPECTED, "12-digit international form");

  // Cosmetic noise a human typed into the field.
  assert.equal(toWhatsAppNumber("+20 101 234 5678"), EXPECTED, "plus, country code and spaces");
  assert.equal(toWhatsAppNumber("010-1234-5678"), EXPECTED, "dashes");
  assert.equal(toWhatsAppNumber("  01012345678  "), EXPECTED, "surrounding whitespace");
  assert.equal(toWhatsAppNumber("\u0660\u0661\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668"), EXPECTED, "Arabic-Indic digits");

  // Two numbers in one field (5 employees). The primary leads, so the first readable
  // one wins rather than the field being discarded as unparseable.
  assert.equal(toWhatsAppNumber("01012345678 / 01112345679"), EXPECTED, "two numbers, slash separated");
  assert.equal(toWhatsAppNumber("01012345678 - 01112345679"), EXPECTED, "two numbers, dash separated");

  // Every live Egyptian mobile prefix must survive, or a whole carrier's worth of staff
  // silently loses the button.
  for (const prefix of ["010", "011", "012", "015"]) {
    assert.equal(
      toWhatsAppNumber(`${prefix}12345678`),
      `20${prefix.slice(1)}12345678`,
      `${prefix} is a live Egyptian mobile prefix`,
    );
  }

  // Nothing on file.
  for (const empty of [null, undefined, "", "   ", "n/a", "-"]) {
    assert.equal(toWhatsAppNumber(empty), null, `empty input ${JSON.stringify(empty)} yields no chat`);
  }

  // THE SAFETY CASE. A wrong number here does not break a page — it opens a chat with a
  // stranger and invites the user to message them. An over-long run must be refused
  // outright, never sliced down to a plausible-looking eleven digits, because the slice
  // would validate and be someone else entirely.
  assert.equal(toWhatsAppNumber("0101234567890123"), null, "over-long run must NOT be sliced into a valid-looking number");
  assert.equal(toWhatsAppNumber("010123456789"), null, "12 digits that are not the 20 country code");
  assert.equal(toWhatsAppNumber("0101234567"), null, "one digit short");

  // Unassigned mobile prefixes and landlines are not WhatsApp numbers.
  assert.equal(toWhatsAppNumber("01312345678"), null, "013 is not an assigned Egyptian mobile prefix");
  assert.equal(toWhatsAppNumber("01412345678"), null, "014 is not an assigned Egyptian mobile prefix");
  assert.equal(toWhatsAppNumber("0221234567"), null, "Cairo landline is not a mobile");

  // The presence flag must agree with the resolver exactly — it is the only thing the
  // browser is told, and a disagreement renders a button that leads nowhere.
  assert.equal(hasWhatsAppNumber("1012345678"), true, "readable number reports present");
  assert.equal(hasWhatsAppNumber("0221234567"), false, "landline reports absent");
  assert.equal(hasWhatsAppNumber(null), false, "no number reports absent");

  // No `text` parameter: the owner asked to land in the chat ready to write, and a
  // canned opening line would put words in his mouth.
  assert.equal(whatsAppChatUrl(EXPECTED), "https://wa.me/201012345678", "chat url shape");
  assert.ok(!whatsAppChatUrl(EXPECTED).includes("text="), "no prefilled message is added");
}
