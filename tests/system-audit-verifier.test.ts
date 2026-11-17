import assert from "node:assert/strict";

import { createVerifierDetector } from "../src/lib/system-audit/detectors/verifier.ts";
import { createFileSink } from "../src/lib/system-audit/sinks/file-sink.ts";
import type { FindingSink } from "../src/lib/system-audit/types.ts";
import {
  MIN_CLEAN_NIGHTS,
  MIN_PAGE_VIEWS,
  VERIFIER_ACTOR,
  createDatabaseVerifierStore,
  isOlderBuild,
  judgeRecurrence,
  quietLongEnough,
  runVerifier,
  type FixUnderReview,
  type RecurrenceCandidate,
  type ReleaseGate,
  type VerifierStore,
} from "../src/lib/system-audit/verifier.ts";

/**
 * The verifier: the only thing that may say FIXED — VERIFIED, and the thing that takes it back.
 * A recurrence after the fix went live reopens the issue — even one already verified. A row from a
 * build OLDER than the fix is set aside; a row nobody can place counts. Seven quiet days are not
 * enough on their own: the page has to have been opened again, or the check has to have held.
 * And if the release table cannot be read, nothing is decided at all.
 */

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-23T02:00:00.000Z");
const FIX_LIVE = new Date(NOW - 8 * DAY).toISOString();
const GATES: ReleaseGate[] = [
  { sha: "aaaaaaa1111111111111111111111111111111aa", recordedAt: new Date(NOW - 10 * DAY).toISOString() },
  { sha: "bbbbbbb2222222222222222222222222222222bb", recordedAt: FIX_LIVE },
];

function fix(overrides: Partial<FixUnderReview> = {}): FixUnderReview {
  return {
    issueId: "issue-1",
    signatureKey: "app:v1:abc",
    family: "app_error",
    status: "fix_implemented",
    title: "Read of 'items' on a missing value",
    fixId: "fix-1",
    fixSha: "b".repeat(40),
    fixLiveAt: FIX_LIVE,
    ...overrides,
  };
}

function candidate(overrides: Partial<RecurrenceCandidate> = {}): RecurrenceCandidate {
  const at = new Date(NOW - DAY).toISOString();
  return { id: "occ-1", occurredAt: at, lastEventAt: at, release: null, ...overrides };
}

type Calls = {
  transitions: Array<Parameters<VerifierStore["transition"]>[0]>;
  preFix: string[];
  candidatesFor: string[];
  cleanNights: Array<{ detector: string; checkId: string | null }>;
  gatesRead: number;
};

function store(input: {
  fixes: FixUnderReview[];
  candidates?: Record<string, RecurrenceCandidate[] | Error>;
  gates?: ReleaseGate[] | null | Error;
  routes?: string[];
  people?: string[];
  views?: number;
  nights?: string[] | Error;
}): { store: VerifierStore; calls: Calls } {
  const calls: Calls = { transitions: [], preFix: [], candidatesFor: [], cleanNights: [], gatesRead: 0 };
  return {
    calls,
    store: {
      openFixes: async () => input.fixes,
      recurrenceCandidates: async (under) => {
        calls.candidatesFor.push(under.issueId);
        const found = input.candidates?.[under.issueId] ?? [];
        if (found instanceof Error) throw found;
        return found;
      },
      releaseGates: async () => {
        calls.gatesRead += 1;
        if (input.gates instanceof Error) throw input.gates;
        return input.gates === undefined ? GATES : input.gates;
      },
      markPreFixBuild: async (ids) => {
        calls.preFix.push(...ids);
      },
      affectedPeople: async () => input.people ?? ["b-77"],
      pageRoutes: async () => input.routes ?? ["/employee-portals/field-crm"],
      pageViews: async ({ atLeast }) => Math.min(atLeast, input.views ?? 0),
      cleanNights: async ({ detector, checkId }) => {
        calls.cleanNights.push({ detector, checkId });
        if (input.nights instanceof Error) throw input.nights;
        return input.nights ?? [];
      },
      transition: async (change) => {
        calls.transitions.push(change);
        return {};
      },
    },
  };
}

const IDS = {
  reconciliation: "reconciliation",
  data_linkage: "data_linkage",
  sync_run: "sync_runs",
  app_error: "app_error_fold",
  user_screen: "user_screens",
} as const;
/** Three clean nights of whichever detector is asked: enough to count. */
const CLEAN = ["2026-10-20", "2026-10-21", "2026-10-22"];

