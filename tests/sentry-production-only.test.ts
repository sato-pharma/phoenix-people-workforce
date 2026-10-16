import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseSentryDsn,
  scrubSentryEvent,
  sentryClientStatus,
  sentryServerStatus,
} from "../src/lib/observability/sentry-policy.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Sentry (sentry.io) runs on PRODUCTION ONLY, and sends errors only.
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
  assert.match(server, /enableOpenTelemetrySetup: false/, "errors only: no OpenTelemetry tracer provider");
  assert.match(server, /enableRuntimeChannelInjection: false/, "errors only: no load-time module rewriting");
  assert.match(server, /sendDefaultPii: false/);
  assert.match(server, /beforeSend: \(event\) => scrubSentryEvent\(event\)/);
  assert.ok(!/tracesSampleRate|profilesSampleRate|replaysSessionSampleRate/.test(server), "no tracing, profiling or replay");

  const client = code("src/lib/observability/sentry-client.ts");
  assert.ok(!/from\s+["']@sentry\//.test(client), "the browser SDK is imported lazily, never statically");
  assert.match(client, /import\("@sentry\/nextjs"\)/);
  assert.match(client, /sentryClientStatus\(/);
  assert.match(client, /integration\.name !== "GlobalHandlers"/, "our reporter feeds window errors; the SDK's own handlers would double-report");
  assert.match(client, /beforeSend: \(event\) => scrubSentryEvent\(event\)/);
  assert.ok(!/tracesSampleRate|replaysSessionSampleRate|replayIntegration/.test(client));

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
  wiringTests();
}
