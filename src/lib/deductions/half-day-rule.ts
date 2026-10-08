// Unified Deductions module: the HALF-DAY rule — pure, no I/O.
//
// THE QUESTION (owner, 2026-10-08): which district managers and medical reps worked only the
// morning, or only the afternoon, of a full working day — and had nothing on file for the other
// half: no approved vacation, no approved plan item, no pending request, no calendar review
// request. Each such half day is its own deduction row at 0.5 day, and nothing is charged until
// he sets it "Approved for Payroll" himself.
//
// THE DAY. The field week is Saturday to Wednesday, all full days. THURSDAY IS A MORNING-ONLY DAY
// for the field force (owner rule 2026-08-02, restated 2026-10-08), so it has no afternoon to
// miss and is never judged here. Friday is off. National holidays are removed by the caller.
//
// THE HALVES. A CRM row speaks for the half its AM/PM tag names. A row with no tag — and a
// Phoenix "Pharmacy" row, which is a place, not a half — is placed by WHEN it was saved: 06-12 is
// the morning, 13-15 could be either and so covers both, anything else is the afternoon, and a
// row saved on another day says nothing about the hour and covers both. A non-visit activity with
// no tag (a meeting, a training day, a public-holiday shift) is a whole-day activity and covers
// both. Campaign visits (-8) count exactly like regular visits — 12,204 of them since June, and
// reading only regular visits would have flagged 578 worked days.
//
// THE PROOF THAT CLEARS A HALF. The AM/PM tag is NOT the clock. Measured on production for
// August-September 2026: 1,962 visits tagged "PM" carry the rep's own GPS check-in at that
// customer between 09:00 and 12:59. So before a missing half is charged, every timed trace of the
// person in that half clears it:
//   - a GPS check-in of his own (05:00-15:59 is the morning, 13:00 onward the afternoon — the
//     13-15 band is genuinely mixed, 17% of morning check-ins and 24% of afternoon ones, so it
//     clears either half rather than charge on a guess),
//   - the check-in the rep made at the customer of a visit this person is credited on (a manager
//     logs no check-ins; his time is the rep's — dv-checkin-attribution memory),
//   - a row saved 06:00-12:59 on the day clears the morning; one saved from 17:00, or before
//     04:00 the next day, clears the afternoon,
//   - a PHOENIX CRM visit's capture time, read exactly like a check-in. A started team logs no
//     iReports360 check-in at all — the phone captures each visit's location and time instead, and
//     its `ampm` is the customer LIST (AM or PM list), not the hour (owner, 2026-10-08: "when they
//     log a visit the location and time is captured, you can use it"). It only ever clears; it
//     never shows a rep a check-in (phoenix-team-starts.ts).
//
// A PHOENIX VISIT MUST HAVE A LOCATION AND A TIME — "no negotiation" (owner, 2026-10-08). One with
// no location (an admin typing a visit in for the rep, `capture_source` admin, `location_flag`
// no_place: 18 of 726 in its first week) is not field evidence: it fills no half and clears none.
// It is counted on the row's evidence so the reviewer sees it was there. The same condition the
// check-in view already puts on a Phoenix check-in (`lat` and `lon` not null).
// Applied to June-October 2026 that is the difference between 862 apparent half days and 308
// confirmed ones. Every stamp here is Cairo wall-clock tagged UTC (the iReports360 convention, and
// the Phoenix views convert to it), so the hour is read with getUTCHours and never shifted again.
//
// WHAT NEVER REACHES THIS TAB (the day is left alone, not judged):
//   - a CRM Annual Vacation (-4) row on the day, tagged or not — the vacation connector owns it;
//   - an approved FULL-day vacation; any request that is not yet decided or was returned for edit;
//   - a calendar review request on the day that has not been rejected.

import { PHOENIX_VISIT_SOURCE } from "@/lib/crm/phoenix-team-starts.ts";
import { crmVisitTypeMeaningLenient } from "@/lib/crm/visit-type-meaning.ts";

import { compactDeductionsHrId } from "./candidate-key.ts";

