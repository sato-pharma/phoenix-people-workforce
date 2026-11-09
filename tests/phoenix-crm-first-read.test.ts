import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { crmUrl } from "../src/lib/phoenix-crm/crm-url.ts";
import { FIRST_READ_LIFETIME_MS, firstReadArrived, firstReadFor, firstReadSpent, readFirst, type CrmFirstRead } from "../src/lib/phoenix-crm/first-read.ts";
import { phoenixCrmFirstReadTarget } from "../src/lib/phoenix-crm/server/first-read.ts";
import type { PhoenixCrmOverview } from "../src/lib/phoenix-crm/view-types.ts";
import { stripComments } from "./support/comment-strip.ts";

// "make every Phoenix CRM module tab load its first data from the server" (2026-11-01). The page starts the read
// the screen is about to ask for, and hands it over only when the address and the key are the screen's own.

const read = (file: string) => readFileSync(file, "utf8");
const code = (file: string) => stripComments(read(file));
const squeeze = (text: string) => text.replace(/\s+/g, " ");

function testHandOverRules() {
  const firstRead = (): CrmFirstRead => ({ body: Promise.resolve("{}"), key: "day", startedAt: 1_000, url: "/api/phoenix-crm/visits?seatId=S-1" });

  const own = firstRead();
  assert.equal(firstReadFor(null, own.url, own.key), null, "with nothing handed over the screen reads for itself");
  assert.equal(firstReadFor(own, "/api/phoenix-crm/visits?seatId=S-2", own.key), null, "RED another territory's read is never drawn under this one's name");
  assert.equal(firstReadFor(own, own.url, "list"), null, "RED and a read under another key is not this screen's");

  const twice = firstRead();
  assert.equal(firstReadFor(twice, twice.url, twice.key, 1_000), twice, "the screen's own read is handed over");
  assert.equal(firstReadFor(twice, twice.url, twice.key, 1_000), twice, "still there when Strict Mode runs the effect again before it has landed");

  const back = firstRead();
  assert.equal(firstReadFor(back, back.url, back.key, 1_000), back);
  firstReadSpent(back);
  assert.equal(firstReadFor(back, back.url, back.key, 1_001), null, "RED browser Back must read afresh, never redraw the day from before the visit he logged");

  // What a real browser did on 3 Nov 2026: a refresh brought a new read under a screen already up, and Back later
  // mounted that copy and drew its read, with no read and no page request.
  const held = firstRead();
  const refreshed = firstRead();
  firstReadArrived(held, held);
  assert.equal(firstReadFor(held, held.url, held.key, 1_000), held, "the screen's own first read is left alone");
  firstReadArrived(held, null);
  firstReadArrived(held, refreshed);
  assert.equal(firstReadFor(refreshed, refreshed.url, refreshed.key, 1_001), null, "RED a read that arrived under a screen already up is never drawn, or Back redraws an old day");

  const leftBehind = firstRead();
  assert.equal(firstReadFor(leftBehind, leftBehind.url, leftBehind.key, 1_001 + FIRST_READ_LIFETIME_MS), null, "RED a read this old is refused the first time it is met, which covers a refresh that landed after the rep left");

  const late = firstRead();
  assert.equal(firstReadFor(late, late.url, late.key, 1_000), late);
  assert.equal(firstReadFor(late, late.url, late.key, 1_000 + FIRST_READ_LIFETIME_MS), late, "still good at the very end of its life");
  assert.equal(firstReadFor(late, late.url, late.key, 1_001 + FIRST_READ_LIFETIME_MS), null, "RED left unused and met again later, it is too old to draw");
}

async function testAnswerOrItsOwnRead() {
  let reads = 0;
  const readItself = async () => {
    reads += 1;
    return { from: "route" };
  };
  const base = { key: "day", startedAt: 0, url: "/x" };

  assert.deepEqual(await readFirst({ ...base, body: Promise.resolve('{"from":"page"}') }, readItself), { from: "page" }, "the answer is parsed as the route's own JSON");
  assert.equal(reads, 0, "RED and the browser does not ask a second time");

  assert.deepEqual(await readFirst({ ...base, body: Promise.resolve(null) }, readItself), { from: "route" }, "a read the page could not do is the route's to answer, with its own sentence");
  assert.equal(reads, 1);

  assert.deepEqual(await readFirst({ ...base, body: Promise.reject(new Error("Connection closed.")) }, readItself), { from: "route" }, "RED a broken stream falls back to the screen's own read");
  assert.equal(reads, 2);

  // What really crosses from the server: React's own thenable, whose `then` returns nothing.
  const flightThenable = { then: (resolve: (value: string) => void) => void resolve('{"from":"stream"}') } as unknown as Promise<string>;
  assert.deepEqual(await readFirst({ ...base, body: flightThenable }, readItself), { from: "stream" }, "RED React's thenable cannot be chained");
  assert.equal(reads, 2);
}

