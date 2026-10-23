import assert from "node:assert/strict";

import type { ReconciliationCheckResult, ReconciliationReport } from "../src/lib/reconciliation/types.ts";
import { createReconciliationDetector } from "../src/lib/system-audit/detectors/reconciliation-ledger.ts";
import {
  REPORT_BYTE_CAP,
  buildReconciliationFindings,
  capStoredReport,
  createMemoryRunStore,
  nextEpisode,
  reconciliationCheckRoute,
  recordReconciliationRun,
} from "../src/lib/system-audit/reconciliation-ledger.ts";
import { createFileSink } from "../src/lib/system-audit/sinks/file-sink.ts";
import { SILENT_DATA_MESSAGE } from "../src/lib/system-audit/types.ts";

/**
 * The nightly integrity report, stored, and every disagreement in it turned into ledger rows.
 * What must hold: a breach becomes rows (one per person, or one per EPISODE when it names nobody),
 * a known-open defect starts NOT FIXED with its own write-up as the probable cause, an errored check
 * is NOT MEASURED and never a pass, and two findings with the same key fold instead of failing the
 * whole night's write.
 */

const LABEL = () => ({ label: "Payroll", shell: "admin" as const });
const PEOPLE = {
  lookup: () =>
    new Map([
      ["b-77", { hrIdDisplay: "B-77", name: "Mona Adel", role: "Medical Rep" }],
      ["b-12", { hrIdDisplay: "B-12", name: "Karim Hassan", role: "District Manager" }],
    ]),
};

function check(overrides: Partial<ReconciliationCheckResult> = {}): ReconciliationCheckResult {
  return {
    id: "payroll-net-matches-rows",
    title: "Payroll net pay matches its rows",
    domain: "payroll",
    severity: "critical",
    expectation: "holds",
    status: "holds",
    holds: true,
    left: { source: "payroll service", value: "EGP 1,000" },
    right: { source: "payroll_rows", value: "EGP 1,000" },
    detail: "Both sides agree.",
    durationMs: 10,
    error: null,
    ...overrides,
  };
}

function report(results: ReconciliationCheckResult[]): ReconciliationReport {
  return {
    generatedAt: "2026-10-23 04:40",
    durationMs: 100,
    counts: {
      total: results.length,
      holding: results.filter((r) => r.status === "holds").length,
      breached: results.filter((r) => r.status === "breached").length,
      knownOpen: results.filter((r) => r.status === "known-open").length,
      errored: results.filter((r) => r.status === "errored").length,
    },
    alerting: results.some((r) => r.status === "breached" || r.status === "errored"),
    results,
  };
}

// 04:40 Cairo on three consecutive nights (Cairo is UTC+3 in October 2026).
const NIGHT_1 = new Date("2026-10-21T01:40:00.000Z");
const NIGHT_2 = new Date("2026-10-22T01:40:00.000Z");
const NIGHT_4 = new Date("2026-10-24T01:40:00.000Z");

const BREACH_NOBODY = check({
  id: "crm-visit-count",
  title: "CRM visit count matches the visit rows",
  domain: "crm-sales",
  severity: "high",
  status: "breached",
  holds: false,
  left: { source: "CRM dashboard", value: "412 visits" },
  right: { source: "crm_visits", value: "409 visits" },
  detail: "The dashboard counts 3 more visits than the rows hold.",
});

