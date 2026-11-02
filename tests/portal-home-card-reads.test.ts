import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAccessContext, parseRoleStrict } from "../src/lib/auth/permissions.ts";
import { kpiBoardDiscovery } from "../src/lib/crm/kpi-board-agents.ts";
import { getKpisBoard } from "../src/lib/crm/kpis-board.ts";
import { PHOENIX_VISIT_DETAIL_COLUMNS } from "../src/lib/crm/phoenix-visit-detail.ts";
import { scanPlanEntries, type PlanChunkMemo } from "../src/lib/crm/rep-doctor-lists.ts";
import { getLiveDoubleVisitRows } from "../src/lib/double-visit-analytics/service.ts";
import { timedCard } from "../src/lib/employee-portal/home-snapshot.ts";
import { drainTimings } from "../src/lib/observability/timings.ts";
import { listMyUpcomingInterviewsFor } from "../src/lib/recruitment/interview-calendar.ts";
import { stripComments } from "./support/comment-strip.ts";

// 2 Nov 2026, "fix the portal home slow opens". 95 of the morning's 130 landing opens were medical reps,
// and the last thing on a rep's landing was his KPI tile: it read his month's plan rows SIX times, one
// after the other, because its discovery, its doctor lists and its Phoenix half each asked again and the
// Phoenix half only started once the rest had come back. The interview card waited on three more reads in
// turn to learn the calendar level of a rep with no interview. A manager's double-visit panel pulled 11 MB
// for the Phoenix field set it never prints. These run the REAL readers against a fake database that counts
// every request, so the count itself is what is pinned.

const FAKE_URL = "http://127.0.0.1:54397";
const PLANS = "crm_plan_entries_unified";
const VISITS = "crm_visits_unified";
const BOOKINGS = "ats_interview_bookings";
const MONTH = { from: "2026-11-01", to: "2026-11-30" };

type Answer = (table: string, url: URL) => unknown;
type Fake = { asked: Array<{ table: string; url: URL }>; count: (table: string) => number; mostAtOnce: () => number };

async function withFakeDatabase<T>(answer: Answer, run: (fake: Fake) => Promise<T>, delayOf: (table: string, url: URL) => number = () => 1): Promise<T> {
  const saved = { fetch: globalThis.fetch, key: process.env.SUPABASE_SERVICE_ROLE_KEY, url: process.env.NEXT_PUBLIC_SUPABASE_URL };
  process.env.NEXT_PUBLIC_SUPABASE_URL = FAKE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";
  const asked: Fake["asked"] = [];
  let inFlight = 0;
  let most = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, FAKE_URL, "a read must only ever reach the fake database");
    const table = url.pathname.replace("/rest/v1/", "");
    const method = String(init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    assert.ok(method === "GET" || method === "HEAD" || table.startsWith("rpc/"), `a landing read must never write: ${method} ${table}`);
    asked.push({ table, url });
    if (table === PLANS) {
      inFlight += 1;
      most = Math.max(most, inFlight);
    }
    await new Promise((resolve) => setTimeout(resolve, delayOf(table, url)));
    if (table === PLANS) inFlight -= 1;
    return new Response(JSON.stringify(answer(table, url) ?? []), { headers: { "content-type": "application/json" }, status: 200 });
  }) as typeof fetch;
  try {
    return await run({ asked, count: (table) => asked.filter((request) => request.table === table).length, mostAtOnce: () => most });
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  }
}

const planRow = (id: number, hrId: string | null, crmId: number | null) => ({
  agent_crm_id: crmId,
  agent_hr_id: hrId,
  crm_plan_entry_id: id,
  plan_date: "2026-11-03",
});

/** The CRM-id pass finds entries 2 and 5; the hr-id pass finds entries 1 and 5 (the one row both reach). */
const planAnswer: Answer = (table, url) => {
  if (table !== PLANS) return [];
  return url.searchParams.has("agent_crm_id")
    ? [planRow(5, "B-59", 7), planRow(2, null, 7)]
    : [planRow(1, "B-59", null), planRow(5, "B-59", 7)];
};

async function testAPlanChunkIsAskedOnce() {
  const memo: PlanChunkMemo = new Map();
  const both = { agentCrmIds: [7], agentHrIds: ["B-59"] };
  await withFakeDatabase(planAnswer, async ({ count }) => {
    const first = await scanPlanEntries(MONTH.from, MONTH.to, { ...both, memo });
    assert.equal(count(PLANS), 2, "one request per pass");
    const second = await scanPlanEntries(MONTH.from, MONTH.to, { ...both, memo });
    assert.equal(count(PLANS), 2, "the same pass of the same window is never asked for twice on one board");
    assert.deepEqual(second, first, "and it reads what the first scan read");

    // The memo is one board's: another window asks, and a scan with no memo always asks.
    await scanPlanEntries(MONTH.from, "2026-11-15", { ...both, memo });
    assert.equal(count(PLANS), 4, "another window is another read");
    await scanPlanEntries(MONTH.from, MONTH.to, both);
    assert.equal(count(PLANS), 6, "a caller with no memo reads live, every time");
  });
}

