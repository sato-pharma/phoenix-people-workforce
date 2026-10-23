import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import ExcelJS from "exceljs";

import { looksLikeSpreadsheetFormula } from "../src/lib/export/spreadsheet-safe.ts";
import {
  SYSTEM_AUDIT_EXPORT_HEADINGS,
  SYSTEM_AUDIT_XLSX_ROW_LIMIT,
  SystemAuditExportTooLargeError,
  createSystemAuditCsvStream,
  systemAuditCsvLine,
  systemAuditExportFilename,
  systemAuditXlsxCells,
  writeSystemAuditWorkbook,
} from "../src/lib/system-audit/export.ts";
import {
  INCIDENT_COLUMN_HEADINGS,
  SYSTEM_ROW_NAME,
  incidentEmployeeName,
  incidentMessage,
  incidentPersonOps,
  incidentScope,
} from "../src/lib/system-audit/incidents-display.ts";
import { iterateSystemAuditExport } from "../src/lib/system-audit/repository.ts";
import {
  SILENT_DATA_MESSAGE,
  USER_MESSAGE_NOT_CAPTURED,
  type SystemAuditExportBatch,
  type SystemAuditPageRow,
} from "../src/lib/system-audit/types.ts";

// The System Error & Data Integrity Audit export (/api/admin/system-audit/export). Two promises
// the owner relies on, pinned here without a database or a server:
//   1. NO CELL IS EVER A FORMULA — text a browser sent us (a message, a module label, a name)
//      reaches the CSV and the XLSX neutralised, including the leads a first-character test misses
//      (a tab, a carriage return, a space, the full-width ＝).
//   2. THE EXPORT CARRIES EVERY FILTERED ROW — 12,345 rows across three keyset batches, with ties
//      on the same instant split across a batch boundary, come out as exactly 12,345 data lines.

const INJECTIONS = ["=CMD|' /C calc'!A0", "+1", "-1", "@x", "\t=1+1", "\r=1", " =1", "＝1"];

function fixtureRow(overrides: Partial<SystemAuditPageRow> = {}): SystemAuditPageRow {
  return {
    id: "0a1b2c3d-0000-4000-8000-000000000001",
    issueId: "9f000000-0000-4000-8000-000000000001",
    signatureKey: "app_error:portal:TypeError",
    family: "app_error",
    hrKey: "b-10",
    hrId: "B-10",
    employeeName: "Omar Gawish",
    roleAtEvent: "Super Admin",
    moduleLabel: "Payroll Management",
    moduleLabelSource: "nav_exact",
    shell: "admin",
    route: "/admin/payroll-management",
    occurredAt: "2026-10-22T22:30:00.000Z",
    occurredAtKind: "failure",
    affectedDate: null,
    userMessage: "Something went wrong",
    isSilent: false,
    technicalMessage: "TypeError: x is undefined",
    errorCode: "APP-500",
    title: "Payroll page crashed",
    rootCauseLevel: "probable",
    rootCause: "A null employee row",
    status: "investigating",
    issueStatus: "investigating",
    personOps: 3,
    people: 2,
    attemptCount: 2,
    pageLoads: 1,
    firstEventAt: "2026-10-22T22:29:00.000Z",
    lastEventAt: "2026-10-22T22:31:00.000Z",
    correlationId: null,
    isRootSymptom: true,
    relatedTable: null,
    relatedId: null,
    release: null,
    preFixBuild: false,
    triageOverride: null,
    triageReason: null,
    isTest: false,
    ...overrides,
  };
}

/** RFC 4180 fields of one CSV line (quotes doubled inside quoted fields). */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  // ignoreBOM keeps the byte-order mark in the text, so the test can see the export wrote it.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function* batchesOf(rows: SystemAuditPageRow[], size: number): AsyncGenerator<SystemAuditExportBatch, void, void> {
  for (let start = 0; start < rows.length; start += size) {
    const slice = rows.slice(start, start + size);
    yield { total: null, limit: size, offset: 0, rows: slice, next: null };
  }
}