function testThePageCannotTellARefresh() {
  const store = read("node_modules/next/dist/server/async-storage/request-store.js");
  assert.ok(store.includes("HIDDEN_REQUEST_HEADERS") && store.includes("FLIGHT_HEADERS"), "Next still hides its request marks from headers(); if this moved, a page may be able to tell a refresh again");
  const server = code("src/lib/phoenix-crm/server/first-read.ts");
  assert.ok(!server.includes("next-router-"), "RED a check on Next's request marks can never fire: a real refresh reached the page with none of them");
}

function overview(overrides: Record<string, unknown> = {}, viewer: Record<string, unknown> = {}): PhoenixCrmOverview {
  const tabs = { calendar: true, doctors: true, forecast: true, list: true, plan: true, reports: true, settings: true, team: true, testAccounts: true, visits: true };
  return {
    closedMessage: null,
    managerPlans: null,
    ownSeatIds: ["S-OWN"],
    tabs,
    territories: [
      { lineCode: "CVS", seatId: "S-OTHER" },
      { lineCode: "CNS", seatId: "S-OWN" },
    ],
    viewer: { isManager: false, isRep: true, isSuperAdmin: false, isTestPersona: false, ...viewer },
    visitSeatIds: ["S-OWN"],
    waitingForYou: { isTest: false, offPlanVisits: 0, planEdits: 0, plans: 0, requests: 0, visitAsks: 0 },
    ...overrides,
  } as unknown as PhoenixCrmOverview;
}

