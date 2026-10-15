import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  applyExitCode,
  diffCheck,
  parseDesiredChecks,
  parseDuration,
  payload,
  selectSyncTargets,
  verifyAfterApply,
} from "../scripts/healthchecks-sync.mjs";

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
  externalSync: boolean;
};

export async function runHealthchecksScheduleSyncTests() {
  const checks = parseDesiredChecks(readFileSync(DOC, "utf8")) as DesiredCheck[];

  assert.ok(
    checks.length >= 40,
    `${DOC} must yield at least the 40 known checks, got ${checks.length} — the table format ` +
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
    externalSync: true,
  });
  assert.deepEqual(bySlug.get("phoenix-direct-orders-probation"), {
    slug: "phoenix-direct-orders-probation",
    kind: "cron",
    schedule: "27 2 * * *",
    tz: "Africa/Cairo",
    grace: 7200,
    externalSync: true,
  });

  // IN-HOUSE ONLY. The project has a check ceiling and the plan is not being raised, so the marker
  // withholds the CREATE: a sync that asked for one of these would report CREATE ... FAILED
  // (HTTP 403) forever. It must withhold that without hiding the ROW — job-heartbeat-register.test.ts
  // asserts this table and JOB_SCHEDULES declare exactly the same slugs, so a parser that dropped
  // them would turn that check red. What the marker must NOT withhold is tuning an existing check:
  // see the selectSyncTargets block below.
  for (const slug of ["phoenix-retention-risk-sweep", "phoenix-retention-risk-pre-payroll"]) {
    const check = bySlug.get(slug);
    assert.ok(check, `${slug} must still be PARSED out of ${DOC}, not dropped`);
    assert.equal(check.externalSync, false, `${slug} must be marked in-house only in ${DOC}`);
  }

  // The negative control. Without it, a marker regex that matched every row would pass the two
  // assertions above while silently switching the whole project off.
  assert.equal(
    bySlug.get("phoenix-notify-daily")?.externalSync,
    true,
    "a row carrying no marker must still be pushed to Healthchecks",
  );
  assert.ok(
    checks.filter((c) => !c.externalSync).length < checks.length,
    "the in-house-only marker must not match every row",
  );

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

  // 🔴 THE MARKER WITHHOLDS THE CREATE, NOT THE TUNING. Until 2026-10-15 it withheld the whole
  // write, and because these jobs ping with ?create=1 Healthchecks had auto-provisioned a check for
  // nearly all of them anyway — each on its own defaults (1-day period, 1-hour grace) — which this
  // script then refused to look at. 13 of the project's 40 live checks were wrong while a dry run
  // printed "Everything already matches": one monthly job had been red for 20 days, two weekly jobs
  // were red six days in seven, and an hourly and a 10-minute job were judged once a DAY.
  {
    const declared = [
      { slug: "pushed", kind: "cron", schedule: "1 2 * * *", tz: "Africa/Cairo", grace: 3600, externalSync: true },
      { slug: "marked-and-present", kind: "cron", schedule: "3 4 * * *", tz: "Africa/Cairo", grace: 3600, externalSync: false },
      { slug: "marked-and-absent", kind: "cron", schedule: "5 6 * * *", tz: "Africa/Cairo", grace: 3600, externalSync: false },
    ];
    const live = new Map([
      ["pushed", { slug: "pushed", uuid: "u1" }],
      ["marked-and-present", { slug: "marked-and-present", uuid: "u2" }],
    ]);
    const { syncable, tuneInPlace, withheld } = selectSyncTargets(declared, live);
    assert.deepEqual(
      syncable.map((d: { slug: string }) => d.slug),
      ["pushed", "marked-and-present"],
      "a marked row whose check EXISTS must be written — an update costs no slot, and skipping it is " +
        "what left 13 checks on the Healthchecks defaults for weeks",
    );
    assert.deepEqual(
      tuneInPlace.map((d: { slug: string }) => d.slug),
      ["marked-and-present"],
      "the tuned-in-place half must be named, not folded silently into the pushed rows",
    );
    assert.deepEqual(
      withheld.map((d: { slug: string }) => d.slug),
      ["marked-and-absent"],
      "a marked row with NO check is the one real coverage gap and must be reported by name, never dropped",
    );
    assert.ok(
      !syncable.some((d: { slug: string }) => d.slug === "marked-and-absent"),
      "a marked row with no check must never be sent as a create — that is the HTTP 403 the marker exists to avoid",
    );
  }

  // An existing check is written BY UUID, where `unique` means nothing. On a create it must stay,
  // or a re-run makes a second check beside the one it made last time.
  {
    const desiredOne = { slug: "phoenix-x", kind: "cron", schedule: "17 2 * * *", tz: "Africa/Cairo", grace: 7200 };
    const createBody: Record<string, unknown> = payload(desiredOne, undefined, { update: false });
    assert.deepEqual(createBody.unique, ["name"], "a create must carry unique:[name]");
    const updateBody: Record<string, unknown> = payload(desiredOne, undefined, { update: true });
    assert.equal("unique" in updateBody, false, "an update by uuid must not send unique at all");
    assert.equal(updateBody.slug, "phoenix-x", "an update must still carry the slug the app pings");
    assert.equal(updateBody.schedule, "17 2 * * *");
    // Annotated like the two above: `payload` is plain .mjs, so its inferred return is a union of
    // the cron and period shapes and neither declares the conditional `unique` — reading it off the
    // call directly is TS2339, which the suite cannot see (node --experimental-strip-types deletes
    // types without checking them) and `checks/Typecheck` catches after the push.
    const defaultBody: Record<string, unknown> = payload(desiredOne);
    assert.deepEqual(
      defaultBody.unique,
      ["name"],
      "the default must stay CREATE — a caller that forgets the flag must not silently drop unique",
    );
  }

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

  // THE READ-BACK. `--apply` used to exit(1) as soon as any write failed, BEFORE re-reading the
  // project — so the one run that most needed verifying never verified anything. On 2026-09-08 a
  // real run updated six checks and hit HTTP 403 on two creates; it printed no verification at all
  // and the six good writes had to be confirmed by re-reading the API by hand.
  const desiredPair = [
    { slug: "phoenix-a", kind: "cron", schedule: "17 2 * * *", tz: "Africa/Cairo", grace: 7200 },
    { slug: "phoenix-b", kind: "cron", schedule: "27 2 * * *", tz: "Africa/Cairo", grace: 7200 },
  ];
  const storedPair = {
    checks: [
      { slug: "phoenix-a", schedule: "17 2 * * *", tz: "Africa/Cairo", grace: 7200 },
      // b never landed — still on the auto-provision default.
      { slug: "phoenix-b", schedule: "", timeout: 86400, tz: "UTC", grace: 3600 },
    ],
  };
  assert.deepEqual(
    await verifyAfterApply(desiredPair, undefined, async () => storedPair),
    ["phoenix-b"],
    "the read-back must name the check that did not stick, and only that one",
  );
  assert.deepEqual(
    await verifyAfterApply(desiredPair, undefined, async () => ({ checks: [] })),
    ["phoenix-a", "phoenix-b"],
    "a check absent from the project entirely must count as still wrong, not as fine",
  );

  // A failed write and a write that silently did not stick are the same outcome — the doc and
  // Healthchecks disagree — so both must be non-zero. `failed` alone used to decide this.
  assert.equal(applyExitCode(0, 0), 0, "a clean apply exits 0");
  assert.equal(applyExitCode(2, 0), 1, "a failed write must still exit non-zero");
  assert.equal(applyExitCode(0, 1), 1, "drift after a 200 must exit non-zero");
  assert.equal(applyExitCode(2, 1), 1);
}
