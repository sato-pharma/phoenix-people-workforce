/**
 * Field Activity — the report model, assembled from raw rows.
 *
 * WHAT THIS ANSWERS. For one person and one period: where was he each day, who was he with, which
 * customers did he stand in front of, at what time did his phone put him there, when was each call
 * actually typed in, how far did he move, what did he claim, and — when there is no field record at
 * all — why. It is the report the owner asked for on 2026-09-28 after a week of asking those
 * questions one at a time in chat.
 *
 * WHY IT IS PURE. Every rule below is a business rule that has already cost a wrong answer once, and
 * a rule that can only be exercised through Supabase is a rule that is never exercised. The loader
 * (report.ts) does nothing but fetch rows and hand them here, so `tests/field-activity-model.test.ts`
 * can put a day in front of this function and assert the verdict.
 *
 * THE FIVE RULES IT ENFORCES, each one measured on production while the report was built by hand:
 *
 *  1. A CHECK-IN IS NOT A LOG. iReports360 records when a rep SAVED a call, not when he stood at the
 *     door; the GPS check-in is the door. They differ by 57 to 231 minutes on the days measured, and
 *     a report that prints one under the other's name answers "when did he finish work" wrongly. Both
 *     are carried on every stop, with the gap.
 *
 *  2. A MANAGER LOGS NO VISITS OF HIS OWN, so his GPS is the REP's. On a double visit the rep enters
 *     the call and tags the manager, and the check-in belongs to the rep's phone. A report that looks
 *     for the manager's own check-ins shows him an empty map on a day he worked. The check-in is
 *     therefore matched through the VISIT — same rep, same contact, same day — which is also what
 *     keeps the rep's SOLO stops out of the manager's route.
 *
 *  3. THE VENDOR CLOCK IS ALREADY CAIRO. `saveDate`/`checkDate` arrive zone-less and Postgres tags
 *     them `+00`, so the stored reading is the wall clock. Converting it to Africa/Cairo adds the
 *     offset a second time and reports every call two to three hours late. Nothing here shifts a
 *     vendor time; `crm_save_date` and `check_date` are read as written. That holds for a Phoenix
 *     CRM visit too: `crm_visits_unified` hands its `captured_at` over already converted, in the
 *     vendor's own shape. The one value on this report that is a REAL instant — the outstation
 *     claim's own GPS fix — is converted ONCE at the loader ({@link cairoWallClockIso}), so every
 *     clock in the document speaks the same convention and none of them is shifted twice.
 *
 *  4. AM · PM · PHARMACIES, THREE FIGURES APART. Never averaged, never joined, and a pharmacy is
 *     never counted inside PM whatever period the vendor tagged. There is one bucket helper in this
 *     repository and this module calls it rather than carrying a second opinion.
 *
 *  5. AN EMPTY DAY IS NOT AN IDLE DAY. Approved leave, a public weekend and a head-office day all
 *     produce no field record, and reading any of them as "did nothing" accuses somebody of
 *     something the data does not say. Each is resolved and named.
 */

