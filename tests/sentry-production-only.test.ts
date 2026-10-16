import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
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
import { sentryMonitorConfigFor } from "../src/lib/observability/sentry-cron-monitor.ts";
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

function beyondErrorsTests() {
  // Sampling: a fixed small rate, nothing for the probe or the reporter's own endpoint, a parent's decision wins.
  assert.equal(sentryTracesSampler({ name: "GET /admin/payroll" }), SENTRY_TRACES_SAMPLE_RATE);
  assert.ok(SENTRY_TRACES_SAMPLE_RATE > 0 && SENTRY_TRACES_SAMPLE_RATE <= 0.1, "a free quota is spent per span");
  for (const name of ["GET /api/healthz", "GET /api/errors/client", "GET /_next/static/chunks/app.js", "GET /favicon.ico"]) {
    assert.equal(sentryTracesSampler({ name }), 0, `${name} says nothing and is never traced`);
  }
  assert.equal(sentryTracesSampler({ name: "GET /admin/payroll", parentSampled: true }), 1);
  assert.equal(sentryTracesSampler({ name: "GET /admin/payroll", parentSampled: false }), 0);
  assert.equal(SENTRY_REPLAY_SESSION_SAMPLE_RATE, 0, "an ordinary session is never recorded");
  assert.equal(SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE, 1, "the lead-up to an error is");

  // Paths: HR ids, uuids, numbers and long tokens go; words stay; the query and fragment go.
  assert.equal(scrubSentryPath("/admin/employees/B-10"), "/admin/employees/:id");
  assert.equal(scrubSentryPath("/admin/employees/b10/edit?tab=pay#x"), "/admin/employees/:id/edit");
  assert.equal(scrubSentryPath("/api/leave/4821/approve"), "/api/leave/:id/approve");
  assert.equal(scrubSentryPath("/x/3f2b8c1e-9d4a-4e6b-8a1f-0c2d3e4f5a6b"), "/x/:id");
  assert.equal(scrubSentryPath("/admin/payroll/summary"), "/admin/payroll/summary");
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
    /async function forwardRequestErrorToSentry[\s\S]*?NEXT_RUNTIME !== "nodejs"\) return;[\s\S]*?\.enabled\) return;[\s\S]*?await import\("@\/lib\/observability\/sentry-server"\)/,
    "the request-error hook checks the runtime and the policy before it loads the SDK",
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

export function runSentryProductionOnlyTests() {
  gateTests();
  scrubTests();
  beyondErrorsTests();
  cronMonitorTests();
  wiringTests();
}