function testPureRules() {
  assert.equal(isOlderBuild("aaaaaaa", FIX_LIVE, GATES), true, "A build released before the fix is older");
  assert.equal(isOlderBuild("bbbbbbb", FIX_LIVE, GATES), false, "The fix's own build is not older");
  assert.equal(isOlderBuild("ccccccc", FIX_LIVE, GATES), null, "A release the gate table does not hold cannot be placed");
  assert.equal(isOlderBuild(null, FIX_LIVE, GATES), null);
  assert.equal(isOlderBuild("aaaaaaa", FIX_LIVE, null), null, "With no gate table nothing can be placed");
  assert.equal(isOlderBuild("not-a-sha", FIX_LIVE, GATES), null);

  const older = candidate({ id: "old", release: "aaaaaaa" });
  const unplaced = candidate({ id: "unplaced", release: null });
  const judged = judgeRecurrence([older, unplaced], { fixLiveAt: FIX_LIVE }, GATES);
  assert.deepEqual(judged.olderBuild.map((row) => row.id), ["old"]);
  assert.equal(judged.recurrence?.id, "unplaced", "An unprovable excuse never closes an issue — an unplaced row is a recurrence");

  assert.equal(quietLongEnough(FIX_LIVE, NOW), true);
  assert.equal(quietLongEnough(new Date(NOW - 3 * DAY).toISOString(), NOW), false);
  assert.equal(quietLongEnough("not a time", NOW), false);
}

