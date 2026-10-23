import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeCallRate, type VisitForCallRate } from "../src/lib/crm/call-rate.ts";
import { DEFAULT_DOCTOR_COVERAGE_NORMS } from "../src/lib/crm/doctor-coverage-config.ts";
import type { DoctorCoverageScope } from "../src/lib/crm/doctor-coverage-roles.ts";
import {
  crmIdsCarriedBy,
  KPI_NARROW_MAX_CRM_IDS,
  KPI_NARROW_MAX_PEOPLE,
  resolveKpiBoardAgents,
  type KpiBoardAgentReaders,
} from "../src/lib/crm/kpi-board-agents.ts";
import { joinKpiRows } from "../src/lib/crm/kpis-board.ts";
import {
  applyVisitFilter,
  collapseDuplicateVisitSubmissions,
  visitFilterNamesPeople,
  type VisitFilterableQuery,
} from "../src/lib/crm/reads.ts";
import { buildRepDoctorListsBoard, inPlanEntryOrder, type PlanRow, type VisitRow } from "../src/lib/crm/rep-doctor-lists.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";

/**
 * THE KPIs BOARD READS ONLY ITS SCOPE'S REPS, AND EVERY FIGURE IS THE ONE THE COMPANY-WIDE READ GAVE.
 *
 * A medical rep's landing tile asked the board for his one row and the board read the whole
 * company's month first (2.7 s at the end of September, measured on production). It now reads only
 * the reps in scope — but a rep's identity on that board comes from his own ROWS (the call rate's
 * first non-blank hr id, else the doctor lists' first), so "his rows" must mean exactly the rows
 * the company-wide read would have credited to him. This drives the REAL discovery
 * (`resolveKpiBoardAgents`) over fixture rows, selects rows the way the SQL filter does, runs the
 * same pure builders, and asserts the board is identical — for the shapes that make it easy to get
 * wrong: a first plan row with no hr id, a rep whose hr id sits ONLY on his plan rows (every rep on
 * the 1st of a month), a native rep with no CRM id, a reused CRM slot, a duplicate re-save, and
 * mixed-case hr ids.
 */

const MONTH = "2026-09";
const FROM = "2026-09-01";
const CALL_TO = "2026-09-09";
const WINDOW_END = "2026-09-30";

type Visit = VisitForCallRate &
  VisitRow & { id: string; crm_visit_id: number | null; double_crm_id: number | null; crm_save_date: string | null };
type Checkin = { agent_crm_id: number | null; agent_hr_id: string | null; contact_crm_id: number | null; check_date: string | null };
type Plan = PlanRow & { crm_plan_entry_id: number };

let visitSeq = 0;
function visit(agentCrmId: number | null, agentHrId: string | null, contact: number, day: string, extra: Partial<Visit> = {}): Visit {
  visitSeq += 1;
  return {
    // Ids rise in creation order, so creation order IS the visits door's id order.
    id: `00000000-0000-4000-8000-${String(visitSeq).padStart(12, "0")}`,
    crm_visit_id: agentCrmId == null ? null : 90_000 + visitSeq,
    double_crm_id: null,
    agent_crm_id: agentCrmId,
    agent_hr_id: agentHrId,
    agent_name: `Agent ${agentCrmId ?? agentHrId}`,
    ampm: "PM",
    comment: null,
    contact_crm_id: contact,
    crm_contact_grade: "A",
    crm_save_date: `${day}T10:00:00`,
    speciality: "Internal Medicine",
    visit_date: day,
    visit_type: 0,
    visit_type_description: "Regular Visit",
    ...extra,
  };
}
function checkin(agentCrmId: number | null, agentHrId: string | null, contact: number, day: string): Checkin {
  return { agent_crm_id: agentCrmId, agent_hr_id: agentHrId, contact_crm_id: contact, check_date: `${day}T10:05:00` };
}
let entrySeq = 0;
function plan(agentCrmId: number | null, agentHrId: string | null, contact: number, day: string): Plan {
  entrySeq += 1;
  return {
    agent_crm_id: agentCrmId,
    agent_hr_id: agentHrId,
    contact_crm_id: contact,
    contact_grade: "A",
    contact_name: `Doctor ${contact}`,
    crm_region_name: "Cairo",
    plan_date: day,
    plan_status: 1,
    speciality: "Internal Medicine",
    synced_at: "2026-09-01T00:00:00.000Z",
    crm_plan_entry_id: entrySeq,
  };
}

