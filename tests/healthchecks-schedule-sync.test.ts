import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseDesiredChecks, parseDuration, diffCheck, payload } from "../scripts/healthchecks-sync.mjs";

/**
 * `scripts/healthchecks-sync.mjs` treats the table in docs/observability.md as the source of truth
 * for every Healthchecks schedule. Two things make that fragile enough to pin.
 *
 * First, the table's shape has already changed once (a "What actually pings it" column was added,
 * and a Simple-period row appeared alongside the cron ones). A parser that quietly matches nothing
 * turns the sync into a no-op that prints a cheerful summary and changes nothing — the exact
 * failure mode this observability layer exists to catch, reproduced in the tool meant to fix it.
 *
 * Second, the timezone. Every schedule in that table is Africa/Cairo, because cron-job.org fires
 * them in Africa/Cairo. A check left on UTC has its expected-ping window two to three hours off the
 * real one and drifts again at every Egyptian DST change — so it goes red against a job that is
 * running perfectly, and people learn to ignore the dashboard.
 */

const DOC = "docs/observability.md";

type DesiredCheck = {
  slug: string;
  kind: string;
  schedule?: string;
  tz?: string;
  timeout?: number;
  grace: number;
};

export async function runHealthchecksScheduleSyncTests() {
  const checks = parseDesiredChecks(readFileSync(DOC, "utf8")) as DesiredCheck[];

  assert.ok(
    checks.length >= 14,
    `${DOC} must yield at least the 14 known checks, got ${checks.length} — the table format ` +
      "probably changed and the sync would silently do nothing",
  );

  const bySlug = new Map(checks.map((c) => [c.slug, c] as const));

  // The two Direct Orders clocks: the reason this script was written. Their live cron-job.org jobs
  // fire at 02:17 and 02:27 Africa/Cairo, staggered so the sweeps never overlap.
  assert.deepEqual(bySlug.get("phoenix-direct-orders-expire-held"), {
    slug: "phoenix-direct-orders-expire-held",
    kind: "cron",
    schedule: "17 2 * * *",
    tz: "Africa/Cairo",
    grace: 7200,
  });
  assert.deepEqual(bySlug.get("phoenix-direct-orders-probation"), {
    slug: "phoenix-direct-orders-probation",
    kind: "cron",
    schedule: "27 2 * * *",
    tz: "Africa/Cairo",
    grace: 7200,
  });

  // No cron check may be left on UTC, and every one needs a real 5-field expression.
  for (const c of checks) {
    assert.ok(c.grace > 0, `${c.slug} must declare a positive grace`);
    if (c.kind === "cron") {
      assert.equal(
        c.tz,
        "Africa/Cairo",
        `${c.slug} must be Africa/Cairo — a UTC check alerts on a perfectly healthy job`,
      );
      assert.equal(
        (c.schedule ?? "").trim().split(/\s+/).length,
        5,
        `${c.slug} must have a 5-field cron expression, got "${c.schedule}"`,
      );
    } else {
      assert.ok((c.timeout ?? 0) > 0, `${c.slug} is a Simple check and must declare a period`);
    }
  }

  // Grace/period parsing: an "h" silently read as minutes would set a 2-minute grace on a daily job.
  assert.equal(parseDuration("10m"), 600);
  assert.equal(parseDuration("2h"), 7200);
  assert.equal(parseDuration("12h"), 43200);
  assert.equal(parseDuration("nonsense"), null);

  // diffCheck is what decides whether anything is written. Prove it actually sees each drift,
  // rather than returning "ok" for everything and making the sync a very confident no-op.
  const want = { slug: "x", kind: "cron", schedule: "17 2 * * *", tz: "Africa/Cairo", grace: 7200 };
  assert.equal(diffCheck(want, { schedule: "17 2 * * *", tz: "Africa/Cairo", grace: 7200 }).action, "ok");
  assert.equal(diffCheck(want, undefined).action, "create");
  assert.equal(
    diffCheck(want, { schedule: "17 2 * * *", tz: "UTC", grace: 7200 }).action,
    "update",
    "a check sitting on UTC must be reported as drift — that is the whole point",
  );
  assert.equal(
    diffCheck(want, { schedule: "17 2 * * *", tz: "Africa/Cairo", grace: 3600 }).action,
    "update",
    "a wrong grace must be reported — auto-provisioned checks default to 1 hour",
  );
  // The default an auto-provisioned check is born with: a 1-day period, no cron at all.
  assert.equal(
    diffCheck(want, { schedule: null, timeout: 86400, tz: "UTC", grace: 3600 }).action,
    "update",
    "a freshly auto-provisioned check must be reported as needing its real schedule",
  );

  // Every write MUST carry an explicit slug. The API stores an empty slug otherwise, and the app
  // pings by slug — so a check created without one never receives the ping it exists to wait for,
  // goes red against a healthy job, and a duplicate gets created beside it by the next real ping.
  // That happened on the very first live run; the read-back inside the script is what caught it.
  const cronBody: Record<string, unknown> = payload({
    slug: "phoenix-x",
    kind: "cron",
    schedule: "17 2 * * *",
    tz: "Africa/Cairo",
    grace: 7200,
  });
  assert.equal(cronBody.slug, "phoenix-x", "a cron check must be created with its slug");
  assert.equal(cronBody.name, "phoenix-x");
  assert.equal(cronBody.schedule, "17 2 * * *");
  assert.equal(cronBody.tz, "Africa/Cairo");

  const simpleBody: Record<string, unknown> = payload({
    slug: "phoenix-y",
    kind: "simple",
    timeout: 300,
    grace: 900,
  });
  assert.equal(simpleBody.slug, "phoenix-y", "a period check must be created with its slug too");
  assert.equal(simpleBody.timeout, 300);
  assert.equal(simpleBody.schedule, undefined, "a period check must not carry a cron expression");

  // Channels: every check must carry every channel the project has configured. Found 2026-08-27 —
  // two checks had sat with zero channels since creation, silently, because nothing ever compared
  // or wrote this field. Omitting the third argument must not silently mean "wipe the channels" —
  // it must mean "don't touch them", or a caller with no channel data would strip every check bare.
  assert.equal(
    diffCheck(want, { schedule: "17 2 * * *", tz: "Africa/Cairo", grace: 7200, channels: "a,b" }).action,
    "ok",
    "omitting desiredChannels must not compare channels at all",
  );
  assert.equal(
    diffCheck(want, { schedule: "17 2 * * *", tz: "Africa/Cairo", grace: 7200, channels: "" }, "a,b").action,
    "update",
    "a check with zero channels must be reported as drift when the project has channels to give it",
  );
  assert.equal(
    diffCheck(want, { schedule: "17 2 * * *", tz: "Africa/Cairo", grace: 7200, channels: "b,a" }, "a,b").action,
    "ok",
    "channel order must not matter — the API returns them in whatever order it feels like",
  );
  assert.equal(
    diffCheck(want, { schedule: "17 2 * * *", tz: "Africa/Cairo", grace: 7200, channels: "a" }, "a,b").action,
    "update",
    "a check missing one of the project's channels must be reported as drift",
  );

  const channelBody: Record<string, unknown> = payload(
    { slug: "phoenix-z", kind: "cron", schedule: "0 4 * * *", tz: "Africa/Cairo", grace: 3600 },
    "chan-1,chan-2",
  );
  assert.equal(channelBody.channels, "chan-1,chan-2", "channels must be sent on write when provided");
  const bodyWithoutChannels: Record<string, unknown> = payload({
    slug: "phoenix-z",
    kind: "cron",
    schedule: "0 4 * * *",
    tz: "Africa/Cairo",
    grace: 3600,
  });
  assert.equal(
    "channels" in bodyWithoutChannels,
    false,
    "omitting desiredChannels must omit the field entirely, not send channels: undefined",
  );

  // A slug listed twice would let one row silently win.
  assert.throws(
    () =>
      parseDesiredChecks(
        "| `phoenix-dupe` | `1 2 * * *` | 1h | a |\n| `phoenix-dupe` | `3 4 * * *` | 2h | b |\n",
      ),
    /appears twice/,
    "a duplicated slug must fail loudly rather than pick one row",
  );
}