function injectionTests() {
  for (const payload of INJECTIONS) {
    const row = fixtureRow({
      employeeName: payload,
      moduleLabel: payload,
      route: payload,
      technicalMessage: payload,
      userMessage: payload,
    });

    // XLSX: every text cell is neutralised; real counts stay numbers.
    const cells = systemAuditXlsxCells(row);
    assert.equal(cells.length, SYSTEM_AUDIT_EXPORT_HEADINGS.length, "one XLSX cell per heading");
    for (const [index, cell] of cells.entries()) {
      if (typeof cell === "string") {
        assert.equal(
          looksLikeSpreadsheetFormula(cell),
          false,
          `XLSX column "${SYSTEM_AUDIT_EXPORT_HEADINGS[index]}" carried ${JSON.stringify(payload)} as a live formula: ${JSON.stringify(cell)}`,
        );
      }
    }
    assert.ok(
      String(cells[5]).startsWith("'"),
      `the Error Encountered cell for ${JSON.stringify(payload)} must be prefixed with an apostrophe, got ${JSON.stringify(cells[5])}`,
    );

    // CSV: parse the line back and check every field.
    const fields = parseCsvLine(systemAuditCsvLine(row));
    assert.equal(fields.length, SYSTEM_AUDIT_EXPORT_HEADINGS.length, "one CSV field per heading");
    for (const [index, field] of fields.entries()) {
      assert.equal(
        looksLikeSpreadsheetFormula(field),
        false,
        `CSV column "${SYSTEM_AUDIT_EXPORT_HEADINGS[index]}" carried ${JSON.stringify(payload)} as a live formula: ${JSON.stringify(field)}`,
      );
    }
  }
}

async function workbookTests() {
  const rows = INJECTIONS.map((payload, index) =>
    fixtureRow({ id: `0a1b2c3d-0000-4000-8000-00000000000${index}`, userMessage: payload, moduleLabel: payload }),
  );
  const pass = new PassThrough();
  const chunks: Buffer[] = [];
  pass.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<void>((resolve) => pass.on("end", () => resolve()));
  const { rows: written } = await writeSystemAuditWorkbook(batchesOf(rows, 3), pass, {
    filters: "test filters",
    generatedBy: "=HYPERLINK(\"http://evil\")",
  });
  await ended;
  assert.equal(written, rows.length, "the workbook reports every row it wrote");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet("Incidents");
  assert.ok(sheet, "the Incidents sheet exists");
  assert.deepEqual(sheet.views?.[0]?.state, "frozen", "the header row is frozen");
  assert.equal(sheet.rowCount, rows.length + 1, "header + one row per incident");
  const header = (sheet.getRow(1).values as unknown[]).slice(1);
  assert.deepEqual(header, [...SYSTEM_AUDIT_EXPORT_HEADINGS], "the XLSX header is the 11 columns then the technical ones");

  let checked = 0;
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow((row) => {
      row.eachCell((cell) => {
        checked += 1;
        assert.notEqual(cell.type, ExcelJS.ValueType.Formula, `cell ${worksheet.name}!${cell.address} is a formula`);
        if (typeof cell.value === "string") {
          assert.equal(
            looksLikeSpreadsheetFormula(cell.value),
            false,
            `cell ${worksheet.name}!${cell.address} holds a live formula lead: ${JSON.stringify(cell.value)}`,
          );
        }
      });
    });
  }
  assert.ok(checked > rows.length * 10, "the formula scan actually read the cells");

  // Above the XLSX limit the writer stops with the sentence that points at the CSV.
  const many = new Array<SystemAuditPageRow>(SYSTEM_AUDIT_XLSX_ROW_LIMIT + 1).fill(fixtureRow());
  const sink = new PassThrough();
  sink.resume();
  await assert.rejects(
    writeSystemAuditWorkbook(batchesOf(many, many.length), sink, { filters: "", generatedBy: "test" }),
    (error: unknown) => error instanceof SystemAuditExportTooLargeError && /CSV/.test(error.message),
    "an XLSX past 100,000 rows must refuse and point at the CSV",
  );
}

/**
 * A fake `system_audit_page` that answers keyset calls exactly as the SQL does:
 * (occurred_at, id) < (after.occurredAt, after.id), ordered occurred_at desc, id desc, 5,000 a call,
 * `next` = the last row of a FULL batch, `total` null.
 */
function fakeKeysetClient(dataset: SystemAuditPageRow[], calls: { count: number }) {
  return {
    async rpc(name: string, args: { p_after: { occurredAt?: string; id?: string } | null; p_limit: number }) {
      assert.equal(name, "system_audit_page");
      calls.count += 1;
      const after = args.p_after ?? {};
      const afterAt = after.occurredAt ? Date.parse(after.occurredAt) : null;
      const afterId = after.id ?? null;
      const eligible = dataset.filter((row) => {
        if (afterAt === null || afterId === null) return true;
        const at = Date.parse(row.occurredAt);
        return at < afterAt || (at === afterAt && row.id < afterId);
      });
      const rows = eligible.slice(0, args.p_limit);
      const last = rows[rows.length - 1];
      const batch: SystemAuditExportBatch = {
        total: null,
        limit: args.p_limit,
        offset: 0,
        rows,
        next: rows.length === args.p_limit && last ? { occurredAt: last.occurredAt, id: last.id } : null,
      };
      return { data: batch, error: null };
    },
  };
}

