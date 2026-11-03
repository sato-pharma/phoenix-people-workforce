import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  priceChainedJourney,
  readJourneyPricing,
  readJourneyStops,
  rebaseClaimOnStopTicket,
  type ChainedJourneyInput,
  type OutstationJourneyStop,
} from "../src/lib/outstation/chained-journey.ts";
import { claimMoneyRows } from "../src/lib/outstation/claim-money-rows.ts";
import {
  isJourneyStopOpen,
  journeyStopEvidenceKind,
  journeyStopEvidenceRefusal,
  journeyStopRule,
  journeyStopRuleForNewClaim,
  journeyStopWriteStatuses,
  payrollRowHoldsPersonsFigure,
  stopAlreadySavedFor,
} from "../src/lib/outstation/journey-stop-rules.ts";

/**
 * The stop rebuilt from scratch (owner, 2026-11-03: "nsms/pms should not have evidence photo ...
 * what if he is trans and no car what is he supposed to capture? ... rebuild the stop from scratch").
 * What a person owes at the next place, what it pays, and that the rows already stored still read.
 */
function stop(overrides: Partial<OutstationJourneyStop>): OutstationJourneyStop {
  return {
    accuracyMeters: 12,
    capturedAt: "2026-10-18T13:00:00.000Z",
    evidence: "location_ticket",
    governorate: "Assiut",
    latitude: 27.18,
    legFrom: "stop",
    legFromCapturedAt: null,
    legFromGovernorate: null,
    legFromPreviousKm: 160,
    legFromPreviousMinutes: 180,
    locationLabel: "Assiut",
    longitude: 31.18,
    photoPath: null,
    returnHomeKm: 374,
    routeError: null,
    stopNumber: 2,
    ticketAmount: 0,
    ticketPaths: [],
    ...overrides,
  };
}

const TRAIN_TO_SOHAG: ChainedJourneyInput = {
  arrival: { capturedAt: "2026-10-17T14:23:00.000Z", distanceFromResidenceKm: 516, governorate: "Sohag" },
  fuelRatePerKm: 1.8,
  residenceGovernorate: "Giza",
  stops: [],
  travel: "ticket",
  tripEndDate: "2026-10-19",
  tripStartDate: "2026-10-17",
};

