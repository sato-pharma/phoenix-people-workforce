import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assessDrainHealth,
  describeDrainHealth,
  type DrainQueueReading,
} from "../src/lib/notifications/drain-health.ts";
import { buildDrainStrandedMessage } from "../src/lib/notifications/drain-health-alert.ts";

/**
 * The alert that would have caught the 13-day freeze - why this test exists.
 *
 * Between 2026-08-14 and 2026-08-27 every notification retry in this system was silently dropped.
 * The drain cron fired every 5 minutes, returned HTTP 200, and reported `attempted: 0` - identical
 * to a healthy, empty queue. 49 real emails waited behind the blockage for 13 days and nothing,
 * anywhere, said a word.
 *
 * Two monitors were already in place and neither could have fired:
 *
 *   - `withDeadMansSwitch` alerts on a ping that never arrives - a job that stopped, paused or
 *     crashed. This job never stopped. It ran flawlessly and did nothing, pinging "success" through
 *     the entire incident.
 *   - #2465 added a counter inside the scan loop (`skippedExhausted > 0`). It was dead on arrival:
 *     #2464 had merged six minutes earlier with a SQL filter that keeps those rows out of the scan,
 *     so the counter is now always 0. An alert keyed to one implementation detail dies the moment
 *     that detail is refactored.
 *
 * So the rule under test is a black-box invariant that survives any refactor of the internals:
 *
 *     A queue that had work DUE BEFORE THIS RUN STARTED, and attempted nothing, is broken.
 *
 * The headline assertion is the first one - the 2026-08-14 shape itself. The three that follow it
 * matter just as much, because an alert that cries wolf gets muted and then it is worse than no
 * alert at all: an empty queue, a busy-but-working drain, and a probe that could not answer must
 * all stay silent.
 */

function reading(
  queue: DrainQueueReading["queue"],
  attempted: number,
  strandedBefore: number | null,
): DrainQueueReading {
  return { attempted, queue, strandedBefore };
}

