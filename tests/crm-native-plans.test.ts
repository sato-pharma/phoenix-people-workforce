import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import {
  NATIVE_PLAN_ITEMS_PER_DAY_MAX,
  diffNativePlanItems,
  isNativePlanDiffEmpty,
  isNativePlanWeekStart,
  nativePlanDayLoadRefusal,
  nativePlanDayShifts,
  nativePlanDecisionRefusal,
  nativePlanEditableDays,
  nativePlanItemOutcome,
  nativePlanItemRefusal,
  nativePlanLockedDayRefusal,
  nativePlanOpenWeeks,
  nativePlanRepActionRefusal,
  nativePlanVisitedRemovalRefusal,
  nativePlanWeekDays,
  nativePlanWeekStart,
  parseNativePlanAction,
  parseNativePlanDecision,
  parseNativePlanItems,
  type NativePlanStoredItem,
} from "../src/lib/crm/native-visits/plan-rules.ts";
import {
  NATIVE_VISIT_NOT_PLANNED_MESSAGE,
  NATIVE_VISIT_PLAN_NOT_VERIFIED_MESSAGE,
  nativeVisitPlanRefusal,
} from "../src/lib/crm/native-visits/rules.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Native rep plans — the PILOT (CRM phase 4).
//
// WHAT THIS FILE GUARDS:
//   · THE FIELD WEEK is Saturday to Thursday, keyed by its Saturday, and Thursday is a morning only.
//   · ONLY PILOT DAYS FROM TODAY ON CAN CHANGE; a passed day is fixed.
//   · AM/PM IS THE CONTACT'S LIST (owner decision 2), and a doctor off the rep's lists is refused.
//   · STABLE IDS: one row per rep, doctor and day for good. A re-save keeps every id, a changed half-day
//     keeps its id, and a dropped doctor is marked removed and comes back as the SAME row — the vendor
//     issues a new id on every re-save, which is what inflated `plannedCalls`.
//   · ONLY THE MANAGER THE PLAN WAS SENT TO verifies or returns it, only while it is submitted, only for
//     a rep beneath that manager, and a return says why (owner decision 16). Nothing verifies on anyone's
//     behalf — not the system, not the Super Admin.
//   · THE REP IS THE SESSION, and the vendor plan, its sync and its write-back are untouched.
//   · NOTHING ELSE READS THE PLAN TABLES before cutover.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATION = "supabase/migrations/20260913210000_crm_native_rep_plans_pilot.sql";

function read(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function stripSqlComments(sql: string) {
  return sql.replace(/--[^\n]*/g, "");
}

function sourceFiles(relativeDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(child);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(child);
      }
    }
  };
  walk(relativeDir);
  return out;
}

// Pedia's pilot: Saturday 19 to Thursday 24 September 2026.
const PILOT = { endsOn: "2026-09-24", isActive: true, lineName: "Pedia", startsOn: "2026-09-19" };

