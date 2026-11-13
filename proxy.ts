import { NextResponse, type NextRequest } from "next/server";

import { isNativeClientRequest } from "@/lib/auth/native-session";
import { resolveRootRedirectPath } from "@/lib/auth/root-landing";
import { phoenixSeatViewCookieName } from "@/lib/auth/seat-view-constants";
import { phoenixDevPreviewCookieName } from "@/lib/auth/dev-preview";
import { phoenixSessionCookieName, verifySessionToken } from "@/lib/auth/session-token";
import {
  TEST_DRY_RUN_HEADER,
  TEST_DRY_RUN_RESPONSE_HEADER,
  noteTestDryRunSeen,
  proxyMarksTestDryRun,
} from "@/lib/auth/test-dry-run-rules";
import { CANDIDATE_LINK_PARAM, PORTAL_CANDIDATES_PATH } from "@/lib/recruitment/candidate-page-link";
import { resolvePortalCandidatesRedirectPath } from "@/lib/recruitment/portal-candidates-redirect";
import {
  isNativeClientMutationRequest,
  isSameOriginMutationRequest,
  requiresCsrfProtection,
} from "@/lib/security/csrf";
import {
  CSP_NONCE_HEADER,
  CSP_REPORTING_ENDPOINTS,
  createCspNonce,
  pageContentSecurityPolicy,
  pageReportOnlyContentSecurityPolicy,
  shouldSendPageCsp,
} from "@/lib/security/content-security-policy";
import { logStructured } from "@/lib/observability/log";
import { pageCacheControlFor } from "@/lib/security/page-cache-control";
import {
  isAllowedPhoenixOrigin,
  normalizeOrigin,
} from "@/lib/security/origins";
import {
  PATH_HEADER,
  SHELL_HEADER,
  hrNamespaceRemainder,
  isHrRewritablePath,
  toHrNamespacePath,
} from "@/lib/navigation/shell-headers";

const builderPreviewOrigin = "https://builder.io";

const previewReadOnlyAllowedMutationPaths = new Set([
  "/api/admin/email-composer/preview",
  "/api/admin/email-composer/resolve-recipients",
  "/api/admin/email-reply/send",
  "/api/admin/email-templates/preview",
  "/api/admin/email-templates/simulate-recipients",
  "/api/admin/email-templates/test",
  "/api/admin/email-templates/validate-draft",
  "/api/auth/heartbeat",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/integrations/telegram/webhook",
]);

function isPreviewSourceOfSalesMutationPath(pathname: string) {
  return pathname === "/api/sales/monthly-import/validate" ||
    /^\/api\/sales\/monthly-import\/batches\/[^/]+$/.test(pathname) ||
    pathname === "/api/sales/source-of-sales/products" ||
    /^\/api\/sales\/source-of-sales\/products\/[^/]+$/.test(pathname);
}

function isPreviewEmailTemplateMutationPath(pathname: string) {
  return /^\/api\/admin\/email-templates\/[^/]+$/.test(pathname) ||
    /^\/api\/admin\/email-templates\/[^/]+\/rollback$/.test(pathname);
}

function isPreviewReadOnlyEnabled() {
  // Platform-neutral preview detection (previously used a Vercel-only env var that is
  // never set on Cloud Run). A preview deployment must set APP_ENV=preview AND opt in
  // with PHOENIX_PREVIEW_READ_ONLY=true.
  return (
    process.env.APP_ENV === "preview" &&
    process.env.PHOENIX_PREVIEW_READ_ONLY === "true"
  );
}

function isPreviewReadOnlyBlockedMutation(request: NextRequest) {
  if (!isPreviewReadOnlyEnabled() || !requiresCsrfProtection(request)) {
    return false;
  }

  return !previewReadOnlyAllowedMutationPaths.has(request.nextUrl.pathname) &&
    !isPreviewSourceOfSalesMutationPath(request.nextUrl.pathname) &&
    !isPreviewEmailTemplateMutationPath(request.nextUrl.pathname);
}

