/**
 * Phoenix CRM — visits: the Add Visit form, saving a visit, and a territory's visits of a day.
 *
 * Owner, 2026-09-16:
 *   - the rep enters visits; a district manager can, but normally goes out on a double visit that the
 *     rep enters and that counts for the manager too; a chain visit adds a senior manager;
 *   - each visit records a location check against the customer's validated place, the products
 *     discussed (from the line's products), a live photo of the clinic sign or door, and a comment;
 *   - double and chain visits count straight away — there is no confirmation step;
 *   - a visit saved far from the validated place still saves, flagged for the manager;
 *   - the Super Admin's visits are test entries, left out of every report.
 *
 * The visit's date and time are the server's (when the PHOTO's upload slot was issued), never the
 * phone's. One visit a customer a day per territory. A retry of the same visit (the phone keeps the
 * visit's id until it is saved) returns the saved visit instead of a second one.
 *
 * Owner, 2026-09-29 — the rep's flow rebuilt:
 *   - "Log visit" is ONE TAP. No photo, no date and no AM/PM picker: the server stamps the time when
 *     the save arrives, and the location is read silently while the form is open. A caller that still
 *     sends a photo is served exactly as before (its slot dates the visit);
 *   - the visit day is TODAY until 02:00 the next morning — the Cairo date of the time minus two hours
 *     (`viewer.visitDay`, `cairoBusinessDay`). Never a past day, never a future one;
 *   - off the plan is two things: OUT OF PLAN (on his list, not on today's sent plan — a reason, then
 *     the manager and SFE approve the visit) and OUT OF LIST (validated on the spot — the district
 *     manager and SFE approve the CUSTOMER, and the visit counts once he is admitted);
 *   - the rep NEVER sees a distance, a flag or a check on his own visit. The polite "Take care" line is
 *     gone (`isLocationBlind`); his managers, the SFE Manager and the Super Admin keep every measure.
 *
 * A visit may also carry a spoken note (owner, 2026-09-25), and the emphasis above is why it is worth
 * saying here: the note is audio the rep recorded, kept as audio and never transcribed, and it dates
 * NOTHING. A photo is taken where the camera is; a recording can be made in a car an hour later. So
 * the photo's slot gives `captured_at` and the voice slot gives nothing at all — phoenix_crm_take_voice
 * returns void, which is what stops a later edit here reaching for its issue time out of habit.
 */

