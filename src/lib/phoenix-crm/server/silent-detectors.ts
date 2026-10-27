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
 * And a fifth, added 2026-10-13 on the owner's own instruction rather than from the audit:
 *
 *   5. the VISIT against the PHOTOGRAPH of the place it names. "since u have the accurate validation
 *      the photo with location then drop the suspected one and compare visits vs the accurate", and
 *      then "i want the integrity report to show exactly this". Measured on production the same day:
 *      of 1,286 visits that can be measured against a photograph, 48 sit past the settings' 300 m
 *      line, 46 survive the accuracy guard and 14 of those are more than a kilometre out. Before
 *      this, 47 of the 48 reached the board through no case of their own.
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
  judgeVisitAgainstPhotograph,
  personOnTheVisit,
  PHOENIX_CRM_AWAY_DAY_ACTIVITIES,
  REVISIT_WINDOW_DAYS,
  type PhoenixCrmIntegrityFlag,
} from "@/lib/phoenix-crm/location-integrity";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadVisitCompanionIds } from "@/lib/phoenix-crm/server/visit-companions";
import {
  fileCustomerCadenceFlag,
  filePlaceCaptureTrust,
  filePlaceCoverageFlag,
  fileVisitPhotographGap,
  fileVisitRosterFlags,
} from "@/lib/phoenix-crm/server/location-integrity";
import { readEveryPage, type PagedRead } from "@/lib/phoenix-crm/server/paged-read";
import { loadPhoenixCrmConfig } from "@/lib/phoenix-crm/server/settings";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/**
 * How many findings are filed at once (Phoenix CRM performance audit, 2026-10-16).
 *
 * Each is still its own upsert on its own (subject_kind, subject_id, source) — the filers are
 * unchanged — so a finding lands exactly as it did when they were filed one after another. Every pass
 * files each subject once, except the cadence pass, where two people can share one customer; that
 * pass keeps a customer's filings in their own order (see `runRosterAndCadence`).
 */
const FILINGS_AT_ONCE = 4;

/**
 * A read one pass made WHOLE — the ceiling never reached — that the fifth pass may reuse rather than
 * read again; null when it stopped at the ceiling, and the fifth pass then reads for itself.
 *
 * 🔴 ONLY A WHOLE READ IS SHARED, and that is what keeps the fifth pass's findings exactly what they
 * were. The fifth pass asks a NARROWER question of the same window (visits with a reading, places with
 * a photograph fix). Below the ceiling those are simply the matching rows of the wider read, in the
 * same order; at the ceiling the wider read stops sooner than the narrower one would, so the fifth
 * pass would see fewer rows than its own read — so there it reads for itself, as it always did.
 */
type WholeRead = Row[] | null;

/** The narrower read the fifth pass would have made, answered out of a wider read that was whole. */
function narrowedFrom(rows: Row[], keep: (row: Row) => boolean): PagedRead<Row> {
  return { rows: rows.filter(keep), error: null, capped: false };
}

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
  /** Visits in the window that could be measured against a photograph at all. */
  visitsAgainstPhotograph: number;
  /** Of those, how many sit far enough from it to be filed. */
  visitPhotoFlagged: number;
  /** True when any of the five reads stopped at its ceiling — more is waiting. */
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
 *
 * And since 2026-10-16 the same read serves the fifth pass too: it also carries each visit's own
 * reading (`lat`, `lon`, `accuracy_meters`), and the window comes back for the photograph check
 * whenever it was read whole (`WholeRead`).
 */
