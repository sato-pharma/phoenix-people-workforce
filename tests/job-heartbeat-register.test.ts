import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseDesiredChecks } from "../scripts/healthchecks-sync.mjs";
import {
  assessJobHeartbeats,
  previousScheduledFire,
  type JobHeartbeatRow,
} from "@/lib/observability/job-heartbeat-assess";
import { JOB_SCHEDULES, type JobScheduleDeclaration } from "@/lib/observability/job-schedule";

/**
 * The in-house dead-man's switch (`public.job_heartbeats`).
 *
 * NOTHING HERE TOUCHES A DATABASE. `job-heartbeat-assess.ts` and `job-schedule.ts` are pure by
 * design precisely so this file can import them; the IO lives in `job-heartbeat.ts`, which is
 * deliberately NOT imported here — doing so would pull `@/lib/supabase/server` into a unit test.
 *
 * Two things are pinned, and they fail for different reasons:
 *
 *   1. The TS declarations and the docs/observability.md table agree. They are separate copies on
 *      purpose — a Next standalone build traces imported files and does not copy `docs/`, so the
 *      markdown cannot be the runtime source — and this is what keeps them one truth.
 *   2. The verdict logic itself, especially the windowed-schedule case that any interval-based
 *      staleness rule gets wrong.
 */

const DOC = "docs/observability.md";

type ParsedCheck = {
  slug: string;
  kind: string;
  schedule?: string;
  tz?: string;
  timeout?: number;
  grace: number;
};

/** A row that has just reported success, for tests that only care about one field. */
function row(overrides: Partial<JobHeartbeatRow> & { slug: string }): JobHeartbeatRow {
  return {
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastDetail: null,
    lastFailAt: null,
    lastOutcome: "success",
    lastSuccessAt: null,
    ...overrides,
  };
}

const DAILY_0636: JobScheduleDeclaration = {
  graceSeconds: 3600,
  kind: "cron",
  schedule: "36 6 * * *",
  slug: "phoenix-notify-daily",
};

/** Twelve ticks inside hour 5 Cairo, then 23 hours of deliberate silence. */
const WINDOWED: JobScheduleDeclaration = {
  graceSeconds: 600,
  kind: "cron",
  schedule: "*/5 5 * * *",
  slug: "phoenix-crm-contact-lists",
};