export type HalfDaySlot = "AM" | "PM";

/** One CRM row as the half-day rule reads it. Every hour field is Cairo wall-clock tagged UTC. */
export type HalfDayVisitRow = {
  visit_date: string | null;
  visit_type: number | string | null;
  ampm: string | null;
  crm_save_date: string | null;
  agent_hr_id: string | null;
  agent_crm_id: number | string | null;
  double_hr_id: string | null;
  double_crm_id: number | string | null;
  double2_hr_id: string | null;
  double2_crm_id: number | string | null;
  contact_crm_id: number | string | null;
  /** `crm_visits_unified.source` — "phoenix" or "ireports360". Optional so a vendor-only fixture need not carry it. */
  source?: string | null;
  /** A Phoenix visit's captured position. Null on every iReports360 row (its position is its check-in). */
  lat?: number | string | null;
  lon?: number | string | null;
};

export type HalfDayCheckinRow = {
  agent_hr_id: string | null;
  agent_crm_id: number | string | null;
  contact_crm_id: number | string | null;
  check_date: string | null;
};

/** What one person-day carries before it is judged. Built by {@link buildHalfDayEvidence}. */
export type HalfDayEvidence = {
  am: boolean;
  pm: boolean;
  /** A CRM Annual Vacation row — the day belongs to the vacation connector. */
  crmLeave: boolean;
  morningProof: boolean;
  eveningProof: boolean;
  visitsAm: number;
  visitsPm: number;
  visitsBoth: number;
  campaignVisits: number;
  /** Rows credited through a partner slot (a double or triple visit). */
  partnerVisits: number;
  /** A row on the day carried a crm id this person shares with someone else, so it could not be
   * credited — the day is left alone rather than judged on half the evidence. */
  unattributedRow: boolean;
  /** Phoenix customer visits with no captured location — not counted, but shown to the reviewer. */
  visitsWithoutLocation: number;
};

/** Everything else on file for the person-day. */
export type HalfDayCover = {
  /** Approved vacation for the morning ("AM off"). */
  vacationAm?: boolean;
  /** Approved vacation for the afternoon ("PM off"). */
  vacationPm?: boolean;
  /** An approved full-day vacation, an undecided/returned request, or an open review request. */
  leaveTheDayAlone?: boolean;
  planAm?: boolean;
  planPm?: boolean;
};

export type HalfDayVerdict =
  | { kind: "not_a_half_day" }
  | { kind: "left_alone"; why: "crm_leave" | "request_on_file" | "unattributed_row" }
  | { kind: "cleared"; missing: HalfDaySlot; by: "morning_trace" | "evening_trace" }
  | {
      kind: "half_day";
      missing: HalfDaySlot;
      /** What covers the half that WAS accounted for. */
      coveredBy: Array<"crm" | "approved_vacation" | "approved_plan">;
    };

const CRM_CAMPAIGN_VISIT_TYPE = -8;
/** Customer calls whose untagged rows are placed by their save time — regular, campaign, -30. */
const TIMED_CALL_VISIT_TYPES = new Set<number>([0, CRM_CAMPAIGN_VISIT_TYPE, -30]);

function trimmed(value: unknown): string {
  return String(value ?? "").trim();
}

function isPhoenixRow(row: { source?: string | null }): boolean {
  return trimmed(row.source).toLowerCase() === PHOENIX_VISIT_SOURCE;
}

function hasCapturedLocation(row: { lat?: unknown; lon?: unknown }): boolean {
  const coordinate = (value: unknown) => trimmed(value) !== "" && Number.isFinite(Number(value));
  return coordinate(row.lat) && coordinate(row.lon);
}

/**
 * Whether a CRM row is a Phoenix customer visit WITHOUT a captured location — a visit Phoenix must
 * never count (owner, 2026-10-08: a visit must have a location and a time, "no negotiation").
 * Phoenix day activities (meeting, training…) are not visits and carry no position by design.
 */