export function runCrmNativePlansTests() {
  // ── 1. The field week ────────────────────────────────────────────────────────────────────────
  assert.equal(nativePlanWeekStart("2026-09-19"), "2026-09-19", "a Saturday starts its own week");
  assert.equal(nativePlanWeekStart("2026-09-24"), "2026-09-19", "the Thursday belongs to the week that began on Saturday");
  assert.equal(nativePlanWeekStart("2026-09-25"), "2026-09-19", "a Friday belongs to the week that ended the day before");
  assert.equal(nativePlanWeekStart("2026-09-26"), "2026-09-26");
  assert.equal(isNativePlanWeekStart("2026-09-19"), true);
  assert.equal(isNativePlanWeekStart("2026-09-20"), false, "a week is keyed by its Saturday only");
  assert.equal(isNativePlanWeekStart("19-09-2026"), false);
  assert.deepEqual(
    nativePlanWeekDays("2026-09-19"),
    ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"],
    "the week is Saturday to Thursday, never Friday",
  );
  assert.deepEqual(nativePlanDayShifts("2026-09-24"), ["AM"], "Thursday is a morning only");
  assert.deepEqual(nativePlanDayShifts("2026-09-20"), ["AM", "PM"]);

  // ── 2. Which weeks and days are open ─────────────────────────────────────────────────────────
  assert.deepEqual(nativePlanOpenWeeks(PILOT, "2026-09-13"), ["2026-09-19"], "the week before the pilot opens the pilot week");
  assert.deepEqual(nativePlanOpenWeeks(PILOT, "2026-09-22"), ["2026-09-19"], "mid-pilot, only the pilot week is open");
  assert.deepEqual(nativePlanOpenWeeks(PILOT, "2026-09-25"), [], "once the pilot has passed, nothing is open");
  assert.deepEqual(nativePlanOpenWeeks(null, "2026-09-13"), [], "another line plans nothing here");
  assert.deepEqual(nativePlanOpenWeeks({ ...PILOT, isActive: false }, "2026-09-13"), [], "an ended pilot opens nothing");
  assert.deepEqual(
    nativePlanEditableDays(PILOT, "2026-09-19", "2026-09-22"),
    ["2026-09-22", "2026-09-23", "2026-09-24"],
    "a passed day is fixed; today and later can change",
  );
  assert.deepEqual(nativePlanEditableDays(PILOT, "2026-09-20", "2026-09-13"), [], "a week that does not start on Saturday is not a week");

  // ── 3. The item list's shape ─────────────────────────────────────────────────────────────────
  assert.equal(parseNativePlanItems("not a list").ok, false);
  const parsed = parseNativePlanItems([
    { contactCrmId: 11, planDate: "2026-09-20", shift: "am", hrId: "B-999" },
    { contactCrmId: 11, planDate: "2026-09-20", shift: "PM" },
    { contactCrmId: 12, planDate: "2026-09-20", shift: "PM" },
  ]);
  assert.ok(parsed.ok && parsed.value.length === 2, "the same doctor twice on one day counts once");
  assert.ok(parsed.ok && parsed.value[0].shift === "AM" && !("hrId" in parsed.value[0]), "an item carries no person — the rep is the session");
  assert.equal(parseNativePlanItems([{ contactCrmId: 100000, planDate: "2026-09-20", shift: "AM" }]).ok, false, "contact 100000 is the catch-all");
  assert.equal(parseNativePlanItems([{ contactCrmId: 11, planDate: "2026-09-20", shift: "noon" }]).ok, false, "shift is AM or PM");
  assert.equal(parseNativePlanItems([{ contactCrmId: 11, planDate: "20/09/2026", shift: "AM" }]).ok, false);

  // ── 4. An item fits the week and the rep's own lists ─────────────────────────────────────────
  const inWeek = { weekStart: "2026-09-19", listTypes: ["AM"] };
  assert.equal(nativePlanItemRefusal({ contactCrmId: 5, planDate: "2026-09-20", shift: "AM" }, inWeek), null);
  assert.ok(nativePlanItemRefusal({ contactCrmId: 5, planDate: "2026-09-26", shift: "AM" }, inWeek), "a day in another week is refused");
  assert.ok(nativePlanItemRefusal({ contactCrmId: 5, planDate: "2026-09-25", shift: "AM" }, inWeek), "a Friday is refused");
  assert.ok(
    nativePlanItemRefusal({ contactCrmId: 5, planDate: "2026-09-24", shift: "PM" }, { ...inWeek, listTypes: ["PM"] }),
    "Thursday takes no PM doctor",
  );
  assert.ok(nativePlanItemRefusal({ contactCrmId: 5, planDate: "2026-09-20", shift: "PM" }, inWeek), "an AM-list doctor is planned AM");
  assert.ok(nativePlanItemRefusal({ contactCrmId: 5, planDate: "2026-09-20", shift: "AM" }, { ...inWeek, listTypes: [] }), "a doctor off the rep's lists is refused");
  assert.ok(nativePlanItemRefusal({ contactCrmId: 5, planDate: "2026-09-20", shift: "AM" }, { ...inWeek, listTypes: ["Pharmacy"] }), "a pharmacy is not a contact");
  const fullDay = Array.from({ length: NATIVE_PLAN_ITEMS_PER_DAY_MAX }, (_, index) => ({ contactCrmId: index + 1, planDate: "2026-09-20", shift: "AM" as const }));
  assert.equal(nativePlanDayLoadRefusal(fullDay), null);
  assert.ok(nativePlanDayLoadRefusal([...fullDay, { contactCrmId: 999, planDate: "2026-09-20", shift: "AM" }]), "one day has a ceiling");

  // ── 5. Stable ids ────────────────────────────────────────────────────────────────────────────
  const stored: NativePlanStoredItem[] = [
    { id: "kept", planDate: "2026-09-20", contactCrmId: 1, shift: "AM", removed: false },
    { id: "moved", planDate: "2026-09-20", contactCrmId: 2, shift: "PM", removed: false },
    { id: "back", planDate: "2026-09-21", contactCrmId: 3, shift: "AM", removed: true },
    { id: "dropped", planDate: "2026-09-21", contactCrmId: 4, shift: "AM", removed: false },
  ];
  const diff = diffNativePlanItems(stored, [
    { planDate: "2026-09-20", contactCrmId: 1, shift: "AM" },
    { planDate: "2026-09-20", contactCrmId: 2, shift: "AM" },
    { planDate: "2026-09-21", contactCrmId: 3, shift: "PM" },
    { planDate: "2026-09-22", contactCrmId: 5, shift: "PM" },
  ]);
  assert.deepEqual(diff.keep.map((row) => row.id), ["kept"], "an unchanged doctor keeps its row");
  assert.deepEqual(diff.reshift.map((change) => [change.row.id, change.shift]), [["moved", "AM"]], "a changed half-day keeps its id");
  assert.deepEqual(
    diff.restore.map((change) => [change.row.id, change.shift]),
    [["back", "PM"]],
    "a doctor dropped earlier and planned again comes back as the SAME row, never a new id",
  );
  assert.deepEqual(diff.insert, [{ planDate: "2026-09-22", contactCrmId: 5, shift: "PM" }], "only a doctor and day never planned is new");
  assert.deepEqual(diff.remove.map((row) => row.id), ["dropped"], "a dropped doctor is marked removed");
  const resave = diffNativePlanItems(
    stored,
    stored.filter((row) => !row.removed).map(({ planDate, contactCrmId, shift }) => ({ planDate, contactCrmId, shift })),
  );
  assert.ok(isNativePlanDiffEmpty(resave), "re-saving the same week changes nothing and issues no id");

  // ── 6. A passed day is fixed, and a kept call stays planned ─────────────────────────────────
  assert.equal(nativePlanLockedDayRefusal(diff, ["2026-09-20", "2026-09-21", "2026-09-22"]), null);
  assert.ok(nativePlanLockedDayRefusal(diff, ["2026-09-21", "2026-09-22"]), "a change on a passed day is refused");
  const futureOnly = diffNativePlanItems(stored, [
    { planDate: "2026-09-20", contactCrmId: 1, shift: "AM" },
    { planDate: "2026-09-20", contactCrmId: 2, shift: "PM" },
    { planDate: "2026-09-21", contactCrmId: 4, shift: "AM" },
    { planDate: "2026-09-22", contactCrmId: 6, shift: "AM" },
  ]);
  assert.equal(nativePlanLockedDayRefusal(futureOnly, ["2026-09-22"]), null, "an untouched passed day does not block a later change");
  assert.ok(nativePlanVisitedRemovalRefusal(diff, new Set(["2026-09-21|4"])), "a doctor already visited that day cannot be dropped");
  assert.equal(nativePlanVisitedRemovalRefusal(diff, new Set()), null);

  // ── 7. The rep's workflow ────────────────────────────────────────────────────────────────────
  assert.equal(nativePlanRepActionRefusal("save", null, 0), null, "a new plan can be saved empty");
  assert.ok(nativePlanRepActionRefusal("submit", null, 0), "an empty plan cannot be sent");
  assert.equal(nativePlanRepActionRefusal("submit", "draft", 3), null);
  assert.equal(nativePlanRepActionRefusal("submit", "returned", 3), null, "a returned plan is fixed and sent again");
  assert.ok(nativePlanRepActionRefusal("save", "submitted", 3), "a submitted plan cannot be edited without reopening");
  assert.ok(nativePlanRepActionRefusal("save", "verified", 3), "a verified plan cannot be edited without reopening");
  assert.equal(nativePlanRepActionRefusal("reopen", "verified", 0), null, "reopening a verified plan sends it back through the manager");
  assert.equal(nativePlanRepActionRefusal("reopen", "submitted", 0), null);
  assert.ok(nativePlanRepActionRefusal("reopen", "draft", 0));
  assert.ok(nativePlanRepActionRefusal("reopen", null, 0));
  assert.equal(parseNativePlanAction("SUBMIT"), "submit");
  assert.equal(parseNativePlanAction("verify"), null, "a rep has no verify action");

  // ── 8. Only the manager the plan was sent to decides ────────────────────────────────────────
  const decision = {
    decision: "verified" as const,
    note: null,
    repInViewerScope: true,
    status: "submitted" as const,
    verifierHrId: "B-30",
    viewerHrId: "b-30",
  };
  assert.equal(nativePlanDecisionRefusal(decision), null, "the named manager verifies a submitted plan of a rep beneath");
  assert.ok(nativePlanDecisionRefusal({ ...decision, viewerHrId: "B-10" }), "nobody decides for that manager — not even the Super Admin");
  assert.ok(nativePlanDecisionRefusal({ ...decision, verifierHrId: null, viewerHrId: null }), "a plan sent to nobody is decided by nobody");
  for (const status of ["draft", "verified", "returned"] as const) {
    assert.ok(nativePlanDecisionRefusal({ ...decision, status }), `a ${status} plan is not waiting for a decision`);
  }
  assert.ok(nativePlanDecisionRefusal({ ...decision, repInViewerScope: false }), "scope runs downward only");
  assert.ok(nativePlanDecisionRefusal({ ...decision, decision: "returned", note: "  " }), "a return says what to change");
  assert.equal(nativePlanDecisionRefusal({ ...decision, decision: "returned", note: "Add Dr Hany on Monday" }), null);
  assert.equal(parseNativePlanDecision("approved"), null, "the decisions are verified and returned only");
  assert.equal(parseNativePlanDecision("Returned"), "returned");

  // ── 9. Plan against visits ───────────────────────────────────────────────────────────────────
  assert.equal(nativePlanItemOutcome({ cairoToday: "2026-09-22", planDate: "2026-09-20", visited: true }), "visited");
  assert.equal(nativePlanItemOutcome({ cairoToday: "2026-09-22", planDate: "2026-09-20", visited: false }), "missed");
  assert.equal(nativePlanItemOutcome({ cairoToday: "2026-09-22", planDate: "2026-09-22", visited: false }), "due_today");
  assert.equal(nativePlanItemOutcome({ cairoToday: "2026-09-22", planDate: "2026-09-23", visited: false }), "upcoming");

  // ── 10. The migration ────────────────────────────────────────────────────────────────────────
  const migration = stripSqlComments(read(MIGRATION));
  for (const table of ["crm_native_plans", "crm_native_plan_items", "crm_native_plan_events"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security;`), `${table} must have RLS on`);
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from anon, authenticated;`), `${table} must grant nothing to browser roles`);
  }
  assert.match(migration, /constraint crm_native_plans_one_per_week unique \(hr_id, week_start\)/, "one plan per rep per week");
  assert.match(
    migration,
    /constraint crm_native_plan_items_one_per_contact_day unique \(hr_id, contact_crm_id, plan_date\)/,
    "one item row per rep, doctor and day — the stable id — must be enforced by the database",
  );
  assert.match(migration, /removed_at timestamptz/, "a dropped doctor is marked removed, not deleted");
  assert.match(migration, /extract\(isodow from week_start\) = 6/, "a plan week starts on Saturday");
  assert.match(migration, /plan_date >= week_start and plan_date <= week_start \+ 5/, "an item falls inside its own plan's week");
  assert.match(migration, /extract\(isodow from plan_date\) <> 4 or shift = 'AM'/, "Thursday is a morning only in the database too");
  assert.match(migration, /contact_crm_id <> 100000/, "the catch-all contact is refused by the database");
  assert.match(migration, /when 'verified' then[^\n]*\n[^\n]*decided_by = verifier_hr_id/, "a verification is recorded only as the verifier");
  assert.match(
    migration,
    /when 'returned' then[^\n]*\n[^\n]*decided_by = verifier_hr_id\s+and decision_note is not null and btrim\(decision_note\) <> ''/,
    "a return is recorded only as the verifier, and always with a note",
  );
  assert.match(
    migration,
    /foreign key \(plan_item_id\)\s+references public\.crm_native_plan_items \(id\)/,
    "a visit links to the plan item it kept by a real foreign key",
  );
  assert.doesNotMatch(migration, /ireports360_/, "the migration must not touch the vendor mirror");
  assert.doesNotMatch(migration, /delete from/i, "the migration deletes nothing");

  // ── 11. Permissions ──────────────────────────────────────────────────────────────────────────
  const grants = (role: keyof typeof permissionMatrix) => [...(permissionMatrix[role].crm_visit_entry ?? [])].sort();
  assert.ok(grants("Medical Rep").includes("create") && !grants("Medical Rep").includes("approve"), "a rep plans and never verifies");
  for (const manager of ["District Manager", "Regional Manager", "National Sales Manager"] as const) {
    assert.ok(grants(manager).includes("approve") && !grants(manager).includes("create"), `${manager} verifies and never plans for a rep`);
  }
  assert.ok(!grants("Super Admin").includes("create") && !grants("Super Admin").includes("approve"),
    "the Super Admin neither plans nor verifies on anyone's behalf");

  // ── 12. The service and the routes ───────────────────────────────────────────────────────────
  const service = read("src/lib/crm/native-visits/plans-service.ts");
  const exported = [...service.matchAll(/export async function (\w+)\(/g)];
  assert.ok(exported.length >= 5, "the plan service's exported functions must be found");
  exported.forEach((match, index) => {
    const body = service.slice(match.index, exported[index + 1]?.index ?? service.length);
    const guard = match[1] === "getNativePlanAvailability" ? /canAccess\(access, "crm_visit_entry"/ : /assertPermission\(access, "crm_visit_entry"/;
    assert.match(body, guard, `${match[1]} must check crm_visit_entry itself, not trust its caller`);
  });
  assert.match(service, /requireActiveSelf\(access, directory\)/, "the rep must be resolved from the session");
  assert.doesNotMatch(service, /status:\s*"(verified|returned)"/, "the service must never write a decision literal — only the manager's own answer");
  assert.match(service, /\.eq\("status", "submitted"\)\s*\.eq\("revision", plan\.revision\)/, "a decision moves only the submitted version the manager saw");
  assert.match(service, /decided_by: plan\.verifierHrId/, "a decision is recorded as the manager the plan was sent to");
  assert.match(service, /update\(\{ removed_at: now, updated_at: now \}\)/, "a dropped doctor is marked removed");
  assert.doesNotMatch(service, /from\(CRM_NATIVE_PLAN_ITEMS_TABLE\)\s*\.delete\(\)/, "a plan item is never deleted, so its id is never reissued");
  assert.doesNotMatch(
    service,
    /CRM_PLAN_ENTRIES_TABLE|iReports360SetPlanStatus|from "@\/lib\/crm\/(plan-verification[^"]*|client|plan-sync|plan-board)"/,
    "the native plan must not read or write the vendor plan, its sync or its write-back",
  );

  const visitService = read("src/lib/crm/native-visits/service.ts");
  assert.match(visitService, /plan_item_id: planItemId/, "a native visit records the plan item it kept");
  assert.match(visitService, /type\.key === "regular" && draft\.contactCrmId != null/, "only a doctor visit keeps a planned call");
  assert.match(visitService, /\.eq\("plan_date", visitDate\)\s*\.is\("removed_at", null\)/, "a visit links only to a live item for that doctor and day");

  // The owner, 2026-09-13: a regular visit is a doctor on the rep's list AND planned on that very day,
  // in a week plan his manager verified. Dormant until the CRM cutover.
  const plannedIn = (planStatus: string) => ({ planStatus });
  assert.equal(nativeVisitPlanRefusal({ ruleActive: false, visitTypeKey: "regular", planItem: null }), null, "before the CRM cutover an unplanned doctor visit still saves");
  assert.equal(nativeVisitPlanRefusal({ ruleActive: true, visitTypeKey: "regular", planItem: null }), NATIVE_VISIT_NOT_PLANNED_MESSAGE, "a doctor not planned on the visit day is refused");
  for (const status of ["draft", "submitted", "returned"]) {
    assert.equal(
      nativeVisitPlanRefusal({ ruleActive: true, visitTypeKey: "regular", planItem: plannedIn(status) }),
      NATIVE_VISIT_PLAN_NOT_VERIFIED_MESSAGE,
      `a ${status} plan is not enough — only a verified one`,
    );
  }
  assert.equal(nativeVisitPlanRefusal({ ruleActive: true, visitTypeKey: "regular", planItem: plannedIn("verified") }), null, "planned that day in a verified plan: saves");
  assert.equal(nativeVisitPlanRefusal({ ruleActive: true, visitTypeKey: "campaign", planItem: null }), null, "campaign (unplanned) waits for its own rule");
  assert.match(
    visitService,
    /nativeVisitPlanRefusal\(\{\s*ruleActive: cutover != null && isOnOrAfterCrmCutover\(cutover, draft\.visitDate\)/,
    "the plan rule is switched by the cutover, for the visit day",
  );
  assert.match(visitService, /from\(CRM_NATIVE_PLANS_TABLE\)\s*\.select\("status"\)/, "the plan's own status is read, not assumed");
  const planCheckAt = visitService.indexOf("nativeVisitPlanRefusal(");
  const visitInsertAt = visitService.search(/\.insert\(\{\s*client_submission_id/);
  assert.ok(planCheckAt > 0 && visitInsertAt > 0 && planCheckAt < visitInsertAt, "the plan rule runs before the visit is inserted");
  assert.match(visitService, /if \(planRefusal\) throw forbiddenError\(/);

  for (const route of ["app/api/crm/native-visits/plans/route.ts", "app/api/crm/native-visits/plan-reviews/route.ts"]) {
    assert.doesNotMatch(read(route), /body\.(hrId|hr_id|repHrId|agentHrId|verifierHrId)|searchParams/, `${route} must not take a person from the request`);
  }

  // ── 13. Isolation: nothing else reads the plan tables before cutover ────────────────────────
  const offenders = [...sourceFiles("app"), ...sourceFiles("src")]
    .filter((file) => !file.startsWith("src/lib/crm/native-visits/"))
    .filter((file) => /crm_native_plan|CRM_NATIVE_PLAN/.test(read(file)));
  assert.deepEqual(
    offenders,
    [],
    "only src/lib/crm/native-visits/ may name the native plan tables until cutover — the pilot line still plans in iReports360",
  );

  // ── 14. Reachability: the pages are linked from My Visits ───────────────────────────────────
  const myVisits = read("app/employee-portals/visits/page.tsx");
  assert.match(myVisits, /href="\/employee-portals\/visits\/plan"/);
  assert.match(myVisits, /href="\/employee-portals\/visits\/plan-reviews"/);
}
