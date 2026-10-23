import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The owner, 2026-09-19: pressing a comment notice's link "bounces me to the employee portal ... then
// the recruitment module and not the comment". The page-level redirect was correct but arrives after
// the portal's loading shell has painted (app/employee-portals/loading.tsx), so the fix has to answer
// with a real HTTP 307 from proxy.ts. These tests call the real `proxy()` with real requests and read
// the response the browser would get — the source is only pinned where a request cannot reach.

process.env.PHOENIX_AUTH_SECRET ??= "portal-candidates-redirect-test-secret";

const { NextRequest } = await import("next/server");
const { proxy } = await import("../proxy.ts");
const { createSessionToken, phoenixSessionCookieName } = await import("../src/lib/auth/session-token.ts");
const { PORTAL_CANDIDATES_PROXY_ROLES, resolvePortalCandidatesRedirectPath } = await import(
  "../src/lib/recruitment/portal-candidates-redirect.ts"
);
const { adminTwinOfPortalCandidatesHref } = await import("../src/lib/recruitment/candidate-page-link.ts");
const { systemAdministratorRoles } = await import("../src/lib/auth/permissions.ts");

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const ORIGIN = "https://phoenix-hr.satopharma.com";
const PORTAL_LIST = "/employee-portals/recruitment-candidates";
const CANDIDATE = "3f2a9c1e-7b64-4d08-9a5e-1c2b3d4e5f60";

type Role = Parameters<typeof createSessionToken>[0]["role"];

function tokenFor(role: Role, maxAgeSeconds = 3600) {
  return createSessionToken({
    hrId: "HR-0001",
    loginId: "portal.candidates.redirect.test",
    maxAgeSeconds,
    role,
    sessionId: "portal-candidates-redirect-test-session",
    sessionVersion: 1,
  });
}

function requestFor(path: string, cookieValue?: string, method = "GET") {
  return new NextRequest(`${ORIGIN}${path}`, {
    headers: cookieValue ? { cookie: `${phoenixSessionCookieName}=${cookieValue}` } : {},
    method,
  });
}

/** What the browser is told, split into the two cases that matter: sent elsewhere, or let through. */
function answer(response: Response) {
  const location = response.headers.get("location");
  return {
    location: location ? new URL(location) : null,
    passedThrough: response.headers.get("x-middleware-next") === "1",
    status: response.status,
  };
}