import { validationError } from "@/lib/http/api-errors";
import { fieldWeekStart, isIsoDay, isRamadanDay, monthStartOf } from "@/lib/phoenix-crm/calendar";
import { gradeTarget } from "@/lib/phoenix-crm/coverage";
import {
  DEVICE_CLOCK_TOLERANCE_MINUTES,
  deviceClockSkewMinutes,
  parseGrade,
  parseProductAvailability,
  parseVisitDraft,
  VISIT_PRODUCTS_MAX,
  type ProductAvailability,
} from "@/lib/phoenix-crm/entry-rules";
import { checkVisitLocation, formatDistance } from "@/lib/phoenix-crm/geo";
import { pickLastVisitProducts, type LastVisitProducts } from "@/lib/phoenix-crm/last-visit-products";
import { isEnteredForRep } from "@/lib/phoenix-crm/missed-records";
import { deriveOfflineCaptureTime, parseOfflineCaptureClaim } from "@/lib/phoenix-crm/offline-clock";
import { describeSamples, narrowSamplesToLine, parseSamplesGiven } from "@/lib/phoenix-crm/samples";
import {
  pickLastNextStep,
  visitNextStepLabel,
  visitObjectionLabel,
  isVisitNextStep,
  isVisitObjection,
  type LastNextStep,
} from "@/lib/phoenix-crm/visit-outcome";
import { describeDayWindows, isUuid } from "@/lib/phoenix-crm/plan-rules";
import { managerChain, resolveVisitParticipants, territoryReviewer, type OrgIndex } from "@/lib/phoenix-crm/scope";
import { canWriteAsRep, isLocationBlind, readTestFlag, territoryForRead, territoryForVisit, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadDayActivityOn, type DayActivityRow } from "@/lib/phoenix-crm/server/day-activities";
import { callPhoenixCrm, numberOrNull, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { judgeCapture } from "@/lib/phoenix-crm/server/location-integrity";
import { ensureReferenceCustomers, loadMonthVisitCounts, loadTerritoryCustomers } from "@/lib/phoenix-crm/server/list";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { photoSlotIssuedAt } from "@/lib/phoenix-crm/server/photos";
import { readTimeAnchor } from "@/lib/phoenix-crm/server/time-anchor";
import { lineProductsByFamily, type LineProductFamily } from "@/lib/phoenix-crm/server/products";
import { describeTerritory, personSeatTitle, seatTierTitle, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmPlanStatus, PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";
import {
  isUnplannedKind,
  isUnplannedVisitStatus,
  outOfListVisitNote,
  OUT_OF_LIST_REP_NOTE,
  unplannedFirstStatus,
  unplannedVisitRepNote,
  unplannedVisitStatusLabel,
  type UnplannedKind,
  type UnplannedVisitStatus,
} from "@/lib/phoenix-crm/unplanned-rules";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

export type VisitLocationFlag = "ok" | "far" | "weak_gps" | "no_place";

const KIND_LABEL: Record<PhoenixCrmVisitKind, string> = {
  single: "Single visit",
  double: "Double visit",
  chain: "Chain visit",
};

/**
 * What a MANAGER reads about a visit's location — plain and measured, never a verdict: the usual cause
 * of a long distance is a place saved from the wrong doorway, not a rep who was not there.
 *
 * 🔴 Never the rep's. The owner's polite sign on the rep's own visit (2026-09-26) was REMOVED on
 * 2026-09-29: the rep sees no distance, no flag and no check of any kind (Golden Rule #1). His rows
 * carry `BLIND_LOCATION` instead — see `mapVisitRow`.
 */
export function visitLocationLabel(flag: VisitLocationFlag, distanceMeters: number | null, accuracyMeters: number | null): string {
  if (flag === "far") return `About ${formatDistance(distanceMeters)} from this customer's saved place`;
  if (flag === "weak_gps") return `The phone was not sure where it was (within ${formatDistance(accuracyMeters)})`;
  if (flag === "no_place") return "No place saved for this customer yet";
  return distanceMeters === null ? "At the saved place" : `At the saved place (${formatDistance(distanceMeters)})`;
}

/**
 * The location fields on the REP's own visit: kept in the response so a caller one release behind
 * still reads a well-formed row, and saying nothing — no distance, no flag, no check.
 */
export const BLIND_LOCATION: { locationFlag: VisitLocationFlag; locationLabel: string } = { locationFlag: "ok", locationLabel: "Visit saved" };

/** What a manager reads where a location would be, on a visit the Super Admin entered for the rep. */
export const MISSED_VISIT_LOCATION_LABEL = "No location: entered later by the Super Admin";

// ── A territory's visits ────────────────────────────────────────────────────────────────────────

export type VisitRow = {
  visitId: string;
  visitDate: string;
  capturedAt: string;
  customerId: string;
  customerName: string;
  listType: PhoenixCrmListType;
  kind: PhoenixCrmVisitKind;
  kindLabel: string;
  repName: string | null;
  managerName: string | null;
  seniorName: string | null;
  /**
   * Each one's REAL JOB TITLE, as the organogram states it — "Medical Representative", "District
   * Sales Manager", "National Sales Manager" (owner, 2026-10-01: *"put actual titles from the
   * organogram"*). The card used to label them by the SLOT they fill on a visit — "Rep", "Manager",
   * "Senior manager" — which names the visit's shape and nobody's job, and read as a demotion beside
   * the organogram's own wording.
   *
   * Null when the organogram has no seat for that person: the tree is SALES-only, so a head-office
   * person or the Super Admin genuinely has no title in it, and the screen falls back to the slot
   * rather than printing nothing or guessing from HR's own job-title column.
   */
  repTitle: string | null;
  managerTitle: string | null;
  seniorTitle: string | null;
  enteredByName: string;
  /**
   * Entered FOR the rep by the Super Admin, who was not on the visit — a visit the rep missed logging
   * (owner, 2026-10-01). Every screen that shows the visit says so in words (`MISSED_RECORD_MARK`).
   * Read from who entered it (`isEnteredForRep`), never from how it was dated.
   */
  enteredByAdmin: boolean;
  products: string[];
  /** The pharmacy the rep took feedback from before the doctor. */
  pharmacyName: string | null;
  /** Which of the rep's line products that pharmacy stocks, product by product. */
  productAvailability: Record<string, ProductAvailability>;
  comment: string | null;
  /** The visit's photo, on a visit saved with one. The one-tap visit (2026-09-29) has none. */
  photoPath: string | null;
  /** The spoken note, if the rep left one. Null is the normal case: a visit never required one. */
  voiceNotePath: string | null;
  voiceNoteSeconds: number | null;
  locationFlag: VisitLocationFlag;
  locationLabel: string;
  clockOff: boolean;
  /**
   * Off the plan, and where its approval has got to. Null on the ordinary planned visit.
   *
   * The rep sees this on his own day — deliberately. It is not the mock-location board, which is
   * silent by owner's rule; this is his own visit telling him it is not counting yet and who it is
   * with, which is the only way he can chase it.
   */
  unplanned: { status: UnplannedVisitStatus; statusLabel: string; note: string; clarification: string } | null;
  /** Which way the visit was off the plan, if it was: out of plan, or out of list. */
  unplannedKind: UnplannedKind | null;
  /**
   * An out-of-list visit has no approval of its own: it waits on its CUSTOMER being added to the list.
   * Where that has got to, in the rep's words. Null on every other visit.
   */
  outOfList: { label: string; note: string } | null;
  /**
   * What the doctor pushed back on, and what the rep said he would do next. Null on a visit that
   * answered neither, which is every visit saved before this existed.
   *
   * His own, and shown to him: an objection is the DOCTOR's, never a mark against the rep, and the
   * next step is the commitment he made and will be reminded of at the door next time.
   */
  outcome: VisitOutcomeView | null;
  /**
   * What he handed over, ready to print: the sampled products first, then the materials in their
   * fixed order. Empty on a visit that left nothing, which is every visit saved before this existed.
   */
  samples: Array<{ key: string; label: string; quantity: number }>;
};

export type VisitOutcomeView = {
  nextStepLabel: string | null;
  nextStepOn: string | null;
  objectionLabel: string | null;
  objectionNote: string | null;
};

const VISIT_COLUMNS =
  "id, visit_date, captured_at, customer_id, list_type, kind, rep_hr_id, manager_hr_id, senior_hr_id, entered_by_hr_id, products, " +
  "comment, pharmacy_name, product_availability, photo_path, voice_note_path, voice_note_seconds, " +
  "accuracy_meters, distance_meters, location_flag, device_skew_minutes, is_unplanned, unplanned_kind, " +
  "next_step, next_step_on, objection, objection_note, samples_given, " +
  "customer:phoenix_crm_customers!customer_id(name, status), " +
  "unplanned:phoenix_crm_unplanned_visits!visit_id(status, clarification)";

function visitKind(value: unknown): PhoenixCrmVisitKind {
  return value === "double" || value === "chain" ? value : "single";
}

function locationFlag(value: unknown): VisitLocationFlag {
  return value === "far" || value === "weak_gps" || value === "no_place" ? value : "ok";
}

/**
 * The approval row PostgREST embedded beside the visit. It is one row through a primary-key foreign
 * key, but PostgREST returns an object for some embeds and a one-element array for others, so both
 * shapes are read rather than assumed.
 */
function visitUnplanned(row: Row): VisitRow["unplanned"] {
  const embedded = Array.isArray(row.unplanned) ? row.unplanned[0] : row.unplanned;
  const entry = record(embedded);
  const status = entry.status;
  if (!isUnplannedVisitStatus(status)) return null;
  return {
    status,
    statusLabel: unplannedVisitStatusLabel(status),
    note: unplannedVisitRepNote(status),
    clarification: textOrNull(entry.clarification) ?? "",
  };
}

/**
 * The outcome, or null when the visit answered neither question.
 *
 * Null rather than an object of nulls: the card has to tell "he answered nothing" from "he answered",
 * and every visit saved before E3 answered nothing. An unrecognised value reads as unanswered — the
 * same drop-never-refuse rule the save follows, applied on the way back out.
 */
function visitOutcome(row: Row): VisitOutcomeView | null {
  const nextStep = isVisitNextStep(row.next_step) ? row.next_step : null;
  const objection = isVisitObjection(row.objection) ? row.objection : null;
  if (nextStep === null && objection === null) return null;
  return {
    nextStepLabel: nextStep === null ? null : visitNextStepLabel(nextStep),
    nextStepOn: textOrNull(row.next_step_on),
    objectionLabel: objection === null ? null : visitObjectionLabel(objection),
    objectionNote: textOrNull(row.objection_note),
  };
}

function visitPeople(rows: ReadonlyArray<Row>): Array<string | null> {
  return rows.flatMap((row) => [
    textOrNull(row.rep_hr_id),
    textOrNull(row.manager_hr_id),
    textOrNull(row.senior_hr_id),
    textOrNull(row.entered_by_hr_id),
  ]);
}

/**
 * One visit row, as a screen reads it. `blind` is the rep's own view of his own territory
 * (`isLocationBlind`): the location fields say nothing and the phone-clock mark is off — no distance,
 * no flag, no check (Golden Rule #1, owner 2026-09-29).
 */
function mapVisitRow(row: Row, names: PeopleNames, options: { blind: boolean; org: OrgIndex }): VisitRow {
  const kind = visitKind(row.kind);
  const flag = locationFlag(row.location_flag);
  const skew = numberOrNull(row.device_skew_minutes);
  const person = (value: unknown) => {
    const hrId = textOrNull(value);
    return hrId ? nameOf(names, hrId) : null;
  };
  // The organogram's own title for whoever is on the visit — resolved from the WHOLE tree rather than
  // this territory's manager chain on purpose: a manager who moved line since the visit, or who went
  // out with a rep outside his own district, still has a seat and still has a title.
  const title = (value: unknown) => personSeatTitle(options.org, textOrNull(value));
  const unplannedKind = row.is_unplanned === true ? (isUnplannedKind(row.unplanned_kind) ? row.unplanned_kind : "out_of_plan") : null;
  const enteredByAdmin = isEnteredForRep({ enteredBy: row.entered_by_hr_id, rep: row.rep_hr_id, manager: row.manager_hr_id, senior: row.senior_hr_id });
  return {
    visitId: String(row.id),
    visitDate: String(row.visit_date),
    capturedAt: String(row.captured_at),
    customerId: String(row.customer_id),
    customerName: textOrNull(record(row.customer).name) ?? "Customer",
    listType: row.list_type === "AM" ? "AM" : "PM",
    kind,
    kindLabel: KIND_LABEL[kind],
    repName: person(row.rep_hr_id),
    managerName: person(row.manager_hr_id),
    seniorName: person(row.senior_hr_id),
    repTitle: title(row.rep_hr_id),
    managerTitle: title(row.manager_hr_id),
    seniorTitle: title(row.senior_hr_id),
    enteredByName: nameOf(names, textOrNull(row.entered_by_hr_id)),
    enteredByAdmin,
    products: Array.isArray(row.products) ? row.products.map(String) : [],
    pharmacyName: textOrNull(row.pharmacy_name),
    productAvailability: parseProductAvailability(row.product_availability),
    comment: textOrNull(row.comment),
    photoPath: textOrNull(row.photo_path),
    voiceNotePath: textOrNull(row.voice_note_path),
    voiceNoteSeconds: numberOrNull(row.voice_note_seconds),
    ...(options.blind
      ? BLIND_LOCATION
      : {
          locationFlag: flag,
          // Entered later by the Super Admin, from wherever he was: there is no reading to describe, and
          // "no place saved for this customer" would be a sentence about the wrong thing.
          locationLabel: enteredByAdmin
            ? MISSED_VISIT_LOCATION_LABEL
            : visitLocationLabel(flag, numberOrNull(row.distance_meters), numberOrNull(row.accuracy_meters)),
        }),
    clockOff: !options.blind && skew !== null && Math.abs(skew) > DEVICE_CLOCK_TOLERANCE_MINUTES,
    unplanned: unplannedKind === "out_of_plan" ? visitUnplanned(row) : null,
    unplannedKind,
    outOfList: unplannedKind === "out_of_list" ? outOfListVisitNote(textOrNull(record(row.customer).status)) : null,
    outcome: visitOutcome(row),
    samples: describeSamples(parseSamplesGiven(row.samples_given)),
  };
}

async function loadVisitRows(seatId: string, isTest: boolean, date: string): Promise<Row[]> {
  const rows = await fetchAllRowsKeyset<Row>(
    () => getSupabaseAdmin().from("phoenix_crm_visits").select(VISIT_COLUMNS).eq("seat_id", seatId).eq("is_test", isTest).eq("visit_date", date),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  return rows.sort((left, right) => String(right.captured_at).localeCompare(String(left.captured_at)));
}

/** Whether the viewer may enter this territory's visits (territoryForVisit, answered for a screen). */
export function canEnterVisits(viewer: PhoenixCrmViewer, seatId: string, isTest: boolean): boolean {
  try {
    // The answer's world must be the one asked about: a test login enters test visits only.
    return territoryForVisit(viewer, seatId, isTest).isTest === isTest;
  } catch {
    return false;
  }
}

export type VisitDayView = {
  territory: TerritorySummary;
  isTest: boolean;
  date: string;
  visits: VisitRow[];
  canAdd: boolean;
  /**
   * What this day was, when it was not a call: a meeting, training, a conference, admin work,
   * travelling, a health day. Null on an ordinary field day (owner, 2026-09-26).
   *
   * Carried on the day view so the screen needs no second read, and a RECORD ONLY — it changes no
   * call rate, no coverage and no plan-against-actual, by his ruling. There is no leave value: HR's
   * vacation module stays the only leave record.
   */
  dayActivity: DayActivityRow | null;
  /** The rep's own day to describe; a manager enters his visits but never how he spent his day. */
  canSetDayActivity: boolean;
};

export async function loadVisitDay(viewer: PhoenixCrmViewer, raw: { seatId: unknown; test: unknown; date: unknown }): Promise<VisitDayView> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  // The visit day, not the calendar day: until 02:00 the day that just ended is still the one a rep
  // adds to (owner, 2026-09-29). A past day is read only; a future one does not exist yet.
  const today = viewer.visitDay;
  const date = isIsoDay(raw.date) && raw.date <= today ? raw.date : today;
  const rows = await loadVisitRows(seat.seatId, isTest, date);
  const [names, activity] = await Promise.all([
    loadPeopleNames([...territoryPeople(viewer.org, [seat]), ...visitPeople(rows)]),
    loadDayActivityOn(seat.seatId, isTest, date),
  ]);
  const blind = isLocationBlind(viewer, seat);
  return {
    territory: describeTerritory(viewer.org, seat, names),
    isTest,
    date,
    visits: rows.map((row) => mapVisitRow(row, names, { blind, org: viewer.org })),
    canAdd: date === today && canEnterVisits(viewer, seat.seatId, isTest),
    dayActivity: activity,
    canSetDayActivity: date === today && canWriteAsRep(viewer, seat, isTest),
  };
}

// ── The Add Visit form ──────────────────────────────────────────────────────────────────────────

export type VisitCustomerOption = {
  customerId: string;
  name: string;
  listType: PhoenixCrmListType;
  grade: PhoenixCrmGrade | null;
  speciality: string | null;
  /**
   * The brick his first place sits in, so the picker can group and colour a day geographically — the
   * same eight hues, in the same order, as the List tab (brick-tints.ts). The List tab has read this
   * from the start; the visit form used to drop it here, which is why the one screen a rep uses every
   * day was the one with no map in it.
   */
  brickId: string | null;
  brickName: string | null;
  places: Array<{
    placeId: string;
    label: string | null;
    address: string | null;
    lat: number;
    lon: number;
    photoPath: string;
    capturedAt: string;
    /** Today's receiving hours at this place, or "Does not receive this day". */
    todayWindows: string;
  }>;
  /**
   * What he discussed with this customer last time, and when — null when there is no earlier visit.
   *
   * GOLDEN RULE #1, the EASY half: nothing is asked twice. The form fills the products in from this
   * the moment he picks the customer, and says which day they came from so he can see what he is
   * agreeing to. Absent, never an empty list: the screen has to tell "nothing to carry over" from
   * "he discussed nothing".
   */
  lastVisit: { date: string; products: string[] } | null;
  /**
   * What he said he would do for this customer last time, if it was something to do — absent when the
   * answer was "Nothing to follow", and absent when there is no earlier visit.
   *
   * Kept APART from `lastVisit`, from the same read, because `pickLastVisitProducts` deliberately
   * drops a customer whose last products have all been retired from the line — and a commitment the
   * rep made to that same doctor is still a commitment. Folding the two together would lose it.
   */
  lastNextStep: LastNextStep | null;
  plannedToday: boolean;
  visitedToday: boolean;
  visitsThisMonth: number;
  target: number | null;
  /**
   * Carried over from iReports360 and not validated yet: he has no place, the visit saves with no
   * location to compare against, and it counts in nothing until he is validated.
   */
  pending: boolean;
  /**
   * Met outside the list and validated at the door, waiting to be added (2026-09-29). A visit to him
   * is an out-of-list visit: it counts once the district manager and SFE admit him.
   */
  outside: boolean;
  /**
   * His entry on the territory's iReports360 list, which is what the Validate screen opens on. Null
   * for a customer the rep added himself — he has no reference entry, so there is nothing to validate
   * from here. Carried so that saving a visit on a pending customer can offer "Validate now" without
   * a second read: he is at the door with the phone already in his hand.
   */
  referenceContactCrmId: number | null;
};

export type VisitPerson = {
  /** The value the form sends back; shown by name only. */
  hrId: string;
  name: string;
  title: string;
  /** 0 = the territory's nearest manager; a senior manager sits at a higher position than the manager. */
  position: number;
};

export type VisitFormView = {
  territory: TerritorySummary;
  isTest: boolean;
  cairoToday: string;
  enteredAs: "rep" | "manager";
  /** The territory's managers, nearest first: the manager and senior manager are chosen from these. */
  managers: VisitPerson[];
  /** Entering as a manager: the viewer's own position in `managers` (they are the visit's manager). */
  viewerPosition: number | null;
  /** The line's discussed choices — the family names — for "Products discussed". */
  products: string[];
  /** The same products grouped by family, for the finer per-product pharmacy-stock check. */
  productFamilies: LineProductFamily[];
  /** Pharmacies this seat has typed on earlier visits, most recent first, for the name suggestions. */
  pharmacies: string[];
  rules: { visitFarMeters: number; weakGpsMeters: number };
  customers: VisitCustomerOption[];
  todayVisits: VisitRow[];
  /** Why no visit can be saved here, in one sentence; null when nothing stops it. */
  blockedReason: string | null;
};

/**
 * The customers planned for a day on a plan that has GONE FOR REVIEW — the screen's twin of the test
 * phoenix_crm_save_visit runs.
 *
 * The status filter is the whole point and must not be dropped for looking redundant. A draft plan is
 * the rep's own to edit and today is an editable day, so counting a plain plan row would let him place
 * the doctor at the door, save seconds later and never be off plan — the approval would never happen
 * and the rule would be theatre. A RETURNED plan is his to edit too, so it is not authority either.
 *
 * The database's version is stricter still: it asks whether the plan had reached review BEFORE this
 * visit's server-issued `captured_at`, which a form being drawn cannot know yet. The two disagree only
 * when the rep reopens his plan between opening the form and saving, and then the save comes back
 * asking him for a reason — the right answer, not a defect.
 */
async function plannedCustomerIds(seatId: string, isTest: boolean, date: string): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const { data: plan, error } = await supabase
    .from("phoenix_crm_plans")
    .select("id")
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .eq("week_start", fieldWeekStart(date))
    .in("status", ["submitted", "approved"])
    .maybeSingle();
  throwIfError(error);
  if (!plan) return new Set();
  const items = await supabase.from("phoenix_crm_plan_items").select("customer_id").eq("plan_id", String((plan as Row).id)).eq("plan_date", date);
  throwIfError(items.error);
  return new Set(((items.data ?? []) as Row[]).map((row) => String(row.customer_id)));
}

/**
 * The pharmacy names this seat has typed before, most recent first, deduped case-insensitively. The
 * form offers them as suggestions; the rep can always type a new one, and it joins the list next time.
 * A fresh read of recent visits — there is no separate pharmacy store to keep in step.
 */
async function loadSeatPharmacies(seatId: string, isTest: boolean): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_visits")
    .select("pharmacy_name, captured_at")
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .not("pharmacy_name", "is", null)
    .order("captured_at", { ascending: false })
    .limit(500);
  throwIfError(error);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of (data ?? []) as Row[]) {
    const name = textOrNull(row.pharmacy_name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= 50) break;
  }
  return names;
}

