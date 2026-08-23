import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The two live-sheet token rotations must stay SCHEDULED and must ping the TRUTH.
 *
 * Until 2026-08-23 these routes were the purest form of the failure this whole file guards against:
 * the code was correct, deployed, configured, and completely unwatched, because **nothing called
 * it**. Both feed tokens were minted 2026-08-05 and never rotated. Everything an observer could see
 * looked healthy — the webhook variables were set, each report had exactly one live feed link, and
 * both sheets were being read tens of thousands of times a week — while the rotation the routes
 * exist for had simply never happened. A dead-man's-switch cannot report that on its own; a check
 * with no schedule behind it is only an opinion. So the schedule came first (cron-job.org jobs
 * 8313169 and 8313171, Fridays 03:23 and 03:43 Cairo) and the wiring second.
 *
 * `withDeadMansSwitch` is the wrong tool here, deliberately. It derives the ping from throw/no-throw,
 * and these routes answer HTTP 200 with `{ rotated: false, reason }` on every failure a person needs
 * to act on: webhook variables unset, no live feed link (the owner's report is dead), more than one
 * live link (ambiguous), or the sheet never reading back with the new token (the rotation did not
 * take). A successful rotation always leaves exactly one live link, so `rotated: true` is the steady
 * state and there is no benign `false` to tolerate. Wrapping these would produce a green check above
 * a route that no-ops every Friday for a year.
 *
 * What this file pins: the outcome is derived from the rotation's own answer, a thrown run is
 * reported too, and the schedule that makes the check meaningful is written down where the next
 * session will find it — in the route, and in the docs, with the external job id that is the only
 * handle anyone has on an account this repository cannot see.
 */

const ROUTES = [
  {
    cron: "23 3 * * 5",
    jobId: "8313169",
    path: "app/api/cron/direct-orders-rotate-sheet-token/route.ts",
    slug: "phoenix-direct-orders-rotate-sheet-token",
    work: "await rotateDirectOrderSheetToken()",
  },
  {
    cron: "43 3 * * 5",
    jobId: "8313171",
    path: "app/api/cron/marketing-requests-rotate-sheet-token/route.ts",
    slug: "phoenix-marketing-requests-rotate-sheet-token",
    work: "await rotateMarketingSheetToken()",
  },
] as const;

const OBSERVABILITY_DOC = "docs/observability.md";

export async function runSheetTokenRotationLivenessTests() {
  const doc = readFileSync(OBSERVABILITY_DOC, "utf8");

  for (const route of ROUTES) {
    const source = readFileSync(route.path, "utf8");

    assert.match(
      source,
      /import \{ pingDeadMansSwitch \} from "@\/lib\/observability\/dead-mans-switch";/,
      `${route.path} must import the dead-man's-switch — this route rotates a secret nobody watches by hand`,
    );

    assert.ok(
      source.includes(`const JOB_SLUG = "${route.slug}";`),
      `${route.path} must ping the slug ${route.slug}, matching its row in ${OBSERVABILITY_DOC}`,
    );

    // THE HEADLINE GUARANTEE. A rotation that did not rotate must ping /fail, not /success.
    assert.ok(
      source.includes('result.rotated ? "success" : "fail"'),
      `${route.path} must derive the ping outcome from result.rotated — this route answers HTTP 200 ` +
        "when the rotation is refused, so an unconditional success ping shows a green check above a " +
        "token that has not moved since 2026-08-05",
    );

    // Matches the CALL form, so each route's own comment explaining why the wrapper is wrong here
    // stays legal — that explanation is the reason this rule exists and must not be what trips it.
    assert.ok(
      !source.includes("withDeadMansSwitch("),
      `${route.path} must NOT use the withDeadMansSwitch wrapper: it reads throw/no-throw, and every ` +
        "failure this route can actually have returns 200 instead of throwing",
    );

    // The ping must sit AFTER the rotation, inside the handler's try. A ping placed before the work,
    // or outside the try, reports success for a rotation that never ran.
    const tryIndex = source.indexOf("  try {");
    const workIndex = source.indexOf(route.work);
    const pingIndex = source.indexOf("await pingDeadMansSwitch(");
    assert.ok(tryIndex >= 0, `${route.path} must keep its handler try block`);
    assert.ok(workIndex > tryIndex, `${route.path} must call ${route.work} inside the handler's try block`);
    assert.ok(
      pingIndex > workIndex,
      `${route.path} must ping only after awaiting the rotation — a ping before the work reports a ` +
        "run that has not happened yet",
    );

    // A throw never reaches the ping above, and that is the single most important case for an
    // external monitor: nothing about that run's outcome would otherwise leave the app at all.
    assert.match(
      source,
      /pingDeadMansSwitch\(\s*JOB_SLUG,\s*"fail"/,
      `${route.path} must also ping /fail from its catch block — a thrown rotation must not go unreported`,
    );

    // The schedule lives in a third-party account this repository cannot read. The job id is the
    // only handle on it, so it must survive in the code that depends on it.
    assert.ok(
      source.includes(route.jobId),
      `${route.path} must name its cron-job.org job id (${route.jobId}) — the schedule exists only in ` +
        "an account outside this repo, and without the id the next session cannot find or verify it",
    );

    assert.ok(
      doc.includes(`\`${route.slug}\` | \`${route.cron}\``),
      `${OBSERVABILITY_DOC} must document ${route.slug} with the schedule that is actually configured ` +
        `(${route.cron}) — a check tuned to a cron the job does not run on alerts on a healthy job`,
    );

    assert.ok(
      doc.includes(route.jobId),
      `${OBSERVABILITY_DOC} must record cron-job.org job ${route.jobId} for ${route.slug}, so the ` +
        "documented schedule can be checked against the account rather than believed",
    );
  }

  // The two runs must never overlap. Each request is capped at 30s by cron-job.org while the routes
  // allow 60s, and both talk to Google Apps Script; scheduling them on the same minute would let one
  // rotation's confirmation race the other's.
  const [first, second] = ROUTES;
  assert.notEqual(
    first.cron,
    second.cron,
    "the two rotation jobs must not share a schedule — each waits on a live sheet to confirm, and " +
      "overlapping runs put two Apps Script round-trips in the same 30s window",
  );
}
