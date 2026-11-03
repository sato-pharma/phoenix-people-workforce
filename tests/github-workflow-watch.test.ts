import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
  GITHUB_WORKFLOW_WATCHES,
  assessGithubWorkflows,
  buildGithubWorkflowMessage,
  parseLastGoodRead,
  parseTokenExpiry,
  tokenWarningDaysDue,
  type GithubWorkflowRead,
} from "../src/lib/observability/github-workflow-watch.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function allFresh(): GithubWorkflowRead[] {
  return GITHUB_WORKFLOW_WATCHES.map((watch) => ({
    file: watch.file,
    kind: "answered",
    lastSuccessAt: new Date(NOW - HOUR).toISOString(),
    tokenExpiresAt: null,
  }));
}

function assess(reads: GithubWorkflowRead[], previousDetail: string | null = null) {
  return assessGithubWorkflows({ firstSeenAt: "2026-10-01T00:00:00Z", nowMs: NOW, previousDetail, reads, tokenSet: true });
}

function replaced(file: string, read: GithubWorkflowRead): GithubWorkflowRead[] {
  return allFresh().map((candidate) => (candidate.file === file ? read : candidate));
}

export function runGithubWorkflowWatchTests() {
  // The table is every workflow that really has a schedule, plus the one Phoenix dispatches. A commented
  // `schedule:` line does not count: two workflows carry one as a warning never to add it back.
  const scheduled = readdirSync(".github/workflows")
    .filter((file) => file.endsWith(".yml"))
    .filter((file) => /^ {2}schedule:/m.test(readFileSync(`.github/workflows/${file}`, "utf8")));
  assert.deepEqual(
    GITHUB_WORKFLOW_WATCHES.map((watch) => watch.file).sort(),
    [...scheduled, "synthetic-journeys.yml"].sort(),
    "a scheduled workflow missing from the watch can stop firing with nobody told",
  );

  const clean = assess(allFresh());
  assert.equal(clean.outcome, "success");
  assert.deepEqual(clean.overdue, []);
  assert.equal(parseLastGoodRead(clean.detail), new Date(NOW).toISOString(), "a complete read moves the clock forward");

  // Overdue is measured against each workflow's own limit, and is an alert rather than a failed run.
  const late = assess(
    replaced("deploy-drift-check.yml", {
      file: "deploy-drift-check.yml",
      kind: "answered",
      lastSuccessAt: new Date(NOW - 7 * HOUR).toISOString(),
      tokenExpiresAt: null,
    }),
  );
  assert.equal(late.outcome, "success", "an overdue check is not the watch failing");
  assert.deepEqual(late.overdue.map((item) => item.file), ["deploy-drift-check.yml"]);
  const within = assess(
    replaced("security-scan.yml", {
      file: "security-scan.yml",
      kind: "answered",
      lastSuccessAt: new Date(NOW - 7 * HOUR).toISOString(),
      tokenExpiresAt: null,
    }),
  );
  assert.deepEqual(within.overdue, [], "seven hours is inside a 36-hour limit");

  const never = assess(
    replaced("security-scan.yml", { file: "security-scan.yml", kind: "answered", lastSuccessAt: null, tokenExpiresAt: null }),
  );
  assert.deepEqual(never.overdue.map((item) => item.file), ["security-scan.yml"], "no success on record is overdue, never clean");
  assert.match(buildGithubWorkflowMessage(never), /no success on record/);

  // Being blind fails: no token, and a refusal, at once.
  const noToken = assessGithubWorkflows({ firstSeenAt: null, nowMs: NOW, previousDetail: null, reads: [], tokenSet: false });
  assert.equal(noToken.outcome, "fail", "an unset token leaves the checks unwatched, so it must fail");
  for (const status of [401, 403, 404]) {
    const refused = assess(replaced("security-scan.yml", { file: "security-scan.yml", kind: "refused", status }));
    assert.equal(refused.outcome, "fail", `${status} is a dead token, a suspended account or a renamed workflow`);
  }

  // A blip stays quiet and keeps the last good read, then fails past three hours.
  const previous = `All 8 checks within their limits. lastGoodRead=${new Date(NOW - 2 * HOUR).toISOString()}`;
  const blip = assess(replaced("security-scan.yml", { file: "security-scan.yml", kind: "transient", reason: "x" }), previous);
  assert.equal(blip.outcome, "success", "two hours of a bad GitHub reaches nobody");
  assert.equal(parseLastGoodRead(blip.detail), new Date(NOW - 2 * HOUR).toISOString(), "a partial read must not move the clock");
  const tooLong = `lastGoodRead=${new Date(NOW - 4 * HOUR).toISOString()}`;
  assert.equal(
    assess(replaced("security-scan.yml", { file: "security-scan.yml", kind: "transient", reason: "x" }), tooLong).outcome,
    "fail",
    "over three hours of no answer is blind",
  );
  const missingRead = assess(allFresh().slice(1), tooLong);
  assert.equal(missingRead.outcome, "fail", "a workflow with no read at all counts as unread, never as fresh");

  // The marker survives a failure, so the clock is not lost across a failed run.
  assert.ok(parseLastGoodRead(noToken.detail), "every detail carries the marker");

  // The token warning.
  assert.equal(parseTokenExpiry("2026-12-31 10:00:00 UTC"), "2026-12-31T10:00:00.000Z");
  assert.equal(parseTokenExpiry("2026-12-31 12:00:00 +0200"), "2026-12-31T10:00:00.000Z");
  assert.equal(parseTokenExpiry(null), null, "a token with no expiry header warns about nothing");
  assert.equal(tokenWarningDaysDue(new Date(NOW + 21 * 24 * HOUR).toISOString(), NOW), 21);
  assert.equal(tokenWarningDaysDue(new Date(NOW + 20 * 24 * HOUR).toISOString(), NOW), null, "weekly until the last week");
  assert.equal(tokenWarningDaysDue(new Date(NOW + 3 * 24 * HOUR).toISOString(), NOW), 3, "daily in the last week");
  assert.equal(tokenWarningDaysDue(new Date(NOW + 30 * 24 * HOUR).toISOString(), NOW), null);
  assert.equal(tokenWarningDaysDue(null, NOW), null);
}
