import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  computePhoenixCrmKpis,
  phoenixCrmCallRateText,
  phoenixCrmCallRateWindow,
  phoenixCrmMonthBounds,
  phoenixCrmRepWindow,
  type PhoenixCrmFrequencyNorms,
  type PhoenixCrmKpiInput,
} from "../src/lib/crm/native-visits/phoenix-crm-kpi-rules.ts";
import {
  isNativeEntryDay,
  isNativeEntryOffered,
  NATIVE_PILOT_ROSTER_OPEN_END,
  nativeVisitPilotForRep,
} from "../src/lib/crm/native-visits/rules.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Phoenix CRM — its own space for the pilot (the owner, 2026-09-14).
//
// WHAT THIS FILE GUARDS:
//   · THE ROSTER IS THE GATE. A rep opens Phoenix CRM when the Super Admin put HIM on the roster, from
//     that day, with no end until removed — a whole line no longer opens it.
//   · THE KPIs READ PHOENIX ONLY ("start clean from scratch"): call rate AM against 2 and PM against 10,
//     REPORTED APART and never averaged; coverage; frequency, with a grade that carries no norm left out;
//     plan achieved, on the day the verified plan named. Only a doctor visit counts; 100000 is no doctor.
//   · EVERY EXPORTED SERVICE FUNCTION CHECKS crm_visit_entry ITSELF; the roster needs update; the rep is
//     told in-app, never by email; a roster row is never deleted.
//   · THE SPACE IS REACHED from My Visits, and the old pilot pages land in it.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATION = "supabase/migrations/20260914170000_phoenix_crm_pilot_reps.sql";