import {
  phoenixRowSight,
  phoenixVisitDetail,
  type PhoenixDetailViewer,
  type PhoenixVisitDetail,
  type PhoenixVisitDetailRow,
} from "@/lib/crm/phoenix-visit-detail";
import {
  addVisitToSplit,
  emptyVisitCountSplit,
  mergeVisitCountSplits,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";
import { isPhoenixNativeVisitRow } from "@/lib/crm/phoenix-team-starts";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { cairoWallClock } from "@/lib/format/cairo-zone";

/** A visit row as the unified CRM view serves it. Vendor times are wall-clock strings (rule 3). */
export type FieldActivityVisitRow = PhoenixVisitDetailRow & {
  visitDate: string;
  agentHrId: string | null;
  agentName: string | null;
  agentCrmId: number | null;
  doubleHrId: string | null;
  doubleName: string | null;
  /** A chain visit's SECOND manager. Slot 1 is `coalesce(manager, product_manager, senior)`, so a row
   * that carries somebody here carries somebody there too — the two slots never hold one person. */
  double2HrId: string | null;
  double2Name: string | null;
  /** Everyone on a Phoenix visit besides the rep (the door's `companion_hr_ids`, owner 2026-10-27:
   * "Everything is applicable") — the two slots above hold only the first two. Absent on a vendor row. */
  companions?: Array<{ hrId: string; name: string | null }>;
  contactCrmId: number | null;
  contactName: string | null;
  speciality: string | null;
  contactGrade: string | null;
  ampm: string | null;
  visitType: number | null;
  visitTypeDescription: string | null;
  comment: string | null;
  /** `crm_save_date`, read as stored — a Cairo wall clock, never converted. */
  savedAt: string | null;
  /**
   * 'phoenix' on a started team's Phoenix CRM visit, 'ireports360' on a vendor row. Phoenix CRM logs no
   * pharmacy visit, so the day's counts say its pharmacy figure was never recorded rather than print 0
   * (src/lib/crm/visit-count-buckets.ts). Optional: a row without it reads as a vendor row.
   */
  source?: string | null;
};

export type FieldActivityCheckinRow = {
  agentCrmId: number | null;
  agentHrId: string | null;
  contactCrmId: number | null;
  contactName: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  /** `check_date`, read as stored. */
  checkedAt: string | null;
};

export type FieldActivityTripRow = {
  reference: string;
  tripDate: string;
  destination: string | null;
  transport: string | null;
  distanceKm: number | null;
  durationMinutes: number | null;
  minimumKm: number | null;
  fuel: number;
  allowance: number;
  tickets: number;
  meeting: number;
  other: number;
  claimedTotal: number;
  approvedTotal: number | null;
  status: string | null;
  eligibility: string | null;
  recommendation: string | null;
  evidenceGate: string | null;
  workloadGate: string | null;
  workload: { am: number | null; pm: number | null; pharmacies: number | null };
  /** The claim's own GPS fix, as a CAIRO WALL CLOCK — `cairoWallClockIso` of a real instant. */
  capturedAt: string | null;
  capturedLat: number | null;
  capturedLon: number | null;
  capturedAccuracyMeters: number | null;
  submittedAt: string | null;
};

export type FieldActivityPunchRow = {
  dateIso: string;
  firstTime: string | null;
  lastTime: string | null;
  count: number;
};

export type FieldActivityLeaveRow = {
  reference: string | null;
  type: string | null;
  dayPart: string | null;
  startDate: string;
  endDate: string;
  status: string | null;
  paymentStatus: string | null;
  managerName: string | null;
  managerDecisionAt: string | null;
  hrDecisionAt: string | null;
  submittedAt: string | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
};

export type FieldActivitySubject = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
  regionName: string | null;
};

export type FieldActivityStop = {
  index: number;
  contactCrmId: number | null;
  customerName: string;
  speciality: string | null;
  grade: string | null;
  ampm: string | null;
  /** Wall clock "HH:MM:SS" of the GPS check-in. */
  checkedAt: string;
  /** Wall clock "HH:MM:SS" of the log. */
  savedAt: string | null;
  /** Calendar day the log landed on, when it was not the visit's own day. */
  savedOn: string | null;
  /**
   * Minutes from door to log, crossing midnight where the rep batched the day the next morning.
   *
   * 🔴 NULL ON A PHOENIX CRM VISIT — NOT MEASURED, NEVER ZERO. A Phoenix visit is its own check-in, so
   * its "door" and its "log" are one timestamp and the subtraction is always 0. Printed, that read as
   * "logged 0 min later" on every stop and "average 0 min after the door" on every day — a figure
   * nobody measured (live audit, 2026-10-26, the Pedia National Sales Manager's 54 visits).
   */
  logLagMinutes: number | null;
  /** A Phoenix CRM visit (`source = 'phoenix'`): its check-in and its log are the same moment. */
  phoenixVisit: boolean;
  /** How long the Phoenix visit form was open, in seconds — null on an iReports360 stop or when unrecorded. */
  formOpenSeconds: number | null;
  lat: number;
  lon: number;
  address: string | null;
  /** Straight-line metres from the previous stop; null on the first. */
  legMetres: number | null;
  /** Whose phone recorded the fix, when it was not the subject's own. */
  viaName: string | null;
  /** The Phoenix field set at this reader's tier, or null on an iReports360 row. */
  phoenix: PhoenixVisitDetail | null;
};

