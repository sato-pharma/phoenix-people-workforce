import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { canReviewDisputes } from "../src/lib/attendance/digest-service.ts";
import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";
import {
  assertPageOpenForRole,
  fencedPageRedirect,
  isPageFencedForRole,
  SEAT_PAGE_FENCES,
} from "../src/lib/auth/seat-page-fences.ts";
import { SIGN_OUT_FAILED_MESSAGE, signOutAndLeave } from "../src/lib/auth/sign-out-client.ts";
import type { PhoenixRole } from "../src/lib/auth/permissions.ts";
import { clientAddress, isInternalAddress } from "../src/lib/security/client-address.ts";
import { ilikeContainsValue, ilikeExactValue } from "../src/lib/supabase/search-filter.ts";

/**
 * The access boundaries from the 2026-10-23 technical audit (PR B): the per-page seat fence (P7-06),
 * the compliance APIs (P7-01), the salary-blind dispute reviewer (P7-07), the scope read that failed
 * open (F-15), the filter injection (F-02), the caller's address (S-AUTH-05), the single-use setup
 * link (F-12) and sign-out (P7-03).
 */

function source(file: string): string {
  return readFileSync(file, "utf8");
}

function walk(dir: string, name: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, name, out);
    else if (entry.name === name) out.push(full.split(path.sep).join("/"));
  }
  return out;
}

/** `app/(admin)/employee-360/[hrId]/page.tsx` -> `/employee-360/[hrId]`. */
function routeOf(pageFile: string): string {
  return pageFile.replace(/^app/, "").replace(/\/\([^)]*\)/g, "").replace(/\/page\.tsx$/, "") || "/";
}

function redirectTarget(access: { role: PhoenixRole }, route: string): string | null {
  return fencedPageRedirect(access.role, route, resolveLandingPathForRole(access.role));
}

