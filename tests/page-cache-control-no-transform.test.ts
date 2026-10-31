import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// React #418 on Employees (31 Oct 2026). Behind Cloudflare, Email Address Obfuscation rewrote every
// work email in the directory's server HTML into "[email protected]" plus a decode script the page
// policy refuses, so hydration found different text on every load. Cloudflare leaves a response
// marked `Cache-Control: no-transform` alone, and the proxy now marks every page with it. These
// tests call the real `proxy()` with real requests and read what the browser would get; Next.js's
// own promise to keep that header is read from the installed Next.js, because a request cannot
// reach it.

process.env.PHOENIX_AUTH_SECRET ??= "page-cache-control-test-secret";

const { NextRequest } = await import("next/server");
const { proxy } = await import("../proxy.ts");
const { PAGE_CACHE_CONTROL } = await import("../src/lib/security/page-cache-control.ts");

const ORIGIN = "https://phoenix-hr.satopharma.com";
const requireFromHere = createRequire(import.meta.url);

function forwarded(path: string) {
  return proxy(
    new NextRequest(`${ORIGIN}${path}`, {
      // Signs in without a cookie, so the page is forwarded rather than sent to /login.
      headers: { authorization: "Bearer page-cache-control-test" },
    }),
  );
}

function testEveryPageIsMarkedNoTransform() {
  for (const path of ["/employees", "/hr/employees", "/employee-360", "/login", "/employee-portals/submit-expense"]) {
    const response = forwarded(path);
    assert.equal(
      response.headers.get("cache-control"),
      PAGE_CACHE_CONTROL,
      `🔴 ${path}: a page must answer no-transform, or Cloudflare rewrites its email addresses and React #418 returns`,
    );
  }
}

function testTheValueIsNextsOwnDynamicPagePlusNoTransform() {
  const { getCacheControlHeader } = requireFromHere("next/dist/server/lib/cache-control.js") as {
    getCacheControlHeader: (value: { revalidate: number; expire: undefined }) => string;
  };
  assert.equal(
    PAGE_CACHE_CONTROL,
    `${getCacheControlHeader({ revalidate: 0, expire: undefined })}, no-transform`,
    "🔴 the proxy's header replaces the one Next.js would send, so apart from no-transform it must say exactly the same: never cached, by anyone",
  );
}

function testApisAndFilesAreLeftToTheirOwnHeaders() {
  for (const path of ["/api/employees", "/api/healthz", "/manifest.json"]) {
    assert.equal(
      forwarded(path).headers.get("cache-control"),
      null,
      `${path}: not a page — the route or the file decides its own caching`,
    );
  }
}

function testARedirectKeepsItsOwnHeader() {
  // No session at all: a signed-in page is answered with a 307 to /login that names its own Cache-Control.
  const response = proxy(new NextRequest(`${ORIGIN}/admin`));
  assert.equal(response.status, 307, "a signed-out page is redirected by the proxy");
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0", "the redirect keeps the value it set");
}

function testNextKeepsAHeaderTheProxySet() {
  const sendPayload = readFileSync(requireFromHere.resolve("next/dist/server/send-payload.js"), "utf8");
  assert.ok(
    sendPayload.includes("cacheControl && !res.getHeader('Cache-Control')"),
    "🔴 Next.js must still keep a Cache-Control already on the response — if an upgrade overwrites it, no-transform is lost and Cloudflare rewrites email addresses again",
  );
}

export async function runPageCacheControlNoTransformTests() {
  testEveryPageIsMarkedNoTransform();
  testTheValueIsNextsOwnDynamicPagePlusNoTransform();
  testApisAndFilesAreLeftToTheirOwnHeaders();
  testARedirectKeepsItsOwnHeader();
  testNextKeepsAHeaderTheProxySet();
}
