/**
 * Phoenix CRM — one visit's report values, assembled from rows the loader has already read.
 *
 * Pure: no I/O and no query, so a test can hand it a synthetic visit and prove every catalogue field is
 * produced. `server/visit-report.ts` reads and looks things up; this file only says what each field MEANS.
 *
 * 🔴 BLANK IS NULL, NEVER ZERO. A field a rep did not fill, a table that holds nothing for the visit, or
 * evidence above the viewer's sight is `null`: the screen shows a dash and the workbook an empty cell.
 * Only the loader's tier (which tables it READ for this viewer) decides sight — nothing here widens it.
 */

import { dayActivityLabel, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { isEnteredForRep } from "@/lib/phoenix-crm/missed-records";
import { exceptionLabel } from "@/lib/phoenix-crm/plan-rules";
import { territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import type { VisitReportCaseFacts } from "@/lib/phoenix-crm/server/integrity-board";
import { nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { formatClockMinute, weekTimingsText } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmTiming } from "@/lib/phoenix-crm/types";
import { unplannedKindLabel, type UnplannedKind } from "@/lib/phoenix-crm/unplanned-rules";
import { phoenixVisitKindLabel } from "@/lib/phoenix-crm/visit-kind-labels";
import { MISSED_VISIT_LOCATION_LABEL } from "@/lib/phoenix-crm/visit-location-words";
import { dayOfWeekName, monthLabel, type SequenceFacts } from "@/lib/phoenix-crm/visit-report-compute";
import type { VisitReportValue } from "@/lib/phoenix-crm/visit-report-fields";

export type Row = Record<string, unknown>;

export type VisitReportContext = {
  visit: Row;
  customer: Row | null;
  place: Row | null;
  sharedPlace: Row | null;
  seat: OrgSeat | null;
  /**
   * Whose visit it is — the rep, or the manager on his own visit with no rep on it — resolved by the
   * loader through `personOnTheVisit`. 🔴 NEVER THE SEAT'S OCCUPANT: a district manager's own call on a
   * rep's territory was printed under that rep's name (13 visits on production, 2026-10-16), and under
   * "Unknown rep" on a vacant seat (12 more).
   */
  personHrId: string | null;
  /**
   * Whether this reader is shown the measurement behind a distance (`readsLocationDetail`: the Super Admin
   * and the SFE Manager). 🔴 A district manager reads the distance only (owner, 2026-10-02), so a weak
   * reading reads to him as at the place, as on every other screen — this report printed "Weak signal"
   * to him on 7 visits until 2026-10-16.
   */
  readsLocationDetail: boolean;
  names: PeopleNames;
  /** The manager chain above the seat, by role: names only. */
  districtManagerHrId: string | null;
  regionalManagerHrId: string | null;
  region: string | null;
  placeNotes: string[];
  recommendations: string[];
  review: Row | null;
  unplanned: Row | null;
  provenance: Row | null;
  evidence: VisitReportCaseFacts | null;
  editedAt: string | null;
  planItem: Row | null;
  dayStartedAt: string | null;
  activities: Row[];
  doubles: string[];
  ask: string | null;
  /** True or false when HR's leave could be read; null when it could not. */
  onLeave: boolean | null;
  sequence: SequenceFacts | null;
  behaviourFlags: string | null;
};

const text = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
};

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const iso = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function humanise(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const spaced = raw.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function person(names: PeopleNames, hrId: unknown): string | null {
  const key = text(hrId);
  return key ? nameOf(names, key, "") || null : null;
}

function when(value: unknown): string | null {
  const at = iso(value);
  return at ? formatPhoenixDateTime(at) : null;
}

function joined(parts: ReadonlyArray<string | null>, separator = " · "): string | null {
  const present = parts.filter((part): part is string => part !== null && part !== "");
  return present.length > 0 ? present.join(separator) : null;
}

/** People, each once by upper-cased id, in the order given — the fixed places first, then the visit's list. */
function distinctPeople(values: ReadonlyArray<unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = text(value)?.toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const LOCATION_FLAG_LABELS: Record<string, string> = {
  ok: "At the place",
  far: "Far from the place",
  weak_gps: "Weak signal",
  no_place: "No validated place",
};

export function locationFlagLabel(flag: unknown): string | null {
  const key = text(flag);
  return key ? LOCATION_FLAG_LABELS[key] ?? humanise(key) : null;
}

/**
 * A visit's position wording. A visit the Super Admin entered later for a rep carries no reading at all,
 * so it says so in the words every other screen uses — its stored `no_place` flag would otherwise read as
 * "No validated place", a sentence about the customer's place rather than about the missing reading.
 *
 * `readsDetail` is required, so every caller says who is reading: below the Super Admin and the SFE
 * Manager a weak reading is never far (far beats weak, geo.ts) and reads as at the place — the rule
 * `offPlanLocationFlag` applies on the approval cards and `loadVisitLocationReport` on the place report.
 */
export function visitLocationFlagLabel(visit: Row, readsDetail: boolean): string | null {
  const enteredLater = isEnteredForRep({
    enteredBy: visit.entered_by_hr_id,
    manager: visit.manager_hr_id,
    rep: visit.rep_hr_id,
    senior: visit.senior_hr_id,
  });
  if (enteredLater) return MISSED_VISIT_LOCATION_LABEL;
  const flag = text(visit.location_flag);
  return locationFlagLabel(!readsDetail && flag === "weak_gps" ? "ok" : flag);
}

const POINT_SOURCE_LABELS: Record<string, string> = {
  photo: "Photo taken at the door",
  pin: "Pin dropped on the map",
  shared_place: "Shared place",
  moved: "Moved by the Super Admin",
};

const CHECK_VERDICT_LABELS: Record<string, string> = {
  match: "The name matches",
  no_name: "No name could be read",
  other_name: "A different name",
  unjudged: "Could not be judged",
  no_schedule: "No schedule on the sign",
};

const CUSTOMER_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  pending: "Waiting to be validated",
  dropped: "Dropped",
  outside: "Outside the list",
};

const REVIEW_STATUS_LABELS: Record<string, string> = { pending: "Waiting for the Super Admin", approved: "Approved", rejected: "Sent back" };

const OFF_PLAN_STATUS_LABELS: Record<string, string> = {
  admin_pending: "Waiting for the Administrator",
  manager_pending: "Waiting for the manager",
  sfe_pending: "Waiting for SFE",
  approved: "Approved — it counts",
  refused: "Refused — it does not count",
};

function checkVerdict(check: unknown): string | null {
  if (!check || typeof check !== "object") return null;
  const verdict = text((check as Row).verdict);
  return verdict ? CHECK_VERDICT_LABELS[verdict] ?? humanise(verdict) : null;
}

function timingsOf(value: unknown): PhoenixCrmTiming[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = (entry && typeof entry === "object" ? entry : {}) as Row;
    const weekday = num(item.weekday);
    const startMinute = num(item.startMinute);
    if (weekday === null || startMinute === null) return [];
    return [{ weekday, startMinute, endMinute: num(item.endMinute), season: item.season === "ramadan" ? "ramadan" : "normal" } as PhoenixCrmTiming];
  });
}

