import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
  ALL_RESIGNATION_FILTER,
  activeResignationFilterCount,
  buildResignationExportRows,
  buildResignationQueueRows,
  countOverdueResignations,
  daysUntilEffectiveDate,
  defaultResignationFilters,
  filterPayrollCandidates,
  filterResignationRecords,
  formatPayrollCandidateSystemId,
  isTerminatedResignation,
  payrollCandidatesVisible,
  queueRowEffectiveDate,
  queueRowSearchText,
  resignationActorLabel,
  resignationDaysState,
  resignationLineOptions,
  selectOverdueResignations,
  selectTerminatedRecords,
} from "../src/lib/resignations/view-model.ts";
import type {
  PayrollResignationCandidateRecord,
  ResignationRecord,
  ResignationStatus,
} from "../src/lib/resignations/types.ts";

function makeRecord(overrides: Partial<ResignationRecord> & { id: string }): ResignationRecord {
  return {
    approvedAt: null,
    approvedBy: null,
    cancelledAt: null,
    cancelledBy: null,
    completedAt: null,
    completedBy: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    createdBy: "a-16",
    createdByName: "Youmna Mohamed Salaheldeen Ahmed Kotb",
    effectiveDate: "2026-08-31",
    employeeHrId: "B-1",
    employeeName: "Test Employee",
    employeeStatus: null,
    jobTitle: "Medical Representative",
    lineName: "Pedia",
    reason: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectedReason: null,
    reviewedAt: null,
    reviewedBy: null,
    status: "submitted" as ResignationStatus,
    submittedDate: "2026-07-01",
    updatedAt: "2026-07-02T00:00:00.000Z",
    workflowNotes: null,
    ...overrides,
  };
}

