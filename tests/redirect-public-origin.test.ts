import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { systemDeployment } from "../src/config/system-settings.ts";
import { trustedOriginForRedirect } from "../src/lib/security/origins.ts";
import { stripComments } from "./system-audit-routes-access.test.ts";

/**
 * NO REDIRECT IS BUILT ON `request.url`'s ORIGIN.
 *
 * Behind Railway's proxy `request.url` is the container's own listener, `https://0.0.0.0:8080/…`;
 * the public host arrives only on the forwarded header. `NextResponse.redirect(new URL(path,
 * request.url))` therefore sends the browser to an address that answers nothing. Two email links
 * did exactly that until 31 Oct 2026 — the closing-published "Open Phoenix Workforce" link
 * (`/api/sales/monthly-closing/go`, 7 times) and the probation notification link
 * (`/api/probation/redirect`, 6 times) — measured on production as `Location: https://0.0.0.0:8080/login`,
 * and the System Audit photographed each as a request with no answer. The Monthly Closing workbook
 * hit the same defect earlier (closing-workbook-link-origin.test.ts).
 *
 * Every redirect takes its origin from `trustedOriginForRedirect`, as sign-in always has; the path
 * and query may still be read from `request.url`, which is only wrong about its origin.
 */

const BASE_PATTERN = /new URL\([^;]*?,\s*(?:request|req)\.(?:url|nextUrl)\s*\)/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function runRedirectPublicOriginTests() {
  // ── The sweep: no URL in app/ is built on the request's own origin ─────────────────────────────
  const files = sourceFiles("app");
  assert.ok(files.length > 500, `the sweep must actually read the app tree (read ${files.length} files)`);
  const offenders: string[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const match of code.matchAll(BASE_PATTERN)) offenders.push(`${file.replaceAll("\\", "/")}: ${match[0]}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "a URL built on request.url's origin redirects to https://0.0.0.0:8080 in production — use trustedOriginForRedirect(request)",
  );

  // The pattern itself must catch the shapes that shipped, or the empty sweep above proves nothing.
  for (const shipped of [
    `NextResponse.redirect(new URL(destination, request.url))`,
    `const loginUrl = new URL("/login", request.url);`,
    `const dest = new URL("/employee-portals/probation", req.url);`,
  ]) {
    assert.equal([...shipped.matchAll(BASE_PATTERN)].length, 1, `the sweep must catch: ${shipped}`);
  }
  assert.equal([...`new URL(destination, trustedOriginForRedirect(request))`.matchAll(BASE_PATTERN)].length, 0);
  assert.equal([...`const { pathname, search } = new URL(request.url);`.matchAll(BASE_PATTERN)].length, 0, "reading the path is fine");

  // ── Both email links use the helper ────────────────────────────────────────────────────────────
  for (const route of ["app/api/sales/monthly-closing/go/route.ts", "app/api/probation/redirect/route.ts"]) {
    const code = stripComments(readFileSync(route, "utf8"));
    assert.match(code, /trustedOriginForRedirect\(request\)/, `${route} must take its origin from trustedOriginForRedirect`);
  }

  // ── The helper gives the public origin for the Railway shape ───────────────────────────────────
  const canonical = systemDeployment.productionUrl;
  const savedAllowed = process.env.PHOENIX_ALLOWED_ORIGINS;
  try {
    process.env.PHOENIX_ALLOWED_ORIGINS = canonical;
    const proxied = new Request("https://0.0.0.0:8080/api/probation/redirect?employeeHrId=B-12", {
      headers: { host: "0.0.0.0:8080", "x-forwarded-host": "phoenix-hr.satopharma.com", "x-forwarded-proto": "https" },
    });
    const location = new URL("/login", trustedOriginForRedirect(proxied)).href;
    assert.equal(location, `${canonical}/login`, "the probation link's sign-in redirect lands on the public domain");
    assert.doesNotMatch(location, /0\.0\.0\.0/, "the container's bind address never reaches a Location header");

    const bare = new Request("https://0.0.0.0:8080/api/sales/monthly-closing/go?line=CNS&period=2026-09", {
      headers: { host: "0.0.0.0:8080" },
    });
    assert.equal(trustedOriginForRedirect(bare), canonical, "with no forwarded host the link falls back to the production domain");
  } finally {
    if (savedAllowed === undefined) delete process.env.PHOENIX_ALLOWED_ORIGINS;
    else process.env.PHOENIX_ALLOWED_ORIGINS = savedAllowed;
  }
}