// Rows are created in id / entry order, exactly as the doors return them company-wide.
const plans: Plan[] = [
  plan(105, "B-9", 7401, "2026-09-01"), // E — a reused CRM slot, its earliest row the previous holder's
  plan(101, null, 7001, "2026-09-02"), // A — his FIRST plan row carries no hr id
  plan(102, "B-2", 7101, "2026-09-02"), // B — out of every scope below but his own
  plan(104, "B-4", 7301, "2026-09-02"), // D — the ONLY rows naming him are plan rows
  plan(101, "b-1", 7002, "2026-09-03"), // A — lower-cased hr id
  plan(null, "B-3", 7201, "2026-09-04"), // C — a native rep with no CRM id
  plan(104, null, 7302, "2026-09-06"),
  plan(101, "B-1", 7003, "2026-09-15"),
];
const visits: Visit[] = [
  visit(105, "B-9", 7401, "2026-09-01"),
  visit(101, "B-1", 7001, "2026-09-02"),
  visit(102, "B-2", 7101, "2026-09-02"),
  visit(104, null, 7301, "2026-09-02"),
  // The same stop saved twice: the collapse keeps one, keyed on the agent.
  visit(101, "B-1", 7001, "2026-09-02", { crm_save_date: "2026-09-02T10:30:00" }),
  visit(101, null, 7002, "2026-09-03"),
  visit(null, "B-3", 7201, "2026-09-04"),
  visit(101, "B-1", 7004, "2026-09-05"),
  visit(104, null, 7302, "2026-09-06"),
  visit(105, "B-1", 7402, "2026-09-07"),
  visit(101, "B-1", 7003, "2026-09-15"), // after the call window: doctor lists only
];
const checkins: Checkin[] = [
  checkin(101, null, 7001, "2026-09-02"),
  checkin(102, "B-2", 7101, "2026-09-02"),
  checkin(104, null, 7301, "2026-09-02"),
  checkin(null, "B-3", 7201, "2026-09-04"),
];

type BoardRows = { callVisits: Visit[]; checkins: Checkin[]; docVisits: Visit[]; plans: Plan[] };

const between = (day: string | null, from: string, to: string) => Boolean(day) && String(day).slice(0, 10) >= from && String(day).slice(0, 10) <= to;
const COMPANY: BoardRows = {
  callVisits: visits.filter((row) => between(row.visit_date, FROM, CALL_TO)),
  checkins: checkins.filter((row) => between(row.check_date, FROM, CALL_TO)),
  docVisits: visits.filter((row) => between(row.visit_date, FROM, WINDOW_END) && (row.visit_type === 0 || row.visit_type === -8)),
  plans: plans.filter((row) => between(row.plan_date, FROM, WINDOW_END)),
};

/** `agent_hr_id IN <every casing variant>` — what the doors' hr-id filters match. */
const hrMatches = (agentHrId: string | null | undefined, hrIds: readonly string[]) => {
  const key = canonicalHrIdKey(agentHrId ?? null);
  return Boolean(key) && hrIds.some((id) => canonicalHrIdKey(id) === key);
};
const READERS: KpiBoardAgentReaders = {
  visits: async ({ agentHrIds, dateFrom, dateTo }) =>
    visits.filter((row) => between(row.visit_date, dateFrom, dateTo) && hrMatches(row.agent_hr_id, agentHrIds)),
  plans: async (from, to, { agentHrIds }) =>
    plans.filter((row) => between(row.plan_date, from, to) && hrMatches(row.agent_hr_id, agentHrIds)),
};

/** The rows the narrowed reads hand the builders — `agent_crm_id IN crmIds OR agent_hr_id IN hrIds`. */
function narrowed(agents: { crmIds: readonly number[]; hrIds: readonly string[] }): BoardRows {
  const picked = (row: { agent_crm_id: number | null; agent_hr_id: string | null }) =>
    (row.agent_crm_id != null && agents.crmIds.includes(row.agent_crm_id)) || hrMatches(row.agent_hr_id, agents.hrIds);
  // scanPlanEntries' union: the CRM-id pass in entry order, then the hr-id pass's new rows.
  const crmPass = COMPANY.plans.filter((row) => row.agent_crm_id != null && agents.crmIds.includes(row.agent_crm_id));
  const hrPass = COMPANY.plans.filter((row) => hrMatches(row.agent_hr_id, agents.hrIds) && !crmPass.includes(row));
  return {
    callVisits: COMPANY.callVisits.filter(picked),
    checkins: COMPANY.checkins.filter(picked),
    docVisits: COMPANY.docVisits.filter(picked),
    plans: inPlanEntryOrder([...crmPass, ...hrPass]) as Plan[],
  };
}

