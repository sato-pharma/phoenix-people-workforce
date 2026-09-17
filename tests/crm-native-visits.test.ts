import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import {
  NATIVE_VISIT_MANAGER_SINGLE_PARTNERS_MESSAGE,
  NATIVE_VISIT_NOT_PLANNED_MESSAGE,
  NATIVE_VISIT_PARTNERS_MAX,
  NATIVE_VISIT_TYPES,
  nativeVisitManagerSinglePartnerRefusal,
  nativeVisitPlannedContactIds,
  nativeVisitPlanRefusal,
  classifyNativeVisitGps,
  isNativeEntryDay,
  isNativeEntryOffered,
  isNativeVisitPilotDay,
  isNativeVisitRepTitle,
  isWithinNativeVisitEntryWindow,
  nativePartnerDecisionRefusal,
  nativeVisitDeleteRefusal,
  nativeVisitOnBehalfDays,
  nativeVisitPartnerRefusal,
  nativeVisitPilotForLine,
  nativeVisitShiftRefusal,
  parseNativeVisitDraft,
} from "../src/lib/crm/native-visits/rules.ts";
import {
  CRM_LEAVE_VISIT_TYPE_CODES,
  crmVisitTypeMeaningStrict,
} from "../src/lib/crm/visit-type-meaning.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Native visits — the PILOT (CRM phase 3).
//
// WHAT THIS FILE GUARDS:
//   · ONE TYPE TABLE. rules.ts and the migration's check constraint map each type to the same vendor
//     code, and visit-type-meaning.ts gives every code a pay meaning: -4 stays the only leave.
//   · THE ENTRY WINDOW is the same Cairo day or the next one.
//   · A MISSING OR FOREIGN GPS FIX IS A FLAG, never a refusal (owner decision 7).
//   · AM/PM IS THE CONTACT'S LIST (owner decision 2), and a doctor off the rep's list is refused.
//   · THE PILOT IS A ROW: its line and its dates, both ends inclusive.
//   · ONLY THE NAMED PARTNER DECIDES, only once, only for a rep beneath him; nothing auto-confirms.
//   · THE REP IS THE SESSION — no route or rule reads a rep id from the request body. The one exception
//     is the Super Admin's entry FOR a rep (update): an active medical rep in his scope, no location,
//     marked as his, the rep told in-app only.
//   · NOTHING ELSE READS THE NATIVE TABLES before cutover, or a visit double-counts against the
//     iReports360 feed the pilot line keeps entering.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATION = "supabase/migrations/20260913170000_crm_native_visits_pilot.sql";

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

function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    clientSubmissionId: "3f1c2a6e-9b4d-4c8e-8a1f-2b3c4d5e6f70",
    comment: "",
    contactCrmId: 5123,
    deviceRecordedAt: "2026-09-20T07:55:00.000Z",
    latitude: 30.0444,
    longitude: 31.2357,
    partnerHrIds: [],
    shift: "AM",
    visitDate: "2026-09-20",
    visitType: "regular",
    ...overrides,
  };
}

const CONTEXT = { cairoToday: "2026-09-20", now: new Date("2026-09-20T08:00:00.000Z") };

