import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  buildFieldActivityReport,
  cairoWallClockIso,
  eachDateIso,
  haversineMetres,
  isWeekendIso,
  minutesOfDay,
  wallClock,
  weekdayOf,
  type FieldActivityCheckinRow,
  type FieldActivityLeaveRow,
  type FieldActivityOwnVisitRow,
  type FieldActivitySubject,
  type FieldActivityTripRow,
  type FieldActivityVisitRow,
} from "../src/lib/field-activity/model.ts";
import {
  bidi,
  buildFieldActivityDocument,
  clock12,
  tidyAddress,
} from "../src/lib/field-activity/document.ts";
import { stripComments } from "./support/comment-strip.ts";
import { defaultPeriod, resolvePeriod, MAX_PERIOD_DAYS } from "../src/lib/field-activity/period.ts";
import { FIELD_ACTIVITY_ROLES, isFieldActivityRole } from "../src/lib/field-activity/access.ts";
import { getNavigationSections } from "../src/config/system-navigation.ts";
import { isPortalShellRole } from "../src/lib/auth/portal-shell-roles.ts";
import { resolvePortalTwin } from "../src/lib/navigation/portal-twins.ts";
import { fetchBasemap, fitZoom, renderRouteSvg } from "../src/lib/field-activity/map.ts";

const SUBJECT: FieldActivitySubject = {
  areaName: null,
  hrId: "B-155",
  jobTitle: "Product Manager",
  lineName: "Pedia",
  name: "A Product Manager",
  regionName: null,
};

function visit(overrides: Partial<FieldActivityVisitRow> = {}): FieldActivityVisitRow {
  return {
    agentCrmId: 1397,
    agentHrId: "B-100",
    agentName: "A Medical Rep",
    ampm: "PM",
    comment: null,
    contactCrmId: 500,
    contactGrade: "A",
    contactName: "A Doctor",
    doubleHrId: "B-155",
    doubleName: "A Product Manager",
    double2HrId: null,
    double2Name: null,
    savedAt: "2026-09-20 15:20:54+00",
    speciality: "Pediatrics",
    visitDate: "2026-09-20",
    visitType: 0,
    visitTypeDescription: "Regular Visit",
    ...overrides,
  };
}

function checkin(overrides: Partial<FieldActivityCheckinRow> = {}): FieldActivityCheckinRow {
  return {
    address: "A street, A city, Egypt 1234567",
    agentCrmId: 1397,
    agentHrId: "B-100",
    checkedAt: "2026-09-20 14:03:52+00",
    contactCrmId: 500,
    contactName: "A Doctor",
    lat: 30.4655,
    lon: 31.1791,
    ...overrides,
  };
}

function run(input: Partial<Parameters<typeof buildFieldActivityReport>[0]> = {}) {
  return buildFieldActivityReport({
    checkins: [],
    fromIso: "2026-09-20",
    leave: [],
    punches: [],
    subject: SUBJECT,
    toIso: "2026-09-20",
    trips: [],
    visits: [],
    ...input,
  });
}

/**
 * Field Activity — the rules that make the report true rather than merely populated.
 *
 * Every assertion below stands for a wrong answer that was produced by hand on production data
 * while the first report was assembled, on 2026-09-28.
 */