function testEachTabsAddress() {
  const target = (tab: string, over = overview()) => {
    const found = phoenixCrmFirstReadTarget(over, tab, "portal");
    return found && { key: found.key, url: found.url };
  };
  const planner = { managerPlans: { planner: true } };

  // What each tab's own expression builds on its first render, with nothing yet chosen.
  const date = null;
  const month = null;
  const week = null;
  const scopeKey = null;
  const picked = null;
  const seatId = "S-OWN";
  const test = false;
  assert.deepEqual(target("visits"), { key: "day", url: crmUrl("/api/phoenix-crm/visits", { date, seatId, test }) }, "RED Visits");
  assert.deepEqual(target("list"), { key: "list", url: crmUrl("/api/phoenix-crm/list", { seatId, test }) }, "RED List");
  assert.deepEqual(target("plan"), { key: "planner", url: crmUrl("/api/phoenix-crm/monthly-plans", { seatId, test, month }) }, "RED Plan");
  assert.deepEqual(target("forecast"), { key: "form", url: crmUrl("/api/phoenix-crm/forecast", { seatId, test }) }, "RED the Forecast form");
  assert.deepEqual(target("team"), { key: "team", url: crmUrl("/api/phoenix-crm/team", { test }) }, "RED Team");
  assert.deepEqual(target("calendar"), { key: "report", url: crmUrl("/api/phoenix-crm/reports", { includeTest: test, month: picked, section: "calendar" }) }, "RED the Calendar");
  assert.deepEqual(target("doctors"), { key: "directory", url: crmUrl("/api/phoenix-crm/doctors", { test }) }, "RED the Directory");
  assert.deepEqual(target("reports"), { key: "report", url: crmUrl("/api/phoenix-crm/reports", { section: "scope" }) }, "RED Reports");
  assert.deepEqual(target("settings"), { key: "settings", url: "/api/phoenix-crm/settings" }, "RED Settings");
  assert.deepEqual(target("testAccounts"), { key: "testApprovals", url: "/api/phoenix-crm/test-approvals" }, "RED Test accounts");

  // The screens a role sees instead.
  assert.deepEqual(
    target("plan", overview(planner, { isManager: true, isRep: false })),
    { key: "board", url: crmUrl("/api/phoenix-crm/manager-plans", { week, scope: scopeKey, test }) },
    "RED a manager's Plan is his own board",
  );
  assert.deepEqual(target("plan", overview(planner, { isManager: true })), { key: "planner", url: crmUrl("/api/phoenix-crm/monthly-plans", { seatId, test, month }) }, "a manager who is also a rep opens on his territory");
  const noSeat = { ownSeatIds: [], territories: [], visitSeatIds: [] };
  assert.deepEqual(target("visits", overview({ ...planner, ...noSeat }, { isManager: true, isRep: false })), { key: "today", url: crmUrl("/api/phoenix-crm/manager-plans/visits", { test }) }, "RED a manager with no territory reads his single visits");
  assert.equal(target("visits", overview(noSeat)), null, "no territory and no planner draws a sentence, and reads nothing");
  assert.equal(target("list", overview(noSeat)), null);
  assert.equal(target("plan", overview(noSeat)), null);
  assert.deepEqual(target("forecast", overview({ ownSeatIds: [] })), { key: "board", url: crmUrl("/api/phoenix-crm/forecast/board", { test, view: "day" }) }, "RED with no form of his own he reads the board");
  assert.deepEqual(target("forecast", overview({}, { isSuperAdmin: true })), { key: "board", url: crmUrl("/api/phoenix-crm/forecast/board", { test, view: "day" }) }, "and so does the Super Admin");
  assert.equal(target("forecast", overview({ ownSeatIds: [], tabs: { ...overview().tabs, team: false } })), null, "with neither, the tab is a sentence");

  // A TEST- login reads its own world, on an address that says so.
  const persona = overview({}, { isTestPersona: true });
  assert.equal(target("visits", persona)?.url, "/api/phoenix-crm/visits?seatId=S-OWN&test=true", "RED a test persona's flag is on the address");
  assert.equal(target("calendar", persona)?.url, "/api/phoenix-crm/reports?includeTest=true&section=calendar");

  assert.equal(target("visits", overview({ closedMessage: "Not open yet." })), null, "RED a closed module draws no tab, so nothing reads");

  // The tab comes from the screen's own rule, on each shell.
  assert.equal(phoenixCrmFirstReadTarget(overview({}, { isRep: false }), null, "admin")?.key, "team", "the admin shell opens on Team");
  assert.equal(phoenixCrmFirstReadTarget(overview(), null, "portal")?.key, "day", "the portal opens a rep on his day");
}

