import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CHAINED_LEG_MINIMUM_KM,
  classifyJourneyLeg,
  journeyOverlapHoldReason,
  journeyStopDays,
  pickJourneyLegOrigin,
  priceChainedJourney,
  readJourneyPricing,
  readJourneyStops,
  rebaseClaimOnNewFuel,
  withJourneyReason,
  type ChainedJourneyInput,
  type OutstationJourneyStop,
} from "../src/lib/outstation/chained-journey.ts";

/**
 * Chained-journey fuel (owner rule, 2026-10-18).
 *
 * A District Manager living in Mallawi (Minya) drove to Sinnuris (Fayoum) on 17 Oct 2026, slept
 * there, drove on to Beni Suef the next day and went home from Beni Suef. The old rule priced
 * only home → Sinnuris → home (237.16 km × 2 × 1.8 = 853.78). The owner's rule: a journey that
 * moves governorate to governorate pays each drive once, one way — 237.16 + 44.5 + 194.0 km × 1.8
 * = 856.19 — and only drives between two governorates over 40 km count. When every stop after the
 * first is inside one governorate (Mallawi → Assiut → Dairut → home) "keep as today rule".
 * Every abuse check flags; none refuses.
 */

function stop(overrides: Partial<OutstationJourneyStop> & { stopNumber: number }): OutstationJourneyStop {
  return {
    accuracyMeters: 12,
    capturedAt: "2026-10-18T13:00:00.000Z",
    governorate: "Beni Suef",
    latitude: 29.0758811,
    legFrom: "arrival",
    legFromCapturedAt: null,
    legFromGovernorate: null,
    legFromPreviousKm: 44.5,
    legFromPreviousMinutes: 58,
    locationLabel: "Beni Suef",
    longitude: 31.0955565,
    evidence: "live_photo",
    photoPath: "stops/test.jpg",
    returnHomeKm: 194,
    routeError: null,
    ticketAmount: 0,
    ticketPaths: [],
    ...overrides,
  };
}

// The owner's own Example 1, on the real numbers: arrival photo 17 Oct 17:23 Cairo, departure photo
// in Fayoum city 18 Oct 14:24 Cairo, Beni Suef 16:00 — the drive is measured from Fayoum city.
const BENI_SUEF_FROM_FAYOUM_CITY = stop({
  legFrom: "departure",
  legFromCapturedAt: "2026-10-18T11:24:00.000Z",
  legFromGovernorate: "Fayoum",
  stopNumber: 2,
});

function exampleOne(stops: OutstationJourneyStop[] = [BENI_SUEF_FROM_FAYOUM_CITY]): ChainedJourneyInput {
  return {
    arrival: { capturedAt: "2026-10-17T14:23:00.000Z", distanceFromResidenceKm: 237.16, governorate: "Fayoum" },
    fuelRatePerKm: 1.8,
    residenceGovernorate: "Minya",
    stops,
    tripEndDate: "2026-10-18",
    tripStartDate: "2026-10-17",
  };
}

