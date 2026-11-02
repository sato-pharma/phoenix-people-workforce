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
  // Back on the page they asked for after signing in (owner, 2026-10-24), and only ever that page.
  const forgedTarget = new URL(forged.headers.get("location") ?? ORIGIN);
  assert.equal(forgedTarget.origin, ORIGIN, "the sign-in redirect stays on this site");
  assert.equal(forgedTarget.searchParams.get("returnUrl"), "/employee-portals/field-crm", "RED the page they opened rides along as returnUrl");
  const deepLink = new URL(
    proxy(requestFor("/employee-portals/phoenix-crm/visits?day=2026-10-24&_rsc=abc123")).headers.get("location") ?? ORIGIN,
  );
  assert.equal(
    deepLink.searchParams.get("returnUrl"),
    "/employee-portals/phoenix-crm/visits?day=2026-10-24",
    "the page's own query is kept and a client navigation's _rsc cache-buster is dropped",
  );
  assert.deepEqual([...deepLink.searchParams.keys()], ["returnUrl"], "returnUrl is the only thing added to /login");
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
  // The wave may carry more reads (the manager's name and the photo, 1 Nov 2026); the mailbox
  // connection must be read BESIDE the viewer and the directory, never after them.
  assert.match(
    service,
    /const \[currentUser, directory, mailboxConnected(?:, \w+)*\] = await Promise\.all\(\[\s*resolvePortalCurrentUser\(access\),\s*getEmployeeDirectory\(\),\s*personalMailboxConnected\(access\),/,
    "RED the shell reads the current user, the directory and the mailbox connection together",
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

  // The product managers are asked for beside the newest-worked-month lookup, and only the three legs
  // that need them wait for them.
  const load = functionBody(calendar, "loadTeamCalendar");
  const startAt = load.indexOf("loadScopeProductManagers(viewer, seats)");
  const monthAt = load.indexOf("await latestWorkedMonth(");
  assert.ok(startAt >= 0 && startAt < monthAt, "RED the product-manager read starts before the month lookup is awaited");
  assert.doesNotMatch(load, /await loadScopeProductManagers/, "RED nothing waits on the product managers before the month's reads start");
  assert.equal((load.match(/productManagersOnGrid\.then\(/g) ?? []).length, 3, "the leave, the product-manager rows and the manager days chain off it");
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

function testCrmVisitFormAndSave() {
  // Production, 24 Oct 2026 16:19-16:33 Cairo: Add Visit form p95 2.5 s, Save a visit p95 8 s.
  const visits = read("src/lib/phoenix-crm/server/visits.ts");

  const form = functionBody(visits, "loadVisitForm");
  const waveAt = form.indexOf("const wave = Promise.all([");
  const waveEnd = form.indexOf("] = await wave;");
  assert.ok(waveAt > 0 && waveEnd > waveAt, "the form still reads in one wave");
  const wave = form.slice(waveAt, waveEnd);
  assert.ok(
    wave.includes("lineProductManagersRead.then((managers) => loadPeopleNames(managers.map((manager) => manager.hrId))),"),
    "RED the product managers' names are read on the wave, the moment their list answers",
  );
  assert.ok(
    wave.includes('enteredAs === "manager" ? managerOwnVisitClosedNow(viewer) : Promise.resolve(false),'),
    "RED a manager's own-visit switch is read on the wave",
  );
  const afterWave = form.slice(waveEnd);
  assert.doesNotMatch(afterWave, /await loadPeopleNames\(/, "RED no names read after the wave");
  assert.doesNotMatch(afterWave, /await managerOwnVisitClosedNow\(/, "RED the switch is never read again after the wave");
  assert.equal(form.split("loadLineProductManagers(").length - 1, 1, "the product managers are read once");

  const save = functionBody(visits, "saveVisit");
  assert.ok(save.includes("const productFamiliesRead = lineProductsByFamily(seat.lineName);"), "RED the line's products start before the participants are checked");
  assert.ok(save.includes("productFamiliesRead.catch(() => undefined);"), "and are handled the moment they start");
  const startAt = save.indexOf("const productFamiliesRead = ");
  assert.ok(startAt < save.indexOf("resolveVisitParticipants("), "started before the participants");
  assert.ok(save.indexOf("const productFamilies = await productFamiliesRead;") > save.indexOf("await prepareDoubleVisitRequest("), "awaited where they always were, so the earlier refusals still come first");

  const deferAt = save.indexOf('await afterResponse("phoenix-crm save visit: capture evidence", async () => {');
  assert.ok(deferAt > save.indexOf('"phoenix_crm_save_visit"'), "RED the capture evidence is kept after the reply, once the visit is saved");
  const judgedAt = save.indexOf("await judgeCapture({");
  const provenanceAt = save.indexOf("await recordCaptureProvenance({");
  assert.ok(deferAt < judgedAt && judgedAt < provenanceAt, "RED the judgement and then the provenance run inside it, in that order");
  const deferred = save.slice(deferAt, save.indexOf("\n    });", provenanceAt));
  assert.doesNotMatch(deferred, /notify/i, "a notice is never deferred from here — the notices own their own timing");
  assert.match(visits, /import \{ afterResponse \} from "@\/lib\/http\/after-response";/);
}

function testCrmVisitsTabStartsItsReadsTogether() {
  // On production, 24 Oct 2026 16:19–16:33 Cairo: Visits day p50 807 ms, call prep 723 ms, Add Visit
  // form 1,034 ms, Customer List 1,211 ms. Each of the second reads used to wait for the first.
  const tab = read("src/components/phoenix-crm/visits-tab.tsx");
  const visits = functionBody(tab, "VisitsTab");
  const dayAt = visits.indexOf('useCrmGet<VisitDayView>(crmUrl("/api/phoenix-crm/visits"');
  const commitmentsAt = visits.indexOf("useCommitments(ownToday ? commitmentsUrl(seatId, test) : null)");
  const prepAt = visits.indexOf("useCallPrep(ownToday ? callPrepUrl(seatId, test) : null)");
  const formAt = visits.indexOf('useCrmGet<VisitFormView>(formWanted ? crmUrl("/api/phoenix-crm/visits/form"');
  assert.ok(dayAt >= 0 && commitmentsAt > dayAt && prepAt > dayAt && formAt > dayAt, "RED the commitments, call prep and Add visit form are read by the Visits tab itself, beside the day");
  assert.match(visits, /const guessOwn = ownSeat === true && !test;/, "the guess is the rep's own live territory only");
  assert.match(visits, /const ownToday = date === null && \(view \? view\.canSetDayActivity : guessOwn\);/, "RED once the day answers, the server's flag decides, never the guess");
  assert.match(visits, /const formWanted = step !== null \|\| \(date === null && \(view \? view\.canAdd : guessOwn\)\);/);
  // What is DRAWN is still the server's word alone.
  assert.match(visits, /const ownDay = isToday && view\?\.canSetDayActivity === true;/);
  assert.match(visits, /\{ownDay \? \(\s*<>[\s{}]*<CommitmentsPanel commitments=\{commitments\} \/>[\s{}]*<CallPrepPanel prep=\{prep\} \/>/);
  // A form read ahead is read again on every opening, so he never picks from an old list.
  assert.equal((visits.match(/if \(form\.data\) form\.reload\(\);/g) ?? []).length, 3, "RED the hand-off, the portal's + and Add visit each read the form afresh");
  const close = functionBody(visits, "closeFlow");
  assert.match(close, /commitments\.reload\(\);\s*prep\.reload\(\);/, "RED closing the flow reads the two panels again, as their remount used to");
  // The panels and the flow make no read of their own any more.
  const addFlow = functionBody(tab, "AddFlow");
  assert.doesNotMatch(addFlow, /useCrmGet/, "RED AddFlow reads nothing itself — the tab hands it the form");
  for (const [file, name] of [
    ["src/components/phoenix-crm/commitments-panel.tsx", "CommitmentsPanel"],
    ["src/components/phoenix-crm/call-prep-panel.tsx", "CallPrepPanel"],
  ] as const) {
    assert.doesNotMatch(functionBody(read(file), name), /useCrmGet|useCommitments|useCallPrep/, `RED ${name} reads nothing itself`);
  }
  assert.match(read("src/components/phoenix-crm/phoenix-crm-app.tsx"), /ownSeat=\{overview\.ownSeatIds\.includes\(seatId\)\}/);

  // The Customer List asks for its board WITH the list unless it opened on a Validate hand-off.
  const list = read("src/components/phoenix-crm/list-tab.tsx");
  assert.match(list, /const \[boardWanted, setBoardWanted\] = useState\(\(\) => validateHandoff === null\);/, "RED the board is asked for with the list");
}

async function testTimingStoreIsOnePerProcess() {
  // Next bundles the route handlers and instrumentation.ts apart, so a module-level store gave the
  // recorders and the process-health drain different copies: "timings":{} on every line, 24 Oct 2026.
  // Two fresh module instances stand in for the two bundles.
  const recorder = await import(`../src/lib/observability/timings.ts?bundle=routes-${Date.now()}`);
  const drainer = await import(`../src/lib/observability/timings.ts?bundle=instrumentation-${Date.now()}`);
  assert.notEqual(recorder, drainer, "two separate module instances, as in the production build");
  drainer.drainTimings();
  recorder.recordTiming("performance_acceleration_probe", 40);
  recorder.recordTiming("performance_acceleration_probe", 60);
  const drained = drainer.drainTimings();
  assert.equal(drained.performance_acceleration_probe?.count, 2, "RED a timing recorded in one bundle is drained by the other");
  assert.deepEqual(drainer.drainTimings(), {}, "a drain still starts a new window");

  const jobsA = await import(`../src/lib/observability/running-jobs.ts?bundle=worker-${Date.now()}`);
  const jobsB = await import(`../src/lib/observability/running-jobs.ts?bundle=instrumentation-${Date.now()}`);
  jobsB.drainJobWindow();
  const end = jobsA.beginJob("performance_acceleration_job");
  end();
  // The register is one per process now, so a job another test left running in this shard is named
  // too; the claim is only that this one, begun in the other bundle, is among them.
  assert.ok(jobsB.drainJobWindow().includes("performance_acceleration_job"), "RED a job begun in one bundle is named by the other's drain");
}

function testCommandCenterDoubleVisitFocusStreams() {
  const snapshot = read("src/lib/employee-portal/home-snapshot.ts");
  assert.match(
    snapshot,
    /const streamDvFocus = options\?\.streamDvFocus === true && STREAM_DV_FOCUS_ROLES\.has\(role\);/,
    "the double-visit focus streams only when the caller asks AND the role draws it streamed",
  );
  assert.match(
    snapshot,
    /streamDvFocus \? Promise\.resolve\(null\) : dvFocusPromise,/,
    "RED the landing no longer waits for the company-wide double-visit walk before it paints",
  );
  assert.match(snapshot, /dvFocusCard: streamDvFocus \? dvFocusPromise : null,/, "RED the running double-visit read is handed to the page");
  assert.match(
    snapshot,
    // The one extra condition allowed is the landing's own skip (a role whose landing draws no focus card).
    /const dvFocusPromise[^=]*= DV_FOCUS_ROLES\.has\(role\)(?: && !skippedOnLanding\.dvFocus)?\s*\?\s*timedCard\("double_visit_focus", getDoubleVisitPortalFocus\(access\)\.catch\(\(\) => null\)\)/,
    "the streamed read never rejects, so its boundary needs no error fallback",
  );
  assert.match(
    read("app/employee-portals/page.tsx"),
    /getPortalHomeSnapshot\(access, \{[^}]*streamDvFocus: true,[^}]*\}\)/,
    "RED the landing page asks for the double-visit focus streamed",
  );
  for (const file of [
    "src/components/employee-portal/dashboards/dsm-command-center.tsx",
    "src/components/employee-portal/dashboards/nsm-command-center.tsx",
    "src/components/employee-portal/dashboards/rm-command-center.tsx",
    "src/components/employee-portal/portal-command-center.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /<StreamedDoubleVisitFocus snapshot=\{snapshot\} \/>/, `RED ${file}: the focus draws through its own Suspense`);
    assert.doesNotMatch(source, /<DoubleVisitFocusSection focus=\{dvFocus\}/, `RED ${file}: no layout reads the (now null) streamed field`);
  }
  const stream = read("src/components/employee-portal/dashboards/double-visit-focus-stream.tsx");
  assert.match(stream, /if \(snapshot\.dvFocusCard\) return snapshot\.dvFocusCard;\s*return Promise\.resolve\(snapshot\.dvFocus\);/, "a whole snapshot still draws its own focus");
  assert.match(stream, /<Suspense fallback=\{<MmSectionSkeleton title="Your Double-Visit Trend" \/>\}>/, "the panel shows a visible loading state while it runs");
  // Her landing never draws the focus and her own page reads a whole snapshot: never streamed away.
  assert.doesNotMatch(
    snapshot.slice(snapshot.indexOf("const STREAM_DV_FOCUS_ROLES"), snapshot.indexOf("const emptyRoleExtras")),
    /Training Manager/,
    "the Training Manager keeps her focus awaited",
  );
}

// "fix the portal home slow opens" (2026-11-01): plan adherence, the interviews, the CV folders and the Early
// Birds held every landing, and his day held the rep's. None of them changes a figure, so nothing on a screen
// can catch one of these awaits coming back; the page just gets slow again.
function testLandingCardsDoNotHoldThePage() {
  const snapshot = read("src/lib/employee-portal/home-snapshot.ts");
  assert.match(snapshot, /const streamLandingCards = options\?\.streamLandingCards === true;/, "the cards stream only when the caller asks");
  for (const [field, promise, empty] of [
    ["earlyBirdStars", "earlyBirdStarsPromise", "\\[\\]"],
    ["planAdherence", "planAdherencePromise", "null"],
    ["myInterviews", "myInterviewsPromise", "\\[\\]"],
    ["cvFolders", "cvFoldersPromise", "null"],
  ]) {
    assert.match(snapshot, new RegExp(`streamLandingCards \\? Promise\\.resolve\\(${empty}\\) : ${promise},`), `RED the snapshot no longer waits for ${field} when it streams`);
    assert.match(snapshot, new RegExp(`${field}: streamLandingCards \\? ${promise} : ${field},`), `RED the running ${field} read is handed to the page`);
    assert.match(snapshot, new RegExp(`const ${promise}[^;]*\\.catch\\(\\(\\) => [^)]*\\)`), `${field} never rejects, so its boundary needs no error fallback`);
  }
  const page = read("app/employee-portals/page.tsx");
  assert.match(page, /getPortalHomeSnapshot\(access, \{[^}]*streamLandingCards: true,[^}]*\}\)/, "RED the landing page asks for the cards streamed");
  assert.doesNotMatch(read("app/api/employee-portals/home/route.ts"), /streamLandingCards/, "the JSON route never asks: a promise serializes to {}");
  assert.doesNotMatch(read("app/employee-portals/training-manager/page.tsx"), /streamLandingCards/, "and neither does the Training Manager's page, which reads the whole snapshot");

  const centre = read("src/components/employee-portal/portal-command-center.tsx");
  assert.match(centre, /<Suspense fallback=\{null\}>\s*<BandPlanAdherence adherence=\{planAdherence\} \/>\s*<\/Suspense>/, "RED plan adherence fills under its own Suspense, with no empty square before it");
  assert.match(centre, /<Suspense fallback=\{null\}>\s*<BandInterviews interviews=\{myInterviews\} \/>\s*<\/Suspense>/, "RED and the interviews under theirs");
  for (const file of [
    "src/components/employee-portal/dashboards/dsm-command-center.tsx",
    "src/components/employee-portal/dashboards/nsm-command-center.tsx",
    "src/components/employee-portal/dashboards/rm-command-center.tsx",
    "src/components/employee-portal/dashboards/marketing-manager-command-center.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /<Suspense fallback=\{null\}>\s*<AwaitCard value=\{earlyBirdStars\}>/, `RED ${file}: the Early Birds fill under their own Suspense`);
    if (!file.includes("marketing")) assert.match(source, /<Suspense fallback=\{null\}>\s*<AwaitCard value=\{snapshot\.cvFolders\}>/, `RED ${file}: the CV folders fill under their own Suspense`);
  }
}

function testOrganogramStartsItsReadsTogether() {
  const source = read("src/lib/reports/organogram-au-source.ts");
  const body = functionBody(source, "buildOrganogramSeatReport");
  const tree = body.indexOf("const { data: treeData, error } = asOfMonth");
  assert.ok(tree > 0, "the seat tree read is still there");
  for (const [load, start] of [
    ["offerLoad", /const offerLoad[^;]*: loadOfferOutBySeat\(\);/],
    ["employeeLoad", /const employeeLoad = Promise\.resolve\(\s*supabase\s*\.from\("employees"\)/],
    ["teamLoad", /const teamLoad = Promise\.resolve\(supabase\.from\("teams"\)\.select\("id, name"\)\);/],
    ["vacancyLoad", /const vacancyLoad = asOfMonth\s*\? null\s*: Promise\.resolve\(\s*supabase\s*\.from\("position_vacancies"\)/],
  ] as const) {
    const at = body.search(start);
    assert.ok(at > 0 && at < tree, `RED organogram: ${load} starts before the seat tree is awaited, not after it`);
    assert.match(body, new RegExp(`= (?:${load}\\s*\\? )?await ${load}`), `organogram: ${load} is awaited where it is read`);
  }
  // A Supabase builder is lazy: without Promise.resolve (or an await) the query never leaves.
  assert.doesNotMatch(body, /const (?:employeeLoad|teamLoad) = supabase/, "RED organogram: an unstarted builder runs nothing");

  const page = read("app/employee-portals/organogram/page.tsx");
  const ask = page.indexOf('const canAddEmployeeLoad = canAccess(access, "employees", "create");');
  assert.ok(ask > 0 && ask < page.indexOf("getOrganogramReport("), "RED organogram: the hire permission is asked beside the report");
  assert.match(page, /const canAddEmployee = await canAddEmployeeLoad;/, "RED organogram: the page still waits for the answer before it draws");
}

export async function runPhoenixPerformanceAccelerationTests() {
  await testTimingStoreIsOnePerProcess();
  testProxySignedOutRedirect();
  testRejectionAuditAfterResponse();
  testShellAndSidebar();
  testCrmPlanAndCalendar();
  testCommandCenterCompliance();
  testCommandCenterDoubleVisitFocusStreams();
  testLandingCardsDoNotHoldThePage();
  testBusinessReview();
  testOrganogramStartsItsReadsTogether();
  testCrmVisitFormAndSave();
  testCrmVisitsTabStartsItsReadsTogether();
}
