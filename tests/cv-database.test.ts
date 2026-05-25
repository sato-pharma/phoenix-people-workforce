import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  classifyCvExperience,
  durationMonthsFromText,
  formatDurationMonths,
  parseCvDatabaseWorkbook,
  summarizeCvDatabase,
} from "@/lib/cv/cv-database";

async function workbookBuffer(rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("CV Database");
  rows.forEach((row) => worksheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return buffer as ArrayBuffer;
}

export async function runCvDatabaseTests() {
  assert.equal(durationMonthsFromText("2 years 3 months"), 27);
  assert.equal(durationMonthsFromText("1.5 years"), 18);
  assert.equal(formatDurationMonths(30), "2 years 6 months");

  assert.equal(
    classifyCvExperience({
      companies: "",
      durationMonths: null,
      from: "",
      medicalSalesExp: "Fresh",
    }),
    "fresh",
  );
  assert.equal(
    classifyCvExperience({
      companies: "Acme Pharma",
      durationMonths: null,
      from: "",
      medicalSalesExp: "",
    }),
    "experienced",
  );

  const parsed = await parseCvDatabaseWorkbook(
    await workbookBuffer([
      ["Name", "Date of sending CV", "Medical Sales Exp?", "From", "To", "Duration", "Companies", "CV Name"],
      ["Mona Ali", "2026-05-17", "Yes", "2022-01-01", "2024-01-01", "", "Alpha Pharma; Beta Pharma", "mona.pdf"],
      ["Omar Said", "2026-05-16", "No", "", "", "", "", "omar.pdf"],
    ]),
    "sample.xlsx",
  );

  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].dateOfSendingCv, "2026-05-17");
  assert.equal(parsed.rows[0].status, "experienced");
  assert.equal(parsed.rows[0].durationMonths, 24);
  assert.equal(parsed.rows[1].status, "fresh");

  const summary = summarizeCvDatabase(parsed.rows);
  assert.equal(summary.candidates, 2);
  assert.equal(summary.experienced, 1);
  assert.equal(summary.fresh, 1);
  assert.equal(summary.companies, 2);
}
