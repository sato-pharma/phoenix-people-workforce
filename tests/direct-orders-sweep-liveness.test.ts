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
 * test exists so the wiring cannot be quietly dropped, and so the live schedule and the documented
 * Healthchecks schedule cannot drift apart (a check tuned to the wrong cron alerts on a job that is
 * running fine, which trains everyone to ignore it).
 *
 * Since 2026-08-23 the clocks live in cron-job.org, not in the workflow. A test cannot read that
 * account, so what it enforces instead is the failure that account move can cause: the workflow
 * quietly growing a `schedule:` back and double-firing both sweeps.
 */

const SWEEPS = [
  {
    route: "app/api/cron/direct-orders-expire-held/route.ts",
    slug: "phoenix-direct-orders-expire-held",
    // Live in cron-job.org job 8313165 — Africa/Cairo, not UTC.
    schedule: "17 2 * * *",
    clock: "02:17",
  },
  {
    route: "app/api/cron/direct-orders-probation/route.ts",
    slug: "phoenix-direct-orders-probation",
    // Live in cron-job.org job 8313177 — deliberately staggered off the sweep above.
    schedule: "27 2 * * *",
    clock: "02:27",
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

  // Exactly one scheduler may own these clocks, and since 2026-08-23 that is cron-job.org.
  {
    const workflow = readFileSync(WORKFLOW, "utf8");
    assert.ok(
      !/^\s*schedule:/m.test(workflow) && !/^\s*- cron:/m.test(workflow),
      `${WORKFLOW} must not declare a schedule — cron-job.org owns these two clocks, and a second ` +
        "scheduler means every requester whose order expires is notified twice",
    );
    assert.match(
      workflow,
      /^\s*workflow_dispatch:/m,
      `${WORKFLOW} must keep workflow_dispatch — it is the manual fallback for these sweeps`,
    );

    const doc = readFileSync(OBSERVABILITY_DOC, "utf8");
    for (const { slug, schedule, clock } of SWEEPS) {
      assert.ok(
        doc.includes(`\`${slug}\` | \`${schedule}\``),
        `docs/observability.md must document ${slug} with its live cron-job.org schedule (${schedule}) — ` +
          "a Healthchecks check tuned to the wrong cron alerts on a healthy job",
      );
      assert.ok(
        workflow.includes(clock),
        `${WORKFLOW} must name ${slug}'s live time (${clock} Africa/Cairo) so someone running the ` +
          "fallback by hand can see what it is standing in for",
      );
    }

    // The doc previously said these schedules were NOT in cron-job.org. Following that today sends
    // a reader to a workflow that no longer has one, and the real clock goes untuned.
    assert.ok(
      !/schedule\s+is \*\*not\*\* in cron-job\.org/.test(doc),
      `${OBSERVABILITY_DOC} must not claim these schedules live outside cron-job.org — they moved ` +
        "into it on 2026-08-23",
    );
  }

  // The workflow must keep naming the CRON_SECRET mismatch on a 401. A bare "HTTP 401" is what made
  // nine identical red runs look like nine unrelated glitches.
  //
  // The pin here was the literal `/CRON_SECRET is STALE/` until 2026-08-31. That wording named the
  // right variable and the WRONG DIRECTION: `sync-railway-production-secrets.yml` pushes GitHub
  // INTO Railway, so "re-align it from Railway" is half the story, and the bare
  // `railway | jq | gh` pipe it recommended can carry a UTF-8 BOM straight into production. Pin the
  // INTENT — diagnose the cause, and say which store is authoritative — never one phrasing.
  {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const failures401 = workflow.match(/^.*returned HTTP 401.*$/gm) ?? [];
    assert.ok(
      failures401.length > 0,
      `${WORKFLOW} must diagnose a 401 rather than printing a bare status code`,
    );
    for (const line of failures401) {
      assert.match(
        line,
        /CRON_SECRET/,
        `${WORKFLOW} must name CRON_SECRET as the cause on a 401, not just the status code`,
      );
      assert.match(
        line,
        /UPSTREAM of Railway/,
        `${WORKFLOW}'s 401 hint must say which store is authoritative — sync-railway-production-` +
          "secrets.yml pushes GitHub INTO Railway, so rotating Railway alone does not stick: the " +
          "next qualifying push reverts it and 401s every cron-job.org job at once",
      );
    }
    assert.ok(
      !/jq\s+-r\s+\.?CRON_SECRET\s*\|\s*gh secret set/.test(workflow),
      `${WORKFLOW} must not recommend the bare railway|jq|gh pipe — it can store a UTF-8 BOM, and ` +
        "because GitHub is upstream that BOM reaches production. Point at the guarded form " +
        "(strip BOM, assert length 64, fingerprint before writing) in docs/agents-production-hooks.md",
    );
    assert.ok(
      !/a red workflow run emails the owner/.test(workflow),
      `${WORKFLOW} must not claim a red run emails the owner — nine consecutive red runs reached nobody`,
    );
  }
}