/**
 * How far back the form looks for "same as last visit".
 *
 * Six months rather than forever: a doctor not seen since last winter is a conversation to have
 * fresh, not one to reopen with whatever was said then, and the read stays small on a territory that
 * has been running for a year.
 */
const LAST_VISIT_MONTHS = 6;

/** The first day of the month `months` before this Cairo day — the floor for the read above. */
function monthsBackFrom(isoDay: string, months: number): string {
  const [year, month] = isoDay.split("-").map((part) => Number(part));
  const zeroBased = (year ?? 0) * 12 + (month ?? 1) - 1 - months;
  const backYear = Math.floor(zeroBased / 12);
  const backMonth = (zeroBased % 12) + 1;
  return `${String(backYear).padStart(4, "0")}-${String(backMonth).padStart(2, "0")}-01`;
}

/**
 * The newest earlier visit per customer on this territory, for the products the form carries over.
 *
 * `.lt("visit_date", today)` is load-bearing: without it a second visit to the same customer on the
 * same day would prefill itself, which is not carrying anything over. One read for the whole
 * territory rather than one per customer — it rides in the form's existing Promise.all.
 *
 * The line's products arrive as a PROMISE (2026-10-01, "slow to transfer between page and page"): the
 * read needs none of them, only the pick below does, so the read starts at once instead of waiting
 * for the product families to land first.
 */