export async function runAccessBoundariesTests() {
  // ==== P7-06: every fenced page checks the fence itself ===========================================
  const fencedRoles = Object.keys(SEAT_PAGE_FENCES) as PhoenixRole[];
  const fencedPages = walk("app", "page.tsx").filter((file) =>
    fencedRoles.some((role) => isPageFencedForRole(role, routeOf(file))),
  );
  assert.ok(fencedPages.length >= 29, `the walk found the fenced pages (${fencedPages.length})`);
  for (const file of fencedPages) {
    assert.ok(
      source(file).includes(`guardSeatPage(access, "${routeOf(file)}");`),
      `HEADLINE: ${file} is fenced for a seat and must call guardSeatPage with its own route — the ` +
        "layout's check does not run when the user navigates inside the app",
    );
  }

  assert.equal(
    redirectTarget({ role: "HR Administration" }, "/attendance/disputes"),
    resolveLandingPathForRole("HR Administration"),
    "HEADLINE: the HR Operations Specialist is sent to her landing page from a fenced page",
  );
  assert.equal(redirectTarget({ role: "HR Administration" }, "/employee-360/[hrId]"), resolveLandingPathForRole("HR Administration"));
  assert.equal(redirectTarget({ role: "HR Resourcing" }, "/hr/cv-database"), resolveLandingPathForRole("HR Resourcing"));
  for (const role of fencedRoles) {
    assert.equal(isPageFencedForRole(role, resolveLandingPathForRole(role)), false, `${role} lands outside its own fence`);
  }
  assert.equal(redirectTarget({ role: "HR Resourcing" }, "/probation/dashboard"), null, "an open sibling stays open");
  assert.equal(redirectTarget({ role: "Super Admin" }, "/attendance/disputes"), null, "an unfenced seat passes");
  assert.equal(fencedPageRedirect("HR Resourcing", "/cv-database", "/cv-database"), "/employee-portals", "a fenced landing page never loops");
  assert.match(
    source("src/lib/auth/seat-page-guard.ts"),
    /const target = fencedPageRedirect\(access\.role, route, resolveLandingPathForRole\(access\.role\)\);\s*if \(target\) redirect\(target\);/,
    "guardSeatPage redirects on exactly that answer",
  );

  // ==== P7-01: the compliance APIs are fenced with their page ======================================
  const complianceRoutes = walk("app/api/admin/field-workforce-compliance", "route.ts");
  assert.equal(complianceRoutes.length, 6);
  for (const file of complianceRoutes) {
    const text = source(file);
    const handlers = (text.match(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g) ?? []).length;
    const fences = (text.match(/assertPageOpenForRole\(access\.role, "\/admin\/field-workforce-compliance"\);/g) ?? []).length;
    assert.ok(handlers > 0 && fences === handlers, `HEADLINE: every handler in ${file} refuses the fenced seat (${fences}/${handlers})`);
  }
  assert.throws(
    () => assertPageOpenForRole("HR Resourcing", "/admin/field-workforce-compliance"),
    /^Error: Forbidden:/,
    "Talent Acquisition is refused, as a 403",
  );

  // ==== P7-07: a salary-blind seat is never a dispute reviewer ======================================
  assert.equal(
    // No database here: reaching the reviewer list at all throws, and counts as not refused.
    await canReviewDisputes({ role: "HR Administration", hrId: "B-1" }).catch(() => "reached the reviewer list"),
    false,
    "HEADLINE: the HR Operations Specialist is refused before the reviewer list is even read",
  );

  // ==== F-15: the scope read fails closed ==========================================================
  assert.match(
    source("src/lib/auth/scope-visibility.ts"),
    /const \{ data, error \} = await supabase\s*\.from\("app_auth_users"\)[\s\S]{0,200}if \(error\) \{\s*throw new Error\(/,
    "HEADLINE: an unreadable scope override refuses instead of answering \"no override\" (the wider rule)",
  );

  // ==== F-02: search text is a quoted value, never filter grammar ==================================
  const hostile = 'ab,password_hash.like.$2b$12$x*,"),(x';
  const contains = ilikeContainsValue(hostile);
  assert.ok(contains && /^"%[\s\S]*%"$/.test(contains), "one quoted value");
  assert.ok(!/(^|[^\\])"/.test(contains!.slice(1, -1)), "HEADLINE: no unescaped quote inside, so the comma stays text");
  assert.ok(!contains!.slice(1, -1).includes("*"), "a wildcard is not passed through");
  assert.equal(ilikeExactValue("%*"), null, "nothing searchable left is no match, never no filter");
  assert.equal(ilikeExactValue("B-10"), '"B-10"');

  const messages = source("src/lib/internal-messages/service.ts");
  for (const raw of ["login_id.ilike.${query}", "email.ilike.${email}", "hr_id.ilike.${normalizedHrId || query}", "const pattern = `%${search}%`"]) {
    assert.ok(!messages.includes(raw), `internal messages no longer splice ${raw}`);
  }
  assert.match(messages, /const pattern = ilikeContainsValue\(search\);/);
  // The typed-email path no longer builds an `.or()` at all (audit point 3, 2026-10-26): it matches
  // employees.work_email through `.ilike()`, which takes the value as one filter argument, after the
  // shared wildcard cleaning — so there is still no PostgREST grammar for a typed value to escape.
  assert.match(messages, /const term = isEmail\(email\) \? searchableTerm\(email\) : null;/);
  assert.match(messages, /\.ilike\("work_email", term\)/);
  assert.ok(!/\.or\(`[^`]*\$\{(?:email|quotedEmail)\}/.test(messages), "no typed email is spliced into an .or() expression");
  assert.match(messages, /login_id\.ilike\.\$\{quotedLogin\},hr_id\.ilike\.\$\{quotedHrId\}/);
  const lookup = source("app/api/admin/outstation/employee-lookup/route.ts");
  assert.ok(!lookup.includes("const pattern = `%${query}%`"), "the outstation lookup no longer splices the query");
  assert.match(lookup, /const pattern = ilikeContainsValue\(query\);/);

  // ==== S-AUTH-05: the caller's address is the one the edge saw ====================================
  const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) });
  assert.equal(clientAddress(req({ "x-forwarded-for": "1.2.3.4, 41.33.10.7" })), "41.33.10.7", "HEADLINE: the caller-written left entry is ignored");
  assert.equal(clientAddress(req({ "x-forwarded-for": "1.2.3.4, 41.33.10.7, 10.4.0.9, 100.64.2.1" })), "41.33.10.7", "internal hops are skipped");
  assert.equal(clientAddress(req({ "x-forwarded-for": "41.33.10.7" })), "41.33.10.7");
  assert.equal(clientAddress(req({ "x-forwarded-for": "127.0.0.1" })), "127.0.0.1", "a local run keeps its address");
  assert.equal(clientAddress(req({ "x-real-ip": "41.33.10.7" })), "41.33.10.7");
  assert.equal(clientAddress(req({})), null);
  assert.equal(clientAddress(req({ "x-forwarded-for": "2001:db8::1, fd00::5" })), "2001:db8::1");
  for (const address of ["10.0.0.1", "172.20.1.1", "192.168.1.1", "169.254.1.1", "100.100.1.1", "::1", "fe80::1", "fd12::1", "::ffff:10.1.1.1"]) {
    assert.equal(isInternalAddress(address), true, `${address} is internal`);
  }
  for (const address of ["41.33.10.7", "172.32.0.1", "100.128.0.1", "2001:db8::1"]) {
    assert.equal(isInternalAddress(address), false, `${address} is public`);
  }
  const readers = [...walk("app", "route.ts"), ...walk("src", "route.ts")]
    .concat(walk("src", "audit.ts"), walk("src", "log.ts"), walk("src", "api-rate-limit.ts"))
    .filter((file) => /request\.headers\.get\("x-forwarded-for"\)/.test(source(file)));
  assert.deepEqual(readers, [], "nothing reads X-Forwarded-For except client-address.ts");

  // ==== F-12: the setup link is spent before the password is written ===============================
  const setup = source("src/lib/auth/password-setup.ts");
  const complete = setup.slice(setup.indexOf("export async function completePasswordSetup"));
  const claimAt = complete.search(/\.update\(\{ updated_at: now, used_at: now \}\)\s*\.eq\("token_hash", tokenRow\.token_hash\)\s*\.is\("used_at", null\)\s*\.select\("token_hash"\)/);
  const passwordAt = complete.indexOf("password_hash: passwordHash");
  assert.ok(claimAt > 0 && passwordAt > claimAt, "HEADLINE: one conditional update claims the link before the password write");
  assert.match(complete, /if \(!claimed \|\| claimed\.length === 0\) \{\s*throw new Error\("This password setup link has already been used\."\);/);

  // ==== P7-03: sign-out leaves only when the server answered =======================================
  const logout = source("app/api/auth/logout/route.ts");
  const sessionCookieCleared = logout.indexOf("cookieStore.delete(phoenixSessionCookieName);");
  assert.ok(
    sessionCookieCleared > 0 && sessionCookieCleared < logout.indexOf("await assertApiRateLimit("),
    "HEADLINE: the cookies are cleared before the rate limit can return",
  );
  assert.ok(!/status: 429/.test(logout), "a rate-limited sign-out still signs this browser out");
  // Audit point 14 (2026-10-26): the server-side session is revoked BEFORE the limiter is asked and
  // whatever it answers, and the page is told whether the revoke really happened. Until then a limited
  // sign-out returned `sessionRevoked: false` early and the stolen-cookie session stayed live.
  const revokeAt = logout.indexOf('revokeAppSession(session.sid, "logout")');
  assert.ok(
    revokeAt > 0 && revokeAt < logout.indexOf("await assertApiRateLimit("),
    "HEADLINE: the server-side session is revoked before the rate limit is asked",
  );
  assert.equal(logout.split("return NextResponse.json(").length - 1, 1, "one answer — the limiter cannot return early and skip the revoke");
  assert.ok(!/sessionRevoked: false/.test(logout), "the answer never claims a fixed revoke result");
  assert.match(logout, /return NextResponse\.json\(\{ sessionRevoked, success: true \}\);/, "the answer carries the real revoke result");
  assert.match(logout, /if \(session && auditAllowed\) \{\s*await writeAuthAudit\(/, "the limit guards the audit row only");

  const realFetch = globalThis.fetch;
  const realWindow = (globalThis as { window?: unknown }).window;
  const navigated: string[] = [];
  (globalThis as { window?: unknown }).window = { location: { assign: (url: string) => navigated.push(url) } };
  try {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    assert.equal(await signOutAndLeave(), false);
    assert.deepEqual(navigated, [], "HEADLINE: a sign-out that never reached the server does not go to /login");
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Forbidden." }), { status: 403 })) as typeof fetch;
    assert.equal(await signOutAndLeave(), false);
    assert.deepEqual(navigated, [], "nor does one the server refused");
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch;
    assert.equal(await signOutAndLeave(), true);
    assert.deepEqual(navigated, ["/login"], "a signed-out browser goes to /login");
  } finally {
    globalThis.fetch = realFetch;
    (globalThis as { window?: unknown }).window = realWindow;
  }
  assert.match(SIGN_OUT_FAILED_MESSAGE, /still signed in/);
  for (const file of ["src/components/layout/topbar.tsx", "src/components/employee-portal/employee-portal-layout.tsx"]) {
    const text = source(file);
    assert.ok(!text.includes('fetch("/api/auth/logout"'), `${file} signs out through signOutAndLeave only`);
  }
}
