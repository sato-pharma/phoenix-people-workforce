import assert from "node:assert/strict";

import { createVerifierDetector } from "../src/lib/system-audit/detectors/verifier.ts";
import { createFileSink } from "../src/lib/system-audit/sinks/file-sink.ts";
import type { FindingSink } from "../src/lib/system-audit/types.ts";
import {
  MIN_CLEAN_NIGHTS,
  MIN_PAGE_VIEWS,
  VERIFIER_ACTOR,
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
  byLastEvent: boolean[];
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
  nights?: string[];
}): { store: VerifierStore; calls: Calls } {
  const calls: Calls = { transitions: [], preFix: [], byLastEvent: [], cleanNights: [], gatesRead: 0 };
  return {
    calls,
    store: {
      openFixes: async () => input.fixes,
      recurrenceCandidates: async (under, byLastEvent) => {
        calls.byLastEvent.push(byLastEvent);
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
        return input.nights ?? [];
      },
      transition: async (change) => {
        calls.transitions.push(change);
        return {};
      },
    },
  };
}

const IDS = { reconciliation: "reconciliation", data_linkage: "data_linkage", sync_run: "sync_runs" } as const;

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
  });
  const outcome = await runVerifier({ store: s, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
  assert.deepEqual(calls.preFix, ["old-build"], "A row from a build older than the fix is set aside, not counted");
  assert.equal(outcome.olderBuildRows, 1);
  assert.equal(outcome.verified.length, 1, "Eight quiet days with the page opened again → FIXED — VERIFIED");
  assert.equal(calls.transitions[0].to, "fixed_verified");
  assert.equal(calls.transitions[0].actor, VERIFIER_ACTOR, "Only the verifier says FIXED — VERIFIED");
  assert.match(String(calls.transitions[0].reason), /page view\(s\) of \/employee-portals\/field-crm by the person it hit/);

  const unseen = store({ fixes: [fix()], views: 1 });
  const notYet = await runVerifier({ store: unseen.store, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
  assert.equal(notYet.verified.length, 0, "Quiet is not enough: a page barely opened proves nothing");
  assert.match(notYet.waiting[0].why, /not enough exposure yet: 1 page view/);

  const apiOnly = store({ fixes: [fix()], routes: [], views: 99 });
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
  const { store: s, calls } = store({ fixes: [check, link, visit], nights: ["2026-10-20", "2026-10-21", "2026-10-22"] });
  const outcome = await runVerifier({ store: s, nowMs: NOW, deadline: NOW + 60_000, now: () => NOW, detectorIdByFamily: IDS });
  assert.deepEqual(calls.byLastEvent, [true, true, false], "The state families compare last_event_at; an event family compares occurred_at");
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

  const oneBad = store({ fixes: [fix(), fix({ issueId: "issue-2" })], candidates: { "issue-1": new Error("timeout") }, views: 99 });
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

export async function runSystemAuditVerifierTests() {
  testPureRules();
  await testReopens();
  await testVerifiesOnlyWithExposure();
  await testDetectorFamilies();
  await testNothingDecidedOnHalfTheEvidence();
}