async function testReopens() {
  const implemented = fix();
  const verified = fix({ issueId: "issue-2", status: "fixed_verified", title: "Visit save failed" });
  const { store: s, calls } = store({
    fixes: [implemented, verified],
    candidates: { "issue-1": [candidate({ id: "occ-a" })], "issue-2": [candidate({ id: "occ-b", release: "bbbbbbb" })] },
  });
  const outcome = await runVerifier({ store: s, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
  assert.deepEqual(
    outcome.reopened.map((row) => [row.issueId, row.wasVerified]),
    [
      ["issue-1", false],
      ["issue-2", true],
    ],
    "A recurrence reopens the issue — and a FIXED — VERIFIED one too, flagged as such",
  );
  assert.ok(calls.transitions.every((change) => change.to === "not_fixed" && change.actor === VERIFIER_ACTOR));
  assert.equal(calls.transitions[0].occurrenceId, "occ-a", "The reopening names the occurrence that proved it");
  assert.equal(outcome.verified.length, 0);
}

async function testVerifiesOnlyWithExposure() {
  const { store: s, calls } = store({
    fixes: [fix()],
    candidates: { "issue-1": [candidate({ id: "old-build", release: "aaaaaaa" })] },
    views: MIN_PAGE_VIEWS,
    nights: CLEAN,
  });
  const outcome = await runVerifier({ store: s, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
  assert.deepEqual(calls.preFix, ["old-build"], "A row from a build older than the fix is set aside, not counted");
  assert.equal(outcome.olderBuildRows, 1);
  assert.equal(outcome.verified.length, 1, "Eight quiet days with the page opened again → FIXED — VERIFIED");
  assert.equal(calls.transitions[0].to, "fixed_verified");
  assert.equal(calls.transitions[0].actor, VERIFIER_ACTOR, "Only the verifier says FIXED — VERIFIED");
  assert.match(String(calls.transitions[0].reason), /page view\(s\) of \/employee-portals\/field-crm by the person it hit/);

  const unseen = store({ fixes: [fix()], views: 1, nights: CLEAN });
  const notYet = await runVerifier({ store: unseen.store, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
  assert.equal(notYet.verified.length, 0, "Quiet is not enough: a page barely opened proves nothing");
  assert.match(notYet.waiting[0].why, /not enough exposure yet: 1 page view/);

  const apiOnly = store({ fixes: [fix()], routes: [], views: 99, nights: CLEAN });
  const noPage = await runVerifier({ store: apiOnly.store, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
  assert.match(noPage.waiting[0].why, /no page address/);

  const tooSoon = store({ fixes: [fix({ fixLiveAt: new Date(NOW - 3 * DAY).toISOString() })], views: 99 });
  const early = await runVerifier({ store: tooSoon.store, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
  assert.match(early.waiting[0].why, /quiet for less than 7 days/);
  assert.equal(tooSoon.calls.transitions.length, 0);
}

async function testDetectorFamilies() {
  const check = fix({ issueId: "recon-1", family: "reconciliation", signatureKey: "recon:payroll-net-matches-rows" });
  const link = fix({ issueId: "link-1", family: "data_linkage", signatureKey: "link:seat_drift" });
  const visit = fix({ issueId: "visit-1", family: "visit_lifecycle", signatureKey: "visit:x" });
  const { store: s, calls } = store({ fixes: [check, link, visit], nights: CLEAN });
  const outcome = await runVerifier({ store: s, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
  assert.deepEqual(calls.candidatesFor, ["recon-1", "link-1", "visit-1"], "Every standing fix is checked for a recurrence");
  assert.deepEqual(
    calls.cleanNights,
    [
      { detector: "reconciliation", checkId: "payroll-net-matches-rows" },
      { detector: "data_linkage", checkId: null },
    ],
    "An integrity check must itself have HELD on its clean nights",
  );
  assert.deepEqual(outcome.verified.map((row) => row.issueId), ["recon-1", "link-1"], `${MIN_CLEAN_NIGHTS} clean nights verify a detector's finding`);
  assert.match(outcome.waiting[0].why, /no detector re-measures this kind of issue/, "A family nobody re-measures is never verified");
}

async function testNothingDecidedOnHalfTheEvidence() {
  const broken = store({ fixes: [fix()], gates: new Error("release_gates: connection reset") });
  await assert.rejects(
    runVerifier({ store: broken.store, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS }),
    /connection reset/,
  );
  assert.equal(broken.calls.transitions.length, 0, "An unreadable release table decides nothing");

  const detector = createVerifierDetector({ detectorIdByFamily: IDS, store: broken.store });
  const sink: FindingSink = { kind: "database", write: async () => ({ issues: 0, inserted: 0, updated: 0 }), readCursor: async () => null };
  const result = await detector.run({ mode: "cron", deadline: NOW + 60_000, sink, runId: "r", now: () => NOW });
  assert.equal(result.status, "errored");
  assert.deepEqual(result.unreadableSources, ["release_gates"], "The run names the input it could not read");
  assert.match(String(result.error), /Nothing was verified or reopened tonight/);

  const empty = store({ fixes: [] });
  await runVerifier({ store: empty.store, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
  assert.equal(empty.calls.gatesRead, 0, "With no standing fix the release table is not even read");

  const oneBad = store({ fixes: [fix(), fix({ issueId: "issue-2" })], candidates: { "issue-1": new Error("timeout") }, views: 99, nights: CLEAN });
  const mixed = await runVerifier({ store: oneBad.store, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
  assert.equal(mixed.unreadable.length, 1, "One issue's failed read is recorded");
  assert.equal(mixed.verified.length, 1, "…and the others are still judged");

  const late = store({ fixes: [fix(), fix({ issueId: "issue-2" })] });
  const outOfTime = await runVerifier({ store: late.store, nowMs: NOW, deadline: NOW, now: () => NOW, detectorIdByFamily: IDS });
  assert.equal(outOfTime.budgetExhausted, true);
  assert.equal(outOfTime.reviewed, 0);

  const untouched = store({ fixes: [fix()] });
  const dry = await createVerifierDetector({ detectorIdByFamily: IDS, store: untouched.store }).run({
    mode: "historical",
    deadline: NOW + 60_000,
    sink: createFileSink(),
    runId: null,
    now: () => NOW,
  });
  assert.equal(dry.status, "skipped", "The verifier never runs against a file — a dry run must not rewrite statuses");
  assert.equal(untouched.calls.gatesRead, 0, "…so it reads nothing either");
}

/**
 * Deep audit, 17 Nov 2026: the ledger's upsert moves `last_event_at` when a row is found again on the
 * same dedupe key, never `occurred_at`. Judged by `occurred_at`, an operation that carried on past the
 * fix, or a finding re-found nightly on one key (a visit day re-judged, a job re-found), never looked
 * like a recurrence — and the issue could be marked FIXED — VERIFIED while it was still happening.
 */
async function testRecurrenceIsTheLastEvent() {
  // The database half: every family asks for rows whose LAST event came after the fix.
  const filters: Array<{ column: string; value: unknown }> = [];
  const orders: string[] = [];
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    gt: (column: string, value: unknown) => {
      filters.push({ column, value });
      return chain;
    },
    order: (column: string) => {
      orders.push(column);
      return chain;
    },
    limit: async () => ({ data: [], error: null }),
  };
  const client = { from: () => chain } as never;
  const db = createDatabaseVerifierStore(client);
  for (const family of ["app_error", "user_screen", "visit_lifecycle", "job_failure", "sync_run", "reconciliation", "data_linkage"] as const) {
    filters.length = 0;
    orders.length = 0;
    await db.recurrenceCandidates(fix({ family }));
    assert.deepEqual(
      filters,
      [{ column: "last_event_at", value: FIX_LIVE }],
      `${family}: a recurrence is an occurrence whose LAST event came after the fix went live, never its first`,
    );
    assert.equal(orders[0], "last_event_at", `${family}: candidates are taken oldest last event first`);
  }

  // The rule half: an operation that began before the fix and went on after it reopens the issue,
  // and the reopening names the moment it was seen AFTER the fix, not the moment it began.
  const began = new Date(Date.parse(FIX_LIVE) - 60_000).toISOString();
  const seenAgain = new Date(Date.parse(FIX_LIVE) + 60_000).toISOString();
  const visit = fix({ issueId: "visit-9", family: "visit_lifecycle", signatureKey: "visit:lost" });
  const { store: s, calls } = store({
    fixes: [visit],
    candidates: { "visit-9": [candidate({ id: "occ-straddle", occurredAt: began, lastEventAt: seenAgain })] },
  });
  const outcome = await runVerifier({ store: s, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
  assert.deepEqual(outcome.reopened.map((row) => row.occurrenceId), ["occ-straddle"]);
  assert.equal(
    (calls.transitions[0].evidence as { recurredAt?: string }).recurredAt,
    seenAgain,
    "The recurrence is dated by its last event — the one after the fix",
  );
}

/**
 * Deep audit, 17 Nov 2026: an error or a screenshot was verified on page views alone. With the error
 * fold failing every night, a recurrence never reaches the ledger, the week reads quiet, and the
 * people opening the page again "prove" a fix that is not there.
 */
async function testPageViewsNeedTheirDetector() {
  for (const [family, detector] of [
    ["app_error", "app_error_fold"],
    ["user_screen", "user_screens"],
  ] as const) {
    const failing = store({ fixes: [fix({ family })], views: 99, nights: ["2026-10-21", "2026-10-22"] });
    const outcome = await runVerifier({ store: failing.store, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
    assert.equal(outcome.verified.length, 0, `${family}: page views with its detector failing verify nothing`);
    assert.equal(failing.calls.transitions.length, 0, `${family}: …and the status is left as it was`);
    assert.deepEqual(failing.calls.cleanNights, [{ detector, checkId: null }], `${family}: the detector asked is the one that would see it — ${detector}`);
    assert.match(outcome.waiting[0].why, /the detector that would see it happen again ran cleanly on 2 night\(s\)/);

    const healthy = store({ fixes: [fix({ family })], views: 99, nights: CLEAN });
    const verified = await runVerifier({ store: healthy.store, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
    assert.equal(verified.verified.length, 1, `${family}: page views plus ${MIN_CLEAN_NIGHTS} clean nights of its detector verify`);
  }

  const unreadable = store({ fixes: [fix()], views: 99, nights: new Error("system_audit_detector_runs: timeout") });
  const outcome = await runVerifier({ store: unreadable.store, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
  assert.equal(unreadable.calls.transitions.length, 0, "A runs table that cannot be read decides nothing");
  assert.equal(outcome.unreadable.length, 1, "…and the run says so");

  const unmapped = store({ fixes: [fix()], views: 99, nights: CLEAN });
  const noDetector = await runVerifier({ store: unmapped.store, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: { sync_run: "sync_runs" } });
  assert.equal(noDetector.verified.length, 0, "An error family with no detector to watch it is never verified");
}

export async function runSystemAuditVerifierTests() {
  testPureRules();
  await testReopens();
  await testVerifiesOnlyWithExposure();
  await testDetectorFamilies();
  await testNothingDecidedOnHalfTheEvidence();
  await testRecurrenceIsTheLastEvent();
  await testPageViewsNeedTheirDetector();
}