export async function runFieldActivityReportTests() {
  // ── a check-in is not a log, and the gap is carried ──────────────────────────────────────────
  {
    const report = run({ visits: [visit()], checkins: [checkin()] });
    const day = report.days[0];
    assert.equal(day.stops.length, 1, "a visit with a matching fix becomes a stop");
    assert.equal(day.stops[0].checkedAt, "14:03:52", "the check-in is the door");
    assert.equal(day.stops[0].savedAt, "15:20:54", "the log is a separate clock");
    assert.equal(day.stops[0].logLagMinutes, 77, "the gap between the two is what the report reports");
    assert.equal(day.firstCheckin, "14:03:52", "the GPS window opens at the first fix, never at the first log");
  }

  // ── THE VENDOR CLOCK IS ALREADY CAIRO — nothing here may shift it ────────────────────────────
  {
    // Read as stored: converting this to Africa/Cairo would say 17:03 and report a 3-hour-late day.
    assert.equal(wallClock("2026-09-20 14:03:52+00"), "14:03:52", "a +00 vendor stamp keeps its clock reading");
    assert.equal(wallClock("2026-09-20T14:03:52"), "14:03:52", "a zone-less vendor stamp keeps its clock reading");
    assert.equal(minutesOfDay("14:03:52"), 843, "minutes come off the same unshifted reading");
  }

  // ── …AND THE ONE REAL INSTANT ON THE PAGE IS CONVERTED, EXACTLY ONCE ─────────────────────────
  {
    // The outstation claim's own GPS fix is a true timestamptz, not a vendor wall clock. Read like
    // one it prints 2-3 hours early beside correct Cairo visit times on the same page — the owner's
    // 2026-10-05 report. Measured on production: B-1's 2026-10-04 fix, 18:34:51Z, is 21:34 Cairo.
    assert.equal(
      cairoWallClockIso("2026-10-04T18:34:51.014+00:00"),
      "2026-10-04T21:34:51",
      "summer time: a real instant becomes the Cairo wall clock, +03:00",
    );
    assert.equal(
      cairoWallClockIso("2026-01-15T18:34:51+00:00"),
      "2026-01-15T20:34:51",
      "winter: the offset is read per instant, never hardcoded — Egypt observes DST",
    );
    assert.equal(
      cairoWallClockIso("2026-10-04T22:30:00+00:00"),
      "2026-10-05T01:30:00",
      "the Cairo calendar day comes with it, so a late fix cannot land on the wrong day",
    );
    assert.equal(cairoWallClockIso(null), null, "no fix stays no fix");
    assert.equal(cairoWallClockIso("not a time"), null, "an unparseable value is refused, never rendered");
    // It carries no zone, so nothing downstream can mistake it for an instant and shift it twice.
    assert.doesNotMatch(String(cairoWallClockIso("2026-10-04T18:34:51Z")), /[Z+]/, "the result is zone-less by construction");
    // The two places that render it, both reading the one convention.
    assert.equal(clock12(cairoWallClockIso("2026-10-04T18:34:51+00:00")), "9:34 PM", "the document prints the Cairo clock");
    assert.equal(String(cairoWallClockIso("2026-10-04T18:34:51+00:00")).slice(11, 16), "21:34", "so does the PDF map label");
    // The loader must keep doing the conversion — the defect was a raw passthrough here.
    const loaderSource = readFileSync("src/lib/field-activity/report.ts", "utf8");
    assert.match(
      loaderSource,
      /capturedAt: cairoWallClockIso\(record\.captured_at as string \| null\)/,
      "the outstation GPS fix is converted at the loader, never handed on as a raw instant",
    );
  }

  // ── a call logged the NEXT morning is a positive lag, never a negative one ───────────────────
  {
    const report = run({
      visits: [visit({ savedAt: "2026-09-21 10:00:57+00" })],
      checkins: [checkin({ checkedAt: "2026-09-20 16:20:49+00" })],
    });
    const stop = report.days[0].stops[0];
    assert.equal(stop.savedOn, "2026-09-21", "the report says which day the log landed on");
    assert.equal(stop.logLagMinutes, 1060, "a next-morning log is 17h40 after the door, not minus six hours");
    assert.equal(report.days[0].logsLandedNextDay, true, "a day logged entirely the next day says so");
  }

  // ── A MANAGER'S ROUTE IS THE REP'S FIXES, AND ONLY FOR THE CALLS HE IS TAGGED ON ─────────────
  {
    const report = run({
      visits: [visit()],
      checkins: [
        // The rep's own round, FIRST in the array on purpose: a match that keys on the phone and the
        // day but not the customer would attach this one and put the manager somewhere he never was.
        checkin({ contactCrmId: 999, contactName: "Somebody else", checkedAt: "2026-09-20 08:10:00+00", lat: 30.45, lon: 31.18 }),
        checkin(),
        checkin({ contactCrmId: 998, contactName: "Somebody else again", checkedAt: "2026-09-20 19:22:40+00", lat: 30.44, lon: 31.17 }),
      ],
    });
    assert.equal(report.days[0].stops.length, 1, "the partner's solo stop never joins the manager's route");
    assert.equal(report.days[0].lastCheckin, "14:03:52", "so his day does not appear to run to 7:22 PM");
  }

  // ── the EARLIEST fix at a door is the arrival ────────────────────────────────────────────────
  {
    const report = run({
      visits: [visit()],
      checkins: [checkin({ checkedAt: "2026-09-20 13:34:39+00" }), checkin({ checkedAt: "2026-09-20 13:39:40+00" })],
    });
    assert.equal(report.days[0].stops[0].checkedAt, "13:34:39", "a re-check-in at the same door does not move the arrival later");
  }

  // ── AM · PM · PHARMACIES, three apart, and a pharmacy is never a PM doctor ───────────────────
  {
    const report = run({
      visits: [
        visit({ ampm: "AM", contactCrmId: 1, speciality: "Hospital" }),
        visit({ ampm: "PM", contactCrmId: 2, speciality: "ENT" }),
        visit({ ampm: "PM", contactCrmId: 3, speciality: "Pharmacy" }),
      ],
    });
    const day = report.days[0];
    assert.deepEqual(
      { am: day.counts.am, pharmacies: day.counts.pharmacies, pm: day.counts.pm },
      { am: 1, pharmacies: 1, pm: 1 },
      "a pharmacy tagged PM is counted as a pharmacy, never inside PM",
    );
    assert.equal(day.countedTotal, 3, "every counted visit lands in exactly one bucket");
  }

  // ── a Traveling record is not a customer call ────────────────────────────────────────────────
  {
    const report = run({
      visits: [visit({ ampm: "AM", agentHrId: "B-155", doubleHrId: null, contactCrmId: null, contactName: null, visitType: -12, visitTypeDescription: "Traveling", comment: "Shebeen El Kom" })],
    });
    const day = report.days[0];
    assert.equal(day.countedTotal, 0, "a Traveling record counts in nothing");
    assert.equal(day.unlocated.length, 1, "but it is still reported, with its own label");
    assert.equal(day.unlocated[0].counts, false, "and it is marked as not counting");
  }

  // ── a call saved with no contact attached still counts, and BORROWS NO GPS ───────────────────
  //
  // `0` is the vendor's "no contact" placeholder and NULL is an unresolved one. Keyed without a
  // real-contact guard, every contact-less row of one agent on one day lands on ONE key — so a
  // contact-less CALL would take the coordinates and the time of a contact-less CHECK-IN made
  // somewhere else entirely, and be drawn on the map as a stop it can prove nothing about. The
  // check-in below is deliberately hours later and 30 km away.
  {
    const strayFix = checkin({ checkedAt: "2026-09-20 19:40:00+00", contactCrmId: 0, contactName: null, lat: 30.79, lon: 30.99 });
    const report = run({
      checkins: [strayFix],
      visits: [visit({ ampm: "AM", contactCrmId: 0, contactName: null })],
    });
    assert.equal(report.days[0].counts.am, 1, "a regular call with no contact is still a call he made");
    assert.equal(
      report.days[0].stops.length,
      0,
      "it carries no GPS fix — and must never inherit an unrelated contact-less check-in's coordinates, which is what a key that lets 0 and NULL match itself would do",
    );
    assert.equal(report.days[0].unlocated.length, 1, "it is reported as a call without a fix, not silently dropped");

    // The same guard on the CHECK-IN side: a real call is not matched by a contact-less fix either.
    const realCall = run({
      checkins: [strayFix],
      visits: [visit({ ampm: "AM" })],
    });
    assert.equal(realCall.days[0].stops.length, 0, "a contact-less fix never answers for a call at a real contact");
  }

  // ── AN EMPTY DAY IS NOT AN IDLE DAY ──────────────────────────────────────────────────────────
  {
    const week = run({ fromIso: "2026-09-20", toIso: "2026-09-25" });
    assert.equal(week.days.length, 6, "every day in the period gets a page, worked or not");
    assert.equal(week.days[5].kind, "weekend", "Friday with no record is the weekend, never an absence");
    assert.equal(week.days[0].kind, "empty", "a working day with nothing at all is named as such");

    const withPunch = run({ punches: [{ count: 2, dateIso: "2026-09-20", firstTime: "09:10:00", lastTime: "17:01:00" }] });
    assert.equal(withPunch.days[0].kind, "office", "a fingerprint punch makes it a head-office day, not an empty one");

    const onLeave = run({
      leave: [{ balanceAfter: 5.25, balanceBefore: 6.25, dayPart: "full_day", endDate: "2026-09-20", hrDecisionAt: null, managerDecisionAt: null, managerName: "A Manager", paymentStatus: "paid", reference: "VAC-0558", startDate: "2026-09-20", status: "approved", submittedAt: null, type: "emergency" }],
    });
    assert.equal(onLeave.days[0].kind, "leave", "approved leave is named, never read as doing nothing");
  }

  // ── a visit recorded on a day of approved leave is FLAGGED, never quietly counted ────────────
  {
    const report = run({
      visits: [visit()],
      checkins: [checkin()],
      leave: [{ balanceAfter: null, balanceBefore: null, dayPart: "full_day", endDate: "2026-09-20", hrDecisionAt: null, managerDecisionAt: null, managerName: null, paymentStatus: "paid", reference: "VAC-0558", startDate: "2026-09-20", status: "approved", submittedAt: null, type: "emergency" }],
    });
    assert.equal(report.days[0].kind, "leave", "the leave wins the day's label");
    assert.equal(report.flags.length, 1, "and the contradiction is raised to the top of the report");
    assert.match(report.flags[0].message, /approved/, "the flag says what the contradiction is");
  }

  // ── the partner's own calls are context, counted nowhere ─────────────────────────────────────
  {
    const report = run({
      visits: [visit()],
      checkins: [checkin()],
      partnerVisits: [visit({ doubleHrId: null, doubleName: null, contactCrmId: 77 }), visit({ doubleHrId: null, doubleName: null, contactCrmId: 78 })],
    });
    assert.equal(report.days[0].partnerSoloCalls, 2, "the rep's solo calls are reported");
    assert.equal(report.days[0].countedTotal, 1, "and counted in nothing");
  }

  // ── movement between stops ───────────────────────────────────────────────────────────────────
  {
    const report = run({
      visits: [visit({ contactCrmId: 1 }), visit({ contactCrmId: 2, savedAt: "2026-09-20 15:30:00+00" })],
      checkins: [
        checkin({ contactCrmId: 1, checkedAt: "2026-09-20 10:38:31+00", lat: 30.4729062, lon: 31.1810655 }),
        checkin({ contactCrmId: 2, checkedAt: "2026-09-20 10:44:58+00", lat: 30.4704032, lon: 31.1779142 }),
      ],
    });
    const day = report.days[0];
    assert.equal(day.stops[0].legMetres, null, "the first stop has no leg");
    assert.ok(day.stops[1].legMetres != null && day.stops[1].legMetres > 300 && day.stops[1].legMetres < 500, "a real leg is measured, not guessed");
    assert.equal(day.movementMetres, day.stops[1].legMetres, "the day's movement is the sum of its legs");
    assert.equal(day.stops[0].index, 1, "stops are numbered in check-in order");
  }

  // ── the scope of the whole report ────────────────────────────────────────────────────────────
  {
    const report = run({
      fromIso: "2026-09-20",
      toIso: "2026-09-22",
      visits: [visit(), visit({ visitDate: "2026-09-22", contactCrmId: 9, savedAt: "2026-09-22 20:07:53+00" })],
      checkins: [checkin(), checkin({ contactCrmId: 9, checkedAt: "2026-09-22 16:16:32+00" })],
      trips: [{ allowance: 125, approvedTotal: null, capturedAccuracyMeters: 12, capturedAt: "2026-09-22 16:30:00+00", capturedLat: 30.56, capturedLon: 31.0084, claimedTotal: 525, destination: "Shebeen El Kom", distanceKm: 111.11, durationMinutes: 116, eligibility: "eligible", evidenceGate: "pending_arrival_photo", fuel: 400, meeting: 0, minimumKm: 60, other: 0, recommendation: "manager_review", reference: "OUTSTATION-173", status: "submitted", submittedAt: "2026-09-22 16:31:00+00", tickets: 0, transport: "car", tripDate: "2026-09-22", workload: { am: 0, pharmacies: 0, pm: 0 }, workloadGate: "pending_workload" }],
    });
    assert.equal(report.totals.fieldDays, 2, "both field days are counted");
    assert.equal(report.totals.stops, 2, "every stop is counted once");
    assert.equal(report.totals.claimedTotal, 525, "the money is the claims' own total");
    assert.equal(report.totals.tripCount, 1, "and the trips are counted");
    const tripDay = report.days.find((day) => day.dateIso === "2026-09-22");
    assert.ok(tripDay?.notes.some((note) => note.includes("before the day's calls were logged")), "a claim that asked before the evidence existed says so");
  }

  // ── date helpers ─────────────────────────────────────────────────────────────────────────────
  {
    assert.equal(weekdayOf("2026-09-20"), "Sunday", "20 September 2026 is a Sunday");
    assert.equal(isWeekendIso("2026-09-25"), true, "Friday is the Egyptian weekend");
    assert.equal(isWeekendIso("2026-09-26"), false, "Saturday is a working day here");
    assert.equal(eachDateIso("2026-09-20", "2026-09-22").length, 3, "a period includes both of its ends");
    assert.equal(haversineMetres({ lat: 30.4729062, lon: 31.1810655 }, { lat: 30.4729062, lon: 31.1810655 }), 0, "the same point is no distance at all");
  }

  // ── the period guard ─────────────────────────────────────────────────────────────────────────
  {
    assert.equal(resolvePeriod("2026-09-20", "2026-09-25").ok, true, "a normal week is accepted");
    assert.equal(resolvePeriod("2026-09-25", "2026-09-20").ok, false, "a period that ends before it starts is refused");
    assert.equal(resolvePeriod("not-a-date", "2026-09-20").ok, false, "a malformed date is refused, never coerced");
    assert.equal(resolvePeriod("2026-01-01", "2026-12-31").ok, false, `a period beyond ${MAX_PERIOD_DAYS} days is refused rather than timing out`);
    const wide = resolvePeriod("2026-01-01", "2026-12-31");
    assert.ok(!wide.ok && wide.reason.includes(String(MAX_PERIOD_DAYS)), "and the refusal names the cap");
    const week = defaultPeriod("2026-09-28");
    assert.equal(week.fromIso, "2026-09-20", "the page opens on the last full week, Sunday first");
    assert.equal(week.toIso, "2026-09-26", "six days later");
  }

  // ── 🔴 THE MEDICAL REP IS NOT IN THIS MODULE (CRM golden rule #1 — his app is blind) ─────────
  {
    assert.equal(isFieldActivityRole("Medical Rep"), false, "a rep never reaches the report that measures him");
    assert.equal(isFieldActivityRole("District Manager"), true, "his DM does");
    assert.equal(isFieldActivityRole("Regional Manager"), true, "his RM does");
    assert.equal(isFieldActivityRole("National Sales Manager"), true, "his NSM does");
    assert.equal(isFieldActivityRole("SFE Manager"), true, "the SFE Manager does");
    assert.equal(isFieldActivityRole("Finance Manager"), false, "a seat with no field business does not");
    assert.ok(!FIELD_ACTIVITY_ROLES.includes("Medical Rep" as never), "and the rep is absent from the list itself");
  }

  // ── the document's text handling ─────────────────────────────────────────────────────────────
  {
    assert.equal(clock12("15:20:54"), "3:20 PM", "the sheet prints a 12-hour clock from the unshifted reading");
    assert.equal(clock12("2026-09-20 09:05:00"), "9:05 AM", "a full timestamp prints the same way");
    assert.equal(tidyAddress("F5FJ+5GW, Qism Banha, Banha 2, Al-Qalyubia Governorate 6470154, Egypt"), "F5FJ+5GW, Qism Banha, Banha 2, Al-Qalyubia Governorate", "the country and the postal number carry nothing the coordinates do not");
    // Direction per RUN: a mixed address keeps its Latin parts in order and its punctuation at the
    // right end — wrapping the whole line in dir="rtl" is the bug this replaced.
    const mixed = bidi("شرف, ش Gamal Abd El-Nasir");
    assert.ok(mixed.includes('dir="rtl"') && mixed.includes('dir="ltr"'), "each run gets its own direction");
    assert.ok(!/dir="rtl"[^<]*Gamal/.test(mixed), "the Latin run is never swept into the Arabic one");
  }

  // ── the map fits what it is given ────────────────────────────────────────────────────────────
  {
    const points = [
      { kind: "stop" as const, label: "1", lat: 30.4729062, lon: 31.1810655 },
      { kind: "stop" as const, label: "2", lat: 30.4631374, lon: 31.1809237 },
    ];
    const zoom = fitZoom(points, 1500, 640);
    assert.ok(zoom >= 14 && zoom <= 18, "a city-scale day picks a street-level zoom");
    const svg = renderRouteSvg({ basemap: null, height: 640, points, width: 1500, zoom });
    assert.ok(svg.startsWith("<svg"), "the map is one self-contained SVG");
    assert.ok(svg.includes("<polyline"), "the route between stops is drawn");
    assert.ok(svg.includes("<rect"), "and the markers are SQUARE — the house rule has no round corners");
    assert.ok(!svg.includes("<circle cx") || svg.includes("leader"), "a circle appears only as a leader-line anchor");
    assert.ok(svg.includes("Street basemap unavailable"), "without a maps key the sheet says so rather than pretending");
  }

  // ── a refused basemap is RECORDED, not only swallowed ────────────────────────────────────────
  //
  // 🔴 THE DEFECT. `fetchBasemap` returns null on every failure, which is correct — a map is worth
  // having and never worth failing an export for. But null was the ONLY signal it produced, so "no
  // key configured", "key refused", "API not enabled" and "Google timed out" were one
  // indistinguishable outcome and nothing anywhere said which. Measured on production 2026-10-06:
  // the server key answers Geocoding and Routes with 200 and the Maps Static API with 403, "This
  // API is not activated on your API project" — so every exported route map printed without
  // streets, and the only trace of the reason was a sentence Google sent that the code threw away.
  //
  // Pinned on BOTH failure paths, because the catch swallowed just as silently as the status check.
  {
    const refusal = "This API is not activated on your API project.";
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      const refused = await fetchBasemap({
        apiKey: "test-key-not-a-real-credential",
        centre: { lat: 30.47, lon: 31.18 },
        fetchImpl: (async () => new Response(refusal, { status: 403 })) as unknown as typeof fetch,
        height: 640,
        width: 1500,
        zoom: 14,
      });
      assert.equal(refused, null, "a refused basemap still returns null — the export must not fail for a map");
      assert.ok(
        warnings.some((line) => line.includes("403") && line.includes("not activated")),
        "the refusal names the HTTP status AND Google's own reason, which is the whole diagnosis",
      );

      // The key travels as a URL parameter, so a verbatim log of the url or of Google's echo would
      // put a live credential in the log. Nothing logged may contain it.
      assert.ok(
        !warnings.some((line) => line.includes("test-key-not-a-real-credential")),
        "the api key is stripped from everything logged — a basemap failure must never leak a credential",
      );

      warnings.length = 0;
      const threw = await fetchBasemap({
        apiKey: "test-key-not-a-real-credential",
        centre: { lat: 30.47, lon: 31.18 },
        fetchImpl: (async () => {
          throw new Error("fetch failed");
        }) as unknown as typeof fetch,
        height: 640,
        width: 1500,
        zoom: 14,
      });
      assert.equal(threw, null, "a thrown request returns null too");
      assert.ok(
        warnings.some((line) => line.includes("fetch failed")),
        "a timeout that leaves no trace is how this stayed unexplained — the throw is recorded on its way to null",
      );

      warnings.length = 0;
      const noKey = await fetchBasemap({
        apiKey: null,
        centre: { lat: 30.47, lon: 31.18 },
        height: 640,
        width: 1500,
        zoom: 14,
      });
      assert.equal(noKey, null, "no key still returns null");
      assert.ok(
        warnings.some((line) => line.includes("GOOGLE_MAPS_SERVER_KEY")),
        "an unset key names the variable, so it is never confused with a key the platform refused",
      );
    } finally {
      console.warn = realWarn;
    }
  }

  // ── EVERY ROLE IT NAMES CAN ACTUALLY REACH IT ────────────────────────────────────────────────
  //
  // 🔴 THE DEFECT THIS EXISTS FOR. The module shipped with ONE page, under /admin/, and its only
  // catalog row in the PORTAL seeds pointing at that /admin/ address. `app/(admin)/layout.tsx`
  // redirects every portal-mode viewer out of the admin route group before any page in it runs, so
  // five of the module's eight roles — District Manager, Regional Manager, National Sales Manager,
  // Product Manager, Group Product Manager — could neither see the row nor reach the page by typing
  // the address. Every unit test passed, the API was correct, the gate was correct, and the module
  // was invisible to the people it was built for. The owner found it: "I CANNOT SEE IT IN NSM
  // SIDEBAR?".
  //
  // A permission is not reach. This asserts reach, per role, from the real catalogs.
  {
    const rows = (mode: "admin" | "employee-portal") =>
      getNavigationSections(mode)
        .flatMap((section) => section.items)
        .filter((item) => item.label === "Field Activity");

    for (const role of FIELD_ACTIVITY_ROLES) {
      const portalSeat = isPortalShellRole(role);
      const mode = portalSeat ? "employee-portal" : "admin";
      const offered = rows(mode).filter(
        (item) => (!item.roles || item.roles.includes(role)) && !(item.excludedRoles ?? []).includes(role),
      );
      assert.equal(
        offered.length >= 1,
        true,
        `${role} holds Field Activity but is offered no row in the ${mode} catalog — a grant with no way in is what shipped in #4647`,
      );
      // The half that actually bit: the shell of the href must match the shell the role renders.
      for (const item of offered) {
        assert.equal(
          item.href.startsWith(portalSeat ? "/employee-portals/" : "/admin/"),
          true,
          `${role} renders the ${mode} shell, so its Field Activity row must not point at ${item.href} — the (admin) layout redirects a portal seat away from /admin/** before the page runs`,
        );
      }
    }

    // And no row anywhere may hand a portal seat an admin address.
    for (const item of rows("employee-portal")) {
      assert.equal(item.href.startsWith("/admin/"), false, "the portal catalog must never carry an /admin/ href for this module");
    }

    // A viewer who follows an admin link lands on the module, not on the portal home.
    assert.equal(
      resolvePortalTwin("/admin/field-activity", "National Sales Manager"),
      "/employee-portals/field-activity",
      "an NSM following a link to the admin address must be forwarded to the portal half, not dropped on the portal home",
    );

    // The portal RAIL is built by hand and reads neither catalog — a row in the seeds alone is
    // exactly how Early Birds became URL-only. Pin the rail's own row and its flag.
    const rail = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
    assert.match(
      rail,
      /showFieldActivityTab \? \[\{ href: "\/employee-portals\/field-activity"/,
      "buildEmployeePortalSections must carry the Field Activity row — the portal sidebar is built here, not from system-navigation.ts",
    );
    const flags = readFileSync("src/lib/employee-portal/navigation.ts", "utf8");
    assert.match(flags, /showFieldActivityTab:/, "the rail's flag must be resolved for the portal roles");
  }

  // ── the loader's source contract ─────────────────────────────────────────────────────────────
  // The loader is the one layer no unit test can execute, so what it must NOT do is pinned here.
  // This module already broke the door rule once: it queried crm_visits_unified directly and CI
  // caught it. Pinning the contract means the next edit is caught at the seam, not by a red merge.
  {
    const loader = readFileSync("src/lib/field-activity/report.ts", "utf8");
    assert.match(loader, /from "@\/lib\/crm\/reads"/, "the CRM mirror is read through its one door");
    assert.doesNotMatch(loader, /@\/lib\/crm\/tables/, "the loader must not import the mirror table constants");
    assert.doesNotMatch(
      loader,
      /\.from\(\s*CRM_(?:VISITS|CHECKINS)_UNIFIED_VIEW/,
      "no consumer may query the unified views itself — src/lib/crm/reads.ts is the door",
    );
    // Both visit reads collapse iReports360's burst-duplicate saves, so a re-saved stop counts once
    // here exactly as it does on Field Workforce Compliance and in Double Visit Analytics. Without
    // it this page and the screen the owner compares it against would report different days.
    assert.equal(
      (loader.match(/collapseDoubleVisits: true,/g) ?? []).length,
      2,
      "both the subject's visits and the partners' own calls go through the canonical duplicate collapse",
    );
    // The opt-out is deliberate and must stay VISIBLE: the agent on these rows is whose phone
    // recorded the day, displayed from the row's own name, never trusted as a current employee.
    assert.equal(
      (loader.match(/includeResignedAgents: true,/g) ?? []).length,
      3,
      "every CRM read states its resigned-agent position explicitly rather than inheriting one",
    );
  }

  // ── the report speaks about anyone, so no masculine default ──────────────────────────────────
  // Found on 2026-10-05 on a District Sales Manager's own page: the report called her "he" in six
  // places and her outstation claim "His own phone fix". Measured on production the same day, the
  // people this report can be run on are 88 women, 87 men and 31 with no gender recorded — so the
  // masculine default was wrong for a MAJORITY of its own subjects, and reading the recorded
  // gender instead would still have no answer for 31 of them. Neutral wording is the only form
  // that is correct for every subject, which is why this is a ban and not a lookup.
  {
    const MASCULINE = /\b(?:he|his|him|himself)\b/i;

    /** The match plus the prose around it, so a failure names the sentence and not just the word. */
    function offence(haystack: string): string | null {
      const hit = MASCULINE.exec(haystack);
      if (!hit) return null;
      const from = Math.max(0, hit.index - 70);
      return `"${hit[0]}" in: …${haystack.slice(from, hit.index + 70).replace(/\s+/g, " ")}…`;
    }

    // The stripper itself must be able to see an offence, or both arms below pass by being blind.
    assert.equal(offence("Where his phone put him"), `"his" in: …Where his phone put him…`);
    assert.equal(offence("Where their phone put them"), null, "neutral prose is not flagged");
    assert.equal(offence("the theme of the shepherd"), null, "a word merely CONTAINING 'he' is not a pronoun");

    const trip: FieldActivityTripRow = {
      allowance: 125,
      approvedTotal: null,
      capturedAccuracyMeters: 2.1,
      capturedAt: "2026-09-20T13:02:02",
      capturedLat: 30.9759767,
      capturedLon: 31.1745033,
      claimedTotal: 342.26,
      destination: "A city",
      distanceKm: 60.35,
      durationMinutes: 104.8,
      eligibility: "eligible",
      evidenceGate: "complete",
      fuel: 217.26,
      meeting: 0,
      minimumKm: 60,
      other: 0,
      recommendation: "auto_approve",
      reference: "OUTSTATION-1",
      status: "submitted",
      submittedAt: "2026-09-20T10:03:19.171+00:00",
      tickets: 0,
      transport: "car",
      tripDate: "2026-09-20",
      workload: { am: 4, pm: 10, pharmacies: 0 },
      workloadGate: "complete",
    };
    const leave: FieldActivityLeaveRow = {
      balanceAfter: 9,
      balanceBefore: 10,
      dayPart: "Full day",
      endDate: "2026-09-20",
      hrDecisionAt: null,
      managerDecisionAt: null,
      managerName: "A Manager",
      paymentStatus: "Paid",
      reference: "LEAVE-1",
      startDate: "2026-09-20",
      status: "Approved",
      submittedAt: null,
      type: "Annual",
    };

    // One document per branch that carries prose. A single report cannot be both a field day and
    // an approved-leave day, so the gendered sentences live on pages that never render together.
    const pages: Array<[string, ReturnType<typeof run>]> = [
      // stops + a map + the trip's own GPS fix: the three day headings and the fix label.
      ["a field day with a trip", run({ visits: [visit()], checkins: [checkin()], trips: [trip] })],
      // approved leave with a call against it: the "Where they were" fact and the contradiction note.
      ["a leave day with a call on it", run({ visits: [visit()], leave: [leave] })],
      // a logged call with no fix behind it: the "where they stood cannot be shown" note.
      ["a day logged with no GPS", run({ visits: [visit()] })],
    ];

    for (const [label, report] of pages) {
      const html = buildFieldActivityDocument({
        generatedOn: "5 October 2026",
        maps: report.days
          .filter((day) => day.stops.length > 0)
          .map((day) => ({ caption: "A caption.", dateIso: day.dateIso, svg: "<g></g>" })),
        report,
      });
      // The house mark is a base64 data URI, and base64 uses "+" and "/" — so it can spell a
      // word boundary around "his" by pure chance. That is not prose and must not fail this.
      const found = offence(html.replace(/data:[^"')]+/g, ""));
      assert.equal(found, null, `${label}: the rendered report must not assume the subject is a man — ${found}`);
    }

    // ── the PDF's money names its currency, as the screen does ───────────────────────────────────
    {
      const report = run({ visits: [visit()], checkins: [checkin()], trips: [trip] });
      const html = buildFieldActivityDocument({ generatedOn: "5 October 2026", maps: [], report });
      assert.ok(html.includes('<td class="num">EGP 342.26</td>'), "the Claimed column prints EGP beside the day's claim");
      assert.ok(html.includes("<strong>EGP 342.26</strong></td></tr></tfoot>"), "the Claimed total prints EGP");
      assert.ok(!/<td class="num">\d[\d,]*\.\d\d<\/td>/.test(html), "no bare amount is left in a money cell");
    }

    // The map caption is assembled in the PDF route, which no unit test can execute, and the day
    // notes are assembled in the model. Both are scanned at the source so a NEW label is caught
    // where it is written rather than only on the one branch a fixture happens to reach.
    //
    // 🔴 THE ON-SCREEN VIEW IS IN THIS LIST BECAUSE IT WAS MISSED. The first fix (#5335) covered
    // the printable document and the PDF and shipped while `field-activity-view.tsx` — the SAME
    // report as a page — still read "Where he was" and "in the order his phone recorded it". The
    // document and the screen are two renderers of one report, and a sweep that names only
    // `src/lib/field-activity/**` sees one of them.
    for (const file of [
      "app/api/admin/field-activity/pdf/route.ts",
      "src/components/field-activity/field-activity-view.tsx",
      "src/lib/field-activity/document.ts",
      "src/lib/field-activity/model.ts",
    ]) {
      const found = offence(stripComments(readFileSync(file, "utf8")));
      assert.equal(found, null, `${file}: user-visible prose must not assume the subject is a man — ${found}`);
    }
  }

  // ── the premium dress (owner, 13 Oct 2026: "change to the premium look") ─────────────────────
  //
  // Dress only: every word, row and figure the tests above pin is untouched. What changed is the page
  // around them — the hand-rolled masthead with its FILLED brand rule and the footer that counted its
  // own pages by hand ("Page N of M", wrong for a day that spills onto a second sheet) are replaced by
  // the premium masthead, the repeating landscape frame and foot, and a page count stamped after layout.
  {
    const rows = Array.from({ length: 10 }, (_, index) => index);
    const report = run({
      checkins: rows.map((index) =>
        checkin({ checkedAt: `2026-09-20 ${String(9 + Math.floor(index / 4)).padStart(2, "0")}:${String((index % 4) * 15).padStart(2, "0")}:00+00`, contactCrmId: 600 + index, contactName: `Doctor ${index + 1}`, lat: 30.46 + index * 0.003 }),
      ),
      visits: rows.map((index) => visit({ contactCrmId: 600 + index, contactName: `Doctor ${index + 1}` })),
    });
    assert.equal(report.days[0].stops.length, 10, "the fixture day has more stops than one page carries, so it spills");
    const html = buildFieldActivityDocument({
      generatedOn: "5 October 2026",
      maps: [{ caption: "A caption.", dateIso: "2026-09-20", svg: "<g></g>" }],
      report,
    });

    assert.equal(html.split('<section class="page">').length - 1, 3, "a cover, the day and its spill page");
    assert.ok(html.includes("@page { size: A4 landscape; margin: 0; }"), "the sheet is the turned A4 with no page margin, so the frame and foot reach the edge");
    assert.equal(html.split('<header class="pm-mast pm-mast--compact">').length - 1, 1, "the cover carries the full premium masthead");
    assert.equal(html.split('<header class="pm-mast pm-mast--compact pm-mast--slim">').length - 1, 2, "and the day and its spill page the slim one, which repeats without eating the page");
    assert.equal(html.split("Field Activity Report</h1>").length - 1, 3, "every page still names the report");
    assert.ok(
      html.includes("A Product Manager · Product Manager · Pedia line") && html.includes("2026-09-20 to 2026-09-20"),
      "the two lines the old masthead carried under the title are the masthead's subtitles, word for word",
    );
    assert.ok(html.includes("Sunday 20 September 2026 &mdash; every stop <span class=\"thin\">(continued)</span>"), "the spill page still says it continues the day's stops");

    // ONE chrome, written once: it is fixed in print, so Chrome repeats it on every page.
    assert.equal(html.split('class="pm-chrome pm-chrome--landscape"').length - 1, 1, "one landscape chrome, repeated by print on every page");
    const foot = /<div class="pm-foot__code" dir="ltr">([^<]*)<\/div>/.exec(html)?.[1] ?? "";
    assert.equal(
      foot,
      "Sato Pharma · Employee record B-155 · read from the live system on 5 October 2026, Cairo time · SATO-DIS-2026-01 v1.0",
      "the old in-page footer's words ride the running foot, with the identity code",
    );
    assert.ok(!/phoenix/i.test(foot), "a company paper's foot says Sato Pharma, never Phoenix");
    assert.ok(html.includes('<div class="pm-foot__ph"></div>'), "the foot's left slot is empty — a Sato-only foot, with no Phoenix label or emblem");
    assert.ok(!/phoenix/i.test(html.slice(html.indexOf('<div class="pm-chrome'), html.indexOf("</section>", html.indexOf('<div class="pm-chrome')))), "nothing in the chrome — label, emblem or microtext — names Phoenix");
    assert.ok(html.includes('class="pm-foot__page"'), "the foot keeps the slot the page count is stamped into");
    assert.ok(
      !/Page \d+ of \d+|class="foot|class="mast|mast__rule|totalPages/.test(html),
      "the hand-counted footer and the filled masthead rule are gone, not hidden",
    );
    assert.ok(!/box-shadow|text-shadow|gradient\(/.test(html), "no shadow and no gradient");
    assert.ok(html.includes("border-radius: 0 !important"), "square edges everywhere");
    assert.doesNotMatch(html, /border-radius:\s*[1-9]/, "and no corner is rounded");
    {
      // The ink rule: no filled area except the 6% zebra row. Every rule that paints a background is a zebra row.
      const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
      const fills = [...css.matchAll(/([^{}]+)\{([^{}]*\bbackground(?:-color)?\s*:[^{}]*)\}/g)].map((match) => match[1].trim());
      assert.ok(fills.length >= 1, "the zebra rows are still there to be found, so this scan is not blind");
      assert.ok(fills.every((selector) => /nth-child\(odd\)/.test(selector)), `only the zebra row is filled — ${fills.join(" | ")}`);
    }

    // The route prints it that way: margin 0, the brand artwork inlined, the count stamped afterwards.
    const route = stripComments(readFileSync("app/api/admin/field-activity/pdf/route.ts", "utf8"));
    assert.ok(/margin:\s*\{\s*bottom:\s*"0",\s*left:\s*"0",\s*right:\s*"0",\s*top:\s*"0"\s*\}/.test(route), "the page margin is zero — the premium sheet draws its own");
    assert.ok(route.includes("landscape: true") && route.includes("preferCSSPageSize: true") && route.includes("printBackground: true"), "A4 landscape, with its backgrounds");
    assert.ok(route.includes("timeout: 60_000"), "and the long timeout a many-day report needs");
    assert.ok(route.includes("inlineLocalAssets(buildFieldActivityDocument("), "the /brand artwork is inlined, since setContent has no base URL");
    assert.ok(route.includes("data-pm-numbered") && route.includes("stampPremiumPageNumbers(bytes)"), "the page count is stamped into the foot after Chromium has counted");
  }

  // ── A chain visit's SECOND manager: the day he rode must be a day he worked ──
  {
    // SUBJECT is B-155, the Product Manager. On a chain visit the door fills slot 1 from
    // `coalesce(manager, product_manager, senior)` and slot 2 with whoever is left — so B-155 can be
    // either. Reading one slot is what made the day he spent in the field read as a day he did not
    // work (owner, 2026-10-07), and the door already returns the row, so the defect is entirely here.
    const chain = visit({
      agentHrId: "B-100",
      agentName: "A Medical Rep",
      doubleHrId: "B-900",
      doubleName: "A District Manager",
      double2HrId: "B-155",
      double2Name: "A Product Manager",
    });

    const report = buildFieldActivityReport({
      checkins: [],
      fromIso: "2026-09-20",
      leave: [],
      punches: [],
      subject: SUBJECT,
      toIso: "2026-09-20",
      trips: [],
      visits: [chain],
    });

    const day = report.days.find((entry) => entry.dateIso === "2026-09-20");
    assert.ok(day, "the chain visit's day must be in the report");
    assert.equal(
      day.countedTotal,
      1,
      "a chain visit carrying the subject in the SECOND ride-along slot counts as a visit on his day",
    );
    assert.deepEqual(
      day.partners.map((partner) => partner.name).sort(),
      ["A District Manager", "A Medical Rep"],
      "both other people on a chain visit are named as who he was out with, not just one",
    );
  }

  // ── A MANAGER'S OWN SINGLE VISITS: listed on the day, counted in nothing (owner, 2026-10-20) ──
  // His multiple-choice answer: "Show, keep out of reps — his own visits appear under his name in the Visit Report and
  // the Field Activity day, never in a rep's totals. Still no GPS or photo required."
  {
    const own: FieldActivityOwnVisitRow = {
      comment: "Asked for samples",
      customerName: "Dr. Hala Mansour",
      date: "2026-09-20",
      grade: "A",
      half: "AM",
      inVacantTerritory: true,
      loggedAt: "2026-09-20T11:42:00",
      planned: true,
      products: ["Lacto Advanced"],
      speciality: "Cardiology",
      where: "12 Mostafa El-Nahas St, Brick Nasr City 3",
    };

    // A day spent on his own visits alone is a day he WORKED — never "no activity", and never "a field record with no
    // GPS", since his own visit is asked for no position at all.
    const alone = run({ ownVisits: [own] });
    assert.equal(alone.days[0].kind, "own-visits", "a day of own visits alone is named as such");
    assert.equal(alone.days[0].ownVisits.length, 1, "and the visit is listed on it");
    assert.equal(alone.days[0].ownVisits[0].loggedAt, "11:42:00", "its clock is the Cairo wall clock the loader handed in, unshifted");
    assert.equal(alone.days[0].ownVisits[0].customerName, "Dr. Hala Mansour");
    assert.equal(alone.days[0].countedTotal, 0, "it is counted in none of the day's figures");
    assert.deepEqual(alone.totals, run().totals, "and the period's totals are exactly what they are without it");

    // Beside a day of calls with a rep: the calls are counted as before, his own visit is listed beside them.
    const withRep = run({ checkins: [checkin()], ownVisits: [own], visits: [visit()] });
    const withoutOwn = run({ checkins: [checkin()], visits: [visit()] });
    assert.equal(withRep.days[0].kind, "field", "a field day stays a field day");
    assert.equal(withRep.days[0].countedTotal, withoutOwn.days[0].countedTotal, "the day's count is the calls with the rep only");
    assert.deepEqual(withRep.days[0].counts, withoutOwn.days[0].counts, "AM, PM and pharmacies are untouched");
    assert.deepEqual(withRep.totals, withoutOwn.totals, "and so is every total");
    assert.equal(withRep.days[0].ownVisits.length, 1, "while his own visit is still listed");
    assert.deepEqual(withoutOwn.days[0].ownVisits, [], "a day with none lists none");

    // A visit outside the period is not drawn on a day that is not in it.
    assert.deepEqual(run({ ownVisits: [{ ...own, date: "2026-09-25" }] }).days[0].ownVisits, [], "an own visit lands on its own date only");

    // The loader reads them through the ONE door out of their table, for the subject alone, and converts the real
    // instant once.
    const loader = stripComments(readFileSync("src/lib/field-activity/report.ts", "utf8"));
    assert.match(loader, /import \{ loadManagerOwnVisitRows \} from "@\/lib\/phoenix-crm\/server\/manager-plan-readers";/, "through the adapter");
    assert.match(
      loader,
      /loadManagerOwnVisitRows\(\{ end: toIso\.slice\(0, 10\), managerHrIds: \[employee\.hrId\], start: fromIso\.slice\(0, 10\) \}\)/,
      "for the subject the report's access admitted, over the report's period",
    );
    assert.match(loader, /loggedAt: cairoWallClockIso\(own\.loggedAt\)/, "the log instant becomes a Cairo wall clock at the loader");
    assert.doesNotMatch(loader, /phoenix_crm_manager_visits/, "and the loader never names the table");
    assert.match(loader, /\n\s+ownVisits,\n/, "they are handed to the model as display rows");
  }
}