export function isPreviewBuilderLoginRequest(request: NextRequest) {
  if (
    request.method.toUpperCase() !== "POST" ||
    request.nextUrl.pathname !== "/api/auth/login" ||
    !isAllowedPhoenixOrigin(builderPreviewOrigin)
  ) {
    return false;
  }

  const originHeader = normalizeOrigin(request.headers.get("origin"));
  const refererOrigin = normalizeOrigin(request.headers.get("referer"));

  return originHeader === builderPreviewOrigin || refererOrigin === builderPreviewOrigin;
}

/**
 * Answer "/" with a real HTTP redirect instead of a JS-dependent one.
 *
 * Resolving the landing path here — before rendering — is what makes the redirect a true 307.
 * See src/lib/auth/root-landing.ts for why resolving it in app/page.tsx could not be.
 *
 * Fails OPEN by design: any throw (missing PHOENIX_AUTH_SECRET, malformed cookie) falls
 * through to app/page.tsx, which still performs the same redirect the slow way. The entry
 * point of a live HR platform must degrade to "slower" and never to a 500.
 */
function rootRedirectResponse(request: NextRequest) {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  if (request.nextUrl.pathname !== "/") return null;

  try {
    const destination = resolveRootRedirectPath(
      request.cookies.get(phoenixSessionCookieName)?.value,
    );
    const url = request.nextUrl.clone();
    url.pathname = destination;
    url.search = "";

    const response = NextResponse.redirect(url, 307);
    // The destination depends on the session cookie, so this response is per-user. Never let an
    // edge or intermediary hold it: a cached "/" -> /admin would be handed to signed-out visitors.
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch {
    return null;
  }
}

/**
 * Answer the portal's "My Candidates" link with a real HTTP redirect when its viewer is the Super
 * Admin, who lives in the admin shell.
 *
 * The page does the same thing, but `app/employee-portals/loading.tsx` makes the page's
 * `redirect()` arrive after the portal's loading shell has been painted (owner, 2026-09-19: "it
 * bounces me to the employee portal"). Only this file runs ahead of that shell — see
 * src/lib/recruitment/portal-candidates-redirect.ts. It is called from `proxy()` directly and NOT
 * added to `isSecurityProxyPath`, which would widen the CSRF rule to a page.
 *
 * Fails OPEN like `rootRedirectResponse`: anything unexpected falls through to the page, which
 * still redirects, only slower.
 */
function portalCandidatesRedirectResponse(request: NextRequest) {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  if (request.nextUrl.pathname !== PORTAL_CANDIDATES_PATH) return null;
  // During the Super Admin's View as Seat the page must show what the VIEWED seat sees; this shortcut
  // reads the real session's role and would send a manager's view away from its own candidates.
  if (request.cookies.get(phoenixSeatViewCookieName)?.value) return null;

  try {
    const destination = resolvePortalCandidatesRedirectPath(
      request.cookies.get(phoenixSessionCookieName)?.value,
      request.nextUrl.searchParams.getAll(CANDIDATE_LINK_PARAM),
    );
    if (!destination) return null;

    const url = request.nextUrl.clone();
    url.pathname = destination;
    url.search = "";

    const response = NextResponse.redirect(url, 307);
    // Per-user, like the root redirect: a cached answer would be handed to somebody else.
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch {
    return null;
  }
}

/**
 * A signed-in page whose request carries no usable session cookie is answered with a real 307 to
 * /login before anything renders (performance brief, 2026-10-23).
 *
 * WHY: the owner's screen recording that day measured about 8 s from opening a portal page on an
 * expired session to seeing the sign-in page. The layouts already send such a request to /login,
 * but only after the session bundle call, and `app/employee-portals/loading.tsx` (and the admin
 * group's) means the portal skeleton has painted first, so the redirect arrives late as an RSC
 * instruction rather than as the response itself — the same trap `rootRedirectResponse` describes.
 *
 * SECURITY: this only ever SENDS PEOPLE TO SIGN IN; it never lets anybody through. A cookie whose
 * signature and expiry pass `verifySessionToken` (a local HMAC check, no database) carries on to the
 * full server check exactly as before — nothing is trusted on the signature alone. Only a cookie
 * that is missing, forged, malformed or expired is turned away here, and the server would turn every
 * one of those away too (`resolveSessionState` starts with the same check). That stale cookie is
 * cleared on the way, so /login does not validate it a second time.
 *
 * The page they asked for rides along as `returnUrl` (owner, 2026-10-24: "back on that page"), so a
 * rep who opens a visit from a notification on an expired session lands on that visit after signing
 * in, not on the home page and one more navigation away. It is always this request's own path, and
 * the login page still admits only a same-site path (`safeReturnUrl` there and in the form).
 *
 * Left alone, so they keep the path they had:
 *  - GET/HEAD only, and only the two signed-in page trees (`/employee-portals`, `/admin`) — never
 *    `/api`, which answers 401 as JSON and must never receive an HTML redirect, and never the `/hr`
 *    spelling, which also rewrites public pages (`/hr/login`, `/hr/password-reset`);
 *  - a request with a bearer token or the native client header (the app authenticates by header);
 *  - local development with the dev-auth role headers or the dev preview cookie, which sign in
 *    without a session cookie;
 *  - the marketing-request decision page, which records its own "opened without a session" audit
 *    row and shows its own sign-in notice.
 *
 * Fails OPEN like the root redirect: a throw (for instance no PHOENIX_AUTH_SECRET) falls through to
 * the layouts, which still send the person to /login, only slower.
 */
const SIGNED_IN_PAGE_PREFIXES = ["/employee-portals", "/admin"] as const;

function isSignedInPagePath(pathname: string): boolean {
  if (pathname.startsWith("/employee-portals/marketing-requests/decision/")) return false;
  return SIGNED_IN_PAGE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function signsInWithoutSessionCookie(request: NextRequest): boolean {
  if (request.headers.get("authorization")) return true;
  if (isNativeClientRequest(request.headers)) return true;
  if (process.env.NODE_ENV === "development") {
    if (request.headers.get("x-phoenix-role") || request.headers.get("x-phoenix-hr-id")) return true;
    if (request.cookies.get(phoenixDevPreviewCookieName)?.value) return true;
  }
  return false;
}

function signedOutPageRedirectResponse(request: NextRequest) {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  if (!isSignedInPagePath(request.nextUrl.pathname)) return null;
  if (signsInWithoutSessionCookie(request)) return null;

  try {
    const sessionCookie = request.cookies.get(phoenixSessionCookieName)?.value;
    if (verifySessionToken(sessionCookie)) return null;

    const asked = new URLSearchParams(request.nextUrl.search);
    asked.delete("_rsc"); // a client navigation's cache-buster, not part of the page's address
    const askedQuery = asked.toString();

    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("returnUrl", `${request.nextUrl.pathname}${askedQuery ? `?${askedQuery}` : ""}`);

    const response = NextResponse.redirect(url, 307);
    // Per-user, like the root redirect: a cached answer must never be handed to somebody else.
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    if (sessionCookie !== undefined) {
      response.cookies.set({
        httpOnly: true,
        maxAge: 0,
        name: phoenixSessionCookieName,
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        value: "",
      });
    }
    return response;
  } catch {
    return null;
  }
}

/**
 * Everything this file did before the `/hr` namespace existed: the root 307, the preview
 * read-only wall, and CSRF protection.
 *
 * Returns a response ONLY when it must intervene; `null` means "carry on", which is what the
 * pass-through `NextResponse.next()` calls used to mean. Splitting it out this way is what lets
 * `proxy()` below widen its matcher to the whole app — needed to strip the forgeable shell
 * headers everywhere they could be believed — WITHOUT widening the CSRF rule, which is scoped by
 * its caller to exactly the paths the old matcher covered. `requiresCsrfProtection` keys on the
 * METHOD alone, so running this on every path would newly subject every server action (a POST to
 * a page URL) to the same-origin test. That is a live-behaviour change on a payroll system that
 * nobody asked for, so it does not happen.
 */
function securityProxy(request: NextRequest): NextResponse | null {
  const rootRedirect = rootRedirectResponse(request);
  if (rootRedirect) return rootRedirect;

  if (isPreviewReadOnlyBlockedMutation(request)) {
    return NextResponse.json(
      {
        error: "preview_read_only",
        message: "Preview is read-only. Mutations are disabled to protect production data.",
      },
      { status: 403 },
    );
  }

  if (isPreviewBuilderLoginRequest(request)) {
    return null;
  }

  if (
    request.method.toUpperCase() === "POST" &&
    (
      request.nextUrl.pathname === "/api/attendance/raw-punches" ||
      request.nextUrl.pathname === "/api/admin/synthetic-journeys/ingest" ||
      request.nextUrl.pathname === "/api/integrations/telegram/webhook" ||
      request.nextUrl.pathname === "/api/webhooks/resend" ||
      // Brevo transactional webhook: the provider POSTs cross-origin; a shared secret in the
      // Authorization: Bearer header (verified in the route; ?token= is refused) authorises it, so it is CSRF-exempt.
      request.nextUrl.pathname === "/api/webhooks/brevo" ||
      // Sentry alert webhook: Sentry POSTs cross-origin with no session; the route verifies the HMAC signature
      // of the body against SENTRY_WEBHOOK_SECRET itself, so it is CSRF-exempt by the same shared-secret pattern.
      request.nextUrl.pathname === "/api/webhooks/sentry" ||
      // WhatsApp Cloud API webhook: Meta POSTs cross-origin with no Origin/Referer header,
      // so it always fail-closed here (403) even with a correct X-Hub-Signature-256 — the
      // route verifies that signature itself, so this is CSRF-exempt by the same shared-secret
      // pattern as the other provider webhooks above.
      request.nextUrl.pathname === "/api/webhooks/whatsapp" ||
      // The Future Talents Portal claiming the WhatsApp videos it has copied: a server-to-server
      // POST with no Origin header, authorised by FTP_VIDEO_HANDOFF_SECRET inside the route, so it
      // is CSRF-exempt by the same shared-secret pattern as the provider webhooks above.
      request.nextUrl.pathname === "/api/integrations/ftp-videos" ||
      // The owner-only MCP source: the reporting reader POSTs server-to-server with no Origin header,
      // authorised by a dedicated bearer secret inside the route (which is also disabled unless
      // PHOENIX_MCP_SOURCE_ENABLED is "true"), so it is CSRF-exempt like the other shared-secret routes.
      request.nextUrl.pathname === "/api/mcp-source/authorize" ||
      // The robot service's four internal routes (audit REC-075): the WEBSITE POSTs them server to
      // server with no Origin header, after it has checked the Super Admin's session, CSRF, role and
      // rate limit itself. Each route checks the CRON_SECRET bearer and that it is running on the robot
      // service before it reads the body, so it is CSRF-exempt by the same shared-secret pattern.
      request.nextUrl.pathname.startsWith("/api/internal/mailbox-robot/") ||
      // RFC 8058 one-click unsubscribe: the mailbox provider POSTs cross-origin; the
      // signed token (not a session) authorises it, so it is CSRF-exempt by design.
      request.nextUrl.pathname.startsWith("/api/email/unsubscribe/") ||
      // The public careers-site application form (www.satopharma.com/careers) POSTs an applicant's
      // CV cross-origin. It has no session and no shared secret — a public page cannot hold one — so
      // it stands on reCAPTCHA + a per-IP rate limit, both verified inside the route. CSRF-exempt for
      // the same reason the provider webhooks are: the authorisation lives in the route, not a cookie.
      request.nextUrl.pathname === "/api/public/apply" ||
      // Report-only content security policy reports: the BROWSER sends them itself, a report-uri POST
      // often with no Origin or Referer and a sandboxed frame's with `Origin: null`. The route reads no
      // session and writes no database (it counts a directive, an origin and a page shape in memory),
      // so there is nothing for a cross-site request to forge.
      request.nextUrl.pathname === "/api/security/csp-report"
    )
  ) {
    return null;
  }

  if (!requiresCsrfProtection(request)) {
    return null;
  }

  // The login route is the one native mutation a stale cookie must not block. It authenticates from
  // the request BODY (loginId + password), not a session cookie — `resolveAccessContext` never runs
  // for it, so the ambient-authority risk that `isNativeClientMutationRequest`'s no-cookie clause
  // guards against is simply absent here. That clause otherwise refuses every login after the first:
  // React Native's Android networking persists the `phoenix_session` cookie the login response sets
  // and re-sends it on the next login, and a login carrying that cookie fails the no-cookie clause
  // (measured against production 2026-09-23 — a rep's second sign-in returned `csrf_blocked`). A
  // cross-site browser cannot reach this branch: it cannot set `x-phoenix-client` (not CORS-safelisted,
  // no preflight answered), and the login route runs its own `rejectUntrustedForwardedOrigin` check.
  if (request.nextUrl.pathname === "/api/auth/login" && isNativeClientRequest(request.headers)) {
    return null;
  }

  // The native app, which sends no Origin because it is not a browser. Checked BEFORE the origin
  // test rather than folded into it, so `isSameOriginMutationRequest` keeps answering exactly the
  // question its name asks. See `isNativeClientMutationRequest` for why this is not a weakening —
  // in short, the header cannot be set cross-site and a cookie request never qualifies.
  if (isNativeClientMutationRequest(request.headers)) {
    return null;
  }

  if (!isSameOriginMutationRequest(request)) {
    // 🔴 SAY WHICH ORIGIN WAS REFUSED. Before this line the guard returned a bare 403 and recorded
    // NOTHING, anywhere — not here, not in `app_error_events` (which stores a path and no host),
    // and not in the database, which has no origin/referer/host column at all. So a person whose
    // every save was being refused produced no evidence of it: reads worked, the app looked
    // healthy, and the only way to find out was to ask them what their address bar said. That is
    // the position this was written from, and it is not one a security control should create.
    //
    // A guard that fires silently cannot be diagnosed. WARNING, not ERROR: a genuine cross-site
    // attempt is this working correctly, so it must not page anybody — it is here to be searchable.
    logStructured("WARNING", "Cross-site mutation blocked", {
      labels: { event: "csrf_blocked" },
      context: {
        method: request.method,
        path: request.nextUrl.pathname,
        // The three headers the decision is actually made from, so the log answers WHY and not
        // merely THAT. Normalized to an origin, so no path or query string is ever recorded.
        origin: normalizeOrigin(request.headers.get("origin")) ?? null,
        referer: normalizeOrigin(request.headers.get("referer")) ?? null,
        host: request.headers.get("host"),
      },
    });
    return NextResponse.json(
      { error: "csrf_blocked", message: "Cross-site mutation request blocked." },
      { status: 403 },
    );
  }

  return null;
}

/**
 * The paths `securityProxy` covered before the `/hr` namespace widened the matcher. Kept as an
 * explicit list rather than inherited from `config.matcher`, because the two now differ on
 * purpose and the difference is the whole point: the matcher decides where headers are stripped,
 * this decides where the CSRF rule applies. `/hr/api/**` is absent because it never resolves to
 * an API route — see `isHrRewritablePath`.
 */
function isSecurityProxyPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    /^\/offers\/[^/]+\/(accept|reject)$/.test(pathname)
  );
}

/**
 * Whether this invocation is `next dev` running us a SECOND time, on the path our own `/hr` rewrite
 * pointed at — in which case the two headers on the request are the ones we wrote on the first run
 * and must be left exactly as they are.
 *
 * 🔴 `next dev` (Next 16.3.8) re-runs the proxy on a rewrite's destination; `next start` on Railway
 * does not. So the second run arrived on `/admin/hr-command-center`, deleted the `x-phoenix-shell:
 * hr` IT HAD JUST WRITTEN, and overwrote `x-phoenix-path` with the bare path — after which AppShell
 * believed the browser had asked for the bare address and redirected it back onto `/hr/…`, which was
 * rewritten, which re-ran the proxy: **every `/hr` page 307'd to itself forever** for HR Operations
 * and HR Resourcing, and every other role silently got ADMIN chrome on an `/hr` address. Production
 * was never affected — measured the same day: 1,566 `/hr/%` page views for HR Operations, the last
 * at 17:02 Cairo, and 42 for HR Resourcing on this very page (2026-10-12).
 *
 * This is NOT a hole in the anti-forgery delete below, because the inbound pair is honoured only
 * when `x-phoenix-path` is EXACTLY this path with the `/hr` prefix on it — the one value our own
 * rewrite could have produced:
 *  - the seat fences normalize the `/hr` prefix away before they test a path
 *    (`normalizePagePath`), so a forged pair cannot move a page out of its fence;
 *  - `SHELL_HEADER` selects CHROME and never access (`resolveShellNavigationMode`), and every page
 *    behind the shell re-asserts its own grant server-side;
 *  - GET/HEAD only, so no mutation can skip `securityProxy` — every guard in there except the root
 *    redirect is scoped to mutating methods, and the root redirect is exactly what must not run a
 *    second time (it is what turned `/hr` into a 307 to `/login`);
 *  - `/hr/api/**` is not rewritable, so an API path can never claim re-entry at all.
 */
function isOwnRewriteReentry(request: NextRequest, pathname: string, search: string): boolean {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (request.headers.get(SHELL_HEADER) !== "hr") return false;

  const namespaced = toHrNamespacePath(pathname);
  if (!isHrRewritablePath(namespaced)) return false;

  return request.headers.get(PATH_HEADER) === `${namespaced}${search}`;
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Our own rewrite, handed back to us by the dev server. Everything below has already run once on
  // the address the browser actually asked for; running it again on the rewritten path is the bug.
  if (isOwnRewriteReentry(request, pathname, search)) {
    return NextResponse.next();
  }

  // THE PAGE SCRIPT NONCE (src/lib/security/content-security-policy.ts). A page gets a nonce minted
  // for this one request: on the REQUEST, where Next.js reads it out of `content-security-policy` and
  // puts it on every script it renders and the root layout reads it from `x-nonce`; and on the
  // RESPONSE, where its policy replaces the next.config.ts one for this page. API routes and files
  // keep the next.config.ts policy.
  const pageCsp = pageCspFor(pathname);
  return withPageCsp(forwardRequest(request, pathname, search, pageCsp), pageCsp, request.headers);
}

type PageCsp = { nonce: string; policy: string };

function pageCspFor(pathname: string): PageCsp | null {
  if (!shouldSendPageCsp(pathname)) return null;
  const nonce = createCspNonce();
  return { nonce, policy: pageContentSecurityPolicy(pathname, nonce) };
}

function withPageCsp(response: NextResponse, pageCsp: PageCsp | null, requestHeaders: Headers): NextResponse {
  if (pageCsp) {
    response.headers.set("Content-Security-Policy", pageCsp.policy);
    // Reported, never enforced: a `<style>` without this nonce and a picture from an unlisted host
    // (pageReportOnlyContentSecurityPolicy). Only on the RESPONSE — Next.js reads the nonce from the
    // request's enforced policy, which is set in forwardRequest below.
    response.headers.set("Content-Security-Policy-Report-Only", pageReportOnlyContentSecurityPolicy(pageCsp.nonce));
    response.headers.set("Reporting-Endpoints", CSP_REPORTING_ENDPOINTS);
    // Behind Cloudflare, `no-transform` keeps it from rewriting the email addresses a page renders into
    // "[email protected]", which broke hydration (React #418). Served directly, the page is left without
    // it, because `no-transform` also stops Next.js compressing the page — src/lib/security/page-cache-control.ts.
    // A redirect already names its own and has no body to rewrite, so it keeps it.
    if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", pageCacheControlFor(requestHeaders));
  }
  return response;
}

function forwardRequest(request: NextRequest, pathname: string, search: string, pageCsp: PageCsp | null): NextResponse {
  // A client can set any header it likes. These two are ours, and the shell trusts them to decide
  // which navigation to render — so delete whatever arrived and write our own. Done for EVERY
  // matched request, including ones that are not rewritten, so there is no path through this file
  // that forwards an attacker-supplied value.
  const headers = new Headers(request.headers);
  headers.delete(SHELL_HEADER);
  headers.delete(PATH_HEADER);
  headers.set(PATH_HEADER, `${pathname}${search}`);
  // The nonce and the policy Next.js reads it from are ours too: whatever arrived is dropped, and a
  // page gets this request's pair.
  headers.delete(CSP_NONCE_HEADER);
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  if (pageCsp) {
    headers.set(CSP_NONCE_HEADER, pageCsp.nonce);
    headers.set("content-security-policy", pageCsp.policy);
  }
  // THE TEST-ACCOUNT DRY RUN (src/lib/auth/test-dry-run-rules.ts): ours alone, so whatever arrived is
  // dropped, and a test account's write outside Phoenix CRM is marked to run fully and save nothing.
  headers.delete(TEST_DRY_RUN_HEADER);
  const testDryRun = proxyMarksTestDryRun(request.method, pathname, request.headers.get("cookie"));
  if (testDryRun) {
    headers.set(TEST_DRY_RUN_HEADER, "1");
    noteTestDryRunSeen();
  }

  const intervention = isSecurityProxyPath(pathname) ? securityProxy(request) : null;
  if (intervention) return intervention;

  const signedOutRedirect = signedOutPageRedirectResponse(request);
  if (signedOutRedirect) return signedOutRedirect;

  const portalRedirect = portalCandidatesRedirectResponse(request);
  if (portalRedirect) return portalRedirect;

  if (isHrRewritablePath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = hrNamespaceRemainder(pathname);
    headers.set(SHELL_HEADER, "hr");
    return markTestDryRun(forwardRewrite(url, headers), testDryRun);
  }

  return markTestDryRun(forwardPassThrough(headers), testDryRun);
}

function forwardRewrite(url: Parameters<typeof NextResponse.rewrite>[0], headers: Headers) {
  return NextResponse.rewrite(url, { request: { headers } });
}

function forwardPassThrough(headers: Headers) {
  return NextResponse.next({ request: { headers } });
}

/** The page reads this and says the save ran every check and saved nothing (TestDryRunNotice). */
function markTestDryRun<T extends NextResponse>(response: T, testDryRun: boolean): T {
  if (testDryRun) response.headers.set(TEST_DRY_RUN_RESPONSE_HEADER, "1");
  return response;
}

export const config = {
  // Matched broadly so the forgeable shell headers are stripped everywhere a layout could believe
  // them, and so `/hr/...` can be rewritten. Widening this does NOT widen the CSRF rule — see
  // `isSecurityProxyPath`. Static assets, images and the favicon are excluded: they render no
  // navigation, so there is nothing there to spoof, and matching them is pure latency on every
  // page load.
  //
  // 🔴 ONLY THE ROUTES THAT TAKE A FILE OVER 10 MB ARE EXCLUDED, AND EACH ONE BY ITS EXACT PATH. When the
  // proxy matches a request Next copies the body so the proxy could read it, and stops copying at
  // `proxyClientMaxBodySize` (10 MB by default): the route then receives a body cut off at 10 MB,
  // `request.formData()` throws, and the person gets a misleading "choose a file" error. Measured on
  // staging 2026-10-04: an 11 MB POST logged "Request body exceeded 10MB for
  // /api/devices/headwind/upload. Only the first 10MB will be available".
  //
  // The list is the device APK upload (Headwind) and the six other multipart routes
  // whose OWN limit is above 10 MB (audit, 2026-10-04): hiring documents (15 MB), custom hiring-pack
  // templates (15 MB a page), personal-mailbox send (15 MB of attachments), the WhatsApp inbox (25 MB),
  // an employee's CV and its staging draft (15 MB). Routes capped at 10 MB or less stay behind the
  // proxy, and so do PUBLIC ones (`/api/public/apply`): excluding a route removes the proxy's 10 MB
  // ceiling, which is only safe once the route turns an anonymous caller away BEFORE it reads the body.
  // Nothing else the proxy did is lost: each excluded route runs `assertSameOriginMutation` (same test
  // as the CSRF rule below) and its own permission or sign-in check first, and the preview wall is
  // inert on Railway. Never raise `proxyClientMaxBodySize` instead — it would make the proxy buffer
  // that much of ANY request body on any path, before authentication. `$` anchors each exclusion to
  // the exact path. Next reads this object statically, so the matcher must stay a literal. Pinned by
  // tests/proxy-upload-body-limit.test.ts.
  //
  // ONE TOKEN DOOR is excluded too: `/api/devices/recordings/upload`, where a rep tablet files a screen
  // recording of up to 256 MB (audit, 2026-10-26, point 24). A tablet holds no cookie and sends no
  // Origin, so there is no session to protect and no `assertSameOriginMutation` to run — the proxy
  // only cut its body at 10 MB and refused it as cross-site. Its gate is in the route, before the body
  // is read: a Content-Length cap, a per-address rate limit and the slot the address names; then the
  // single-use recording token.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|api/devices/headwind/upload$|api/devices/recordings/upload$|api/hiring-documents/files$|api/hiring-pack/custom-templates$|api/messages/mailbox/send$|api/whatsapp-inbox/conversations/[^/]+/messages$|api/employees/[^/]+/cv$|api/employees/cv-staging$).*)",
  ],
};