export function runOutstationJourneyStopRulesTests() {
  // ── 1. What each person owes at the next place ─────────────────────────────
  assert.deepEqual(
    journeyStopRule({ employeeRole: "District Manager", transportationType: "car" }),
    { paysFuel: true, photo: true, ticket: "none" },
    "a car trip with photos: one live photo, paid in fuel",
  );
  assert.deepEqual(
    journeyStopRule({ employeeRole: "National Sales Manager", transportationType: "car" }),
    { paysFuel: true, photo: false, ticket: "none" },
    "a National Sales Manager by car: the location alone, paid drive by drive",
  );
  assert.deepEqual(
    journeyStopRule({ employeeRole: "District Manager", transportationType: "train" }),
    { paysFuel: false, photo: false, ticket: "required" },
    "no car: never a photo of a car, the location and that leg's ticket",
  );
  assert.deepEqual(
    journeyStopRule({ employeeRole: "Product Manager", transportationType: "bus" }),
    { paysFuel: false, photo: false, ticket: "optional" },
    "no car and no photos owed: the location, the ticket when there is one",
  );

  // ── 2. The evidence a stop is refused without, before anything is uploaded ─────
  const carPhoto = journeyStopRule({ employeeRole: "District Manager", transportationType: "car" });
  const trainTicket = journeyStopRule({ employeeRole: "District Manager", transportationType: "train" });
  const waivedBus = journeyStopRule({ employeeRole: "Product Manager", transportationType: "bus" });
  const refuse = (rule: typeof carPhoto, hasPhoto: boolean, ticketAmount: number, ticketFileCount: number) =>
    journeyStopEvidenceRefusal({ hasPhoto, rule, ticketAmount, ticketFileCount });
  assert.match(String(refuse(carPhoto, false, 0, 0)), /live photo/);
  assert.equal(refuse(carPhoto, true, 0, 0), null);
  assert.match(String(refuse(carPhoto, true, 50, 1)), /must not carry a ticket/, "a car drive is paid in fuel, never twice");
  assert.match(String(refuse(trainTicket, false, 0, 0)), /required/);
  assert.match(String(refuse(trainTicket, false, 120, 0)), /required/, "an amount with no ticket pays nothing");
  assert.match(String(refuse(trainTicket, false, 0, 1)), /required/, "a ticket with no amount pays nothing");
  assert.equal(refuse(trainTicket, false, 120, 1), null);
  assert.equal(refuse(waivedBus, false, 0, 0), null, "the optional ticket may be left out");
  assert.match(String(refuse(waivedBus, false, 120, 0)), /file is required/);
  assert.match(String(refuse(waivedBus, false, 0, 1)), /amount is required/);
  assert.equal(journeyStopEvidenceKind(carPhoto, 0), "live_photo");
  assert.equal(journeyStopEvidenceKind(trainTicket, 1), "location_ticket");
  assert.equal(journeyStopEvidenceKind(waivedBus, 0), "location");

  // ── 3. Only a claim the SYSTEM accepted stays open, and only for that one role ──
  assert.equal(isJourneyStopOpen("submitted", "District Manager"), true);
  assert.equal(isJourneyStopOpen("accepted_by_system", "District Manager"), false);
  assert.equal(isJourneyStopOpen("accepted_by_system", "National Sales Manager"), true);
  assert.equal(isJourneyStopOpen("accepted_by_admin", "National Sales Manager"), false, "a person's decision closes it");
  assert.equal(isJourneyStopOpen("rejected", "National Sales Manager"), false);
  assert.ok(journeyStopWriteStatuses("National Sales Manager").includes("accepted_by_system"));
  assert.ok(!journeyStopWriteStatuses("District Manager").includes("accepted_by_system"));

  // ── 4. No car: every drive is listed and no fuel is ever paid ─────────────────
  assert.equal(priceChainedJourney(TRAIN_TO_SOHAG).fuelAmount, 0, "with no stop at all, a trip without a car still pays no fuel");
  const ticketed = priceChainedJourney({
    ...TRAIN_TO_SOHAG,
    stops: [stop({ ticketAmount: 120, ticketPaths: ["tickets/assiut.jpg"] })],
  });
  assert.equal(ticketed.mode, "ticket_journey");
  assert.equal(ticketed.fuelAmount, 0, "a trip without a car pays no fuel");
  assert.equal(ticketed.singleDestinationFuelAmount, 0);
  assert.equal(ticketed.paidKm, 0);
  assert.deepEqual(
    ticketed.legs.map((leg) => [leg.from, leg.to, leg.reason, leg.ticketAmount, leg.fuelAmount]),
    [
      ["Home (Giza)", "Sohag", "ticket_on_claim", 0, 0],
      ["Sohag", "Assiut", "ticket_leg", 120, 0],
      ["Assiut", "Home (Giza)", "ticket_on_claim", 0, 0],
    ],
    "the leg with its own ticket shows that ticket; the others say the ticket is on the claim",
  );
  assert.ok(
    ticketed.legs.every((leg) => !/Stop \d|Arrival/.test(`${leg.from} ${leg.to}`)),
    "a place reads as its governorate, never as a stop number",
  );

  // ── 5. A stop's ticket moves the claim by exactly its amount ──────────────────
  const moved = rebaseClaimOnStopTicket({
    addedTicketAmount: 120,
    claimedTotalAmount: 1500,
    expectedTotalFor: (travelCost) => travelCost + 400,
    fuelAmount: 0,
    reportTravelCost: 1100,
    ticketAmount: 1100,
  });
  assert.deepEqual(moved, {
    claimedTotalAmount: 1620,
    expectedTotalAmount: 1620,
    reportTravelCost: 1220,
    ticketAmount: 1220,
  });
  assert.equal(
    rebaseClaimOnStopTicket({
      addedTicketAmount: 0,
      claimedTotalAmount: 1500,
      expectedTotalFor: (travelCost) => travelCost + 400,
      fuelAmount: 0,
      reportTravelCost: 1100,
      ticketAmount: 1100,
    }).claimedTotalAmount,
    1500,
    "a stop with no ticket changes nothing",
  );

  // ── 6. What is already stored still reads, in the new words ───────────────────
  const [oldRow] = readJourneyStops([
    {
      capturedAt: "2026-10-18T13:00:00.000Z",
      latitude: 27.18,
      longitude: 31.18,
      photoPath: "stops/old.jpg",
      stopNumber: 2,
    },
  ]);
  assert.equal(oldRow.evidence, "live_photo", "a stored stop from before this rule is a live photo");
  assert.equal(oldRow.ticketAmount, 0);
  assert.deepEqual(oldRow.ticketPaths, []);
  assert.equal(
    readJourneyStops([{ capturedAt: "2026-10-18T13:00:00.000Z", latitude: 27.18, longitude: 31.18, stopNumber: 2 }]).length,
    0,
    "a row with neither a photo nor a kind proves nothing and is not read",
  );
  const storedPricing = readJourneyPricing({
    flagReasons: [],
    flags: [],
    fuelAmount: 100,
    legs: [
      { distanceKm: 44, from: "Departure photo (Fayoum)", fuelAmount: 80, paid: true, reason: "different_governorates", to: "Stop 2 (Beni Suef)" },
      { distanceKm: 90, from: "Stop 2 (Beni Suef)", fuelAmount: 0, paid: false, reason: "same_governorate", to: "Arrival" },
    ],
    mode: "chained",
    modeReason: "",
    paidKm: 44,
    singleDestinationFuelAmount: 90,
  });
  assert.deepEqual(
    storedPricing?.legs.map((leg) => [leg.from, leg.to, leg.ticketAmount]),
    [
      ["Fayoum", "Beni Suef", 0],
      ["Beni Suef", "First place", 0],
    ],
    "a route stored in the old words reads in the new ones, and its money is untouched",
  );
  assert.equal(storedPricing?.fuelAmount, 100);

  // ── 7. The claim's money shows what it holds, never a row of zeros ─────────────
  const money = (over: Record<string, unknown>) =>
    claimMoneyRows({
      allowanceAmount: 0,
      meetingAmount: 0,
      otherAmount: 0,
      ticketAmount: 0,
      transportationType: "car",
      travelCost: 0,
      ...over,
    } as never).map((row) => [row.label, row.amount]);
  assert.deepEqual(money({ allowanceAmount: 500, travelCost: 900 }), [["Fuel", 900], ["Allowance", 500]]);
  assert.deepEqual(
    money({ ticketAmount: 300, transportationType: "train", travelCost: 300 }),
    [["Tickets", 300]],
    "a ticket inside the travel cost is shown once",
  );

  // ── 7b. The risk review of this rebuild: what must never pay twice, or pay unseen ──
  // A typed ticket never reaches a claim the system already accepted; a car stop on one still pays fuel.
  const acceptedTrain = journeyStopRule({
    employeeRole: "National Sales Manager",
    status: "accepted_by_system",
    transportationType: "train",
  });
  assert.deepEqual(acceptedTrain, { paysFuel: false, photo: false, ticket: "none" }, "location alone, nothing typed");
  assert.match(
    String(journeyStopEvidenceRefusal({ hasPhoto: false, rule: acceptedTrain, ticketAmount: 200, ticketFileCount: 1 })),
    /before it is accepted/,
    "a ticket on an accepted claim is refused, with no figure reaching payroll",
  );
  assert.equal(
    journeyStopEvidenceRefusal({ hasPhoto: false, rule: acceptedTrain, ticketAmount: 0, ticketFileCount: 0 }),
    null,
    "the location alone is still a stop",
  );
  assert.equal(
    journeyStopRule({ employeeRole: "National Sales Manager", status: "accepted_by_system", transportationType: "car" }).paysFuel,
    true,
    "the owner's paid-by-drive stop stands",
  );
  assert.equal(
    journeyStopRuleForNewClaim({ employeeRole: "National Sales Manager", transportationType: "train" }).ticket,
    "none",
    "the card right after Submit asks the same",
  );
  assert.equal(
    journeyStopRuleForNewClaim({ employeeRole: "District Manager", transportationType: "train" }).ticket,
    "required",
    "an undecided claim still takes its ticket",
  );

  // A person's typed figure closes the stop, and a system push (no amount) does not.
  assert.equal(payrollRowHoldsPersonsFigure({ approvedAmount: 800 }), true);
  assert.equal(payrollRowHoldsPersonsFigure({ approvedAmount: 0 }), true, "a figure of nothing is still a person's");
  assert.equal(payrollRowHoldsPersonsFigure({ approvedAmount: null }), false);
  assert.equal(payrollRowHoldsPersonsFigure(null), false);

  // A retry finds what the capture already saved, and the stored row keeps the key that finds it.
  const keyed = stop({ captureKey: "capture-1", stopNumber: 3 });
  assert.equal(stopAlreadySavedFor([stop({}), keyed], "capture-1"), keyed);
  assert.equal(stopAlreadySavedFor([stop({}), keyed], "capture-2"), null, "a new capture is a new stop");
  assert.equal(stopAlreadySavedFor([stop({})], ""), null, "no key finds nothing, even on a stop with none");
  assert.equal(readJourneyStops([keyed])[0]?.captureKey, "capture-1", "the key survives the reader");
  assert.equal("captureKey" in (readJourneyStops([stop({})])[0] ?? {}), false, "and an old row gains none");

  const service = readFileSync("src/lib/outstation/service.ts", "utf8");
  const capture = service.slice(service.indexOf("export async function captureOutstationJourneyStop("));
  assert.ok(
    capture.indexOf("stopAlreadySavedFor(") < capture.indexOf("isJourneyStopOpen("),
    "a retry is answered before any refusal",
  );
  assert.ok(
    capture.indexOf("stopAlreadySavedFor(") < capture.indexOf("uploadOutstationTicketAttachments("),
    "and before anything is uploaded",
  );
  assert.ok(capture.includes("payrollRowHoldsPersonsFigure(linkedPayroll)"), "a trimmed claim refuses the stop");
  const follow = service.slice(service.indexOf("async function followStopToPayroll("), service.indexOf("async function writeJourneyStopToClaim("));
  assert.ok(follow.includes("payrollRowHoldsPersonsFigure(linked)"), "a person's figure is never reported as followed");
  assert.ok(follow.includes("releaseOutstationRequestToPayrollIfReady(claim.id, systemAccessContext)"), "the first push runs as the system");
  assert.ok(follow.includes("describeExpenseResyncNotApplied(outcomes)"), "a confirmed run that did not take it is said");
  const writer = service.slice(service.indexOf("async function writeJourneyStopToClaim("), service.indexOf("export async function captureOutstationJourneyStop("));
  assert.match(writer, /try \{\s+await writeRequiredAuditLog\(/, "a failed audit row never reports a saved stop as failed");
  assert.ok(
    writer.includes('stopWrite.eq("attachment_count", request.attachmentCount)'),
    "a stop's ticket never overwrites a missing ticket attached meanwhile",
  );
  assert.ok(writer.includes("Payroll did not follow this stop"), "the claim itself says the payroll figure did not move");
  const stopsLookup = service.slice(service.indexOf("async function journeysWithStopsForEmployee("), service.indexOf("async function measureJourneyStop("));
  assert.ok(stopsLookup.includes('text(row.transportation_type).toLowerCase() === "car"'), "a no-car journey holds no car trip");
  const edit = service.slice(service.indexOf("export async function updateManagerExpenseAsAdmin("));
  assert.ok(edit.indexOf("assertOutstationClaimUnchanged(") < edit.indexOf('.from("outstation_expense_requests")'), "an old form's save is refused");
  const modal = readFileSync("src/components/outstation/admin-manager-expense-modal.tsx", "utf8");
  assert.ok(modal.includes("expectedRevision: request.updatedAt"), "and the form sends the version it opened on");
  const card = readFileSync("src/components/outstation/journey-stop-card.tsx", "utf8");
  assert.ok(card.includes("captureKeyRef.current ??= crypto.randomUUID()"), "the card keeps one key through its retries");

  // ── 8. The way in, the reader and the tab ──────────────────────────────────
  const page = readFileSync("app/employee-portals/submit-expense/page.tsx", "utf8");
  assert.match(page, /<JourneyMoveOn\b/, "the next place is reached from the top of the page");
  assert.match(page, /\.filter\(\(submission\) => submission\.canAddJourneyStop\)/, "and only while a trip can take one");
  const list = readFileSync("src/components/outstation/my-expense-submissions.tsx", "utf8");
  assert.ok(!list.includes("<JourneyStopCard"), "the capture no longer hides inside a closed claim");
  const attachments = readFileSync("app/api/admin/outstation/[id]/attachments/route.ts", "utf8");
  assert.match(attachments, /stop\.photoPath \? stopPhotoUrl\.get\(stop\.photoPath\)/, "a stop with no photo signs nothing");
}
