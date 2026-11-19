import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

import { jobSchedulesFor } from "../src/lib/observability/job-schedule.ts";
import { DAILY_JOBS, DAILY_JOB_PATH_PREFIX, dailyJobHeartbeatSlug } from "../src/lib/scheduled-jobs/daily-jobs.ts";
import { stripComments } from "./support/comment-strip.ts";

// EVERY SCHEDULED ROUTE RECORDS A HEARTBEAT (REC-049, F-PLT-005, 19 Nov 2026).
//
// The heartbeat register (`job_heartbeats`, swept by /api/cron/job-heartbeat-sweep) can only notice a
// job that stopped if the job reports to it. This test reads every route under app/api/cron/**, the
// two notification morning routes (the 06:36 fan-out /api/notifications/daily and the per-job
// /api/cron/daily/[job]) and every route a scheduler calls — the cron-job.org jobs in
// scripts/cronjob-sync.mjs and the GitHub workflows that call a route — and holds each to:
//
//   - it reports through withDeadMansSwitch or pingDeadMansSwitch (both write the register);
//   - every slug it reports under resolves to a name, and that name is DECLARED in the register
//     (JOB_SCHEDULES, either position of the morning-jobs switch), so the sweep judges it;
//   - or it is a route no scheduler calls, named below with the heartbeat that covers its work.
//
// It found one scheduled route that reported nothing: /api/cron/attendance-weekly-digest, called
// twice a day by .github/workflows/attendance-weekly-digest.yml. It now reports as
// phoenix-attendance-weekly-digest.

const HEARTBEAT_CALL = /(?<![\w$.])(withDeadMansSwitch|pingDeadMansSwitch)\(\s*([^,)]+)/g;

/** Routes no scheduler calls — each drives by hand a sweep whose scheduled run reports elsewhere. */
const NOT_SCHEDULED: ReadonlyArray<{ route: string; coveredBy: string; why: string }> = [
  {
    coveredBy: "phoenix-daily-marketing-assignment-backfill",
    route: "app/api/cron/marketing-assignment-backfill/route.ts",
    why: "the sweep runs every morning as its own job; this route drives it by hand without firing every other morning job (docs/observability.md)",
  },
  {
    coveredBy: "phoenix-daily-probation-milestone-emails",
    route: "app/api/cron/probation-milestones/route.ts",
    why: "the Day 30/60/75 sweep runs every morning as its own job; this route runs it on demand for a catch-up",
  },
  {
    coveredBy: "phoenix-daily-birthday",
    route: "app/api/notifications/birthdays/route.ts",
    why: "the morning job imports runBirthdayNotifications from here; the route itself is a manual trigger",
  },
  {
    coveredBy: "phoenix-daily-contract-renewals",
    route: "app/api/notifications/contract-renewals/route.ts",
    why: "the morning job imports runContractRenewalNotifications from here; the route itself is a manual trigger",
  },
  {
    coveredBy: "phoenix-daily-holiday-confirmation",
    route: "app/api/notifications/holiday-confirmation/route.ts",
    why: "the morning job imports runHolidayConfirmationReminder from here; the route itself is a manual trigger",
  },
];

/** Slugs computed at run time: the values each can take. */
const DYNAMIC_SLUGS: ReadonlyArray<{ route: string; text: string; values: readonly string[] }> = [
  { route: "app/api/cron/daily/[job]/route.ts", text: "slug", values: DAILY_JOBS.map((job) => dailyJobHeartbeatSlug(job.key)) },
  { route: "app/api/cron/code-backup-verify/route.ts", text: "slug", values: ["phoenix-code-backup-verify", "phoenix-db-backup-verify"] },
];

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === "route.ts" ? [full] : [];
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

/** `export const NAME = "phoenix-…"` anywhere in src/ — the slug constants a route may import. */
function exportedSlugConstants(): Map<string, string> {
  const index = new Map<string, string>();
  for (const file of sourceFiles("src")) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const match of code.matchAll(/export const ([A-Z][A-Z0-9_]*) = "([a-z0-9-]+)"/g)) index.set(match[1], match[2]);
  }
  return index;
}

/** The route file a scheduled path is served by. */
function routeForPath(path: string): string {
  if (path.startsWith(DAILY_JOB_PATH_PREFIX)) return "app/api/cron/daily/[job]/route.ts";
  return `app${path}/route.ts`;
}

