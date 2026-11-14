import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { declaredJourney, journeyAnnotation } from "./synthetic/helpers/declared-journey.ts";
import SyntheticReporter from "./synthetic/helpers/reporter.ts";
import type { JourneyResult } from "./synthetic/helpers/types.ts";

/**
 * The page printed beside a smoke check that skipped itself.
 *
 * Owner, 14 November 2026, reading the Synthetic Journeys page: "Outstation Expenses export produces
 * a workbook — unknown — skipped — 147ms — why?". The check stops on its first line, on purpose,
 * before it reports which page it is for, so the reporter wrote the word "unknown" on all 1,083 runs
 * since 9 September. A check that skips itself now names its page first, and the reporter prints it.
 */

const EXPORT_JOURNEY = { id: "outstation-expenses-export", route: "/admin/outstation/expenses", role: "Super Admin" };
const EXPORT_TITLE = "Outstation Expenses export produces a workbook";
const EXPORT_REASON =
  "Downloading the export records that an administrator exported expenses, so an hourly run would record 24 exports a day that nobody made.";
const SKIP_NOTE = { type: "skip", description: EXPORT_REASON };

type Note = { type: string; description?: string };

/** What the real reporter records for one check that never attached its own result. */
function reported(input: {
  status: "passed" | "skipped" | "failed";
  onResult?: Note[];
  onTest?: Note[];
  attachments?: { name: string; body?: Buffer }[];
}): JourneyResult {
  const reporter = new SyntheticReporter();
  const test = { id: "3f1c9d0a7b2e-playwright-hash", title: EXPORT_TITLE, annotations: input.onTest ?? [] };
  const result = {
    status: input.status,
    duration: 147,
    attachments: input.attachments ?? [],
    errors: input.status === "failed" ? [{ message: "boom" }] : [],
    annotations: input.onResult ?? [],
  };
  reporter.onTestEnd(test as never, result as never);
  const results = (reporter as unknown as { results: JourneyResult[] }).results;
  assert.equal(results.length, 1, "one check in, one result out");
  return results[0];
}

export function runSyntheticJourneyDeclaredPageTests() {
  // ── The defect. The export skipped itself and the page read "unknown".
  const skipped = reported({ status: "skipped", onResult: [journeyAnnotation(EXPORT_JOURNEY), SKIP_NOTE] });
  assert.equal(
    skipped.route,
    "/admin/outstation/expenses",
    "a check that skipped itself named its page first — the report must print that page, not the word 'unknown'",
  );
  assert.equal(skipped.role, "Super Admin", "and the role it runs as, not 'unknown'");
  assert.equal(
    skipped.journeyId,
    "outstation-expenses-export",
    "the page prints the check's id beside its route — its own id, not the test runner's internal hash",
  );
  assert.equal(skipped.status, "skipped", "naming the page does not change what happened to the check");
  assert.equal(skipped.skipReason, EXPORT_REASON, "the reason it gave for skipping is still carried");
  assert.equal(skipped.durationMs, 147);

  // ── Where the note is found. The runner hands it over on the result, or on the test itself.
  const onTest = reported({ status: "skipped", onTest: [journeyAnnotation(EXPORT_JOURNEY), SKIP_NOTE] });
  assert.equal(onTest.route, "/admin/outstation/expenses", "a note left on the test itself is read as well");
  assert.equal(onTest.skipReason, EXPORT_REASON);

  // ── "unknown" is kept for a check that really said nothing.
  const silent = reported({ status: "skipped" });
  assert.equal(silent.route, "unknown", "a check that never ran — the sign-in step before it failed — named no page, and none is invented");
  assert.equal(silent.role, "unknown");
  assert.equal(silent.journeyId, "3f1c9d0a7b2e-playwright-hash");
  assert.equal(silent.skipReason, undefined, "and it gave no reason, so the run is still marked down for it");

  const unreadable = reported({ status: "skipped", onResult: [{ type: "journey", description: "{not json" }, SKIP_NOTE] });
  assert.equal(unreadable.route, "unknown", "a note that cannot be read is no note — the report does not print half of one");
  assert.equal(unreadable.skipReason, EXPORT_REASON, "and an unreadable page note never costs the check its reason");

  // ── A check that crashed after naming its page is still told it crashed.
  const crashed = reported({ status: "failed", onResult: [journeyAnnotation(EXPORT_JOURNEY)] });
  assert.equal(crashed.route, "/admin/outstation/expenses");
  assert.equal(crashed.status, "failed");
  assert.ok(crashed.recommendation?.startsWith("This step crashed before it could report"), "naming a page does not hide a crash");

  // ── A check that reported for itself is never overridden by its note.
  const own: JourneyResult = {
    journeyId: "outstation-expenses-export",
    journeyName: EXPORT_TITLE,
    route: "/admin/outstation/expenses",
    role: "Super Admin",
    status: "passed",
    durationMs: 900,
    errors: [],
    consoleErrors: [],
    networkErrors: [],
  };
  const attached = reported({
    status: "passed",
    onResult: [journeyAnnotation({ id: "something-else", route: "/elsewhere", role: "Nobody" })],
    attachments: [{ name: "journey-result", body: Buffer.from(JSON.stringify(own), "utf-8") }],
  });
  assert.deepEqual(attached, own, "the check's own report wins — the note only fills the gap when there is none");

  // ── The note itself.
  assert.deepEqual(declaredJourney([journeyAnnotation(EXPORT_JOURNEY)]), EXPORT_JOURNEY, "what a check declares is what is read back");
  assert.deepEqual(
    declaredJourney([SKIP_NOTE, { type: "slow" }, journeyAnnotation(EXPORT_JOURNEY)]),
    EXPORT_JOURNEY,
    "other notes on the check are passed over",
  );
  assert.equal(declaredJourney([]), undefined);
  assert.equal(declaredJourney([SKIP_NOTE]), undefined, "a reason for skipping is not a page");
  assert.equal(
    declaredJourney([{ type: "journey", description: JSON.stringify({ id: "x", route: "  ", role: "Super Admin" }) }]),
    undefined,
    "a blank page is no page",
  );
  assert.equal(declaredJourney([{ type: "journey", description: "null" }]), undefined);
  assert.equal(declaredJourney([{ type: "journey" }]), undefined);
  const extra = journeyAnnotation({ ...EXPORT_JOURNEY, name: EXPORT_TITLE, mutates: true } as never);
  assert.deepEqual(JSON.parse(extra.description), EXPORT_JOURNEY, "only the id, page and role are carried in the note");

  // ── The one check that skips itself says its page BEFORE the line that stops it.
  const spec = readFileSync(new URL("./synthetic/journeys/outstation-expenses-export.spec.ts", import.meta.url), "utf8");
  const declares = spec.indexOf("testInfo.annotations.push(journeyAnnotation(JOURNEY))");
  const skips = spec.indexOf("test.skip(");
  assert.ok(declares > 0, "the export check names its page");
  assert.ok(skips > 0, "the export check still skips itself unless a mutating run is asked for");
  assert.ok(declares < skips, "the page is named before the skip — a note left after it is never written, because the check has already stopped");
  assert.ok(spec.includes('route: "/admin/outstation/expenses"'), "the page it names is the Outstation Expenses admin page");
}