async function loadLastVisits(
  seatId: string,
  isTest: boolean,
  today: string,
  lineProductsRead: Promise<readonly string[]>,
): Promise<{ products: Map<string, LastVisitProducts>; nextSteps: Map<string, LastNextStep> }> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_visits")
        .select("id, customer_id, visit_date, captured_at, products, next_step, next_step_on")
        .eq("seat_id", seatId)
        .eq("is_test", isTest)
        .lt("visit_date", today)
        .gte("visit_date", monthsBackFrom(today, LAST_VISIT_MONTHS)),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  const lineProducts = await lineProductsRead;
  const base = rows.map((row) => ({
    customerId: String(row.customer_id ?? ""),
    visitDate: String(row.visit_date ?? ""),
    capturedAt: String(row.captured_at ?? ""),
  }));
  return {
    products: pickLastVisitProducts(
      rows.map((row, index) => ({
        ...base[index],
        products: Array.isArray(row.products) ? (row.products as unknown[]).map((entry) => String(entry)) : [],
      })),
      lineProducts,
      VISIT_PRODUCTS_MAX,
    ),
    nextSteps: pickLastNextStep(
      rows.map((row, index) => ({ ...base[index], nextStep: textOrNull(row.next_step), nextStepOn: textOrNull(row.next_step_on) })),
    ),
  };
}

