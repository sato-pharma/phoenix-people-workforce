import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cairoWallClockToIso } from "@/lib/format/cairo-zone";
import { adminJourneyStopNoticeMessage, adminStopNoticeKey } from "@/lib/outstation/admin-stop-notice";
import {
  ADMIN_ADDED_STOP_PHOTO_PATH,
  adminAddedStopNotes,
  readJourneyStops,
} from "@/lib/outstation/chained-journey";
import {
  adminMissedStopRule,
  isJourneyStopOpen,
  journeyStopEvidenceKind,
  journeyStopEvidenceRefusal,
} from "@/lib/outstation/journey-stop-rules";

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
//   5. Expense Approvals offers it only where the service would take it, under the cap;
//   6. without a car HR adds the leg's ticket with the stop — on a National Sales Manager's claim the
//      system accepted too (owner, 2026-11-19: Amr Naguib, Cairo to Sohag, Sohag to Assiut, home);
//   7. the employee is TOLD - in-app, Telegram and email - after the stop is saved (owner, 2026-11-19:
//      "AMR IS NOT INFORMED WHY ?"), and a ticket stop reads back as a ticket stop.

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
    'request.expenseType !== "traveling"',
    "if (!isJourneyStopOpen(request.status, request.employeeRole))",
    "isOutstationExpenseInPayroll(linkedPayroll)",
    "payrollRowHoldsPersonsFigure(linkedPayroll)",
    "if (evidenceRefusal) throw new Error(evidenceRefusal);",
    "existingStops.length >= MAX_JOURNEY_STOPS",
    "if (!reason) throw new Error(",
    "if (!usablePosition(input.latitude, input.longitude))",
    "if (stoppedAtMs > Date.now())",
    "stopDay < firstDay || stopDay > lastDay",
  ]) {
    assert.ok(at(guard) < write, `${guard} must be checked before the stop is written`);
  }
  assert.ok(at("assertOutstationClaimUnchanged({") < at("isJourneyStopOpen("), "the version is checked first");
  assert.ok(
    at("if (evidenceRefusal) throw new Error(evidenceRefusal);") < at("uploadOutstationTicketAttachments("),
    "a refused ticket is never stored",
  );

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
    /requestRow\.expenseType === "traveling" &&\s+isJourneyStopOpen\(requestRow\.status, requestRow\.employeeRole\) &&\s+stops\.length < MAX_JOURNEY_STOPS/,
  );
  assert.match(attachmentsRoute, /ticket: adminMissedStopRule\(\{/, "the screen asks the ticket only where the service does");
  assert.match(attachmentsRoute, /revision: outstationClaimRevision\(requestRow\.updatedAt\)/);
  assert.match(attachmentsRoute, /stop\.addedByAdmin \? "" : stop\.photoPath/, "no signed URL is asked for a stop with no photo");

  // ── 6. Without a car, HR adds the leg's ticket — on a system-accepted NSM claim too ───────────────
  const nsm = "National Sales Manager";
  const nsmTrain = adminMissedStopRule({ employeeRole: nsm, transportationType: "train" });
  assert.deepEqual(nsmTrain, { paysFuel: false, photo: false, ticket: "optional" }, "an NSM owes no evidence: the ticket is optional");
  assert.equal(isJourneyStopOpen("accepted_by_system", nsm), true, "HEADLINE: Amr Naguib's accepted train trip takes HR's stop");
  assert.equal(isJourneyStopOpen("accepted_by_admin", nsm), false, "a person's acceptance still closes it");
  assert.equal(isJourneyStopOpen("accepted_by_system", "District Manager"), false, "never widened to another role");
  assert.equal(
    journeyStopEvidenceRefusal({ hasPhoto: false, rule: nsmTrain, ticketAmount: 250, ticketFileCount: 1 }),
    null,
    "HR's 250 ticket with its file joins the system-accepted claim",
  );
  assert.equal(journeyStopEvidenceKind(nsmTrain, 1), "location_ticket");
  assert.match(
    String(journeyStopEvidenceRefusal({ hasPhoto: false, rule: nsmTrain, ticketAmount: 250, ticketFileCount: 0 })),
    /a file is required/,
    "an amount with no ticket file is refused",
  );
  const repTrain = adminMissedStopRule({ employeeRole: "Medical Representative", transportationType: "train" });
  assert.equal(repTrain.ticket, "required", "a role that owes evidence must bring the leg's ticket");
  assert.ok(journeyStopEvidenceRefusal({ hasPhoto: false, rule: repTrain, ticketAmount: 0, ticketFileCount: 0 }));
  const car = adminMissedStopRule({ employeeRole: nsm, transportationType: "car" });
  assert.deepEqual(car, { paysFuel: true, photo: false, ticket: "none" }, "a car's drive is fuel, never a ticket");
  assert.ok(journeyStopEvidenceRefusal({ hasPhoto: false, rule: car, ticketAmount: 250, ticketFileCount: 1 }));
  assert.match(admin, /travel: rule\.paysFuel \? "car" : "ticket"/);
  assert.match(admin, /paysFuel: rule\.paysFuel,/);
  assert.match(admin, /ticket: \{ amount: stopTicketAmount, uploaded: uploadedTickets \}/);
  assert.match(stopRoute, /parseOutstationTicketAttachmentDataUrl\(/);

  // ── 7. The employee is told, after the stop is saved ─────────────────────────────────────────────
  const notifyCall = admin.indexOf("notifyEmployeeOfAdminJourneyStop({ request: updated, stop })");
  assert.ok(notifyCall > write, "HEADLINE: HR's stop tells the employee, and only once it is written");
  assert.match(
    admin,
    /await afterResponse\("outstation_notice:admin_stop", \(\) => notifyEmployeeOfAdminJourneyStop\(\{ request: updated, stop \}\)\);/,
    "the notice runs after the reply, so the stop never waits on it",
  );
  const notice = functionBody(service, "export async function notifyEmployeeOfAdminJourneyStop(");
  assert.match(notice, /channels: \["in_app", "telegram", "email"\]/, "the owner's three channels: in-app, Telegram, email");
  assert.match(notice, /eventType: "journey_stop_added_by_hr"/);
  assert.match(notice, /templateKey: "general"/, "the email is the plain template, never the submit one");
  assert.match(notice, /subjectHrId: r\.employeeHrId/, "without the subject the email half is refused");
  assert.match(notice, /\[r\.employeeHrId\],?\s*\)/, "it goes to the employee alone");
  assert.match(notice, /\} catch \(error\) \{\s*logError\(/, "a failed notice never undoes the saved stop");
  assert.match(
    readFileSync(join(root, "src/lib/notifications/notification-types.ts"), "utf8"),
    /eventType: "journey_stop_added_by_hr"/,
    "the event is registered in the notice catalogue",
  );
  const message = adminJourneyStopNoticeMessage({
    claimedTotal: 1974,
    stop: {
      addedByAdmin: { by: "Omar Gawish", reason: "Sohag to Assiut, then the 16:50 train to Cairo." },
      capturedAt: "2026-11-04T12:00:00.000Z",
      governorate: "Assiut",
      locationLabel: "55JM+896, Asyut 1, Assiut Governorate",
      stopNumber: 2,
      ticketAmount: 250,
    },
    tripEndDate: "2026-11-04",
    tripStartDate: "2026-11-02",
  });
  assert.match(message, /^HR added stop 2, Assiut, to your trip of /, "where");
  assert.match(message, /2:00\sPM/, "when, in Cairo time (12:00 UTC is 14:00 in Cairo in November)");
  assert.match(message, /with its ticket of 250 EGP/, "the leg's ticket");
  assert.match(message, /Your claim is now 1,974 EGP\./, "the new total");
  assert.match(message, /Reason: Sohag to Assiut, then the 16:50 train to Cairo\.$/, "why");
  assert.doesNotMatch(
    adminJourneyStopNoticeMessage({
      claimedTotal: 900,
      stop: { capturedAt: "2026-11-04T12:00:00.000Z", governorate: null, locationLabel: null, stopNumber: 3, ticketAmount: 0 },
      tripEndDate: "2026-11-04",
      tripStartDate: "2026-11-04",
    }),
    /ticket|Reason/,
    "a car stop names no ticket, and no reason when none was kept",
  );
  assert.equal(adminStopNoticeKey(338, 2, " b-122 "), "outstation:338:journey_stop_added_by_hr:2:B-122", "told once per stop");

  // A stop HR added with its ticket reads back as a ticket stop, so both screens show the 250.
  const [ticketStop] = readJourneyStops([
    {
      addedByAdmin: { by: "Omar Gawish", reason: "Sohag to Assiut." },
      capturedAt: "2026-11-04T12:00:00.000Z",
      evidence: "location_ticket",
      latitude: 27.1809,
      longitude: 31.1837,
      photoPath: ADMIN_ADDED_STOP_PHOTO_PATH,
      stopNumber: 2,
      ticketAmount: 250,
      ticketPaths: ["tickets/B-122/outstation-stop-x/1-1.jpg"],
    },
  ]);
  assert.equal(ticketStop?.evidence, "location_ticket", "HEADLINE: HR's ticket stop is not read back as location only");
  assert.equal(ticketStop?.ticketAmount, 250);
}