/** A call on the day that carries no GPS fix — no contact attached, or the subject's own record. */
export type FieldActivityUnlocatedVisit = {
  ampm: string | null;
  savedAt: string | null;
  savedOn: string | null;
  label: string;
  comment: string | null;
  /** Whether it is a customer call at all — a Traveling record never counts toward the buckets. */
  counts: boolean;
  /**
   * The Phoenix field set at this reader's tier, or null on an iReports360 row.
   *
   * 🔴 THIS IS WHERE A PHOENIX VISIT LANDS, and it is why the field set matters most here. A Phoenix
   * visit IS its own check-in, so it never matches an iReports360 GPS fix and every one of them falls
   * into this list — the list the report introduces as work with no GPS behind it. Its own distance,
   * products and evidence were measured all along and simply had nowhere to be printed, so a day a rep
   * spent in the field read as a day nothing was recorded. That is the owner's reported sentence.
   */
  phoenix: PhoenixVisitDetail | null;
};

/**
 * A single visit the subject logged ALONE as a manager, on his own (owner, 2026-10-20, multiple choice: "Show, keep
 * out of reps — his own visits appear under his name in the Visit Report and the Field Activity day, never in a
 * rep's totals. Still no GPS or photo required").
 *
 * 🔴 A DISPLAY ROW, NEVER A COUNT. It is listed on his day and added to none of the day's AM, PM or pharmacy
 * figures, none of the period's totals and no field-day count. It carries no position and no photo verdict — his own
 * visit is asked for neither — so nothing on this report can read its absence as something he failed to do. The
 * loader reads it through `manager-plan-readers.ts`, the one door out of his own visits' table.
 */
export type FieldActivityOwnVisitRow = {
  /** The Cairo calendar day, YYYY-MM-DD. */
  date: string;
  /** The half of the day it was planned in, or the Cairo half it was logged in. */
  half: "AM" | "PM";
  /** When it was logged, as a CAIRO WALL CLOCK (`cairoWallClockIso` of the real instant), or null. */
  loggedAt: string | null;
  customerName: string;
  speciality: string | null;
  grade: string | null;
  /** The street, the brick and the area, as one line, or null when none was kept. */
  where: string | null;
  planned: boolean;
  /** A doctor of a vacant area, logged by the manager while the seat was empty. */
  inVacantTerritory: boolean;
  products: string[];
  comment: string | null;
};

/** One of his own visits as the day prints it: the row, with its log time read as a clock. */
export type FieldActivityOwnVisit = Omit<FieldActivityOwnVisitRow, "loggedAt" | "date"> & {
  /** Wall clock "HH:MM:SS" of the log, or null. */
  loggedAt: string | null;
};

export type FieldActivityDayKind = "field" | "field-no-gps" | "leave" | "own-visits" | "office" | "weekend" | "empty";

export type FieldActivityDay = {
  dateIso: string;
  weekday: string;
  kind: FieldActivityDayKind;
  /** The people he was out with that day, named. */
  partners: Array<{ hrId: string | null; name: string }>;
  territory: string | null;
  counts: VisitCountSplit;
  countedTotal: number;
  stops: FieldActivityStop[];
  unlocated: FieldActivityUnlocatedVisit[];
  firstCheckin: string | null;
  lastCheckin: string | null;
  onTerritoryMinutes: number | null;
  firstLog: string | null;
  lastLog: string | null;
  logsLandedNextDay: boolean;
  averageLogLagMinutes: number | null;
  movementMetres: number;
  trip: FieldActivityTripRow | null;
  punches: FieldActivityPunchRow | null;
  leave: FieldActivityLeaveRow | null;
  /** Calls the partner recorded that day WITHOUT the subject on them. Never counted here. */
  partnerSoloCalls: number;
  /**
   * The single visits he logged alone that day, as a manager — listed, counted in nothing (owner, 2026-10-20).
   * Empty for anybody who is not a manager, and on every day he logged none.
   */
  ownVisits: FieldActivityOwnVisit[];
  /** Anything the report should say out loud about this day. */
  notes: string[];
};

