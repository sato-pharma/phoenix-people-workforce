import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The performance brief of 2026-10-23. The owner's screen recording that day showed about 8 s from
// an expired session to the sign-in page, and seconds of skeleton on the Command Center, the CRM
// plan and calendar pages and the business review. Production said where:
//   - the expired-session path awaited an audit insert and then painted the portal skeleton before
//     its redirect arrived;
//   - independent reads ran one after another on the shell, the CRM sidebar, the manager plan and
//     calendar pages, the Command Center compliance board and the business review.
// Each pin below names the fix it holds. The proxy is exercised with real requests; the rest is
// read from source, because none of it can be reached without a database.
// ─────────────────────────────────────────────────────────────────────────────

process.env.PHOENIX_AUTH_SECRET ??= "phoenix-performance-acceleration-test-secret";

const { NextRequest } = await import("next/server");
const { proxy } = await import("../proxy.ts");
const { createSessionToken, phoenixSessionCookieName } = await import("../src/lib/auth/session-token.ts");

const raw = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const read = (path: string) => stripComments(raw(path));

const ORIGIN = "https://phoenix-hr.satopharma.com";

function validToken() {
  return createSessionToken({
    hrId: "HR-0001",
    loginId: "performance.acceleration.test",
    maxAgeSeconds: 3600,
    role: "Medical Rep",
    sessionId: "performance-acceleration-test-session",
    sessionVersion: 1,
  });
}

function requestFor(path: string, options: { cookie?: string; method?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.cookie !== undefined) headers.cookie = `${phoenixSessionCookieName}=${options.cookie}`;
  return new NextRequest(`${ORIGIN}${path}`, { headers, method: options.method ?? "GET" });
}

function sentToSignIn(response: Response): boolean {
  const location = response.headers.get("location");
  return response.status === 307 && location !== null && new URL(location).pathname === "/login";
}

