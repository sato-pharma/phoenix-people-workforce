import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The two Direct Orders clocks must stay WATCHED.
 *
 * Both sweeps 401'd every night from 2026-08-14 to 2026-08-22 — nine consecutive failures — and
 * nothing reported it. `CRON_SECRET` had been rotated on Railway and the GitHub Actions copy was
 * left stale. The workflow went red nightly and that reached nobody; the failure surfaced only
 * because an unrelated audit went looking.
 *
 * A red CI run is not an alert. The dead-man's-switch is, because it fires on the ping that did
 * NOT arrive — the only signal that can report a request never reaching the handler at all. This
 * test exists so the wiring cannot be quietly dropped, and so the workflow schedule and the
 * documented Healthchecks schedule cannot drift apart (a check tuned to the wrong cron alerts on
 * a job that is running fine, which trains everyone to ignore it).
 */

const SWEEPS = [
  {
    route: "app/api/cron/direct-orders-expire-held/route.ts",
    slug: "phoenix-direct-orders-expire-held",
  },
  {
    route: "app/api/cron/direct-orders-probation/route.ts",
    slug: "phoenix-direct-orders-probation",
  },
];

const WORKFLOW = ".github/workflows/direct-orders-sweeps.yml";
const OBSERVABILITY_DOC = "docs/observability.md";

export async function runDirectOrdersSweepLivenessTests() {
  for (const { route, slug } of SWEEPS) {
    const source = readFileSync(route, "utf8");

    assert.match(
      source,
      /import \{ withDeadMansSwitch \} from "@\/lib\/observability\/dead-mans-switch";/,
      `${route} must import the dead-man's-switch — an unwatched daily clock is how nine nights of 401s went unseen`,
    );

    assert.ok(
      source.includes(`withDeadMansSwitch("${slug}"`),
      `${route} must run its sweep inside withDeadMansSwitch("${slug}") so a missing ping alerts`,
    );

    // The ping must wrap the real work, not sit beside it. If the call were made unconditionally
    // outside the try/catch the switch would report success for a sweep that threw.
    const wrapIndex = source.indexOf("withDeadMansSwitch(");
    const tryIndex = source.indexOf("  try {");
    assert.ok(
      tryIndex >= 0 && wrapIndex > tryIndex,
      `${route} must call withDeadMansSwitch inside the handler's try block, not around it`,
    );
  }

  // The probation sweep's report send must be INSIDE the switch: a sweep that finds phantoms and
  // then fails to email them has not done its job, and must not ping success.
  {
    const source = readFileSync(SWEEPS[1].route, "utf8");
    const wrapIndex = source.indexOf("withDeadMansSwitch(");
    const sendIndex = source.indexOf("sendDirectOrderPhantomReport(sweep.flagged)");
    assert.ok(
      sendIndex > wrapIndex && wrapIndex >= 0,
      "the phantom report send must sit inside withDeadMansSwitch — an unsent report is a failed sweep",
    );
  }

  // Schedule coupling: the workflow's cron and the documented Healthchecks rows must agree.
  {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const match = /- cron: "([^"]+)"/.exec(workflow);
    assert.ok(match, `${WORKFLOW} must declare a cron schedule`);
    const schedule = match![1];

    const doc = readFileSync(OBSERVABILITY_DOC, "utf8");
    for (const { slug } of SWEEPS) {
      assert.ok(
        doc.includes(`\`${slug}\` | \`${schedule}\``),
        `docs/observability.md must document ${slug} with the workflow's own schedule (${schedule}) — ` +
          "a Healthchecks check tuned to the wrong cron alerts on a healthy job",
      );
    }
  }

  // The workflow must keep naming the stale-secret cause on a 401. A bare "HTTP 401" is what made
  // nine identical red runs look like nine unrelated glitches.
  {
    const workflow = readFileSync(WORKFLOW, "utf8");
    assert.match(
      workflow,
      /CRON_SECRET is STALE/,
      `${WORKFLOW} must diagnose a 401 as a stale CRON_SECRET rather than printing a bare status code`,
    );
    assert.ok(
      !/a red workflow run emails the owner/.test(workflow),
      `${WORKFLOW} must not claim a red run emails the owner — nine consecutive red runs reached nobody`,
    );
  }
}