function boardFor(scope: DoctorCoverageScope, rows: BoardRows) {
  const rate = computeCallRate(collapseDuplicateVisitSubmissions(rows.callVisits), rows.checkins, { dateFrom: FROM, dateTo: CALL_TO });
  const lists = buildRepDoctorListsBoard({
    employeeNameByHrId: new Map(),
    excludedAgentCrmIds: [],
    month: MONTH,
    norms: DEFAULT_DOCTOR_COVERAGE_NORMS,
    planRows: rows.plans,
    visitRows: collapseDuplicateVisitSubmissions(rows.docVisits),
    window: { from: FROM, to: WINDOW_END },
  });
  return joinKpiRows({ callRates: rate.reps, docLists: lists.reps, scope, workingDays: rate.workingDays });
}

const agentsScope = (agentHrIds: string[], basis: "self" | "team" = "self"): DoctorCoverageScope => ({ kind: "agents", basis, agentHrIds, label: "" });

type Call = [method: string, ...args: unknown[]];
function recordingQuery(calls: Call[]): VisitFilterableQuery {
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push([method, ...args]);
      return query;
    };
  const query: VisitFilterableQuery = {
    eq: record("eq"),
    gte: record("gte"),
    ilike: record("ilike"),
    in: record("in"),
    is: record("is"),
    lte: record("lte"),
    neq: record("neq"),
    not: record("not"),
    or: record("or"),
  };
  return query;
}

