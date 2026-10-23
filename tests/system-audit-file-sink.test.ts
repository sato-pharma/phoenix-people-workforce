import assert from "node:assert/strict";

import { MASTER_CSV_HEADERS, cairoDateAndTime, createFileSink } from "../src/lib/system-audit/sinks/file-sink.ts";
import {
  USER_MESSAGE_NOT_CAPTURED,
  type AuditIssueInput,
  type AuditOccurrenceInput,
} from "../src/lib/system-audit/types.ts";

/**
 * The ledger in memory — what the historical runner writes its master CSV from. It must merge the
 * way `system_audit_upsert_occurrences` does, or the file and the screen would disagree about the
 * same events.
 */

const SIG = "app:v1:aaaaaaaaaaaaaaaa";

function issue(overrides: Partial<AuditIssueInput> = {}): AuditIssueInput {
  return {
    signatureKey: SIG,
    family: "app_error",
    errorCode: "APP-AAAAAAAA",
    title: "Read of 'items' on a missing value",
    firstSeenAt: "2026-10-20T08:00:00.000Z",
    lastSeenAt: "2026-10-20T08:00:00.000Z",
    ...overrides,
  };
}

function occurrence(overrides: Partial<AuditOccurrenceInput> = {}): AuditOccurrenceInput {
  return {
    dedupeKey: `${SIG}:hr:b-10:e1`,
    signatureKey: SIG,
    hrKey: "b-10",
    hrIdDisplay: "B-10",
    employeeName: "Omar Gawish",
    moduleLabel: "Phoenix CRM",
    moduleLabelSource: "nav_exact",
    route: "/employee-portals/field-crm",
    occurredAt: "2026-10-20T08:00:00.000Z",
    occurredAtKind: "failure",
    isSilent: false,
    errorCode: "APP-AAAAAAAA",
    attemptCount: 3,
    pageLoads: 1,
    firstEventAt: "2026-10-20T08:00:00.000Z",
    lastEventAt: "2026-10-20T08:02:00.000Z",
    sourceRefs: ["e1", "e2", "e3"],
    ...overrides,
  };
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

export async function runSystemAuditFileSinkTests() {
  // ── Insert, then an `add` extension sums the new counts ────────────────────────────────────────
  const sink = createFileSink();
  const first = await sink.write("app_error_fold", null, { issues: [issue()], occurrences: [occurrence()], merge: "add", cursor: { id: "e3" } });
  assert.deepEqual(first, { issues: 1, inserted: 1, updated: 0 });
  assert.equal(await sink.readCursor("app_error_fold"), null, "a file run always starts from its own beginning");
  assert.deepEqual(sink.lastCursor("app_error_fold"), { id: "e3" });

  const extension = await sink.write("app_error_fold", null, {
    issues: [issue({ lastSeenAt: "2026-10-20T08:05:00.000Z", rootCauseLevel: "probable", rootCause: "third-party script (x)" })],
    occurrences: [
      occurrence({
        attemptCount: 2,
        pageLoads: 0,
        firstEventAt: "2026-10-20T08:04:00.000Z",
        lastEventAt: "2026-10-20T08:05:00.000Z",
        sourceRefs: ["e4", "e5"],
        technicalMessage: "newer",
      }),
    ],
    merge: "add",
    cursor: { id: "e5" },
  });
  assert.deepEqual(extension, { issues: 1, inserted: 0, updated: 1 });
  const merged = sink.entries()[0].occurrence;
  assert.equal(merged.attemptCount, 5, "an add extension sums its attempts into the occurrence");
  assert.equal(merged.pageLoads, 1, "an extension with 0 new page loads must add 0 — never clamp it to 1");
  assert.equal(merged.firstEventAt, "2026-10-20T08:00:00.000Z");
  assert.equal(merged.lastEventAt, "2026-10-20T08:05:00.000Z");
  assert.deepEqual(merged.sourceRefs, ["e1", "e2", "e3", "e4", "e5"]);
  assert.equal(merged.technicalMessage, "newer");

  // The issue widens its window, and a root cause appears once where there was none.
  const storedIssue = sink.issues()[0];
  assert.equal(storedIssue.lastSeenAt, "2026-10-20T08:05:00.000Z");
  assert.equal(storedIssue.rootCauseLevel, "probable");
  assert.equal(storedIssue.status, "investigating");
  await sink.write("app_error_fold", null, { issues: [issue({ rootCauseLevel: "confirmed", rootCause: "other" })], occurrences: [], merge: "add" });
  assert.equal(sink.issues()[0].rootCause, "third-party script (x)", "a root cause once established is never overwritten by a detector");

  // ── `max` keeps the larger counters, never doubles ─────────────────────────────────────────────
  const state = createFileSink();
  await state.write("visit", null, { issues: [issue()], occurrences: [occurrence({ attemptCount: 4 })], merge: "max" });
  await state.write("visit", null, { issues: [issue()], occurrences: [occurrence({ attemptCount: 2 })], merge: "max" });
  assert.equal(state.entries()[0].occurrence.attemptCount, 4, "a state finding seen again keeps the larger count");

  // ── What Postgres refuses, the sink refuses ────────────────────────────────────────────────────
  await assert.rejects(
    () => sink.write("app_error_fold", null, { issues: [issue()], occurrences: [occurrence(), occurrence()], merge: "add" }),
    /appears twice in one batch/,
    "a batch repeating a dedupe key must fail as the SQL upsert would",
  );
  const orphan = createFileSink();
  const orphanResult = await orphan.write("x", null, { issues: [], occurrences: [occurrence()], merge: "add" });
  assert.equal(orphanResult.inserted, 0, "an occurrence whose signature has no issue is not written (the SQL joins on it)");
  assert.equal(orphan.entries().length, 0);

  // ── The master CSV: the owner's eleven columns, in his order ───────────────────────────────────
  assert.deepEqual(MASTER_CSV_HEADERS.slice(0, 11), [
    "HR ID",
    "Employee Name",
    "Module Name",
    "Error Date",
    "Error Time",
    "Error Encountered",
    "Error Code / Incident Ref",
    "Why",
    "Fixed status",
    "Occurrences for this employee",
    "Unique vs Shared",
  ]);
  await sink.write("app_error_fold", null, {
    issues: [],
    occurrences: [
      occurrence({ dedupeKey: `${SIG}:hr:a-1:e9`, hrKey: "a-1", hrIdDisplay: "A-1", employeeName: "Another Person", occurredAt: "2026-10-20T21:30:00.000Z", sourceRefs: ["e9"] }),
      occurrence({ dedupeKey: `${SIG}:test:test-b-10:e10`, hrKey: "test-b-10", isTest: true, sourceRefs: ["e10"] }),
      occurrence({ dedupeKey: `${SIG}:guest:abc:e11`, hrKey: null, hrIdDisplay: null, employeeName: null, sourceRefs: ["e11"] }),
    ],
    merge: "add",
  });
  const csv = sink.toMasterCsv();
  assert.equal(csv.charCodeAt(0), 0xfeff, "the CSV opens with a BOM so Excel reads Arabic names");
  const lines = sink.toMasterCsvLines();
  assert.equal(lines.length, 1 + 3, "test rows are left out of the CSV unless asked for");
  assert.equal(sink.toMasterCsvLines(undefined, { includeTest: true }).length, 1 + 4);

  const rows = lines.slice(1).map(parseCsvLine);
  // Newest first: A-1 at 21:30 UTC is 00:30 on 21 Oct in Cairo.
  assert.equal(rows[0][0], "A-1");
  assert.equal(rows[0][3], "2026-10-21", "the date column is the CAIRO date");
  assert.equal(rows[0][4], "00:30:00");
  assert.equal(rows[0][5], USER_MESSAGE_NOT_CAPTURED, "column 6 never invents the words a person was shown");
  assert.equal(rows[0][6], "APP-AAAAAAAA / e9");
  assert.equal(rows[0][7], "PROBABLE — third-party script (x)");
  assert.equal(rows[0][8], "INVESTIGATING");
  assert.equal(rows[0][10], "SHARED — 2 EMPLOYEES AFFECTED");
  const system = rows.find((row) => row[0] === "");
  assert.ok(system, "the guest row is in the file");
  assert.equal(system[10], "SYSTEM — NO EMPLOYEE ATTRIBUTION", "a row with no person is a system row, never an employee");

  assert.deepEqual(cairoDateAndTime("2026-10-20T08:00:00.000Z"), { date: "2026-10-20", time: "11:00:00" });
}
