/**
 * Native visits — the RULES, with no I/O (CRM phase 3, the pilot).
 *
 * Pure on purpose: the phone form and the server both apply these, and the tests exercise them
 * without a database. Nothing here imports the Supabase client, so a "use client" component may
 * import it.
 *
 * The owner's decisions this file carries (numbers from the CRM audit):
 *   2  AM/PM is decided by the contact's list — a doctor on only the AM list is an AM visit.
 *   3  A campaign visit names a doctor OR a prospect, never both.
 *   7  No GPS fix is allowed: it is flagged and still counted. So is a fix outside Egypt.
 *   8  Entry window: the same Cairo day or the next one.
 *   10 The rep records who accompanied him; that person confirms with his own click.
 *   17 One line, for one week — the pilot row, not a code constant.
 *
 * And the audit's §11.1: explicit types, each mapped to the vendor's legacy code, so -4 stays the
 * only leave and no meaning is ever parsed out of a comment again.
 */

import { isPlausibleCheckinCoordinate } from "@/lib/crm/checkin-coords";
import { addDaysIso } from "@/lib/crm/dates";
import { readAccuracyInput, readCoordinateInput } from "@/lib/geo/coordinate-input";
import { canonicalHrIdKey } from "@/lib/hr-id";

export type NativeVisitContactRule = "required" | "contact_or_prospect" | "none";

export type NativeVisitTypeDefinition = {
  key: NativeVisitTypeKey;
  label: string;
  /** The iReports360 code this type means. Its pay meaning is visit-type-meaning.ts's answer for it. */
  legacyCode: number;
  contact: NativeVisitContactRule;
};

export type NativeVisitTypeKey =
  | "regular"
  | "campaign"
  | "conference"
  | "group_meeting"
  | "annual_vacation"
  | "public_holiday"
  | "casual_leave"
  | "training"
  | "meeting"
  | "traveling"
  | "health_day"
  | "admin_work"
  | "business_review";

/**
 * THE catalogue. The migration's `crm_native_visits_legacy_code` check holds the same pairs, and
 * tests/crm-native-visits.test.ts keeps the two in step.
 *
 * Deliberately absent: -7 (Ambiguous) and -19 (a second, undocumented "Meeting") exist only because the vendor
 * form let a rep pick a code whose meaning nobody could state; -30 (Unlabelled field visit) is a
 * regular visit the vendor never labelled. A native entry is explicit, so none of the three can be
 * created here.
 */
export const NATIVE_VISIT_TYPES: readonly NativeVisitTypeDefinition[] = [
  { key: "regular", label: "Doctor visit", legacyCode: 0, contact: "required" },
  { key: "campaign", label: "Campaign", legacyCode: -8, contact: "contact_or_prospect" },
  { key: "conference", label: "Conference", legacyCode: -1, contact: "none" },
  { key: "group_meeting", label: "Group Meeting", legacyCode: -2, contact: "none" },
  { key: "annual_vacation", label: "Annual Vacation", legacyCode: -4, contact: "none" },
  { key: "public_holiday", label: "Public Holiday", legacyCode: -5, contact: "none" },
  { key: "casual_leave", label: "Casual Leave", legacyCode: -6, contact: "none" },
  { key: "training", label: "Training", legacyCode: -9, contact: "none" },
  { key: "meeting", label: "Meeting", legacyCode: -11, contact: "none" },
  { key: "traveling", label: "Traveling", legacyCode: -12, contact: "none" },
  { key: "health_day", label: "Health Day", legacyCode: -15, contact: "none" },
  { key: "admin_work", label: "Admin Work", legacyCode: -20, contact: "none" },
  { key: "business_review", label: "Business Review", legacyCode: -21, contact: "none" },
];

const TYPE_BY_KEY = new Map<string, NativeVisitTypeDefinition>(NATIVE_VISIT_TYPES.map((type) => [type.key, type]));

export function nativeVisitType(key: string | null | undefined): NativeVisitTypeDefinition | null {
  return TYPE_BY_KEY.get(String(key ?? "")) ?? null;
}