export async function runJobHeartbeatRegisterTests() {
  // ---------------------------------------------------------------------------
  // 1. The declarations and the doc table are the same list.
  // ---------------------------------------------------------------------------
  const parsed = parseDesiredChecks(readFileSync(DOC, "utf8")) as ParsedCheck[];
  const docBySlug = new Map(parsed.map((check) => [check.slug, check] as const));
  const codeBySlug = new Map(JOB_SCHEDULES.map((declaration) => [declaration.slug, declaration] as const));

  assert.deepEqual(
    [...codeBySlug.keys()].sort(),
    [...docBySlug.keys()].sort(),
    `JOB_SCHEDULES and the ${DOC} table must declare exactly the same slugs — a job declared in ` +
      "only one of them is either unwatched at runtime or absent from the Healthchecks sync",
  );

  for (const [slug, declaration] of codeBySlug) {
    const doc = docBySlug.get(slug);
    assert.ok(doc, `${slug} is missing from ${DOC}`);
    assert.equal(declaration.kind, doc.kind, `${slug}: kind disagrees between code and ${DOC}`);
    assert.equal(
      declaration.graceSeconds,
      doc.grace,
      `${slug}: grace disagrees between code (${declaration.graceSeconds}s) and ${DOC} (${doc.grace}s)`,
    );
    if (declaration.kind === "cron") {
      assert.equal(declaration.schedule, doc.schedule, `${slug}: cron expression disagrees with ${DOC}`);
    } else {
      assert.equal(declaration.periodSeconds, doc.timeout, `${slug}: period disagrees with ${DOC}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Cron evaluation is Africa/Cairo, not UTC.
  // ---------------------------------------------------------------------------
  // 06:36 Cairo on 2026-08-30 is 03:36Z (UTC+3 — Egypt observes DST in August). Read as UTC this
  // would answer 06:36Z, putting every expected-fire window three hours out.
  const cairoFire = previousScheduledFire("36 6 * * *", new Date("2026-08-30T09:00:00.000Z"));
  assert.equal(
    cairoFire?.toISOString(),
    "2026-08-30T03:36:00.000Z",
    "the previous fire must be computed in Africa/Cairo — a UTC reading alerts on a healthy job",
  );

  // ---------------------------------------------------------------------------
  // 3. A daily job: covered, then stranded.
  // ---------------------------------------------------------------------------
  const noon = new Date("2026-08-30T09:00:00.000Z"); // 12:00 Cairo, well past 06:36 + 1h grace

  const healthy = assessJobHeartbeats({
    declarations: [DAILY_0636],
    now: noon,
    rows: [row({ lastSuccessAt: "2026-08-30T03:37:00.000Z", slug: DAILY_0636.slug })],
  });
  assert.equal(healthy.healthy, true, "a daily job that reported after its last fire is healthy");
  assert.equal(healthy.checked, 1);

  const stranded = assessJobHeartbeats({
    declarations: [DAILY_0636],
    now: noon,
    rows: [row({ lastSuccessAt: "2026-08-29T03:37:00.000Z", slug: DAILY_0636.slug })],
  });
  assert.equal(stranded.healthy, false);
  assert.deepEqual(
    stranded.stranded.map((problem) => problem.slug),
    [DAILY_0636.slug],
    "a daily job that missed today's fire past its grace is stranded",
  );

  // ---------------------------------------------------------------------------
  // 4. THE HEADLINE CASE: a windowed schedule is not stranded during its silent hours.
  // ---------------------------------------------------------------------------
  // `*/5 5 * * *` last fired at 05:55 Cairo (02:55Z) and will not fire again until 05:00 tomorrow.
  // At 20:00 Cairo it has been quiet for fourteen hours, which is CORRECT. Any rule based on an
  // average interval (5 minutes) reports this as stranded every single afternoon.
  const windowedQuiet = assessJobHeartbeats({
    declarations: [WINDOWED],
    now: new Date("2026-08-30T17:00:00.000Z"), // 20:00 Cairo
    rows: [row({ lastSuccessAt: "2026-08-30T02:56:00.000Z", slug: WINDOWED.slug })],
  });
  assert.equal(
    windowedQuiet.healthy,
    true,
    "a windowed job in its designed silent hours must NOT be stranded — this is the case an " +
      "interval-based staleness rule gets wrong every day",
  );

  // ...but it IS stranded if it missed the window it was due in.
  const windowedMissed = assessJobHeartbeats({
    declarations: [WINDOWED],
    now: new Date("2026-08-30T17:00:00.000Z"),
    rows: [row({ lastSuccessAt: "2026-08-29T02:56:00.000Z", slug: WINDOWED.slug })],
  });
  assert.deepEqual(
    windowedMissed.stranded.map((problem) => problem.slug),
    [WINDOWED.slug],
    "a windowed job that missed today's whole window is stranded",
  );

  // ---------------------------------------------------------------------------
  // 5. A job that has never reported does not alarm merely for being new.
  // ---------------------------------------------------------------------------
  const brandNew = assessJobHeartbeats({
    declarations: [DAILY_0636],
    now: noon,
    // Registered ten minutes ago; today's 06:36 fire happened BEFORE we started watching.
    rows: [row({ firstSeenAt: "2026-08-30T08:50:00.000Z", lastOutcome: null, slug: DAILY_0636.slug })],
  });
  assert.equal(
    brandNew.healthy,
    true,
    "a newly declared job must not alarm before a scheduled fire has passed since first_seen_at",
  );

  const neverRanForDays = assessJobHeartbeats({
    declarations: [DAILY_0636],
    now: noon,
    rows: [row({ firstSeenAt: "2026-08-27T00:00:00.000Z", lastOutcome: null, slug: DAILY_0636.slug })],
  });
  assert.deepEqual(
    neverRanForDays.stranded.map((problem) => problem.slug),
    [DAILY_0636.slug],
    "a job that has been declared for days and never reported IS stranded",
  );

  // ---------------------------------------------------------------------------
  // 6. "Ran and reported failure" — the signal the external switch only ever showed on a dashboard.
  // ---------------------------------------------------------------------------
  const failing = assessJobHeartbeats({
    declarations: [DAILY_0636],
    now: noon,
    rows: [
      row({
        lastDetail: "interlock refused the rebuild",
        lastFailAt: "2026-08-30T04:00:00.000Z",
        lastOutcome: "fail",
        lastSuccessAt: "2026-08-30T03:37:00.000Z",
        slug: DAILY_0636.slug,
      }),
    ],
  });
  assert.equal(failing.healthy, false);
  assert.deepEqual(failing.stranded, [], "a job that reported on time is not stranded");
  assert.deepEqual(
    failing.failing.map((problem) => problem.slug),
    [DAILY_0636.slug],
    "a job whose most recent report was a failure is reported as failing",
  );
  assert.ok(
    failing.failing[0].detail.includes("interlock refused the rebuild"),
    "the failure detail must reach the alert body — it is the only diagnostic a reader gets",
  );

  // Stranded beats failing: silence is the more serious signal, and listing a job under both
  // headings makes the alert harder to read rather than more informative.
  const both = assessJobHeartbeats({
    declarations: [DAILY_0636],
    now: noon,
    rows: [
      row({
        lastFailAt: "2026-08-30T04:00:00.000Z",
        lastOutcome: "fail",
        lastSuccessAt: "2026-08-28T03:37:00.000Z",
        slug: DAILY_0636.slug,
      }),
    ],
  });
  assert.deepEqual(both.stranded.map((problem) => problem.slug), [DAILY_0636.slug]);
  assert.deepEqual(both.failing, [], "a stranded job must not also be listed as failing");

  // ---------------------------------------------------------------------------
  // 7. Period ("Simple") checks.
  // ---------------------------------------------------------------------------
  const poll: JobScheduleDeclaration = {
    graceSeconds: 900,
    kind: "simple",
    periodSeconds: 300,
    slug: "phoenix-ireports360-live-poll",
  };
  const pollNow = new Date("2026-08-30T12:00:00.000Z");
  assert.equal(
    assessJobHeartbeats({
      declarations: [poll],
      now: pollNow,
      rows: [row({ lastSuccessAt: "2026-08-30T11:50:00.000Z", slug: poll.slug })],
    }).healthy,
    true,
    "a period check inside period + grace is healthy",
  );
  assert.deepEqual(
    assessJobHeartbeats({
      declarations: [poll],
      now: pollNow,
      rows: [row({ lastSuccessAt: "2026-08-30T11:30:00.000Z", slug: poll.slug })],
    }).stranded.map((problem) => problem.slug),
    [poll.slug],
    "a period check past period + grace is stranded",
  );

  // ---------------------------------------------------------------------------
  // 8. A declaration nobody can evaluate is reported, never silently skipped.
  // ---------------------------------------------------------------------------
  const broken = assessJobHeartbeats({
    declarations: [{ graceSeconds: 600, kind: "cron", schedule: "not a cron expression", slug: "phoenix-broken" }],
    now: noon,
    rows: [row({ lastSuccessAt: "2026-08-30T08:00:00.000Z", slug: "phoenix-broken" })],
  });
  assert.equal(broken.healthy, false);
  assert.deepEqual(
    broken.misdeclared.map((problem) => problem.slug),
    ["phoenix-broken"],
    "an unparseable schedule means nothing is watching that job, so it must be surfaced",
  );

  // ---------------------------------------------------------------------------
  // 9. A declared job with no row yet is awaiting bootstrap, not an alert.
  // ---------------------------------------------------------------------------
  const noRow = assessJobHeartbeats({ declarations: [DAILY_0636], now: noon, rows: [] });
  assert.equal(noRow.healthy, true, "a slug with no row yet must not page anyone");
  assert.deepEqual(noRow.awaitingBootstrap, [DAILY_0636.slug]);
  assert.equal(noRow.checked, 0);

  // ---------------------------------------------------------------------------
  // 10. The write gate that keeps this suite out of the production register.
  // ---------------------------------------------------------------------------
  // `pnpm run test` loads `.env.local`, which holds PRODUCTION Supabase credentials, and
  // `dead-mans-switch.test.ts` sets APP_ENV=production on purpose — so during this very run
  // `isProductionRuntime()` is true while live credentials are in memory. The only thing stopping
  // `recordJobHeartbeat` from stamping fabricated successes onto real job slugs is the pair of
  // flag checks below. That would make stopped jobs look alive: the exact failure this register
  // exists to catch, manufactured by the tool meant to catch it.
  //
  // Pinned by SOURCE, not by calling it: importing `job-heartbeat.ts` would pull
  // `@/lib/supabase/server` into a unit test, and a behavioural check cannot help here anyway —
  // if the gate were gone, the damage would already be done by the time this assertion ran.
  const gateSource = readFileSync("src/lib/observability/job-heartbeat.ts", "utf8");
  assert.match(
    gateSource,
    /if \(process\.env\.PHOENIX_TEST_SUITE === "1"\) return false;/,
    "the PHOENIX_TEST_SUITE gate is missing from job-heartbeat.ts — the test suite would write " +
      "fabricated job successes into the PRODUCTION monitoring register",
  );
  assert.match(
    gateSource,
    /if \(process\.env\.NODE_ENV === "test"\) return false;/,
    "the NODE_ENV gate is missing from job-heartbeat.ts",
  );
}