function testTabsStillAskForThoseAddresses() {
  const asks: Array<[string, string]> = [
    ["visits-tab", 'useCrmGet<VisitDayView>(crmUrl("/api/phoenix-crm/visits", { date, seatId, test }), "day")'],
    ["list-tab", 'useCrmGet<TerritoryListView>(listUrl(seatId, test), "list")'],
    ["list-screens", 'return crmUrl("/api/phoenix-crm/list", { seatId, test });'],
    ["plan-board", 'const planUrl = crmUrl("/api/phoenix-crm/monthly-plans", { seatId, test, month });'],
    ["plan-board", 'useCrmGet<MonthlyPlannerView>(planUrl, "planner")'],
    ["manager-plan-board", 'useCrmGet<ManagerPlanBoardView>(crmUrl(BOARD, { week, scope: scopeKey, test }), "board")'],
    ["manager-single-visits", 'useCrmGet<ManagerTodayView>(crmUrl(VISITS, { test }), "today")'],
    ["forecast-tab", 'useCrmGet<ForecastFormView>(seatId ? crmUrl(FORM_PATH, { seatId, test }) : null, "form")'],
    ["forecast-tab", 'view === "day" ? crmUrl(BOARD_PATH, { test, view: "day" })'],
    ["forecast-tab", 'useState<string>(territories[0]?.seatId ?? "")'],
    ["team-tab", 'useCrmGet<TeamView>(crmUrl("/api/phoenix-crm/team", { test }), "team")'],
    ["calendar-tab", 'crmUrl(CALENDAR_PATH, { includeTest: test, month: picked, section: "calendar" })'],
    ["doctors-tab", 'useCrmGet<DoctorDirectoryView>(crmUrl("/api/phoenix-crm/doctors", { test }), "directory")'],
    ["reports-tab", 'useCrmGet<ReportScopeView>(crmUrl(REPORTS_PATH, { section: "scope" }), "report")'],
    ["settings-tab", 'useCrmGet<PhoenixCrmSettingsView>(SETTINGS_PATH, "settings")'],
    ["test-accounts-tab", 'useCrmGet<TestApprovalsView>("/api/phoenix-crm/test-approvals", "testApprovals")'],
  ];
  for (const [file, expression] of asks) {
    assert.ok(squeeze(code(`src/components/phoenix-crm/${file}.tsx`)).includes(expression), `RED ${file} no longer asks ${expression}; change server/first-read.ts with it, or the read is wasted on every open`);
  }

  // What the first render starts from. Each of these would quietly make the page's read a spare one.
  const screens = squeeze(code("src/components/phoenix-crm/phoenix-crm-app.tsx"));
  assert.ok(screens.includes("useState<TabKey>(() => openingTab(initialOverview, initialTab, surface))"), "the screen opens the tab the page read for");
  assert.ok(screens.includes("const [chosenSeat, setChosenSeat] = useState<string | null>(null);"), "and starts with no other territory chosen");
  assert.ok(screens.includes('visits: seatOf(overview, "visits", chosenSeat),'), "and finds it with the rule the page uses");
  assert.ok(screens.includes('key === "plan" && managerPlanner && (!viewer.isRep || planScope === "district")'), "the manager's own board");
  assert.ok(screens.includes('useState<"territory" | "district">("territory")'), "opening on the territory");
  assert.ok(screens.includes('key === "visits" && managerPlanner && seats.visits === null'), "and his single visits");
  const planBoard = screens.slice(screens.indexOf("<PlanBoard"), screens.indexOf("weekNonce={planWeekNonce}"));
  assert.ok(planBoard.length > 0 && !/initial(Month|WeekStart)/.test(planBoard), "RED the Plan tab opens with no month on its address");
}

function testEachLoadIsItsRoutesOwn() {
  const server = squeeze(code("src/lib/phoenix-crm/server/first-read.ts"));
  const loads: Array<[string, string]> = [
    ["visits", 'loadVisitDay(viewer, { seatId: search.get("seatId"), test: search.get("test"), date: search.get("date") })'],
    ["list", 'loadTerritoryList(viewer, search.get("seatId"), search.get("test"))'],
    ["monthly-plans", 'loadMonthlyPlanner(viewer, { seatId: search.get("seatId"), test: search.get("test"), month: search.get("month") })'],
    ["manager-plans", 'loadManagerPlanBoard(viewer, { week: search.get("week"), manager: search.get("manager"), test: search.get("test"), scope: search.get("scope"), })'],
    ["manager-plans/visits", 'loadManagerToday(viewer, { test: search.get("test") })'],
    ["forecast", 'loadForecastForm(viewer, { seatId: search.get("seatId"), test: search.get("test") })'],
    ["forecast/board", 'loadForecastBoard(viewer, { day: search.get("day"), test: search.get("test") })'],
    ["forecast/board", 'kind: "day", day }'],
    ["team", 'loadTeamView(viewer, { test: search.get("test") })'],
    ["doctors", 'readWorldFor(viewer, search.get("test"))'],
    ["doctors", "loadDoctorDirectory(viewer, isTest)"],
    ["reports", "loadReportScope(viewer)"],
    ["reports", 'loadTeamCalendar(viewer, { month: search.get("month"), test: search.get("includeTest") })'],
    ["settings", "loadSettingsView(viewer)"],
    ["test-approvals", "loadTestApprovals(viewer)"],
  ];
  for (const [route, expression] of loads) {
    const source = squeeze(code(`app/api/phoenix-crm/${route}/route.ts`))
      .replaceAll('searchOf(request).get("test")', 'search.get("test")')
      .replace("month: filters.month, test: filters.includeTest", 'month: search.get("month"), test: search.get("includeTest")');
    assert.ok(source.includes(expression), `RED the ${route} route no longer calls ${expression}; the page's read would answer differently from it`);
    assert.ok(server.includes(expression), `RED the page's read for ${route} no longer calls ${expression}`);
  }
  const reports = squeeze(code("app/api/phoenix-crm/reports/route.ts"));
  assert.ok(reports.includes('month: search.get("month")') && reports.includes('includeTest: search.get("includeTest")'), "the Calendar's two filters come straight off its address");

  // The answers as the routes send them, read back by the same key.
  for (const [route, key] of [
    ["visits", "day"],
    ["list", "list"],
    ["monthly-plans", "planner"],
    ["manager-plans", "board"],
    ["manager-plans/visits", "today"],
    ["forecast", "form"],
    ["forecast/board", "board"],
    ["team", "team"],
    ["doctors", "directory"],
    ["reports", "report"],
    ["settings", "settings"],
    ["test-approvals", "testApprovals"],
  ]) {
    assert.match(code(`app/api/phoenix-crm/${route}/route.ts`), new RegExp(`NextResponse\\.json\\(\\{ ${key}[,:]`), `the ${route} route answers under "${key}"`);
  }

  // The same gates in front of it.
  assert.match(server, /assertTestAccountMayRun\(access, request\); assertSeatViewMayRun\(access, request\); await assertPermission\(access, "phoenix_crm", target\.permission \?\? "read"\);/, "RED the test account guard, the seat view guard and the permission all run first");
  assert.ok(code("app/api/phoenix-crm/settings/route.ts").includes('assertPermission(access, "phoenix_crm", "update")'), "Settings asks for update on its route");
  assert.ok(server.includes('permission: "update"'), "RED and on the page's read");
  assert.match(server, /body: runFirstRead\(access, target\)/, "RED handed over still running: the page never waits for it");
  assert.ok(!/await runFirstRead/.test(server), "RED never awaited");
}