async function testThePassesRunSideBySideAndFoldInOrder() {
  // The first pass answers LAST, so a fold in order of arrival would put the hr-id rows first.
  const slowCrmPass = (table: string, url: URL) => (table === PLANS && url.searchParams.has("agent_crm_id") ? 40 : 1);
  await withFakeDatabase(
    planAnswer,
    async ({ mostAtOnce }) => {
      const rows = await scanPlanEntries(MONTH.from, MONTH.to, { agentCrmIds: [7], agentHrIds: ["B-59"] });
      assert.equal(mostAtOnce(), 2, "the two passes share nothing, so neither waits for the other");
      assert.deepEqual(
        rows.map((row) => (row as unknown as { crm_plan_entry_id: number }).crm_plan_entry_id),
        [2, 5, 1],
        "the union reads as it always did: the CRM pass in entry order, then what only the hr-id pass found, the shared row once",
      );
    },
    slowCrmPass,
  );
}

async function testABoardsDiscoveryIsAskedOnceAndFeedsTheMemo() {
  const memo: PlanChunkMemo = new Map();
  const discover = kpiBoardDiscovery(memo);
  const scope = { agentHrIds: ["B-59"], basis: "self", kind: "agents" } as Parameters<typeof discover>[0];
  await withFakeDatabase(planAnswer, async ({ count }) => {
    const agents = await discover(scope, MONTH);
    assert.deepEqual(agents?.hrIds, ["B-59"]);
    assert.equal(count(PLANS), 1, "discovery reads the rep's plan rows by hr id");
    const visitsAfterFirst = count(VISITS);
    assert.equal(await discover(scope, MONTH), agents, "the same window answers once");
    assert.equal(count(PLANS), 1);
    assert.equal(count(VISITS), visitsAfterFirst);

    // What the doctor lists and the Phoenix half then read: the hr-id pass is already held.
    await scanPlanEntries(MONTH.from, MONTH.to, { agentCrmIds: agents?.crmIds, agentHrIds: agents?.hrIds, memo });
    assert.equal(count(PLANS), 2, "only the CRM-id pass is new; the hr-id pass came from discovery");
  });
}

/** The whole tile, end to end: the regression this file exists for. */
async function testARepsBoardReadsHisPlanOnce() {
  const answer: Answer = (table, url) => {
    if (table === "rpc/phoenix_crm_started_team_reps") return [{ agent_crm_id: 7, counted_from: "2026-10-01", counted_until: null, hr_id: "B-59" }];
    if (table === "employees") {
      return [{ employment_status: "Active", full_name: "A Rep", hr_id: "B-59", job_title: "Medical Rep", line_name: "Delta" }];
    }
    if (table === VISITS) return url.searchParams.get("select")?.trim() === "agent_crm_id" ? [{ agent_crm_id: 7 }] : [];
    return planAnswer(table, url);
  };
  await withFakeDatabase(answer, async ({ asked, count }) => {
    const access = createAccessContext({ hrId: "B-59", loginId: "B-59", role: parseRoleStrict("Medical Rep"), source: "dev-header", testPersona: null });
    const board = await getKpisBoard({ access, month: "2026-11", todayIso: "2026-11-15" });
    assert.notEqual(board.scopeLabel, "No reach", `the fake must give the rep his own reach: ${board.scopeReason ?? ""}`);
    assert.ok(count(PLANS) > 0, "the board reads the plan");
    const passes = asked
      .filter((request) => request.table === PLANS)
      .map((request) => `${request.url.searchParams.has("agent_crm_id") ? "crm" : "hr"} ${request.url.searchParams.getAll("plan_date").join(" ")}`);
    assert.equal(new Set(passes).size, passes.length, `a board never asks one pass of one window twice — it asked ${passes.join(" | ")}`);
    assert.ok(count(PLANS) <= 4, `a rep's tile reads his plan in at most two windows of two passes, never six in turn: ${count(PLANS)}`);
  });
}

const ME = createAccessContext({ hrId: "B-59", loginId: "B-59", role: parseRoleStrict("Medical Rep"), source: "dev-header", testPersona: null });

const booking = (id: string, interviewer: string) => ({
  candidate_id: null,
  created_at: "2026-11-01T08:00:00.000Z",
  created_by_hr_id: "B-10",
  duration_minutes: 30,
  id,
  interviewer_hr_id: interviewer,
  outcome: null,
  panelist_hr_ids: [],
  platform: "Teams",
  requested_by_hr_id: "B-10",
  session_id: null,
  shared_with_hr_ids: [],
  starts_at: "2026-11-04T08:00:00.000Z",
});

