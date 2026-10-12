/**
 * Phoenix CRM — the nightly pass for the four checks that nothing was making (2026-10-12).
 *
 * The second-pass CRM audit listed 23 gaps in the checks. Nine of them turned out to be the owner's
 * own written decisions and three were factually wrong about the code; what survived included four
 * questions Phoenix could already answer from data it holds, and was simply never asked:
 *
 *   1. the ROSTER — a visit saved on a day the rep was not in the field at all;
 *   2. the CADENCE — one customer called three times inside a rolling week;
 *   3. the COVERAGE — an active place filed under a brick it is nowhere near;
 *   4. the SHARED VENUES — 24 active rows that reached no detector of any kind, while carrying the
 *      same pair of independent fixes an ordinary place does.
 *
 * FOUR RULES, and three of them look like something to tidy.
 *
 *   1. 🔴 EVERY FLAG IT FILES IS WEAK, AND THAT IS THE DESIGN AND NOT A STARTING POINT. A weak flag
 *      moves NO number a rep can read — `countedIntegrityFlags` in `rep-ranks/field-quality.ts`
 *      filters to `PHOENIX_CRM_STRONG_INTEGRITY_FLAGS`, and the nightly ranks reader asks the table
 *      for `strong = true` as well, so there are two independent gates between this pass and a rep's
 *      score. None of these four can accuse anybody: a rep on a conference day very often was at a
 *      conference AND at a doctor.
 *   2. 🔴 IT TELLS NOBODY, in either direction. No notification, no e-mail, no in-app notice, not to
 *      a rep and not to a manager (owner, 2026-09-25, Golden Rule #1). It reads, it files, it stops.
 *      The integrity board is where a human looks.
 *   3. 🔴 IT REFUSES NOTHING AND HOLDS NOTHING. No visit is un-saved, no place un-validated, no
 *      customer's status touched (owner, 2026-10-08: "flag them, you decide each").
 *   4. 🔴 IT FILES A FINDING ONLY WHERE THE DATA CAN CARRY ONE. A half-day leave is not a day off, an
 *      unmeasured brick distance is not a far one, and a venue with a single fix has not been
 *      measured — each of those is a null answer here, not a flag. The measurements behind every one
 *      of those three refusals are in `location-integrity.ts` beside the threshold they set.
 *
 * TWO CHECKS THE AUDIT ASKED FOR AND THIS FILE DELIBERATELY DOES NOT MAKE — both measured, both
 * refused, and both recorded here so a later session does not re-chase them out of the workbook:
 *
 *   • A SHARED PHONE NUMBER ACROSS CUSTOMERS. Measured on production 2026-10-12, keyed on the last
 *     nine digits: 15 shared numbers spanning 88 customers, the worst group 30 doctors on one number
 *     — and the groups plainly contain مستشفي النفسيه والعصبيه and الوحده الصحيه بزناره, i.e.
 *     hospital and polyclinic switchboards, which is the correct number for every doctor inside the
 *     building. Only ONE of the 15 even crosses a seat. A detector here would file 88 customers'
 *     worth of noise to find nothing, against this module's own first law ("no false positive is
 *     worth a catch"). The duplicate-NAME pairs the same sweep surfaced belong to the duplicate
 *     customers board and the name fold, which already have them.
 *   • A CUSTOMER WITH NO PLACE TO COMPARE A VISIT AGAINST. 10,397 of 11,560 live customers (90%) have
 *     no active place, 286 of them visited across 26 reps. That is the ordinary state of a module
 *     about 10% of the way through its validation drive — a coverage NUMBER for the validation board
 *     to chase, and naming 286 rows as integrity cases would bury the 11 real ones.
 */