export function nativeVisitTypeLabel(key: string | null | undefined): string {
  return nativeVisitType(key)?.label ?? "Visit";
}

export type NativeVisitShift = "AM" | "PM";
export type NativeVisitGpsStatus = "captured" | "missing" | "out_of_bounds";
export type NativePartnerStatus = "pending" | "confirmed" | "rejected";

export const NATIVE_VISIT_COMMENT_MAX = 1000;
export const NATIVE_VISIT_PROSPECT_MAX = 200;
export const NATIVE_VISIT_PARTNERS_MAX = 3;
export const NATIVE_VISIT_DELETE_REASON_MAX = 500;
/** A phone clock this far ahead of the server is refused rather than believed. */
export const NATIVE_VISIT_DEVICE_CLOCK_SKEW_MS = 15 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ── Pilot ───────────────────────────────────────────────────────────────────────────────────────

export type NativeVisitPilot = {
  lineName: string;
  startsOn: string;
  endsOn: string;
  isActive: boolean;
};

/** Line names are compared the way the portal nav compares them: case, spaces and dashes ignored. */
export function nativeVisitLineKey(lineName: string | null | undefined): string {
  return String(lineName ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The pilot row covering this line, whatever the date — null when the line is not piloting. */
export function nativeVisitPilotForLine(
  lineName: string | null | undefined,
  pilots: readonly NativeVisitPilot[],
): NativeVisitPilot | null {
  const key = nativeVisitLineKey(lineName);
  if (!key) return null;
  return pilots.find((pilot) => pilot.isActive && nativeVisitLineKey(pilot.lineName) === key) ?? null;
}

/** A rep the owner placed on the Phoenix CRM pilot roster, and the first day they enter from. */
export type NativePilotRosterEntry = {
  hrId: string;
  startsOn: string;
};

/** The roster has no end date: a rep stays in the pilot until the owner removes them. */
export const NATIVE_PILOT_ROSTER_OPEN_END = "9999-12-31";

/**
 * Phoenix CRM's pilot for ONE rep (the owner, 2026-09-14: "Reps you pick", from any line, no end until
 * the owner says): open when the rep is on the roster, null otherwise. A whole line no longer opens it.
 */
export function nativeVisitPilotForRep(
  rep: { hrId: string | null | undefined; lineName: string | null | undefined },
  roster: readonly NativePilotRosterEntry[],
): NativeVisitPilot | null {
  const key = canonicalHrIdKey(rep.hrId);
  if (!key) return null;
  const entry = roster.find((row) => canonicalHrIdKey(row.hrId) === key);
  if (!entry || !ISO_DAY_PATTERN.test(entry.startsOn)) return null;
  return { lineName: String(rep.lineName ?? ""), startsOn: entry.startsOn, endsOn: NATIVE_PILOT_ROSTER_OPEN_END, isActive: true };
}

/** True when `visitDate` falls inside the pilot, both ends inclusive. */
export function isNativeVisitPilotDay(pilot: NativeVisitPilot | null, visitDate: string): boolean {
  if (!pilot || !pilot.isActive || !ISO_DAY_PATTERN.test(visitDate)) return false;
  return visitDate >= pilot.startsOn && visitDate <= pilot.endsOn;
}

// ── Which days are open ─────────────────────────────────────────────────────────────────────────

/**
 * What opens a day for native entry and planning. Before the CRM cutover only a pilot line's pilot
 * days are open. From the cutover date on, every day is open to every rep of every line at once (the
 * owner, 2026-09-13: "All lines at once"), because Phoenix is then the only record.
 */
export type NativeEntryGate = {
  /** The pilot row for the rep's own line, or null. */
  pilot: NativeVisitPilot | null;
  /** crm_cutover.cutover_date (YYYY-MM-DD), or null while iReports360 is still the record. */
  cutoverDate: string | null;
};

/** True when `day` is on or after the cutover date: Phoenix is the record for it. */
export function isOnOrAfterNativeCutover(gate: NativeEntryGate, day: string): boolean {
  return gate.cutoverDate != null && ISO_DAY_PATTERN.test(day) && day >= gate.cutoverDate;
}

/** True when a rep may enter or plan work for `day`: a pilot day of his line, or on or after the cutover. */
export function isNativeEntryDay(gate: NativeEntryGate, day: string): boolean {
  return isOnOrAfterNativeCutover(gate, day) || isNativeVisitPilotDay(gate.pilot, day);
}

/**
 * Whether My Visits offers the visit form at all: once a cutover date is set (the form says when it
 * opens), or while his line's pilot still has a day left.
 */
export function isNativeEntryOffered(gate: NativeEntryGate, cairoToday: string): boolean {
  if (gate.cutoverDate != null) return true;
  return Boolean(gate.pilot && gate.pilot.isActive && cairoToday <= gate.pilot.endsOn);
}

/** A calendar day as people read it: "3 October 2026". Anything that is not a day comes back unchanged. */
export function nativeDayLabel(isoDay: string): string {
  if (!ISO_DAY_PATTERN.test(isoDay)) return isoDay;
  return new Date(`${isoDay}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  });
}

// ── Entry window ────────────────────────────────────────────────────────────────────────────────

/** The days a rep may enter today: today and yesterday, Cairo (owner decision 8). */
export function nativeVisitEntryDays(cairoToday: string): { today: string; yesterday: string } {
  return { today: cairoToday, yesterday: addDaysIso(cairoToday, -1) };
}

export function isWithinNativeVisitEntryWindow(visitDate: string, cairoToday: string): boolean {
  if (!ISO_DAY_PATTERN.test(visitDate)) return false;
  const { today, yesterday } = nativeVisitEntryDays(cairoToday);
  return visitDate === today || visitDate === yesterday;
}

/** How far back the Super Admin's entry for a rep looks for open days. */
export const NATIVE_VISIT_ON_BEHALF_LOOKBACK_DAYS = 120;

/** The job titles the Super Admin may enter a visit for: the reps who hold the doctor lists. */
export function isNativeVisitRepTitle(jobTitle: string | null | undefined): boolean {
  return /medical rep|representative/i.test(jobTitle ?? "");
}

/**
 * The days the Super Admin may enter a visit for a rep (the owner, 2026-09-14: "Any open day"): every
 * open day of the rep's line up to today, newest first, never a day still to come.
 */
export function nativeVisitOnBehalfDays(gate: NativeEntryGate, cairoToday: string): string[] {
  const days: string[] = [];
  for (let back = 0; back <= NATIVE_VISIT_ON_BEHALF_LOOKBACK_DAYS; back += 1) {
    const day = addDaysIso(cairoToday, -back);
    if (isNativeEntryDay(gate, day)) days.push(day);
  }
  return days;
}

// ── GPS ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A missing fix and a fix outside Egypt are both FLAGS, never a refusal (owner decision 7). An
 * out-of-bounds fix keeps its coordinates, so whoever reads the flag can see where the phone said.
 */
export function classifyNativeVisitGps(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): NativeVisitGpsStatus {
  const hasLat = typeof latitude === "number" && Number.isFinite(latitude);
  const hasLon = typeof longitude === "number" && Number.isFinite(longitude);
  if (!hasLat || !hasLon) return "missing";
  return isPlausibleCheckinCoordinate(latitude, longitude) ? "captured" : "out_of_bounds";
}

// ── Draft parsing ───────────────────────────────────────────────────────────────────────────────

export type NativeVisitDraft = {
  clientSubmissionId: string;
  visitDate: string;
  shift: NativeVisitShift;
  visitType: NativeVisitTypeKey;
  contactCrmId: number | null;
  prospectName: string | null;
  prospectSpeciality: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  gpsAddress: string | null;
  gpsStatus: NativeVisitGpsStatus;
  comment: string | null;
  partnerHrIds: string[];
  deviceRecordedAt: string;
};

export type NativeVisitRuleResult<T> = { ok: true; value: T } | { ok: false; error: string };

function text(value: unknown, max: number): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Shape and self-consistency of one submission. Deliberately says nothing about WHO sends it — the
 * rep comes from the session (or, for the Super Admin's entry, from the route's own rep field), never
 * from this body, and the body has no field that could name one.
 *
 * `enteredOnBehalf`: the Super Admin enters it for a rep (the owner, 2026-09-14). Any day up to today
 * — whether that day is open is the gate's question — and never a location: he was not standing at
 * the doctor, so the visit is saved with none and never reads as a check-in.
 */
export function parseNativeVisitDraft(
  raw: unknown,
  context: { cairoToday: string; now: Date; enteredOnBehalf?: boolean },
): NativeVisitRuleResult<NativeVisitDraft> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const clientSubmissionId = String(body.clientSubmissionId ?? "").trim();
  if (!UUID_PATTERN.test(clientSubmissionId)) {
    return { ok: false, error: "This visit has no submission id. Reload the form and enter it again." };
  }

  const type = nativeVisitType(String(body.visitType ?? ""));
  if (!type) return { ok: false, error: "Choose what kind of visit or day this is." };

  const visitDate = String(body.visitDate ?? "").trim();
  if (context.enteredOnBehalf) {
    if (!ISO_DAY_PATTERN.test(visitDate)) return { ok: false, error: "Choose the day of the visit." };
    if (visitDate > context.cairoToday) return { ok: false, error: "A visit cannot be entered for a day still to come." };
  } else if (!isWithinNativeVisitEntryWindow(visitDate, context.cairoToday)) {
    return { ok: false, error: "A visit can only be entered on the same day or the next day." };
  }

  const shift = String(body.shift ?? "").trim().toUpperCase();
  if (shift !== "AM" && shift !== "PM") return { ok: false, error: "Choose AM or PM." };

  const contactNumber = finiteOrNull(body.contactCrmId);
  const contactCrmId = contactNumber != null && Number.isInteger(contactNumber) && contactNumber > 0 ? contactNumber : null;
  if (contactCrmId === 100000) {
    return { ok: false, error: "That entry is the CRM's catch-all, not a doctor. Choose the doctor from your list." };
  }
  const prospectName = text(body.prospectName, NATIVE_VISIT_PROSPECT_MAX);
  const prospectSpeciality = text(body.prospectSpeciality, NATIVE_VISIT_PROSPECT_MAX);

  if (type.contact === "required") {
    if (contactCrmId == null) return { ok: false, error: "Choose the doctor you visited." };
    if (prospectName) return { ok: false, error: "A doctor visit names a doctor from your list, not a prospect." };
  } else if (type.contact === "contact_or_prospect") {
    if ((contactCrmId == null) === (prospectName == null)) {
      return { ok: false, error: "A campaign visit names either a doctor from your list or a new prospect — one of the two." };
    }
  } else if (contactCrmId != null || prospectName) {
    return { ok: false, error: `${type.label} is not a visit to a doctor, so it takes no doctor.` };
  }

  // Not finiteOrNull, which lets " " through as 0: a blank pair read as 0°N 0°E, which is outside
  // Egypt, so the visit was flagged "out of bounds" and kept a position the phone never reported.
  // A blank coordinate is no fix, and takes the "missing" flag a missing one always did.
  let latitude = context.enteredOnBehalf ? null : readCoordinateInput(body.latitude);
  let longitude = context.enteredOnBehalf ? null : readCoordinateInput(body.longitude);
  if (latitude == null || longitude == null) {
    latitude = null;
    longitude = null;
  }
  const gpsStatus = classifyNativeVisitGps(latitude, longitude);
  // Not finiteOrNull, which lets " " through as 0: a blank accuracy is none, never a perfect 0 m.
  const accuracy = readAccuracyInput(body.accuracyMeters);
  const accuracyMeters = gpsStatus === "missing" || accuracy == null || accuracy < 0 ? null : accuracy;

  const deviceRecordedAtRaw = String(body.deviceRecordedAt ?? "").trim();
  const deviceTime = Date.parse(deviceRecordedAtRaw);
  if (!deviceRecordedAtRaw || Number.isNaN(deviceTime)) {
    return { ok: false, error: "This visit has no recorded time. Reload the form and enter it again." };
  }
  if (deviceTime - context.now.getTime() > NATIVE_VISIT_DEVICE_CLOCK_SKEW_MS) {
    return { ok: false, error: "Your phone's clock is ahead of the real time. Correct the clock, then send again." };
  }

  const partnerInput = Array.isArray(body.partnerHrIds) ? body.partnerHrIds : [];
  const seen = new Set<string>();
  const partnerHrIds: string[] = [];
  for (const candidate of partnerInput) {
    const value = String(candidate ?? "").trim();
    const key = canonicalHrIdKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    partnerHrIds.push(value);
  }
  if (partnerHrIds.length > NATIVE_VISIT_PARTNERS_MAX) {
    return { ok: false, error: `At most ${NATIVE_VISIT_PARTNERS_MAX} people can be recorded as accompanying one visit.` };
  }

  return {
    ok: true,
    value: {
      clientSubmissionId: clientSubmissionId.toLowerCase(),
      visitDate,
      shift,
      visitType: type.key,
      contactCrmId: type.contact === "none" ? null : contactCrmId,
      prospectName: type.contact === "contact_or_prospect" ? prospectName : null,
      prospectSpeciality: type.contact === "contact_or_prospect" && prospectName ? prospectSpeciality : null,
      latitude,
      longitude,
      accuracyMeters,
      gpsAddress: gpsStatus === "missing" ? null : text(body.gpsAddress, 500),
      gpsStatus,
      comment: text(body.comment, NATIVE_VISIT_COMMENT_MAX),
      partnerHrIds,
      deviceRecordedAt: new Date(deviceTime).toISOString(),
    },
  };
}

// ── Rules that need the rep's own list ──────────────────────────────────────────────────────────

/**
 * AM/PM is the contact's list (owner decision 2). `listTypes` is the set of THIS rep's open lists
 * holding the contact: empty means the contact is not on his list at all, and he cannot visit it.
 * A doctor on both lists takes whichever half-day the rep chose.
 */
export function nativeVisitShiftRefusal(
  draft: Pick<NativeVisitDraft, "contactCrmId" | "shift">,
  listTypes: readonly string[],
  listOwner = "your",
): string | null {
  if (draft.contactCrmId == null) return null;
  const lists = listTypes.filter((list): list is NativeVisitShift => list === "AM" || list === "PM");
  if (lists.length === 0) return `That doctor is not on ${listOwner} AM or PM list.`;
  if (!lists.includes(draft.shift)) {
    return `That doctor is on ${listOwner} ${lists.join(" and ")} list, so this is a ${lists.join(" or ")} visit.`;
  }
  return null;
}

export const NATIVE_VISIT_NOT_PLANNED_MESSAGE =
  "That doctor is not in your plan for that day. A doctor visit must be to a doctor planned on the day you visit.";

export const NATIVE_VISIT_PLAN_NOT_VERIFIED_MESSAGE =
  "Your plan for that week is not verified by your manager yet. A doctor visit saves only from a verified plan.";

/**
 * Why a doctor visit is refused for being outside the plan, or null.
 *
 * The owner, 2026-09-13: a regular visit is a doctor on the rep's list AND in his plan — planned on
 * that very day, in a week plan his manager VERIFIED. Dormant until the CRM cutover. Only the doctor
 * visit is judged: an unplanned visit is now called campaign, and its own rule is still to come.
 */
export function nativeVisitPlanRefusal(input: {
  /** The CRM cutover date is set and the visit day is on or after it. */
  ruleActive: boolean;
  visitTypeKey: string;
  /** The rep's live plan item for this doctor on the visit day, with its week plan's status; null when none. */
  planItem: { planStatus: string } | null;
  /** A district manager's single visit without his rep. He files no week plan, so the rule does not reach it. */
  managerSingleVisit?: boolean;
  /** The Super Admin enters it for a rep: any doctor on the rep's list (the owner, 2026-09-14: "No, any list doctor"). */
  enteredOnBehalf?: boolean;
}): string | null {
  if (!input.ruleActive || input.visitTypeKey !== "regular" || input.managerSingleVisit || input.enteredOnBehalf) return null;
  if (!input.planItem) return NATIVE_VISIT_NOT_PLANNED_MESSAGE;
  if (input.planItem.planStatus !== "verified") return NATIVE_VISIT_PLAN_NOT_VERIFIED_MESSAGE;
  return null;
}

/**
 * The doctors the form offers for a regular visit on one day while the plan rule is active: the rep's
 * live plan items for that day, in a week plan his manager verified. The same test the save applies.
 */
export function nativeVisitPlannedContactIds(
  items: ReadonlyArray<{ contactCrmId: number; planDate: string; planStatus: string }>,
  day: string,
): number[] {
  const ids = new Set<number>();
  for (const item of items) {
    if (item.planDate === day && item.planStatus === "verified") ids.add(item.contactCrmId);
  }
  return Array.from(ids).sort((left, right) => left - right);
}

export const NATIVE_VISIT_MANAGER_SINGLE_PARTNERS_MESSAGE =
  "A single visit names nobody accompanying you. When you visit with a rep, the rep enters the visit and names you.";

export const NATIVE_PLAN_MANAGER_MESSAGE =
  "Forbidden: a district manager files no weekly plan here. Your reps plan their weeks and you verify them.";

/**
 * The owner, 2026-09-14: a district manager normally goes on a double visit and the REP submits it,
 * naming him. In rare cases he submits a single visit without the rep. That visit names nobody.
 */
export function nativeVisitManagerSinglePartnerRefusal(managerSingleVisit: boolean, partnerHrIds: readonly string[]): string | null {
  return managerSingleVisit && partnerHrIds.length > 0 ? NATIVE_VISIT_MANAGER_SINGLE_PARTNERS_MESSAGE : null;
}

/** A rep can never record himself as his own partner. */
export function nativeVisitPartnerRefusal(repHrId: string, partnerHrIds: readonly string[]): string | null {
  const repKey = canonicalHrIdKey(repHrId);
  if (partnerHrIds.some((partner) => canonicalHrIdKey(partner) === repKey)) {
    return "You cannot record yourself as accompanying your own visit.";
  }
  return null;
}

// ── Deletion and partner decisions ──────────────────────────────────────────────────────────────

export function nativeVisitDeleteRefusal(input: {
  ownerHrId: string;
  viewerHrId: string | null;
  deletedAt: string | null;
  visitDate: string;
  cairoToday: string;
  reason: string | null;
}): string | null {
  if (!input.viewerHrId || canonicalHrIdKey(input.ownerHrId) !== canonicalHrIdKey(input.viewerHrId)) {
    return "Only the rep who entered a visit can delete it.";
  }
  if (input.deletedAt) return "This visit is already deleted.";
  if (!isWithinNativeVisitEntryWindow(input.visitDate, input.cairoToday)) {
    return "A visit can only be deleted on the day it was for or the next day.";
  }
  if (!input.reason || !input.reason.trim()) return "Say why this visit is being deleted.";
  return null;
}

export type NativePartnerDecision = "confirmed" | "rejected";

export function parseNativePartnerDecision(value: unknown): NativePartnerDecision | null {
  const decision = String(value ?? "").trim().toLowerCase();
  return decision === "confirmed" || decision === "rejected" ? decision : null;
}

/**
 * Whether THIS viewer may decide THIS partner row. Only the named partner decides, only once, only
 * on a live visit of a rep beneath him. Nothing here, or anywhere, decides on anyone's behalf.
 */
export function nativePartnerDecisionRefusal(input: {
  partnerHrId: string;
  viewerHrId: string | null;
  status: NativePartnerStatus;
  visitDeleted: boolean;
  repInViewerScope: boolean;
}): string | null {
  if (!input.viewerHrId || canonicalHrIdKey(input.partnerHrId) !== canonicalHrIdKey(input.viewerHrId)) {
    return "Only the person named on this visit can confirm it.";
  }
  if (input.status !== "pending") return "This visit has already been answered.";
  if (input.visitDeleted) return "The rep deleted this visit.";
  if (!input.repInViewerScope) return "This rep is not in your team.";
  return null;
}