function makeCandidate(
  overrides: Partial<PayrollResignationCandidateRecord> & { id: string },
): PayrollResignationCandidateRecord {
  return {
    areaName: "Dakahlia 1",
    createdBy: null,
    employeeName: "Payroll Only Person",
    firstSeenAt: "2026-07-13T00:00:00.000Z",
    hireDate: null,
    hrId: "B-153",
    jobTitle: "Medical Representative",
    lastPayoutMonth: 7,
    lastPayoutYear: 2026,
    lastSeenAt: "2026-07-13T00:00:00.000Z",
    lineName: "Anti Infective",
    nameAr: null,
    sourceFileName: "phoenix-salary-upload-template.xlsx",
    sourceRow: 129,
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

export function runResignationsViewModelTests() {
  // ── "Today" is Africa/Cairo, never the host clock ───────────────────────────
  // This instant is 2026-08-09 23:00 UTC, which is ALREADY 2026-08-10 in Cairo (UTC+2, or +3
  // under Egypt's summer time — both land on the 10th). An effective date of 2026-08-10 is
  // therefore TODAY: 0 days left. The old inline `new Date()` math resolved "today" from
  // whatever clock it ran on, so the server (UTC) said 1 and the browser (Cairo) said 0 — and
  // that disagreement is what produced React hydration error #418 on this page in production.
  const nearCairoMidnight = new Date("2026-08-09T23:00:00.000Z");
  assert.equal(
    daysUntilEffectiveDate("2026-08-10", nearCairoMidnight),
    0,
    "an effective date of 2026-08-10 must read as 0 days left once Cairo has already rolled over to the 10th",
  );
  assert.equal(
    daysUntilEffectiveDate("2026-08-11", nearCairoMidnight),
    1,
    "the day after Cairo's today must read as 1 day left",
  );
  assert.equal(
    daysUntilEffectiveDate("2026-07-18", nearCairoMidnight),
    -23,
    "an effective date already in the past must return a negative day count, not clamp to zero",
  );
  assert.equal(
    daysUntilEffectiveDate(null, nearCairoMidnight),
    null,
    "a missing effective date must return null rather than a bogus day count",
  );

  // ── Days-left states must be honest ─────────────────────────────────────────
  // Production showed "-23 DAYS / Escalation window" in red on 11 of 12 rows, including one
  // already COMPLETED — the old code ran a bare `days <= 7` test with no sign or status check.
  const closed = resignationDaysState(
    { effectiveDate: "2026-07-31", status: "completed" },
    nearCairoMidnight,
  );
  assert.equal(closed.text, "—", "a completed resignation must show no countdown at all");
  assert.equal(
    closed.tone,
    "neutral",
    "a completed resignation must never render as a red escalation",
  );

  const overdue = resignationDaysState(
    { effectiveDate: "2026-07-18", status: "approved" },
    nearCairoMidnight,
  );
  assert.equal(overdue.text, "23 days overdue", "a past-due OPEN record counts up, not down");
  assert.equal(overdue.label, "Left, never completed");
  assert.equal(overdue.tone, "danger");

  assert.equal(
    resignationDaysState({ effectiveDate: "2026-08-10", status: "approved" }, nearCairoMidnight)
      .text,
    "Today",
    "the last working day itself must read as Today, not '0 days'",
  );
  assert.equal(
    resignationDaysState({ effectiveDate: "2026-08-14", status: "approved" }, nearCairoMidnight)
      .label,
    "Escalation window",
  );
  assert.equal(
    resignationDaysState({ effectiveDate: "2026-08-31", status: "approved" }, nearCairoMidnight)
      .tone,
    "warning",
  );
  assert.equal(
    resignationDaysState({ effectiveDate: "2026-12-31", status: "approved" }, nearCairoMidnight)
      .tone,
    "neutral",
  );
  assert.equal(
    resignationDaysState({ effectiveDate: "2026-07-18", status: "cancelled" }, nearCairoMidnight)
      .tone,
    "neutral",
    "a cancelled resignation is closed too — no countdown, no red",
  );

  assert.equal(
    countOverdueResignations(
      [
        makeRecord({ effectiveDate: "2026-07-18", id: "o1", status: "approved" }),
        makeRecord({ effectiveDate: "2026-07-31", id: "o2", status: "completed" }),
        makeRecord({ effectiveDate: "2026-12-31", id: "o3", status: "approved" }),
      ],
      nearCairoMidnight,
    ),
    1,
    "only OPEN records past their effective date are overdue — completed and future ones are not",
  );

  // ── Status + line filtering ─────────────────────────────────────────────────
  const records = [
    makeRecord({ id: "r1", lineName: "Pedia", status: "approved" }),
    makeRecord({ employeeStatus: "terminated", id: "r2", lineName: "CNS", status: "completed" }),
    makeRecord({ id: "r3", lineName: "Pedia", status: "submitted" }),
  ];
  const candidates = [
    makeCandidate({ id: "c1", lineName: "Anti Infective" }),
    makeCandidate({ id: "c2", lineName: "Pedia" }),
  ];

  assert.deepEqual(
    resignationLineOptions(records, candidates),
    ["Anti Infective", "CNS", "Pedia"],
    "line options must be de-duplicated across both row kinds and sorted",
  );

  assert.deepEqual(
    filterResignationRecords(records, { ...defaultResignationFilters, status: "approved" }).map(
      (record) => record.id,
    ),
    ["r1"],
    "the status filter must keep only matching workflow records",
  );
  assert.deepEqual(
    filterResignationRecords(records, { ...defaultResignationFilters, lineName: "Pedia" }).map(
      (record) => record.id,
    ),
    ["r1", "r3"],
    "the line filter must keep only matching workflow records",
  );
  assert.deepEqual(
    filterPayrollCandidates(candidates, { ...defaultResignationFilters, lineName: "Pedia" }).map(
      (candidate) => candidate.id,
    ),
    ["c2"],
    "the line filter must apply to payroll candidates too",
  );

  // ── Payroll candidates vs a status filter ───────────────────────────────────
  assert.equal(payrollCandidatesVisible(defaultResignationFilters), true);
  assert.equal(
    payrollCandidatesVisible({ ...defaultResignationFilters, status: "approved" }),
    false,
    "payroll candidates carry no workflow status, so any status filter must exclude them",
  );

  const unfilteredQueue = buildResignationQueueRows(records, candidates, defaultResignationFilters);
  assert.equal(unfilteredQueue.length, 5, "the queue must merge workflow records and candidates");
  assert.equal(
    unfilteredQueue.filter((row) => row.kind === "payrollCandidate").length,
    2,
    "both payroll candidates belong in the unfiltered queue",
  );

  const statusFilteredQueue = buildResignationQueueRows(records, candidates, {
    ...defaultResignationFilters,
    status: "approved",
  });
  assert.equal(
    statusFilteredQueue.filter((row) => row.kind === "payrollCandidate").length,
    0,
    "a status filter must drop payroll candidates from the queue entirely",
  );

  // ── Queue accessors (what useSortableTable sorts and searches by) ───────────
  const candidateRow = unfilteredQueue.find((row) => row.kind === "payrollCandidate");
  assert.ok(candidateRow, "expected a payroll candidate row in the queue");
  assert.equal(
    queueRowEffectiveDate(candidateRow),
    "2026-07-01",
    "a candidate's sort date must be the first day of its last payout month so both row kinds interleave",
  );
  assert.match(
    queueRowSearchText(candidateRow),
    /phoenix-salary-upload-template\.xlsx/,
    "candidate search text must include the source file so HR can find a row by its upload",
  );

  // ── Terminated selection ────────────────────────────────────────────────────
  assert.deepEqual(
    selectTerminatedRecords(records).map((record) => record.id),
    ["r2"],
    "only employees whose lifecycle status is terminated belong in the Terminated Employees panel",
  );

  // ── Overdue selection (what the bulk close acts on) ─────────────────────────
  const overdueCandidates = [
    makeRecord({ effectiveDate: "2026-06-08", id: "od1", status: "approved" }),
    makeRecord({ effectiveDate: "2026-07-18", id: "od2", status: "under_review" }),
    makeRecord({ effectiveDate: "2026-07-31", id: "od3", status: "completed" }),
    makeRecord({ effectiveDate: "2026-07-31", id: "od4", status: "cancelled" }),
    makeRecord({ effectiveDate: "2026-12-31", id: "od5", status: "approved" }),
  ];
  assert.deepEqual(
    selectOverdueResignations(overdueCandidates, nearCairoMidnight).map((record) => record.id),
    ["od1", "od2"],
    "bulk close must target ONLY open, past-due records — never an already closed one, never a future one",
  );

  // ── Terminated employees live in the same queue, highlighted ────────────────
  assert.equal(isTerminatedResignation({ employeeStatus: "Terminated" }), true);
  assert.equal(isTerminatedResignation({ employeeStatus: "resigned" }), false);
  assert.equal(isTerminatedResignation({ employeeStatus: null }), false);

  // ── Filter chip count ───────────────────────────────────────────────────────
  assert.equal(activeResignationFilterCount(defaultResignationFilters), 0);
  assert.equal(
    activeResignationFilterCount({ lineName: "Pedia", status: "approved" }),
    2,
    "both status and line count towards the active filter badge",
  );
  assert.equal(
    activeResignationFilterCount({ lineName: ALL_RESIGNATION_FILTER, status: "approved" }),
    1,
  );

  // ── Export shape ────────────────────────────────────────────────────────────
  const exportRows = buildResignationExportRows(records, candidates, nearCairoMidnight);
  assert.equal(exportRows.length, 5, "the export must carry every visible row of both kinds");
  assert.equal(
    exportRows[0].recordType,
    "Payroll Candidate",
    "payroll candidates lead the export, matching the on-screen queue order",
  );
  assert.equal(
    exportRows[2].status,
    "Approved",
    "the export must show a human-readable status, never the raw enum value",
  );
  assert.equal(
    exportRows[2].effectiveDate,
    "Aug 31, 2026",
    "the export must show a formatted date, not a raw ISO string",
  );

  // ── Actor is a person, never a login code ───────────────────────────────────
  assert.equal(
    resignationActorLabel(makeRecord({ id: "actor" })),
    "Youmna Mohamed Salaheldeen Ahmed Kotb",
    "the audit trail must name the actor, not print their raw login id",
  );
  assert.equal(
    resignationActorLabel(makeRecord({ createdByName: null, id: "actor-unknown" })),
    "a-16",
    "when the directory cannot name the actor, fall back to the stored id rather than showing nothing",
  );
  assert.equal(
    resignationActorLabel(makeRecord({ createdBy: null, createdByName: null, id: "actor-none" })),
    "-",
  );
  assert.equal(
    exportRows[2].createdBy,
    "Youmna Mohamed Salaheldeen Ahmed Kotb",
    "the XLSX Created By column must carry the human name too",
  );

  // ── Candidate handle ────────────────────────────────────────────────────────
  assert.equal(
    formatPayrollCandidateSystemId("4f69c943-1111-2222-3333-444444444444"),
    "PRC-4F69C943",
  );
  assert.equal(formatPayrollCandidateSystemId("---"), "PRC-PENDING");

  runResignationsUiContractAssertions();
}

/**
 * Locks in the decisions the 2026-08-10 rebuild made, each of which replaced something the audit
 * found on the live page. These are cheap source-text guards over the whole UI module — the same
 * idiom the other resignation tests use for surfaces the Node harness cannot render.
 */
function runResignationsUiContractAssertions() {
  const dir = "src/components/resignations";
  const ui = readdirSync(dir)
    .map((file) => readFileSync(`${dir}/${file}`, "utf8"))
    .join("\n");

  assert.doesNotMatch(
    ui,
    /window\.prompt/,
    "rejection reasons must be captured in the admin-shell dialog, never a native window.prompt()",
  );
  assert.match(
    ui,
    /useDialogA11y/,
    "the rejection dialog must use the shared focus-trap/ESC hook rather than a bespoke modal",
  );
  assert.match(
    ui,
    /adminPanelClassName/,
    "the page frame must use the shared admin panel token, not a one-off surface",
  );
  assert.doesNotMatch(
    ui,
    /radial-gradient/,
    "the bespoke orange gradient page shell must not come back — no other admin page has one",
  );
  assert.match(
    ui,
    /ExportXlsxButton/,
    "export must go through the shared styled-XLSX button",
  );
  assert.doesNotMatch(
    ui,
    /text\/csv/,
    "the hand-rolled CSV blob download must not come back",
  );
  assert.match(
    ui,
    /useSortableTable/,
    "the queue must sort via the shared hook (click-to-sort headers), not a bespoke sort dropdown",
  );
  assert.match(
    ui,
    /Terminated Employees/,
    "terminated exits must stay visible on the resignations page — no separate termination system",
  );
  assert.match(
    ui,
    /isTerminatedResignation/,
    "terminated rows must be highlighted inside the shared queue (owner decision), not split out",
  );
  assert.doesNotMatch(
    ui,
    /TerminatedEmployeesPanel/,
    "the separate Terminated Employees table must not come back",
  );
  assert.match(
    ui,
    /action: "complete"/,
    "the bulk close must reuse the existing per-record workflow endpoint, not a new bulk route",
  );
  assert.doesNotMatch(
    ui,
    /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/,
    "the create form's default date must resolve via Africa/Cairo, never a naive UTC slice",
  );
}