/**
 * A day's visits, mapped — for any screen that needs to know who was seen today.
 *
 * The Today screen reads this rather than the raw rows, so one visit reads the same on both screens
 * and a change to `mapVisitRow` cannot leave the two disagreeing about a name.
 */
export async function loadVisitRowsForDay(seatId: string, isTest: boolean, date: string, options: { blind: boolean; org: OrgIndex }): Promise<VisitRow[]> {
  const rows = await loadVisitRows(seatId, isTest, date);
  const names = await loadPeopleNames(visitPeople(rows));
  return rows.map((row) => mapVisitRow(row, names, options));
}

/**
 * The customers on a SENT plan for one day, and whether a sent plan exists at all.
 *
 * `plannedCustomerIds` answers only the first half, and the Today screen needs the second: "no plan
 * sent yet" and "a sent plan with nobody on today" are different sentences to a rep, and showing the
 * wrong one sends him to the wrong screen.
 */
export async function plannedCustomersOn(
  seatId: string,
  isTest: boolean,
  date: string,
): Promise<{ status: PhoenixCrmPlanStatus | null; customerIds: string[] }> {
  const supabase = getSupabaseAdmin();
  const { data: plan, error } = await supabase
    .from("phoenix_crm_plans")
    .select("id, status")
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .eq("week_start", fieldWeekStart(date))
    .maybeSingle();
  throwIfError(error);
  if (!plan) return { status: null, customerIds: [] };
  const status = String((plan as Row).status ?? "") as PhoenixCrmPlanStatus;
  const items = await supabase
    .from("phoenix_crm_plan_items")
    .select("customer_id")
    .eq("plan_id", String((plan as Row).id))
    .eq("plan_date", date);
  throwIfError(items.error);
  return { status, customerIds: ((items.data ?? []) as Row[]).map((row) => String(row.customer_id)) };
}

