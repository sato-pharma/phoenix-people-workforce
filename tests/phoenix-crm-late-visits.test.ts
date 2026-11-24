import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  cairoPressTime,
  LATE_VISIT_BODY_MAX_CHARS,
  LATE_VISIT_DEFAULT_REASON,
  managerApprovalBody,
  parseLateVisitFiling,
  pickedOnTerritoryVisit,
  territoryApprovalBody,
  VISIT_FILED_LINE,
  VISIT_FILED_PILL,
} from "../src/lib/phoenix-crm/late-visit-rules.ts";

/**
 * A held visit that missed its window is filed whole and decided by the Super Admin alone (owner, 24 Nov 2026: "never
 * any visit to be lost from either a rep or from the manager", then "SUPER ADMIN APPROVE IT ONLY SUPER ADMIN").
 */
export function runPhoenixCrmLateVisitsTests(): void {
  checkTheFiling();
  checkThePressTime();
  checkWhoWasOnIt();
  checkTheTerritoryApproval();
  checkTheManagerApproval();
  checkTheWords();
  checkTheDoors();
}

const VISIT = "0b6f1b5e-1a2b-4c3d-8e9f-001122334455";
const CUSTOMER = "1c7a2b6f-2b3c-4d4e-9fa0-112233445566";

function filing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VISIT,
    kind: "territory",
    seatId: "SEAT-1",
    customerId: CUSTOMER,
    customerName: "عيادة النور",
    pressedDay: "2026-11-16",
    pressedAtDevice: "2026-11-16T11:40:00.000Z",
    body: { id: VISIT, comment: "Saw the doctor", products: ["Alpha"] },
    ...overrides,
  };
}

function checkTheFiling(): void {
  const parsed = parseLateVisitFiling(filing());
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.equal(parsed.value.id, VISIT);
    assert.deepEqual(parsed.value.body.products, ["Alpha"], "the whole body is kept");
  }
  // 🔴 The id must be the body's own, so a filing can never carry a visit under an id it does not hold.
  assert.equal(parseLateVisitFiling(filing({ body: { id: CUSTOMER, comment: "x" } })).ok, false, "🔴 an id that is not the body's own is refused");
  const manager = parseLateVisitFiling(filing({ kind: "manager_single", body: { clientRef: VISIT, customerId: CUSTOMER } }));
  assert.ok(manager.ok, "a manager's single visit is held under its client ref");
  assert.equal(parseLateVisitFiling(filing({ kind: "manager_single" })).ok, false, "a manager's visit without its client ref is refused");
  assert.equal(parseLateVisitFiling(filing({ kind: "something" })).ok, false, "an unknown kind is refused");
  assert.equal(parseLateVisitFiling(filing({ pressedDay: "16/11/2026" })).ok, false);
  assert.equal(parseLateVisitFiling(filing({ seatId: "" })).ok, false);
  const huge = parseLateVisitFiling(filing({ body: { id: VISIT, comment: "x".repeat(LATE_VISIT_BODY_MAX_CHARS) } }));
  assert.equal(huge.ok, false, "a body nobody's phone could make is refused");
  const noClock = parseLateVisitFiling(filing({ pressedAtDevice: "not a time" }));
  assert.ok(noClock.ok && noClock.value.pressedAtDevice === null, "a phone with no usable clock still files its visit");
  // The person is never read from the filing.
  const parsedKeys = parsed.ok ? Object.keys(parsed.value) : [];
  assert.ok(!parsedKeys.some((key) => /hr_?id|person|sender/i.test(key)), "🔴 the filing names no person: the session does");
}

function checkThePressTime(): void {
  // 13:40 Cairo on 16 Nov is 11:40 UTC (Cairo is UTC+2 in November).
  assert.equal(cairoPressTime("2026-11-16T11:40:00.000Z", "2026-11-16"), "13:40");
  // 01:30 Cairo on 17 Nov still belongs to the 16th's visit day (it closes at 02:00).
  assert.equal(cairoPressTime("2026-11-16T23:30:00.000Z", "2026-11-16"), "01:30");
  // 🔴 A clock that puts the press on another visit day is not believed: no time is better than a made-up one.
  assert.equal(cairoPressTime("2026-11-18T11:40:00.000Z", "2026-11-16"), null);
  assert.equal(cairoPressTime(null, "2026-11-16"), null);
}