export type FieldActivityReport = {
  subject: FieldActivitySubject;
  fromIso: string;
  toIso: string;
  days: FieldActivityDay[];
  totals: {
    counts: VisitCountSplit;
    countedTotal: number;
    fieldDays: number;
    stops: number;
    movementMetres: number;
    claimedTotal: number;
    tripCount: number;
  };
  /** Days that carry a record the report cannot reconcile — surfaced, never hidden. */
  flags: Array<{ dateIso: string; message: string }>;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function weekdayOf(dateIso: string): string {
  // UTC on purpose: a date-only value pinned to UTC midnight cannot drift onto the previous day.
  return WEEKDAYS[new Date(`${dateIso}T00:00:00Z`).getUTCDay()] ?? "";
}

/** Friday is the Egyptian weekend. A Friday with no record is expected, not an absence. */
export function isWeekendIso(dateIso: string): boolean {
  return weekdayOf(dateIso) === "Friday";
}

export function eachDateIso(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const end = new Date(`${toIso}T00:00:00Z`).getTime();
  for (let t = new Date(`${fromIso}T00:00:00Z`).getTime(); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** "2026-09-20T14:03:52" or "2026-09-20 14:03:52+00" -> "14:03:52". Never shifts the clock. */
export function wallClock(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value));
  if (!match) return null;
  return `${match[1]}:${match[2]}:${match[3] ?? "00"}`;
}

/**
 * A REAL instant, rewritten as the Cairo wall clock the rest of this report speaks in.
 *
 * Rule 3 says nothing shifts a vendor time, because a vendor time is already a Cairo wall clock
 * wearing a `+00` label. The outstation claim's own GPS fix is the opposite kind of value: a true
 * `timestamptz`, stamped when the rep opened the claim. Sliced like a wall clock it prints two or
 * three hours early — measured on production 2026-10-04, B-1's 21:34 Cairo fix printed as 18:34 on
 * a page whose CRM visit times were correct Cairo to the second, which is exactly the "the module
 * and the CRM disagree about the time" the owner reported on 2026-10-05.
 *
 * Converted here, at the seam, and never again downstream: the result keeps the date (so the PDF
 * route's `slice(11, 16)` and the document's `clock12` both still read it) and carries no zone, so
 * nothing can take it for an instant and shift it a second time.
 *
 * The offset comes from `cairoWallClock`'s shipped table, not from `Intl`: Egypt abolished daylight
 * saving in 2014 and reintroduced it in 2023, so an engine's own answer depends on how old its
 * timezone data is (`src/lib/format/cairo-zone.ts`). This runs on the server, where that is not the
 * hydration hazard it is in a client component — but there is one way to say "Cairo" in this
 * repository and a second one is how the two drift apart.
 */
export function cairoWallClockIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  // A carrier for the digits, never a real instant — read its UTC fields and nothing else.
  return cairoWallClock(instant).toISOString().slice(0, 19);
}

export function calendarDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function minutesOfDay(clock: string | null | undefined): number | null {
  if (!clock) return null;
  const match = /^(\d{2}):(\d{2})/.exec(clock);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Straight-line metres. Used for "how far did he move between doors", never for a road distance. */
export function haversineMetres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const radius = 6_371_000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * radius * Math.asin(Math.sqrt(h)));
}