async function testBreachWithPeople() {
  const sink = createFileSink();
  const runStore = createMemoryRunStore();
  const breached = check({
    status: "breached",
    holds: false,
    detail: "Two people's net pay disagrees with their rows.",
    findings: [
      { hrId: "B-77", affectedDate: "2026-10-01", relatedTable: "payroll_rows", relatedId: "r1", detail: "Net EGP 900 vs rows EGP 1,000" },
      // The same person, day and record again — a check listing one row per mismatching field.
      { hrId: "b-77", affectedDate: "2026-10-01", relatedTable: "payroll_rows", relatedId: "r1", detail: "Basic EGP 630 vs rows EGP 700" },
      { hrId: "B-12", affectedDate: "2026-10-01", relatedTable: "payroll_rows", relatedId: "r2", detail: "Net EGP 1,500 vs rows EGP 1,400" },
    ],
  });
  const recorded = await recordReconciliationRun(report([breached, check({ id: "payroll-holds", status: "holds" })]), {
    sink,
    runStore,
    people: PEOPLE,
    now: NIGHT_1,
    release: "abc123",
    label: LABEL,
  });

  assert.equal(recorded.status, "ok");
  const issues = sink.issues();
  assert.equal(issues.length, 1, "A holding check writes nothing; only the breach becomes an issue");
  assert.equal(issues[0].signatureKey, "recon:payroll-net-matches-rows");
  assert.equal(issues[0].status, "investigating", "A new breach starts INVESTIGATING");

  const rows = sink.entries().map((entry) => entry.occurrence);
  assert.equal(rows.length, 2, "A repeated person/day/record key folds into one row rather than failing the write");
  const mona = rows.find((row) => row.hrKey === "b-77");
  assert.ok(mona, "The finding for B-77 is written under the canonical key");
  assert.equal(mona.attemptCount, 2, "The folded repeat is counted as an extra attempt, never dropped");
  assert.equal(mona.employeeName, "Mona Adel");
  assert.equal(mona.hrIdDisplay, "B-77");
  assert.equal(mona.affectedDate, "2026-10-01");
  assert.equal(mona.isSilent, true);
  assert.equal(mona.userMessage, SILENT_DATA_MESSAGE);
  assert.equal(mona.moduleLabel, "Payroll");
  assert.equal(mona.occurredAtKind, "detected");

  const stored = runStore.runs()[0];
  assert.equal(stored.startedAt, NIGHT_1.toISOString(), "The run is stored at the night's own time");
  const ledger = (stored.result?.report as { ledger: { checks: Record<string, string> } }).ledger;
  assert.deepEqual(
    ledger.checks,
    { "payroll-net-matches-rows": "breached", "payroll-holds": "holds" },
    "Every check's verdict is stored by id, so the verifier never reads the whole report",
  );
}

async function testKnownOpenAndErrored() {
  const sink = createFileSink();
  const runStore = createMemoryRunStore();
  const knownOpen = check({
    id: "sos-office-share",
    title: "Office share matches the closing",
    domain: "crm-sales",
    expectation: "known-open",
    status: "known-open",
    holds: false,
    detail: "Office share is 2% off.",
    openDefect: "The Office share rounds per line, the closing rounds per area — documented 2026-10-01.",
  });
  const errored = check({ id: "recruitment-offers", domain: "recruitment", status: "errored", holds: null, left: null, right: null, error: "timeout" });
  const recorded = await recordReconciliationRun(report([knownOpen, errored]), { sink, runStore, now: NIGHT_1, release: null, label: LABEL });

  const issue = sink.issues().find((row) => row.signatureKey === "recon:sos-office-share");
  assert.ok(issue);
  assert.equal(issue.status, "not_fixed", "A documented open defect is NOT FIXED from the first night");
  assert.equal(issue.rootCauseLevel, "probable");
  assert.equal(issue.rootCause, knownOpen.openDefect, "Its own write-up is the probable cause");

  assert.equal(recorded.status, "partial", "A night with an errored check is partial, never ok");
  assert.deepEqual(recorded.notMeasured, ["recruitment-offers"]);
  assert.equal(sink.issues().some((row) => row.signatureKey === "recon:recruitment-offers"), false, "An errored check writes no row at all");
  const result = runStore.runs()[0].result;
  assert.deepEqual(result?.unreadableSources, ["reconciliation:recruitment-offers"], "It is listed as NOT MEASURED on the run");
}