import { assessCaptureTrust, type CaptureFix } from "@/lib/evidence/capture-trust";
import { getFullDayApprovedLeaveMap } from "@/lib/attendance/working-days";
import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import {
  judgePlaceBrickDistance,
  judgeRevisitCadence,
  judgeRosterDay,
  PHOENIX_CRM_AWAY_DAY_ACTIVITIES,
  REVISIT_WINDOW_DAYS,
} from "@/lib/phoenix-crm/location-integrity";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import {
  fileCustomerCadenceFlag,
  filePlaceCaptureTrust,
  filePlaceCoverageFlag,
  fileVisitRosterFlags,
} from "@/lib/phoenix-crm/server/location-integrity";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/**
 * How far back each night looks, in days.
 *
 * 🔴 A WINDOW AND NOT THE WHOLE HISTORY, because the filers upsert on
 * (subject_kind, subject_id, source): a finding re-filed tonight REPLACES its own row in place, so a
 * window that reaches back over work already filed costs a write and changes nothing, while a window
 * that reaches back over work the owner has SETTLED re-stamps `flags` identically and leaves the
 * settlement intact (the test is `settled_flags = flags`). 21 days covers a rep who works one week a
 * month in an outstation area and keeps every query small forever.
 */
export const SILENT_SWEEP_DAYS = 21;

/** The ceiling on each paged read. A bound on memory, never a bound on the field. */
const SILENT_READ_MAX = 20_000;

export type SilentSweepResult = {
  /** Visits read in the window. */
  visits: number;
  /** Of those, how many the roster had something to say about. */
  rosterFlagged: number;
  /** Customers whose call cadence inside the window reached the rule. */
  cadenceFlagged: number;
  /** Active places read, and how many sit outside their own brick. */
  placesRead: number;
  coverageFlagged: number;
  /** Active shared venues read. */
  venuesRead: number;
  /**
   * Of those, how many had TWO readings for the comparison to run on.
   *
   * 🔴 MEASURED, NOT FLAGGED, AND THE NAME SAYS SO. `filePlaceCaptureTrust` is void by this module's
   * rule 2 — it can never throw and never reports — so this pass cannot know how many venues it
   * filed on. A field called `venueFlagged` here would be a number that does not mean what it says,
   * which is the one thing a result object must never be. How many venues actually carry a case is a
   * query on the board, where it belongs.
   */
  venuesMeasured: number;
  /** True when any of the four reads stopped at its ceiling — more is waiting. */
  capped: boolean;
};