function testThePagesAndTheHook() {
  const portal = squeeze(code("app/employee-portals/field-crm/[module]/page.tsx"));
  assert.ok(portal.includes('await startPhoenixCrmFirstRead(access, load.overview, moduleKey, "portal")'), "RED every portal module starts its read");
  assert.ok(portal.includes('<CrmFirstReadProvider firstRead={firstRead}> <PhoenixCrmApp initialOverview={load.overview} initialTab={moduleKey} single surface="portal" /> </CrmFirstReadProvider>'), "RED and hands it to the screen");

  const admin = squeeze(code("app/(admin)/admin/field-crm/page.tsx"));
  assert.ok(admin.includes('await startPhoenixCrmFirstRead(access, load.overview, tab, "admin")'), "RED the admin twin too");
  assert.ok(admin.includes('<CrmFirstReadProvider firstRead={firstRead}> <PhoenixCrmApp initialOverview={load.overview} initialTab={tab} surface="admin" /> </CrmFirstReadProvider>'), "RED and hands it over");

  const hook = squeeze(code("src/components/phoenix-crm/api.ts"));
  assert.ok(hook.includes("const handedOver = nonce === 0 ? firstReadFor(firstRead, url, key) : null;"), "RED a reload wants newer data than the page had, so it never takes the page's read");
  assert.ok(hook.includes("(handedOver ? readFirst<T>(handedOver, readItself) : readItself()).then("), "RED and everything else reads exactly as before");
  assert.ok(hook.includes("[firstRead, key, nonce, url]"), "the effect's own list");
  assert.equal((hook.match(/landed\(\);/g) ?? []).length, 2, "RED a read that landed, answer or failure, is spent");

  const provider = code("src/components/phoenix-crm/first-read.ts");
  assert.match(provider, /const \[held\] = useState\(firstRead\);/, "RED held from the first render, so a refresh cannot run the screen's effect again");
  assert.ok(squeeze(provider).includes("useEffect(() => { firstReadArrived(held, firstRead); }, [firstRead, held]);"), "RED a read arriving under a screen already up is marked, or Back draws it");
  assert.ok(code("src/lib/phoenix-crm/server/first-read.ts").includes("startedAt: Date.now()"), "RED every read the page starts says when, which is how one left behind is refused");
}

export async function runPhoenixCrmFirstReadTests() {
  testHandOverRules();
  await testAnswerOrItsOwnRead();
  testThePageCannotTellARefresh();
  testEachTabsAddress();
  testTabsStillAskForThoseAddresses();
  testEachLoadIsItsRoutesOwn();
  testThePagesAndTheHook();
}
