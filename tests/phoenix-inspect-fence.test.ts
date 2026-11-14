import assert from "node:assert/strict";

import {
  NEVER_TOUCH_PATHS,
  PRODUCTION_HOSTS,
  STAGING_ORIGIN,
  classifyRequest,
  maskPathIds,
  sanitizeUrlForLog,
} from "../scripts/phoenix-inspect/lib/fence.mjs";

/**
 * Phoenix Visual Intelligence: the explorer's write fence. Every request a browsing context makes is
 * decided by classifyRequest, so these pin the no-mutation promise without a browser: only GET/HEAD to
 * the one target origin (and two font hosts) pass; every write method, every Server Action, every other
 * origin, the production host by any method, and the never-touch paths (the KPIs export above all) are
 * refused. The page-side stubs (fetch, sendBeacon, XHR) are exercised in a real browser by
 * scripts/phoenix-inspect/self-check.mjs.
 */
export function runPhoenixInspectFenceTests() {
  const policy = { origin: STAGING_ORIGIN };
  const at = (path: string) => `${STAGING_ORIGIN}${path}`;

  // Reads of the target pass.
  assert.deepEqual(classifyRequest({ method: "GET", url: at("/admin/kpis?month=2026-08") }, policy), { allow: true });
  assert.deepEqual(classifyRequest({ method: "HEAD", url: at("/admin/kpis") }, policy), { allow: true });
  assert.deepEqual(classifyRequest({ method: "get", url: at("/_next/static/chunks/app.js") }, policy), { allow: true }, "method case is ignored");
  assert.deepEqual(classifyRequest({ method: "GET", url: at("/admin/kpis?_rsc=abc") }, policy), { allow: true }, "an RSC read is a read");
  assert.deepEqual(classifyRequest({ method: "GET", url: "data:image/png;base64,AAAA" }, policy), { allow: true });

  // Every write method is refused, on any path, including the sign-in route.
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"]) {
    for (const path of ["/api/auth/login", "/api/crm/visits", "/admin/kpis", "/api/auth/pulse"]) {
      assert.deepEqual(
        classifyRequest({ method, url: at(path) }, policy),
        { allow: false, reason: "write-method" },
        `${method} ${path} must be refused`,
      );
    }
  }

  // A Server Action is refused even if something dressed it as a GET.
  assert.deepEqual(
    classifyRequest({ method: "GET", url: at("/admin/kpis"), headers: { "Next-Action": "7f3a" } }, policy),
    { allow: false, reason: "server-action" },
  );
  assert.deepEqual(
    classifyRequest({ method: "POST", url: at("/admin/kpis"), headers: { "next-action": "7f3a" } }, policy),
    { allow: false, reason: "server-action" },
  );

  // Production is refused by any method, and a policy that targets it refuses everything.
  assert.ok(PRODUCTION_HOSTS.includes("phoenix-hr.satopharma.com"));
  assert.deepEqual(
    classifyRequest({ method: "GET", url: "https://phoenix-hr.satopharma.com/admin/kpis" }, policy),
    { allow: false, reason: "production-host" },
  );
  assert.deepEqual(
    classifyRequest({ method: "GET", url: "https://phoenix-hr.satopharma.com/admin/kpis" }, { origin: "https://phoenix-hr.satopharma.com" }),
    { allow: false, reason: "production-host" },
  );
  assert.deepEqual(
    classifyRequest({ method: "GET", url: "https://example.org/x" }, { origin: "https://phoenix-hr.satopharma.com" }),
    { allow: false, reason: "policy-targets-production" },
  );

  // Other origins: refused, except GET to the two font hosts over https.
  assert.deepEqual(classifyRequest({ method: "GET", url: "https://onesignal.com/sdk.js" }, policy), { allow: false, reason: "off-origin" });
  assert.deepEqual(classifyRequest({ method: "GET", url: "https://o1.ingest.sentry.io/api/1/envelope/" }, policy), { allow: false, reason: "off-origin" });
  assert.deepEqual(classifyRequest({ method: "GET", url: "https://fonts.gstatic.com/s/inter.woff2" }, policy), { allow: true });
  assert.deepEqual(classifyRequest({ method: "GET", url: "http://fonts.gstatic.com/s/inter.woff2" }, policy), { allow: false, reason: "off-origin" }, "fonts over plain http are refused");
  assert.deepEqual(classifyRequest({ method: "POST", url: "https://fonts.googleapis.com/css" }, policy), { allow: false, reason: "write-method" });
  assert.deepEqual(
    classifyRequest({ method: "GET", url: "https://phoenix-people-workforce-staging.up.railway.app.evil.example/x" }, policy),
    { allow: false, reason: "off-origin" },
    "a look-alike host is another origin",
  );
  assert.deepEqual(classifyRequest({ method: "GET", url: "http://phoenix-people-workforce-staging.up.railway.app/x" }, policy), { allow: false, reason: "off-origin" }, "http is another origin");

  // Never-touch paths are refused even as GET: the KPIs export first of all.
  for (const path of [
    "/api/crm/kpis-export?month=2026-08",
    "/api/crm/kpis-export",
    "/api/payroll/export",
    "/admin/reports/exports/123",
    "/api/files/download/abc",
    "/api/auth/logout",
    "/sign-out",
    "/api/cron/drain-outbox",
    "/api/webhooks/resend",
    "/api/email/unsubscribe",
  ]) {
    assert.deepEqual(classifyRequest({ method: "GET", url: at(path) }, policy), { allow: false, reason: "never-touch-path" }, `GET ${path} must be refused`);
  }
  assert.ok(NEVER_TOUCH_PATHS[0].test("/api/crm/kpis-export"), "the KPIs export is the first never-touch rule");
  assert.deepEqual(classifyRequest({ method: "GET", url: at("/admin/kpis/call-rate/abc") }, policy), { allow: true }, "a drill-down page is not a never-touch path");
  assert.deepEqual(classifyRequest({ method: "GET", url: "not a url" }, policy), { allow: false, reason: "unparseable-url" });

  // Logging: path ids masked, query keys only, other origins' paths withheld.
  assert.equal(sanitizeUrlForLog(at("/admin/kpis/call-rate/Z-9043?month=2026-08&rep=Z-9043&q=Sammy"), STAGING_ORIGIN), "/admin/kpis/call-rate/:id?month=…&q=…&rep=…");
  assert.equal(sanitizeUrlForLog("https://o1.ingest.sentry.io/api/1/envelope/?sentry_key=k", STAGING_ORIGIN), "https://o1.ingest.sentry.io/(off-origin path withheld)");
  assert.equal(maskPathIds("/employee-portals/kpis/call-rate/12345"), "/employee-portals/kpis/call-rate/:n");
  assert.equal(maskPathIds("/x/0f8fad5b-d9cb-469f-a165-70867728950e"), "/x/:uuid");
  assert.equal(maskPathIds("/x/%D8%A3%D8%AD%D9%85%D8%AF"), "/x/:text", "an encoded name is masked");
  assert.equal(maskPathIds("/admin/kpis"), "/admin/kpis", "ordinary segments are kept");
}