export function runPortalCandidatesProxyRedirectTests() {
  const superAdmin = tokenFor("Super Admin");

  // ── The headline: a true 307 to the candidate, before any page renders ────────────────────────
  const named = answer(proxy(requestFor(`${PORTAL_LIST}?candidate=${CANDIDATE}`, superAdmin)));
  assert.equal(
    named.status,
    307,
    "the Super Admin's press on the notice's link is answered by the PROXY with a 307 — a page redirect under the portal's loading.tsx paints the portal first, which is the bounce he reported",
  );
  assert.equal(named.location?.pathname, `/recruitment/candidate/${CANDIDATE}`, "it lands on the candidate the notice is about");
  assert.equal(named.location?.origin, ORIGIN, "the redirect stays on the same host");
  assert.equal(named.location?.search, "", "the link's own query is not carried to the admin page");
  assert.equal(named.passedThrough, false, "a redirected request is not also forwarded to render");

  const namedResponse = proxy(requestFor(`${PORTAL_LIST}?candidate=${CANDIDATE}`, superAdmin));
  assert.equal(
    namedResponse.headers.get("cache-control"),
    "private, no-store, max-age=0",
    "the answer depends on the session cookie, so nothing between the server and the browser may hold it",
  );

  // A notice sent before the id was added, and any edited link, still avoids the portal entirely.
  for (const search of ["", "?candidate=", "?candidate=not-a-uuid", "?candidate=../../admin", "?other=1"]) {
    const bare = answer(proxy(requestFor(`${PORTAL_LIST}${search}`, superAdmin)));
    assert.equal(bare.status, 307, `${search || "a bare link"}: still a 307 straight out of the portal`);
    assert.equal(bare.location?.pathname, "/recruitment", `${search || "a bare link"}: the hub, never an id it cannot vouch for`);
  }
  assert.equal(
    answer(proxy(requestFor(`${PORTAL_LIST}?candidate=${CANDIDATE.toUpperCase()}`, superAdmin))).location?.pathname,
    `/recruitment/candidate/${CANDIDATE}`,
    "an upper-cased id is the same candidate and is sent to the lower-cased page",
  );
  assert.equal(
    answer(proxy(requestFor(`${PORTAL_LIST}?candidate=${CANDIDATE}&candidate=ignored`, superAdmin))).location?.pathname,
    `/recruitment/candidate/${CANDIDATE}`,
    "a repeated parameter uses the first one, the way the page does",
  );
  assert.equal(
    answer(proxy(requestFor(`${PORTAL_LIST}?candidate=${CANDIDATE}`, superAdmin, "HEAD"))).status,
    307,
    "HEAD is answered like GET",
  );

  // ── Everyone else is left to the page, exactly as before ──────────────────────────────────────
  for (const role of ["CEO", "HR Advisory", "HR Operations", "Medical Rep", "District Manager"] as const) {
    const other = answer(proxy(requestFor(`${PORTAL_LIST}?candidate=${CANDIDATE}`, tokenFor(role))));
    assert.equal(other.location, null, `${role}: the proxy must not decide for a role whose answer needs the permission matrix`);
    assert.equal(other.passedThrough, true, `${role}: the request carries on to the page`);
  }

  // No session, a forged one, an expired one: never a redirect chosen from an unverified cookie. Since
  // the performance brief (2026-10-23) such a request is sent to sign in by the proxy itself
  // (`signedOutPageRedirectResponse`) — to /login, never to the candidate the payload would pick.
  const signIn = (cookieValue?: string) =>
    answer(proxy(requestFor(`${PORTAL_LIST}?candidate=${CANDIDATE}`, cookieValue))).location?.pathname ?? null;
  assert.equal(signIn(), "/login", "no cookie: sent to sign in, never to the candidate");
  assert.equal(
    signIn(`${superAdmin}x`),
    "/login",
    "a signature that does not verify must not be believed, whatever role the payload claims",
  );
  assert.equal(signIn("not-a-real-token"), "/login", "an unsigned string is not a session");
  assert.equal(signIn(tokenFor("Super Admin", -60)), "/login", "an expired token is not a session");

  // Only this address, only a read.
  assert.equal(
    answer(proxy(requestFor(`${PORTAL_LIST}?candidate=${CANDIDATE}`, superAdmin, "POST"))).location,
    null,
    "a mutation is never redirected — that would drop its body and dodge the CSRF rule",
  );
  for (const path of ["/employee-portals", "/employee-portals/recruitment", "/recruitment/candidates", "/employee-portals/recruitment-candidates/x"]) {
    assert.equal(answer(proxy(requestFor(path, superAdmin))).location, null, `${path} is not the link this redirect is for`);
  }

  // ── The pure decision, and the two places that must agree about it ─────────────────────────────
  assert.equal(resolvePortalCandidatesRedirectPath(undefined, CANDIDATE), null, "no cookie decides nothing");
  assert.equal(resolvePortalCandidatesRedirectPath(superAdmin, [CANDIDATE, "x"]), `/recruitment/candidate/${CANDIDATE}`, "an array takes its first value");
  for (const candidate of [CANDIDATE, undefined, "", "junk"]) {
    assert.equal(
      resolvePortalCandidatesRedirectPath(superAdmin, candidate),
      adminTwinOfPortalCandidatesHref({ canOpenPersonalInbox: true, canOpenRecruitment: true, candidateId: candidate }),
      "the proxy and the page send the Super Admin to the same place — one decision, in two layers",
    );
  }
  for (const role of PORTAL_CANDIDATES_PROXY_ROLES) {
    assert.ok(
      (systemAdministratorRoles as readonly string[]).includes(role),
      `${role}: the proxy may forward only roles whose page answer never depends on the permission matrix`,
    );
  }

  // ── Wiring that a request cannot show ─────────────────────────────────────────────────────────
  const proxySource = read("proxy.ts");
  const securityPaths = proxySource.slice(
    proxySource.indexOf("function isSecurityProxyPath"),
    proxySource.indexOf("export function proxy"),
  );
  assert.ok(securityPaths.includes("/api"), "sanity: this is the CSRF path list");
  assert.ok(
    !securityPaths.includes("employee-portals"),
    "the redirect is called from proxy() directly — adding the portal to isSecurityProxyPath would widen the CSRF rule to a page",
  );
  const body = proxySource.slice(proxySource.indexOf("export function proxy"));
  assert.ok(
    body.indexOf("portalCandidatesRedirectResponse(request)") > 0 &&
      body.indexOf("portalCandidatesRedirectResponse(request)") < body.indexOf("isHrRewritablePath(pathname)"),
    "the redirect is decided before the /hr rewrite, so nothing renders first",
  );

  // The page keeps its own redirect for the roles the proxy leaves alone.
  const page = read("app/employee-portals/recruitment-candidates/page.tsx");
  assert.ok(
    page.includes("adminTwinOfPortalCandidatesHref(") && page.includes('redirect("/overview")'),
    "the page's own redirect stays as the fallback for every role the proxy does not cover",
  );
}
