import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CSP_NONCE_HEADER,
  CSP_REPORT_PATH,
  CSP_REPORTING_ENDPOINTS,
  pageContentSecurityPolicy,
  pageReportOnlyContentSecurityPolicy,
} from "@/lib/security/content-security-policy";
import {
  CSP_REPORT_MAX_BODY_BYTES,
  CSP_REPORT_MAX_SHAPES,
  CSP_REPORT_RATE_LIMIT,
  blockedSourceOf,
  countCspViolation,
  pageShapeOf,
  parseCspReports,
} from "@/lib/security/csp-report-intake";

const { NextRequest } = await import("next/server");
const { proxy } = await import("../proxy.ts");
const { POST: cspReportPost } = await import("../app/api/security/csp-report/route.ts");

// ─────────────────────────────────────────────────────────────────────────────
// THE REPORT-ONLY PAGE POLICY (S01, F-PLT-011, 13 Nov 2026).
//
//   1. It measures a `<style>` element without this request's nonce and a picture from outside the
//      measured host list — style-src carries the nonce and no 'unsafe-inline', img-src no bare https:.
//   2. The proxy sends it on every page beside the enforced policy, with the SAME nonce, and names the
//      report endpoint; an API route and a file get neither.
//   3. A report is reduced to a measured directive, the blocked ORIGIN and the page SHAPE — never a
//      path, a query or an id — and anything else is dropped.
//   4. The report route is public, bounded and answers 204; it never reads a session or a database.
// ─────────────────────────────────────────────────────────────────────────────

const NONCE = "dGVzdC1ub25jZS0xMjM0NTY3OA==";
const ORIGIN = "https://phoenix-hr.satopharma.com";

function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

