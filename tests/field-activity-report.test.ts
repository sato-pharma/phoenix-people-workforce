import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  buildFieldActivityReport,
  eachDateIso,
  haversineMetres,
  isWeekendIso,
  minutesOfDay,
  wallClock,
  weekdayOf,
  type FieldActivityCheckinRow,
  type FieldActivitySubject,
  type FieldActivityVisitRow,
} from "../src/lib/field-activity/model.ts";
import { bidi, clock12, tidyAddress } from "../src/lib/field-activity/document.ts";
import { defaultPeriod, resolvePeriod, MAX_PERIOD_DAYS } from "../src/lib/field-activity/period.ts";
import { FIELD_ACTIVITY_ROLES, isFieldActivityRole } from "../src/lib/field-activity/access.ts";
import { getNavigationSections } from "../src/config/system-navigation.ts";
import { isPortalShellRole } from "../src/lib/auth/portal-shell-roles.ts";
import { resolvePortalTwin } from "../src/lib/navigation/portal-twins.ts";
import { fitZoom, renderRouteSvg } from "../src/lib/field-activity/map.ts";

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
export function runFieldActivityReportTests() {
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
}