async function testEpisodes() {
  const sink = createFileSink();
  const runStore = createMemoryRunStore();
  const options = { sink, runStore, release: null, label: LABEL };

  await recordReconciliationRun(report([BREACH_NOBODY]), { ...options, now: NIGHT_1 });
  await recordReconciliationRun(report([BREACH_NOBODY]), { ...options, now: NIGHT_2 });
  let rows = sink.entries().map((entry) => entry.occurrence);
  assert.equal(rows.length, 1, "The same breach on consecutive nights is ONE episode row");
  assert.equal(rows[0].dedupeKey, "recon:crm-visit-count:2026-10-21");
  assert.equal(rows[0].attemptCount, 2, "The episode row counts the nights it has run");
  assert.equal(rows[0].hrKey ?? null, null, "A breach that names nobody is a system row");
  assert.equal(
    rows[0].technicalMessage,
    "Screen: 412 visits · Second source: 409 visits · The dashboard counts 3 more visits than the rows hold.",
    "The row says what the screen showed and what the second source holds",
  );

  // Night 3 is missing (held, or not measured): night 4 is a NEW episode, never glued to the old one.
  await recordReconciliationRun(report([BREACH_NOBODY]), { ...options, now: NIGHT_4 });
  rows = sink.entries().map((entry) => entry.occurrence);
  assert.deepEqual(
    rows.map((row) => row.dedupeKey).sort(),
    ["recon:crm-visit-count:2026-10-21", "recon:crm-visit-count:2026-10-24"],
    "A gap of a night ends the episode",
  );

  // Pure: a changed detail starts a new episode; a re-run the same night stays on it.
  const first = nextEpisode(null, "2026-10-21", "h1");
  assert.deepEqual(first, { start: "2026-10-21", lastNight: "2026-10-21", nights: 1, hash: "h1" });
  assert.equal(nextEpisode(first, "2026-10-21", "h1"), first, "A re-run the same night is the same episode");
  assert.equal(nextEpisode(first, "2026-10-22", "h1").nights, 2);
  assert.equal(nextEpisode(first, "2026-10-22", "h2").start, "2026-10-22", "A changed detail is a new episode");
}

function testRoutesAndCap() {
  assert.equal(reconciliationCheckRoute({ id: "sos-office-share", domain: "crm-sales" }), "/sales/source-of-sales-tools");
  assert.equal(reconciliationCheckRoute({ id: "crm-visit-count", domain: "crm-sales" }), "/admin/crm");
  assert.equal(reconciliationCheckRoute({ id: "payroll-net", domain: "payroll" }), "/payroll");

  const findings = Array.from({ length: 400 }, (_, index) => ({ hrId: `B-${index}`, detail: "x".repeat(800) }));
  const big = { generatedAt: "now", results: [{ id: "big", status: "breached", findings }] };
  const capped = capStoredReport(big);
  assert.ok(Buffer.byteLength(JSON.stringify(capped), "utf8") <= REPORT_BYTE_CAP, "The stored report always fits the row");
  assert.match(String(capped.capped), /Per-finding detail was dropped/, "It says what it dropped, on the report itself");
  const kept = (capped.results as Array<{ findings: Array<Record<string, unknown>> }>)[0].findings;
  assert.equal(kept.length, 400, "Dropping the detail keeps every finding");
  assert.equal("detail" in kept[0], false);

  const small = { generatedAt: "now", results: [] };
  assert.equal(capStoredReport(small), small, "A report under the cap is stored as it is");

  const built = buildReconciliationFindings({
    report: report([check({ status: "holds" })]),
    runAt: NIGHT_1.toISOString(),
    release: null,
    episodes: {},
    people: new Map(),
    label: LABEL,
  });
  assert.deepEqual(built, { issues: [], occurrences: [] }, "A night where everything holds writes nothing");
}

async function testDetectorOnFileSinkStaysInMemory() {
  const sink = createFileSink();
  const detector = createReconciliationDetector({ runChecks: async () => report([BREACH_NOBODY]) });
  assert.equal(detector.recordsOwnRun, true, "The caller must not open a second run row for it");
  const result = await detector.run({ mode: "historical", deadline: Date.now() + 60_000, sink, runId: null, now: () => NIGHT_1.getTime() });
  assert.equal(result.status, "ok");
  assert.match(String(result.report?.runId), /^memory-/, "On a file sink the run is kept in memory — a dry run writes nothing anywhere");
  assert.equal(sink.entries().length, 1);
}

export async function runSystemAuditReconciliationLedgerTests() {
  await testBreachWithPeople();
  await testKnownOpenAndErrored();
  await testEpisodes();
  testRoutesAndCap();
  await testDetectorOnFileSinkStaysInMemory();
}