export function runOutstationChainedJourneyTests() {
  // ── The leg test itself: other governorate AND over 40 km ──────────────────────────────────
  {
    assert.deepEqual(classifyJourneyLeg({ distanceKm: 44.5, fromGovernorate: "Fayoum", toGovernorate: "Beni Suef" }), {
      paid: true,
      reason: "different_governorates",
    });
    assert.equal(CHAINED_LEG_MINIMUM_KM, 40, "the owner's number is 40 km");
    assert.equal(
      classifyJourneyLeg({ distanceKm: 40, fromGovernorate: "Fayoum", toGovernorate: "Beni Suef" }).reason,
      "under_minimum_km",
      "exactly 40 km is not MORE than 40",
    );
    assert.equal(
      classifyJourneyLeg({ distanceKm: 58.7, fromGovernorate: "Assiut", toGovernorate: "Assiut" }).reason,
      "same_governorate",
      "Assiut → Dairut is inside Assiut and pays nothing, however long",
    );
    assert.equal(
      classifyJourneyLeg({ distanceKm: 44.5, fromGovernorate: null, toGovernorate: "Beni Suef" }).reason,
      "governorate_unknown",
    );
    assert.equal(
      classifyJourneyLeg({ distanceKm: null, fromGovernorate: "Fayoum", toGovernorate: "Beni Suef" }).reason,
      "distance_unknown",
    );
    assert.equal(
      classifyJourneyLeg({ distanceKm: null, fromGovernorate: "Alexandria", toGovernorate: "Alexandria" }).reason,
      "same_governorate",
      "a drive inside one governorate pays nothing, so a missing road distance must not make it unpriceable",
    );
  }

  // ── A lost Google route on a drive inside one governorate keeps the chain priced ──────────
  {
    const pricing = priceChainedJourney(
      exampleOne([
        BENI_SUEF_FROM_FAYOUM_CITY,
        stop({ capturedAt: "2026-10-18T15:00:00.000Z", legFrom: "stop", legFromPreviousKm: null, stopNumber: 3 }),
      ]),
    );
    assert.equal(pricing.mode, "chained", "Beni Suef → Beni Suef with no road distance still pays nothing, and the chain stands");
    assert.ok(!pricing.flags.includes("chain_unpriceable"));
  }

  // ── A departure photo in another governorate than the arrival is a drive nobody measured ──
  {
    const pricing = priceChainedJourney(
      exampleOne([{ ...BENI_SUEF_FROM_FAYOUM_CITY, governorate: "Fayoum", legFromGovernorate: "Giza" }]),
    );
    assert.ok(
      pricing.legs.some((leg) => leg.fromGovernorate === "Fayoum" && leg.toGovernorate === "Giza" && leg.reason === "distance_unknown"),
      "the arrival → departure drive is listed, with no road distance",
    );
    assert.equal(pricing.mode, "single_destination", "never priced on a guess");
    assert.ok(pricing.flags.includes("chain_unpriceable"));
    assert.ok(pricing.flags.includes("revisits_governorate"), "back to Fayoum after leaving from Giza is a return");
    assert.equal(priceChainedJourney(exampleOne()).legs.length, 3, "a departure photo in the arrival's own governorate adds no drive");
  }

  // ── A trip with no extra stop is priced exactly as before ──────────────────────────────────
  {
    const pricing = priceChainedJourney(exampleOne([]));
    assert.equal(pricing.mode, "single_destination");
    assert.equal(pricing.fuelAmount, 853.78, "237.16 × 2 × 1.8 — the fuel request 276 already carries");
    assert.equal(pricing.singleDestinationFuelAmount, 853.78);
    assert.deepEqual(pricing.legs, [], "no legs are invented for an ordinary trip");
    assert.deepEqual(pricing.flags, [], "and no flags");
  }

  // ── Example 1: Mallawi → Sinnuris → Beni Suef → Mallawi is a chain ─────────────────────────
  {
    const pricing = priceChainedJourney(exampleOne());
    assert.equal(pricing.mode, "chained");
    assert.equal(pricing.legs.length, 3, "home → arrival, Fayoum city → Beni Suef, Beni Suef → home");
    assert.match(pricing.legs[1].from, /^Fayoum$/, "the second drive starts where he left Fayoum");
    assert.deepEqual(
      pricing.legs.map((leg) => [leg.fromGovernorate, leg.toGovernorate, leg.distanceKm, leg.paid]),
      [
        ["Minya", "Fayoum", 237.16, true],
        ["Fayoum", "Beni Suef", 44.5, true],
        ["Beni Suef", "Minya", 194, true],
      ],
    );
    assert.equal(pricing.paidKm, 475.66);
    assert.equal(pricing.fuelAmount, 856.19, "each drive once, one way, × 1.8 — the owner's number");
    assert.equal(pricing.singleDestinationFuelAmount, 853.78, "the old figure travels beside it for the reviewer");
    assert.deepEqual(pricing.flags, [], "an honest chain raises nothing");
  }

  // ── Example 2: every stop after the first inside Assiut → today's rule ────────────────────
  {
    const pricing = priceChainedJourney({
      arrival: { capturedAt: "2026-10-20T07:00:00.000Z", distanceFromResidenceKm: 105.8, governorate: "Assiut" },
      fuelRatePerKm: 1.8,
      residenceGovernorate: "Minya",
      stops: [
        stop({
          capturedAt: "2026-10-20T10:00:00.000Z",
          governorate: "Assiut",
          legFromPreviousKm: 58.7,
          legFromPreviousMinutes: 70,
          returnHomeKm: 23.3,
          stopNumber: 2,
        }),
      ],
      tripEndDate: "2026-10-20",
      tripStartDate: "2026-10-20",
    });
    assert.equal(pricing.mode, "single_destination", "Dairut is inside Assiut: keep as today's rule");
    assert.equal(pricing.fuelAmount, 380.88, "105.8 × 2 × 1.8, exactly the old price");
    assert.equal(pricing.legs[1].reason, "same_governorate");
    assert.equal(pricing.legs[2].reason, "under_minimum_km", "Dairut → Mallawi is 23.3 km");
    assert.deepEqual(pricing.flags, []);
  }

  // ── A cross-governorate stop 40 km or nearer does not make a chain ──────────────────────────
  {
    const pricing = priceChainedJourney(exampleOne([stop({ legFromPreviousKm: 39, stopNumber: 2 })]));
    assert.equal(pricing.mode, "single_destination");
    assert.equal(pricing.fuelAmount, 853.78);
  }

  // ── Never priced on a guess ────────────────────────────────────────────────────────────────
  {
    const noGovernorate = priceChainedJourney(exampleOne([stop({ governorate: null, stopNumber: 2 })]));
    assert.equal(noGovernorate.mode, "single_destination");
    assert.equal(noGovernorate.fuelAmount, 853.78, "an unread governorate keeps the old price");
    assert.ok(noGovernorate.flags.includes("chain_unpriceable"), "and is flagged for a person");

    const noRoad = priceChainedJourney(exampleOne([stop({ returnHomeKm: null, stopNumber: 2 })]));
    assert.equal(noRoad.fuelAmount, 853.78, "an unread road distance keeps the old price");
    assert.ok(noRoad.flags.includes("chain_unpriceable"));
    assert.match(noRoad.flagReasons.join(" "), /road distance/);
  }

  // ── Abuse: ping-pong between two governorates ─────────────────────────────────────────────
  {
    const pricing = priceChainedJourney(
      exampleOne([
        stop({ capturedAt: "2026-10-18T09:00:00.000Z", stopNumber: 2 }),
        stop({
          capturedAt: "2026-10-18T12:00:00.000Z",
          governorate: "Fayoum",
          legFromPreviousKm: 44.5,
          returnHomeKm: 241.2,
          stopNumber: 3,
        }),
      ]),
    );
    assert.ok(pricing.flags.includes("revisits_governorate"), "Fayoum → Beni Suef → Fayoum is flagged");
    assert.equal(pricing.mode, "chained", "flagged, never refused — a person decides");
  }

  // ── Abuse: a stop reached faster than the road allows ─────────────────────────────────────
  {
    const pricing = priceChainedJourney(
      exampleOne([stop({ capturedAt: "2026-10-17T14:35:00.000Z", legFromPreviousMinutes: 58, stopNumber: 2 })]),
    );
    assert.ok(pricing.flags.includes("impossible_speed"), "12 minutes for a 58-minute drive");
    assert.ok(!pricing.flags.includes("stop_too_soon"), "12 minutes is past the 10-minute floor");
    assert.match(pricing.flagReasons.join(" "), /58 minutes/);
  }

  // ── Abuse: two photos at once ──────────────────────────────────────────────────────────────
  {
    const pricing = priceChainedJourney(
      exampleOne([stop({ capturedAt: "2026-10-17T14:28:00.000Z", legFromPreviousMinutes: null, stopNumber: 2 })]),
    );
    assert.ok(pricing.flags.includes("stop_too_soon"), "five minutes after the arrival photo");
  }

  // ── Abuse: a stop photographed before the arrival, or outside the trip's days ───────────────
  {
    const early = priceChainedJourney(exampleOne([stop({ capturedAt: "2026-10-17T10:00:00.000Z", stopNumber: 2 })]));
    assert.ok(early.flags.includes("stop_out_of_order"));
    const late = priceChainedJourney(exampleOne([stop({ capturedAt: "2026-10-19T09:00:00.000Z", stopNumber: 2 })]));
    assert.ok(late.flags.includes("stop_outside_trip_dates"), "19 Oct on a 17–18 Oct trip");
    // 23:30 UTC on the 18th is 02:30 on the 19th in Cairo — the CAIRO day decides.
    const cairoNextDay = priceChainedJourney(
      exampleOne([stop({ capturedAt: "2026-10-18T23:30:00.000Z", stopNumber: 2 })]),
    );
    assert.ok(cairoNextDay.flags.includes("stop_outside_trip_dates"), "the Cairo calendar day, not UTC");
  }

  // ── Abuse: a stop back in the home governorate ─────────────────────────────────────────────
  {
    const pricing = priceChainedJourney(
      exampleOne([stop({ governorate: "Minya", legFromPreviousKm: 200, returnHomeKm: 45, stopNumber: 2 })]),
    );
    assert.ok(pricing.flags.includes("stop_in_home_governorate"), "he may have gone home in between");
  }

  // ── Abuse: three governorate changes in one day ────────────────────────────────────────────
  {
    const pricing = priceChainedJourney(
      exampleOne([
        stop({ capturedAt: "2026-10-18T07:00:00.000Z", governorate: "Beni Suef", legFromPreviousKm: 60, stopNumber: 2 }),
        stop({ capturedAt: "2026-10-18T10:00:00.000Z", governorate: "Giza", legFromPreviousKm: 120, stopNumber: 3 }),
        stop({ capturedAt: "2026-10-18T13:00:00.000Z", governorate: "Qalyubia", legFromPreviousKm: 50, stopNumber: 4 }),
      ]),
    );
    assert.ok(pricing.flags.includes("too_many_governorates_in_a_day"));
  }

  // ── A chain far bigger than the trip it grew from is looked at ─────────────────────────────
  {
    const pricing = priceChainedJourney({
      ...exampleOne([stop({ governorate: "Alexandria", legFromPreviousKm: 300, returnHomeKm: 300, stopNumber: 2 })]),
      arrival: { capturedAt: "2026-10-17T14:23:00.000Z", distanceFromResidenceKm: 70, governorate: "Fayoum" },
    });
    assert.equal(pricing.mode, "chained");
    assert.ok(pricing.flags.includes("chain_large"), "670 km against a 140 km trip");
  }

  // ── The drive from the departure photo is timed from the departure photo ──────────────────
  {
    const pricing = priceChainedJourney(
      exampleOne([
        stop({
          capturedAt: "2026-10-18T11:29:00.000Z",
          legFrom: "departure",
          legFromCapturedAt: "2026-10-18T11:24:00.000Z",
          legFromGovernorate: "Fayoum",
          stopNumber: 2,
        }),
      ]),
    );
    assert.ok(pricing.flags.includes("stop_too_soon"), "five minutes after the departure photo, not a day after arrival");
    assert.ok(pricing.flags.includes("impossible_speed"));
  }

  // ── A weak or missing GPS fix on a stop ───────────────────────────────────────────────────
  {
    const weak = priceChainedJourney({ ...exampleOne([{ ...BENI_SUEF_FROM_FAYOUM_CITY, accuracyMeters: 350 }]), gpsAccuracyThresholdMeters: 100 });
    assert.ok(weak.flags.includes("stop_gps_inaccurate"));
    assert.match(weak.flagReasons.join(" "), /350 m/);
    const none = priceChainedJourney({ ...exampleOne([{ ...BENI_SUEF_FROM_FAYOUM_CITY, accuracyMeters: null }]), gpsAccuracyThresholdMeters: 100 });
    assert.ok(none.flags.includes("stop_gps_inaccurate"), "no accuracy at all is flagged too");
    const fine = priceChainedJourney({ ...exampleOne(), gpsAccuracyThresholdMeters: 100 });
    assert.ok(!fine.flags.includes("stop_gps_inaccurate"), "a 12 m fix is fine");
  }

  // ── Double pay: the same day filed as a separate trip, from both sides ────────────────────
  {
    const pricing = priceChainedJourney({ ...exampleOne(), otherCarTripsByDay: { "2026-10-18": [301] } });
    assert.ok(pricing.flags.includes("another_trip_same_day"), "a Beni Suef trip also filed for 18 Oct");
    assert.equal(pricing.flags[0], "another_trip_same_day", "and it is the first thing the approver reads");
    assert.match(pricing.flagReasons[0], /#301/);
    assert.deepEqual(journeyStopDays([BENI_SUEF_FROM_FAYOUM_CITY]), ["2026-10-18"]);
    const held = journeyOverlapHoldReason({
      journeys: [{ id: 276, stopDays: ["2026-10-18"] }],
      tripEndDate: "2026-10-18",
      tripStartDate: "2026-10-18",
    });
    assert.ok(held, "a NEW trip on a day a journey already reached is held");
    assert.match(String(held), /#276 \(2026-10-18\)/);
    assert.equal(
      journeyOverlapHoldReason({ journeys: [{ id: 276, stopDays: ["2026-10-18"] }], tripEndDate: "2026-10-20", tripStartDate: "2026-10-20" }),
      null,
      "another day is not held",
    );
  }

  // ── Where the next drive starts ────────────────────────────────────────────────────────────
  {
    const arrival = { capturedAt: "2026-10-17T14:23:00.000Z", latitude: 29.4074517, longitude: 30.8686217 };
    const departure = { capturedAt: "2026-10-18T11:24:00.000Z", latitude: 29.3214083, longitude: 30.857019 };
    assert.equal(
      pickJourneyLegOrigin({ arrival, departure, nowIso: "2026-10-18T13:00:00.000Z", stops: [] })?.kind,
      "departure",
      "with no stop yet, from the departure photo",
    );
    assert.equal(
      pickJourneyLegOrigin({ arrival, departure: null, nowIso: "2026-10-18T13:00:00.000Z", stops: [] })?.kind,
      "arrival",
    );
    assert.equal(
      pickJourneyLegOrigin({ arrival, departure, nowIso: "2026-10-18T13:00:00.000Z", stops: [BENI_SUEF_FROM_FAYOUM_CITY] })?.kind,
      "stop",
      "after a stop, from that stop",
    );
    assert.equal(
      pickJourneyLegOrigin({ arrival: { capturedAt: null, latitude: 0, longitude: 0 }, departure: null, nowIso: "2026-10-18T13:00:00.000Z", stops: [] }),
      null,
      "0,0 is no position",
    );
  }

  // ── Stored stops are read defensively — a broken entry is never priced ─────────────────────
  {
    const read = readJourneyStops(
      JSON.stringify([
        BENI_SUEF_FROM_FAYOUM_CITY,
        { ...BENI_SUEF_FROM_FAYOUM_CITY, stopNumber: 3, latitude: 0, longitude: 0 },
        { ...BENI_SUEF_FROM_FAYOUM_CITY, stopNumber: 4, photoPath: "" },
        { ...BENI_SUEF_FROM_FAYOUM_CITY, stopNumber: 1 },
        "junk",
      ]),
    );
    assert.deepEqual(read.map((entry) => entry.stopNumber), [2], "only the whole entry survives");
    assert.deepEqual(readJourneyStops(null), []);
    assert.deepEqual(readJourneyStops({ not: "an array" }), []);
    const pricing = priceChainedJourney(exampleOne());
    assert.equal(readJourneyPricing(JSON.parse(JSON.stringify(pricing)))?.fuelAmount, 856.19, "the snapshot round-trips");
    assert.equal(readJourneyPricing({ mode: "other" }), null);
  }

  // ── The claim moves by exactly the fuel's change ───────────────────────────────────────────
  {
    // Request 276 as filed: fuel 853.78 + allowance 325 = 1,178.78, claimed the same.
    const rebased = rebaseClaimOnNewFuel({
      claimedTotalAmount: 1178.78,
      expectedTotalAmount: 1178.78,
      expectedTotalFor: (travelCost) => travelCost + 325,
      fuelAmount: 853.78,
      newFuelAmount: 856.19,
      reportTravelCost: 853.78,
      ticketAmount: 0,
    });
    assert.deepEqual(rebased, {
      claimedTotalAmount: 1181.19,
      expectedTotalAmount: 1181.19,
      fuelAmount: 856.19,
      reportTravelCost: 856.19,
    });
    const notEligible = rebaseClaimOnNewFuel({
      claimedTotalAmount: 500,
      expectedTotalAmount: 0,
      expectedTotalFor: () => 0,
      fuelAmount: 300,
      newFuelAmount: 400,
      reportTravelCost: null,
      ticketAmount: 0,
    });
    assert.equal(notEligible.claimedTotalAmount, 500, "a not-eligible trip's claim does not grow with the fuel");
    // Its travel cost WOULD still grow here — which is why the capture never calls this for a
    // not-eligible trip at all (pinned in runCaptureGuardPins: `moneyMoves`).
  }

  // ── The approver always reads a chained journey in the queue ──────────────────────────────
  {
    const chained = priceChainedJourney(exampleOne());
    assert.equal(chained.flags.length, 0, "Example 1 is clean");
    const reason = withJourneyReason("Waiting for review.", chained);
    assert.ok(
      reason.startsWith("Waiting for review. Journey check: Priced as a chain of drives: 475.66 km paid one way, fuel 856.19"),
      `a clean chain still says it is a chain, with its price: ${reason}`,
    );
    assert.ok(reason.includes("home and back would be 853.78"), "and what home-and-back would have paid");
    assert.equal(withJourneyReason(reason, chained), reason, "re-pricing replaces the journey sentence, never stacks it");
    const single = priceChainedJourney(exampleOne([]));
    assert.equal(withJourneyReason(reason, single), "Waiting for review.", "a journey with nothing to say leaves no trace");
    assert.ok(
      withJourneyReason(null, single, ["The trip is not eligible."]).endsWith("Journey check: The trip is not eligible."),
      "an extra sentence rides in the same group",
    );
  }

  runCaptureGuardPins();
}

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

/**
 * The capture's anti-abuse rules live in service.ts, which reads Google and Supabase and cannot run
 * here, so its ORDER is pinned in the source: who may add a stop, when, and that nothing is stored
 * before the photo is proven to carry a position (owner, 2026-10-18: "make sure that no one abuses it").
 */
function runCaptureGuardPins() {
  const service = source("src/lib/outstation/service.ts");
  const start = service.indexOf("export async function captureOutstationJourneyStop(");
  assert.ok(start > 0, "captureOutstationJourneyStop is the one way a stop is written");
  const end = service.indexOf("\nexport ", start + 10);
  const capture = service.slice(start, end > 0 ? end : undefined);
  const at = (needle: string) => {
    const index = capture.indexOf(needle);
    assert.ok(index > 0, `the stop capture must still contain: ${needle}`);
    return index;
  };
  const upload = at("await uploadOutstationJourneyStopImage(");
  for (const guard of [
    'throw forbiddenError("A stop can only be added by the employee on the trip.")',
    'request.expenseType !== "traveling"',
    "isJourneyStopOpen(request.status, request.employeeRole)",
    "isOutstationExpenseInPayroll(linkedPayroll)",
    "isWithinDepartureWindow({ capturedAt, tripEndDate: request.tripEndDate })",
    "existingStops.length >= MAX_JOURNEY_STOPS",
    "throw new Error(JOURNEY_STOP_LOCATION_REQUIRED_MESSAGE)",
  ]) {
    assert.ok(at(guard) < upload, `${guard} must be checked BEFORE the stop photo is stored`);
  }
  assert.ok(
    at("const capturedAt = new Date().toISOString();") < upload,
    "the capture time is the server's clock, never the phone's",
  );
  // The claim write is shared with a system administrator's missed stop (2026-11-03), so its guards
  // are read in writeJourneyStopToClaim, and the capture must reach it only after the photo is stored.
  assert.ok(at("await writeJourneyStopToClaim({") > upload, "the claim is written after the stop photo is stored");
  const writerStart = service.indexOf("async function writeJourneyStopToClaim(");
  assert.ok(writerStart > 0, "writeJourneyStopToClaim is the one write of a stop onto its claim");
  const writer = service.slice(writerStart, service.indexOf("\n/**", writerStart + 10));
  const inWriter = (needle: string) => {
    const index = writer.indexOf(needle);
    assert.ok(index > 0, `the stop's claim write must still contain: ${needle}`);
    return index;
  };
  inWriter('.eq("updated_at", (token as { updated_at: string }).updated_at)');
  inWriter('.in("status", journeyStopWriteStatuses(request.employeeRole))');
  inWriter("withJourneyReason(request.approvalReason, pricing, [...notEligibleNote, ...adminAddedStopNotes(stops)])");
  // A not-eligible trip keeps its money exactly; the chain is only recorded and explained.
  assert.ok(inWriter('const moneyMoves = request.eligibilityStatus !== "not_eligible";') < inWriter("...rebaseClaimOnNewFuel({"));
  // Every governorate is Google's reading of a GPS position — never the label the phone posted.
  // The measurement lives in measureJourneyStop, shared with a test account's rehearsal
  // (2026-11-03), so the capture must go through it and the helper is held to the same rule.
  assert.ok(at("await measureJourneyStop({") < upload, "the stop is measured before its photo is stored");
  const measureStart = service.indexOf("async function measureJourneyStop(");
  assert.ok(measureStart > 0, "measureJourneyStop is the one measurement of a stop");
  const measure = service.slice(measureStart, service.indexOf("\nasync function ", measureStart + 10));
  for (const body of [capture, measure]) {
    assert.ok(!body.includes("capturedLocationLabel"), "no governorate may be read from a posted location label");
    assert.ok(!body.includes("resolveGovernorate("), "governorates come from reverse geocodes only");
  }
  assert.ok(
    measure.includes("readGovernorate({ lat: origin.latitude, lng: origin.longitude })"),
    "the departure origin's governorate is read from its position",
  );
  // The submit-side double-pay check HOLDS on a failed read; it never refuses the submission.
  const overlapRead = service.indexOf("journeys: await journeysWithStopsForEmployee(calculation.employeeHrId)");
  const overlapCatch = service.indexOf('labels: { event: "outstation_journey_overlap_read_failed" }');
  assert.ok(overlapRead > 0 && overlapCatch > overlapRead, "the submit-side overlap read has its catch");
  assert.ok(
    service.lastIndexOf("try {", overlapRead) > service.lastIndexOf("let journeyOverlapReason", overlapRead),
    "the overlap read sits inside its try",
  );
  inWriter("await writeRequiredAuditLog(");
  assert.ok(!capture.includes("upsert: true"), "a stop photo is never overwritten");

  const route = source("app/api/outstation/[id]/journey-stop/route.ts");
  assert.ok(route.includes("assertSameOriginMutation(request)"), "the stop route keeps its CSRF check");
  assert.ok(route.includes('assertPermission(access, "outstation", "create")'), "the stop route checks the permission");
  assert.ok(!route.includes("Number(body.latitude)"), "Number(null) is 0 — a no-fix photo would land at 0,0");

  const route2 = source("app/api/outstation/[id]/journey-stop/route.ts");
  assert.ok(!route2.includes("flagReasons"), "the flag wording is the approver's — never returned to the employee");
  const card = source("src/components/outstation/journey-stop-card.tsx");
  assert.ok(card.includes("maximumAge: 0"), "the stop camera takes a FRESH fix at the shutter");
  // The only file input is the ticket's: the photo is camera only, a gallery picture proves nothing.
  assert.equal(card.split('type="file"').length, 2, "one file input, the ticket's");
  assert.ok(
    card.indexOf('{rule.ticket !== "none" ? (') < card.indexOf('type="file"') &&
      card.indexOf('type="file"') < card.indexOf("{rule.photo ? ("),
    "it sits inside the ticket block, never beside the camera",
  );
}
