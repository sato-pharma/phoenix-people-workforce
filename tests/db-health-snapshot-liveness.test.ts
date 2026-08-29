import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The database health snapshot must stay WATCHED, and must report its own failures.
 *
 * This route spent its whole life deliberately unwatched. The reasoning was written into it: a
 * missed snapshot is a gap in a graph, not an incident, and paging on it would train the owner to
 * ignore the pager. That answered SEVERITY and ignored VISIBILITY. Opting out did not make the job
 * alert quietly — it made a stopped job and a running job look exactly the same from outside.
 *
 * On 2026-08-24 a half-finished `CRON_SECRET` rotation left six of the twelve enabled cron-job.org
 * jobs presenting a superseded token. Every one of them 401’d at the door, before any ping, so they
 * went silent rather than red. The only reason it was caught at all is that the hourly
 * synthetic-journeys check blew its grace window and dragged the rest into view. On a 6-hourly
 * clock with no check at all, this job would have stayed dark indefinitely, and the slow-query
 * history it exists to accumulate — the history that surfaced a 17.5s query which had run 192 times
 * unreported — would simply have stopped growing with nobody the wiser.
 *
 * Severity is now carried by the GRACE (2h, docs/observability.md), not by the silence.
 *
 * THE HEADLINE GUARANTEE, and the reason `withDeadMansSwitch` is the wrong tool here: this route
 * CATCHES its own error and answers HTTP 500 rather than throwing. The wrapper derives its ping
 * from throw/no-throw, so wrapping this route would report every failed snapshot as a success —
 * precisely the failure the check exists to detect. The outcome must therefore be pinged by hand,
 * success from the try and fail from the catch.
 */

const ROUTE = "app/api/cron/db-health-snapshot/route.ts";
const OBSERVABILITY_DOC = "docs/observability.md";
const SLUG = "phoenix-db-health-snapshot";
const CRON = "17 */6 * * *";
const JOB_ID = "8242721";
const WORK = "await captureQueryStatsSnapshot()";

export async function runDbHealthSnapshotLivenessTests() {
  const source = readFileSync(ROUTE, "utf8");
  const doc = readFileSync(OBSERVABILITY_DOC, "utf8");

  assert.match(
    source,
    /import \{ pingDeadMansSwitch \} from "@\/lib\/observability\/dead-mans-switch";/,
    `${ROUTE} must import the dead-man's-switch — this job runs every 6 hours and nobody watches it by hand`,
  );

  assert.ok(
    source.includes(`const JOB_SLUG = "${SLUG}";`),
    `${ROUTE} must ping the slug ${SLUG}, matching its row in ${OBSERVABILITY_DOC}`,
  );

  // THE HEADLINE ASSERTION. The route swallows its own error and answers 500, so a failed snapshot
  // is invisible unless the catch says so. Without this ping the check stays green over a route
  // that has failed every run for a month.
  assert.match(
    source,
    /pingDeadMansSwitch\(\s*JOB_SLUG,\s*"fail"/,
    `${ROUTE} must ping /fail from its catch block — this route answers HTTP 500 instead of throwing, ` +
      "so a snapshot that failed on every run would otherwise leave a permanently green check behind it",
  );

  assert.ok(
    source.includes('pingDeadMansSwitch(JOB_SLUG, "success")'),
    `${ROUTE} must ping /success once the snapshot is captured — a check that is never pinged goes red ` +
      "on schedule and stays red, which teaches whoever reads the dashboard that red is the normal colour",
  );

  // Matches the CALL form, so the route's own comment explaining why the wrapper is wrong here stays
  // legal — that explanation is the reason this rule exists and must not be what trips it.
  assert.ok(
    !source.includes("withDeadMansSwitch("),
    `${ROUTE} must NOT use the withDeadMansSwitch wrapper: it reads throw/no-throw, and this route ` +
      "catches its own error and returns 500, so the wrapper would call a failed snapshot a success",
  );

  // The success ping must sit AFTER the capture, inside the handler's try. A ping placed before the
  // work, or outside the try, reports a run that has not happened yet.
  const tryIndex = source.indexOf("  try {");
  const workIndex = source.indexOf(WORK);
  const pingIndex = source.indexOf('pingDeadMansSwitch(JOB_SLUG, "success")');
  assert.ok(tryIndex >= 0, `${ROUTE} must keep its handler try block`);
  assert.ok(workIndex > tryIndex, `${ROUTE} must call ${WORK} inside the handler's try block`);
  assert.ok(
    pingIndex > workIndex,
    `${ROUTE} must ping success only after awaiting the snapshot — a ping before the work reports a ` +
      "capture that has not run yet",
  );

  // The unauthorized branch must stay ABOVE the try, and must never ping. A 401 means the caller is
  // not the scheduler; pinging success there would let anything on the internet hold the check green,
  // and pinging fail would page on a stray scan. Staying silent there is what made the 2026-08-24
  // rotation invisible — the answer to that is a check that notices the ABSENCE, not a ping on 401.
  // Repointed 2026-08-29 (A2): the route no longer calls logCronUnauthorized itself — the log and
  // the 401 are now inseparable inside assertCronAuthorized, and that they cannot come apart is
  // pinned by tests/cron-auth-single-guard.test.ts. What this file still owns is the POSITION of
  // the rejection relative to the try block, which is the part that governs pinging, so that is
  // what it keeps asserting.
  const unauthorizedIndex = source.indexOf("assertCronAuthorized(");
  assert.ok(unauthorizedIndex >= 0, `${ROUTE} must keep rejecting and logging unauthorized calls`);
  assert.ok(
    unauthorizedIndex < tryIndex,
    `${ROUTE} must reject unauthorized callers before the try block, so no ping can be triggered by an ` +
      "unauthenticated request",
  );

  // The schedule lives in a third-party account this repository cannot read. The job id is the only
  // handle on it, so it must survive in the code that depends on it.
  assert.ok(
    source.includes(JOB_ID),
    `${ROUTE} must name its cron-job.org job id (${JOB_ID}) — the schedule exists only in an account ` +
      "outside this repo, and without the id the next session cannot find or verify it",
  );

  assert.ok(
    doc.includes(`\`${SLUG}\` | \`${CRON}\``),
    `${OBSERVABILITY_DOC} must document ${SLUG} with the schedule that is actually configured (${CRON}) — ` +
      "a check tuned to a cron the job does not run on alerts on a healthy job",
  );

  assert.ok(
    doc.includes(JOB_ID),
    `${OBSERVABILITY_DOC} must record cron-job.org job ${JOB_ID} for ${SLUG}, so the documented schedule ` +
      "can be checked against the account rather than believed",
  );

  // The doc used to state, as a deliberate decision, that this job had no check. It has one now, and
  // a stale sentence saying otherwise is how a future session removes the ping in good faith.
  assert.ok(
    !doc.includes("One enabled job has no row here, and that is deliberate."),
    `${OBSERVABILITY_DOC} still says one enabled job deliberately has no check — that sentence described ` +
      `${SLUG} before it was wired on 2026-08-24 and must not outlive the decision it recorded`,
  );
}
