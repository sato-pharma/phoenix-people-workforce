import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { parseDesiredChecks } from "../scripts/healthchecks-sync.mjs";
import {
  assessJobHeartbeats,
  previousScheduledFire,
  type JobHeartbeatRow,
} from "@/lib/observability/job-heartbeat-assess";
import { HEALTHCHECKS_CHECKED_SLUGS, JOB_SCHEDULES, type JobScheduleDeclaration } from "@/lib/observability/job-schedule";
import { decideJobRefires, JOB_REFIRE_POLICIES, refireStrandedJobs } from "@/lib/observability/job-refire";

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
  externalSync: boolean;
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
  slug: "phoenix-windowed-example",
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

  // The jobs that ping Healthchecks at runtime are exactly the rows the sync gives a check: a row the
  // sync creates but nothing pings goes red for ever, and a job that pings with no row behind it is
  // refused on every run - the expected noise that hid a dead account for three days in Nov 2026.
  assert.deepEqual(
    [...HEALTHCHECKS_CHECKED_SLUGS].sort(),
    parsed.filter((check) => check.externalSync).map((check) => check.slug).sort(),
    `HEALTHCHECKS_CHECKED_SLUGS must equal the ${DOC} rows that are not marked in-house only`,
  );
  for (const slug of HEALTHCHECKS_CHECKED_SLUGS) {
    assert.ok(codeBySlug.has(slug), `${slug} pings Healthchecks but is not declared in JOB_SCHEDULES`);
  }
  assert.ok(HEALTHCHECKS_CHECKED_SLUGS.size <= 20, "the Healthchecks account holds 20 checks - a 21st would be refused");

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
  // 5b. A RESTORED declaration is judged from the restore, not from the original one.
  // ---------------------------------------------------------------------------
  // The incident this pins (phoenix-crm-daily-digest, 2026-09-27/28): the heartbeat row outlives a
  // stand-down, so its first_seen_at still pointed at the ORIGINAL declaration days earlier. On the
  // restore the sweep judged the job against a fire that had no cron job behind it — never reported,
  // so STRANDED, alarming every Super Admin every 15 minutes about a job scheduled perfectly well.
  const restored: JobScheduleDeclaration = { ...DAILY_0636, watchingSince: "2026-08-30T08:50:00.000Z" };
  const restoredQuiet = assessJobHeartbeats({
    declarations: [restored],
    now: noon,
    // The row is ancient — the very row that stranded just above — but watching resumed at 08:50.
    rows: [row({ firstSeenAt: "2026-08-27T00:00:00.000Z", lastOutcome: null, slug: restored.slug })],
  });
  assert.equal(
    restoredQuiet.healthy,
    true,
    "a restored job must be judged from watchingSince, not from a first_seen_at that predates the stand-down",
  );

  // 🔴 AND THE ALARM MUST STILL BITE. The floor moves the baseline ONCE; the next fire after it
  // counts, or a restored job could never strand again and its silence would stop meaning anything.
  const restoredThenMissed = assessJobHeartbeats({
    declarations: [restored],
    now: new Date("2026-08-31T09:00:00.000Z"), // the day AFTER the restore, past 06:36 + 1h grace
    rows: [row({ firstSeenAt: "2026-08-27T00:00:00.000Z", lastOutcome: null, slug: restored.slug })],
  });
  assert.deepEqual(
    restoredThenMissed.stranded.map((problem) => problem.slug),
    [restored.slug],
    "once a fire passes AFTER watchingSince with no success, the restored job is stranded as normal",
  );

  // A floor nobody can read, or one in the future, would leave hadAChanceToRun false for ever — so it
  // is reported rather than obeyed. Silently ignoring either would blind the sweep for that job.
  for (const bad of ["not a date", "2099-01-01T00:00:00.000Z"]) {
    const verdict = assessJobHeartbeats({
      declarations: [{ ...DAILY_0636, watchingSince: bad }],
      now: noon,
      rows: [row({ firstSeenAt: "2026-08-27T00:00:00.000Z", lastOutcome: null, slug: DAILY_0636.slug })],
    });
    assert.deepEqual(
      verdict.misdeclared.map((problem) => problem.slug),
      [DAILY_0636.slug],
      `watchingSince "${bad}" must be reported as misdeclared, never obeyed`,
    );
    assert.equal(verdict.stranded.length, 0, `a misdeclared job is named once, not twice (${bad})`);
  }

  // The live declaration carries the restore instant, and it must stay a real past date.
  const digest = JOB_SCHEDULES.find((declaration) => declaration.slug === "phoenix-crm-daily-digest");
  assert.ok(digest, "phoenix-crm-daily-digest must stay declared — the owner asked for it back on 2026-09-28");
  assert.ok(
    digest?.watchingSince && Number.isFinite(Date.parse(digest.watchingSince)) && Date.parse(digest.watchingSince) < Date.now(),
    "the restored digest must carry a parseable, past watchingSince, or its stand-down window alarms again",
  );

  // The System Audit sweep: 04:57 Cairo, seventeen minutes after the integrity checks it follows,
  // with two hours of grace — a sweep that sat a night out after a database restart still reports.
  const sweep = JOB_SCHEDULES.find((declaration) => declaration.slug === "phoenix-system-audit-sweep");
  assert.ok(sweep, "phoenix-system-audit-sweep must be declared, or a sweep that stops firing is never noticed");
  assert.equal(sweep?.kind, "cron");
  assert.equal(sweep?.schedule, "57 4 * * *", "the sweep fires at 04:57 Cairo, after the 04:40 integrity checks");
  assert.equal(sweep?.graceSeconds, 2 * 60 * 60, "two hours of grace before a missed sweep is called stranded");

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

  // A GRACE AT OR ABOVE THE GAP BETWEEN FIRES (owner, 2026-11-03). Measuring only from the latest
  // fire, the next fire always arrived before the deadline, so these jobs could never strand.
  const HOURLY_GRACE_ONE_HOUR: JobScheduleDeclaration = {
    graceSeconds: 3600,
    kind: "cron",
    schedule: "5 * * * *",
    slug: "phoenix-recovery-snapshot",
  };
  const EVERY_FIVE_GRACE_THIRTY: JobScheduleDeclaration = {
    graceSeconds: 1800,
    kind: "cron",
    schedule: "*/5 * * * *",
    slug: "phoenix-crm-rep-entry-days-reconcile",
  };
  const silentForHours = assessJobHeartbeats({
    declarations: [HOURLY_GRACE_ONE_HOUR],
    now: new Date("2026-08-30T12:30:00.000Z"),
    rows: [row({ lastSuccessAt: "2026-08-30T09:05:30.000Z", slug: HOURLY_GRACE_ONE_HOUR.slug })],
  });
  assert.deepEqual(
    silentForHours.stranded.map((problem) => problem.slug),
    [HOURLY_GRACE_ONE_HOUR.slug],
    "an hourly job with an hour of grace, silent for over three hours, is stranded",
  );
  assert.equal(
    silentForHours.stranded[0]?.overdueSince,
    "2026-08-30T11:05:00.000Z",
    "it is overdue from the OLDEST fire nothing answered, plus its grace",
  );
  assert.equal(
    assessJobHeartbeats({
      declarations: [HOURLY_GRACE_ONE_HOUR],
      now: new Date("2026-08-30T10:50:00.000Z"),
      rows: [row({ lastSuccessAt: "2026-08-30T09:05:30.000Z", slug: HOURLY_GRACE_ONE_HOUR.slug })],
    }).healthy,
    true,
    "one fire unanswered and still inside its grace is healthy",
  );
  // A job that keeps reporting failures is not silent, and its error must reach the alert.
  const failingEveryRun = assessJobHeartbeats({
    declarations: [HOURLY_GRACE_ONE_HOUR],
    now: new Date("2026-08-30T12:30:00.000Z"),
    rows: [
      row({
        lastDetail: "interlock refused the rebuild",
        lastFailAt: "2026-08-30T12:05:30.000Z",
        lastOutcome: "fail",
        lastSuccessAt: "2026-08-30T09:05:30.000Z",
        slug: HOURLY_GRACE_ONE_HOUR.slug,
      }),
    ],
  });
  assert.deepEqual(failingEveryRun.stranded, [], "a job answering with failures is not stranded");
  assert.match(failingEveryRun.failing[0]?.detail ?? "", /interlock refused the rebuild/, "and the failing report keeps its error");
  // A job whose grace is below the gap keeps the old deadline: quiet between a missed day and today's fire.
  assert.equal(
    assessJobHeartbeats({
      declarations: [{ graceSeconds: 3600, kind: "cron", schedule: "30 7 * * *", slug: "phoenix-recovery-snapshot" }],
      now: new Date("2026-08-30T04:45:00.000Z"), // 07:45 Cairo, ten minutes after today's fire, inside its grace
      rows: [row({ lastSuccessAt: "2026-08-28T04:40:00.000Z", slug: "phoenix-recovery-snapshot" })],
    }).stranded.length,
    0,
    "a daily job's overdueSince is not moved by the wider rule",
  );
  const strandedAtSweep = (now: string) =>
    assessJobHeartbeats({
      declarations: [EVERY_FIVE_GRACE_THIRTY],
      now: new Date(now),
      rows: [row({ lastSuccessAt: "2026-08-30T09:00:30.000Z", slug: EVERY_FIVE_GRACE_THIRTY.slug })],
    }).stranded[0];
  assert.equal(strandedAtSweep("2026-08-30T09:30:00.000Z"), undefined, "a five-minute job stays quiet inside its grace");
  assert.equal(
    strandedAtSweep("2026-08-30T09:45:00.000Z")?.overdueSince,
    strandedAtSweep("2026-08-30T11:45:00.000Z")?.overdueSince,
    "overdueSince does not move between sweeps, because the audit detector keys its dedupe on it",
  );
  assert.equal(
    assessJobHeartbeats({
      declarations: [EVERY_FIVE_GRACE_THIRTY],
      now: new Date("2026-08-30T09:31:00.000Z"),
      rows: [row({ lastSuccessAt: "2026-08-30T09:30:20.000Z", slug: EVERY_FIVE_GRACE_THIRTY.slug })],
    }).healthy,
    true,
    "a job answering on time is untouched",
  );
  assert.deepEqual(
    assessJobHeartbeats({
      declarations: [HOURLY_GRACE_ONE_HOUR],
      now: new Date("2026-08-30T12:30:00.000Z"),
      rows: [row({ firstSeenAt: "2026-08-30T09:00:00.000Z", lastOutcome: null, slug: HOURLY_GRACE_ONE_HOUR.slug })],
    }).stranded.map((problem) => problem.slug),
    [HOURLY_GRACE_ONE_HOUR.slug],
    "a short-gap job that has never reported is stranded too, once a fire and its grace have passed",
  );
  assert.equal(
    assessJobHeartbeats({
      declarations: [HOURLY_GRACE_ONE_HOUR],
      now: new Date("2026-08-30T09:30:00.000Z"),
      rows: [row({ firstSeenAt: "2026-08-30T09:00:00.000Z", lastOutcome: null, slug: HOURLY_GRACE_ONE_HOUR.slug })],
    }).healthy,
    true,
    "a job declared half an hour ago does not alarm for being new",
  );
  assert.equal(
    assessJobHeartbeats({
      declarations: [DAILY_0636],
      now: noon,
      rows: [row({ lastSuccessAt: "2026-08-27T03:37:00.000Z", slug: DAILY_0636.slug })],
    }).stranded[0]?.overdueSince,
    "2026-08-30T04:36:00.000Z",
    "a job whose grace is below the gap keeps today's deadline, which is what job-refire reads",
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
    slug: "phoenix-period-example",
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
  assert.deepEqual(noRow.undeclared, [], "and nothing is undeclared when there are no rows at all");

  // ---------------------------------------------------------------------------
  // 9b. The OPPOSITE case: a row whose declaration was retired.
  // ---------------------------------------------------------------------------
  // `phoenix-interview-digest` was created 26 Sep 17:39 and retired 26 Sep 22:43 — its cron-job.org
  // job was deleted first, so it never fired once, and the retiring commit removed its route, its
  // lib, its cronjob-sync block, its docs row and its JOB_SCHEDULES line. What it did NOT remove was
  // the `job_heartbeats` row, because bootstrapJobHeartbeatRows only ever inserts.
  //
  // Before this, such a row was INVISIBLE: assessJobHeartbeats iterates declarations, so it was
  // never judged, never counted in `checked`, never alerted and never cleared — a NULL
  // last_success_at sitting there for ever. It is now reported, and still not an alert, because a
  // retired job is not a broken job.
  const retiredSlugRow = {
    slug: "phoenix-interview-digest",
    firstSeenAt: "2026-09-26T14:39:00.000Z",
    lastOutcome: null,
    lastSuccessAt: null,
    lastFailAt: null,
    lastDetail: null,
  };
  const withRetired = assessJobHeartbeats({
    declarations: [DAILY_0636],
    now: noon,
    rows: [retiredSlugRow],
  });
  assert.deepEqual(
    withRetired.undeclared,
    ["phoenix-interview-digest"],
    "a row no declaration claims is reported, not skipped in silence",
  );
  assert.equal(withRetired.healthy, true, "but it does not page anyone — tidying is not an incident");
  assert.equal(withRetired.stranded.length, 0, "and it is not a strand: nothing is supposed to be pinging it");
  assert.equal(withRetired.checked, 0, "it is still not 'checked' — there is no declaration to check it against");

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

  // ── Re-firing a stranded morning job (job-refire.ts) ─────────────────────────────────────────
  // 2026-10-16: a deploy killed phoenix-notify-daily at 06:37 and the day's notifications stayed
  // half-sent. The sweep saw it from 07:36 and did nothing. The decision is pure, so it is pinned
  // here; the claim and the trigger are injected, so the "once" and "fail closed" rules are too.
  {
    const NOTIFY = "phoenix-notify-daily";
    const overdue = "2026-10-16T04:36:00.000Z"; // 07:36 Cairo
    const at = (iso: string) => new Date(iso);

    assert.ok(JOB_REFIRE_POLICIES[NOTIFY], "notify-daily is the first job with a re-fire policy");
    assert.deepEqual(
      Object.keys(JOB_REFIRE_POLICIES),
      [NOTIFY, "phoenix-reconciliation-check"],
      "a job joins this list only after its sub-jobs were read for a same-day repeat (docs/observability.md)",
    );
    // 2026-11-03: a merge at 04:40 removed the container 42 seconds into the nightly integrity checks.
    assert.deepEqual(
      decideJobRefires(
        [{ overdueSince: "2026-11-03T04:40:00.000Z", slug: "phoenix-reconciliation-check" }],
        at("2026-11-03T05:00:00.000Z"),
      ).due,
      [{ day: "2026-11-03", path: "/api/cron/reconciliation-check", slug: "phoenix-reconciliation-check" }],
      "the nightly integrity checks killed by a deploy are re-fired once the sweep sees them stranded",
    );

    const due = decideJobRefires([{ overdueSince: overdue, slug: NOTIFY }], at("2026-10-16T04:51:00.000Z"));
    assert.deepEqual(
      due.due,
      [{ day: "2026-10-16", path: "/api/notifications/daily", slug: NOTIFY }],
      "a stranded notify-daily at 07:51 Cairo on the day it was missed is due",
    );
    assert.deepEqual(
      decideJobRefires([{ overdueSince: overdue, slug: "phoenix-retention-risk-pre-payroll" }], at("2026-10-16T04:51:00.000Z")).due,
      [],
      "a stranded job with no policy is never re-fired",
    );
    assert.equal(
      decideJobRefires([{ overdueSince: overdue, slug: NOTIFY }], at("2026-10-16T10:30:00.000Z")).due.length,
      0,
      "13:30 Cairo is past the cut-off: a morning job started in the afternoon tells people stale things",
    );
    assert.equal(
      decideJobRefires([{ overdueSince: "2026-10-15T04:36:00.000Z", slug: NOTIFY }], at("2026-10-16T04:51:00.000Z")).due.length,
      0,
      "yesterday's missed run is not re-fired today",
    );
    assert.equal(
      decideJobRefires([{ overdueSince: null, slug: NOTIFY }], at("2026-10-16T04:51:00.000Z")).due.length,
      0,
      "no readable overdue time means no re-fire",
    );

    const triggered: string[] = [];
    const stranded = [{ overdueSince: overdue, slug: NOTIFY }];
    const now = at("2026-10-16T04:51:00.000Z");
    const claimed: string[] = [];
    const first = await refireStrandedJobs(
      stranded,
      { claim: async (key) => { claimed.push(key); return true; }, trigger: (path) => { triggered.push(path); } },
      now,
    );
    assert.deepEqual(first.results, [{ outcome: "started", slug: NOTIFY }]);
    assert.deepEqual(triggered, ["/api/notifications/daily"], "the route is started exactly once");
    assert.deepEqual(claimed, [`${NOTIFY}:2026-10-16`], "the claim is per job per Cairo day");

    triggered.length = 0;
    const second = await refireStrandedJobs(stranded, { claim: async () => false, trigger: (path) => { triggered.push(path); } }, now);
    assert.deepEqual(second.results, [{ outcome: "already_refired_today", slug: NOTIFY }]);
    assert.equal(triggered.length, 0, "a lost claim starts nothing - this is what stops a second sweep firing it again");

    const unclaimable = await refireStrandedJobs(
      stranded,
      { claim: async () => { throw new Error("database unreachable"); }, trigger: (path) => { triggered.push(path); } },
      now,
    );
    assert.equal(unclaimable.results[0]?.outcome, "not_started");
    assert.equal(triggered.length, 0, "if the claim cannot be made nothing is fired - it fails closed");

    const triggerFails = await refireStrandedJobs(
      stranded,
      { claim: async () => true, trigger: () => { throw new Error("could not start"); } },
      now,
    );
    assert.equal(triggerFails.results[0]?.outcome, "not_started", "a failing trigger is reported and never thrown into the sweep");

    // WIRING (comment-stripped): the sweep hands the re-fire the STRANDED list only, inside the
    // branch that already found a problem, and runs the job after the response via after().
    const sweep = stripComments(readFileSync(new URL("../app/api/cron/job-heartbeat-sweep/route.ts", import.meta.url), "utf8"));
    assert.ok(sweep.includes("refireStrandedJobs(verdict.stranded,"), "the sweep must re-fire from verdict.stranded - never from the failing list");
    assert.ok(!sweep.includes("refireStrandedJobs(verdict.failing"), "a job that ran and reported failure is never re-fired");
    assert.ok(
      sweep.indexOf("refireStrandedJobs(verdict.stranded") > sweep.indexOf("notifyJobsStranded(verdict)"),
      "the re-fire sits after the alert, in the branch that found a problem, so a healthy sweep can never start anything",
    );
    assert.ok(
      sweep.includes("after(async () => {") && sweep.indexOf("fireCronRouteOnLoopback(path)") > sweep.indexOf("after(async () => {"),
      "the run is handed to after() so the 60s sweep does not wait for it",
    );
    // The stranded finding is a WARNING: logError persists to app_error_events, and a job that stays
    // stranded wrote that row 96 times a day (955 of the week's 1,401), burying every browser error.
    assert.ok(
      sweep.includes('logWarning("Job heartbeat sweep found jobs that have stopped reporting"'),
      "the stranded finding is logged as a warning so it never lands in the System Issues error table",
    );
    assert.ok(
      !sweep.includes('logError("Job heartbeat sweep found jobs that have stopped reporting"'),
      "logError would write the same app_error_events row every 15 minutes for as long as a job stays stranded",
    );
    const refireSource = stripComments(readFileSync(new URL("../src/lib/observability/job-refire.ts", import.meta.url), "utf8"));
    assert.ok(refireSource.includes("if (!isProductionRuntime())"), "the loopback fire is production only");
    assert.ok(refireSource.includes("process.env.CRON_SECRET"), "and needs the shared cron secret, like any cron caller");
  }
}
