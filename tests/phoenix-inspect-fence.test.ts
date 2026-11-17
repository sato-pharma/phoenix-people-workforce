import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  NEVER_TOUCH_PATHS,
  PRODUCTION_HOSTS,
  STAGING_ORIGIN,
  classifyRequest,
  maskPathIds,
  sanitizeErrorText,
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
  assert.deepEqual(classifyRequest({ method: "GET", url: "https://o1.ingest.example.com/api/1/envelope/" }, policy), { allow: false, reason: "off-origin" });
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
  assert.equal(sanitizeUrlForLog("https://o1.ingest.example.com/api/1/envelope/?key=k", STAGING_ORIGIN), "https://o1.ingest.example.com/(off-origin path withheld)");
  assert.equal(maskPathIds("/employee-portals/kpis/call-rate/12345"), "/employee-portals/kpis/call-rate/:n");
  assert.equal(maskPathIds("/x/0f8fad5b-d9cb-469f-a165-70867728950e"), "/x/:uuid");
  assert.equal(maskPathIds("/x/%D8%A3%D8%AD%D9%85%D8%AF"), "/x/:text", "an encoded name is masked");
  assert.equal(maskPathIds("/admin/kpis"), "/admin/kpis", "ordinary segments are kept");

  // An error is recorded as its first line, with every address masked and long digit runs zeroed:
  // Playwright's call log quotes the link it waited on (14 Nov 2026, a rep number in the manifest).
  const esc = String.fromCharCode(27);
  const timedOut = [
    "locator.click: Timeout 30000ms exceeded.",
    "Call log:",
    `${esc}[2m  - waiting for locator('a[href*="rep="]').first()${esc}[22m`,
    `${esc}[2m    - locator resolved to <a href="/admin/kpis?month=2026-08&tab=coverage&rep=8123">Sammy Example</a>${esc}[22m`,
  ].join("\n");
  assert.equal(sanitizeErrorText(timedOut, STAGING_ORIGIN), "locator.click: Timeout 30000ms exceeded.", "the call log never travels");
  const failedGoto = sanitizeErrorText(
    `page.goto: net::ERR_ABORTED at ${STAGING_ORIGIN}/admin/kpis/call-rate/crm%3A8123?month=2026-08&rep=8123`,
    STAGING_ORIGIN,
  );
  assert.equal(failedGoto, "page.goto: net::ERR_ABORTED at /admin/kpis/call-rate/:text?month=…&rep=…", "an address in the first line is masked");
  assert.equal(sanitizeErrorText("waiting for /employee-portals/kpis/call-rate/Z-9043?rep=1", STAGING_ORIGIN), "waiting for /employee-portals/kpis/call-rate/:id?rep=…");
  assert.equal(sanitizeErrorText("row 81234 of 99", STAGING_ORIGIN), "row 00000 of 99", "a long number outside an address is masked");
  assert.ok(!/8123|Sammy|9043/.test(`${sanitizeErrorText(timedOut, STAGING_ORIGIN)}${failedGoto}`), "no id or name survives");

  // Every place the capture records an error goes through it.
  const capture = readFileSync(new URL("../scripts/phoenix-inspect/lib/capture.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(capture, /\.error = String\(/, "no error is recorded raw");
  assert.equal((capture.match(/sanitizeErrorText\(error\.message, origin/g) ?? []).length, 4, "sign-in, navigation, capture and the denied probe");
}
