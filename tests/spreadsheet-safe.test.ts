import assert from "node:assert/strict";

import {
  CSV_BOM,
  csvField,
  csvLine,
  looksLikeSpreadsheetFormula,
  spreadsheetSafe,
  spreadsheetSafeText,
} from "../src/lib/export/spreadsheet-safe.ts";

/**
 * The one formula-injection guard for every CSV/XLSX built from text a person or a browser supplied
 * (the System Error & Data Integrity Audit export is its first caller). A spreadsheet runs a cell as
 * a formula when its first meaningful character is = + - @ — after skipping whitespace, a tab or a
 * carriage return, and treating the full-width ＝＋－＠ the same way. The older per-file guards
 * tested only the first character, so a tab- or space-led formula went through live.
 */
export function runSpreadsheetSafeTests() {
  const hostile = [
    `=CMD|' /C calc'!A0`,
    `+1`,
    `-1`,
    `@SUM(A1)`,
    `\t=HYPERLINK("http://evil","click")`,
    `\r=1+1`,
    `  =1+1`,
    `＝1+1`,
    `＋1`,
    `－1`,
    `＠x`,
  ];
  for (const value of hostile) {
    assert.equal(looksLikeSpreadsheetFormula(value), true, `formula lead not detected: ${JSON.stringify(value)}`);
    const safe = spreadsheetSafeText(value);
    assert.equal(safe.startsWith("'"), true, `cell not neutralised: ${JSON.stringify(value)} -> ${JSON.stringify(safe)}`);
    assert.equal(looksLikeSpreadsheetFormula(safe), false, `neutralised cell still reads as a formula: ${JSON.stringify(safe)}`);
    // The CSV path neutralises before it quotes, so the field never starts with a live lead.
    const field = csvField(value);
    const unquoted = field.startsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field;
    assert.equal(unquoted.startsWith("'"), true, `CSV field not neutralised: ${JSON.stringify(value)} -> ${field}`);
  }

  // Control characters are removed, but a tab-led formula is still caught after the strip.
  assert.equal(spreadsheetSafeText("a\u0000b\u0007c"), "abc");

  // Plain text passes untouched — a hyphenated name, an e-mail, a negative-looking word mid-text.
  for (const value of ["Ahmed Ali", "Al-Sayed", "phoenix@example.com", "KPIs", "Day 30 - review", "100%"]) {
    assert.equal(spreadsheetSafeText(value), value, `plain text was altered: ${value}`);
  }

  // A real number stays a number (a negative count must not become text), and so does a boolean;
  // null and undefined are an empty cell, never the word "null".
  assert.equal(spreadsheetSafe(-3), -3);
  assert.equal(spreadsheetSafe(0), 0);
  assert.equal(spreadsheetSafe(Number.NaN), null);
  assert.equal(spreadsheetSafe(true), true);
  assert.equal(spreadsheetSafe(null), null);
  assert.equal(spreadsheetSafeText(undefined), "");
  assert.equal(csvField(null), "");

  // CSV quoting: a comma, a quote or a line break is quoted and the quote doubled.
  assert.equal(csvField('He said "no", twice'), '"He said ""no"", twice"');
  assert.equal(csvField("line one\nline two"), '"line one\nline two"');
  assert.equal(csvLine(["SHARED — 3 EMPLOYEES AFFECTED", 4, null, "=1+1"]), "SHARED — 3 EMPLOYEES AFFECTED,4,,'=1+1");

  // The BOM is what makes Excel read a UTF-8 CSV (Arabic names) correctly.
  assert.equal(CSV_BOM, "﻿");
}