export async function loadVisitForm(viewer: PhoenixCrmViewer, raw: { seatId: unknown; test: unknown }): Promise<VisitFormView> {
  const { seat, isTest, enteredAs } = territoryForVisit(viewer, raw.seatId, readTestFlag(raw.test));
  // The visit day: until 02:00 the day that just ended is still today's (owner, 2026-09-29).
  const today = viewer.visitDay;
  const chain = managerChain(viewer.org, seat.seatId);

  // 🔴 ONE WAVE, NOT FOUR (2026-10-01, "slow to transfer between page and page", Phoenix CRM first —
  // this is the screen a rep opens most). The form waited for the reference mint, then its reads,
  // then the last visits, then the names. Only the customer list depends on the mint — the mint can
  // add customers to it — and nothing else here can name a customer minted a moment ago: he has no
  // visit, no plan row and no last visit yet. So every other read starts BESIDE the mint; the last
  // visits' read no longer waits for the product families (only its pick does); and the names ride on
  // the day's visits, the one read they need. The mint's own failure is still the one that surfaces,
  // first, exactly as when it ran alone.
  const ensured = ensureReferenceCustomers(seat, isTest);
  const visitRowsRead = loadVisitRows(seat.seatId, isTest, today);
  const productFamiliesRead = lineProductsByFamily(seat.lineName);
  // The products the last visits are narrowed to. `loadLastVisits` awaits this only once its own read
  // is in, so it is handled here, the moment it exists: a failure landing first must never be an
  // UNHANDLED rejection. The families' own failure still fails the wave below, as it always did.
  const lineProductsRead = productFamiliesRead.then((families) => families.map((entry) => entry.family));
  lineProductsRead.catch(() => undefined);
  const wave = Promise.all([
    // The list, and the customers waiting outside it: a second visit to someone met outside the list
    // is another out-of-list visit to the same customer, never a second customer.
    ensured.then(() => loadTerritoryCustomers(seat.seatId, isTest, { onListOnly: true, includeOutside: true })),
    loadMonthVisitCounts(seat.seatId, isTest, monthStartOf(today), today),
    plannedCustomerIds(seat.seatId, isTest, today),
    visitRowsRead,
    productFamiliesRead,
    loadSeatPharmacies(seat.seatId, isTest),
    // Narrowed to what the line still sells, which is why its pick waits for the families.
    loadLastVisits(seat.seatId, isTest, today, lineProductsRead),
    visitRowsRead.then((rows) =>
      loadPeopleNames([...territoryPeople(viewer.org, [seat]), ...chain.map((member) => member.hrId), ...visitPeople(rows)]),
    ),
  ]);
  // Handled at once: if the mint fails, `await ensured` below throws its error and the wave is dropped.
  wave.catch(() => undefined);
  await ensured;
  const [{ customers, placesByCustomer }, visitCounts, planned, visitRows, productFamilies, pharmacies, lastVisits, names] = await wave;
  const products = productFamilies.map((entry) => entry.family);
  const visitedToday = new Set(visitRows.map((row) => String(row.customer_id)));
  const ramadan = isRamadanDay(today, viewer.config.ramadanOverrides);
  const settings = viewer.config.settings;

  const options: VisitCustomerOption[] = customers.map((row) => {
    const customerId = String(row.id);
    const listType: PhoenixCrmListType = row.list_type === "AM" ? "AM" : "PM";
    const grade = parseGrade(row.grade);
    const customerPlaces = placesByCustomer.get(customerId) ?? [];
    // His first place's brick — a customer with several places is grouped by the one he was captured
    // at first, which is how the List tab groups him too. A customer with no place yet has no brick,
    // and the picker shows him under "Not mapped yet" rather than guessing one.
    const [firstPlace] = customerPlaces;
    return {
      customerId,
      name: String(row.name),
      listType,
      grade,
      speciality: textOrNull(row.speciality),
      brickId: firstPlace?.brickId ?? null,
      brickName: firstPlace?.brickName ?? null,
      lastVisit: lastVisits.products.get(customerId) ?? null,
      lastNextStep: lastVisits.nextSteps.get(customerId) ?? null,
      places: customerPlaces.map((place) => ({
        placeId: place.placeId,
        label: place.label,
        address: place.address,
        lat: place.lat,
        lon: place.lon,
        photoPath: place.photoPath,
        capturedAt: place.capturedAt,
        todayWindows: describeDayWindows(place.timings, today, ramadan),
      })),
      plannedToday: planned.has(customerId),
      visitedToday: visitedToday.has(customerId),
      visitsThisMonth: visitCounts.get(customerId) ?? 0,
      target: gradeTarget(settings, listType, grade),
      pending: row.status === "pending",
      outside: row.status === "outside",
      referenceContactCrmId: numberOrNull(row.reference_contact_crm_id),
    };
  });
  // Today's planned customers first, then the rest by name. The picker groups by brick on top of this,
  // so within a brick the planned doctors still lead.
  options.sort((left, right) => Number(right.plannedToday) - Number(left.plannedToday) || left.name.localeCompare(right.name));

  let blockedReason: string | null = null;
  if (!seat.lineCode) blockedReason = "This territory has no line in the organogram, so visits cannot be saved.";
  else if (products.length === 0) blockedReason = `No products are on file for ${seat.lineName ?? "this line"} yet, so a visit cannot record the products discussed.`;
  const blind = isLocationBlind(viewer, seat);

  return {
    territory: describeTerritory(viewer.org, seat, names),
    isTest,
    cairoToday: today,
    enteredAs,
    managers: chain.map((member) => ({
      hrId: member.hrId,
      name: nameOf(names, member.hrId),
      title: seatTierTitle(member.seat.tier),
      position: member.position,
    })),
    viewerPosition: enteredAs === "manager" ? (chain.find((member) => member.hrId === viewer.hrId)?.position ?? null) : null,
    products,
    productFamilies,
    pharmacies,
    rules: { visitFarMeters: settings.visitFarMeters, weakGpsMeters: settings.weakGpsMeters },
    customers: options,
    todayVisits: visitRows.map((row) => mapVisitRow(row, names, { blind, org: viewer.org })),
    blockedReason,
  };
}

