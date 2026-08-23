import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The synthetic-journeys trigger must stay WATCHED, and it must ping the TRUTH.
 *
 * `/api/cron/run-synthetic-journeys` is the clock behind the only automated "is production actually
 * working?" signal left in the system. It does not run the suite itself — it asks GitHub to start
 * `synthetic-journeys.yml` — and it answers HTTP 200 with `{ dispatched: false, reason }` when that
 * ask does not land, deliberately, so cron-job.org is never trained to read a normal unconfigured
 * state as an outage.
 *
 * That shape is exactly why the generic `withDeadMansSwitch` wrapper is WRONG here: it derives the
 * ping from throw/no-throw, so a refused dispatch would ping success.
 * `GITHUB_ACTIONS_DISPATCH_TOKEN` is a fine-grained PAT and will expire; the hour it does, every
 * dispatch 401s and the synthetic suite silently stops while the check stays green. That is the
 * 2026-08-14 Direct Orders failure — nine nights of 401s that reached nobody — one layer up.
 *
 * So this file pins the two things that make the alarm real: the outcome is derived from the
 * dispatch's own answer, and the documented Healthchecks schedule matches the measured one. A check
 * tuned to the wrong cron alerts on a healthy job, which trains everyone to ignore it.
 */

const ROUTE = "app/api/cron/run-synthetic-journeys/route.ts";
const SLUG = "phoenix-run-synthetic-journeys";
const OBSERVABILITY_DOC = "docs/observability.md";

/**
 * Measured, not copied. 177 `workflow_dispatch` events on synthetic-journeys.yml between
 * 2026-08-15 and 2026-08-23, every one 4-12s past the top of the hour, all 24 UTC hours present.
 */
const DOCUMENTED_CRON = "0 * * * *";

/**
 * Cron routes that nothing in cron-job.org calls. Wiring one to a check produces a permanently red
 * dashboard entry, which is worse than no check at all.
 *
 * Three routes came off this list on 2026-08-23 — both `*-rotate-sheet-token` routes and
 * `/api/cron/brevo-keepalive` — in every case because a schedule was CREATED for them, not because
 * the evidence about them changed. See tests/sheet-token-rotation-liveness.test.ts and
 * tests/brevo-keepalive.test.ts, which pin those schedules. Of the two left, only the first is
 * unscheduled on purpose.
 */
const UNWATCHED_ROUTES = [
  "/api/cron/marketing-assignment-backfill",
  "/api/cron/reconciliation-check",
];

export async function runSyntheticJourneysLivenessTests() {
  const source = readFileSync(ROUTE, "utf8");

  assert.match(
    source,
    /import \{ pingDeadMansSwitch \} from "@\/lib\/observability\/dead-mans-switch";/,
    `${ROUTE} must import the dead-man's-switch — an unwatched trigger is how nine nights of 401s went unseen`,
  );

  assert.ok(
    source.includes(`const JOB_SLUG = "${SLUG}";`),
    `${ROUTE} must ping the slug ${SLUG}, matching the row in ${OBSERVABILITY_DOC}`,
  );

  // THE HEADLINE GUARANTEE. A dispatch that did not dispatch must ping /fail, not /success.
  assert.ok(
    source.includes('result.dispatched ? "success" : "fail"'),
    `${ROUTE} must derive the ping outcome from result.dispatched — this route answers 200 when the ` +
      "dispatch is refused, so any unconditional success ping reports a healthy check while the " +
      "synthetic suite has silently stopped running",
  );

  // Matches the CALL form, so the route's own comment explaining why the wrapper is wrong here
  // stays legal — it is the reason this rule exists and must not be the thing that trips it.
  assert.ok(
    !source.includes("withDeadMansSwitch("),
    `${ROUTE} must NOT use the withDeadMansSwitch wrapper: it derives the ping from throw/no-throw, ` +
      "and this route deliberately does not throw when GitHub refuses the dispatch (an expired PAT " +
      "would then hold the check green forever)",
  );

  // The ping must sit AFTER the real work, inside the handler's try — a ping placed before the
  // dispatch, or outside the try, reports success for a run that never happened.
  {
    const tryIndex = source.indexOf("  try {");
    const dispatchIndex = source.indexOf("await dispatchSyntheticJourneys()");
    const pingIndex = source.indexOf("await pingDeadMansSwitch(");
    assert.ok(tryIndex >= 0, `${ROUTE} must keep its handler try block`);
    assert.ok(
      dispatchIndex > tryIndex && pingIndex > dispatchIndex,
      `${ROUTE} must ping only after awaiting the dispatch, inside the handler's try block`,
    );
  }

  // A total crash never reaches the ping above, and is the single most important case for an
  // external monitor: nothing about that run's outcome would otherwise leave the app at all.
  assert.match(
    source,
    /pingDeadMansSwitch\(\s*JOB_SLUG,\s*"fail"/,
    `${ROUTE} must also ping /fail from its catch block — a thrown dispatch must not go unreported`,
  );

  const doc = readFileSync(OBSERVABILITY_DOC, "utf8");

  assert.ok(
    doc.includes(`\`${SLUG}\` | \`${DOCUMENTED_CRON}\``),
    `${OBSERVABILITY_DOC} must document ${SLUG} with its measured schedule (${DOCUMENTED_CRON}) — ` +
      "a Healthchecks check tuned to the wrong cron alerts on a healthy job",
  );

  // Keep the unscheduled routes named. Without this, the next sweep for "cron routes missing a
  // dead-man's-switch" finds them again and wires them blind, creating checks with no schedule
  // behind them — worse than none, because it teaches the dashboard's reader to ignore red.
  for (const route of UNWATCHED_ROUTES) {
    assert.ok(
      doc.includes(route),
      `${OBSERVABILITY_DOC} must record that nothing calls ${route}, or a later sweep will wire it ` +
        "to a check that has no schedule to be measured against",
    );
  }
}