function functionBody(code: string, name: string): string {
  const at = code.search(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
  assert.notEqual(at, -1, `${name} must exist`);
  const next = code.slice(at + 10).search(/\n(?:export )?(?:async )?function /);
  return code.slice(at, next === -1 ? undefined : at + 10 + next);
}

function testProxySignedOutRedirect() {
  // The headline: a signed-out page request is answered by the proxy itself, before any skeleton.
  for (const path of ["/employee-portals", "/employee-portals/field-crm/plan", "/admin/action-center"]) {
    assert.ok(sentToSignIn(proxy(requestFor(path))), `RED no cookie on ${path}: a 307 to /login from the proxy, before the layout paints`);
  }
  const forged = proxy(requestFor("/employee-portals/field-crm", { cookie: `${validToken()}x` }));
  assert.ok(sentToSignIn(forged), "a cookie whose signature fails is sent to sign in");
  assert.equal(new URL(forged.headers.get("location") ?? ORIGIN).search, "", "plain /login: no return address is added");
  assert.match(forged.headers.get("cache-control") ?? "", /no-store/, "the redirect is never cached");
  assert.match(
    forged.headers.get("set-cookie") ?? "",
    new RegExp(`${phoenixSessionCookieName}=;.*Max-Age=0`, "i"),
    "the stale cookie is cleared, so /login does not validate it a second time",
  );
  assert.ok(sentToSignIn(proxy(requestFor("/employee-portals", { cookie: "not-a-real-token" }))), "an unsigned string is not a session");

  // It only ever sends people to sign in; it never lets anybody through.
  const valid = proxy(requestFor("/employee-portals/field-crm", { cookie: validToken() }));
  assert.equal(sentToSignIn(valid), false, "a valid signature carries on to the full server check");
  assert.equal(valid.headers.get("x-middleware-next"), "1", "a valid cookie passes through to the page");

  // Left alone, so they keep the path they had.
  assert.equal(sentToSignIn(proxy(requestFor("/api/employee-portal/badges"))), false, "an API request is never sent an HTML redirect");
  assert.equal(sentToSignIn(proxy(requestFor("/employee-portals", { method: "POST" }))), false, "only a read is redirected");
  assert.equal(sentToSignIn(proxy(requestFor("/login"))), false, "the sign-in page itself is never redirected");
  assert.equal(sentToSignIn(proxy(requestFor("/hr/login"))), false, "the /hr spelling of a public page is never redirected");
  assert.equal(sentToSignIn(proxy(requestFor("/hr/password-reset"))), false, "the /hr spelling of password reset is never redirected");
  assert.equal(
    sentToSignIn(proxy(requestFor("/employee-portals/marketing-requests/decision/abc"))),
    false,
    "the marketing-request decision page keeps its own signed-out notice and audit row",
  );
  assert.equal(
    sentToSignIn(proxy(requestFor("/employee-portals", { headers: { authorization: "Bearer x" } }))),
    false,
    "a bearer-token request authenticates by header and is left to the server",
  );
}

function testRejectionAuditAfterResponse() {
  const server = read("src/lib/auth/server.ts");
  assert.match(server, /import \{ afterResponse \} from "@\/lib\/http\/after-response";/, "the auth server imports afterResponse");
  const body = functionBody(server, "auditSessionRejection");
  assert.match(
    body,
    /await afterResponse\("auth_session_rejection_audit", \(\) => writeAuthAudit\(/,
    "RED the rejected-session audit row is still written, through afterResponse — never awaited on the way to sign-in",
  );
  assert.doesNotMatch(body, /^\s*await writeAuthAudit\(/m, "RED no direct awaited audit insert on the rejection path");
}

function testShellAndSidebar() {
  const service = read("src/lib/employee-portal/service.ts");
  assert.match(
    service,
    /const \[currentUser, directory\] = await Promise\.all\(\[\s*resolvePortalCurrentUser\(access\),\s*getEmployeeDirectory\(\),\s*\]\);/,
    "RED the shell reads the current user and the directory together",
  );

  const planSwitch = read("src/lib/phoenix-crm/server/manager-plan-switch.ts");
  const together = planSwitch.match(
    /const \[owes, live\] = await Promise\.all\(\[owesTheLegacyWeeklyPlan\(hrId\), loadLiveTeamSeatIdsForDisplay\((?:options\.)?cairoToday\)\]\);\s*if \(owes\) return false;/g,
  );
  assert.equal(together?.length, 2, "RED both the District and the senior plan switch read the legacy-plan check and the live seats together, owes still decided first");
  assert.doesNotMatch(planSwitch, /if \(await owesTheLegacyWeeklyPlan\(/, "RED no sequential legacy-plan await left");

  const singleVisit = read("src/lib/phoenix-crm/server/manager-single-visit-days.ts");
  assert.match(
    singleVisit,
    /const \[asks, holidays\] = await Promise\.all\(\[\s*loadSingleVisitDayAsks\(/,
    "RED the single-visit asks and the plan holidays are read together",
  );
}

function testCrmPlanAndCalendar() {
  const plans = read("src/lib/phoenix-crm/server/manager-plans.ts");
  assert.match(
    plans,
    /await Promise\.all\(\s*chunk\(dedupeIds\(seatIds\), 100\)\.map\(\(part\) =>\s*fetchAllRowsKeyset<Row>\(/,
    "RED the rep-week plan chunks are read in parallel, then flattened in order",
  );
  assert.doesNotMatch(plans, /for \(const part of chunk\(dedupeIds\(seatIds\), 100\)\) \{\s*planRows\.push/, "RED no sequential plan-chunk loop");

  const calendar = read("src/lib/phoenix-crm/server/team-calendar.ts");
  assert.match(calendar, /const results = await Promise\.all\(\s*reads\.map\(\(\{ column, asked \}\) =>/, "RED the manager visit reads run together");
  assert.match(
    calendar,
    /const parts = await Promise\.all\(\s*chunk\(\[\.\.\.seatIds\], 150\)\.map\(\(part\) =>\s*fetchAllRowsKeyset<Row>\(/,
    "RED the activity-day chunks run together",
  );
  assert.match(calendar, /const answers = await Promise\.all\(chunk\(\[\.\.\.seatIds\], 150\)\.map\(\(part\) => run\(part\)\)\);/, "RED the newest-worked-month chunks run together");
  assert.doesNotMatch(calendar, /for \(const part of chunk\(\[\.\.\.seatIds\], 150\)\) \{/, "RED no sequential seat-chunk loop left on the calendar");
}

function testCommandCenterCompliance() {
  const snapshot = read("src/lib/employee-portal/home-snapshot.ts");
  for (const [label, module] of [
    ["your district", "dsm-crm-compliance"],
    ["your line", "nsm-crm-compliance"],
    ["your region", "rm-crm-compliance"],
  ] as const) {
    assert.match(
      snapshot,
      new RegExp(`const rosterPromise = resolveServingRoster\\(\\{ viewerHrId: hrId, label: "${label}" \\}\\);\\s*const earlyCrm = crmComplianceFromRoster\\(rosterPromise,`),
      `RED ${module}: compliance starts the moment the roster answers, beside the sales reads`,
    );
    assert.match(
      snapshot,
      new RegExp(`const crm = \\(await earlyCrm\\) \\?\\? \\(await crmComplianceFor\\(access, "${module}", crmInput\\)\\);`),
      `${module}: no roster still falls back to the input built after the sales rows`,
    );
  }
  assert.doesNotMatch(snapshot, /const crm = await getNsmCrmCompliance\(crmInput\)/, "RED no branch waits for the sales reads before starting compliance");
  assert.match(
    functionBody(snapshot, "crmComplianceFor"),
    /getNsmCrmCompliance\(input\)\.catch\([\s\S]*nsmCrmComplianceUnavailable\(input\)/,
    "a failed compliance read still answers its \"unavailable\" state, never a fake zero",
  );
}

function testBusinessReview() {
  const review = read("app/(admin)/business-review/page.tsx");
  const gate = review.indexOf('redirect("/admin/access")');
  const scopeStart = review.indexOf("const scopeLoad = loadReviewPortalScope({ hrId: access.hrId ?? null, sessionRole: access.role });");
  const reviewLoad = review.indexOf("await loadBusinessReview({");
  assert.notEqual(scopeStart, -1, "RED the admin business review starts the seat map before the live review, not after it");
  assert.ok(gate < scopeStart && scopeStart < reviewLoad, "RED the seat map starts after the role gate and before the review is awaited");
  assert.ok(review.includes("scopeLoad.catch(() => {});"), "a rejection never surfaces unhandled while the review loads");
  assert.ok(review.includes("const { scope } = await scopeLoad;"), "the page still waits for the seat map before narrowing");
  assert.equal(review.split("loadReviewPortalScope(").length - 1, 1, "the seat map is read once");
}

export async function runPhoenixPerformanceAccelerationTests() {
  testProxySignedOutRedirect();
  testRejectionAuditAfterResponse();
  testShellAndSidebar();
  testCrmPlanAndCalendar();
  testCommandCenterCompliance();
  testBusinessReview();
}