function checkWhoWasOnIt(): void {
  // A rep's own double visit: her district manager was on it.
  assert.deepEqual(pickedOnTerritoryVisit({ managerHrId: "dm-1", companions: [{ hrId: "DM-1" }] }, "REP-1", "rep-1"), ["DM-1"]);
  // 🔴 A manager who logged a visit on his rep's territory was there himself.
  assert.deepEqual(pickedOnTerritoryVisit({ managerHrId: "DM-1", companions: [] }, "DM-1", "REP-1"), ["DM-1"]);
  // A chain: nearest first, each once, never the rep.
  assert.deepEqual(
    pickedOnTerritoryVisit({ managerHrId: "DM-1", seniorHrId: "NSM-1", companions: [{ hrId: "DM-1" }, { hrId: "NSM-1" }, { hrId: "REP-1" }] }, "REP-1", "REP-1"),
    ["DM-1", "NSM-1"],
  );
  assert.deepEqual(pickedOnTerritoryVisit({ companions: [] }, "REP-1", "REP-1"), [], "her own single visit");
}

function checkTheTerritoryApproval(): void {
  const base = { id: VISIT, seatId: "SEAT-1", customerId: CUSTOMER, pressedDay: "2026-11-16", pressedAtDevice: "2026-11-16T11:40:00.000Z", senderHrId: "REP-1", repHrId: "REP-1" };
  const single = territoryApprovalBody({ ...base, body: { visitType: "planned", products: ["Alpha"], comment: "Saw the doctor", companions: [] } });
  assert.equal(single.record, "visit");
  assert.equal(single.id, VISIT, "🔴 the SAME id, so approving twice is the same visit, never a second");
  assert.equal(single.visitDate, "2026-11-16", "🔴 entered on the day it was PRESSED, not the day it arrived");
  assert.equal(single.visitTime, "13:40");
  assert.equal(single.planned, true);
  assert.equal(single.kind, "single");
  assert.deepEqual(single.products, ["Alpha"]);
  assert.equal(single.comment, "Saw the doctor");

  const double = territoryApprovalBody({ ...base, body: { visitType: "planned", managerHrId: "DM-1", companions: [{ hrId: "DM-1" }] } });
  assert.equal(double.kind, "double");
  assert.deepEqual(double.picked, ["DM-1"]);
  const chain = territoryApprovalBody({ ...base, body: { companions: [{ hrId: "DM-1" }, { hrId: "NSM-1" }] } });
  assert.equal(chain.kind, "chain");

  const offPlan = territoryApprovalBody({ ...base, body: { visitType: "out_of_plan", unplannedReason: "The doctor asked for a sample today" } });
  assert.equal(offPlan.planned, false, "an off-plan press stays off plan, and raises its approval as a rep's own does");
  assert.equal(offPlan.reason, "The doctor asked for a sample today", "in the rep's own words");
  const noReason = territoryApprovalBody({ ...base, body: { visitType: "out_of_plan", unplannedReason: "" } });
  assert.equal(noReason.reason, LATE_VISIT_DEFAULT_REASON, "the door needs a reason, and an off-plan press may carry none");
  assert.equal(territoryApprovalBody({ ...base, body: { visitType: "out_of_list" } }).planned, false);
}

function checkTheManagerApproval(): void {
  const approved = managerApprovalBody({
    id: VISIT,
    managerKey: "SEAT-DM",
    pressedDay: "2026-11-16",
    pressedAtDevice: "2026-11-16T11:40:00.000Z",
    body: { clientRef: VISIT, customerId: CUSTOMER, managerCustomerId: null, products: ["Alpha"], comment: "Visited", address: "Tanta", companionHrIds: ["NSM-1", 7, "", "PM-2"] },
  });
  assert.equal(approved.record, "manager-visit");
  assert.equal(approved.manager, "SEAT-DM");
  assert.equal(approved.id, VISIT);
  assert.equal(approved.customerId, CUSTOMER);
  assert.equal(approved.managerCustomerId, null);
  assert.equal(approved.visitDate, "2026-11-16");
  assert.equal(approved.visitTime, "13:40");
  assert.equal(approved.address, "Tanta");
  // 🔴 Who went with him travels with the approval (24 Nov 2026), so an approved visit never credits him alone.
  assert.deepEqual(approved.companionHrIds, ["NSM-1", "PM-2"], "🔴 the people his phone ticked reach the door");
  const alone = managerApprovalBody({ id: VISIT, managerKey: "SEAT-DM", pressedDay: "2026-11-16", pressedAtDevice: null, body: { customerId: CUSTOMER } });
  assert.deepEqual(alone.companionHrIds, [], "a visit with nobody ticked carries nobody");

  // 🔴 The manager missed-record door keeps them: checked against his own offers, refused when one is unknown, and
  // saved with the visit as one save, the visit taken back when the list fails.
  const door = stripComments(readFileSync("src/lib/phoenix-crm/server/manager-missed-records.ts", "utf8"));
  const enter = door.slice(door.indexOf("export async function enterManagerMissedVisit"), door.indexOf("export async function enterManagerMissedActivity"));
  assert.ok(enter.includes("missedCompanionsOf(body.companionHrIds, body.companionHrIds == null ? [] : await loadCompanionOffers(viewer, writer))"), "🔴 each person is checked against his own offers");
  assert.ok(enter.indexOf("missedCompanionsOf(") < enter.indexOf('.from("phoenix_crm_manager_visits")'), "and before the visit is written");
  assert.ok(enter.includes(".insert(companions.map((companion, position) => ({ manager_visit_id: visitId, hr_id: companion.hrId, side: companion.side, position })))"), "🔴 who went with him is saved");
  assert.ok(enter.includes("await getSupabaseAdmin().from(\"phoenix_crm_manager_visits\").delete().eq(\"id\", visitId);"), "🔴 a failed list takes the visit back");
  const check = door.slice(door.indexOf("function missedCompanionsOf"), door.indexOf("export async function enterManagerMissedVisit"));
  assert.ok(check.includes("if (!offer) throw validationError("), "🔴 an unknown person refuses the entry, never dropped");
}

