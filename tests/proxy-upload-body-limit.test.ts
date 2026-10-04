// The two device upload routes must stay OUT of the proxy matcher, and must keep their own guards.
//
// WHY THIS EXISTS. When the proxy matches a request, Next copies the request body so the proxy could
// read it, and stops copying at `proxyClientMaxBodySize` — 10 MB by default (next 16.3.8,
// `next/dist/server/config-shared.js`). The route then receives a body cut off at 10 MB with only a
// console warning, `request.formData()` throws, and `/api/devices/headwind/upload` answers "Choose a
// file to send." — for any APK over 10 MB, which is every APK. Measured on staging 2026-10-04: an
// 11 MB POST logged `Request body exceeded 10MB for /api/devices/headwind/upload. Only the first
// 10MB will be available`. Production `audit_logs` held zero `application-upload` / `file-upload`
// rows: no device upload had ever succeeded.
//
// The fix excludes ONLY those two paths from the matcher. This file pins that, and pins the other
// half that makes the exclusion safe: both routes still run the same-origin test and the
// `company_devices:approve` check BEFORE they read the body — the proxy's CSRF rule was the second
// layer, never the only one. It also pins that the limit is NOT raised globally: that would make the
// proxy buffer up to that much of ANY request body, on any path, before authentication.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { config } from "../proxy.ts";
import { stripComments } from "./support/comment-strip.ts";

const UPLOAD_PATHS = ["/api/devices/headwind/upload", "/api/devices/manageengine/apps/upload"] as const;
const UPLOAD_ROUTES = [
  "app/api/devices/headwind/upload/route.ts",
  "app/api/devices/manageengine/apps/upload/route.ts",
] as const;

/**
 * Compiles each matcher with Next's own path parser, so the test asks Next's regex and not ours.
 * Only the parser is loaded: `get-page-static-info`, which wraps it with the `_next/data` prefix and the
 * `.rsc` suffix, drags in server code that throws at load outside a running server. The prefix and
 * suffix only widen what matches around the pathname, never the lookahead under test.
 */
function compileMatchers(): RegExp[] {
  const requireFromRepo = createRequire(import.meta.url);
  const { tryToParsePath } = requireFromRepo("next/dist/lib/try-to-parse-path") as {
    tryToParsePath: (path: string) => { regexStr?: string; error?: unknown };
  };
  return config.matcher.map((source) => {
    const parsed = tryToParsePath(source);
    assert.ok(parsed.regexStr, "Next could not parse proxy.ts's matcher — the harness or the matcher is broken");
    return new RegExp(parsed.regexStr);
  });
}

function proxyRuns(matchers: RegExp[], pathname: string): boolean {
  return matchers.some((matcher) => matcher.test(pathname));
}

export function runProxyUploadBodyLimitTests() {
  const matchers = compileMatchers();

  // ── 1. the two upload routes are not seen by the proxy, so their body is never cut at 10 MB ──
  for (const path of UPLOAD_PATHS) {
    assert.equal(
      proxyRuns(matchers, path),
      false,
      `${path} is matched by the proxy — its body would be truncated at the 10 MB clone limit and every APK upload would fail`,
    );
  }

  // ── 2. nothing else was excluded: siblings, look-alikes, children and every other API stay covered ──
  const stillCovered = [
    "/",
    "/admin",
    "/hr/devices",
    "/api/employees",
    "/api/devices",
    "/api/devices/headwind",
    "/api/devices/headwind/actions",
    "/api/devices/headwind/apps",
    "/api/devices/headwind/wipe",
    "/api/devices/manageengine",
    "/api/devices/manageengine/apps",
    "/api/devices/import/confirm",
    "/api/devices/import/dry-run",
    // an exclusion anchored with `$` must not swallow a longer path that merely starts the same way
    "/api/devices/headwind/uploads",
    "/api/devices/headwind/upload/extra",
    "/api/devices/manageengine/apps/upload-extra",
    "/api/devices/manageengine/apps/upload/extra",
  ];
  for (const path of stillCovered) {
    assert.equal(proxyRuns(matchers, path), true, `${path} must still pass through the proxy`);
  }
  for (const path of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico", "/icon.png", "/apple-icon.png"]) {
    assert.equal(proxyRuns(matchers, path), false, `${path} was already excluded and must stay so`);
  }

  // The exclusion list under /api is exactly the two upload routes — a third entry is a decision to
  // make on purpose (it drops the proxy's header stripping and CSRF layer for that path), not drift.
  const source = config.matcher.join("|");
  const excludedApiPaths = [...source.matchAll(/\|(api\/[^|)$]+)\$/g)].map((hit) => `/${hit[1]}`).sort();
  assert.deepEqual(
    excludedApiPaths,
    [...UPLOAD_PATHS].sort(),
    "the only /api paths left out of the proxy matcher must be the two device upload routes",
  );

  // ── 3. the exclusion is safe because each route guards ITSELF, in the right order, before the body ──
  for (const file of UPLOAD_ROUTES) {
    const code = stripComments(readFileSync(file, "utf8"));
    const csrf = code.indexOf("assertSameOriginMutation(request)");
    const permission = code.indexOf('assertPermission(access, "company_devices", "approve")');
    const body = code.indexOf("request.formData()");
    assert.ok(csrf >= 0, `${file} must call assertSameOriginMutation(request) — the proxy no longer does it for this path`);
    assert.ok(permission >= 0, `${file} must require company_devices:approve — the proxy never did, and is no longer in front of it`);
    assert.ok(body >= 0, `${file} no longer reads request.formData() — this test's premise needs re-reading`);
    assert.ok(csrf < permission, `${file} must check same-origin BEFORE the permission, as the proxy's CSRF rule did`);
    assert.ok(permission < body, `${file} must authorise the caller BEFORE it reads the uploaded body`);
  }

  // ── 4. the global limit is NOT raised — that would be the unauthenticated-buffering hole ──────
  const nextConfig = stripComments(readFileSync("next.config.ts", "utf8"));
  assert.ok(
    !/proxyClientMaxBodySize|middlewareClientMaxBodySize/.test(nextConfig),
    "next.config.ts must not raise the proxy body limit: it would let any unauthenticated request make the proxy hold that much body on any path. Exclude the path from the matcher instead.",
  );
}