function sameHrId(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = canonicalHrIdKey(left ?? null);
  const b = canonicalHrIdKey(right ?? null);
  return Boolean(a) && a === b;
}

/**
 * Minutes from the check-in to the log, carrying the calendar day.
 *
 * A rep who batches his day the next morning logs at 10:00 against a 16:20 door — a same-day
 * subtraction reads as minus six hours, which then prints as a negative lag and poisons the average.
 */
function logLag(day: string, checkedAt: string, savedAt: string | null, savedOn: string | null): number | null {
  const from = minutesOfDay(checkedAt);
  const to = minutesOfDay(savedAt);
  if (from == null || to == null) return null;
  const dayShift = savedOn && savedOn !== day
    ? Math.round((new Date(`${savedOn}T00:00:00Z`).getTime() - new Date(`${day}T00:00:00Z`).getTime()) / 86_400_000)
    : 0;
  return to + dayShift * 1440 - from;
}

/**
 * A visit the subject is on — as the agent himself, or tagged in EITHER ride-along slot.
 *
 * Slot 2 is not optional here. `participantHrIds` at the door already returns the row where he is
 * the chain visit's second manager, and testing one slot threw it away again — which is the owner's
 * reported sentence in code: the day he spent in the field reads as a day he did not work.
 */
function subjectIsOn(visit: FieldActivityVisitRow, subjectHrId: string): boolean {
  return (
    sameHrId(visit.agentHrId, subjectHrId) ||
    sameHrId(visit.doubleHrId, subjectHrId) ||
    sameHrId(visit.double2HrId, subjectHrId) ||
    (visit.companions ?? []).some((companion) => sameHrId(companion.hrId, subjectHrId))
  );
}

/** A vendor code that is not a customer call. -12 Traveling, -5/-6 leave, -19 meeting and friends. */
function isCustomerCall(visit: FieldActivityVisitRow): boolean {
  return (visit.visitType ?? 0) >= 0 || (visit.contactCrmId != null && visit.contactCrmId > 0);
}