export function isUnlocatedPhoenixVisit(row: Pick<HalfDayVisitRow, "source" | "visit_type" | "lat" | "lon">): boolean {
  return isPhoenixRow(row) && Number(row.visit_type ?? 0) === 0 && !hasCapturedLocation(row);
}

/** A Phoenix visit with a captured location and time — that team's check-in. */
function isLocatedPhoenixVisit(row: Pick<HalfDayVisitRow, "source" | "visit_type" | "lat" | "lon">): boolean {
  return isPhoenixRow(row) && Number(row.visit_type ?? 0) === 0 && hasCapturedLocation(row);
}

/** The ledger's own compact hr id (candidate-key.ts), so every key here matches the ledger's. */
export function compactHalfDayHrId(value: unknown): string | null {
  return compactDeductionsHrId(trimmed(value));
}

/** A crm id as a comparable string; 0 and blanks are "no partner". */
function crmIdText(value: unknown): string | null {
  const text = trimmed(value);
  if (!text || text === "0") return null;
  return text;
}

/** `{ date, hour }` of a Cairo-wall-clock stamp stored tagged UTC — read as stored, never shifted. */
export function wallClockOf(stamp: string | null | undefined): { date: string; hour: number } | null {
  const text = trimmed(stamp);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return { date: parsed.toISOString().slice(0, 10), hour: parsed.getUTCHours() };
}