export function runCrmNativeVisitsTests() {
  // ── 1. One type table, in step with the migration and with pay meaning ──────────────────────
  const keys = NATIVE_VISIT_TYPES.map((type) => type.key);
  const codes = NATIVE_VISIT_TYPES.map((type) => type.legacyCode);
  assert.equal(new Set(keys).size, keys.length, "type keys must be unique");
  assert.equal(new Set(codes).size, codes.length, "each type must map to its own vendor code");

  const migration = stripSqlComments(read(MIGRATION));
  const legacyBlock = migration.slice(
    migration.indexOf("crm_native_visits_legacy_code"),
    migration.indexOf("crm_native_visits_contact_rule"),
  );
  const migrationPairs = new Map(
    [...legacyBlock.matchAll(/when '([a-z_]+)' then (-?\d+)/g)].map((match) => [match[1], Number(match[2])]),
  );
  assert.deepEqual(
    migrationPairs,
    new Map(NATIVE_VISIT_TYPES.map((type) => [type.key, type.legacyCode])),
    "the migration's legacy-code check must map exactly the types rules.ts maps, to the same codes",
  );
  const typeCheck = migration.match(/crm_native_visits_type check \(\s*visit_type in \(([^)]*)\)/);
  assert.ok(typeCheck, "the migration must constrain visit_type to a list");
  assert.deepEqual(
    [...typeCheck[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort(),
    [...keys].sort(),
    "the migration's visit_type list must be exactly the catalogue",
  );

  for (const type of NATIVE_VISIT_TYPES) {
    if (type.key === "regular") {
      assert.equal(type.legacyCode, 0, "a doctor visit is the vendor's regular code 0");
      continue;
    }
    const meaning = crmVisitTypeMeaningStrict(type.legacyCode);
    assert.ok(meaning, `${type.label} (${type.legacyCode}) must carry a pay meaning in visit-type-meaning.ts`);
    assert.equal(
      meaning,
      type.key === "annual_vacation" ? "AV" : "CP",
      `${type.label} must be ${type.key === "annual_vacation" ? "leave" : "a working day"}`,
    );
  }
  assert.deepEqual(
    codes.filter((code) => CRM_LEAVE_VISIT_TYPE_CODES.has(code)),
    [-4],
    "annual vacation (-4) must be the ONLY leave a native entry can create — public holiday and casual leave are working days",
  );
  for (const retired of [-7, -19, -30]) {
    assert.ok(!codes.includes(retired), `vendor code ${retired} has no stated meaning and must not be creatable natively`);
  }

  // ── 2. Entry window ──────────────────────────────────────────────────────────────────────────
  assert.equal(isWithinNativeVisitEntryWindow("2026-09-20", "2026-09-20"), true, "today is open");
  assert.equal(isWithinNativeVisitEntryWindow("2026-09-19", "2026-09-20"), true, "yesterday is open");
  assert.equal(isWithinNativeVisitEntryWindow("2026-09-18", "2026-09-20"), false, "two days back is closed");
  assert.equal(isWithinNativeVisitEntryWindow("2026-09-21", "2026-09-20"), false, "tomorrow is closed");
  assert.equal(isWithinNativeVisitEntryWindow("2026-10-01", "2026-10-01"), true);
  assert.equal(isWithinNativeVisitEntryWindow("2026-09-30", "2026-10-01"), true, "yesterday across a month end is open");

  // ── 3. GPS is a flag ─────────────────────────────────────────────────────────────────────────
  assert.equal(classifyNativeVisitGps(30.0444, 31.2357), "captured", "a Cairo fix is captured");
  assert.equal(classifyNativeVisitGps(null, null), "missing");
  assert.equal(classifyNativeVisitGps(51.5072, -0.1276), "out_of_bounds", "a fix outside Egypt is flagged, not dropped");

  const noFix = parseNativeVisitDraft(draftBody({ latitude: null, longitude: null }), CONTEXT);
  assert.ok(noFix.ok, "a visit with no GPS fix must still save");
  assert.equal(noFix.ok && noFix.value.gpsStatus, "missing");
  const abroad = parseNativeVisitDraft(draftBody({ latitude: 51.5072, longitude: -0.1276 }), CONTEXT);
  assert.ok(abroad.ok && abroad.value.gpsStatus === "out_of_bounds" && abroad.value.latitude === 51.5072,
    "an out-of-bounds fix saves with its coordinates kept");
  const halfFix = parseNativeVisitDraft(draftBody({ latitude: 30.1, longitude: null }), CONTEXT);
  assert.ok(halfFix.ok && halfFix.value.latitude === null && halfFix.value.gpsStatus === "missing",
    "half a coordinate is no coordinate");

  // ── 4. Draft shape ───────────────────────────────────────────────────────────────────────────
  assert.ok(parseNativeVisitDraft(draftBody(), CONTEXT).ok, "a plain doctor visit parses");
  assert.equal(parseNativeVisitDraft(draftBody({ clientSubmissionId: "abc" }), CONTEXT).ok, false, "a submission id must be a UUID");
  assert.equal(parseNativeVisitDraft(draftBody({ visitDate: "2026-09-18" }), CONTEXT).ok, false, "outside the window is refused");
  assert.equal(parseNativeVisitDraft(draftBody({ shift: "noon" }), CONTEXT).ok, false, "shift is AM or PM");
  assert.equal(parseNativeVisitDraft(draftBody({ contactCrmId: null }), CONTEXT).ok, false, "a doctor visit needs a doctor");
  assert.equal(parseNativeVisitDraft(draftBody({ contactCrmId: 100000 }), CONTEXT).ok, false, "contact 100000 is the catch-all");
  assert.equal(
    parseNativeVisitDraft(draftBody({ visitType: "campaign", prospectName: "Dr Hany" }), CONTEXT).ok,
    false,
    "a campaign visit names a doctor OR a prospect, never both",
  );
  const prospect = parseNativeVisitDraft(draftBody({ visitType: "campaign", contactCrmId: null, prospectName: "Dr Hany" }), CONTEXT);
  assert.ok(prospect.ok && prospect.value.contactCrmId === null && prospect.value.prospectName === "Dr Hany");
  assert.equal(parseNativeVisitDraft(draftBody({ visitType: "conference" }), CONTEXT).ok, false, "a conference takes no doctor");
  assert.ok(parseNativeVisitDraft(draftBody({ visitType: "annual_vacation", contactCrmId: null }), CONTEXT).ok);
  assert.equal(
    parseNativeVisitDraft(draftBody({ deviceRecordedAt: "2026-09-20T08:16:00.000Z" }), CONTEXT).ok,
    false,
    "a phone clock 16 minutes ahead is refused",
  );
  assert.ok(parseNativeVisitDraft(draftBody({ deviceRecordedAt: "2026-09-20T08:14:00.000Z" }), CONTEXT).ok);
  const partners = parseNativeVisitDraft(draftBody({ partnerHrIds: ["B-25", "b-25", "B-30"] }), CONTEXT);
  assert.ok(partners.ok && partners.value.partnerHrIds.length === 2, "the same partner named twice counts once");
  assert.equal(
    parseNativeVisitDraft(draftBody({ partnerHrIds: ["B-1", "B-2", "B-3", "B-4"].slice(0, NATIVE_VISIT_PARTNERS_MAX + 1) }), CONTEXT).ok,
    false,
    `more than ${NATIVE_VISIT_PARTNERS_MAX} partners is refused`,
  );
  const withRepId = parseNativeVisitDraft(draftBody({ hrId: "B-999", repHrId: "B-999" }), CONTEXT);
  assert.ok(withRepId.ok && !("hrId" in withRepId.value) && !("repHrId" in withRepId.value),
    "a rep id in the body is ignored — the rep is the session");

  // ── 5. AM/PM from the list ───────────────────────────────────────────────────────────────────
  assert.equal(nativeVisitShiftRefusal({ contactCrmId: 5, shift: "AM" }, ["AM"]), null);
  assert.ok(nativeVisitShiftRefusal({ contactCrmId: 5, shift: "PM" }, ["AM"]), "an AM-list doctor is an AM visit");
  assert.ok(nativeVisitShiftRefusal({ contactCrmId: 5, shift: "AM" }, []), "a doctor off the rep's lists is refused");
  assert.ok(nativeVisitShiftRefusal({ contactCrmId: 5, shift: "AM" }, ["Pharmacy"]), "a pharmacy list is not a contact list");
  assert.equal(nativeVisitShiftRefusal({ contactCrmId: 5, shift: "PM" }, ["AM", "PM"]), null, "on both lists the rep chooses");
  assert.equal(nativeVisitShiftRefusal({ contactCrmId: null, shift: "PM" }, []), null, "no contact, no list rule");

  // ── 6. The pilot row ─────────────────────────────────────────────────────────────────────────
  const pilots = [{ endsOn: "2026-09-24", isActive: true, lineName: "Pedia", startsOn: "2026-09-19" }];
  const pedia = nativeVisitPilotForLine(" pedia ", pilots);
  assert.ok(pedia, "the line name matches whatever its spacing or case");
  assert.equal(nativeVisitPilotForLine("CNS", pilots), null, "another line is not piloting");
  assert.equal(nativeVisitPilotForLine("Pedia", [{ ...pilots[0], isActive: false }]), null, "an ended pilot is off");
  assert.equal(isNativeVisitPilotDay(pedia, "2026-09-18"), false);
  assert.equal(isNativeVisitPilotDay(pedia, "2026-09-19"), true, "the first day is inside");
  assert.equal(isNativeVisitPilotDay(pedia, "2026-09-24"), true, "the last day is inside");
  assert.equal(isNativeVisitPilotDay(pedia, "2026-09-25"), false);
  assert.equal(isNativeVisitPilotDay(null, "2026-09-20"), false);

  // From the CRM cutover date every rep of every line enters here (the owner, 2026-09-13: all lines at once).
  const pilotGate = { cutoverDate: null, pilot: pedia };
  assert.equal(isNativeEntryDay(pilotGate, "2026-09-20"), true, "before any cutover a pilot day is open");
  assert.equal(isNativeEntryDay(pilotGate, "2026-10-05"), false, "and a day after the pilot is not");
  assert.equal(isNativeEntryDay({ cutoverDate: null, pilot: null }, "2026-10-05"), false, "another line enters nothing before a cutover");
  const cutoverGate = { cutoverDate: "2026-10-03", pilot: null };
  assert.equal(isNativeEntryDay(cutoverGate, "2026-10-02"), false, "the day before the cutover stays in iReports360");
  assert.equal(isNativeEntryDay(cutoverGate, "2026-10-03"), true, "the cutover day is open to a line that never piloted");
  assert.equal(isNativeEntryDay(cutoverGate, "2027-01-15"), true, "and so is every day after it");
  assert.equal(isNativeEntryDay(cutoverGate, "2026-10-3"), false, "a malformed day is never open");
  assert.equal(isNativeEntryDay({ cutoverDate: "2026-10-03", pilot: pedia }, "2026-09-21"), true, "a pilot day before a later cutover stays open");
  assert.equal(isNativeEntryOffered(cutoverGate, "2026-09-26"), true, "once a date is set the form is offered, and says when it opens");
  assert.equal(isNativeEntryOffered(pilotGate, "2026-09-13"), true, "a pilot line is offered the form ahead of its pilot");
  assert.equal(isNativeEntryOffered(pilotGate, "2026-09-25"), false, "and not once the pilot is over");
  assert.equal(isNativeEntryOffered({ cutoverDate: null, pilot: null }, "2026-09-13"), false, "another line is offered nothing before a cutover");

  // ── 7. Partners and deletion ─────────────────────────────────────────────────────────────────
  assert.ok(nativeVisitPartnerRefusal("B-25", ["b-25"]), "a rep cannot name himself");
  assert.equal(nativeVisitPartnerRefusal("B-25", ["B-30"]), null);

  const deletion = { cairoToday: "2026-09-20", deletedAt: null, ownerHrId: "B-25", reason: "wrong doctor", viewerHrId: "b-25", visitDate: "2026-09-19" };
  assert.equal(nativeVisitDeleteRefusal(deletion), null, "the rep deletes his own visit inside the window, with a reason");
  assert.ok(nativeVisitDeleteRefusal({ ...deletion, viewerHrId: "B-30" }), "nobody else deletes it");
  assert.ok(nativeVisitDeleteRefusal({ ...deletion, reason: "  " }), "a deletion needs a reason");
  assert.ok(nativeVisitDeleteRefusal({ ...deletion, visitDate: "2026-09-18" }), "an old visit cannot be deleted");
  assert.ok(nativeVisitDeleteRefusal({ ...deletion, deletedAt: "2026-09-20T09:00:00Z" }), "a deleted visit stays deleted");

  const decision = { partnerHrId: "B-30", repInViewerScope: true, status: "pending" as const, viewerHrId: "b-30", visitDeleted: false };
  assert.equal(nativePartnerDecisionRefusal(decision), null, "the named partner answers a live visit of his own rep");
  assert.ok(nativePartnerDecisionRefusal({ ...decision, viewerHrId: "B-10" }), "nobody answers for the named partner — not even the Super Admin");
  assert.ok(nativePartnerDecisionRefusal({ ...decision, status: "confirmed" }), "an answer is given once");
  assert.ok(nativePartnerDecisionRefusal({ ...decision, visitDeleted: true }), "a deleted visit is not answered");
  assert.ok(nativePartnerDecisionRefusal({ ...decision, repInViewerScope: false }), "scope runs downward only");

  // ── 8. The migration ─────────────────────────────────────────────────────────────────────────
  for (const table of ["crm_native_visit_pilots", "crm_native_visits", "crm_native_visit_partners", "crm_native_visit_events"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security;`), `${table} must have RLS on`);
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from anon, authenticated;`), `${table} must grant nothing to browser roles`);
  }
  assert.match(migration, /crm_native_visits_one_per_contact_day_uidx\s+on public\.crm_native_visits \(hr_id, contact_crm_id, visit_date\)\s+where deleted_at is null/,
    "one visit per rep, contact and day must be enforced by the database");
  assert.match(migration, /constraint crm_native_visits_client_submission_uidx unique \(client_submission_id\)/,
    "a resent offline visit must save once");
  assert.match(migration, /contact_crm_id is null or contact_crm_id <> 100000/, "the catch-all contact is refused by the database too");
  assert.match(migration, /decided_by = partner_hr_id/, "only the partner can be recorded as deciding");
  assert.match(migration, /'Pedia',\s*date '2026-09-19',\s*date '2026-09-24'/, "the pilot is seeded as Pedia, 19 to 24 September");
  assert.doesNotMatch(migration, /ireports360_/, "the migration must not touch the vendor mirror");

  // ── 9. Permissions ───────────────────────────────────────────────────────────────────────────
  const grants = (role: keyof typeof permissionMatrix) => [...(permissionMatrix[role].crm_visit_entry ?? [])].sort();
  assert.deepEqual(grants("Medical Rep"), ["create", "delete", "read"], "a rep enters, reads and deletes his own visits");
  for (const manager of ["District Manager", "Regional Manager", "National Sales Manager"] as const) {
    assert.ok(grants(manager).includes("approve"), `${manager} confirms visits naming him`);
  }
  // The owner, 2026-09-14: a district manager, in rare cases, submits a single visit without the rep.
  assert.deepEqual(grants("District Manager"), ["approve", "create", "delete", "read"], "a district manager enters his rare single visits");
  for (const manager of ["Regional Manager", "National Sales Manager"] as const) {
    assert.ok(!grants(manager).includes("create"), `${manager} does not enter visits`);
  }

  // ── 9b. A district manager's single visit, and the planned doctors the form offers ───────────
  assert.equal(
    nativeVisitPlanRefusal({ ruleActive: true, visitTypeKey: "regular", planItem: null, managerSingleVisit: true }),
    null,
    "a district manager's single visit files no plan, so the plan rule does not reach it",
  );
  assert.equal(
    nativeVisitPlanRefusal({ ruleActive: true, visitTypeKey: "regular", planItem: null, managerSingleVisit: false }),
    NATIVE_VISIT_NOT_PLANNED_MESSAGE,
    "a rep's unplanned doctor visit is still refused",
  );
  assert.equal(nativeVisitManagerSinglePartnerRefusal(true, ["B-77"]), NATIVE_VISIT_MANAGER_SINGLE_PARTNERS_MESSAGE, "a single visit names nobody");
  assert.equal(nativeVisitManagerSinglePartnerRefusal(true, []), null);
  assert.equal(nativeVisitManagerSinglePartnerRefusal(false, ["B-77"]), null, "a rep names his managers as before");
  assert.deepEqual(
    nativeVisitPlannedContactIds(
      [
        { contactCrmId: 30, planDate: "2026-10-01", planStatus: "verified" },
        { contactCrmId: 10, planDate: "2026-10-01", planStatus: "verified" },
        { contactCrmId: 20, planDate: "2026-10-01", planStatus: "submitted" },
        { contactCrmId: 40, planDate: "2026-09-30", planStatus: "verified" },
      ],
      "2026-10-01",
    ),
    [10, 30],
    "the form offers only that day's doctors from a verified plan — the same test the save applies",
  );
  const shared = read("src/lib/crm/native-visits/server-shared.ts");
  assert.match(shared, /canonicalHrIdKey\(row\.managerHrId\) === managerKey/, "a manager's doctors are his own reps' lists");
  const planService = read("src/lib/crm/native-visits/plans-service.ts");
  assert.equal((planService.match(/await refuseManagerPlanner\(access\);/g) ?? []).length, 2, "a district manager opens and saves no weekly plan");
  assert.match(planService, /if \(mayCreate && !mayApprove\) \{/, "My Visits offers a district manager no weekly plan");
  // Phoenix CRM (the owner, 2026-09-14): a viewer holding approve takes the manager's seat, and only the
  // rep's seat is shown the weekly planner.
  const phoenixCrmService = read("src/lib/crm/native-visits/phoenix-crm.ts");
  assert.ok(
    phoenixCrmService.indexOf("if (mayApprove) {") > 0 &&
      phoenixCrmService.indexOf("if (mayApprove) {") < phoenixCrmService.indexOf('{ seat: "rep", waiting: 0 }'),
    "a district manager is seated as a manager before they could be seated as a rep",
  );
  assert.match(read("src/components/employee-portal/phoenix-crm-space.tsx"), /if \(seat === "rep"\) return <NativePlanWorkspace \/>;/, "the weekly planner opens only in the rep's seat");
  assert.ok(!grants("Super Admin").includes("create") && !grants("Super Admin").includes("approve"),
    "the Super Admin is nobody's rep and confirms no visit — his entry for a rep is update, below");
  assert.deepEqual(grants("Employee"), [], "an ordinary employee has no visit entry");

  // ── 9c. The Super Admin enters a visit FOR a rep (the owner, 2026-09-14) ──────────────────────
  assert.deepEqual(grants("Super Admin"), ["read", "update"], "the Super Admin reads every rep's visits and enters one for a rep");
  const onBehalfContext = { cairoToday: "2026-09-20", enteredOnBehalf: true, now: new Date("2026-09-20T08:00:00.000Z") };
  const onBehalfBody = (visitDate: string) =>
    draftBody({ accuracyMeters: 12, deviceRecordedAt: "2026-09-20T08:00:00.000Z", gpsAddress: "Cairo", latitude: 30.05, longitude: 31.24, visitDate });
  const lastWeek = parseNativeVisitDraft(onBehalfBody("2026-09-13"), onBehalfContext);
  assert.ok(lastWeek.ok, "his entry takes a day before yesterday — whether that day is open is the gate's question");
  assert.ok(
    lastWeek.ok && lastWeek.value.gpsStatus === "missing" && lastWeek.value.latitude === null && lastWeek.value.gpsAddress === null,
    "his entry never carries a location, whatever the body sends, so it never reads as a check-in",
  );
  assert.equal(parseNativeVisitDraft(onBehalfBody("2026-09-21"), onBehalfContext).ok, false, "never a day still to come");
  assert.equal(
    parseNativeVisitDraft(onBehalfBody("2026-09-13"), { ...onBehalfContext, enteredOnBehalf: false }).ok,
    false,
    "a rep's own form keeps today or yesterday",
  );
  assert.equal(
    nativeVisitPlanRefusal({ ruleActive: true, visitTypeKey: "regular", planItem: null, enteredOnBehalf: true }),
    null,
    "his entry takes any doctor on the rep's list, planned or not",
  );
  assert.deepEqual(
    nativeVisitOnBehalfDays(pilotGate, "2026-09-22"),
    ["2026-09-22", "2026-09-21", "2026-09-20", "2026-09-19"],
    "any open pilot day up to today, newest first",
  );
  assert.deepEqual(nativeVisitOnBehalfDays(pilotGate, "2026-09-13"), [], "before the pilot there is no open day to enter");
  assert.ok(isNativeVisitRepTitle("Medical Representative") && !isNativeVisitRepTitle("District Sales Manager"), "only a rep has visits entered for him");
  assert.equal(nativeVisitShiftRefusal({ contactCrmId: 5, shift: "AM" }, [], "the rep's"), "That doctor is not on the rep's AM or PM list.");

  const onBehalfService = read("src/lib/crm/native-visits/service.ts");
  const requireRep = onBehalfService.slice(
    onBehalfService.indexOf("async function requireRepForOnBehalfEntry"),
    onBehalfService.indexOf("async function loadOnBehalfActors"),
  );
  assert.match(requireRep, /isNativeVisitRepTitle\(row\.jobTitle\)/, "the rep named must be an active medical rep");
  assert.match(requireRep, /if \(!isAgentInScope\(scope, row\.hrId\)\) throw forbiddenError\(/, "and inside the caller's scope");
  assert.match(
    onBehalfService,
    /await assertPermission\(access, "crm_visit_entry", onBehalf \? "update" : "create"\);\s*const enteredOnBehalf = onBehalf != null;/,
    "entering for a rep needs update; a rep's own entry needs create",
  );
  assert.match(onBehalfService, /\.\.\.\(enteredOnBehalf \? \{ enteredOnBehalf: true \} : \{\}\)/, "the created event marks the entry as his");
  assert.match(onBehalfService, /enteredOnBehalf \? loadAppRole\(rep\.hrId\) : Promise\.resolve\(access\.role\)/, "the row carries the rep's role, never the Super Admin's");
  const notify = onBehalfService.slice(
    onBehalfService.indexOf("async function notifyRepOfOnBehalfVisit"),
    onBehalfService.indexOf("// ── Form options"),
  );
  assert.match(notify, /channels: \["in_app"\]/, "the rep is told in-app");
  assert.doesNotMatch(notify, /"email"|email:/, "and never by email");
  const onBehalfRoute = read("app/api/crm/native-visits/on-behalf/route.ts");
  assert.equal((onBehalfRoute.match(/await assertPermission\(access, "crm_visit_entry", "update"\);/g) ?? []).length, 2, "both on-behalf methods check update");
  assert.ok(
    onBehalfRoute.indexOf("assertSameOriginMutation(request)") > 0 &&
      onBehalfRoute.indexOf("assertSameOriginMutation(request)") < onBehalfRoute.indexOf("createNativeVisit("),
    "the save checks the origin before it saves",
  );
  assert.match(read("app/api/crm/native-visits/all/route.ts"), /await assertPermission\(access, "crm_visit_entry", "update"\);/);
  // Entry for a rep now lives in Phoenix CRM's Visits tab, in the Super Admin's seat only.
  assert.match(phoenixCrmService, /if \(mayUpdate\) return \{ seat: "admin", waiting: 0 \};/, "only update seats the Super Admin");
  assert.match(read("src/components/employee-portal/phoenix-crm-space.tsx"), /if \(seat === "admin"\) return <NativeVisitForRepWorkspace \/>;/);
  for (const page of ["app/(admin)/admin/phoenix-crm/page.tsx", "app/employee-portals/phoenix-crm/page.tsx"]) {
    assert.match(read(page), /const \{ seat \} = await getPhoenixCrmAccess\(access\);\s*if \(!seat\) \{?\s*redirect\(/, `${page} turns away anyone with no seat`);
  }
  assert.match(read("src/components/employee-portal/phoenix-crm-space.tsx"), /\?\? "visits";/, "Visits stays the pilot space's default tab");
  // The old Visits for Reps addresses and the rail link moved to the clean Phoenix CRM when it shipped
  // (the owner, 2026-09-16: the pilot's link is hidden then, and the pilot removed after go-live).
  assert.match(read("app/(admin)/admin/visit-entry/page.tsx"), /redirect\("\/admin\/field-crm"\)/, "Visits for Reps lands on the new Phoenix CRM");
  assert.match(read("app/employee-portals/visits/for-reps/page.tsx"), /redirect\("\/employee-portals\/field-crm\?tab=visits"\)/);
  assert.doesNotMatch(read("src/config/system-navigation.ts"), /href: "\/admin\/phoenix-crm"/, "the pilot has no rail link");
  assert.match(read("src/config/system-navigation.ts"), /href: "\/admin\/field-crm"/, "the Phoenix CRM rail link opens the new module");

  // ── 10. The service and the routes ───────────────────────────────────────────────────────────
  const service = read("src/lib/crm/native-visits/service.ts");
  const exported = [...service.matchAll(/export async function (\w+)\(/g)];
  assert.ok(exported.length >= 7, "the service's exported functions must be found");
  exported.forEach((match, index) => {
    const body = service.slice(match.index, exported[index + 1]?.index ?? service.length);
    const guard = match[1] === "getNativeVisitEntryAvailability" ? /canAccess\(access, "crm_visit_entry"/ : /assertPermission\(access, "crm_visit_entry"/;
    assert.match(body, guard, `${match[1]} must check crm_visit_entry itself, not trust its caller`);
  });
  assert.match(service, /requireActiveSelf\(access, directory\)/, "the rep must be resolved from the session");
  assert.doesNotMatch(service, /status:\s*"(confirmed|rejected)"/, "the service must never write a decision literal — only the partner's own answer");
  assert.match(service, /status: "pending",/, "every partner row starts pending");
  assert.match(service, /\.eq\("status", "pending"\)/, "a decision may only move a pending row");

  const routes = [
    "app/api/crm/native-visits/route.ts",
    "app/api/crm/native-visits/delete/route.ts",
    "app/api/crm/native-visits/form-options/route.ts",
    "app/api/crm/native-visits/confirmations/route.ts",
  ];
  for (const route of [...routes, "src/lib/crm/native-visits/rules.ts"]) {
    assert.doesNotMatch(read(route), /body\.(hrId|hr_id|repHrId|agentHrId)|searchParams/, `${route} must not take a person from the request`);
  }

  // ── 11. Isolation: nothing else reads the native tables before cutover ────────────────────────
  const offenders = [...sourceFiles("app"), ...sourceFiles("src")]
    .filter((file) => !file.startsWith("src/lib/crm/native-visits/"))
    .filter((file) => /crm_native_visit|CRM_NATIVE_VISIT/.test(read(file)));
  assert.deepEqual(
    offenders,
    [],
    "only src/lib/crm/native-visits/ may name the native visit tables until cutover — a native row read by a report double-counts the iReports360 feed",
  );

  // ── 12. Reachability: My Visits opens the new Phoenix CRM, and the old pages land in it ───────
  // The owner hid the pilot's link when the clean module shipped (2026-09-16).
  const myVisits = read("app/employee-portals/visits/page.tsx");
  assert.match(myVisits, /phoenixCrm \? \(\s*<Link[^>]*href="\/employee-portals\/field-crm"/);
  assert.doesNotMatch(myVisits, /href="\/employee-portals\/phoenix-crm"/, "My Visits no longer links the pilot");
  for (const page of ["log", "confirmations"]) {
    assert.match(read(`app/employee-portals/visits/${page}/page.tsx`), /redirect\("\/employee-portals\/field-crm\?tab=visits"\)/);
  }
}
