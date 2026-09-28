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
 *     vendor time; `crm_save_date` and `check_date` are read as written.
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
  addVisitToSplit,
  emptyVisitCountSplit,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";
import { canonicalHrIdKey } from "@/lib/hr-id";

/** A visit row as the unified CRM view serves it. Vendor times are wall-clock strings (rule 3). */
export type FieldActivityVisitRow = {
  visitDate: string;
  agentHrId: string | null;
  agentName: string | null;
  agentCrmId: number | null;
  doubleHrId: string | null;
  doubleName: string | null;
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
  /** Minutes from door to log, crossing midnight where the rep batched the day the next morning. */
  logLagMinutes: number | null;
  lat: number;
  lon: number;
  address: string | null;
  /** Straight-line metres from the previous stop; null on the first. */
  legMetres: number | null;
  /** Whose phone recorded the fix, when it was not the subject's own. */
  viaName: string | null;
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
};

export type FieldActivityDayKind = "field" | "field-no-gps" | "leave" | "office" | "weekend" | "empty";

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

/** A visit the subject is on — as the agent himself, or tagged as the double-visit partner. */
function subjectIsOn(visit: FieldActivityVisitRow, subjectHrId: string): boolean {
  return sameHrId(visit.agentHrId, subjectHrId) || sameHrId(visit.doubleHrId, subjectHrId);
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
  /** Every visit recorded by the partners on those days, used ONLY to count their solo calls. */
  partnerVisits?: FieldActivityVisitRow[];
  trips: FieldActivityTripRow[];
  punches: FieldActivityPunchRow[];
  leave: FieldActivityLeaveRow[];
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
  const checkinKey = (agentCrmId: number | null, contactCrmId: number | null, day: string | null) =>
    `${agentCrmId ?? "?"}|${contactCrmId ?? "?"}|${day ?? "?"}`;
  const checkinIndex = new Map<string, FieldActivityCheckinRow>();
  for (const checkin of input.checkins) {
    const day = calendarDay(checkin.checkedAt);
    const key = checkinKey(checkin.agentCrmId, checkin.contactCrmId, day);
    const existing = checkinIndex.get(key);
    // The EARLIEST fix at a customer is the arrival; a rep who re-checks in at the same door later
    // would otherwise move his own arrival forward.
    if (!existing || String(checkin.checkedAt) < String(existing.checkedAt)) checkinIndex.set(key, checkin);
  }

  const tripsByDay = new Map(input.trips.map((trip) => [calendarDay(trip.tripDate) ?? trip.tripDate, trip]));
  const punchesByDay = new Map(input.punches.map((punch) => [punch.dateIso, punch]));

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
    const leave = input.leave.find((row) => row.startDate <= dateIso && row.endDate >= dateIso) ?? null;
    const punches = punchesByDay.get(dateIso) ?? null;
    const trip = tripsByDay.get(dateIso) ?? null;

    const counts = emptyVisitCountSplit();
    const stops: FieldActivityStop[] = [];
    const unlocated: FieldActivityUnlocatedVisit[] = [];
    const partners = new Map<string, { hrId: string | null; name: string }>();

    for (const visit of dayVisits) {
      // Who he was out with: the other name on the row.
      const partnerIsAgent = !sameHrId(visit.agentHrId, subjectHrId);
      const partnerName = partnerIsAgent ? visit.agentName : visit.doubleName;
      const partnerHrId = partnerIsAgent ? visit.agentHrId : visit.doubleHrId;
      if (partnerName) partners.set(partnerName, { hrId: partnerHrId, name: partnerName });

      const counted = isCustomerCall(visit);
      if (counted) {
        addVisitToSplit(counts, {
          ampm: visit.ampm,
          comment: visit.comment,
          speciality: visit.speciality,
          visit_type: visit.visitType,
          visit_type_description: visit.visitTypeDescription,
        });
      }

      const checkin = checkinIndex.get(checkinKey(visit.agentCrmId, visit.contactCrmId, dateIso));
      const savedClock = wallClock(visit.savedAt);
      const savedDay = calendarDay(visit.savedAt);

      if (checkin && checkin.lat != null && checkin.lon != null) {
        const checkedClock = wallClock(checkin.checkedAt);
        if (checkedClock) {
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
            logLagMinutes: logLag(dateIso, checkedClock, savedClock, savedDay),
            lat: checkin.lat,
            lon: checkin.lon,
            address: checkin.address,
            legMetres: null,
            viaName: partnerIsAgent ? visit.agentName : null,
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
    const lags = stops.map((s) => s.logLagMinutes).filter((value): value is number => value != null);
    const countedTotal = counts.am + counts.pm + counts.pharmacies;

    const notes: string[] = [];
    let kind: FieldActivityDayKind;
    if (stops.length > 0) kind = "field";
    else if (dayVisits.length > 0) kind = "field-no-gps";
    else if (leave) kind = "leave";
    else if (punches) kind = "office";
    else if (isWeekendIso(dateIso)) kind = "weekend";
    else kind = "empty";

    // Approved leave with a visit recorded against it is the one contradiction worth shouting
    // about: it means somebody logged a call for a person who was not working that day.
    if (leave && dayVisits.length > 0) {
      kind = "leave";
      const message =
        `A customer call is recorded against him on a day of approved ` +
        `${(leave.type ?? "leave").toLowerCase()} leave.`;
      notes.push(message);
      flags.push({ dateIso, message });
    }
    if (kind === "field-no-gps" && !leave) {
      notes.push("The day's call carries no GPS check-in, so where he stood cannot be shown.");
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
      notes,
    });
  }

  const totals = days.reduce(
    (acc, day) => {
      acc.counts.am += day.counts.am;
      acc.counts.pm += day.counts.pm;
      acc.counts.pharmacies += day.counts.pharmacies;
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