async function testTheInterviewCardAsksOnlyWhenThereIsAnInterview() {
  const now = new Date("2026-11-02T08:00:00.000Z");
  await withFakeDatabase(
    (table) => (table === BOOKINGS ? [booking("someone-elses", "B-77")] : []),
    async ({ asked }) => {
      assert.deepEqual(await listMyUpcomingInterviewsFor(ME, now), []);
      assert.deepEqual(
        asked.map((request) => request.table),
        [BOOKINGS],
        "a person with no interview costs one read — never their shares, their selection and their record, in turn",
      );
    },
  );
  await withFakeDatabase(
    (table) => (table === BOOKINGS ? [booking("mine", "B-59"), booking("someone-elses", "B-77")] : []),
    async ({ count }) => {
      const rows = await listMyUpcomingInterviewsFor(ME, now);
      assert.deepEqual(rows.map((row) => row.id), ["mine"], "a person with one sees exactly their own, dressed");
      assert.ok(count("ats_interview_calendar_shares") >= 1, "and their calendar level is read to dress it, as it always was");
    },
  );
}

async function testTheFocusPanelLeavesTheFieldSetBehind() {
  const detail = PHOENIX_VISIT_DETAIL_COLUMNS.split(",").map((column) => column.trim());
  assert.ok(detail.length > 0, "the field set names columns");
  const visit = {
    agent_crm_id: 7,
    agent_hr_id: "B-59",
    ampm: "AM",
    double_crm_id: 9,
    double_hr_id: "B-116",
    id: "00000000-0000-0000-0000-000000000001",
    visit_date: "2026-11-03",
    visit_type: 0,
  };
  const selects = (asked: Fake["asked"]) => asked.filter((request) => request.table === VISITS).map((request) => request.url.searchParams.get("select") ?? "");
  const answer: Answer = (table) => (table === VISITS ? [visit] : []);

  await withFakeDatabase(answer, async ({ asked }) => {
    const rows = await getLiveDoubleVisitRows("2026-11-01", "2026-11-07", [], { withoutVisitDetail: true });
    assert.ok(selects(asked).length > 0, "the read reached the door");
    for (const select of selects(asked)) {
      for (const column of detail) assert.ok(!select.split(",").includes(column), `the focus read must not ask for ${column}`);
    }
    assert.equal(rows.length, 1, "and the row it counts still arrives");
  });
  await withFakeDatabase(answer, async ({ asked }) => {
    await getLiveDoubleVisitRows("2026-11-01", "2026-11-07", []);
    for (const select of selects(asked)) {
      for (const column of detail) assert.ok(select.split(",").includes(column), `every other reader keeps ${column} — the report prints it`);
    }
  });

  // Only the panel: the report prints these columns, and it reads this same loader.
  const service = stripComments(readFileSync("src/lib/double-visit-analytics/service.ts", "utf8"));
  assert.equal(service.split("withoutVisitDetail: true").length - 1, 1, "one caller leaves the field set out");
  const focus = service.slice(service.indexOf("getDoubleVisitPortalFocus("));
  assert.ok(
    focus.indexOf("withoutVisitDetail: true") >= 0 && focus.indexOf("withoutVisitDetail: true") < focus.indexOf("doubleVisitFocusTallies("),
    "and it is the focus panel, on the read its tallies count",
  );
  const tallies = service.slice(service.indexOf("function doubleVisitFocusTallies("));
  assert.ok(!tallies.slice(0, tallies.indexOf("\n}\n")).includes("phoenix_detail"), "the tallies never read what the panel left out");
}

async function testEachCardIsTimed() {
  drainTimings();
  assert.equal(await timedCard("test_ok", Promise.resolve("value")), "value", "a timer hands the answer on");
  const refused = new Error("refused");
  await assert.rejects(timedCard("test_refused", Promise.reject(refused)), refused, "and a failure, as it came");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const timings = drainTimings();
  assert.equal(timings["home.card.test_ok"]?.count, 1, "the process-health line names the card");
  assert.equal(timings["home.card.test_refused"]?.count, 1, "a failed read is timed too");

  const snapshot = stripComments(readFileSync("src/lib/employee-portal/home-snapshot.ts", "utf8"));
  for (const card of ["field_kpis", "double_visit_focus", "plan_adherence", "my_interviews", "sales", "rank", "role_extras"]) {
    assert.ok(snapshot.includes(`timedCard("${card}", `), `the landing times its ${card} card`);
  }
}

export async function runPortalHomeCardReadsTests() {
  await testAPlanChunkIsAskedOnce();
  await testThePassesRunSideBySideAndFoldInOrder();
  await testABoardsDiscoveryIsAskedOnceAndFeedsTheMemo();
  await testARepsBoardReadsHisPlanOnce();
  await testTheInterviewCardAsksOnlyWhenThereIsAnInterview();
  await testTheFocusPanelLeavesTheFieldSetBehind();
  await testEachCardIsTimed();
}