function checkTheWords(): void {
  // Golden Rule #1: the held row says what happened to HIS work, never a check, a distance or a clock.
  for (const words of [VISIT_FILED_PILL, VISIT_FILED_LINE]) {
    assert.doesNotMatch(words, /check|late|gps|location|distance|flag|suspicious|minute|hour/i, `"${words}" names no check`);
  }
}

function checkTheDoors(): void {
  const service = stripComments(readFileSync("src/lib/phoenix-crm/server/late-visits.ts", "utf8"));
  // 🔴 Only the Super Admin decides: the list and the decision both ask the missed-record gate before anything else.
  const gate = service.indexOf("function assertSuperAdmin");
  assert.ok(gate > 0 && /canEnterMissedRecords\(viewer\)/.test(service.slice(gate, gate + 300)), "🔴 the gate is the Super Admin's own");
  for (const fn of ["loadLateVisits", "decideLateVisit"]) {
    const start = service.indexOf(`export async function ${fn}`);
    assert.ok(start > 0, fn);
    // The body opens at the first "{" that ends a line; a return type such as Promise<{ status }> holds an earlier one.
    const opening = service.slice(start, service.indexOf("{\n", start) + 60);
    assert.match(opening, /assertSuperAdmin\(viewer\)/, `🔴 ${fn} asks for the Super Admin first`);
  }
  // 🔴 The person filing comes from the session, never the body.
  const file = service.slice(service.indexOf("export async function fileLateVisit"), service.indexOf("// ── The Super Admin's list"));
  assert.match(file, /sender_hr_id: sender/);
  assert.match(file, /const sender = personKey\(viewer\.hrId\)/);
  assert.match(file, /\.eq\("sender_hr_id", sender\)/, "🔴 a filing answers as filed only when the row is this person's");
  // 🔴 Approval goes through the missed-record doors, never a write of its own to the visits.
  assert.doesNotMatch(service, /from\("phoenix_crm_visits"\)|from\("phoenix_crm_manager_visits"\)/);
  assert.match(service, /await enterMissedVisit\(/);
  assert.match(service, /await enterManagerMissedVisit\(/);
  // A decision lands once: only a pending row moves.
  assert.match(service, /\.update\(\{ status,[^}]*\}\)\s*\.eq\("id", id\)\s*\.eq\("status", "pending"\)/);

  const filing = stripComments(readFileSync("app/api/phoenix-crm/late-visits/route.ts", "utf8"));
  assert.match(filing, /assertPermission\(access, "phoenix_crm", "create"\)/, "filing is the gate logging a visit takes");
  assert.doesNotMatch(filing, /decideLateVisit|loadLateVisits/, "🔴 the filing door decides nothing and lists nothing");
  const decide = stripComments(readFileSync("app/api/phoenix-crm/late-visits/decide/route.ts", "utf8"));
  assert.match(decide, /assertPermission\(access, "phoenix_crm", "update"\)/, "deciding needs update, then the service narrows it to him");

  // 🔴 The screen is the Super Admin's: the page asks his own gate before it loads anything.
  const page = stripComments(readFileSync("app/(admin)/admin/field-crm/late-visits/page.tsx", "utf8"));
  const gateAt = page.indexOf("canEnterMissedRecords(viewer)");
  assert.ok(gateAt > 0 && gateAt < page.indexOf("loadLateVisits("), "🔴 the page asks for the Super Admin before it loads the list");
  const board = readFileSync("src/components/phoenix-crm/late-visits-board.tsx", "utf8");
  assert.match(board, /crmPost(?:<[^>]*>)?\(\s*"\/api\/phoenix-crm\/late-visits\/decide"/, "the board decides through the decide door");
}
