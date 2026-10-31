import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cairoOffsetMinutes } from "../src/lib/format/cairo-zone.ts";
import { isManagerVisitEnteredForHim, missedVisitInstant, parseMissedManagerVisit } from "../src/lib/phoenix-crm/missed-records.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the Super Admin enters what a MANAGER missed recording (owner, 2026-10-24).
 *
 * Asked what to build for managers he chose "Visits and days"; asked about interviews he chose to keep
 * "Admin work" plus a note. So a manager's day page carries the same "Enter a missed record" panel a rep's
 * does — a single visit of the manager's own, and, for a district or regional manager, how the day was spent —
 * behind the one gate the rep's uses (the Super Admin alone), with the visit marked "Entered by the Super Admin".
 */

const VISIT_DAY = "2026-10-24";
const ID = "6f1c9a7e-3b2d-4c1e-9a8f-0b1c2d3e4f50";
const CUSTOMER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

function visit(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: ID, customerId: CUSTOMER, visitDate: "2026-10-20", ...patch };
}

export async function runPhoenixCrmManagerMissedRecordsTests(): Promise<void> {
  // ── 1 · The visit from the wire: products and comment are optional, the customer is exactly one ──
  const bare = parseMissedManagerVisit(visit(), VISIT_DAY);
  assert.ok(bare.ok && bare.value.products.length === 0 && bare.value.comment === null && bare.value.address === null, "no products, no comment, no address is a valid entry");
  assert.ok(bare.ok && bare.value.clientRef === `admin:${ID}`, "the entry's id is its idempotency key");
  assert.equal(parseMissedManagerVisit(visit({ customerId: undefined }), VISIT_DAY).ok, false, "a customer is required");
  assert.equal(parseMissedManagerVisit(visit({ managerCustomerId: CUSTOMER }), VISIT_DAY).ok, false, "never both a rep's customer and one of his own list");
  assert.ok(parseMissedManagerVisit(visit({ customerId: undefined, managerCustomerId: CUSTOMER }), VISIT_DAY).ok, "or one of Manager's own list");
  assert.equal(parseMissedManagerVisit(visit({ visitDate: "2026-10-25" }), VISIT_DAY).ok, false, "never a day still to come");
  assert.equal(parseMissedManagerVisit(visit({ visitTime: "25:00" }), VISIT_DAY).ok, false);
  assert.equal(parseMissedManagerVisit(visit({ id: "nope" }), VISIT_DAY).ok, false);
  assert.equal(parseMissedManagerVisit(visit({ products: Array.from({ length: 13 }, (_, index) => `P${index}`) }), VISIT_DAY).ok, false, "twelve is still the most");
  assert.equal(parseMissedManagerVisit(visit({ comment: "x".repeat(1001) }), VISIT_DAY).ok, false);
  const typed = parseMissedManagerVisit(visit({ address: "  12  Tahrir   St ", comment: "  went   well " }), VISIT_DAY);
  assert.ok(typed.ok && typed.value.address === "12 Tahrir St" && typed.value.comment === "went well");

  // ── 2 · The instant: his time or noon, in Cairo, never later than now ───────────────────────────
  const now = new Date("2026-10-24T12:00:00Z");
  assert.equal(missedVisitInstant("2026-10-20", null, now, cairoOffsetMinutes).toISOString(), "2026-10-20T09:00:00.000Z", "noon in Cairo (UTC+3 in October)");
  assert.equal(missedVisitInstant("2026-10-20", 14 * 60 + 30, now, cairoOffsetMinutes).toISOString(), "2026-10-20T11:30:00.000Z");
  assert.equal(missedVisitInstant("2026-10-20", 30, now, cairoOffsetMinutes).toISOString(), "2026-10-20T21:30:00.000Z", "00:30 is the small hours AFTER the chosen day");
  assert.equal(missedVisitInstant("2026-10-24", 23 * 60, now, cairoOffsetMinutes).getTime(), now.getTime(), "a time still ahead today is now");

  // ── 3 · The mark: read from who entered it ─────────────────────────────────────────────────────
  assert.equal(isManagerVisitEnteredForHim({ enteredBy: "B-12", manager: "B-12" }), false, "his own visit");
  assert.equal(isManagerVisitEnteredForHim({ enteredBy: "b-10", manager: "B-12" }), true, "the Super Admin's entry");
  assert.equal(isManagerVisitEnteredForHim({ enteredBy: null, manager: "B-12" }), false);

  // ── 4 · The gate, the writes and the panel ──────────────────────────────────────────────────────
  const service = source("src/lib/phoenix-crm/server/manager-missed-records.ts");
  assert.match(service, /if \(!canEnterMissedRecords\(viewer\)\) throw forbiddenError\(/, "the Super Admin alone");
  assert.match(service, /resolveManagerDaySubject\(viewer, key\)/, "who the manager is comes from the day page's own gate");
  for (const entry of ["loadManagerMissedRecordForm", "enterManagerMissedVisit", "enterManagerMissedActivity"]) {
    const at = service.indexOf(`export async function ${entry}(`);
    assert.ok(at >= 0, `${entry} exists`);
    const body = service.slice(at, service.indexOf("\n}\n", at));
    assert.match(body, /await missedManager\(viewer, (raw|body)\.manager\)/, `${entry} passes the gate first`);
  }
  assert.match(service, /entered_by_hr_id: viewer\.hrId,/, "the visit records who entered it — the mark is read from that");
  assert.match(service, /is_test: false,/, "real data only: a manager's row is never drawn in test mode");
  assert.match(service, /vacantVisitPlaceError\(\{ vacant, address: entry\.address, captured: false \}\)/, "a vacant area's doctor still needs the typed address");
  assert.match(service, /if \(existing && !existing\.enteredByAdmin\) throw conflictError\(/, "a day the manager recorded himself stays his");
  assert.match(service, /recordsOwnDayOn\(seat\)/, "a day is offered to the district and regional tiers alone");
  assert.doesNotMatch(service, /assertSingleVisitLogFits/, "an entry that records what happened is not held to the weekly limit");

  const route = source("app/api/phoenix-crm/missed-records/route.ts");
  assert.match(route, /body\.record === "manager-visit"[\s\S]*enterManagerMissedVisit\(viewer, body\)/);
  assert.match(route, /body\.record === "manager-activity"[\s\S]*enterManagerMissedActivity\(viewer, body\)/);
  assert.match(route, /await assertPermission\(access, "phoenix_crm", "update"\);/, "the same `update` gate as the rep's");

  const day = source("src/lib/phoenix-crm/server/manager-day-detail.ts");
  assert.match(day, /missedRecords: canEnterMissedRecords\(viewer\) && isMissedRecordDay\(date, viewer\.visitDay\)/, "the panel is the server's decision");
  const view = source("src/components/phoenix-crm/manager-day-view.tsx");
  assert.match(view, /\{view\.missedRecords \? \(\s*<ManagerMissedRecordPanel/, "drawn only where the server said so");
  const table = source("src/components/phoenix-crm/manager-plan-actual-table.tsx");
  assert.match(table, /visit\?\.enteredByAdmin \? <Chip[^>]*>\{MISSED_RECORD_MARK\}<\/Chip>/, "the visit shows 'Entered by the Super Admin'");
  const details = source("src/lib/phoenix-crm/server/manager-visit-details.ts");
  assert.match(details, /enteredByAdmin: isManagerVisitEnteredForHim\(\{ enteredBy: row\.entered_by_hr_id, manager: row\.manager_hr_id \}\)/);

  // ── 5 · The rep side: single, double or chain; no products or comment needed ───────────────────
  const migration = source("supabase/migrations/20261024213000_phoenix_crm_admin_entry_kind_and_optional_products.sql");
  assert.match(migration, /cardinality\(products\) <= 12\s+and \(cardinality\(products\) >= 1 or capture_source = 'admin'\)/, "no products — on an admin visit ONLY");
  assert.match(migration, /or v_kind not in \('single', 'double', 'chain'\)/, "the three a rep logs himself");
  assert.match(migration, /\(v_kind = 'chain' and \(v_manager is null or v_senior is null\)\)/, "a chain names both people");
  const repService = source("src/lib/phoenix-crm/server/missed-records.ts");
  assert.match(repService, /resolveVisitParticipants\(\{[\s\S]*enteredAs: "rep",/, "the people are checked against the territory's chain by the rep's own rule");
  assert.match(repService, /unplannedFirstStatus\(reviewer !== null, reviewerOnTheVisit\)/, "a manager who was ON the visit does not approve it");
  assert.match(repService, /if \(entry\.products\.length > 0\) \{/, "products are checked only when he chose some");
  const panel = source("src/components/phoenix-crm/missed-record-panel.tsx");
  assert.match(panel, /label="Single, double or chain"/, "the form offers the choice");
  assert.doesNotMatch(panel, /products\.length > 0 &&\s*comment\.trim\(\)\.length > 0/, "neither is required to save");

  // ── 6 · The rep's out-of-plan cap does not apply to a visit the admin enters ──────────────────
  const cap = readFileSync(new URL("../supabase/migrations/20261024223000_phoenix_crm_admin_entry_skips_the_offplan_cap.sql", import.meta.url), "utf8");
  const gate = cap.indexOf("if new.capture_source = 'admin' then\n    return new;");
  assert.ok(gate > 0, "an admin-entered visit returns before the cap is counted");
  assert.ok(gate < cap.indexOf("phoenix_crm_offplan_exempt(new.seat_id"), "…and before the named exemptions, which stamp the row");
  assert.ok(gate < cap.indexOf("raise exception 'phoenix_crm:offplan_day_full'"), "…and before the day's refusal");
  assert.ok(gate < cap.indexOf("raise exception 'phoenix_crm:offplan_week_full'"), "…and before the week's");
  assert.match(cap, /select s\.offplan_daily_cap, s\.offplan_weekly_cap into v_daily, v_weekly/, "a rep's own visit is still held to the settings' numbers");
  assert.match(cap, /revoke execute on function public\.phoenix_crm_offplan_visit_cap\(\) from public, anon, authenticated;/, "the function stays closed to the browser roles");

  // ── 7 · A visit still waiting for its approvals is LISTED on the rep's day, marked, and counted nowhere ──
  const repDetails = source("src/lib/phoenix-crm/server/manager-visit-details.ts");
  assert.match(repDetails, /const WAITING_STATUSES = \["admin_pending", "manager_pending", "sfe_pending"\];/, "exactly the statuses the countable view holds out");
  assert.match(repDetails, /\.from\("phoenix_crm_unplanned_visits"\)[\s\S]*?\.in\("status", WAITING_STATUSES\)/, "found through the approval table's own status");
  assert.match(repDetails, /awaitingApproval: true, awaitingValidation: false/, "marked waiting, and not 'not scored' for a reason it does not have");
  assert.match(repDetails, /input\.includeWaiting \? loadWaitingOffPlanRows\(/, "read only when the caller asks");
  assert.match(source("src/lib/phoenix-crm/server/day-detail.ts"), /includeWaiting: true,/, "the rep's day page asks");
  assert.doesNotMatch(source("src/lib/private-calendar/visit-detail-items.ts"), /includeWaiting/, "the private calendar's figures are untouched");
  assert.match(table, /visit\.awaitingApproval \? <Chip[^>]*>Waiting for approval/, "the table says what the visit waits for");
}
