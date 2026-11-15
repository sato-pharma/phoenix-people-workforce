import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import {
  buildCeoApprovalRows,
  ceoApprovalsWindow,
  type CeoApprovalRequestInput,
  type CeoApprovalStepInput,
} from "../src/lib/marketing-requests/ceo-approvals.ts";
import {
  buildCeoApprovalsWorkbook,
  ceoApprovalsExportFileName,
  ceoApprovalsRangeLabel,
  parseCeoApprovalsExportFormat,
  pickCeoApprovalsExportRows,
  renderCeoApprovalsHtml,
  type CeoApprovalsExportInput,
} from "../src/lib/marketing-requests/ceo-approvals-export.ts";

// CEO Approvals export (owner, 2026-11-15: "I want to be able to export selected in a very premium
// polished XLSX and PDF"): only the ticked requests, in the page's order, with the dates' own scope.

const RANGE = { from: "2026-11-08", to: "2026-11-15" };

function step(requestId: string, overrides: Partial<CeoApprovalStepInput> = {}): CeoApprovalStepInput {
  return {
    decisionAt: null,
    decisionByHrId: null,
    executedAt: null,
    isCc: false,
    requestId,
    sequence: 5,
    status: "pending",
    stepCode: "ceo_approval",
    stepName: "CEO Approval",
    ...overrides,
  };
}

function request(id: string, estimatedCost: number, customerName = `Customer ${id}`): CeoApprovalRequestInput {
  return {
    customerId: `customer-${id}`,
    customerName,
    estimatedCost,
    href: `/marketing-requests/${id}`,
    id,
    lineName: "Pedia",
    payDate: "2026-11-20",
    requestCode: `MKT-REQ-${id}`,
    requesterHrId: "B-154",
    requesterName: "Nermeen Salah",
    requestType: "Deal",
    status: "pending_approval",
  };
}

function rows(includeCarriedOver: boolean) {
  const ids = ["a", "b", "c", "old"];
  return buildCeoApprovalRows({
    ceoApprovals: [
      step("a", { decisionAt: "2026-11-08T08:00:00.000Z", decisionByHrId: "AA", status: "approved" }),
      step("b", { decisionAt: "2026-11-09T08:00:00.000Z", decisionByHrId: "AA", status: "approved" }),
      step("c", { decisionAt: "2026-11-10T08:00:00.000Z", decisionByHrId: "AA", status: "approved" }),
      step("old", { decisionAt: "2026-11-02T08:00:00.000Z", decisionByHrId: "AA", status: "approved" }),
    ],
    deciders: new Map([["aa", { isCeo: true, name: "Dr Anwar Gaweesh" }]]),
    includeCarriedOver,
    period: ceoApprovalsWindow(RANGE),
    requestsById: new Map(
      [request("a", 1500, "صيدلية <الشفاء>"), request("b", 2500), request("c", 4000), request("old", 900)].map((row) => [row.id, row]),
    ),
    steps: ids.map((id) => step(id, { sequence: 6, status: "current", stepCode: "finance_execution", stepName: "Finance Execution" })),
    todayCairo: "2026-11-15",
  });
}

function input(includeCarriedOver: boolean, picked: CeoApprovalsExportInput["picked"]): CeoApprovalsExportInput {
  return {
    exportedByName: "Hossam Reda",
    generatedAtIso: "2026-11-15T10:00:00.000Z",
    picked,
    report: { includeCarriedOver, range: RANGE, rows: rows(includeCarriedOver) },
  };
}