function read(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

export async function runPhoenixCrmTests() {
  // ── 1. The roster is the gate ────────────────────────────────────────────────────────────────
  const roster = [{ hrId: "B-12", startsOn: "2026-09-14" }];
  const pilot = nativeVisitPilotForRep({ hrId: "b-12", lineName: "Pedia" }, roster);
  assert.deepEqual(
    pilot,
    { lineName: "Pedia", startsOn: "2026-09-14", endsOn: NATIVE_PILOT_ROSTER_OPEN_END, isActive: true },
    "a rep on the roster is in the pilot from the day they were added, with no end until removed",
  );
  assert.equal(nativeVisitPilotForRep({ hrId: "B-13", lineName: "Pedia" }, roster), null, "a rep of the same line who is not on it is not");
  assert.equal(nativeVisitPilotForRep({ hrId: null, lineName: "Pedia" }, roster), null);
  assert.equal(nativeVisitPilotForRep({ hrId: "B-12", lineName: "Pedia" }, [{ hrId: "B-12", startsOn: "soon" }]), null, "a broken start day opens nothing");
  const gate = { pilot, cutoverDate: null };
  assert.equal(isNativeEntryDay(gate, "2026-09-13"), false, "no day before they joined");
  assert.equal(isNativeEntryDay(gate, "2026-09-14"), true);
  assert.equal(isNativeEntryDay(gate, "2027-03-01"), true, "and no end date");
  assert.equal(isNativeEntryOffered(gate, "2027-03-01"), true);

  const shared = read("src/lib/crm/native-visits/server-shared.ts");
  assert.match(
    shared,
    /from\(CRM_NATIVE_PILOT_REPS_TABLE\)\s*\.select\("hr_id,starts_on"\)\s*\.is\("removed_at", null\)/,
    "the gate reads the roster, and a removed rep is off it",
  );
  assert.match(shared, /pilot: nativeVisitPilotForRep\(rep, roster\)/, "the gate opens a day for the rep themselves, not for their line");

  // ── 2. The KPIs, from Phoenix only ───────────────────────────────────────────────────────────
  const norms: PhoenixCrmFrequencyNorms = { AM: { A: 2, B: null, C: 1 }, PM: { A: 1, B: 2, C: 1 } };
  const result = computePhoenixCrmKpis({
    workingDays: 2,
    cairoToday: "2026-09-16",
    norms,
    panel: [
      { contactCrmId: 1, lists: ["AM"], grade: "A" },
      { contactCrmId: 2, lists: ["PM"], grade: "B" },
      { contactCrmId: 3, lists: ["PM"], grade: null },
      { contactCrmId: 4, lists: ["AM", "PM"], grade: "C" },
      { contactCrmId: 100000, lists: ["PM"], grade: "A" },
    ],
    visits: [
      { contactCrmId: 1, shift: "AM", visitDate: "2026-09-14", visitType: "regular" },
      { contactCrmId: 1, shift: "AM", visitDate: "2026-09-15", visitType: "regular" },
      { contactCrmId: 2, shift: "PM", visitDate: "2026-09-14", visitType: "regular" },
      { contactCrmId: 2, shift: "PM", visitDate: "2026-09-16", visitType: "regular" },
      { contactCrmId: 4, shift: "PM", visitDate: "2026-09-15", visitType: "regular" },
      { contactCrmId: 3, shift: "PM", visitDate: "2026-09-14", visitType: "campaign" },
      { contactCrmId: 100000, shift: "PM", visitDate: "2026-09-14", visitType: "regular" },
    ],
    planned: [
      { contactCrmId: 1, planDate: "2026-09-14" },
      { contactCrmId: 1, planDate: "2026-09-14" },
      { contactCrmId: 2, planDate: "2026-09-15" },
      { contactCrmId: 4, planDate: "2026-09-15" },
      { contactCrmId: 2, planDate: "2026-09-16" },
      { contactCrmId: 4, planDate: "2026-09-16" },
      { contactCrmId: 100000, planDate: "2026-09-14" },
    ],
  });
  assert.deepEqual(Object.keys(result.callRate), ["AM", "PM"], "the call rate is a pair — there is no combined figure to show");
  assert.deepEqual(result.callRate.AM, { calls: 2, perDay: 1, target: 2, attainmentPct: 50 }, "AM against 2");
  assert.deepEqual(
    result.callRate.PM,
    { calls: 3, perDay: 1.5, target: 10, attainmentPct: 15 },
    "PM against 10 — the campaign visit and the catch-all contact are not doctor visits",
  );
  assert.equal(phoenixCrmCallRateText(result.callRate), "1.0 AM · 1.5 PM", "side by side, never a slash, never averaged");
  assert.deepEqual(result.coverage.AM, { of: 2, hit: 1, pct: 50 });
  assert.deepEqual(result.coverage.PM, { of: 3, hit: 2, pct: 67 }, "100000 is no doctor on the list; a campaign visit covers nobody");
  assert.deepEqual(result.frequency.AM, { of: 2, hit: 1, pct: 50 }, "each grade against its own norm: the A doctor met 2, the C doctor missed 1");
  assert.deepEqual(result.frequency.PM, { of: 2, hit: 2, pct: 100 }, "an ungraded doctor is left out, never scored as a miss");
  assert.deepEqual(
    result.planAchieved,
    { of: 4, hit: 3, pct: 75 },
    "a planned call is due once its day passed, or today once kept; a doctor visited on another day is not kept",
  );

  const unscored = computePhoenixCrmKpis({
    workingDays: 0,
    cairoToday: "2026-09-16",
    panel: [{ contactCrmId: 9, lists: ["AM"], grade: "B" }],
    visits: [],
    planned: [],
  });
  assert.deepEqual(unscored.frequency.AM, { of: 0, hit: 0, pct: null }, "the company norm holds a B doctor to nothing, so it is not scored");
  assert.equal(unscored.callRate.AM.perDay, null, "no working day yet: no rate, never a zero");
  assert.equal(phoenixCrmCallRateText(unscored.callRate), "— AM · — PM");

  assert.deepEqual(phoenixCrmMonthBounds("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
  assert.equal(phoenixCrmMonthBounds("2026-13"), null);
  const september = { from: "2026-09-01", to: "2026-09-30" };
  assert.deepEqual(phoenixCrmRepWindow(september, "2026-09-14", "2026-09-16"), { from: "2026-09-14", to: "2026-09-16" }, "from the day they joined, to today");
  assert.equal(phoenixCrmRepWindow(september, "2026-09-20", "2026-09-16"), null, "nothing counted before they joined");

  // ── 2b. The owner's ruling C1 (2026-09-21): the call rate stops at yesterday ─────────────────
  // As on Reps List and the KPIs board: today is not scored until it is over, its calls and its day
  // together. Coverage, frequency and plan achieved keep counting today — none divides by days.
  const running = phoenixCrmRepWindow(september, "2026-09-14", "2026-09-16");
  assert.deepEqual(phoenixCrmCallRateWindow(running, "2026-09-16"), { from: "2026-09-14", to: "2026-09-15" }, "the call rate drops today while it runs");
  assert.deepEqual(
    phoenixCrmCallRateWindow({ from: "2026-08-01", to: "2026-08-31" }, "2026-09-16"),
    { from: "2026-08-01", to: "2026-08-31" },
    "a month already over is scored whole",
  );
  assert.equal(phoenixCrmCallRateWindow({ from: "2026-09-16", to: "2026-09-16" }, "2026-09-16"), null, "a rep who joined today has no day over yet");
  assert.equal(phoenixCrmCallRateWindow(null, "2026-09-16"), null);

  const c1Input: PhoenixCrmKpiInput = {
    workingDays: 2,
    cairoToday: "2026-09-16",
    norms,
    panel: [
      { contactCrmId: 1, lists: ["AM"], grade: "A" },
      { contactCrmId: 2, lists: ["PM"], grade: "A" },
      { contactCrmId: 5, lists: ["PM"], grade: "A" },
    ],
    visits: [
      { contactCrmId: 1, shift: "AM", visitDate: "2026-09-14", visitType: "regular" },
      { contactCrmId: 1, shift: "AM", visitDate: "2026-09-15", visitType: "regular" },
      { contactCrmId: 2, shift: "PM", visitDate: "2026-09-15", visitType: "regular" },
      // Today: the only visit doctor 5 has had, and one more for doctor 1.
      { contactCrmId: 5, shift: "PM", visitDate: "2026-09-16", visitType: "regular" },
      { contactCrmId: 1, shift: "AM", visitDate: "2026-09-16", visitType: "regular" },
    ],
    planned: [{ contactCrmId: 5, planDate: "2026-09-16" }],
  };
  const c1 = computePhoenixCrmKpis({ ...c1Input, callRateWindow: { from: "2026-09-14", to: "2026-09-15" } });
  assert.deepEqual(c1.callRate.AM, { calls: 2, perDay: 1, target: 2, attainmentPct: 50 }, "today's AM call waits for tomorrow");
  assert.deepEqual(c1.callRate.PM, { calls: 1, perDay: 0.5, target: 10, attainmentPct: 5 }, "and so does today's PM call");
  assert.deepEqual(c1.coverage.PM, { of: 2, hit: 2, pct: 100 }, "doctor 5, seen only TODAY, is already covered");
  const allDays = computePhoenixCrmKpis(c1Input);
  assert.equal(allDays.callRate.AM.calls, 3, "left out, every visit given counts toward the rate");
  assert.deepEqual(c1.coverage, allDays.coverage, "coverage does not move — the ruling is the call rate's");
  assert.deepEqual(c1.frequency, allDays.frequency, "and neither does frequency");
  assert.deepEqual(c1.planAchieved, { of: 1, hit: 1, pct: 100 }, "a planned call kept today still counts as kept");
  assert.deepEqual(c1.planAchieved, allDays.planAchieved);
  const joinedToday = computePhoenixCrmKpis({ ...c1Input, workingDays: 0, callRateWindow: null });
  assert.equal(joinedToday.callRate.AM.calls, 0, "no day over: no call counts");
  assert.equal(joinedToday.callRate.PM.perDay, null, "so there is no rate — a dash, never a red 0.0");
  assert.equal(joinedToday.coverage.PM.hit, 2, "while today's doctors already count as covered");

  // ── 3. The service ───────────────────────────────────────────────────────────────────────────
  const service = read("src/lib/crm/native-visits/phoenix-crm.ts");
  const exported = [...service.matchAll(/export async function (\w+)\(/g)];
  assert.equal(exported.length, 5, "the Phoenix CRM service's exported functions must be found");
  exported.forEach((match, index) => {
    const body = service.slice(match.index, exported[index + 1]?.index ?? service.length);
    const guard = match[1] === "getPhoenixCrmAccess" ? /canAccess\(access, "crm_visit_entry"/ : /assertPermission\(access, "crm_visit_entry"/;
    assert.match(body, guard, `${match[1]} must check crm_visit_entry itself, not trust its caller`);
  });
  for (const name of ["listPhoenixCrmPilotRoster", "setPhoenixCrmPilotRep"]) {
    const start = service.indexOf(`export async function ${name}(`);
    assert.match(service.slice(start, start + 400), /await assertPermission\(access, "crm_visit_entry", "update"\);/, `${name} is the Super Admin's`);
  }
  const setRep = service.slice(service.indexOf("export async function setPhoenixCrmPilotRep("), service.indexOf("// ── KPIs"));
  assert.match(setRep, /isNativeVisitRepTitle\(rep\.jobTitle\)/, "only a medical rep goes on the roster");
  assert.match(setRep, /if \(!isAgentInScope\(scope, rep\.hrId\)\) throw forbiddenError\(/, "and only one inside the caller's scope");
  assert.doesNotMatch(service, /from\(CRM_NATIVE_PILOT_REPS_TABLE\)\s*\.delete\(/, "a roster row is never deleted — removal stamps it");
  const notify = service.slice(service.indexOf("async function notifyRepOfRosterChange"), service.indexOf("export async function setPhoenixCrmPilotRep("));
  assert.match(notify, /channels: \["in_app"\]/, "the rep is told in-app");
  assert.doesNotMatch(notify, /"email"|email:/, "and never by email");
  assert.doesNotMatch(
    service + read("src/lib/crm/native-visits/phoenix-crm-kpi-rules.ts"),
    /ireports360|IREPORTS360|CRM_VISITS_TABLE|CRM_PLAN_ENTRIES_TABLE/,
    "Phoenix CRM's KPIs read what the pilot reps entered in Phoenix, never the vendor feed",
  );
  assert.match(service, /visitType: String\(row\.visit_type/, "the visit type key is carried to the rules, which count only a doctor visit");
  assert.match(service, /status: "verified"/, "plan achieved reads verified plans only");
  assert.match(
    service,
    /const callRateWindow = phoenixCrmCallRateWindow\(window, cairoToday\);\s*const result = computePhoenixCrmKpis\(\{\s*workingDays: callRateWindow \? countCallRateWorkingDays\(callRateWindow\.from, callRateWindow\.to, holidays\.dates\) : 0,/,
    "ruling C1: the call rate's working days stop at yesterday",
  );
  assert.match(service, /visits: \(visitsByRep\.get\(repKey\) \?\? \[\]\)\.filter\(\(visit\) => inWindow\(visit\.visitDate\)\),\s*callRateWindow,/, "and so do its calls");
  const board = read("src/components/employee-portal/phoenix-crm-kpi-board.tsx");
  assert.match(board, /scored\s+through yesterday: today is not scored until it is over/, "the board says the call rate stops at yesterday");
  assert.match(board, /call rate to \$\{dayLabel\(row\.callRateWindow\.to\)\}/, "and to which day, on every row");
  assert.match(board, /call rate starts once today is over/, "and why a rep who joined today has no rate");

  // ── 4. The route and the table ───────────────────────────────────────────────────────────────
  const route = read("app/api/crm/phoenix-crm/pilot-reps/route.ts");
  assert.equal((route.match(/await assertPermission\(access, "crm_visit_entry", "update"\);/g) ?? []).length, 2, "both roster methods check update");
  assert.ok(
    route.indexOf("assertSameOriginMutation(request)") > 0 && route.indexOf("assertSameOriginMutation(request)") < route.indexOf("setPhoenixCrmPilotRep("),
    "a roster change checks the origin before it writes",
  );
  const registry = read("src/lib/security/access-registry.ts");
  assert.match(registry, /methods: \["GET"\], pattern: "\/api\/crm\/phoenix-crm\/pilot-reps", permission: \{ resource: "crm_visit_entry", action: "update" \}/);
  assert.match(registry, /methods: \["POST"\], pattern: "\/api\/crm\/phoenix-crm\/pilot-reps", permission: \{ resource: "crm_visit_entry", action: "update" \}, guard: "assert-permission", csrfRequired: true/);
  const sql = read(MIGRATION).replace(/--[^\n]*/g, "");
  for (const table of ["crm_native_pilot_reps", "crm_native_pilot_rep_events"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`), `${table} has RLS on`);
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from anon, authenticated;`), `${table} is closed to the browser roles`);
  }
  assert.doesNotMatch(sql, /\bgrant\b/i, "nothing is granted to a browser role");

  // ── 5. The space and how it is reached ───────────────────────────────────────────────────────
  const space = read("src/components/employee-portal/phoenix-crm-space.tsx");
  assert.match(space, /tab === "pilot-reps" && seat === "admin" \? <PhoenixCrmPilotRosterWorkspace \/>/, "only the Super Admin picks the pilot reps");
  assert.match(space, /return seat === "admin" \? \["visits", "planning", "kpis", "pilot-reps"\] : \["visits", "planning", "kpis"\];/);
  // The owner hid the pilot's links when the clean Phoenix CRM shipped (2026-09-16): My Visits and the
  // admin rail open the new module, and nothing offers the pilot any more. Its two pages forward to the
  // field app since 2026-09-25 — pinned in tests/phoenix-crm-retired-pilot-redirect.test.ts.
  assert.doesNotMatch(read("app/employee-portals/visits/page.tsx"), /href="\/employee-portals\/phoenix-crm"/, "My Visits no longer links the pilot");
  assert.doesNotMatch(read("src/config/system-navigation.ts"), /href: "\/admin\/phoenix-crm"/, "the admin rail no longer links the pilot");
  for (const component of ["phoenix-crm-kpi-board", "phoenix-crm-pilot-roster-workspace", "phoenix-crm-plans-overview", "phoenix-crm-team-visits"]) {
    const source = read(`src/components/employee-portal/${component}.tsx`);
    assert.match(source, /<table className="w-full table-fixed[^"]*">\s*<colgroup>/, `${component} fits the screen: a fixed table with a colgroup`);
    assert.match(source, /md:hidden/, `${component} gives a phone cards`);
    assert.doesNotMatch(source, /AM \/|\/ PM/, `${component} never joins AM and PM with a slash`);
  }
}
