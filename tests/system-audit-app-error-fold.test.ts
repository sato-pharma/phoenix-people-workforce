import assert from "node:assert/strict";

import type { OpenOccurrence } from "../src/lib/system-audit/collapse.ts";
import {
  APP_ERROR_FOLD_DETECTOR_ID,
  appErrorIssueTitle,
  createAppErrorFoldDetector,
  createArrayAppErrorSource,
  type AppErrorSource,
} from "../src/lib/system-audit/detectors/app-error-fold.ts";
import { createStaticPersonDirectory, type PersonDirectory } from "../src/lib/system-audit/person-directory.ts";
import type { AppErrorEventRow } from "../src/lib/system-audit/signature.ts";
import { createFileSink, type FileSink, type FileSinkEntry } from "../src/lib/system-audit/sinks/file-sink.ts";
import type { DetectorContext, FindingBatch, FindingSink } from "../src/lib/system-audit/types.ts";

/**
 * The app_error_fold detector end to end, against the in-memory ledger: which rows leave and are
 * counted, which stay, how retries fold, who each row is attributed to, what module it names — and
 * that a second run over the same events changes nothing.
 */

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const T0 = Date.parse("2026-10-20T08:00:00.000Z");

let sequence = 0;
function uuid(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function clientStack(sinceNavMs: number, body = "Error: x"): string {
  return `— Client context —\nsinceNavMs=${sinceNavMs} seq=1 readyState=complete navType=navigate\n\n${body}`;
}

function row(offsetMs: number, overrides: Partial<AppErrorEventRow> = {}): AppErrorEventRow {
  return {
    id: uuid(),
    created_at: at(offsetMs),
    source: "client",
    hr_id: "B-10",
    login_id: "B-10",
    role: "Super Admin",
    route: "/employee-portals/field-crm",
    route_type: "page",
    message: "TypeError: Cannot read properties of undefined (reading 'items')",
    stack: null,
    release: "abc123",
    environment: "production",
    user_agent: "Mozilla/5.0 (Windows NT 10.0)",
    ...overrides,
  };
}

const PEOPLE = createStaticPersonDirectory({
  "B-10": { hrIdDisplay: "B-10", name: "Omar Gawish", role: "Super Admin" },
  "A-1": { hrIdDisplay: "A-1", name: "Mona Adel", role: "Medical Rep" },
  "login-only": { hrIdDisplay: "C-3", name: "Karim Salah", role: "Medical Rep" },
});

/** The file sink, but serving its last cursor back — the database's watermark, in memory. */
function cursorSink(): FileSink & { batches: FindingBatch[] } {
  const inner = createFileSink();
  const batches: FindingBatch[] = [];
  return {
    ...inner,
    batches,
    async write(detector, runId, batch) {
      batches.push(batch);
      return inner.write(detector, runId, batch);
    },
    async readCursor(detector) {
      return inner.lastCursor(detector);
    },
  };
}

/** Open occurrences read back from the in-memory ledger, the way the database source reads them. */
function ledgerSource(rows: readonly AppErrorEventRow[], sink: FileSink, extra: Partial<AppErrorSource> = {}): AppErrorSource {
  const base = createArrayAppErrorSource(rows);
  return {
    kind: "array",
    readPage: base.readPage,
    async readOpenOccurrences(sinceIso): Promise<OpenOccurrence[]> {
      return sink
        .entries()
        .filter(({ occurrence }) => Date.parse(occurrence.lastEventAt) >= Date.parse(sinceIso))
        .map(({ occurrence }) => ({
          dedupeKey: occurrence.dedupeKey,
          signatureKey: occurrence.signatureKey,
          actorKey: String(occurrence.evidence.actor),
          routeFamily: typeof occurrence.evidence.routeFamily === "string" ? occurrence.evidence.routeFamily : null,
          occurredAt: occurrence.occurredAt,
          firstEventAt: occurrence.firstEventAt,
          lastEventAt: occurrence.lastEventAt,
          lastPageLoadAt: typeof occurrence.evidence.lastPageLoadAt === "string" ? occurrence.evidence.lastPageLoadAt : null,
        }));
    },
    ...extra,
  };
}

function context(sink: FindingSink, overrides: Partial<DetectorContext> = {}): DetectorContext {
  return { mode: "manual", deadline: NOW + 60_000, sink, runId: null, now: () => NOW, ...overrides };
}

function byRef(sink: FileSink, id: string): FileSinkEntry {
  const entry = sink.entries().find(({ occurrence }) => occurrence.sourceRefs.includes(id));
  assert.ok(entry, `an occurrence must hold event ${id}`);
  return entry;
}

export async function runSystemAuditAppErrorFoldTests() {
  // ── The day's rows ─────────────────────────────────────────────────────────────────────────────
  const burst: AppErrorEventRow[] = [];
  for (let index = 0; index < 24; index += 1) {
    burst.push(
      row(index * 250, {
        message: `Minified React error #418; visit https://react.dev/errors/418?args[]=${index % 2 ? "div" : "p"} for the full message`,
        stack: clientStack(5_000 + index * 250),
      }),
    );
  }
  const maskedNoFrame = row(60_000, { message: "Script error.", stack: null });
  const maskedWithFrame = row(61_000, {
    message: "Script error.",
    stack: "Error: x\n    at Ab (https://phoenix-hr.satopharma.com/_next/static/chunks/app/page-1a2b.js:1:200)",
  });
  const connectionClosed = row(62_000, {
    source: "server",
    hr_id: "A-1",
    login_id: "A-1",
    role: "Medical Rep",
    route: "/employee-portals/visit-report",
    message: "Connection closed.",
  });
  const development = row(63_000, { environment: "development", message: "dev only" });
  const nullEnvironment = row(64_000, { environment: null, message: "Error: written before the environment was stamped" });
  const testAccount = row(65_000, { login_id: "TEST-B-10", hr_id: "B-10", message: "Error: a test persona failure" });
  const healthCheck = row(66_000, { login_id: "admin-HR", hr_id: null, message: "Error: the health check failed" });
  const lateFirst = row(70_000, { hr_id: "A-1", login_id: "A-1", role: "Medical Rep", message: "Error: save failed" });
  const lateSecond = row(70_000 + 11 * 60 * 1000, { hr_id: "A-1", login_id: "A-1", role: "Medical Rep", message: "Error: save failed" });
  const sharedB = row(80_000, { message: "Error: shared failure" });
  const sharedA = row(81_000, { hr_id: "A-1", login_id: "A-1", role: "Medical Rep", message: "Error: shared failure" });
  const thirdParty = row(90_000, {
    message: "TypeError: a is undefined",
    stack: "TypeError: a is undefined\n    at Ab (https://maps.googleapis.com/maps-api-v3/api/js/58/1/main.js:120:33)",
  });
  const guest = row(95_000, { hr_id: null, login_id: null, role: null, route: "/login", user_agent: "Guest Browser 1", message: "Error: guest failure" });
  const loginOnly = row(96_000, { hr_id: null, login_id: "login-only", role: null, message: "Error: login only failure" });
  const apiError = row(97_000, {
    source: "server",
    hr_id: "A-1",
    login_id: "A-1",
    role: "Medical Rep",
    route: "/api/approvals/vacation/123",
    route_type: "route",
    message: "Error: approval write failed",
  });
  const unsettled = { ...row(0, { message: "Error: still happening" }), created_at: new Date(NOW - 60_000).toISOString() };

  const rows = [
    ...burst,
    maskedNoFrame,
    maskedWithFrame,
    connectionClosed,
    development,
    nullEnvironment,
    testAccount,
    healthCheck,
    lateFirst,
    lateSecond,
    sharedB,
    sharedA,
    thirdParty,
    guest,
    loginOnly,
    apiError,
    unsettled,
  ];

  // ── First run ──────────────────────────────────────────────────────────────────────────────────
  const sink = cursorSink();
  const trailSource = ledgerSource(rows, sink, {
    async recentPageViews(requests) {
      const views = new Map<string, string>();
      for (const request of requests) if (request.eventId === apiError.id) views.set(request.eventId, "/employee-portals/approvals/vacation");
      return views;
    },
  });
  const detector = createAppErrorFoldDetector({ source: trailSource, people: PEOPLE });
  assert.equal(detector.id, APP_ERROR_FOLD_DETECTOR_ID);
  const first = await detector.run(context(sink));

  assert.equal(first.status, "ok", `the first run must succeed (${first.error ?? ""})`);
  assert.equal(first.scanned, rows.length - 1, "a row younger than ten minutes is left to settle");
  assert.deepEqual(first.excludedCounts, { masked_script_error: 1, development: 1 }, "every excluded row is counted by its class");
  assert.equal(first.report?.testAccountRows, 2, "test rows are kept, flagged — not counted as excluded");

  // 24 errors in one page load: ONE occurrence, one page load, named by the person's sidebar.
  const hydration = byRef(sink, burst[0].id);
  assert.equal(hydration.occurrence.attemptCount, 24, "24 hydration errors in one page load must be ONE occurrence of 24 attempts");
  assert.equal(hydration.occurrence.pageLoads, 1);
  assert.equal(hydration.occurrence.hrIdDisplay, "B-10");
  assert.equal(hydration.occurrence.employeeName, "Omar Gawish");
  assert.equal(hydration.occurrence.moduleLabel, "Phoenix CRM");
  assert.equal(hydration.occurrence.moduleLabelSource, "nav_exact");
  assert.equal(hydration.occurrence.shell, "portal");
  assert.equal(hydration.occurrence.userMessage ?? null, null, "the words on the screen were not captured, and are never invented");
  assert.equal(hydration.occurrence.errorCode, hydration.issue.errorCode);
  assert.match(hydration.issue.errorCode, /^APP-[0-9A-F]{8}$/);
  assert.equal(hydration.issue.title.includes("…"), false, "a title never carries an ellipsis");
  assert.equal(hydration.occurrence.evidence.actor, "hr:b-10");

  // Masked without a frame is excluded; with one of ours it stays.
  assert.equal(sink.entries().some(({ occurrence }) => occurrence.sourceRefs.includes(maskedNoFrame.id)), false);
  byRef(sink, maskedWithFrame.id);
  // "Connection closed." is a finding; a NULL environment is a production row.
  assert.equal(byRef(sink, connectionClosed.id).occurrence.moduleLabel, "Visit report");
  byRef(sink, nullEnvironment.id);
  assert.equal(sink.entries().some(({ occurrence }) => occurrence.sourceRefs.includes(development.id)), false);

  // Test accounts: kept, flagged, on the TEST login — never on the mirrored person's line.
  const test = byRef(sink, testAccount.id).occurrence;
  assert.equal(test.isTest, true);
  assert.equal(test.hrKey, "test-b-10", "a test row must never be attributed to the real person it mirrors");
  assert.equal(test.employeeName, "Test account — mirrors Omar Gawish");
  assert.equal(byRef(sink, healthCheck.id).occurrence.employeeName, "Health-check service account");

  // 11 minutes apart: two operations. Two people: two occurrences, SHARED.
  assert.notEqual(byRef(sink, lateFirst.id).occurrence.dedupeKey, byRef(sink, lateSecond.id).occurrence.dedupeKey, "11 minutes apart is two operations");
  assert.notEqual(byRef(sink, sharedA.id).occurrence.dedupeKey, byRef(sink, sharedB.id).occurrence.dedupeKey, "two people are never one occurrence");
  assert.equal(byRef(sink, sharedA.id).issue.signatureKey, byRef(sink, sharedB.id).issue.signatureKey);

  // A third-party script: PROBABLE, with the host named.
  const outside = byRef(sink, thirdParty.id).issue;
  assert.equal(outside.rootCauseLevel, "probable");
  assert.equal(outside.rootCause, "third-party script (maps.googleapis.com)");

  // A guest has no person; a login with no HR id is named by the directory.
  const guestRow = byRef(sink, guest.id).occurrence;
  assert.equal(guestRow.hrKey ?? null, null);
  assert.equal(guestRow.employeeName ?? null, null);
  const loginRow = byRef(sink, loginOnly.id).occurrence;
  assert.equal(loginRow.hrIdDisplay, "C-3");
  assert.equal(loginRow.employeeName, "Karim Salah");
  assert.equal(loginRow.evidence.actor, "login:login-only");

  // An API error is named by the page the person last opened.
  const api = byRef(sink, apiError.id).occurrence;
  assert.equal(api.moduleLabel, "Leave Approvals");
  assert.equal(api.moduleLabelSource, "page_trail");

  assert.deepEqual(first.watermarkTo, { createdAt: lateSecond.created_at, id: lateSecond.id }, "the watermark is the last settled row read");
  const csvBefore = sink.toMasterCsv(undefined, { includeTest: true });

  // ── Second run over the same events: nothing is counted twice ──────────────────────────────────
  const second = await detector.run(context(sink));
  assert.equal(second.status, "ok");
  assert.equal(second.scanned, 0, "a second run must read nothing it already folded");
  assert.equal(sink.toMasterCsv(undefined, { includeTest: true }), csvBefore, "a second run must not change a single count");

  // ── New events extend what the ledger holds, by their own counts only ──────────────────────────
  // After the watermark, and long after the burst — but in the SAME page load (the tab stayed open).
  const later = row(800_000, {
    message: "Minified React error #418; visit https://react.dev/errors/418?args[]=span for the full message",
    stack: clientStack(5_000 + 800_000),
  });
  const extendingSource = ledgerSource([...rows, later], sink);
  const third = await createAppErrorFoldDetector({ source: extendingSource, people: PEOPLE }).run(context(sink));
  assert.equal(third.status, "ok");
  assert.equal(third.scanned, 1, "only the new event is read");
  const extended = byRef(sink, later.id);
  assert.equal(extended.occurrence.dedupeKey, hydration.occurrence.dedupeKey, "a retry in the same page load extends the ledger's occurrence");
  assert.equal(extended.occurrence.attemptCount, 25);
  assert.equal(extended.occurrence.pageLoads, 1, "the same page load must not add a page load");

  // ── A burst across the write boundary stays one operation; no write exceeds 500 rows ───────────
  const wide: AppErrorEventRow[] = [];
  for (let index = 0; index < 600; index += 1) wide.push(row(index * 100, { message: "Error: one long burst", stack: clientStack(1_000 + index * 100) }));
  for (let index = 0; index < 1_100; index += 1) {
    wide.push(row(200_000 + index, { hr_id: null, login_id: null, role: null, user_agent: `Browser ${index}`, message: "Error: many guests" }));
  }
  const wideSink = cursorSink();
  const wideRun = await createAppErrorFoldDetector({ source: ledgerSource(wide, wideSink), people: PEOPLE }).run(context(wideSink));
  assert.equal(wideRun.status, "ok");
  assert.equal(wideRun.scanned, 1_700);
  const longBurst = byRef(wideSink, wide[0].id);
  assert.equal(longBurst.occurrence.attemptCount, 600, "the write boundary must not split one operation");
  assert.equal(longBurst.occurrence.pageLoads, 1);
  assert.equal(
    wideSink.entries().filter(({ occurrence }) => occurrence.signatureKey === longBurst.occurrence.signatureKey).length,
    1,
    "600 events of one page load across two writes are still ONE occurrence",
  );
  assert.ok(wideSink.batches.length >= 4, `1,700 rows must be written in several batches (wrote ${wideSink.batches.length})`);
  for (const batch of wideSink.batches) {
    assert.ok(batch.occurrences.length <= 500, `a write must stay inside one repository chunk (had ${batch.occurrences.length})`);
    assert.ok(batch.cursor, "every write carries its watermark");
    assert.equal(batch.merge, "add");
  }
  assert.equal(wideSink.entries().length, 1 + 1_100);

  // ── The budget: stop before starting work, move nothing ────────────────────────────────────────
  const budgetSink = cursorSink();
  const budget = await createAppErrorFoldDetector({ source: ledgerSource(rows, budgetSink), people: PEOPLE }).run(context(budgetSink, { deadline: NOW }));
  assert.equal(budget.status, "budget_exhausted");
  assert.equal(budget.scanned, 0);
  assert.equal(budgetSink.entries().length, 0);

  // ── A failed person read stops the run; nothing is written, the watermark does not move ────────
  const failingPeople: PersonDirectory = {
    async lookup() {
      throw new Error("System audit person lookup failed on employees: timeout");
    },
  };
  const failSink = cursorSink();
  const failed = await createAppErrorFoldDetector({ source: ledgerSource(rows, failSink), people: failingPeople }).run(context(failSink));
  assert.equal(failed.status, "errored");
  assert.deepEqual(failed.unreadableSources, ["employees / app_auth_users"], "the run names the source it could not read");
  assert.equal(failSink.entries().length, 0, "a column of blank names must never be written");
  assert.equal(failSink.lastCursor(APP_ERROR_FOLD_DETECTOR_ID), null);

  // ── A page trail that cannot be read: the API map names it, and the run says so ────────────────
  const trailSink = cursorSink();
  const noTrail = await createAppErrorFoldDetector({
    source: ledgerSource([apiError], trailSink, {
      async recentPageViews() {
        throw new Error("activity_events read failed");
      },
    }),
    people: PEOPLE,
  }).run(context(trailSink));
  assert.equal(noTrail.status, "partial");
  assert.deepEqual(noTrail.unreadableSources, ["activity_events"]);
  const mapped = byRef(trailSink, apiError.id).occurrence;
  assert.equal(mapped.moduleLabel, "Leave Approvals");
  assert.equal(mapped.moduleLabelSource, "api_map");

  // ── Titles ─────────────────────────────────────────────────────────────────────────────────────
  assert.equal(
    appErrorIssueTitle({ source: "client", message: "null-access:items", where: "component:VisitForm", routeFamily: null }),
    "Read of 'items' on a missing value (in VisitForm)",
  );
  assert.equal(
    appErrorIssueTitle({ source: "server", message: "Connection closed.", where: "route:/employee-portals/visit-report", routeFamily: "/employee-portals/visit-report" }),
    "Server: Connection closed. (on /employee-portals/visit-report)",
  );
}