function listOf(value: unknown): string | null {
  return Array.isArray(value) ? joined(value.map((entry) => text(entry)), ", ") : null;
}

/** `{ "Ivyronc": "has" }` → the products whose answer is `answer`, as one list. */
function availability(value: unknown, answer: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Row).filter(([, state]) => state === answer).map(([product]) => product);
  return entries.length > 0 ? entries.join(", ") : null;
}

function samples(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Row)
    .map(([product, count]) => ({ product, count: num(count) }))
    .filter((entry) => entry.count !== null && entry.count > 0);
  return entries.length > 0 ? entries.map((entry) => `${entry.product} × ${entry.count}`).join(", ") : null;
}

function googleText(google: unknown): string | null {
  if (!google || typeof google !== "object") return null;
  const body = google as Row;
  const listings = Array.isArray(body.listings) ? (body.listings as Row[]) : [];
  const first = listings.length > 0 ? text(listings[0].name) : null;
  return joined([humanise(body.reason), first ? `Closest listing: ${first}` : null, text(body.note)]);
}

function entryRoute(visit: Row): string | null {
  if (visit.capture_source === "admin") return "Super Admin";
  const enteredBy = text(visit.entered_by_hr_id);
  const rep = text(visit.rep_hr_id);
  if (!enteredBy) return null;
  return rep !== null && enteredBy === rep ? "Rep's phone" : "Manager's phone";
}

function approvalStatus(context: VisitReportContext): string | null {
  const { unplanned, visit, customer } = context;
  if (unplanned) return OFF_PLAN_STATUS_LABELS[String(unplanned.status)] ?? humanise(unplanned.status);
  // An out-of-list visit has no approval of its own: it counts once its CUSTOMER is admitted.
  if (visit.unplanned_kind === "out_of_list") {
    const status = text(customer?.status);
    if (status === "active") return "Customer added to the list — it counts";
    if (status === "dropped") return "Customer not added — it does not count";
    return "Customer waiting to be added";
  }
  return null;
}

function decisionText(names: PeopleNames, by: unknown, at: unknown, note: unknown): string | null {
  return joined([person(names, by), when(at), text(note)]);
}

