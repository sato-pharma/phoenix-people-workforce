import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request as httpRequest, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";

// React #418 on Employees (31 Oct 2026). Behind Cloudflare, Email Address Obfuscation rewrote every
// work email in the directory's server HTML into "[email protected]" plus a decode script the page
// policy refuses, so hydration found different text on every load. Cloudflare leaves a response
// marked `Cache-Control: no-transform` alone, and the proxy now marks every page with it. These
// tests call the real `proxy()` with real requests and read what the browser would get; Next.js's
// own promise to keep that header is read from the installed Next.js, because a request cannot
// reach it.
//
// 🔴 ONLY BEHIND CLOUDFLARE (12 Nov 2026, "make the Ranks and Visits pages fast"). `no-transform` also
// stops Next.js's own compression, so from 31 Oct every page went out as raw HTML (Ranks 1.7 MB, My
// Visits 0.9 MB) while production no longer sat behind the proxy at all. A request Cloudflare forwarded
// carries `cf-ray` and still gets `no-transform`; a page served directly gets Next's own value and is
// compressed. Both halves are pinned below, the second against the compression middleware itself.

process.env.PHOENIX_AUTH_SECRET ??= "page-cache-control-test-secret";

const { NextRequest } = await import("next/server");
const { proxy } = await import("../proxy.ts");
const { PAGE_CACHE_CONTROL, PAGE_CACHE_CONTROL_DIRECT } = await import("../src/lib/security/page-cache-control.ts");

const ORIGIN = "https://phoenix-hr.satopharma.com";
const requireFromHere = createRequire(import.meta.url);

/** A request as Cloudflare forwards it: it stamps `cf-ray` on every request it proxies to the origin. */
const VIA_CLOUDFLARE = { "cf-ray": "8f1c2d3e4a5b6c7d-CDG" };

function forwarded(path: string, extraHeaders: Record<string, string> = VIA_CLOUDFLARE) {
  return proxy(
    new NextRequest(`${ORIGIN}${path}`, {
      // Signs in without a cookie, so the page is forwarded rather than sent to /login.
      headers: { authorization: "Bearer page-cache-control-test", ...extraHeaders },
    }),
  );
}

const PAGES = [
  "/employees",
  "/hr/employees",
  "/employee-360",
  "/login",
  "/employee-portals/submit-expense",
  "/employee-portals/ranks",
  "/employee-portals/visits",
];

function testEveryPageIsMarkedNoTransform() {
  for (const path of PAGES) {
    const response = forwarded(path);
    assert.equal(
      response.headers.get("cache-control"),
      PAGE_CACHE_CONTROL,
      `🔴 ${path}: a page must answer no-transform, or Cloudflare rewrites its email addresses and React #418 returns`,
    );
  }
}

function testAPageServedDirectlyCanBeCompressed() {
  for (const path of PAGES) {
    const value = forwarded(path, {}).headers.get("cache-control");
    assert.equal(
      value,
      PAGE_CACHE_CONTROL_DIRECT,
      `🔴 ${path}: served straight from Railway (no cf-ray), a page must NOT carry no-transform — Next.js's compression refuses it, and every phone downloads the raw HTML (Ranks was 1.7 MB)`,
    );
    assert.doesNotMatch(value ?? "", /no-transform/);
  }
}

/** Runs Next's own compression middleware on a local server and reports what a gzip-accepting browser gets. */
async function encodingFor(cacheControl: string): Promise<string | null> {
  const compression = requireFromHere("next/dist/compiled/compression") as () => (
    req: unknown,
    res: unknown,
    next: () => void,
  ) => void;
  const compress = compression();
  const body = "<p>Phoenix Ranks</p>".repeat(2000);
  const server = createServer((req, res) => {
    compress(req, res, () => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", cacheControl);
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise<string | null>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/", headers: { "accept-encoding": "gzip" } }, (res) => {
        res.resume();
        res.on("end", () => resolve((res.headers["content-encoding"] as string | undefined) ?? null));
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testNextsCompressionIsWhyTheDirectValueMatters() {
  assert.equal(
    await encodingFor(PAGE_CACHE_CONTROL_DIRECT),
    "gzip",
    "🔴 a page served directly must come out of Next.js's compression gzipped",
  );
  assert.equal(
    await encodingFor(PAGE_CACHE_CONTROL),
    null,
    "Next.js's compression refuses a no-transform response — the reason no-transform is kept to requests Cloudflare forwarded. If this ever reads gzip, an upgrade changed it and the split can be revisited",
  );
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
  assert.equal(
    PAGE_CACHE_CONTROL_DIRECT,
    getCacheControlHeader({ revalidate: 0, expire: undefined }),
    "🔴 served directly, the page answers exactly what Next.js would send for a dynamic page: never cached, by anyone",
  );
}

function testApisAndFilesAreLeftToTheirOwnHeaders() {
  for (const path of ["/api/employees", "/api/healthz", "/manifest.json"]) {
    for (const headers of [VIA_CLOUDFLARE, {}]) {
      assert.equal(
        forwarded(path, headers).headers.get("cache-control"),
        null,
        `${path}: not a page — the route or the file decides its own caching`,
      );
    }
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
  testAPageServedDirectlyCanBeCompressed();
  await testNextsCompressionIsWhyTheDirectValueMatters();
  testTheValueIsNextsOwnDynamicPagePlusNoTransform();
  testApisAndFilesAreLeftToTheirOwnHeaders();
  testARedirectKeepsItsOwnHeader();
  testNextKeepsAHeaderTheProxySet();
}