export async function runKpiBoardAgentsTests() {
  // ── 1. The board a scope sees is the board the company-wide read gave it ─────────────────────
  for (const [label, scope] of [
    ["a rep whose first plan row has no hr id", agentsScope(["B-1"])],
    ["a native rep with no CRM id", agentsScope(["B-3"])],
    ["a rep named ONLY on his plan rows", agentsScope(["B-4"])],
    ["a district team of all three", agentsScope(["B-1", "b-3", "B-4"], "team")],
    ["the previous holder of a reused CRM slot", agentsScope(["B-9"])],
    ["a rep nobody else's rows touch", agentsScope(["B-2"])],
  ] as const) {
    const agents = await resolveKpiBoardAgents(scope, { from: FROM, to: WINDOW_END }, READERS);
    assert.ok(agents, `${label}: a scope of ${scope.kind === "agents" ? scope.agentHrIds.length : 0} is narrowed`);
    assert.deepEqual(
      boardFor(scope, narrowed(agents)),
      boardFor(scope, COMPANY),
      `${label}: the narrowed read must give exactly the board the company-wide read gave`,
    );
  }

  // Not vacuous: the cases above really carry the figures they are about.
  const repD = boardFor(agentsScope(["B-4"]), COMPANY);
  assert.equal(repD.length, 1, "D is on his own board");
  assert.equal(repD[0].hasCallRate, true, "D's call rate reaches his row through the hr id on his PLAN rows");
  assert.ok(repD[0].pmVerified > 0, "and it carries his verified call");
  const repA = boardFor(agentsScope(["B-1"]), COMPANY);
  assert.equal(repA.length, 1, "A is one row — the reused slot E is judged by its previous holder's first hr id");
  assert.ok(repA[0].plannedDoctors > 0 && repA[0].hasCallRate, "A has both halves");

  // The discovery is what makes D right: his hr id is on no visit, so only the PLAN read finds his
  // CRM id, and without it his call-rate rows would never be read.
  const forD = await resolveKpiBoardAgents(agentsScope(["B-4"]), { from: FROM, to: WINDOW_END }, READERS);
  assert.deepEqual(forD, { crmIds: [104], hrIds: ["B-4"] }, "D's CRM id is found from his plan rows");
  const forA = await resolveKpiBoardAgents(agentsScope(["B-1"]), { from: FROM, to: WINDOW_END }, READERS);
  assert.deepEqual(forA, { crmIds: [101, 105], hrIds: ["B-1"] }, "every CRM id that carries his hr id, the reused slot included");

  // ── 2. Bounded: only small scopes narrow, and anything doubtful reads company-wide ─────────────
  const company: DoctorCoverageScope = { kind: "company", basis: "company", label: "Company" };
  assert.equal(await resolveKpiBoardAgents(company, { from: FROM, to: WINDOW_END }, READERS), null, "a company scope keeps the company-wide read");
  const tooMany = agentsScope(Array.from({ length: KPI_NARROW_MAX_PEOPLE + 1 }, (_, i) => `B-${500 + i}`), "team");
  assert.equal(await resolveKpiBoardAgents(tooMany, { from: FROM, to: WINDOW_END }, READERS), null, "a scope wider than a team keeps the company-wide read");
  assert.deepEqual(
    await resolveKpiBoardAgents(agentsScope([]), { from: FROM, to: WINDOW_END }, READERS),
    { crmIds: [], hrIds: [] },
    "an agents scope naming nobody reads nobody — what the company-wide read showed it",
  );
  const manyIds: KpiBoardAgentReaders = {
    visits: async () => Array.from({ length: KPI_NARROW_MAX_CRM_IDS + 1 }, (_, i) => ({ agent_crm_id: 1000 + i })),
    plans: async () => [],
  };
  assert.equal(await resolveKpiBoardAgents(agentsScope(["B-1"]), { from: FROM, to: WINDOW_END }, manyIds), null, "too many ids for one URL list keeps the company-wide read");
  const failing: KpiBoardAgentReaders = {
    visits: async () => {
      throw new Error("visits door down");
    },
    plans: async () => [],
  };
  const originalWarn = console.warn;
  const originalLog = console.log;
  try {
    console.warn = () => undefined;
    console.log = () => undefined;
    assert.equal(await resolveKpiBoardAgents(agentsScope(["B-1"]), { from: FROM, to: WINDOW_END }, failing), null, "a failed discovery reads company-wide: slower, never wrong");
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
  assert.deepEqual(crmIdsCarriedBy([{ agent_crm_id: 7 }, { agent_crm_id: null }, { agent_crm_id: 3 }, { agent_crm_id: 7 }]), [3, 7]);

  // ── 3. The visits door's either-id filter ─────────────────────────────────────────────────────
  const calls: Call[] = [];
  applyVisitFilter(recordingQuery(calls), { agentCrmOrHrIds: { crmIds: [101, 104], hrIds: ["B-1"] } }, "");
  const orCall = calls.find((call) => call[0] === "or");
  assert.ok(orCall, "the either-id filter is one `or`");
  assert.match(String(orCall[1]), /^agent_crm_id\.in\.\(101,104\),agent_hr_id\.in\.\(.+\)$/, "CRM ids OR every casing of the hr ids");
  assert.ok(!calls.some((call) => call[0] === "in"), "and never an AND of two `in` lists");
  const closed: Call[] = [];
  applyVisitFilter(recordingQuery(closed), { agentCrmOrHrIds: { crmIds: [], hrIds: ["  "] } }, "");
  assert.deepEqual(closed.find((call) => call[0] === "in"), ["in", "agent_crm_id", []], "nothing usable fails CLOSED — never every visit");
  assert.equal(visitFilterNamesPeople({ agentCrmOrHrIds: { crmIds: [101] } }), true, "a named read takes the single scan in id order");
  assert.deepEqual(
    inPlanEntryOrder([plans[6], plans[1], plans[4]]).map((row) => (row as Plan).crm_plan_entry_id),
    [2, 5, 7],
    "the union is put back into entry order",
  );

  // ── 4. Wired through the board and both loaders ───────────────────────────────────────────────
  const board = readFileSync("src/lib/crm/kpis-board.ts", "utf8");
  assert.match(
    board,
    /const agentsRead = input\.coverageDoctors\s*\?\s*Promise\.resolve\(null\)\s*:\s*resolveKpiBoardAgents\(scope, \{/,
    "the board resolves its reps once — and never for the Coverage tab, whose off-plan doctors are named from other reps' plans",
  );
  assert.match(board, /loadCallRateReport\(\{\s*dateFrom: callRange\.dateFrom,\s*dateTo: callRange\.dateTo,\s*reuseRecentWindow: true,\s*\.\.\.\(agents \? \{ agents \} : \{\}\),?\s*\}\)/, "the call rate reads only them");
  assert.match(board, /getRepDoctorLists\(\{[\s\S]{0,700}?\.\.\.\(agents \? \{ agents \} : \{\}\),\s*\}\)/, "and so do the doctor lists");
  const rate = readFileSync("src/lib/crm/call-rate-service.ts", "utf8");
  assert.match(rate, /agentCrmOrHrIds: \{ crmIds: input\.agents\.crmIds, hrIds: input\.agents\.hrIds \}/, "the call rate narrows by either id");
  assert.equal((rate.match(/\.\.\.narrowTo/g) ?? []).length, 2, "both its visits and its check-ins");
  const lists = readFileSync("src/lib/crm/rep-doctor-lists.ts", "utf8");
  assert.match(lists, /agentCrmIds: agents\.crmIds, agentHrIds: agents\.hrIds \}\)\.then\(inPlanEntryOrder\)/, "the narrowed plan union is re-ordered");
  assert.match(lists, /\.\.\.\(agents \? \{ agentCrmOrHrIds: \{ crmIds: agents\.crmIds, hrIds: agents\.hrIds \} \} : \{\}\)/, "the doctor-list visits narrow by either id");

  console.log("kpi board agents: OK");
}