export async function runMarketingCeoApprovalsExportTests() {
  // ── The format and the file name ──────────────────────────────────────────────────────────────
  assert.equal(parseCeoApprovalsExportFormat("xlsx"), "xlsx");
  assert.equal(parseCeoApprovalsExportFormat("pdf"), "pdf");
  for (const bad of ["csv", "XLSX", "", null, undefined, 1]) assert.equal(parseCeoApprovalsExportFormat(bad), null, `${String(bad)} is not a format`);
  assert.equal(ceoApprovalsExportFileName(RANGE, "pdf"), "CEO Approvals 2026-11-08 to 2026-11-15.pdf");
  assert.equal(ceoApprovalsRangeLabel(RANGE), "08 Nov 2026 to 15 Nov 2026");

  // ── Only the ticked rows, in the page's order, never one from outside the period ──────────────
  const inRange = rows(false);
  assert.deepEqual(inRange.map((row) => row.requestId), ["a", "b", "c"], "the dates' own approvals only by default");
  const picked = pickCeoApprovalsExportRows(
    [{ requestId: "c" }, { note: "  pay\nfirst \u0007 please ", requestId: "a" }, { requestId: "old" }, { requestId: "not-a-request" }, null, "x"],
    inRange,
  );
  assert.deepEqual(picked.map((item) => item.row.requestId), ["a", "c"], "the ticked rows in screen order; ids outside the period are dropped");
  assert.equal(picked[0].note, "pay first please", "a note is cleaned of control characters and runs of space");
  assert.equal(pickCeoApprovalsExportRows([{ note: "x".repeat(900), requestId: "b" }], inRange)[0].note.length, 300, "a note is cut to 300 characters");
  assert.throws(() => pickCeoApprovalsExportRows([], inRange), /Tick at least one request/);
  assert.throws(() => pickCeoApprovalsExportRows("a", inRange), /Tick at least one request/);
  assert.throws(() => pickCeoApprovalsExportRows([{ requestId: "old" }], inRange), /None of the ticked requests is in this period/);
  assert.throws(() => pickCeoApprovalsExportRows(Array.from({ length: 2001 }, (_, i) => ({ requestId: String(i) })), inRange), /at most 2000/);

  // ── The PDF's page: the ticked rows, their total, escaped cells, columns that follow the switch ──
  const html = renderCeoApprovalsHtml(input(false, picked));
  assert.match(html, /MKT-REQ-a/);
  assert.match(html, /MKT-REQ-c/);
  assert.doesNotMatch(html, /MKT-REQ-b/, "an unticked request is not in the export");
  assert.match(html, /5,500/, "the total is the ticked rows' value (1,500 + 4,000)");
  assert.doesNotMatch(html, /5,500[^<]*8,000|8,000/, "the unticked request's value never reaches the total");
  assert.match(html, /صيدلية &lt;الشفاء&gt;/, "a customer name is escaped");
  assert.doesNotMatch(html, /<th>Listed as<\/th>/, "no Listed as column with the switch off");
  assert.match(html, /<th>Note<\/th>/, "a Note column when a note was typed");
  assert.match(html, /pay first please/);
  assert.equal((html.match(/<col style=/g) ?? []).length, 9, "nine columns: eight plus the note");
  assert.doesNotMatch(html, /border-radius:\s*[1-9]/, "square edges");

  const noNote = renderCeoApprovalsHtml(input(false, pickCeoApprovalsExportRows([{ requestId: "b" }], inRange)));
  assert.doesNotMatch(noNote, /<th>Note<\/th>/, "no Note column when nobody typed one");
  assert.equal((noNote.match(/<col style=/g) ?? []).length, 8);

  const carriedRows = rows(true);
  const withCarry = renderCeoApprovalsHtml(input(true, pickCeoApprovalsExportRows([{ requestId: "old" }, { requestId: "a" }], carriedRows)));
  assert.match(withCarry, /<th>Listed as<\/th>/, "the Listed as column with the switch on");
  assert.match(withCarry, /tag--carry/, "the carried-over row is marked");
  assert.match(withCarry, /1 carried over/);

  // ── The workbook: one sheet, the ticked rows, a live total ────────────────────────────────────
  const buffer = await buildCeoApprovalsWorkbook(input(false, picked));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  assert.equal(workbook.worksheets.length, 1, "one sheet");
  const sheet = workbook.worksheets[0];
  const cells: string[] = [];
  sheet.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.text ?? ""))));
  assert.ok(cells.includes("MKT-REQ-a") && cells.includes("MKT-REQ-c"), "the ticked requests are rows");
  assert.ok(!cells.includes("MKT-REQ-b"), "the unticked request is not");
  assert.ok(!cells.includes("Listed as"), "no Listed as column with the switch off");
  let sumFormula = "";
  sheet.eachRow((row) =>
    row.eachCell((cell) => {
      const value = cell.value as { formula?: string } | null;
      if (value && typeof value === "object" && value.formula?.startsWith("SUM(")) sumFormula = value.formula;
    }),
  );
  assert.ok(sumFormula, "the total is a live SUM, not a typed number");

  // ── The route and the screen ──────────────────────────────────────────────────────────────────
  const route = readFileSync(new URL("../app/api/marketing-requests/ceo-approvals/export/route.ts", import.meta.url), "utf8");
  assert.match(route, /getMarketingCeoApprovals\(/, "the rows are re-read on the server, never taken from the browser");
  assert.match(route, /writeRequiredAuditLog\(/, "every export is audited");
  const registry = readFileSync(new URL("../src/lib/security/access-registry.ts", import.meta.url), "utf8");
  assert.match(registry, /"\/api\/marketing-requests\/ceo-approvals\/export"/, "the export route is in the access registry");
  const screen = readFileSync(new URL("../src/components/marketing-requests/marketing-ceo-approvals-report.tsx", import.meta.url), "utf8");
  assert.match(screen, /Export XLSX/);
  assert.match(screen, /Export PDF/);
}