function nextDayIso(dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Which half a CRM row speaks for. `null` for a leave row (it covers nothing — the day is the
 * vacation connector's).
 */
export function halfDaySlotOfRow(row: Pick<HalfDayVisitRow, "visit_date" | "visit_type" | "ampm" | "crm_save_date">): "AM" | "PM" | "BOTH" | null {
  const visitType = Number(row.visit_type ?? 0);
  if (crmVisitTypeMeaningLenient(Number.isFinite(visitType) ? visitType : 0) === "AV") return null;
  const tag = trimmed(row.ampm).toUpperCase();
  if (tag === "AM") return "AM";
  if (tag === "PM") return "PM";
  if (!TIMED_CALL_VISIT_TYPES.has(visitType)) return "BOTH";
  const saved = wallClockOf(row.crm_save_date);
  const visitDate = trimmed(row.visit_date).slice(0, 10);
  if (!saved || saved.date !== visitDate) return "BOTH";
  if (saved.hour >= 6 && saved.hour <= 12) return "AM";
  if (saved.hour >= 13 && saved.hour <= 15) return "BOTH";
  return "PM";
}

/** A check-in hour clears the morning (05-15) and/or the afternoon (13 onward). */
function checkinClears(hour: number): { morning: boolean; evening: boolean } {
  return { morning: hour >= 5 && hour <= 15, evening: hour >= 13 };
}

/**
 * Resolves a row's slot to a person. The hr id wins; a blank hr id falls back to the crm id —
 * the mirror resolves `agent_hr_id` asynchronously and leaves it null for weeks (2,050 rows since
 * June, 601 of them one rep's), while `agent_crm_id` is on the row from the moment it is written.
 * The same fallback the CRM connector's `isMine` uses. A crm id two people claim is dropped and
 * reported, never arbitrated.
 */
export type HalfDayIdentity = {
  crmToCompact: ReadonlyMap<string, string>;
  ambiguousCrmIds: ReadonlySet<string>;
  /** Everyone who claims each ambiguous crm id — each of their days with such a row is left alone. */
  ambiguousClaimants: ReadonlyMap<string, ReadonlySet<string>>;
};

function resolveSlot(
  hrId: unknown,
  crmId: unknown,
  identity: HalfDayIdentity,
): { compact: string | null; ambiguous: boolean; claimants: ReadonlySet<string> } {
  const none: ReadonlySet<string> = new Set<string>();
  const compact = compactHalfDayHrId(hrId);
  if (compact) return { compact, ambiguous: false, claimants: none };
  const crm = crmIdText(crmId);
  if (!crm) return { compact: null, ambiguous: false, claimants: none };
  if (identity.ambiguousCrmIds.has(crm)) {
    return { compact: null, ambiguous: true, claimants: identity.ambiguousClaimants.get(crm) ?? none };
  }
  return { compact: identity.crmToCompact.get(crm) ?? null, ambiguous: false, claimants: none };
}

/**
 * Builds a crm id → person map from the directory and from rows that carry both ids. Pure.
 * A crm id seen against two different people becomes ambiguous and maps to nobody.
 */
export function buildHalfDayIdentity(pairs: Iterable<{ hrId: unknown; crmId: unknown }>): HalfDayIdentity {
  const byCrm = new Map<string, string>();
  const claimants = new Map<string, Set<string>>();
  for (const pair of pairs) {
    const compact = compactHalfDayHrId(pair.hrId);
    const crm = crmIdText(pair.crmId);
    if (!compact || !crm) continue;
    const known = claimants.get(crm);
    if (known) known.add(compact);
    else claimants.set(crm, new Set([compact]));
  }
  const ambiguous = new Set<string>();
  const ambiguousClaimants = new Map<string, ReadonlySet<string>>();
  for (const [crm, people] of claimants) {
    if (people.size === 1) {
      byCrm.set(crm, [...people][0] as string);
    } else {
      ambiguous.add(crm);
      ambiguousClaimants.set(crm, people);
    }
  }
  return { crmToCompact: byCrm, ambiguousCrmIds: ambiguous, ambiguousClaimants };
}

function emptyEvidence(): HalfDayEvidence {
  return {
    am: false,
    pm: false,
    crmLeave: false,
    morningProof: false,
    eveningProof: false,
    visitsAm: 0,
    visitsPm: 0,
    visitsBoth: 0,
    campaignVisits: 0,
    partnerVisits: 0,
    unattributedRow: false,
    visitsWithoutLocation: 0,
  };
}

/**
 * Every person-day's CRM evidence, keyed `${compact}:${date}`, plus the person-days a row could
 * not be attributed on (an ambiguous crm id) — those are left alone, never judged on half the
 * evidence. Pure.
 */
export function buildHalfDayEvidence(input: {
  visits: readonly HalfDayVisitRow[];
  checkins: readonly HalfDayCheckinRow[];
  identity: HalfDayIdentity;
}): { byPersonDay: Map<string, HalfDayEvidence>; firstSignalByPerson: Map<string, string>; unattributable: number } {
  const byPersonDay = new Map<string, HalfDayEvidence>();
  const firstSignalByPerson = new Map<string, string>();
  let unattributable = 0;
  const evidenceFor = (key: string) => {
    const known = byPersonDay.get(key);
    if (known) return known;
    const fresh = emptyEvidence();
    byPersonDay.set(key, fresh);
    return fresh;
  };

  // The rep's check-in hours at each customer on each day — what places a visit, and so every
  // partner credited on it, in a half of the day.
  const checkinHoursByVisitKey = new Map<string, number[]>();
  for (const checkin of input.checkins) {
    const clock = wallClockOf(checkin.check_date);
    if (!clock) continue;
    const agentCrm = crmIdText(checkin.agent_crm_id);
    const contact = crmIdText(checkin.contact_crm_id);
    if (agentCrm && contact) {
      const key = `${agentCrm}|${contact}|${clock.date}`;
      const hours = checkinHoursByVisitKey.get(key);
      if (hours) hours.push(clock.hour);
      else checkinHoursByVisitKey.set(key, [clock.hour]);
    }
    // The rep's OWN presence, whether or not a visit was logged against it.
    const owner = resolveSlot(checkin.agent_hr_id, checkin.agent_crm_id, input.identity);
    if (!owner.compact) continue;
    const clears = checkinClears(clock.hour);
    if (clears.morning || clears.evening) {
      const evidence = evidenceFor(`${owner.compact}:${clock.date}`);
      if (clears.morning) evidence.morningProof = true;
      if (clears.evening) evidence.eveningProof = true;
    }
    // A check-in after midnight is the tail of the evening before.
    if (clock.hour < 4) {
      const previous = new Date(`${clock.date}T00:00:00Z`);
      previous.setUTCDate(previous.getUTCDate() - 1);
      evidenceFor(`${owner.compact}:${previous.toISOString().slice(0, 10)}`).eveningProof = true;
    }
  }

  for (const row of input.visits) {
    const date = trimmed(row.visit_date).slice(0, 10);
    if (!date) continue;
    const slot = halfDaySlotOfRow(row);
    const visitType = Number(row.visit_type ?? 0);
    const saved = wallClockOf(row.crm_save_date);
    const unlocated = isUnlocatedPhoenixVisit(row);
    const phoenixCheckin = isLocatedPhoenixVisit(row);
    const linkedHours =
      checkinHoursByVisitKey.get(`${crmIdText(row.agent_crm_id)}|${crmIdText(row.contact_crm_id)}|${date}`) ?? [];

    const slots: Array<{ hr: unknown; crm: unknown; partner: boolean }> = [
      { hr: row.agent_hr_id, crm: row.agent_crm_id, partner: false },
      { hr: row.double_hr_id, crm: row.double_crm_id, partner: true },
      { hr: row.double2_hr_id, crm: row.double2_crm_id, partner: true },
    ];
    const credited = new Set<string>();
    for (const entry of slots) {
      const resolved = resolveSlot(entry.hr, entry.crm, input.identity);
      if (resolved.ambiguous) {
        unattributable += 1;
        for (const claimant of resolved.claimants) evidenceFor(`${claimant}:${date}`).unattributedRow = true;
      }
      if (!resolved.compact || credited.has(resolved.compact)) continue;
      credited.add(resolved.compact);
      const evidence = evidenceFor(`${resolved.compact}:${date}`);
      // No location, no visit: it fills no half, clears none, and starts no one's month.
      if (unlocated) {
        evidence.visitsWithoutLocation += 1;
        continue;
      }
      const first = firstSignalByPerson.get(resolved.compact);
      if (!first || date < first) firstSignalByPerson.set(resolved.compact, date);
      if (slot === null) {
        evidence.crmLeave = true;
        continue;
      }
      if (slot === "AM" || slot === "BOTH") evidence.am = true;
      if (slot === "PM" || slot === "BOTH") evidence.pm = true;
      if (slot === "AM") evidence.visitsAm += 1;
      else if (slot === "PM") evidence.visitsPm += 1;
      else evidence.visitsBoth += 1;
      if (visitType === CRM_CAMPAIGN_VISIT_TYPE) evidence.campaignVisits += 1;
      if (entry.partner) evidence.partnerVisits += 1;
      if (saved) {
        if (saved.date === date && saved.hour >= 6 && saved.hour <= 12) evidence.morningProof = true;
        if ((saved.date === date && saved.hour >= 17) || (saved.date === nextDayIso(date) && saved.hour < 4)) {
          evidence.eveningProof = true;
        }
      }
      for (const hour of linkedHours) {
        const clears = checkinClears(hour);
        if (clears.morning) evidence.morningProof = true;
        if (clears.evening) evidence.eveningProof = true;
      }
      // A Phoenix visit's capture time IS that team's check-in.
      if (phoenixCheckin && saved) {
        if (saved.date === date) {
          const clears = checkinClears(saved.hour);
          if (clears.morning) evidence.morningProof = true;
          if (clears.evening) evidence.eveningProof = true;
        } else if (saved.date === nextDayIso(date) && saved.hour < 4) {
          evidence.eveningProof = true;
        }
      }
    }
  }

  return { byPersonDay, firstSignalByPerson, unattributable };
}

/**
 * Every day's company-wide GPS trace count — iReports360 check-ins plus Phoenix visit captures, which
 * are a started team's check-ins — seeded at zero for every day of the month. Fed to the CRM
 * connector's `detectSuspectDatesFromCounts`: the sync KEEPS a window's visits when its check-in
 * fetch fails ("visits still synced without the GPS overlay"), so a day can arrive with every visit
 * and none of the GPS that clears a half — and judged that way it shows about 2.8 times its real
 * half days, each one saying "no check-in" (risk review, 2026-10-08). Pure.
 */
export function countGpsTracesByDate(input: {
  days: readonly string[];
  visits: readonly Pick<HalfDayVisitRow, "visit_date" | "crm_save_date" | "source" | "visit_type" | "lat" | "lon">[];
  checkins: readonly Pick<HalfDayCheckinRow, "check_date">[];
}): Map<string, number> {
  const counts = new Map<string, number>(input.days.map((day) => [day, 0]));
  const bump = (date: string) => {
    if (counts.has(date)) counts.set(date, (counts.get(date) ?? 0) + 1);
  };
  for (const checkin of input.checkins) {
    const clock = wallClockOf(checkin.check_date);
    if (clock) bump(clock.date);
  }
  for (const row of input.visits) {
    if (!isLocatedPhoenixVisit(row)) continue;
    const saved = wallClockOf(row.crm_save_date);
    if (saved && saved.date === trimmed(row.visit_date).slice(0, 10)) bump(saved.date);
  }
  return counts;
}

/**
 * The verdict for one working, non-Thursday person-day. Pure — the caller has already removed
 * Thursdays, Fridays, national holidays, company-wide CRM gap days and days outside employment.
 */
export function judgeHalfDay(evidence: HalfDayEvidence | undefined, cover: HalfDayCover): HalfDayVerdict {
  const crm = evidence ?? emptyEvidence();
  if (crm.crmLeave) return { kind: "left_alone", why: "crm_leave" };
  if (cover.leaveTheDayAlone) return { kind: "left_alone", why: "request_on_file" };
  if (crm.unattributedRow) return { kind: "left_alone", why: "unattributed_row" };

  const amCovered = crm.am || Boolean(cover.vacationAm) || Boolean(cover.planAm);
  const pmCovered = crm.pm || Boolean(cover.vacationPm) || Boolean(cover.planPm);
  // Both halves accounted for is a full day; neither is a whole-day absence, which the CRM
  // no-activity and district-manager connectors own. Only exactly one is a half day.
  if (amCovered === pmCovered) return { kind: "not_a_half_day" };

  const missing: HalfDaySlot = amCovered ? "PM" : "AM";
  if (missing === "AM" && crm.morningProof) return { kind: "cleared", missing, by: "morning_trace" };
  if (missing === "PM" && crm.eveningProof) return { kind: "cleared", missing, by: "evening_trace" };

  const half = missing === "AM" ? "pm" : "am";
  const coveredBy: Array<"crm" | "approved_vacation" | "approved_plan"> = [];
  if (crm[half]) coveredBy.push("crm");
  if (half === "am" ? cover.vacationAm : cover.vacationPm) coveredBy.push("approved_vacation");
  if (half === "am" ? cover.planAm : cover.planPm) coveredBy.push("approved_plan");
  return { kind: "half_day", missing, coveredBy };
}

/** The approved plan item's half(s): before 14:00 is the morning, from 14:00 (or running past it) the afternoon. */
export function planItemHalves(item: { start_time: string | null; end_time: string | null }): { am: boolean; pm: boolean } {
  const start = trimmed(item.start_time).slice(0, 5);
  const end = trimmed(item.end_time).slice(0, 5);
  if (!start) return { am: true, pm: true };
  return { am: start < "14:00", pm: start >= "14:00" || !end || end > "14:00" };
}

/** The reason line a reviewer reads on the row. */
export function halfDayReason(verdict: Extract<HalfDayVerdict, { kind: "half_day" }>): string {
  const worked = verdict.missing === "AM" ? "afternoon" : "morning";
  const missing = verdict.missing === "AM" ? "morning" : "afternoon";
  const cover = verdict.coveredBy.includes("crm")
    ? `Worked the ${worked} only`
    : verdict.coveredBy.includes("approved_vacation")
      ? `${worked === "morning" ? "AM" : "PM"} off approved`
      : `Approved plan covers the ${worked} only`;
  return `${cover} — nothing recorded for the ${missing}: no visit, check-in, approved vacation, approved plan or request`;
}