// ── Saving a visit ──────────────────────────────────────────────────────────────────────────────

export type SavedVisit = {
  visitId: string;
  visitDate: string;
  capturedAt: string;
  customerId: string;
  duplicate: boolean;
  locationFlag: VisitLocationFlag;
  locationLabel: string;
  /** The server's verdict, not the rep's choice — it is what he is told after the save. */
  isUnplanned: boolean;
  /** Which way it was off the plan, if it was — out of plan, or out of list. */
  unplannedKind: UnplannedKind | null;
  unplannedNote: string | null;
};

export async function saveVisit(viewer: PhoenixCrmViewer, raw: unknown): Promise<SavedVisit> {
  const body = record(raw);
  if (!isUuid(body.id)) throw validationError("Start the visit again from Add Visit.");
  const visitId = String(body.id).toLowerCase();
  const { seat, isTest, enteredAs } = territoryForVisit(viewer, body.seatId, readTestFlag(body.test));
  if (!seat.lineCode) throw validationError("This territory has no line in the organogram, so visits cannot be saved.");
  const draft = parseVisitDraft(body);
  if (!draft.ok) throw validationError(draft.error);
  const visit = draft.value;

  const participants = resolveVisitParticipants({
    index: viewer.org,
    territorySeatId: seat.seatId,
    actorHrId: viewer.hrId,
    enteredAs,
    kind: visit.kind,
    managerHrId: visit.managerHrId,
    seniorHrId: visit.seniorHrId,
  });
  if (!participants.ok) throw validationError(participants.error);

  const productFamilies = await lineProductsByFamily(seat.lineName);
  const allowedFamilies = new Set(productFamilies.map((entry) => entry.family));
  if (productFamilies.length === 0 || visit.products.some((product) => !allowedFamilies.has(product))) {
    throw validationError("Choose the products discussed from your line's products. Reload the page.");
  }
  // The pharmacy stock answers are per product (concentration), not per family, so they are kept only
  // for products still on the line. A product dropped from the line since the form loaded is quietly
  // left out rather than blocking the save.
  const allowedProducts = new Set(productFamilies.flatMap((entry) => entry.products));
  const productAvailability: Record<string, ProductAvailability> = {};
  for (const [product, answer] of Object.entries(visit.productAvailability)) {
    if (allowedProducts.has(product)) productAvailability[product] = answer;
  }

  const reviewer = territoryReviewer(viewer.org, seat.seatId);
  const supabase = getSupabaseAdmin();

  /**
   * A1 · WAS THIS VISIT CAPTURED WITH NO SIGNAL, AND IF SO WHEN?
   *
   * 🔴 The phone sends an anchor id and an ELAPSED DURATION, never a timestamp — the owner's
   * requirement (2026-09-27: "I don't want the time on the phone because they may install an app
   * that changes the time in the phone"). The server reads its own anchor row and does the
   * arithmetic, so `offlineCapturedAt` is DERIVED here and never copied out of the body.
   *
   * Every failure is SILENT and non-fatal. A missing, borrowed, stale or impossible claim leaves
   * this null, the save falls through to the photo slot exactly as it always did, and the rep is
   * told nothing (Golden Rule #1). A rep must never lose a real visit to an argument about a clock.
   */
  const offlineClaim = parseOfflineCaptureClaim(body);
  let offlineCapturedAt: string | null = null;
  let offlineAnchorId: string | null = null;
  if (offlineClaim) {
    const anchor = await readTimeAnchor(offlineClaim.anchorId).catch(() => null);
    const verdict = deriveOfflineCaptureTime(anchor, offlineClaim, {
      receivedAt: new Date(),
      hrId: viewer.hrId,
      seatId: seat.seatId,
    });
    if (verdict.ok) {
      offlineCapturedAt = verdict.capturedAt.toISOString();
      offlineAnchorId = offlineClaim.anchorId;
    }
  }
  const [placesResult, issuedAt] = await Promise.all([
    supabase
      .from("phoenix_crm_places")
      .select("id, lat, lon")
      .eq("customer_id", visit.customerId)
      .eq("seat_id", seat.seatId)
      .eq("is_test", isTest)
      .eq("status", "active"),
    // Only a caller that still sends a photo has a slot to read; the one-tap visit has none.
    visit.photoPath ? photoSlotIssuedAt(visit.photoPath) : Promise.resolve(null),
  ]);
  throwIfError(placesResult.error);
  const places = ((placesResult.data ?? []) as Row[]).map((row) => ({ id: String(row.id), lat: Number(row.lat), lon: Number(row.lon) }));
  const settings = viewer.config.settings;
  const check = checkVisitLocation({
    fix: { lat: visit.lat, lon: visit.lon, accuracyMeters: visit.accuracyMeters },
    places,
    farMeters: settings.visitFarMeters,
    weakGpsMeters: settings.weakGpsMeters,
  });
  const flag: VisitLocationFlag = places.length === 0 ? "no_place" : check.flag;
  // Whole metres: the database casts the distance to an integer and refuses "123.4".
  const distance = check.distanceMeters === null ? null : Math.round(check.distanceMeters);

  // Right after validating a customer, the place's photo can stand for the visit (the database allows it
  // only for the same person's photo of that customer, taken in the last 30 minutes).
  const reusePlacePhoto = body.reusePlacePhoto === true;
  const result = await callPhoenixCrm<Row>("phoenix_crm_save_visit", {
    p: {
      id: visitId,
      seat_id: seat.seatId,
      line_code: seat.lineCode,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      customer_id: visit.customerId,
      kind: visit.kind,
      rep_hr_id: participants.value.repHrId,
      manager_hr_id: participants.value.managerHrId,
      senior_hr_id: participants.value.seniorHrId,
      products: visit.products,
      pharmacy_name: visit.pharmacyName,
      product_availability: productAvailability,
      comment: visit.comment,
      photo_path: visit.photoPath,
      reuse_place_photo: reusePlacePhoto,
      // The spoken note, when the rep recorded one. It is passed beside the photo and it is not one:
      // no term of the visit's date reads it, and phoenix_crm_take_voice returns void so that none can.
      voice_note_path: visit.voiceNotePath,
      voice_note_seconds: visit.voiceNoteSeconds,
      voice_note_bytes: visit.voiceNoteBytes,
      // Off the plan, if that is what it turns out to be. The reason is sent whatever the rep chose —
      // the database asks for it only when its OWN test says the customer was not on a sent plan, so a
      // rep who chose "planned" for a doctor who was not planned is refused here and shown the box,
      // rather than quietly filed as planned. Where the approval starts is resolved from the
      // organogram, never from the phone: a territory with no manager seat above it begins at SFE.
      unplanned_reason: visit.unplannedReason,
      // The outcome. Already dropped-not-refused by parseVisitOutcome; the function does the same
      // again from its own lists, because the vocabulary has to be true of the column and not only of
      // the caller that happens to be in front of it today.
      next_step: visit.outcome.nextStep,
      next_step_on: visit.outcome.nextStepOn,
      objection: visit.outcome.objection,
      objection_note: visit.outcome.objectionNote,
      // Narrowed to the line's own products the same way product_availability is: a product dropped
      // from the line since the form loaded is quietly left out rather than blocking the save.
      samples_given: narrowSamplesToLine(visit.samplesGiven, allowedProducts),
      // 🔴 The one mention of a SILENT column in this file, and it is a WRITE. Nothing reads it back:
      // it is not in VISIT_COLUMNS, not on VisitRow and not in mapVisitRow, and the blind-half test
      // pins that every occurrence of it here lies inside saveVisit. The server derives the real
      // elapsed time itself; this is only what the phone claims, kept because a forged one is
      // constant. It never reaches the rep and can never refuse him a visit.
      form_open_seconds: visit.formOpenSeconds,
      unplanned_first_status: unplannedFirstStatus(reviewer !== null),
      reviewer_hr_id: reviewer?.hrId ?? null,
      lat: visit.lat,
      lon: visit.lon,
      accuracy_meters: visit.accuracyMeters,
      // The PHOTO’s own fix, stored beside the pin and never over it. NULL is NOT MEASURED - a
      // refused or slow shutter reading never costs the rep his visit, and nothing may read the
      // null as “same place as the pin”.
      photo_lat: visit.photoLat,
      photo_lon: visit.photoLon,
      photo_accuracy_meters: visit.photoAccuracyMeters,
      photo_captured_at: visit.photoCapturedAt,
      place_id: check.placeId,
      distance_meters: distance,
      location_flag: flag,
      // Against the photo slot's issue time when there is a photo, else against the moment the save
      // arrived — which is what dates a one-tap visit. Managers read it; the rep never does.
      device_skew_minutes: deviceClockSkewMinutes(visit.deviceCapturedAt, issuedAt ? new Date(issuedAt) : new Date()),
      // 🔴 A1. DERIVED ABOVE, never read from `body`. The database then re-checks it against now()
      // and a one-day floor, so the value passes two independent fences before it dates anything.
      offline_captured_at: offlineCapturedAt,
      time_anchor_id: offlineAnchorId,
    },
  });

  // Was this position real? Judged AFTER the save, deliberately: the answer never reaches the rep,
  // never changes what comes back to him, and can never cost him a visit he actually made. A repeat
  // save (`duplicate`) is skipped — the first one was already judged.
  if (result.duplicate !== true) {
    const capturedAt = new Date(String(result.captured_at));
    if (!Number.isNaN(capturedAt.getTime())) {
      await judgeCapture({
        subjectKind: "visit",
        subjectId: visitId,
        seatId: seat.seatId,
        repHrId: participants.value.repHrId ?? viewer.hrId,
        customerId: visit.customerId,
        isTest,
        fix: { lat: visit.lat, lon: visit.lon, accuracyMeters: visit.accuracyMeters, capturedAt },
        deviceMocked: visit.deviceMocked,
      });
    }
  }

  const isUnplanned = result.is_unplanned === true;
  const unplannedKind: UnplannedKind | null = isUnplanned ? (isUnplannedKind(result.unplanned_kind) ? result.unplanned_kind : "out_of_plan") : null;
  // An out-of-plan visit is the ONE visit that tells anybody (notifications.ts): it counts in nothing
  // until it is decided, so the manager who must decide it is told. An out-of-list visit raises no
  // approval of its own — its CUSTOMER's add request is what the district manager decides. A repeat
  // save is skipped — the first one already raised it, and the notice's idempotency key would drop
  // the second anyway.
  if (unplannedKind === "out_of_plan" && result.duplicate !== true) {
    await notifyPhoenixCrm(
      {
        kind: "unplanned_visit_raised",
        org: viewer.org,
        seat,
        visitId,
        repHrId: participants.value.repHrId ?? viewer.hrId,
        customerName: textOrNull(result.customer_name) ?? "a customer",
        visitDate: String(result.visit_date),
        clarification: visit.unplannedReason ?? "",
      },
      isTest,
    );
  }
  // The rep is told his visit is saved and nothing about where he was (Golden Rule #1).
  const location = isLocationBlind(viewer, seat)
    ? BLIND_LOCATION
    : { locationFlag: flag, locationLabel: visitLocationLabel(flag, distance, visit.accuracyMeters) };
  return {
    visitId: String(result.id),
    visitDate: String(result.visit_date),
    capturedAt: String(result.captured_at),
    customerId: String(result.customer_id),
    duplicate: result.duplicate === true,
    ...location,
    isUnplanned,
    unplannedKind,
    unplannedNote:
      unplannedKind === "out_of_list"
        ? OUT_OF_LIST_REP_NOTE
        : unplannedKind === "out_of_plan"
          ? unplannedVisitRepNote(unplannedFirstStatus(reviewer !== null))
          : null,
  };
}