function isoDaysBefore(todayIso: string, days: number): string {
  const parsed = Date.parse(`${todayIso}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return todayIso;
  return new Date(parsed - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A venue row's columns as a `CaptureFix`.
 *
 * 🔴 `latitude`/`longitude`/`capturedAt`, NOT `lat`/`lon`/`Date` — `CaptureFix`'s fields are all
 * OPTIONAL, so an object spelled with the place row's own column names type-checks perfectly and
 * reads as a fix with no coordinates at all: `assessCaptureTrust` would answer `unmeasured` for every
 * venue and the pass would file on nobody while looking like it worked.
 */
function fixOf(lat: unknown, lon: unknown, accuracy: unknown, at: unknown): CaptureFix | null {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const accuracyMeters = accuracy === null || accuracy === undefined ? null : Number(accuracy);
  return {
    latitude,
    longitude,
    accuracyMeters: accuracyMeters !== null && Number.isFinite(accuracyMeters) ? accuracyMeters : null,
    capturedAt: typeof at === "string" && at !== "" ? at : null,
  };
}

/**
 * Pass 1 and 2 — the roster and the cadence, from one read of the window's visits.
 *
 * ONE READ FOR BOTH, deliberately: they ask different questions of the same rows, and the roster
 * lookups (leave, day activities) are per rep-and-date whichever question is being answered.
 */
async function runRosterAndCadence(todayIso: string, result: SilentSweepResult): Promise<void> {
  const supabase = getSupabaseAdmin();
  const fromIso = isoDaysBefore(todayIso, SILENT_SWEEP_DAYS);

  const read = await readEveryPage<Row>(
    () =>
      supabase
        .from("phoenix_crm_visits")
        .select("id, seat_id, rep_hr_id, customer_id, visit_date, captured_at, is_test, manager_hr_id, senior_hr_id, product_manager_hr_id")
        .eq("is_test", false)
        .gte("visit_date", fromIso)
        .lte("visit_date", todayIso)
        // A total order, so a page seam can neither drop a visit nor repeat one.
        .order("visit_date", { ascending: true })
        .order("id", { ascending: true }),
    { maxRows: SILENT_READ_MAX, whenFull: "stop", what: "Phoenix CRM visits for the silent detectors", uniqueBy: (row) => String(row.id) },
  );
  throwIfError(read.error);
  if (read.capped) result.capped = true;
  const visits = read.rows;
  result.visits = visits.length;
  if (visits.length === 0) return;

  // Everybody whose roster matters: the rep who saved each visit AND whoever is named beside him.
  const people = new Set<string>();
  for (const visit of visits) {
    for (const key of ["rep_hr_id", "manager_hr_id", "senior_hr_id", "product_manager_hr_id"]) {
      const hrId = visit[key] ? String(visit[key]).toUpperCase() : "";
      if (hrId) people.add(hrId);
    }
  }

  const [leaveDays, activityRead] = await Promise.all([
    // 🔴 FULL-DAY LEAVE ONLY. Reading every approved leave here is what made the audit's own count
    // wrong: all nine of its leave and companion hits were half days.
    getFullDayApprovedLeaveMap({ dateFromIso: fromIso, dateToIso: todayIso, employeeHrIds: [...people] }),
    readEveryPage<Row>(
      () =>
        supabase
          .from("phoenix_crm_day_activities")
          .select("rep_hr_id, activity_date, activity_type, half_day, is_test")
          .eq("is_test", false)
          // A HALF day is not a day away, for the same reason a half day of leave is not: the other
          // half of it is field work.
          .eq("half_day", false)
          .gte("activity_date", fromIso)
          .lte("activity_date", todayIso)
          .order("activity_date", { ascending: true })
          .order("rep_hr_id", { ascending: true }),
      { maxRows: SILENT_READ_MAX, whenFull: "stop", what: "Phoenix CRM day activities for the silent detectors" },
    ),
  ]);
  throwIfError(activityRead.error);
  if (activityRead.capped) result.capped = true;

  const awayByPersonDay = new Map<string, string[]>();
  for (const row of activityRead.rows) {
    const hrId = row.rep_hr_id ? String(row.rep_hr_id).toUpperCase() : "";
    const date = row.activity_date ? String(row.activity_date) : "";
    const type = row.activity_type ? String(row.activity_type) : "";
    if (!hrId || !date || !type) continue;
    const key = `${hrId}|${date}`;
    awayByPersonDay.set(key, [...(awayByPersonDay.get(key) ?? []), type]);
  }

  /**
   * Was this person off duty for the WHOLE of that day — full-day leave, or a full-day away activity?
   *
   * The same test for a rep and for a companion, read from the same two maps. Only `away` rows are in
   * `awayByPersonDay` at all, because the read already asked `half_day = false`; the activity list is
   * the one in `location-integrity.ts` and `sales_day` and `admin_work` are deliberately not in it.
   */
  const offDuty = (hrId: string, date: string): boolean => {
    const upper = hrId.toUpperCase();
    if (leaveDays.get(upper)?.has(date) === true) return true;
    const activities = awayByPersonDay.get(`${upper}|${date}`) ?? [];
    return activities.some((activity) => PHOENIX_CRM_AWAY_DAY_ACTIVITIES.includes(activity));
  };

  // ── Pass 1: the roster, visit by visit ──────────────────────────────────────────────────────
  const cadence = new Map<string, { customerId: string; repHrId: string; seatId: string; days: string[]; lastCapturedAt: Date; lastDate: string }>();
  for (const visit of visits) {
    const repHrId = visit.rep_hr_id ? String(visit.rep_hr_id).toUpperCase() : "";
    const visitDate = String(visit.visit_date ?? "");
    const customerId = visit.customer_id ? String(visit.customer_id) : "";
    if (!repHrId || !visitDate) continue;

    const companions = ["manager_hr_id", "senior_hr_id", "product_manager_hr_id"]
      .map((key) => (visit[key] ? String(visit[key]).toUpperCase() : ""))
      .filter(Boolean);
    const offDutyCompanions = companions.filter((hrId) => offDuty(hrId, visitDate));

    const flags = judgeRosterDay({
      repOnFullDayLeave: leaveDays.get(repHrId)?.has(visitDate) === true,
      repFullDayActivities: awayByPersonDay.get(`${repHrId}|${visitDate}`) ?? [],
      companionOffDuty: offDutyCompanions.length > 0,
    });
    if (flags.length > 0) {
      const capturedAt = new Date(Date.parse(String(visit.captured_at ?? "")) || Date.parse(`${visitDate}T12:00:00Z`));
      await fileVisitRosterFlags({
        visitId: String(visit.id),
        seatId: String(visit.seat_id ?? ""),
        repHrId,
        customerId: customerId || null,
        isTest: false,
        capturedAt,
        visitDate,
        flags,
        // 🔴 THE COMPANIONS' HR IDS AND NOT THEIR NAMES. This row is evidence, read by a board that
        // resolves every id to a name at the moment it prints; a name written in here would be a
        // second copy of somebody's name, going stale from the day it is filed.
        signals: {
          awayActivities: awayByPersonDay.get(`${repHrId}|${visitDate}`) ?? [],
          offDutyCompanionHrIds: offDutyCompanions,
          onFullDayLeave: leaveDays.get(repHrId)?.has(visitDate) === true,
        },
      });
      result.rosterFlagged += 1;
    }

    // ── Pass 2's tally, gathered on the same walk ────────────────────────────────────────────
    if (!customerId) continue;
    const key = `${repHrId}|${customerId}`;
    const current = cadence.get(key);
    const capturedAt = new Date(Date.parse(String(visit.captured_at ?? "")) || Date.parse(`${visitDate}T12:00:00Z`));
    if (!current) {
      cadence.set(key, { customerId, repHrId, seatId: String(visit.seat_id ?? ""), days: [visitDate], lastCapturedAt: capturedAt, lastDate: visitDate });
    } else {
      current.days.push(visitDate);
      if (visitDate >= current.lastDate) {
        current.lastDate = visitDate;
        current.lastCapturedAt = capturedAt;
      }
    }
  }

  // ── Pass 2: the cadence, per rep and customer ───────────────────────────────────────────────
  for (const entry of cadence.values()) {
    const flags = judgeRevisitCadence(entry.days);
    if (flags.length === 0) continue;
    await fileCustomerCadenceFlag({
      customerId: entry.customerId,
      seatId: entry.seatId,
      repHrId: entry.repHrId,
      isTest: false,
      capturedAt: entry.lastCapturedAt,
      visitDate: entry.lastDate,
      flags,
      signals: {
        visitDays: [...new Set(entry.days)].sort(),
        windowDays: REVISIT_WINDOW_DAYS,
      },
    });
    result.cadenceFlagged += 1;
  }
}

/**
 * Pass 3 — every active place against the brick it is filed under.
 *
 * The whole table and not a window: a place's distance from its brick does not change with time, and
 * a place validated last month is as wrongly filed today as it was then. The upsert key means a place
 * already filed is re-stamped rather than duplicated.
 */
async function runCoverage(result: SilentSweepResult): Promise<void> {
  const read = await readEveryPage<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_places")
        .select("id, seat_id, customer_id, created_by_hr_id, lat, lon, accuracy_meters, captured_at, brick_distance_km, brick_lookup, is_test, status")
        .eq("is_test", false)
        .eq("status", "active")
        .order("id", { ascending: true }),
    { maxRows: SILENT_READ_MAX, whenFull: "stop", what: "Phoenix CRM places for the coverage check", uniqueBy: (row) => String(row.id) },
  );
  throwIfError(read.error);
  if (read.capped) result.capped = true;
  result.placesRead = read.rows.length;

  for (const place of read.rows) {
    const raw = place.brick_distance_km;
    const distance = raw === null || raw === undefined || raw === "" ? null : Number(raw);
    const flags = judgePlaceBrickDistance({
      brickDistanceKm: distance !== null && Number.isFinite(distance) ? distance : null,
      brickMatched: String(place.brick_lookup ?? "") === "matched",
    });
    if (flags.length === 0) continue;
    const capturedAt = new Date(Date.parse(String(place.captured_at ?? "")) || Date.now());
    const accuracy = place.accuracy_meters === null || place.accuracy_meters === undefined ? null : Number(place.accuracy_meters);
    await filePlaceCoverageFlag({
      placeId: String(place.id),
      seatId: String(place.seat_id ?? ""),
      // The rep who captured the place: the row has no other person on it, and the board prints his
      // name beside every case.
      repHrId: String(place.created_by_hr_id ?? ""),
      customerId: place.customer_id ? String(place.customer_id) : null,
      isTest: false,
      flags,
      signals: { brickDistanceKm: distance, brickLookup: String(place.brick_lookup ?? ""), businessDay: cairoBusinessDay(capturedAt) },
      fixed: {
        lat: Number(place.lat),
        lon: Number(place.lon),
        accuracyMeters: accuracy !== null && Number.isFinite(accuracy) ? accuracy : null,
        capturedAt,
      },
    });
    result.coverageFlagged += 1;
  }
}

/**
 * Pass 4 — the shared venues, through the EXISTING capture-trust comparison.
 *
 * 🔴 NOT A NEW DETECTOR AND NOT A CROSS-REP DUPLICATE CHECK. `assessCaptureTrust` already answers the
 * one question a venue row can be asked — do its own two independent fixes agree — and it is the
 * `filePlaceCaptureTrust` filer that writes the result, with `subjectKind: "shared_place"`. A
 * detector comparing two REPS' captures of one building is forbidden by the owner's 2026-10-09
 * ruling: two reps each capturing the same building is correct, and those duplicate rows are correct.
 */
async function runSharedVenues(result: SilentSweepResult): Promise<void> {
  const read = await readEveryPage<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_shared_places")
        .select("id, seat_id, created_by_hr_id, lat, lon, accuracy_meters, captured_at, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_captured_at, is_test, status")
        .eq("is_test", false)
        .eq("status", "active")
        .order("id", { ascending: true }),
    { maxRows: SILENT_READ_MAX, whenFull: "stop", what: "Phoenix CRM shared venues for the capture-trust check", uniqueBy: (row) => String(row.id) },
  );
  throwIfError(read.error);
  if (read.capped) result.capped = true;
  result.venuesRead = read.rows.length;

  for (const venue of read.rows) {
    const pinFix = fixOf(venue.pin_lat, venue.pin_lon, venue.pin_accuracy_meters, venue.captured_at);
    const photoFix = fixOf(venue.photo_lat, venue.photo_lon, venue.photo_accuracy_meters, venue.photo_captured_at);
    // The filer itself refuses an unmeasured pair; asking here as well keeps a venue with one fix
    // out of the write path entirely rather than relying on the filer's own guard.
    if (!assessCaptureTrust({ locationFix: pinFix, photoFix }).measured) continue;
    const capturedAt = new Date(Date.parse(String(venue.captured_at ?? "")) || Date.now());
    const accuracy = venue.accuracy_meters === null || venue.accuracy_meters === undefined ? null : Number(venue.accuracy_meters);
    result.venuesMeasured += 1;
    await filePlaceCaptureTrust({
      placeId: String(venue.id),
      subjectKind: "shared_place",
      seatId: String(venue.seat_id ?? ""),
      repHrId: String(venue.created_by_hr_id ?? ""),
      // A venue belongs to no one customer — that is what makes it shared.
      customerId: null,
      isTest: false,
      photoFix,
      pinFix,
      fixed: {
        lat: Number(venue.lat),
        lon: Number(venue.lon),
        accuracyMeters: accuracy !== null && Number.isFinite(accuracy) ? accuracy : null,
        capturedAt,
      },
    });
  }
}

/**
 * Run all four passes. Sequential on purpose: they share the cron's window with the photo, signboard
 * and behaviour passes, and four concurrent full-table walks on a 16 GB box is how a night gets reaped.
 */
export async function runPhoenixCrmSilentSweep(options: { today?: string } = {}): Promise<SilentSweepResult> {
  const result: SilentSweepResult = {
    visits: 0,
    rosterFlagged: 0,
    cadenceFlagged: 0,
    placesRead: 0,
    coverageFlagged: 0,
    venuesRead: 0,
    venuesMeasured: 0,
    capped: false,
  };
  const todayIso = options.today && /^\d{4}-\d{2}-\d{2}$/.test(options.today) ? options.today : cairoBusinessDay(new Date());
  await runRosterAndCadence(todayIso, result);
  await runCoverage(result);
  await runSharedVenues(result);
  return result;
}