async function runRosterAndCadence(todayIso: string, result: SilentSweepResult): Promise<WholeRead> {
  const supabase = getSupabaseAdmin();
  const fromIso = isoDaysBefore(todayIso, SILENT_SWEEP_DAYS);

  const read = await readEveryPage<Row>(
    () =>
      supabase
        .from("phoenix_crm_visits")
        .select("id, seat_id, rep_hr_id, customer_id, visit_date, captured_at, is_test, manager_hr_id, senior_hr_id, product_manager_hr_id, lat, lon, accuracy_meters")
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
  const whole: WholeRead = read.capped ? null : visits;
  result.visits = visits.length;
  if (visits.length === 0) return whole;

  // Everyone a visit lists past its three fixed places (owner, 2026-10-27), read once for the whole window. A
  // visit with a list always keeps its first manager or product person in a fixed place, so only those are asked.
  const companionsOf = await loadVisitCompanionIds(
    visits.filter((visit) => visit.manager_hr_id || visit.product_manager_hr_id).map((visit) => String(visit.id)),
  );

  // Everybody whose roster matters: the rep who saved each visit AND whoever is named beside him.
  const people = new Set<string>();
  for (const visit of visits) {
    for (const key of ["rep_hr_id", "manager_hr_id", "senior_hr_id", "product_manager_hr_id"]) {
      const hrId = visit[key] ? String(visit[key]).toUpperCase() : "";
      if (hrId) people.add(hrId);
    }
    for (const hrId of companionsOf.get(String(visit.id)) ?? []) people.add(hrId.toUpperCase());
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
  // Gathered on the walk and filed after it, a few at a time — one finding per visit, so no two
  // filings share a subject and their order cannot change what lands.
  const rosterFilings: Parameters<typeof fileVisitRosterFlags>[0][] = [];
  for (const visit of visits) {
    // Whose visit it is — the rep, or the MANAGER on his own single visit, where `rep_hr_id` is null
    // by design (`personOnTheVisit` carries the rule and the production count). Reading the rep
    // column alone left those calls checked by nothing at all.
    const repHrId = personOnTheVisit({
      repHrId: visit.rep_hr_id ? String(visit.rep_hr_id) : null,
      managerHrId: visit.manager_hr_id ? String(visit.manager_hr_id) : null,
    }) ?? "";
    const visitDate = String(visit.visit_date ?? "");
    const customerId = visit.customer_id ? String(visit.customer_id) : "";
    if (!repHrId || !visitDate) continue;

    // 🔴 THE SUBJECT IS NEVER HIS OWN COMPANION. On a manager's own single visit he is the person
    // above AND the row's `manager_hr_id`, so leaving him in this list would answer "was somebody
    // else with him who should not have been?" with his own leave day — the same fact the roster
    // judge already reads as his, filed twice under two different explanations.
    const companions = [
      ...new Set([
        ...["manager_hr_id", "senior_hr_id", "product_manager_hr_id"].map((key) => (visit[key] ? String(visit[key]).toUpperCase() : "")),
        ...(companionsOf.get(String(visit.id)) ?? []).map((hrId) => hrId.toUpperCase()),
      ]),
    ].filter((hrId) => hrId !== "" && hrId !== repHrId);
    const offDutyCompanions = companions.filter((hrId) => offDuty(hrId, visitDate));

    const flags = judgeRosterDay({
      repOnFullDayLeave: leaveDays.get(repHrId)?.has(visitDate) === true,
      repFullDayActivities: awayByPersonDay.get(`${repHrId}|${visitDate}`) ?? [],
      companionOffDuty: offDutyCompanions.length > 0,
    });
    if (flags.length > 0) {
      const capturedAt = new Date(Date.parse(String(visit.captured_at ?? "")) || Date.parse(`${visitDate}T12:00:00Z`));
      rosterFilings.push({
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

  await mapWithConcurrency(rosterFilings, FILINGS_AT_ONCE, (filing) => fileVisitRosterFlags(filing));

  // ── Pass 2: the cadence, per rep and customer ───────────────────────────────────────────────
  // 🔴 GROUPED BY CUSTOMER, because the customer is the subject and two people can each have called
  // the same one (a rep and his manager on a visit of his own): both findings upsert ONE row, and the
  // later one in this walk is the one that stands. A customer's filings therefore go one after
  // another in walk order, exactly as before; only different customers are filed side by side.
  const cadenceByCustomer = new Map<string, Parameters<typeof fileCustomerCadenceFlag>[0][]>();
  for (const entry of cadence.values()) {
    const flags = judgeRevisitCadence(entry.days);
    if (flags.length === 0) continue;
    const filing = {
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
    };
    cadenceByCustomer.set(entry.customerId, [...(cadenceByCustomer.get(entry.customerId) ?? []), filing]);
    result.cadenceFlagged += 1;
  }
  await mapWithConcurrency([...cadenceByCustomer.values()], FILINGS_AT_ONCE, async (filings) => {
    for (const filing of filings) await fileCustomerCadenceFlag(filing);
  });
  return whole;
}

/**
 * Pass 3 — every active place against the brick it is filed under.
 *
 * The whole table and not a window: a place's distance from its brick does not change with time, and
 * a place validated last month is as wrongly filed today as it was then. The upsert key means a place
 * already filed is re-stamped rather than duplicated.
 *
 * Since 2026-10-16 the read also carries each place's photograph fix and path, and the active places
 * come back for the fifth pass whenever they were read whole (`WholeRead`).
 */
async function runCoverage(result: SilentSweepResult): Promise<WholeRead> {
  const read = await readEveryPage<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_places")
        .select(
          "id, seat_id, customer_id, created_by_hr_id, lat, lon, accuracy_meters, captured_at, brick_distance_km, brick_lookup, is_test, status, photo_lat, photo_lon, photo_accuracy_meters, photo_captured_at, photo_path",
        )
        .eq("is_test", false)
        .eq("status", "active")
        .order("id", { ascending: true }),
    { maxRows: SILENT_READ_MAX, whenFull: "stop", what: "Phoenix CRM places for the coverage check", uniqueBy: (row) => String(row.id) },
  );
  throwIfError(read.error);
  if (read.capped) result.capped = true;
  result.placesRead = read.rows.length;

  // One finding per place, so no two filings share a subject; filed a few at a time after the walk.
  const filings: Parameters<typeof filePlaceCoverageFlag>[0][] = [];
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
    filings.push({
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
  await mapWithConcurrency(filings, FILINGS_AT_ONCE, (filing) => filePlaceCoverageFlag(filing));
  return read.capped ? null : read.rows;
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

  // One filing per venue, so no two share a subject; filed a few at a time after the walk.
  const filings: Parameters<typeof filePlaceCaptureTrust>[0][] = [];
  for (const venue of read.rows) {
    const pinFix = fixOf(venue.pin_lat, venue.pin_lon, venue.pin_accuracy_meters, venue.captured_at);
    const photoFix = fixOf(venue.photo_lat, venue.photo_lon, venue.photo_accuracy_meters, venue.photo_captured_at);
    // The filer itself refuses an unmeasured pair; asking here as well keeps a venue with one fix
    // out of the write path entirely rather than relying on the filer's own guard.
    if (!assessCaptureTrust({ locationFix: pinFix, photoFix }).measured) continue;
    const capturedAt = new Date(Date.parse(String(venue.captured_at ?? "")) || Date.now());
    const accuracy = venue.accuracy_meters === null || venue.accuracy_meters === undefined ? null : Number(venue.accuracy_meters);
    result.venuesMeasured += 1;
    filings.push({
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
  await mapWithConcurrency(filings, FILINGS_AT_ONCE, (filing) => filePlaceCaptureTrust(filing));
}

/**
 * Pass 5 — every visit in the window against the PHOTOGRAPH of the place it names (2026-10-13).
 *
 * THE PHOTOGRAPH IS THE ANCHOR AND THE PIN IS DROPPED FROM THE JUDGEMENT (owner, 13 October 2026).
 * A photograph carries the fix its own shutter took at the door; a pin can be saved from anywhere.
 * So this pass measures the rep's own visit fix against the photograph and nothing else, and the
 * metres it files are the metres the panel prints.
 *
 * 🔴 IT MEASURES AGAINST A PHOTOGRAPH CAPTURED BEFORE THE VISIT, which is not a tidy detail: a
 * clinic validated in October must not retroactively make a September visit far — nor near. That is
 * the rule `placesFor` in `server/visit-locations.ts` carries for the stored distance, and the
 * fallback is the other half of the owner's 2026-09-29 ruling: a customer visited BEFORE he was
 * validated is measured against the place the validation captured, which is the EARLIEST one.
 *
 * 🔴 AND IT FILES A MANAGER'S OWN VISIT UNDER HIS OWN NAME (corrected 13 Oct 2026, hours after the
 * pass shipped). An empty `rep_hr_id` is not a lost rep: a manager entering a single visit on a
 * territory IS the person on it, and `scope.ts` writes `manager_hr_id` and no rep deliberately. The
 * first spelling of this pass read the rep column alone and skipped all 17 such rows on production —
 * one of them 3,236 m from the photograph of the place it names, past the line and past both
 * accuracy margins, visible to nothing. `personOnTheVisit` answers whose visit it is, so the board
 * still prints a NAME beside every case and nothing is filed against nobody.
 *
 * The flags are weak, nobody is told, nothing is refused and nothing is held — this file's four
 * rules hold for this pass exactly as they do for the others.
 *
 * `wholeReads` carries the window's visits and the active places as passes 1 and 3 read them, when
 * each was read whole — the same rows, already in hand, so they are narrowed here rather than read
 * twice (`WholeRead` says why only a whole read is reused). A read that stopped at its ceiling is
 * null, and the pass then reads for itself exactly as it always did.
 */
async function runVisitPhotographGap(
  todayIso: string,
  result: SilentSweepResult,
  wholeReads: { visits: WholeRead; places: WholeRead },
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const fromIso = isoDaysBefore(todayIso, SILENT_SWEEP_DAYS);

  // The far line is the module's own setting, read live — never a constant in this file, so this
  // detector and a visit's own stored `location_flag` can never disagree about what far means.
  const config = await loadPhoenixCrmConfig();
  const farMeters = config.settings.visitFarMeters;

  const [visitRead, placeRead] = await Promise.all([
    // Pass 1's window, kept to the visits with a reading — the `.not("lat", "is", null)` below.
    wholeReads.visits
      ? narrowedFrom(wholeReads.visits, (visit) => visit.lat !== null && visit.lat !== undefined)
      : readEveryPage<Row>(
          () =>
            supabase
              .from("phoenix_crm_visits")
              .select("id, seat_id, rep_hr_id, manager_hr_id, customer_id, visit_date, captured_at, lat, lon, accuracy_meters")
              .eq("is_test", false)
              .gte("visit_date", fromIso)
              .lte("visit_date", todayIso)
              // A visit with no reading has nothing to measure: one the Super Admin entered for a rep who
              // missed logging it carries none by design, and it accuses nobody.
              .not("lat", "is", null)
              .order("visit_date", { ascending: true })
              .order("id", { ascending: true }),
          { maxRows: SILENT_READ_MAX, whenFull: "stop", what: "Phoenix CRM visits for the photograph check", uniqueBy: (row) => String(row.id) },
        ),
    // Pass 3's active places, kept to those whose photograph carries a fix — the `.not("photo_lat", …)` below.
    wholeReads.places
      ? narrowedFrom(wholeReads.places, (place) => place.photo_lat !== null && place.photo_lat !== undefined)
      : readEveryPage<Row>(
          () =>
            supabase
              .from("phoenix_crm_places")
              .select("id, seat_id, customer_id, captured_at, photo_lat, photo_lon, photo_accuracy_meters, photo_captured_at, photo_path")
              .eq("is_test", false)
              .eq("status", "active")
              // Only a place whose photograph carries its own fix can be an anchor. One captured before
              // the shutter reading shipped has no photograph reading at all, and an absent anchor is
              // never a finding.
              .not("photo_lat", "is", null)
              .order("id", { ascending: true }),
          { maxRows: SILENT_READ_MAX, whenFull: "stop", what: "Phoenix CRM places for the photograph check", uniqueBy: (row) => String(row.id) },
        ),
  ]);
  throwIfError(visitRead.error);
  throwIfError(placeRead.error);
  if (visitRead.capped || placeRead.capped) result.capped = true;

  // Keyed on customer AND seat, exactly as the restamp is: a customer is a row per seat in this
  // module, and keying on the customer alone would measure one territory's visit against another
  // territory's door.
  const placesFor = new Map<string, Row[]>();
  for (const place of placeRead.rows) {
    const customerId = String(place.customer_id ?? "");
    if (customerId === "") continue;
    const key = `${customerId}|${String(place.seat_id ?? "")}`;
    placesFor.set(key, [...(placesFor.get(key) ?? []), place]);
  }

  // One finding per visit, so no two filings share a subject; filed a few at a time after the walk.
  const filings: Parameters<typeof fileVisitPhotographGap>[0][] = [];
  for (const visit of visitRead.rows) {
    // The rep, or the manager whose own single visit this is — the header's second rule.
    const repHrId = personOnTheVisit({
      repHrId: visit.rep_hr_id ? String(visit.rep_hr_id) : null,
      managerHrId: visit.manager_hr_id ? String(visit.manager_hr_id) : null,
    }) ?? "";
    const customerId = visit.customer_id ? String(visit.customer_id) : "";
    const visitDate = String(visit.visit_date ?? "");
    if (!repHrId || !customerId || !visitDate) continue;
    const candidates = placesFor.get(`${customerId}|${String(visit.seat_id ?? "")}`) ?? [];
    if (candidates.length === 0) continue;

    // Captured before this visit, else the earliest — the rule above, in three lines.
    const capturedAtIso = typeof visit.captured_at === "string" ? visit.captured_at : "";
    const earlier = capturedAtIso === "" ? candidates : candidates.filter((place) => String(place.captured_at ?? "") <= capturedAtIso);
    const eligible = earlier.length > 0
      ? earlier
      : [candidates.reduce((held, place) => (String(place.captured_at ?? "") < String(held.captured_at ?? "") ? place : held), candidates[0]!)];

    const visitFix = {
      lat: Number(visit.lat),
      lon: Number(visit.lon),
      accuracyMeters: visit.accuracy_meters === null || visit.accuracy_meters === undefined ? null : Number(visit.accuracy_meters),
    };
    // The NEAREST eligible photograph, because a customer with two clinics is at whichever door the
    // rep stood at: judging him against the further one would file a finding the data itself refutes.
    let nearest: { place: Row; metres: number; flags: PhoenixCrmIntegrityFlag[] } | null = null;
    for (const place of eligible) {
      const verdict = judgeVisitAgainstPhotograph({
        visit: visitFix,
        photograph: {
          lat: Number(place.photo_lat),
          lon: Number(place.photo_lon),
          accuracyMeters:
            place.photo_accuracy_meters === null || place.photo_accuracy_meters === undefined ? null : Number(place.photo_accuracy_meters),
        },
        farMeters,
      });
      if (verdict.metres === null) continue;
      if (nearest === null || verdict.metres < nearest.metres) nearest = { place, metres: verdict.metres, flags: verdict.flags };
    }
    if (nearest === null) continue;
    result.visitsAgainstPhotograph += 1;
    if (nearest.flags.length === 0) continue;

    const capturedAt = new Date(Date.parse(capturedAtIso) || Date.parse(`${visitDate}T12:00:00Z`));
    filings.push({
      visitId: String(visit.id),
      seatId: String(visit.seat_id ?? ""),
      repHrId,
      customerId,
      isTest: false,
      capturedAt,
      visitDate,
      flags: nearest.flags,
      fix: visitFix,
      // 🔴 THE PHOTOGRAPH'S OWN PATH TRAVELS AS `photoPath`, because that is the key the board's
      // reader already prefers for the picture it draws: what a reader judges this case on is the
      // PLACE's photograph, and the visit itself keeps no picture (a one-tap visit keeps none by
      // design). Every number the panel prints is filed here beside it rather than re-derived.
      signals: {
        metresFromPhotograph: Math.round(nearest.metres),
        farMeters,
        placeId: String(nearest.place.id),
        photoPath: typeof nearest.place.photo_path === "string" && nearest.place.photo_path !== "" ? nearest.place.photo_path : null,
        photographAccuracyMeters:
          nearest.place.photo_accuracy_meters === null || nearest.place.photo_accuracy_meters === undefined
            ? null
            : Number(nearest.place.photo_accuracy_meters),
        photographAtIso: typeof nearest.place.photo_captured_at === "string" ? nearest.place.photo_captured_at : null,
        visitAccuracyMeters: visitFix.accuracyMeters,
        placesConsidered: eligible.length,
      },
    });
    result.visitPhotoFlagged += 1;
  }
  await mapWithConcurrency(filings, FILINGS_AT_ONCE, (filing) => fileVisitPhotographGap(filing));
}

/**
 * Run all five passes. Sequential on purpose: they share the cron's window with the photo, signboard
 * and behaviour passes, and four concurrent full-table walks on a 16 GB box is how a night gets reaped.
 *
 * Still sequential, in the same order, since 2026-10-16 — what changed is that the fifth pass is
 * handed the window's visits and the active places that passes 1 and 3 already read, instead of
 * walking both tables a second time (only when they were read whole: see `WholeRead`).
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
    visitsAgainstPhotograph: 0,
    visitPhotoFlagged: 0,
    capped: false,
  };
  const todayIso = options.today && /^\d{4}-\d{2}-\d{2}$/.test(options.today) ? options.today : cairoBusinessDay(new Date());
  const windowVisits = await runRosterAndCadence(todayIso, result);
  const activePlaces = await runCoverage(result);
  await runSharedVenues(result);
  await runVisitPhotographGap(todayIso, result, { visits: windowVisits, places: activePlaces });
  return result;
}