function report(body: unknown, address = "203.0.113.7", extra: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${CSP_REPORT_PATH}`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/csp-report", "x-forwarded-for": address, ...extra },
    method: "POST",
  });
}

export async function runCspReportOnlyTests(): Promise<void> {
  // ── 1. What the report-only policy measures ────────────────────────────────────────────────
  const policy = directives(pageReportOnlyContentSecurityPolicy(NONCE));
  const styleSrc = policy.get("style-src") ?? [];
  assert.ok(styleSrc.includes(`'nonce-${NONCE}'`), "a <style> carrying this request's nonce is allowed");
  assert.ok(!styleSrc.includes("'unsafe-inline'"), "🔴 style-src must not allow every inline <style> — that is what it measures");
  assert.deepEqual(policy.get("style-src-attr"), ["'unsafe-inline'"], "style attributes are left out of the reports");
  const imgSrc = policy.get("img-src") ?? [];
  assert.ok(!imgSrc.includes("https:"), "🔴 img-src must name its hosts, not every https address");
  for (const host of ["'self'", "data:", "blob:", "https://*.supabase.co", "https://tile.openstreetmap.org", "https://*.googleapis.com", "https://*.gstatic.com"]) {
    assert.ok(imgSrc.includes(host), `img-src must keep ${host}, which a page loads today`);
  }
  assert.deepEqual(policy.get("report-uri"), [CSP_REPORT_PATH]);
  assert.deepEqual(policy.get("report-to"), ["csp-report"]);
  for (const ignored of ["frame-ancestors", "upgrade-insecure-requests", "script-src", "default-src"]) {
    assert.ok(!policy.has(ignored), `${ignored} is not measured here, so it is not in the report-only policy`);
  }
  assert.equal(CSP_REPORTING_ENDPOINTS, `csp-report="${CSP_REPORT_PATH}"`);

  // ── 2. The proxy sends it on pages only, with the page's own nonce ─────────────────────────
  for (const path of ["/employee-portals/submit-expense", "/hr/milestones", "/login"]) {
    const response = proxy(new NextRequest(`${ORIGIN}${path}`, { headers: { authorization: "Bearer csp-report-only-test" } }));
    const nonce = response.headers.get(`x-middleware-request-${CSP_NONCE_HEADER}`) ?? "";
    assert.equal(response.headers.get("content-security-policy"), pageContentSecurityPolicy(path, nonce), `${path}: the enforced policy is unchanged`);
    assert.equal(
      response.headers.get("content-security-policy-report-only"),
      pageReportOnlyContentSecurityPolicy(nonce),
      `🔴 ${path}: the page must carry the report-only policy with ITS OWN nonce, or every nonced <style> is reported`,
    );
    assert.equal(response.headers.get("reporting-endpoints"), CSP_REPORTING_ENDPOINTS, `${path}: Chromium needs the named endpoint`);
    assert.equal(
      response.headers.get("x-middleware-request-content-security-policy-report-only"),
      null,
      `${path}: the report-only policy goes on the response only — Next.js reads the nonce from the request's enforced policy`,
    );
  }
  for (const path of ["/api/readyz", "/marketing-guide.html"]) {
    const response = proxy(new NextRequest(`${ORIGIN}${path}`, { headers: { authorization: "Bearer csp-report-only-test" } }));
    assert.equal(response.headers.get("content-security-policy-report-only"), null, `${path} is not a page`);
  }

  // ── 3. A report keeps three words, none of them a person or a secret ───────────────────────
  assert.equal(blockedSourceOf("https://xyz.supabase.co/storage/v1/object/sign/evidence/a.jpg?token=SECRET"), "https://xyz.supabase.co");
  assert.equal(blockedSourceOf("inline"), "inline");
  assert.equal(blockedSourceOf(""), "inline");
  assert.equal(blockedSourceOf("data:image/png;base64,AAAA"), "data");
  assert.equal(blockedSourceOf("javascript:alert(1)"), "other");
  assert.equal(pageShapeOf(`${ORIGIN}/admin/employees/B-10?tab=pay#x`), "/admin/employees/:id");
  assert.equal(pageShapeOf(`${ORIGIN}/employee-portals/phoenix-crm/visits`), "/employee-portals/phoenix-crm/visits");
  assert.equal(pageShapeOf("about:srcdoc"), "srcdoc");
  assert.equal(pageShapeOf(`${ORIGIN}/share/${"a".repeat(43)}`), "/share/:id", "a long token-like segment is never kept");

  const uriFormat = parseCspReports({
    "csp-report": {
      "blocked-uri": "https://tracker.example/pixel.gif?u=someone",
      disposition: "report",
      "document-uri": `${ORIGIN}/employee-portals/mailbox/123`,
      "effective-directive": "img-src",
      "violated-directive": "img-src 'self'",
    },
  });
  assert.deepEqual(uriFormat, [{ blocked: "https://tracker.example", directive: "img-src", page: "/employee-portals/mailbox/:id" }]);

  const toFormat = parseCspReports([
    { body: { blockedURL: "inline", disposition: "report", documentURL: `${ORIGIN}/login`, effectiveDirective: "style-src-elem" }, type: "csp-violation" },
    { body: { blockedURL: "https://fonts.example", disposition: "enforce", documentURL: `${ORIGIN}/login`, effectiveDirective: "style-src-elem" }, type: "csp-violation" },
    { body: { blockedURL: "https://x.example", disposition: "report", documentURL: `${ORIGIN}/login`, effectiveDirective: "connect-src" }, type: "csp-violation" },
    { body: { message: "something else" }, type: "deprecation" },
  ]);
  assert.deepEqual(toFormat, [{ blocked: "inline", directive: "style-src-elem", page: "/login" }], "an enforced violation, an unmeasured directive and another report type are dropped");
  assert.deepEqual(parseCspReports("nonsense"), []);
  assert.deepEqual(parseCspReports(null), []);

  // Logged the first time a shape is seen and at each tenth power, never on every report.
  const counts = new Map<string, number>();
  const shape = { blocked: "inline", directive: "style-src-elem", page: "/login" };
  const logged: number[] = [];
  for (let index = 0; index < 1_000; index += 1) {
    const count = countCspViolation(counts, shape);
    if (count !== null) logged.push(count);
  }
  assert.deepEqual(logged, [1, 10, 100, 1_000]);
  const full = new Map<string, number>();
  for (let index = 0; index < CSP_REPORT_MAX_SHAPES + 50; index += 1) countCspViolation(full, { ...shape, page: `/p${index}` });
  assert.equal(full.size, CSP_REPORT_MAX_SHAPES, "rotating page shapes can never grow the map past its cap");

  // ── 4. The route ───────────────────────────────────────────────────────────────────────────
  const ok = await cspReportPost(report({ "csp-report": { "blocked-uri": "inline", "document-uri": `${ORIGIN}/login`, "effective-directive": "style-src-elem" } }));
  assert.equal(ok.status, 204);
  assert.equal((await cspReportPost(report("{not json"))).status, 204, "a malformed report is dropped quietly");
  assert.equal(
    (await cspReportPost(report("x", "203.0.113.8", { "content-length": String(CSP_REPORT_MAX_BODY_BYTES + 1) }))).status,
    413,
  );
  assert.equal((await cspReportPost(report("x".repeat(CSP_REPORT_MAX_BODY_BYTES + 1), "203.0.113.9"))).status, 413);
  const flooder = "198.51.100.23";
  for (let index = 0; index < CSP_REPORT_RATE_LIMIT; index += 1) {
    assert.equal((await cspReportPost(report([], flooder))).status, 204);
  }
  assert.equal((await cspReportPost(report([], flooder))).status, 429, "one address is capped a minute");
  assert.equal((await cspReportPost(report([], "198.51.100.24"))).status, 204, "another address is not");

  // A browser's own report often carries no Origin, and a sandboxed frame's carries `null`: the proxy
  // must let it reach the route, which reads no session and writes nothing.
  for (const origin of [null, "null"]) {
    const headers: Record<string, string> = { "content-type": "application/csp-report" };
    if (origin) headers.origin = origin;
    const forwarded = await proxy(new NextRequest(`${ORIGIN}${CSP_REPORT_PATH}`, { body: "[]", headers, method: "POST" }));
    assert.notEqual(forwarded.status, 403, `🔴 a report with Origin ${String(origin)} must reach the route, or the measurement misses it`);
  }
  const forged = await proxy(new NextRequest(`${ORIGIN}/api/telemetry/page-timing`, { body: "[]", headers: { origin: "null" }, method: "POST" }));
  assert.equal(forged.status, 403, "only the report route is exempt — every other POST keeps its origin check");

  const route = readFileSync(new URL("../app/api/security/csp-report/route.ts", import.meta.url), "utf8");
  assert.ok(!/supabase|getSession|cookies\(/i.test(route), "🔴 the report route reads no session and touches no database");
  const registry = readFileSync(new URL("../src/lib/security/access-registry.ts", import.meta.url), "utf8");
  assert.ok(registry.includes('authMode: "public-token", methods: ["POST"], pattern: "/api/security/csp-report"'), "the report route is registered as a public POST");
}
