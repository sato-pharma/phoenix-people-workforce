import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cairoWallClockToIso } from "@/lib/format/cairo-zone";
import {
  ADMIN_ADDED_STOP_PHOTO_PATH,
  adminAddedStopNotes,
  readJourneyStops,
} from "@/lib/outstation/chained-journey";

import { stripComments } from "./support/comment-strip.ts";

// A system administrator adds a stop the employee missed (owner, 2026-11-03). The employee's own Add
// stop closes at the end of the trip's last day, and every refusal said "Ask a system administrator"
// while nothing let one. This suite pins:
//   1. the admin path is guarded before anything is read or written — admin access, then the
//      reviewer's version, the car trip, undecided, not in payroll, the cap, a reason, a position, a
//      time inside the trip's own days;
//   2. it measures, prices and writes through the employee's own three functions — never a fork;
//   3. the stop is marked as the administrator's, keeps that mark when read back, and says so in the
//      approval reason;
//   4. the form's Cairo time becomes the right instant in winter and in summer;
//   5. Expense Approvals offers it only for an undecided car trip under the cap.

const root = process.cwd();
const service = stripComments(readFileSync(join(root, "src/lib/outstation/service.ts"), "utf8"));
const attachmentsRoute = stripComments(
  readFileSync(join(root, "app/api/admin/outstation/[id]/attachments/route.ts"), "utf8"),
);
const stopRoute = stripComments(readFileSync(join(root, "app/api/admin/outstation/[id]/journey-stop/route.ts"), "utf8"));

function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is still in service.ts`);
  const next = source.slice(start + declaration.length).search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? source.slice(start) : source.slice(start, start + declaration.length + next);
}

export function runOutstationAdminMissedStopTests(): void {
  // ── 1. Guards, in order, before anything moves ─────────────────────────────────────────────────
  const admin = functionBody(service, "export async function addOutstationJourneyStopAsAdmin(");
  const at = (needle: string) => {
    const index = admin.indexOf(needle);
    assert.ok(index > 0, `addOutstationJourneyStopAsAdmin must still contain: ${needle}`);
    return index;
  };
  const access = at('await assertOutstationAdminAccess(access, "approve");');
  assert.ok(access < admin.indexOf(".from("), "admin access is checked before the claim is read");
  const write = at("await writeJourneyStopToClaim({");
  for (const guard of [
    "assertOutstationClaimUnchanged({",
    'request.expenseType !== "traveling" || request.transportationType !== "car"',
    "(JOURNEY_STOP_OPEN_STATUSES as readonly string[]).includes(request.status)",
    "isOutstationExpenseInPayroll(linkedPayroll)",
    "existingStops.length >= MAX_JOURNEY_STOPS",
    "if (!reason) throw new Error(",
    "if (!usablePosition(input.latitude, input.longitude))",
    "if (stoppedAtMs > Date.now())",
    "stopDay < firstDay || stopDay > lastDay",
  ]) {
    assert.ok(at(guard) < write, `${guard} must be checked before the stop is written`);
  }
  assert.ok(at("assertOutstationClaimUnchanged({") < at("JOURNEY_STOP_OPEN_STATUSES"), "the version is checked first");

  // ── 2. The employee's own measurement, pricing and write — never a fork ────────────────────────
  assert.ok(at("await measureJourneyStop({") < at("await priceJourneyStops({"));
  assert.ok(at("await priceJourneyStops({") < write);
  for (const fork of [/googleDirectionsRoute\(/, /priceChainedJourney\(/, /\.update\(/, /writeRequiredAuditLog/]) {
    assert.ok(!fork.test(admin), `addOutstationJourneyStopAsAdmin must not ${fork} on its own`);
  }
  assert.match(admin, /source: "admin_journey_stop"/);
  assert.match(admin, /photoPath: ADMIN_ADDED_STOP_PHOTO_PATH/);
  assert.match(admin, /addedByAdmin: \{ by: adminName, reason \}/);
  assert.ok(!/isWithinDepartureWindow\(/.test(admin), "the trip-window cutoff is the gap this closes — it must not return");

  // ── 3. The mark survives a read back, and the reason says so ───────────────────────────────────
  const base = {
    capturedAt: "2026-11-02T12:30:00.000Z",
    latitude: 27.18,
    longitude: 31.18,
    photoPath: ADMIN_ADDED_STOP_PHOTO_PATH,
    stopNumber: 2,
  };
  const [kept] = readJourneyStops([{ ...base, addedByAdmin: { by: "Omar Gawish", reason: "CRM visits in Assiut" } }]);
  assert.deepEqual(kept.addedByAdmin, { by: "Omar Gawish", reason: "CRM visits in Assiut" });
  const [half] = readJourneyStops([{ ...base, addedByAdmin: { by: "Omar Gawish" } }]);
  assert.equal(half.addedByAdmin, undefined, "a mark with no reason is dropped, never half-kept");
  const [employees] = readJourneyStops([{ ...base, photoPath: "outstation/stop.jpg" }]);
  assert.equal(employees.addedByAdmin, undefined, "an employee's stop carries no mark");
  assert.deepEqual(adminAddedStopNotes([kept, employees]), [
    "Stop 2 was added by a system administrator (Omar Gawish), with no photo: CRM visits in Assiut",
  ]);

  // ── 4. The form's Cairo wall clock becomes the right instant ────────────────────────────────────
  assert.equal(cairoWallClockToIso("2026-11-02T14:30"), "2026-11-02T12:30:00.000Z", "winter: Cairo is UTC+2");
  assert.equal(cairoWallClockToIso("2026-07-01T14:30"), "2026-07-01T11:30:00.000Z", "summer: Cairo is UTC+3");
  assert.equal(cairoWallClockToIso("2026-11-02 14:30"), "", "only a datetime-local value is read");
  assert.equal(cairoWallClockToIso(undefined), "");
  assert.match(stopRoute, /stoppedAt: cairoWallClockToIso\(body\.stoppedAtCairo\)/);

  // ── 5. Offered only where the service would accept it ───────────────────────────────────────────
  assert.match(
    attachmentsRoute,
    /requestRow\.expenseType === "traveling" &&\s+requestRow\.transportationType === "car" &&\s+isOutstationClaimUndecided\(requestRow\.status\) &&\s+stops\.length < MAX_JOURNEY_STOPS/,
  );
  assert.match(attachmentsRoute, /revision: outstationClaimRevision\(requestRow\.updatedAt\)/);
  assert.match(attachmentsRoute, /stop\.addedByAdmin \? "" : stop\.photoPath/, "no signed URL is asked for a stop with no photo");
}