async function everyRowTests() {
  const ROWS = 12_345;
  const base = Date.parse("2026-10-20T09:00:00.000Z");
  const dataset: SystemAuditPageRow[] = [];
  for (let index = 0; index < ROWS; index += 1) {
    // Seven rows share each instant, so the 5,000 boundary falls INSIDE a tie group.
    const occurredAt = new Date(base - Math.floor(index / 7) * 1000).toISOString();
    const id = `${(ROWS - index).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
    dataset.push(fixtureRow({ id, occurredAt, firstEventAt: occurredAt, lastEventAt: occurredAt }));
  }
  // The order the SQL returns: occurred_at desc, id desc.
  dataset.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  assert.equal(5000 % 7 === 0, false, "the fixture must split a tie group across the batch boundary");

  const calls = { count: 0 };
  let finished: { rows: number; error: unknown } | null = null;
  const stream = createSystemAuditCsvStream(
    iterateSystemAuditExport({}, fakeKeysetClient(dataset, calls) as never),
    (result) => {
      finished = result;
    },
  );
  const text = await readStream(stream);
  const lines = text.split("\r\n").filter((line) => line !== "");
  assert.equal(calls.count, 3, "12,345 rows are three keyset batches of 5,000 / 5,000 / 2,345");
  assert.equal(lines.length, ROWS + 1, `expected the header plus ${ROWS} data lines, got ${lines.length - 1} data lines`);
  assert.ok(lines[0].startsWith("﻿"), "the CSV starts with the UTF-8 byte-order mark");
  assert.deepEqual(parseCsvLine(lines[0].slice(1)), [...SYSTEM_AUDIT_EXPORT_HEADINGS], "the CSV header is the export headings");
  const ids = new Set(lines.slice(1).map((line) => parseCsvLine(line).at(-1)));
  assert.equal(ids.size, ROWS, "every occurrence id appears exactly once — none skipped, none repeated at a tie");
  assert.deepEqual(finished, { rows: ROWS, error: null }, "the export reports the rows it actually wrote");
}

function displayTests() {
  assert.deepEqual(
    [...INCIDENT_COLUMN_HEADINGS],
    [
      "HR ID",
      "Employee Name",
      "Module Name",
      "Error Date (Cairo)",
      "Error Time (Cairo)",
      "Error Encountered",
      "Error Code / Incident Ref",
      "Why",
      "Fixed Status",
      "Occurrences (this employee)",
      "Unique vs Shared",
    ],
    "the 11 columns, in the owner's order, with his headings",
  );
  assert.deepEqual(SYSTEM_AUDIT_EXPORT_HEADINGS.slice(0, 11), [...INCIDENT_COLUMN_HEADINGS], "the export leads with the 11 columns");

  const system = fixtureRow({ hrKey: null, hrId: null, employeeName: null, personOps: 4, people: 0 });
  assert.equal(incidentEmployeeName(system), SYSTEM_ROW_NAME, "a row with no person says System, never a blank");
  assert.equal(incidentPersonOps(system), "—", "a system row has no employee to count for");
  assert.equal(incidentScope(system), "SYSTEM — NO EMPLOYEE ATTRIBUTION");
  assert.equal(systemAuditXlsxCells(system)[9], "—", "the export's column 10 is a dash for a system row, never 0");

  assert.equal(incidentMessage(fixtureRow({ userMessage: null })), USER_MESSAGE_NOT_CAPTURED);
  assert.equal(
    incidentMessage(fixtureRow({ userMessage: "  ", family: "reconciliation", isSilent: true })),
    SILENT_DATA_MESSAGE,
    "a silent finding never borrows the stack trace as its message",
  );
  assert.equal(incidentMessage(fixtureRow({ userMessage: null, technicalMessage: "stack" })), USER_MESSAGE_NOT_CAPTURED);

  // Cairo, not UTC: 22:30 UTC on 22 Oct 2026 is 01:30 on the 23rd in Cairo (summer time, UTC+3).
  const cells = systemAuditXlsxCells(fixtureRow());
  assert.equal(cells[3], "2026-10-23", "the error date is the Cairo calendar day");
  assert.equal(cells[4], "01:30", "the error time is the Cairo wall clock");
  assert.equal(systemAuditExportFilename("csv", "2026-10-22T22:30:00.000Z"), "system-audit-2026-10-23.csv");
  assert.equal(systemAuditExportFilename("xlsx", "2026-10-22T20:00:00.000Z"), "system-audit-2026-10-22.xlsx");
}

export async function runSystemAuditExportTests() {
  displayTests();
  injectionTests();
  await workbookTests();
  await everyRowTests();
}