/** Every catalogue field for one visit. Keys are the catalogue's; a key with no fact is `null`. */
export function buildVisitReportValues(context: VisitReportContext): Record<string, VisitReportValue> {
  const { visit, customer, place, sharedPlace, seat, names, provenance, evidence, sequence, planItem, review, unplanned } = context;
  const visitDate = String(visit.visit_date ?? "");
  const fixAge = num(provenance?.fix_age_seconds);
  const queued = num(provenance?.queued_seconds);
  const planned = planItem !== null;

  // Everyone the visit lists past its fixed places (owner, 2026-10-27) joins his own side's column, each once:
  // `companion_product_hr_ids` is the product side of `companion_hr_ids`, carried on the row by the reader.
  const productCompanions = distinctPeople(arrayOf(visit.companion_product_hr_ids));
  const managerCompanions = arrayOf(visit.companion_hr_ids).filter((hrId) => !productCompanions.includes(String(text(hrId) ?? "").toUpperCase()));
  const managers = joined(
    distinctPeople([visit.manager_hr_id, visit.senior_hr_id, ...managerCompanions]).map((hrId) => person(names, hrId)),
    " + ",
  );
  const productManagers = joined(distinctPeople([visit.product_manager_hr_id, ...productCompanions]).map((hrId) => person(names, hrId)), " + ");
  const recommendation = context.recommendations.length > 0 ? context.recommendations.join(" | ") : null;

  return {
    // ── When and how it was logged ──
    visitDate: visitDate || null,
    dayOfWeek: dayOfWeekName(visitDate) || null,
    month: monthLabel(visitDate) || null,
    savedAt: iso(visit.captured_at),
    visitType: phoenixVisitKindLabel(visit.kind),
    plannedOrNot: visit.is_unplanned === true ? "Unplanned" : "Planned",
    unplannedKind: visit.is_unplanned === true && (visit.unplanned_kind === "out_of_plan" || visit.unplanned_kind === "out_of_list")
      ? unplannedKindLabel(visit.unplanned_kind as UnplannedKind)
      : null,
    enteredBy: person(names, visit.entered_by_hr_id),
    entryRoute: entryRoute(visit),
    editedBySuperAdmin: context.editedAt ? `Yes · ${formatPhoenixDateTime(context.editedAt)}` : "No",
    // The rep's own write-up, read from the VISIT's own stamp rather than the audit table above: only
    // he writes it, and it is told in the open (owner, 2026-10-15).
    detailEdited: text(visit.detail_edited_at) ? `Yes · ${formatPhoenixDateTime(String(visit.detail_edited_at))}` : "No",
    clockOffsetMinutes: num(visit.device_skew_minutes),
    dwellSeconds: num(visit.dwell_seconds),
    formOpenSeconds: num(visit.form_open_seconds),
    offlineSeconds: num(visit.offline_seconds),
    syncedAt: iso(visit.synced_at),

    // ── Who and where in the org ──
    repName: person(names, context.personHrId),
    repSeat: seat ? territoryName(seat) : null,
    line: seat?.lineName ?? null,
    district: seat?.regionName ?? null,
    area: seat?.areaName ?? null,
    region: context.region,
    districtManager: person(names, context.districtManagerHrId),
    regionalManager: person(names, context.regionalManagerHrId),
    managerOnVisit: managers,
    productManagerOnVisit: productManagers,

    // ── Customer ──
    customerName: text(customer?.name),
    listType: text(visit.list_type) ?? text(customer?.list_type),
    speciality: text(customer?.speciality),
    grade: text(customer?.grade),
    potentialGrade: text(customer?.potential_grade),
    origin: humanise(customer?.origin),
    customerStatus: customer ? CUSTOMER_STATUS_LABELS[String(customer.status)] ?? humanise(customer.status) : null,
    validatedAt: iso(customer?.validated_at),
    validatedBy: person(names, customer?.validated_by_hr_id),
    customerPhone: text(customer?.phone),
    primaryPharmacy: text(customer?.primary_pharmacy_name),
    pharmacyOnVisit: text(visit.pharmacy_name),

    // ── Place visited ──
    placeLabel: text(place?.label),
    placeAddress: text(place?.address),
    brick: text(place?.brick_name),
    zone: text(place?.zone),
    governorate: text(customer?.pharmacy_pin_governorate),
    placeStatus: humanise(place?.status),
    placeSession: text(place?.session)?.toUpperCase() ?? null,
    pointSource: place ? POINT_SOURCE_LABELS[String(place.point_source)] ?? humanise(place.point_source) : null,
    placeLat: num(place?.lat),
    placeLon: num(place?.lon),
    placeAccuracy: num(place?.accuracy_meters),
    openingHours: place ? text(weekTimingsText(timingsOf(place.timings), false)) : null,
    signboardVerdict: checkVerdict(place?.signboard_check),
    scheduleVerdict: checkVerdict(place?.schedule_check),
    sharedPlace: text(sharedPlace?.name),
    placeNotes: context.placeNotes.length > 0 ? context.placeNotes.join(" | ") : null,
    managerRecommendation: recommendation,

    // ── What happened in the visit ──
    productsDetailed: listOf(visit.products),
    productsAvailable: availability(visit.product_availability, "has"),
    productsMissing: availability(visit.product_availability, "missing"),
    samplesGiven: samples(visit.samples_given),
    objection: humanise(visit.objection),
    objectionNote: text(visit.objection_note),
    nextStep: humanise(visit.next_step),
    nextStepDate: text(visit.next_step_on),
    comment: text(visit.comment),
    detailComment: text(visit.detail_comment),
    voiceNote: Boolean(text(visit.voice_note_path)),
    voiceNoteSeconds: num(visit.voice_note_seconds),
    visitPhoto: Boolean(text(visit.photo_path)),

    // ── Location on the visit ──
    visitLat: num(visit.lat),
    visitLon: num(visit.lon),
    visitAccuracy: num(visit.accuracy_meters),
    distanceFromPlace: num(visit.distance_meters),
    locationFlag: visitLocationFlagLabel(visit, context.readsLocationDetail),
    photoLat: num(visit.photo_lat),
    photoLon: num(visit.photo_lon),
    photoAccuracy: num(visit.photo_accuracy_meters),
    photoTakenAt: iso(visit.photo_captured_at),
    // A negative age is a phone clock that ran ahead of the server: not a measurement.
    fixAgeSeconds: fixAge !== null && fixAge >= 0 ? fixAge : null,
    sentLateMinutes: queued !== null && queued > 0 ? Math.round(queued / 60) : null,
    deviceInstall: text(provenance?.device_install_id),
    appRevision: text(provenance?.app_revision),
    browser: text(provenance?.user_agent),
    integrityDetectors: evidence?.detectorsText ?? null,
    integrityStrength: evidence?.strengthText ?? null,
    mockDevice: evidence?.deviceMocked ?? null,
    caseSettled: evidence?.settledText ?? null,

    // ── Approval of off-plan visits ──
    offPlanReason: text(unplanned?.clarification),
    approvalStatus: approvalStatus(context),
    managerDecidedBy: person(names, unplanned?.manager_decided_by_hr_id),
    managerDecidedAt: iso(unplanned?.manager_decided_at),
    managerNote: text(unplanned?.manager_note),
    sfeDecidedBy: person(names, unplanned?.sfe_decided_by_hr_id),
    sfeDecidedAt: iso(unplanned?.sfe_decided_at),
    sfeNote: text(unplanned?.sfe_note),
    superAdminDecision: unplanned ? decisionText(names, unplanned.admin_decided_by_hr_id, unplanned.admin_decided_at, unplanned.admin_note) : null,

    // ── Validation of the place ──
    validationStatus: review ? REVIEW_STATUS_LABELS[String(review.status)] ?? humanise(review.status) : null,
    validationDecidedBy: person(names, review?.decided_by_hr_id),
    validationDecidedAt: iso(review?.decided_at),
    validationNote: text(review?.decision_note) ?? text(review?.refusal_reason),
    googleResult: googleText(review?.google),

    // ── The day around the visit ──
    plannedThatDay: planned,
    plannedStart: planItem && num(planItem.start_minute) !== null ? formatClockMinute(num(planItem.start_minute) as number) : null,
    planException: planItem ? joined([exceptionLabel(text(planItem.exception_type)), text(planItem.exception_note)]) : null,
    dayStartedAt: context.dayStartedAt,
    dayActivity:
      context.activities.length > 0
        ? context.activities
            .map((entry) =>
              joined(
                [`${dayActivityLabel(String(entry.activity_type) as PhoenixCrmDayActivity)}${entry.half_day === true ? " (half day)" : ""}`, text(entry.note)],
                ": ",
              ),
            )
            .join(" | ")
        : null,
    doubleVisitPlan: context.doubles.length > 0 ? context.doubles.join(" | ") : null,
    visitRequest: context.ask,
    onLeave: context.onLeave,

    // ── Computed per visit ──
    visitNumberInDay: sequence?.numberInDay ?? null,
    visitsThatDay: sequence?.visitsThatDay ?? null,
    gapMinutes: sequence?.gapMinutes ?? null,
    distanceFromPreviousKm: sequence?.distanceFromPreviousKm ?? null,
    speedKmh: sequence?.speedKmh ?? null,
    customerVisitsThisMonth: sequence?.customerVisitsThisMonth ?? null,
    daysSinceCustomerVisit: sequence?.daysSinceCustomerVisit ?? null,
    repMonthFlags: context.behaviourFlags,
  };
}