/** Every path a scheduler calls: the cron-job.org map, its one hand-made job, and the GitHub workflows. */
function scheduledRoutes(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (path: string, by: string) => {
    const route = routeForPath(path.split("?")[0]);
    assert.ok(existsSync(route), `${by} calls ${path}, but no route serves it (${route})`);
    out.set(route, [...(out.get(route) ?? []), by]);
  };
  const sync = readFileSync("scripts/cronjob-sync.mjs", "utf8");
  const paths = Array.from(sync.matchAll(/path:\s*"([^"]+)"/g), (m) => m[1]);
  assert.ok(paths.length > 50, `read only ${paths.length} cron-job.org paths from scripts/cronjob-sync.mjs`);
  for (const path of paths) add(path, "cron-job.org");
  // The one entry made by hand and not in the map (scripts/cronjob-sync.mjs says so): the 06:36 fan-out.
  assert.match(sync, /job `8200909`, made by hand, not in this map\) calls \/api\/notifications\/daily/);
  add("/api/notifications/daily", "cron-job.org job 8200909");
  for (const workflow of readdirSync(".github/workflows").filter((name) => name.endsWith(".yml"))) {
    const text = readFileSync(`.github/workflows/${workflow}`, "utf8");
    for (const match of text.matchAll(/phoenix-hr\.satopharma\.com(\/api\/(?:cron|notifications)\/[A-Za-z0-9/_-]+)/g)) add(match[1], `.github/workflows/${workflow}`);
  }
  return out;
}

export function runScheduledRouteHeartbeatsTests() {
  const declared = new Set([...jobSchedulesFor(false), ...jobSchedulesFor(true)].map((declaration) => declaration.slug));
  const constants = exportedSlugConstants();
  const scheduled = scheduledRoutes();

  const covered = new Set([
    ...routeFiles("app/api/cron"),
    "app/api/notifications/daily/route.ts",
    "app/api/cron/daily/[job]/route.ts",
    ...scheduled.keys(),
    ...NOT_SCHEDULED.map((entry) => entry.route),
  ]);
  assert.ok(covered.size > 50, `read only ${covered.size} scheduled routes`);
  assert.ok(scheduled.has("app/api/cron/attendance-weekly-digest/route.ts"), "the GitHub-scheduled attendance digest is read as scheduled");
  assert.ok(scheduled.has("app/api/notifications/process/route.ts"), "the outbox drain is read as scheduled");

  const usedDynamic = new Set<string>();
  let reporting = 0;
  for (const route of [...covered].sort()) {
    const exempt = NOT_SCHEDULED.find((entry) => entry.route === route);
    if (exempt) {
      assert.ok(!scheduled.has(route), `${route} is listed as called by no scheduler, but ${scheduled.get(route)?.join(", ")} calls it — it must record a heartbeat`);
      assert.ok(declared.has(exempt.coveredBy), `${route}: the heartbeat said to cover its work, ${exempt.coveredBy}, is not declared`);
      continue;
    }

    const code = stripComments(readFileSync(route, "utf8"));
    const calls = Array.from(code.matchAll(HEARTBEAT_CALL));
    assert.ok(
      calls.length > 0,
      `${route} is ${scheduled.has(route) ? `called by ${scheduled.get(route)!.join(", ")}` : "a scheduled route"} and records no heartbeat — wrap its run in withDeadMansSwitch or report with pingDeadMansSwitch, and declare its slug in JOB_SCHEDULES`,
    );
    reporting += 1;
    const locals = new Map(Array.from(code.matchAll(/const ([A-Za-z_][A-Za-z0-9_]*) = "([a-z0-9-]+)"/g), (m) => [m[1], m[2]] as const));
    for (const call of calls) {
      const arg = call[2].trim();
      let slugs: readonly string[];
      const literal = arg.match(/^"([^"]+)"$/);
      if (literal) slugs = [literal[1]];
      else if (locals.has(arg)) slugs = [locals.get(arg)!];
      else if (constants.has(arg)) slugs = [constants.get(arg)!];
      else {
        const dynamic = DYNAMIC_SLUGS.find((entry) => entry.route === route && entry.text === arg);
        assert.ok(dynamic, `${route} reports under ${arg}, which this test cannot follow — list the slugs it takes in DYNAMIC_SLUGS`);
        usedDynamic.add(`${dynamic.route}::${dynamic.text}`);
        slugs = dynamic.values;
      }
      for (const slug of slugs) {
        assert.ok(declared.has(slug), `${route} reports as "${slug}", which JOB_SCHEDULES does not declare — the sweep would never judge it`);
      }
    }
  }
  assert.ok(reporting > 45, `only ${reporting} routes were checked for a heartbeat`);
  for (const dynamic of DYNAMIC_SLUGS) assert.ok(usedDynamic.has(`${dynamic.route}::${dynamic.text}`), `DYNAMIC_SLUGS names ${dynamic.route} "${dynamic.text}", which no longer reports that way — drop it`);

  // The fix itself: the attendance digest reports success on a 200 and failure on any other answer.
  const digest = stripComments(readFileSync("app/api/cron/attendance-weekly-digest/route.ts", "utf8"));
  assert.match(digest, /const HEARTBEAT_SLUG = "phoenix-attendance-weekly-digest";/);
  assert.match(digest, /await pingDeadMansSwitch\(HEARTBEAT_SLUG, response\.ok \? "success" : "fail",/, "a failed step or a thrown run reports a failure, not a success");
  assert.ok(digest.indexOf("if (denied) return denied;") < digest.indexOf("pingDeadMansSwitch("), "a refused caller reports nothing");
}
