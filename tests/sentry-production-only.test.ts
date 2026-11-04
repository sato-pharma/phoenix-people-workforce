import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  SENTRY_PAGE_SURVEY_ENDS_AT_MS,
  SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE,
  SENTRY_REPLAY_SESSION_SAMPLE_RATE,
  SENTRY_TRACES_SAMPLE_RATE,
  parseSentryDsn,
  scrubSentryEvent,
  scrubSentryLog,
  scrubSentryPath,
  scrubSentrySpan,
  scrubSentryText,
  sentryClientStatus,
  sentryServerStatus,
  sentryTracesSampler,
} from "../src/lib/observability/sentry-policy.ts";
import { isBrowserNoiseMessage } from "../src/lib/error-monitor/browser-noise.ts";
import { CROSS_ORIGIN_MASKED_DISPLAY } from "../src/lib/error-monitor/cross-origin-masked.ts";
import { isModuleLockRefusal } from "../src/lib/error-monitor/expected-refusal.ts";
import { sentryMonitorConfigFor } from "../src/lib/observability/sentry-cron-monitor.ts";
import { buildSentryAlertMessage, verifySentrySignature } from "../src/lib/observability/sentry-alert-webhook.ts";
import { createHmac } from "node:crypto";
import { JOB_SCHEDULES } from "../src/lib/observability/job-schedule.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Sentry (sentry.io) runs on PRODUCTION ONLY, and everything it sends is bounded and scrubbed.
 *
 * The gate is the deployment NAME, because a Phoenix build is NODE_ENV=production on staging, on the
 * Hetzner previews and on a laptop's `next start` alike — so "is this a production build" answers yes
 * everywhere and proves nothing. These tests hold the gate (a pure function), the scrub, and the places
 * the SDK is allowed to be named, read from the files as written.
 */

const DSN = "https://abc123publickey@o4500000000.ingest.de.sentry.io/4500000001";