export async function runNotificationDrainHealthAlertTests() {
  // The headline: the production incident, expressed as a reading.
  {
    const verdict = assessDrainHealth([reading("outbox", 0, 49)]);

    assert.equal(
      verdict.healthy,
      false,
      "a drain that attempted NOTHING while 49 rows were already due must be reported unhealthy - "
        + "this is the exact reading the drain produced every 5 minutes for 13 days while a green "
        + "cron and a green dead-man's switch reported success. If this assertion fails, the one "
        + "signal that distinguishes a broken drain from an idle one is gone and the next freeze "
        + "hides exactly as long.",
    );
    assert.deepEqual(
      verdict.stranded.map((row) => row.queue),
      ["outbox"],
      "the unhealthy queue must be named, so the alert says which drain stopped",
    );
  }

  // An empty queue is the normal case and must never alert - this is the reading a healthy drain
  // produces on most ticks, and a false alarm here is what gets the whole alert muted.
  {
    const verdict = assessDrainHealth([reading("outbox", 0, 0)]);
    assert.equal(
      verdict.healthy,
      true,
      "attempted 0 with nothing due is an IDLE drain, not a broken one - alerting here would fire "
        + "on almost every run and train everyone to ignore it",
    );
    assert.deepEqual(verdict.stranded, [], "an idle drain strands nothing");
  }

  // A real backlog draining under load is working, not broken.
  {
    const verdict = assessDrainHealth([reading("outbox", 50, 400)]);
    assert.equal(
      verdict.healthy,
      true,
      "a drain that attempted its full batch is working - a large remaining backlog means busy, "
        + "and firing on it would make every genuine surge look like an outage",
    );
  }

  // A probe that could not answer is UNKNOWN. It must never manufacture an alert.
  {
    const verdict = assessDrainHealth([reading("outbox", 0, null)]);
    assert.equal(
      verdict.healthy,
      true,
      "a failed monitoring probe is not an application failure - a null reading must stay silent, "
        + "or a Supabase blip becomes a page at 4am",
    );
  }

  // Every queue is watched independently: one broken drain must not be hidden by three healthy ones.
  {
    const verdict = assessDrainHealth([
      reading("outbox", 12, 3),
      reading("telegram", 0, 25),
      reading("push", 0, 0),
      reading("deferred", 0, null),
    ]);

    assert.equal(verdict.healthy, false, "a single stranded queue makes the whole run unhealthy");
    assert.deepEqual(
      verdict.stranded.map((row) => row.queue),
      ["telegram"],
      "only the genuinely stranded queue is reported - telegram held 25 exhausted rows against a "
        + "limit of 50 on 2026-08-27, one shape away from the same freeze email hit",
    );
  }

  // The alert payload has to say what is wrong without anyone opening a database.
  {
    const text = describeDrainHealth(assessDrainHealth([reading("telegram", 0, 25)]));
    assert.equal(text.includes("telegram"), true, "the description names the queue");
    assert.equal(text.includes("25"), true, "the description carries the stranded count");

    const healthy = describeDrainHealth(assessDrainHealth([reading("outbox", 3, 0)]));
    assert.equal(
      healthy.includes("attempted their due work"),
      true,
      "a healthy verdict still describes itself, so a quiet monitor is distinguishable from an "
        + "unwired one",
    );
  }

  // Wiring guard: the drain route must not go back to the wrapper that stayed green all 13 days.
  {
    const source = readFileSync(
      new URL("../app/api/notifications/process/route.ts", import.meta.url),
      "utf8",
    );

    // Match the IMPORT and the CALL, not the bare word - the route names it in a comment
    // explaining why it is not used, and a check that trips on prose is a check nobody trusts.
    const dmsSpecifier = 'from "@/lib/observability/dead-mans-switch"';
    const specifierAt = source.indexOf(dmsSpecifier);
    assert.notEqual(specifierAt, -1, "the drain route must still import the dead-man's switch");
    const dmsImport = source.slice(source.lastIndexOf("import ", specifierAt), specifierAt + dmsSpecifier.length);
    assert.equal(
      dmsImport?.includes("withDeadMansSwitch"),
      false,
      "the drain route must NOT import withDeadMansSwitch: it pings success whenever the body "
        + "resolves, and the body resolved perfectly on every run of the 13-day freeze. Ping the "
        + "queue's verdict instead.",
    );
    assert.equal(
      source.includes("withDeadMansSwitch("),
      false,
      "the drain route must not CALL the wrapper either - that is the monitor that stayed green "
        + "through the whole incident",
    );
    assert.equal(
      source.includes("pingDeadMansSwitch"),
      true,
      "the drain route must still ping the external monitor - dropping the ping entirely would "
        + "lose liveness detection on top of everything else",
    );
    assert.equal(
      source.includes("describeDrainHealth"),
      true,
      "the fail ping must carry the verdict, or the monitor goes red with no way to see why",
    );

    // Slice by marker, never by a fixed byte window - a byte window false-fails the moment the
    // file shifts above it.
    const start = source.indexOf("export async function GET");
    assert.notEqual(start, -1, "the cron entry point must still be a GET");
    const cronBody = source.slice(start);
    assert.equal(
      cronBody.includes('"fail"'),
      true,
      "the cron path must be able to ping a FAILURE - a route that can only ping success is the "
        + "monitor that watched this break for 13 days",
    );
  }

  // And the orchestrator has to actually compute the verdict, not just export the ability to.
  {
    const source = readFileSync(
      new URL("../src/lib/notifications/scheduled-processing.ts", import.meta.url),
      "utf8",
    );
    assert.equal(
      source.includes("assessDrainHealth"),
      true,
      "the orchestrator must assess drain health on every run",
    );
    assert.equal(
      source.includes("drain_stranded"),
      true,
      "a stranded drain must also write an ERROR log, so it reaches the Error Monitor and not only "
        + "the external dead-man's switch",
    );
    // The bare word alone would also match the import line — require the CALL, same discipline the
    // withDeadMansSwitch check above uses for the opposite reason.
    assert.equal(
      source.includes("notifyDrainStranded(drainHealth)"),
      true,
      "a stranded drain must also page a human in-app + Telegram — the ERROR log and the Healthchecks "
        + "ping both require someone to already be watching a dashboard or an inbox; this is the alert "
        + "that reaches a phone",
    );
  }

  // The Telegram/in-app message has to say what is wrong without anyone opening a database, same bar
  // as describeDrainHealth's own text.
  {
    const message = buildDrainStrandedMessage(assessDrainHealth([reading("telegram", 0, 25)]));
    assert.equal(message.includes("telegram"), true, "the alert names the stranded queue");
    assert.equal(message.includes("25"), true, "the alert carries the stranded count");
    assert.equal(
      message.includes("not going out"),
      true,
      "the alert says plainly that queued work is not being delivered, not just that a check failed",
    );
  }

  // A healthy verdict must never build an alert-worthy message from notifyDrainStranded's own
  // caller — the healthy branch is guarded before buildDrainStrandedMessage is ever reached, so this
  // pins the guard's existence rather than the message itself.
  {
    const source = readFileSync(
      new URL("../src/lib/notifications/drain-health-alert.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("export async function notifyDrainStranded");
    assert.notEqual(start, -1, "notifyDrainStranded must still exist and be exported");
    const body = source.slice(start);
    assert.equal(
      /if\s*\(\s*verdict\.healthy\s*\)\s*return/.test(body),
      true,
      "a healthy verdict must short-circuit before resolving recipients or sending anything — "
        + "alerting on every healthy tick would page someone every 5 minutes forever",
    );
  }
}