export function buildFieldActivityReport(input: {
  subject: FieldActivitySubject;
  fromIso: string;
  toIso: string;
  visits: FieldActivityVisitRow[];
  checkins: FieldActivityCheckinRow[];
  /**
   * The single visits the subject logged alone as a manager — DISPLAY ONLY: each is listed on its day and none is
   * added to any count, total or field-day figure (owner, 2026-10-20: "Show, keep out of reps"). Optional, so a
   * caller with none passes nothing.
   */
  ownVisits?: FieldActivityOwnVisitRow[];
  /** Every visit recorded by the partners on those days, used ONLY to count their solo calls. */
  partnerVisits?: FieldActivityVisitRow[];
  trips: FieldActivityTripRow[];
  punches: FieldActivityPunchRow[];
  leave: FieldActivityLeaveRow[];
  /**
   * Who is reading, so each Phoenix row's field set is shaped to his sight tier and blinded on a row
   * whose rep is himself (golden rule #1's three tiers). Omitted → no Phoenix half at all, which is
   * exactly the behaviour before 2026-10-07.
   */
  viewer?: PhoenixDetailViewer;
}): FieldActivityReport {
  const { subject, fromIso, toIso } = input;
  const subjectHrId = subject.hrId;

  const visitsByDay = new Map<string, FieldActivityVisitRow[]>();
  for (const visit of input.visits) {
    if (!subjectIsOn(visit, subjectHrId)) continue;
    const day = calendarDay(visit.visitDate);
    if (!day) continue;
    const bucket = visitsByDay.get(day) ?? [];
    bucket.push(visit);
    visitsByDay.set(day, bucket);
  }

  // Check-ins are keyed by (recording agent, contact, day) — rule 2. A fix is attached to a visit
  // only when the same phone checked in at the same customer on that day, so the partner's own
  // later stops never appear on the subject's route.
  //
  // 🔴 A NON-REAL CONTACT NEVER MATCHES, ON EITHER SIDE. `0` is the vendor's "no contact"
  // placeholder and NULL is an unresolved one, and the key used to carry both through — `0` as
  // itself and NULL as `?`. So every contact-less row of one agent on one day collapsed onto a
  // single key and matched every other: a Meeting or a Traveling row would have taken the GPS of
  // whatever other contact-less row shared that phone and date, and been drawn as a stop with a
  // time. Rejecting it on BOTH sides is the same rule `indexCheckinsByAgentContactDay` enforces in
  // `@/lib/crm/checkin-match`, whose own comment records that this asymmetry was load-bearing
  // rather than safe. Production has these rows — B-155's September carries four of them.
  const realContact = (contactCrmId: number | null): number | null =>
    contactCrmId != null && contactCrmId !== 0 ? contactCrmId : null;
  const checkinKey = (agentCrmId: number | null, contactCrmId: number | null, day: string | null): string | null => {
    const contact = realContact(contactCrmId);
    if (agentCrmId == null || contact == null || !day) return null;
    return `${agentCrmId}|${contact}|${day}`;
  };
  const checkinIndex = new Map<string, FieldActivityCheckinRow>();
  for (const checkin of input.checkins) {
    const key = checkinKey(checkin.agentCrmId, checkin.contactCrmId, calendarDay(checkin.checkedAt));
    if (key == null) continue;
    const existing = checkinIndex.get(key);
    // The EARLIEST fix at a customer is the arrival; a rep who re-checks in at the same door later
    // would otherwise move his own arrival forward. This is a DELIBERATE departure from
    // `pickCheckinForVisit`, which breaks the same tie toward the save time because it is asking
    // "which fix verifies this call". Here the question is "when did he get there", and the two
    // agree wherever a customer has one fix that day, which is almost every stop.
    if (!existing || String(checkin.checkedAt) < String(existing.checkedAt)) checkinIndex.set(key, checkin);
  }

  const tripsByDay = new Map(input.trips.map((trip) => [calendarDay(trip.tripDate) ?? trip.tripDate, trip]));
  const punchesByDay = new Map(input.punches.map((punch) => [punch.dateIso, punch]));

  const ownVisitsByDay = new Map<string, FieldActivityOwnVisit[]>();
  for (const own of input.ownVisits ?? []) {
    const day = calendarDay(own.date);
    if (!day) continue;
    const shown: FieldActivityOwnVisit = {
      comment: own.comment,
      customerName: own.customerName,
      grade: own.grade,
      half: own.half,
      inVacantTerritory: own.inVacantTerritory,
      loggedAt: wallClock(own.loggedAt),
      planned: own.planned,
      products: own.products,
      speciality: own.speciality,
      where: own.where,
    };
    ownVisitsByDay.set(day, [...(ownVisitsByDay.get(day) ?? []), shown]);
  }
  for (const list of ownVisitsByDay.values()) {
    list.sort((left, right) => left.half.localeCompare(right.half) || String(left.loggedAt ?? "").localeCompare(String(right.loggedAt ?? "")));
  }

  const partnerSoloByDay = new Map<string, number>();
  for (const visit of input.partnerVisits ?? []) {
    if (subjectIsOn(visit, subjectHrId)) continue;
    const day = calendarDay(visit.visitDate);
    if (!day) continue;
    partnerSoloByDay.set(day, (partnerSoloByDay.get(day) ?? 0) + 1);
  }

  const flags: FieldActivityReport["flags"] = [];
  const days: FieldActivityDay[] = [];

  for (const dateIso of eachDateIso(fromIso, toIso)) {
    const dayVisits = visitsByDay.get(dateIso) ?? [];
    const ownVisits = ownVisitsByDay.get(dateIso) ?? [];
    const leave = input.leave.find((row) => row.startDate <= dateIso && row.endDate >= dateIso) ?? null;
    const punches = punchesByDay.get(dateIso) ?? null;
    const trip = tripsByDay.get(dateIso) ?? null;

    const counts = emptyVisitCountSplit();
    const stops: FieldActivityStop[] = [];
    const unlocated: FieldActivityUnlocatedVisit[] = [];
    const partners = new Map<string, { hrId: string | null; name: string }>();

    for (const visit of dayVisits) {
      // Whose phone recorded the day: his own, or — when he rode along — the rep's. Read on its own
      // because a chain visit has TWO ride-along slots, so "the subject is not the agent" can no
      // longer be inferred from which partner column happens to be filled.
      const subjectRodeAlong = !sameHrId(visit.agentHrId, subjectHrId);

      // The field set, at the tier this reader's role earns, blinded where HE is the row's rep —
      // resolved per row, because a District Manager's own report carries his reps' days and his own.
      const phoenix = input.viewer
        ? phoenixVisitDetail(visit, phoenixRowSight(input.viewer, visit.agentHrId))
        : null;

      // Who he was out with: every OTHER person on the row. A chain visit carries three people, so
      // the old agent-or-partner pair named only one of the two he actually rode with.
      for (const person of [
        { hrId: visit.agentHrId, name: visit.agentName },
        { hrId: visit.doubleHrId, name: visit.doubleName },
        { hrId: visit.double2HrId, name: visit.double2Name },
        ...(visit.companions ?? []),
      ]) {
        if (!person.name) continue;
        if (sameHrId(person.hrId, subjectHrId)) continue;
        partners.set(person.name, { hrId: person.hrId, name: person.name });
      }

      const counted = isCustomerCall(visit);
      if (counted) {
        addVisitToSplit(counts, {
          ampm: visit.ampm,
          comment: visit.comment,
          source: visit.source ?? null,
          speciality: visit.speciality,
          visit_type: visit.visitType,
          visit_type_description: visit.visitTypeDescription,
        });
      }

      const visitCheckinKey = checkinKey(visit.agentCrmId, visit.contactCrmId, dateIso);
      const checkin = visitCheckinKey == null ? undefined : checkinIndex.get(visitCheckinKey);
      const savedClock = wallClock(visit.savedAt);
      const savedDay = calendarDay(visit.savedAt);

      if (checkin && checkin.lat != null && checkin.lon != null) {
        const checkedClock = wallClock(checkin.checkedAt);
        if (checkedClock) {
          const phoenixVisit = isPhoenixNativeVisitRow({ source: visit.source ?? null });
          const formOpen = Number(visit.form_open_seconds);
          stops.push({
            index: 0,
            contactCrmId: visit.contactCrmId,
            customerName: visit.contactName ?? checkin.contactName ?? "",
            speciality: visit.speciality,
            grade: visit.contactGrade,
            ampm: visit.ampm,
            checkedAt: checkedClock,
            savedAt: savedClock,
            savedOn: savedDay && savedDay !== dateIso ? savedDay : null,
            // The lag is a measurement of iReports360 only — the vendor app saves a call after the door.
            logLagMinutes: phoenixVisit ? null : logLag(dateIso, checkedClock, savedClock, savedDay),
            phoenixVisit,
            formOpenSeconds:
              phoenixVisit && visit.form_open_seconds != null && Number.isFinite(formOpen) && formOpen > 0
                ? Math.round(formOpen)
                : null,
            lat: checkin.lat,
            lon: checkin.lon,
            address: checkin.address,
            legMetres: null,
            viaName: subjectRodeAlong ? visit.agentName : null,
            phoenix,
          });
          continue;
        }
      }

      unlocated.push({
        ampm: visit.ampm,
        savedAt: savedClock,
        savedOn: savedDay && savedDay !== dateIso ? savedDay : null,
        label: visit.contactName
          ? visit.contactName
          : visit.visitTypeDescription
            ? visit.visitTypeDescription
            : "Call saved with no contact attached",
        comment: visit.comment,
        counts: counted,
        phoenix,
      });
    }

    stops.sort((left, right) => left.checkedAt.localeCompare(right.checkedAt));
    stops.forEach((stop, index) => {
      stop.index = index + 1;
      stop.legMetres = index === 0 ? null : haversineMetres(stops[index - 1], stop);
    });

    const logs = [...stops.map((s) => s.savedAt), ...unlocated.map((u) => u.savedAt)]
      .filter((value): value is string => Boolean(value))
      .sort();
    // A Phoenix stop's lag is null (not measured), so it is left out of the average rather than pulling it to 0.
    const lags = stops.map((s) => s.logLagMinutes).filter((value): value is number => value != null);
    const countedTotal = counts.am + counts.pm + counts.pharmacies;

    const notes: string[] = [];
    let kind: FieldActivityDayKind;
    if (stops.length > 0) kind = "field";
    else if (dayVisits.length > 0) kind = "field-no-gps";
    else if (leave) kind = "leave";
    // A day he spent on his own visits alone is a day he WORKED (rule 5), never "no activity" — and never a
    // "field record with no GPS": his own visit is asked for no position at all.
    else if (ownVisits.length > 0) kind = "own-visits";
    else if (punches) kind = "office";
    else if (isWeekendIso(dateIso)) kind = "weekend";
    else kind = "empty";

    // Approved leave with a visit recorded against it is the one contradiction worth shouting
    // about: it means somebody logged a call for a person who was not working that day.
    if (leave && dayVisits.length > 0) {
      kind = "leave";
      const message =
        `A customer call is recorded against them on a day of approved ` +
        `${(leave.type ?? "leave").toLowerCase()} leave.`;
      notes.push(message);
      flags.push({ dateIso, message });
    }
    if (kind === "field-no-gps" && !leave) {
      notes.push("The day's call carries no GPS check-in, so where they stood cannot be shown.");
    }
    if (stops.length > 0 && stops.every((stop) => stop.savedOn)) {
      notes.push("Every call on this day was logged the following day, not at the door.");
    }
    if (trip && (trip.workloadGate ?? "").toLowerCase().startsWith("pending") && countedTotal > 0) {
      notes.push(
        "The trip claim captured no workload because it was submitted before the day's calls were logged.",
      );
    }

    days.push({
      dateIso,
      weekday: weekdayOf(dateIso),
      kind,
      partners: [...partners.values()],
      territory: null,
      counts,
      countedTotal,
      stops,
      unlocated,
      firstCheckin: stops[0]?.checkedAt ?? null,
      lastCheckin: stops.length > 0 ? stops[stops.length - 1].checkedAt : null,
      onTerritoryMinutes:
        stops.length > 1
          ? (minutesOfDay(stops[stops.length - 1].checkedAt) ?? 0) - (minutesOfDay(stops[0].checkedAt) ?? 0)
          : null,
      firstLog: logs[0] ?? null,
      lastLog: logs.length > 0 ? logs[logs.length - 1] : null,
      logsLandedNextDay: stops.length > 0 && stops.every((stop) => Boolean(stop.savedOn)),
      averageLogLagMinutes: lags.length > 0 ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null,
      movementMetres: stops.reduce((total, stop) => total + (stop.legMetres ?? 0), 0),
      trip,
      punches,
      leave,
      partnerSoloCalls: partnerSoloByDay.get(dateIso) ?? 0,
      ownVisits,
      notes,
    });
  }

  const totals = days.reduce(
    (acc, day) => {
      mergeVisitCountSplits(acc.counts, day.counts);
      acc.countedTotal += day.countedTotal;
      acc.stops += day.stops.length;
      acc.movementMetres += day.movementMetres;
      if (day.kind === "field") acc.fieldDays += 1;
      if (day.trip) {
        acc.claimedTotal += day.trip.claimedTotal;
        acc.tripCount += 1;
      }
      return acc;
    },
    {
      counts: emptyVisitCountSplit(),
      countedTotal: 0,
      fieldDays: 0,
      stops: 0,
      movementMetres: 0,
      claimedTotal: 0,
      tripCount: 0,
    },
  );

  return { subject, fromIso, toIso, days, totals, flags };
}