function code(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

function gateTests() {
  // The server: APP_ENV must be literally production AND the DSN must be real.
  assert.deepEqual(sentryServerStatus({ appEnv: "production", dsn: DSN }), { enabled: true });
  assert.deepEqual(sentryServerStatus({ appEnv: " Production ", dsn: DSN }), { enabled: true });
  for (const appEnv of ["staging", "development", "preview", "test", "", undefined]) {
    const status = sentryServerStatus({ appEnv, dsn: DSN });
    assert.equal(status.enabled, false, `APP_ENV=${String(appEnv)} with a DSN must stay OFF — staging builds as NODE_ENV=production`);
  }
  for (const dsn of [undefined, "", "   ", "not a url", "http://key@o1.ingest.sentry.io/1", "https://o1.ingest.sentry.io/1", "https://key@o1.ingest.sentry.io/"]) {
    assert.equal(
      sentryServerStatus({ appEnv: "production", dsn }).enabled,
      false,
      `production without a valid DSN (${JSON.stringify(dsn)}) must stay OFF`,
    );
  }

  // The browser cannot read APP_ENV, so it asks the host it was served from.
  const productionHost = "phoenix-hr.satopharma.com";
  assert.deepEqual(sentryClientStatus({ dsn: DSN, hostname: productionHost, productionHost }), { enabled: true });
  assert.equal(sentryClientStatus({ dsn: DSN, hostname: "PHOENIX-HR.satopharma.com", productionHost }).enabled, true);
  for (const hostname of ["localhost", "phoenix-people-workforce-staging.up.railway.app", "evil-phoenix-hr.satopharma.com", "", undefined]) {
    assert.equal(
      sentryClientStatus({ dsn: DSN, hostname, productionHost }).enabled,
      false,
      `a browser on ${String(hostname)} must stay OFF even with a DSN baked into the bundle`,
    );
  }
  assert.equal(sentryClientStatus({ dsn: undefined, hostname: productionHost, productionHost }).enabled, false);

  assert.deepEqual(parseSentryDsn(DSN), { origin: "https://o4500000000.ingest.de.sentry.io" });
  assert.equal(parseSentryDsn(null), null);
}

function scrubTests() {
  const event = {
    user: { id: "B-10", email: "someone@satopharma.com" },
    request: {
      cookies: { phoenix_session: "secret" },
      data: { salary: 1 },
      query_string: "hr_id=B-10",
      headers: {
        Cookie: "phoenix_session=secret",
        authorization: "Bearer x",
        "x-phoenix-role": "CEO",
        "x-forwarded-for": "10.0.0.1",
        "user-agent": "kept",
        host: "kept",
      },
    },
    message: "kept",
  };
  const scrubbed = scrubSentryEvent(event);
  assert.equal(scrubbed.user, undefined, "the user must not leave");
  assert.equal(scrubbed.request?.cookies, undefined);
  assert.equal(scrubbed.request?.data, undefined, "request bodies carry payroll and HR identifiers");
  assert.equal(scrubbed.request?.query_string, undefined, "URLs here carry HR ids");
  assert.deepEqual(Object.keys(scrubbed.request?.headers ?? {}).sort(), ["host", "user-agent"]);
  assert.equal(scrubbed.message, "kept");
  assert.deepEqual(scrubSentryEvent({}), {}, "an event with no request or user is returned untouched");
}

function nextConfigSource(): string {
  return code("next.config.ts");
}

/**
 * The source assertions above prove the plugin is required from the right entry; this one RUNS it. It hands
 * next.config.ts to Next's own loader — the loader `next build` uses — with a dummy build token, so the
 * `withSentryConfig(...)` call and its option object are evaluated exactly as the production build evaluates
 * them. A PR build has no token, so until this ran, a plugin that failed to load (2026-10-16: "withSentryConfig is
 * not a function") or a major bump that renamed an option reached production green and stopped every deploy.
 * Nothing is uploaded: the plugin only wraps the config here, and uploads at the end of a real build.
 */
async function buildPluginLoadsTests() {
  const nodeRequire = createRequire(import.meta.url);
  try {
    nodeRequire.resolve("@sentry/nextjs/config");
  } catch (error) {
    if ((error as { code?: string }).code === "MODULE_NOT_FOUND") return;
    throw error;
  }
  const loadConfig = nodeRequire("next/dist/server/config.js").default as (
    phase: string,
    dir: string,
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  // Next keeps every loaded config in a per-process cache keyed by the directory string (and phase and pid), so a
  // first load with no token would be replayed to a second load WITH one and next.config.ts would never be
  // evaluated again — the first version of this guard did exactly that and passed on a deliberately broken
  // plugin import. One load, with the token, under a spelling of the directory (no trailing separator) that no
  // other caller in the suite uses.
  const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");
  const saved = { token: process.env.SENTRY_AUTH_TOKEN, sha: process.env.RAILWAY_GIT_COMMIT_SHA };
  try {
    process.env.SENTRY_AUTH_TOKEN = "sntrys_ci_dummy_token_that_is_never_sent_anywhere";
    process.env.RAILWAY_GIT_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
    let wrapped: Record<string, unknown>;
    try {
      wrapped = await loadConfig("phase-production-build", root, { silent: true });
    } catch (error) {
      assert.fail(`next.config.ts must load with a build token set, as the production build loads it — the Sentry plugin failed: ${String((error as Error).message).split("\n")[0]}`);
    }
    // The wrapper must hand the app's own config back, not replace it: the security headers are the part of it a
    // broken wrap would drop without any build error.
    assert.equal(typeof wrapped.headers, "function", "the Sentry-wrapped config must still carry the app's headers()");
  } finally {
    if (saved.token === undefined) delete process.env.SENTRY_AUTH_TOKEN;
    else process.env.SENTRY_AUTH_TOKEN = saved.token;
    if (saved.sha === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = saved.sha;
  }
}

function beyondErrorsTests() {
  // Sampling: a fixed small rate, nothing for the probe or the reporter's own endpoint, a parent's decision wins.
  const afterSurvey = SENTRY_PAGE_SURVEY_ENDS_AT_MS + 1;
  assert.equal(sentryTracesSampler({ name: "GET /admin/payroll" }, afterSurvey), SENTRY_TRACES_SAMPLE_RATE);
  assert.ok(SENTRY_TRACES_SAMPLE_RATE > 0 && SENTRY_TRACES_SAMPLE_RATE <= 0.1, "a free quota is spent per span");
  for (const name of ["GET /api/healthz", "GET /api/errors/client", "GET /_next/static/chunks/app.js", "GET /favicon.ico"]) {
    assert.equal(sentryTracesSampler({ name }, afterSurvey), 0, `${name} says nothing and is never traced`);
    assert.equal(sentryTracesSampler({ name }, SENTRY_PAGE_SURVEY_ENDS_AT_MS - 1), 0, `${name} stays quiet during the page survey`);
  }
  assert.equal(sentryTracesSampler({ name: "GET /admin/payroll", parentSampled: true }, afterSurvey), 1);
  assert.equal(sentryTracesSampler({ name: "GET /admin/payroll", parentSampled: false }, afterSurvey), 0);

  // The page survey (owner, 2026-10-16: "measure all pages, every single page"): every page request is traced until
  // midnight Cairo on 2026-10-19, API calls and bare "RSC GET" / "middleware GET" stay at the fixed rate, and after
  // that instant everything is back to the fixed rate by itself.
  const duringSurvey = SENTRY_PAGE_SURVEY_ENDS_AT_MS - 1;
  assert.equal(SENTRY_PAGE_SURVEY_ENDS_AT_MS, Date.parse("2026-10-20T00:00:00+03:00"), "the window ends at midnight Cairo");
  for (const name of ["GET /admin/payroll", "GET /employee-portals/plans", "/admin/reps-list"]) {
    assert.equal(sentryTracesSampler({ name }, duringSurvey), 1, `${name} is a page and is traced during the survey`);
    assert.equal(sentryTracesSampler({ name }, SENTRY_PAGE_SURVEY_ENDS_AT_MS), SENTRY_TRACES_SAMPLE_RATE, `${name} drops back when the survey ends`);
  }
  for (const name of ["GET /api/messages", "POST /admin/payroll", "RSC GET", "middleware GET"]) {
    assert.equal(sentryTracesSampler({ name }, duringSurvey), SENTRY_TRACES_SAMPLE_RATE, `${name} is not a page request`);
  }
  assert.equal(sentryTracesSampler({ name: "GET /admin/payroll", parentSampled: false }, duringSurvey), 0, "a parent's decision still wins");
  assert.equal(SENTRY_REPLAY_SESSION_SAMPLE_RATE, 0, "an ordinary session is never recorded");
  assert.equal(SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE, 1, "the lead-up to an error is");

  // Paths: HR ids, uuids, numbers and long tokens go; words stay; the query and fragment go.
  assert.equal(scrubSentryPath("/admin/employees/B-10"), "/admin/employees/:id");
  assert.equal(scrubSentryPath("/admin/employees/b10/edit?tab=pay#x"), "/admin/employees/:id/edit");
  assert.equal(scrubSentryPath("/api/leave/4821/approve"), "/api/leave/:id/approve");
  assert.equal(scrubSentryPath("/x/3f2b8c1e-9d4a-4e6b-8a1f-0c2d3e4f5a6b"), "/x/:id");
  assert.equal(scrubSentryPath("/admin/payroll/summary"), "/admin/payroll/summary");
  // A database call keeps its table (or function) name: they are schema, not data, and masking them made 100,120 spans a day
  // read the same `/rest/:id/:id` (an "N+1 API Call" issue on a cron that reads thirty different tables). Values ride in the
  // query string, which is still dropped, and a path that merely resembles one is scrubbed as before.
  assert.equal(scrubSentryPath("/rest/v1/employees?hr_id=eq.B-10&select=*"), "/rest/v1/employees");
  assert.equal(scrubSentryPath("/rest/v1/source_of_sales_import_rows_staging_archive?limit=1"), "/rest/v1/source_of_sales_import_rows_staging_archive");
  assert.equal(scrubSentryPath("/rest/v1/rpc/phx_monthly_achievement"), "/rest/v1/rpc/phx_monthly_achievement");
  assert.equal(scrubSentryPath("/rest/v1/employees/B-10"), "/rest/v1/employees", "nothing after the table name is ever kept");
  assert.equal(scrubSentryPath("/auth/v1/user"), "/auth/v1/user");
  assert.equal(scrubSentryPath("/storage/v1/object/hiring/B-10"), "/storage/v1/object/hiring/:id");
  assert.equal(scrubSentryPath("/rest/B-10/employees"), "/rest/:id/employees", "a PostgREST shape needs the real /rest/v1/ prefix");
  // Telegram's bot API carries the bot's credential as a path segment (`/bot<id>:<token>/sendMessage`). The colon kept it out of the
  // long-word rule, so the production bot token left in every Telegram span's name and URL until 2026-10-23. The token below is made up.
  const fakeBotToken = "1234567890:AAFakeFakeFakeFakeFakeFakeFakeFake_abc";
  assert.equal(scrubSentryPath(`/bot${fakeBotToken}/sendMessage`), "/:id/sendMessage", "the bot path segment is masked");
  assert.equal(
    scrubSentryText(`POST https://api.telegram.org/bot${fakeBotToken}/sendMessage`),
    "POST https://api.telegram.org/:id/sendMessage",
    "a span name carrying the Telegram URL loses the token",
  );
  assert.equal(scrubSentryText(`fetch failed for ${fakeBotToken}`), "fetch failed for [token]", "the bare token is masked wherever it appears");
  assert.ok(!JSON.stringify(scrubSentrySpan({ name: `POST https://api.telegram.org/bot${fakeBotToken}/sendMessage`, attributes: { "http.url": `https://api.telegram.org/bot${fakeBotToken}/sendMessage`, "url.full": `https://api.telegram.org/bot${fakeBotToken}/sendMessage` } })).includes("AAFake"), "no field of a Telegram span keeps the token");
  assert.equal(
    scrubSentryText("GET https://ozucdzovmcqvepbozvqf.supabase.co/rest/v1/employees?hr_id=eq.B-10"),
    "GET https://ozucdzovmcqvepbozvqf.supabase.co/rest/v1/employees",
  );
  assert.equal(scrubSentryText("GET /admin/employees/B-10?month=2026-10"), "GET /admin/employees/:id");
  assert.equal(scrubSentryText("failed for omar@satopharma.com on B-204"), "failed for [email] on :id");
  assert.equal(scrubSentryText("fetch https://phoenix-hr.satopharma.com/api/leave/4821"), "fetch https://phoenix-hr.satopharma.com/api/leave/:id");

  const span = scrubSentrySpan({
    name: "GET /admin/employees/B-10",
    attributes: {
      "http.url": "https://phoenix-hr.satopharma.com/admin/employees/B-10?x=1",
      "url.query": "hr_id=B-10",
      "user.email": "a@b.com",
      "http.request.header.cookie": "phoenix_session=secret",
      "db.statement": "select * from payroll where hr_id = 'B-10'",
      "http.status_code": 200,
    },
  });
  assert.equal(span.name, "GET /admin/employees/:id");
  assert.deepEqual(
    Object.keys(span.attributes ?? {}).sort(),
    ["http.status_code", "http.url"],
    "user, header, query and SQL attributes never leave",
  );
  assert.equal(span.attributes?.["http.url"], "https://phoenix-hr.satopharma.com/admin/employees/:id");

  const log = scrubSentryLog({
    message: "send failed for omar@satopharma.com at /admin/employees/B-10",
    attributes: { "sentry.origin": "auto.console", employee_name: "x", salary: 1, route: "/api/leave/4821", level: "error" },
  });
  assert.equal(log.message, "send failed for [email] at /admin/employees/:id");
  assert.deepEqual(Object.keys(log.attributes ?? {}).sort(), ["level", "route", "sentry.origin"], "a name or a figure never rides a log");
  assert.equal(log.attributes?.route, "/api/leave/:id");
}

function cronMonitorTests() {
  // A declared cron job becomes a crontab monitor in Africa/Cairo, with the register's own grace as the margin.
  const daily = sentryMonitorConfigFor("phoenix-notify-daily");
  assert.deepEqual(daily?.schedule, { type: "crontab", value: "36 6 * * *" });
  assert.equal(daily?.checkinMargin, 60, "a one-hour grace is a sixty-minute margin");
  assert.equal(daily?.timezone, "Africa/Cairo", "the register is Cairo local; UTC would put every window hours off");
  assert.equal(daily?.failureIssueThreshold, 2);
  assert.equal(daily?.recoveryThreshold, 1);
  // A job on a plain interval becomes an interval monitor.
  assert.deepEqual(sentryMonitorConfigFor("phoenix-ireports360-live-poll")?.schedule, { type: "interval", value: 5, unit: "minute" });
  // A job the register never declared sends no config, so Sentry ignores its check-in and creates nothing.
  assert.equal(sentryMonitorConfigFor("not-a-declared-job"), undefined);
  assert.equal(sentryMonitorConfigFor(""), undefined);
  // Every declaration yields a usable monitor, and none has a margin of zero.
  for (const job of JOB_SCHEDULES) {
    const config = sentryMonitorConfigFor(job.slug);
    assert.ok(config, `${job.slug} must produce a monitor config`);
    assert.ok(config.checkinMargin >= 1, `${job.slug} needs a margin of at least a minute`);
    assert.ok(config.schedule.type === "crontab" ? config.schedule.value.split(" ").length === 5 : config.schedule.value >= 1, `${job.slug} needs a real schedule`);
  }
}

function wiringTests() {
  // instrumentation.ts is bundled for both runtimes: it may import the pure policy statically and the
  // SDK only dynamically, inside a nodejs guard that the policy has already cleared.
  const instrumentation = code("instrumentation.ts");
  assert.ok(!/from\s+["']@sentry\//.test(instrumentation), "instrumentation.ts must never import the Sentry SDK statically");
  assert.ok(!/sentry-server["']\s*;?\s*$/m.test(instrumentation.replace(/await import\([^)]*\)/g, "")), "sentry-server is loaded only by dynamic import");
  assert.match(instrumentation, /sentryServerStatus\(\{ appEnv: process\.env\.APP_ENV, dsn: process\.env\.SENTRY_DSN \}\)/);
  assert.ok(
    (instrumentation.match(/await import\("@\/lib\/observability\/sentry-server"\)/g) ?? []).length === 2,
    "the SDK is reached from exactly two dynamic imports: boot and onRequestError",
  );
  assert.match(
    instrumentation,
    /async function forwardRequestErrorToSentry[^{]*\{\s*if \(process\.env\.NEXT_RUNTIME === "nodejs"\) \{\s*if \(process\.env\.NODE_ENV === "production"\) \{\s*if \(!sentryServerStatus\([^)]*\)\.enabled\) return;[\s\S]*?await import\("@\/lib\/observability\/sentry-server"\)/,
    "the request-error hook checks the runtime, the build and the policy before it loads the SDK",
  );
  // 🔴 COMPILE-TIME GATES (2026-10-17). Webpack drops a dynamic import only inside a BLOCK whose test Next
  // inlines to a literal; code after an early `return` is compiled anyway. The runtime check was an early
  // return until then, and the edge bundle carried the whole SDK (6 MB) and every `next dev` compiled it.
  assert.doesNotMatch(instrumentation, /NEXT_RUNTIME !== "nodejs"\) return;/, "an early return on the runtime prunes nothing from the edge bundle");
  assert.match(
    instrumentation,
    /\} else if \(process\.env\.NODE_ENV === "production"\) \{\s*const \{ initSentryServer \} = await import\("@\/lib\/observability\/sentry-server"\);/,
    "the boot import of the SDK sits inside a production-build block, so a dev server never compiles it",
  );

  // Only these two files may name the SDK; sentry-client loads it lazily so a staging browser never downloads it.
  const server = code("src/lib/observability/sentry-server.ts");
  assert.match(server, /enableRuntimeChannelInjection: false/, "no load-time module rewriting on the payroll server");
  assert.ok(!/sendDefaultPii/.test(server), "SDK 11 has no sendDefaultPii option — it is a type error in `checks`; the scrubber is the lock");
  assert.match(server, /beforeSend: \(event\) => scrubSentryEvent\(event\)/);
  assert.match(server, /beforeSendSpan: \(span\) => scrubSentrySpan\(span\)/, "every span is scrubbed before it leaves");
  assert.match(server, /beforeSendLog: \(log\) => scrubSentryLog\(log\)/, "every log line is scrubbed before it leaves");
  assert.match(server, /tracesSampler: \(context\) => sentryTracesSampler\(context\)/, "sampling goes through the policy, never a literal rate");
  assert.match(server, /levels: \["warn", "error"\]/, "only warn and error console lines become logs");
  assert.ok(!/tracesSampleRate|profilesSampleRate|replaysSessionSampleRate/.test(server), "rates live in sentry-policy.ts only");
  assert.match(server, /captureCheckIn\(\{ monitorSlug: jobSlug, status \}, sentryMonitorConfigFor\(jobSlug\)\)/, "the monitor is built from the register of scheduled jobs, never written by hand in Sentry");

  const client = code("src/lib/observability/sentry-client.ts");
  assert.ok(!/from\s+["']@sentry\//.test(client), "the browser SDK is imported lazily, never statically");
  assert.match(client, /import\("@sentry\/nextjs"\)/);
  assert.match(client, /sentryClientStatus\(/);
  assert.match(client, /integration\.name !== "GlobalHandlers"/, "our reporter feeds window errors; the SDK's own handlers would double-report");
  assert.match(client, /beforeSend: \(event\) => scrubSentryEvent\(event\)/);
  assert.match(client, /beforeSendSpan: \(span\) => scrubSentrySpan\(span\)/);
  assert.match(client, /replayIntegration\(\{ maskAllText: true, maskAllInputs: true, blockAllMedia: true \}\)/, "Phoenix screens are payroll: a replay shows layout, never a figure");
  assert.match(client, /replaysSessionSampleRate: SENTRY_REPLAY_SESSION_SAMPLE_RATE/);
  assert.match(client, /tracePropagationTargets: \[\]/, "no trace header is added to any request");
  assert.ok(!/tracesSampleRate|replaysSessionSampleRate: [01]/.test(client), "rates live in sentry-policy.ts only");
  assert.match(code("src/components/layout/global-error-reporter.tsx"), /startSentryBrowser\(\)/, "the browser SDK starts from the one mounted reporter");

  // The cron monitor leg rides the dead-man's switch, behind the same production gate.
  const switchSource = code("src/lib/observability/dead-mans-switch.ts");
  assert.match(switchSource, /checkInSentry\(jobSlug, outcome\)/);
  assert.match(switchSource, /sentryServerStatus\(\{ appEnv: process\.env\.APP_ENV, dsn: process\.env\.SENTRY_DSN \}\)\.enabled\) return/);
  assert.match(
    switchSource,
    /async function checkInSentry[^{]*\{\s*if \(process\.env\.NODE_ENV === "production"\) \{[\s\S]*?await import\("@\/lib\/observability\/sentry-server"\)/,
    "the 44 routes that import the switch compile the SDK only in a production build",
  );

  // Source maps and the release: the build plugin runs only when a build token exists, and keeps the maps off the wire.
  assert.match(nextConfigSource(), /if \(!authToken\) return config/, "a build without a token exports the plain config");
  assert.match(nextConfigSource(), /deleteSourcemapsAfterUpload: true/);
  // 2026-10-16: the first version required the package ROOT, where withSentryConfig does not exist, and the
  // production build died with "withSentryConfig is not a function" while every PR check stayed green (a PR build
  // has no token, so the branch never ran). The plugin lives at the /config entry.
  assert.match(nextConfigSource(), /require\("@sentry\/nextjs\/config"\)/, "withSentryConfig is exported from the /config entry, not the package root");
  assert.ok(!/require\("@sentry\/nextjs"\)/.test(nextConfigSource()), "never require the package root for the build plugin");
  assert.match(nextConfigSource(), /errorHandler: \(error: Error\) => console\.warn\(/, "a rejected token must never stop a production deploy");
  try {
    const entry = createRequire(import.meta.url).resolve("@sentry/nextjs/config");
    assert.match(readFileSync(entry, "utf8"), /withSentryConfig/, "the installed package's /config entry must export withSentryConfig");
  } catch (error) {
    if ((error as { code?: string }).code !== "MODULE_NOT_FOUND" && (error as { code?: string }).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    assert.notEqual((error as { code?: string }).code, "ERR_PACKAGE_PATH_NOT_EXPORTED", "the installed package must export ./config");
  }
  assert.match(nextConfigSource(), /telemetry: false/);
  assert.match(nextConfigSource(), /deploy: \{ env: "production" \}/, "each release is marked as a production deploy");
  assert.match(nextConfigSource(), /setCommits: \{ repo: "Omar-3-xx\/phoenix-people-workforce", commit: release, ignoreMissing: true \}/, "commits are named explicitly and a missing integration is tolerated");
  for (const switchName of ["autoInstrumentServerFunctions", "autoInstrumentMiddleware", "autoInstrumentAppDirectory", "automaticVercelMonitors"]) {
    assert.match(nextConfigSource(), new RegExp(`${switchName}: false`), `${switchName} stays off`);
  }
  assert.ok(!/tunnelRoute/.test(nextConfigSource()), "reports go straight to the ingest host the CSP allows, never through a tunnel");
  assert.match(nextConfigSource(), /Document-Policy[\s\S]{0,40}js-profiling/, "the browser profiler needs this header");
  assert.match(nextConfigSource(), /sentryIngestOrigin \? \[\{ key: "Document-Policy"/, "and only a build that carries a DSN sends it");
  const buildDockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(buildDockerfile, /^ARG SENTRY_AUTH_TOKEN$/m);
  assert.ok(
    buildDockerfile.indexOf("ARG SENTRY_AUTH_TOKEN") < buildDockerfile.search(/^RUN pnpm run build$/m),
    "the token must be declared before the build that uses it",
  );
  assert.ok(
    buildDockerfile.indexOf("ARG SENTRY_AUTH_TOKEN") < buildDockerfile.search(/^FROM base AS runner$/m),
    "and only in the build stage — the token never reaches the running image",
  );

  // The one browser funnel feeds it.
  assert.match(code("src/lib/error-monitor/report-client-error.ts"), /captureClientErrorInSentry\(/);

  // The CSP gains a host only from this build's own DSN — never a hard-coded ingest host.
  const nextConfig = code("next.config.ts");
  assert.ok(!/ingest\.[a-z.]*sentry\.io/.test(nextConfig), "no ingest host is written into the CSP");
  assert.match(nextConfig, /NEXT_PUBLIC_SENTRY_DSN/);
  assert.match(nextConfig, /value: siteContentSecurityPolicy/);

  // The browser DSN is a build-time value.
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^ARG NEXT_PUBLIC_SENTRY_DSN$/m);
  assert.match(dockerfile, /^ENV NEXT_PUBLIC_SENTRY_DSN=\$NEXT_PUBLIC_SENTRY_DSN$/m);
}

function alertWebhookTests() {
  // The signature: HMAC-SHA256 of the raw body, hex, under the integration's client secret.
  const body = JSON.stringify({ action: "triggered", data: { event: { title: "TypeError: x" } } });
  const good = createHmac("sha256", "s3cret").update(body, "utf8").digest("hex");
  assert.equal(verifySentrySignature(body, good, "s3cret"), true);
  assert.equal(verifySentrySignature(body, good.toUpperCase(), "s3cret"), true, "hex case does not matter");
  assert.equal(verifySentrySignature(body + " ", good, "s3cret"), false, "a changed body fails");
  assert.equal(verifySentrySignature(body, good, "other"), false, "another secret fails");
  assert.equal(verifySentrySignature(body, "", "s3cret"), false, "no signature fails");
  assert.equal(verifySentrySignature(body, null, "s3cret"), false);
  assert.equal(verifySentrySignature(body, good, ""), false, "an empty secret never verifies");

  // The message: an alert or a new issue becomes a short text, anything else is ignored, and identifiers are scrubbed.
  const alert = buildSentryAlertMessage("event_alert", {
    action: "triggered",
    data: {
      event: {
        title: "TypeError: Cannot read properties of undefined for B-10",
        culprit: "GET /admin/employees/B-10",
        level: "error",
        web_url: "https://phoenix-crm.sentry.io/issues/1/events/2/",
      },
      triggered_rule: "New production error",
    },
  });
  assert.ok(alert, "an event alert is forwarded");
  assert.doesNotMatch(alert.message, /B-10/, "HR ids never reach the message");
  assert.match(alert.message, /TypeError/);
  assert.match(alert.message, /Rule: New production error/);
  assert.equal(alert.url, "https://phoenix-crm.sentry.io/issues/1/events/2/");
  const created = buildSentryAlertMessage("issue", { action: "created", data: { issue: { title: "Boom", level: "fatal" } } });
  assert.ok(created && /Boom/.test(created.message), "a created issue is forwarded");
  assert.equal(buildSentryAlertMessage("issue", { action: "resolved", data: { issue: { title: "Boom" } } }), null, "a resolved issue is not an alert");
  assert.equal(buildSentryAlertMessage("installation", { action: "created" }), null, "other resources are ignored");
  assert.equal(buildSentryAlertMessage("event_alert", { data: { event: {} } }), null, "an alert with no title says nothing");
  assert.equal(
    buildSentryAlertMessage("event_alert", { data: { event: { title: "x", web_url: "https://evil.example/phish" } } })?.url,
    null,
    "only a sentry.io link is ever put in the message",
  );
  assert.ok((buildSentryAlertMessage("event_alert", { data: { event: { title: "y".repeat(2000) } } })?.message.length ?? 0) <= 400, "a long title is cut");

  // The wiring: a signed, CSRF-exempt, registered route that refuses everything when its secret is unset.
  const route = code("app/api/webhooks/sentry/route.ts");
  assert.match(route, /process\.env\.SENTRY_WEBHOOK_SECRET/);
  assert.match(route, /status: 500/, "no secret configured means refuse");
  assert.match(route, /verifySentrySignature\(body, request\.headers\.get\("sentry-hook-signature"\), secret\)[\s\S]*?status: 401/, "a bad signature is a 401 before anything is read");
  assert.ok(route.indexOf("verifySentrySignature(") < route.indexOf("JSON.parse(body)"), "the body is parsed only after it is verified");
  assert.match(code("proxy.ts"), /pathname === "\/api\/webhooks\/sentry"/, "the webhook is CSRF-exempt like the other provider webhooks");
  assert.match(code("src/lib/security/access-registry.ts"), /pattern: "\/api\/webhooks\/sentry"/, "the route is in the access registry");
}

function sentryCheckPageTests() {
  // The example page: Super Admin only, and the server half throws only after the SAME gate the SDK uses.
  const page = code("app/(admin)/admin/sentry-check/page.tsx");
  assert.match(page, /access\.role !== "Super Admin"[\s\S]*?redirect\(/, "the Sentry Check page is the Super Admin's alone");
  assert.match(page, /sentryServerStatus\(\{ appEnv: process\.env\.APP_ENV, dsn: process\.env\.SENTRY_DSN \}\)/, "the page reads the SDK's own production gate");

  const route = code("app/api/admin/sentry-check/route.ts");
  assert.match(route, /assertSameOriginMutation\(request\)/);
  assert.match(route, /access\.role !== "Super Admin"[\s\S]*?status: 403/, "the trigger route refuses everyone but the Super Admin");
  assert.match(route, /!status\.enabled[\s\S]*?status: 409/, "off production the route refuses instead of throwing");
  assert.ok(
    route.indexOf("!status.enabled") < route.indexOf('throw new Error("Sentry Check'),
    "the deliberate throw comes only after the production gate",
  );
  assert.match(code("src/lib/security/access-registry.ts"), /pattern: "\/api\/admin\/sentry-check"/, "the route is in the access registry");
}

function expectedNoiseTests() {
  // A locked module refusing a page is an answer: skipped by the request-error hook, exact wording only.
  assert.equal(isModuleLockRefusal(new Error("Forbidden: incentive is temporarily locked by the system administrator.")), true);
  assert.equal(isModuleLockRefusal(new Error("Forbidden: sales is temporarily locked by the system administrator.")), true);
  assert.equal(isModuleLockRefusal(new Error("Forbidden: Employee cannot read payroll.")), false, "a real refusal still reaches both stores");
  assert.equal(isModuleLockRefusal(new Error("Connection closed.")), false);
  assert.equal(isModuleLockRefusal("Forbidden: incentive is temporarily locked by the system administrator."), false, "only a thrown error object counts");
  assert.match(code("instrumentation.ts"), /if \(isModuleLockRefusal\(error\)\) return;\s*await forwardRequestErrorToSentry/, "the lock refusal is skipped before either store is written");

  // The browser's own network-failure wording and its injected-script placeholder stay out of Sentry.
  for (const message of ["Load failed", "Failed to fetch", "Error in input stream", "network error", CROSS_ORIGIN_MASKED_DISPLAY]) {
    assert.equal(isBrowserNoiseMessage(message), true, `${message} is the browser talking, not Phoenix`);
  }
  assert.equal(isBrowserNoiseMessage("Connection closed."), false, "'Connection closed.' was once a REAL Supabase failure and must stay visible");
  assert.equal(isBrowserNoiseMessage("TypeError: Cannot read properties of undefined"), false);
  assert.equal(isBrowserNoiseMessage("Failed to fetch the incentive table"), false, "the match is exact, never a substring");
  assert.match(
    code("src/lib/observability/sentry-client.ts"),
    /isBrowserNoiseMessage\(describeThrown\(report\.error\)\)\) return;/,
    "the browser Sentry path drops the noise; the error table still records it",
  );
}

export async function runSentryProductionOnlyTests() {
  expectedNoiseTests();
  sentryCheckPageTests();
  gateTests();
  scrubTests();
  beyondErrorsTests();
  cronMonitorTests();
  alertWebhookTests();
  wiringTests();
  await buildPluginLoadsTests();
}
