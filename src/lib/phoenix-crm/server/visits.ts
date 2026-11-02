/**
 * Phoenix CRM — visits: the Add Visit form, saving a visit, and a territory's visits of a day.
 *
 * Owner, 2026-09-16:
 *   - the rep enters visits; a district manager can, but normally goes out on a double visit that the
 *     rep enters and that counts for the manager too; a chain visit adds a senior manager;
 *   - each visit records a location check against the customer's validated place, the products
 *     discussed (from the line's products), a live photo of the clinic sign or door, and a comment;
 *   - double and chain visits count straight away — there is no confirmation step;
 *   - a visit saved far from the validated place still saves, flagged for the manager — EXCEPT a
 *     medical rep's own, which since 2026-10-20 is REFUSED past the far line from the customer's
 *     validated photograph (owner: "not accept medical reps visits logged away from the validated
 *     picture of the customer with maximum 300 m apart"; `visitAwayFromValidatedPlace`). A visit a
 *     manager enters still saves and is flagged;
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
 *     gone (`isLocationBlind`). His managers read the DISTANCE only (owner, 2026-10-02); the SFE Manager
 *     and the Super Admin keep every measure (`locationSight`, `visitLocationFor`).
 *
 * A visit may also carry a spoken note (owner, 2026-09-25), and the emphasis above is why it is worth
 * saying here: the note is audio the rep recorded, kept as audio and never transcribed, and it dates
 * NOTHING. A photo is taken where the camera is; a recording can be made in a car an hour later. So
 * the photo's slot gives `captured_at` and the voice slot gives nothing at all — phoenix_crm_take_voice
 * returns void, which is what stops a later edit here reaching for its issue time out of habit.
 */

import { refreshSharedCrmWindows } from "@/lib/crm/shared-windows";
import { validationError } from "@/lib/http/api-errors";
import { afterResponse } from "@/lib/http/after-response";
import { cairoBusinessDay, fieldWeekStart, isIsoDay, isRamadanDay, monthStartOf } from "@/lib/phoenix-crm/calendar";
import { gradeTarget } from "@/lib/phoenix-crm/coverage";
import type { DayStartView } from "@/lib/phoenix-crm/day-start-rules";
import { loadDayStartOn } from "@/lib/phoenix-crm/server/day-start";
import {
  DEVICE_CLOCK_TOLERANCE_MINUTES,
  deviceClockSkewMinutes,
  farVisitRefusalApplies,
  parseGrade,
  parseProductAvailability,
  parseVisitDraft,
  UNVALIDATED_CUSTOMER_VISIT_REFUSED,
  unvalidatedVisitRefused,
  VISIT_AWAY_FROM_PLACE,
  VISIT_PRODUCTS_MAX,
  visitAwayFromValidatedPlace,
  type ProductAvailability,
  type VisitDraft,
} from "@/lib/phoenix-crm/entry-rules";
import { checkVisitLocation } from "@/lib/phoenix-crm/geo";
import { BLIND_LOCATION, visitLocationFor, type VisitLocationFlag } from "@/lib/phoenix-crm/visit-location-words";
import { pickLastVisitProducts, type LastVisitProducts } from "@/lib/phoenix-crm/last-visit-products";
import { isEnteredForRep } from "@/lib/phoenix-crm/missed-records";
import { deriveOfflineCaptureTime, parseOfflineCaptureClaim } from "@/lib/phoenix-crm/offline-clock";
import {
  doctorListType,
  isPharmacyListType,
  linkedPharmaciesNote,
  linkNamedPharmacies,
  parseListType,
  PHARMACY_CALL_REP_NOTE,
  pharmacyNameKey,
  splitNamedPharmacies,
  type ListedPharmacy,
} from "@/lib/phoenix-crm/pharmacy-call-rules";
import { describeSamples, narrowSamplesToLine, parseSamplesGiven } from "@/lib/phoenix-crm/samples";
import {
  pickLastNextStep,
  visitNextStepLabel,
  visitObjectionLabel,
  isVisitNextStep,
  isVisitObjection,
  type LastNextStep,
} from "@/lib/phoenix-crm/visit-outcome";
import { doubleVisitDayChoices, doubleVisitSavedNote } from "@/lib/phoenix-crm/double-visit-request-rules";
import { raisesVisitAsk, visitAskLastDay } from "@/lib/phoenix-crm/visit-ask-rules";
import { visitDetailEditable } from "@/lib/phoenix-crm/visit-detail-edit-rules";
import { PHOENIX_VISIT_KIND_LABELS } from "@/lib/phoenix-crm/visit-kind-labels";
import { MANAGER_OWN_VISIT_CLOSED } from "@/lib/phoenix-crm/manager-plan-rules";
import { managerOwnVisitClosedNow } from "@/lib/phoenix-crm/server/manager-plan-switch";
import { isVacantTerritory } from "@/lib/phoenix-crm/server/manager-customers";
import { logManagerVisit, plannedSingleVisitSlotFor } from "@/lib/phoenix-crm/server/manager-visits";
import { describeDayWindows, isPlanSentForReview, isUuid, planDayStatus } from "@/lib/phoenix-crm/plan-rules";
import { managerChain, personKey, resolveVisitParticipants, territoryReviewer, type OrgIndex } from "@/lib/phoenix-crm/scope";
import {
  canWriteAsRep,
  locationSight,
  ownDaySeat,
  readTestFlag,
  territoryForRead,
  territoryForVisit,
  type LocationSight,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { blindVisitForm } from "@/lib/phoenix-crm/server/blind-payloads";
import { type CaptureClient } from "@/lib/phoenix-crm/server/capture-client";
import { recordCaptureProvenance } from "@/lib/phoenix-crm/server/capture-provenance";
import { loadDayActivityOn, type DayActivityRow } from "@/lib/phoenix-crm/server/day-activities";
import { callPhoenixCrm, numberOrNull, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { judgeCapture } from "@/lib/phoenix-crm/server/location-integrity";
import { ensureReferenceCustomersRecently, loadListedPharmacies, loadMonthVisitCounts, loadTerritoryCustomers } from "@/lib/phoenix-crm/server/list";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadPlannedOtherDays } from "@/lib/phoenix-crm/server/offplan-day";
import { loadOffPlanExemptions, loadOffPlanRows } from "@/lib/phoenix-crm/server/offplan-cap";
import { offPlanAllowance, offPlanWeekWindow, type OffPlanAllowance } from "@/lib/phoenix-crm/offplan-cap-rules";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { loadPlanDayFacts, PLAN_DAY_COLUMNS } from "@/lib/phoenix-crm/server/plan-day-status";
import { photoSlotIssuedAt } from "@/lib/phoenix-crm/server/photos";
import { recordFarVisitRefusal, recordRefusedReading } from "@/lib/phoenix-crm/server/refused-readings";
import { readTimeAnchor } from "@/lib/phoenix-crm/server/time-anchor";
import {
  claimRequiredRecording,
  hearsVisitRecording,
  isRecordingRequired,
  loadRecordingsByVisit,
} from "@/lib/phoenix-crm/server/visit-recordings";
import { RECORDED_VISIT_REP_NOTE, type RecordingReviewStatus } from "@/lib/phoenix-crm/visit-recording-rules";
import { lineProductsByFamily, type LineProductFamily } from "@/lib/phoenix-crm/server/products";
import { prepareDoubleVisitRequest, raiseDoubleVisitRequestFromVisit } from "@/lib/phoenix-crm/server/double-visit-requests";
import { loadPlanHolidays } from "@/lib/phoenix-crm/server/plan-holidays";
import { loadLineProductManagers, raiseVisitAskFromVisit, visitAskSavedNote } from "@/lib/phoenix-crm/server/visit-asks";
import { describeTerritory, personSeatTitle, seatTierTitle, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmPlanStatus, PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";
import {
  customerCountsAsValidated,
  isUnplannedKind,
  isUnplannedVisitStatus,
  outOfListVisitNote,
  OUT_OF_LIST_REP_NOTE,
  reviewerWasOnTheVisit,
  unplannedFirstStatus,
  unplannedVisitRepNote,
  unplannedVisitStatusLabel,
  visitCountsInKpi,
  visitIsArchiveHistory,
  type UnplannedKind,
  type UnplannedVisitStatus,
} from "@/lib/phoenix-crm/unplanned-rules";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

/**
 * THE LOCATION WORDING AND ITS THREE TIERS LIVE IN `@/lib/phoenix-crm/visit-location-words`,
 * re-exported here so every existing caller keeps its import.
 *
 * Moved on 2026-10-07 because the old CRM's ADMIN reports now print these same sentences (owner:
 * "everything, GPS and evidence included"), and anything importing THIS file is server-only — it
 * reaches `getSupabaseAdmin`. A report shaper that pulled it in would drag the service-role client
 * into any client bundle that touched it. Nothing about the tiers changed in the move.
 */
export {
  BLIND_LOCATION,
  MISSED_VISIT_LOCATION_LABEL,
  visitLocationFor,
  visitLocationLabel,
  type VisitLocationFlag,
} from "@/lib/phoenix-crm/visit-location-words";

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
  /** The line's product manager who came along, on a `product_manager` visit. Null on every other. */
  productManagerName: string | null;
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
  /**
   * A product manager holds NO SEAT in the organogram, so the tree has no title for him. His APP ROLE
   * is the title — "Product Manager", "Group Product Manager", or the Marketing Manager on CNS — and
   * it is read from the same list that offered him.
   */
  productManagerTitle: string | null;
  /**
   * Everyone else on the visit, past the four places above, each by name and title (owner, 2026-10-27:
   * "Everything is applicable" — a Training Manager beside a product manager, a third manager up the
   * line). Read from `phoenix_crm_visit_companions`; empty on a visit that carries no one more.
   */
  moreCompanions: Array<{ name: string; title: string | null }>;
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
  /**
   * The length of the visit's RECORDING — the conversation the Super Admin requires of the reps he
   * chooses (owner, 2026-10-16) — present only for a reader who may hear it (`hearsVisitRecording`):
   * the Super Admin, an SFE manager, a manager above the territory. Absent for the rep, and for every
   * visit with no recording. The audio itself is signed one visit at a time.
   */
  recordingSeconds?: number | null;
  /**
   * Where a RECORDED visit's approval has got to (owner, 2026-10-16) — for EVERY reader, the rep
   * included: it is his own approval, shown on his own list as "Pending admin approval" until the
   * Administrator decides. It carries no length and no audio. Absent on a visit with no recording.
   */
  recordingReview?: RecordingReviewStatus;
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
   * Whether the visit's customer counts as validated (`customerCountsAsValidated`: a pharmacy needs no
   * validation) and so is admitted to the list. False is NORMAL on a
   * team that has just started — 0 of Delta (1)'s 1,551 carried-over customers were validated the
   * day before it began — and the visit is saved and real either way.
   */
  customerValidated: boolean;
  /**
   * Copied from the old system's history (`imported_from_ireports360_at`). It carries its day and no clock: its
   * `capturedAt` is that day's midnight in Cairo, which nobody saw, so a screen prints no time for it.
   */
  copiedFromOldSystem: boolean;
  /** `visitIsArchiveHistory`: copied, to a customer in the Archive. In no figure, and waiting for nobody. */
  archiveHistory: boolean;
  /**
   * 🔴 Whether this visit is inside a KPI figure — `visitCountsInKpi`, the TypeScript twin of
   * `phoenix_crm_countable_visits` and its `customer_validated` column. A screen reading the RAW
   * table has no view to ask, so a count on such a screen reads this instead of counting rows: it is
   * what keeps the day page's three figures equal to the calendar cell that opens it.
   */
  countsInKpi: boolean;
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
  /**
   * The rep's SECOND, longer account of the call, written afterwards (owner, 2026-10-15). The door
   * comment above stays exactly as he left it and is not editable by him.
   */
  detailComment: string | null;
  /** When he last changed the detail, for the "Edited · <Cairo date and time>" line. */
  detailEditedAt: string | null;
  /**
   * Whether this visit's detail is the READER's own to fill in — his own visit, and not the pharmacy
   * visit another visit filed. False for every reader but the rep who made it, and false whenever the
   * caller names no actor, so a screen that never asks offers nothing.
   */
  detailEditable: boolean;
};

export type VisitOutcomeView = {
  nextStepLabel: string | null;
  nextStepOn: string | null;
  objectionLabel: string | null;
  objectionNote: string | null;
};

const VISIT_COLUMNS =
  "id, visit_date, captured_at, customer_id, list_type, kind, rep_hr_id, manager_hr_id, senior_hr_id, product_manager_hr_id, entered_by_hr_id, products, " +
  "comment, pharmacy_name, product_availability, photo_path, voice_note_path, voice_note_seconds, " +
  // The rep's own second account, written afterwards, and when he last changed the detail (owner,
  // 2026-10-15). `linked_from_visit_id` is read for one reason only: the pharmacy visit a doctor's
  // visit filed has no detail of its own to fill in, so its card offers nothing, and nor does a visit
  // copied from the old system, which is history.
  "detail_comment, detail_edited_at, linked_from_visit_id, imported_from_ireports360_at, " +
  // `lat` and `lon` are read only to say whether the row holds a reading; `mapVisitRow` passes no coordinate on.
  "lat, lon, accuracy_meters, distance_meters, location_flag, device_skew_minutes, is_unplanned, unplanned_kind, " +
  "next_step, next_step_on, objection, objection_note, samples_given, " +
  // `validated_at` and `list_type` are the other half of "does this count" (`visitCountsInKpi`): the approval half is
  // the embedded `unplanned` row, and a reader of the raw table has to ask for both by name.
  "customer:phoenix_crm_customers!customer_id(name, status, validated_at, list_type), " +
  // Everyone on the visit, in its order (2026-10-27) — the card names those past the fixed places.
  "companions:phoenix_crm_visit_companions(hr_id, position), " +
  // `manager_decided_at` is read for the REP's own sentence, not for a manager's screen: `sfe_pending`
  // is reached either by a manager approving it or by his step never having been available, and only
  // this column tells the two apart. Without it the rep is told "your manager approved it" about a
  // step nobody took. It is a timestamp, never a name — Golden Rule #1 keeps people off his screen.
  "unplanned:phoenix_crm_unplanned_visits!visit_id(status, clarification, manager_decided_at)";

function visitKind(value: unknown): PhoenixCrmVisitKind {
  return value === "double" || value === "chain" || value === "product_manager" ? value : "single";
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
    note: unplannedVisitRepNote(status, entry.manager_decided_at != null),
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
    textOrNull(row.product_manager_hr_id),
    textOrNull(row.entered_by_hr_id),
    ...listedCompanions(row),
  ]);
}

/** The hr ids a visit's companions list holds, in its order; none on a visit saved before 2026-10-27. */
function listedCompanions(row: Row): string[] {
  return (Array.isArray(row.companions) ? row.companions : [])
    .map((entry) => record(entry))
    .sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0))
    .flatMap((entry) => {
      const hrId = textOrNull(entry.hr_id);
      return hrId ? [hrId] : [];
    });
}

/**
 * One visit row, as a screen reads it. `sight` is how much of its location this reader may read
 * (`locationSight`): on the rep's own territory nothing — no distance, no flag, no check (Golden Rule #1,
 * owner 2026-09-29); for a manager the distance only, with no phone-clock mark (owner, 2026-10-02); for
 * the Super Admin and the SFE Manager everything.
 */
/**
 * Each product manager who could have been on this seat's visits, by his APP ROLE — the title the
 * organogram cannot give, because he holds no seat in it at all. One cached read
 * (`loadLineProductManagers`, the same list that offered him), and an EMPTY map where the line cannot
 * be read, which prints no title rather than a wrong one.
 */
async function productManagerRolesFor(org: OrgIndex, seatId: string): Promise<ReadonlyMap<string, string>> {
  const seat = org.seats.get(seatId);
  if (!seat) return new Map();
  const managers = await loadLineProductManagers(seat);
  const out = new Map<string, string>();
  for (const manager of managers) {
    const hrId = personKey(manager.hrId);
    if (hrId) out.set(hrId, manager.role);
  }
  return out;
}

function mapVisitRow(
  row: Row,
  names: PeopleNames,
  options: { sight: LocationSight; org: OrgIndex; productManagerRoles?: ReadonlyMap<string, string>; actorHrId?: string },
): VisitRow {
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
  const appRole = (value: unknown) => {
    const hrId = personKey(textOrNull(value));
    return hrId ? options.productManagerRoles?.get(hrId) ?? null : null;
  };
  const unplannedKind = row.is_unplanned === true ? (isUnplannedKind(row.unplanned_kind) ? row.unplanned_kind : "out_of_plan") : null;
  const unplannedApproval = unplannedKind === "out_of_plan" ? visitUnplanned(row) : null;
  const customerRow = record(row.customer);
  const customerValidated = customerCountsAsValidated({ validatedAt: textOrNull(customerRow.validated_at), listType: customerRow.list_type });
  const importedAt = textOrNull(row.imported_from_ireports360_at);
  const enteredByAdmin = isEnteredForRep({ enteredBy: row.entered_by_hr_id, rep: row.rep_hr_id, manager: row.manager_hr_id, senior: row.senior_hr_id });
  return {
    visitId: String(row.id),
    visitDate: String(row.visit_date),
    capturedAt: String(row.captured_at),
    customerId: String(row.customer_id),
    customerName: textOrNull(record(row.customer).name) ?? "Customer",
    listType: parseListType(row.list_type),
    kind,
    kindLabel: PHOENIX_VISIT_KIND_LABELS[kind],
    repName: person(row.rep_hr_id),
    managerName: person(row.manager_hr_id),
    seniorName: person(row.senior_hr_id),
    productManagerName: person(row.product_manager_hr_id),
    repTitle: title(row.rep_hr_id),
    managerTitle: title(row.manager_hr_id),
    seniorTitle: title(row.senior_hr_id),
    // His app role, because the organogram holds no seat for him to take a title from.
    productManagerTitle: appRole(row.product_manager_hr_id),
    moreCompanions: (() => {
      const placed = new Set([row.rep_hr_id, row.manager_hr_id, row.senior_hr_id, row.product_manager_hr_id].map((value) => personKey(textOrNull(value))).filter(Boolean));
      return listedCompanions(row)
        .filter((hrId) => !placed.has(personKey(hrId)))
        .map((hrId) => ({ name: nameOf(names, hrId), title: title(hrId) ?? appRole(hrId) }));
    })(),
    enteredByName: nameOf(names, textOrNull(row.entered_by_hr_id)),
    enteredByAdmin,
    products: Array.isArray(row.products) ? row.products.map(String) : [],
    pharmacyName: textOrNull(row.pharmacy_name),
    productAvailability: parseProductAvailability(row.product_availability),
    comment: textOrNull(row.comment),
    photoPath: textOrNull(row.photo_path),
    voiceNotePath: textOrNull(row.voice_note_path),
    voiceNoteSeconds: numberOrNull(row.voice_note_seconds),
    ...visitLocationFor(options.sight, flag, numberOrNull(row.distance_meters), numberOrNull(row.accuracy_meters), enteredByAdmin, numberOrNull(row.lat) !== null && numberOrNull(row.lon) !== null),
    // The phone's clock is a reading, not a distance: the Super Admin's and the SFE Manager's alone.
    clockOff: options.sight === "full" && skew !== null && Math.abs(skew) > DEVICE_CLOCK_TOLERANCE_MINUTES,
    // The same value #5171 computed inline, read from the one `const` above — `countsInKpi` below
    // needs that approval's status too, and asking `visitUnplanned(row)` twice is two answers.
    unplanned: unplannedApproval,
    unplannedKind,
    customerValidated,
    copiedFromOldSystem: importedAt !== null,
    archiveHistory: visitIsArchiveHistory({ importedAt, customerStatus: textOrNull(customerRow.status), customerValidated }),
    countsInKpi: visitCountsInKpi({
      isUnplanned: row.is_unplanned === true,
      unplannedKind,
      unplannedStatus: unplannedApproval?.status ?? null,
      customerValidated,
    }),
    outOfList: unplannedKind === "out_of_list" ? outOfListVisitNote(textOrNull(record(row.customer).status)) : null,
    outcome: visitOutcome(row),
    samples: describeSamples(parseSamplesGiven(row.samples_given)),
    detailComment: textOrNull(row.detail_comment),
    detailEditedAt: textOrNull(row.detail_edited_at),
    // The pure rule, asked with the reader as the actor. No actor — a manager's board, a report, the
    // customer's timeline — answers false, which is the right direction: the button appears only where
    // the screen deliberately said who is looking.
    detailEditable:
      options.actorHrId !== undefined &&
      visitDetailEditable({
        repHrId: textOrNull(row.rep_hr_id),
        linkedFromVisitId: textOrNull(row.linked_from_visit_id),
        actorHrId: options.actorHrId,
        importedAt,
      }).editable,
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
  /** The rep's own day to describe; a manager enters his visits but never how he spent his day on a rep's seat. */
  canSetDayActivity: boolean;
  /**
   * A DISTRICT manager describing HIS OWN day from a rep's territory (owner, 2026-10-20): true only
   * today, only for him, and never where `canSetDayActivity` already is. It lands on his own seat, so
   * `ownDayActivity` is what HE recorded — never the rep's, which `dayActivity` keeps.
   */
  canSetOwnDayActivity: boolean;
  ownDayActivity: DayActivityRow | null;
  /**
   * Whether the reader may fill in the detail of his own visits on this day (owner, 2026-10-15).
   *
   * 🔴 IT CARRIES NO DAY CONDITION, unlike `canSetDayActivity` above: he was asked directly and
   * answered "any time", so a visit he logged last week is still his to write up. The per-visit half
   * is `detailEditable` on the row.
   */
  canAddVisitDetail: boolean;
  /**
   * When he confirmed he started working, if he has (owner, 2026-10-03). Null before the press, and
   * on every day he never pressed it — which is itself the answer his manager reads.
   */
  dayStart: DayStartView | null;
};

/**
 * The seat, test flag and day a visit-day read is ABOUT — with no read of its own, and the same refusal
 * `territoryForRead` throws. Exported so the day page can start its other reads of the same day BESIDE
 * `loadVisitDay` instead of after it (2026-10-31, "fix the slowest five pages"), with the day clamped
 * here, once, for both.
 */
export function resolveVisitDayAddress(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; date: unknown },
): { seat: ReturnType<typeof territoryForRead>["seat"]; isTest: boolean; date: string } {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  // The visit day, not the calendar day: until 02:00 the day that just ended is still the one a rep
  // adds to (owner, 2026-09-29). A past day is read only; a future one does not exist yet.
  const today = viewer.visitDay;
  const date = isIsoDay(raw.date) && raw.date <= today ? raw.date : today;
  return { seat, isTest, date };
}

export async function loadVisitDay(viewer: PhoenixCrmViewer, raw: { seatId: unknown; test: unknown; date: unknown }): Promise<VisitDayView> {
  const { seat, isTest, date } = resolveVisitDayAddress(viewer, raw);
  const today = viewer.visitDay;
  const ownSeat = date === today ? ownDaySeat(viewer, seat) : null;
  // TWO WAVES, NOT THREE (2026-10-23, every page change under 1 second). The day's activities, its
  // start and the line's product managers need only the seat and the date, so they start BESIDE the
  // visit rows instead of after them; the names and the recordings need the rows, and go together in
  // the one wave after. Every answer is the one the three waves gave, and the rows' own failure is
  // still the one that surfaces first — the early reads are handled the moment they start.
  const rowsRead = loadVisitRows(seat.seatId, isTest, date);
  const dayReads = Promise.all([
    loadDayActivityOn(seat.seatId, isTest, date),
    ownSeat ? loadDayActivityOn(ownSeat.seatId, isTest, date) : Promise.resolve(null),
    productManagerRolesFor(viewer.org, seat.seatId),
    loadDayStartOn(seat.seatId, isTest, date),
  ]);
  dayReads.catch(() => undefined);
  const rows = await rowsRead;
  // The visit recordings. Their LENGTH (what draws the player) goes only to a reader who may hear them;
  // the Administrator's approval is read for every reader, because a recorded visit he has not approved
  // counts in nothing (owner, 2026-10-16) and `countsInKpi` must say what the countable view says.
  const [names, recordings, [activity, ownDayActivity, productManagerRoles, dayStart]] = await Promise.all([
    loadPeopleNames([...territoryPeople(viewer.org, [seat]), ...visitPeople(rows)]),
    loadRecordingsByVisit(rows.map((row) => String(row.id))),
    dayReads,
  ]);
  const sight = locationSight(viewer, seat);
  const hears = hearsVisitRecording(viewer, seat);
  return {
    territory: describeTerritory(viewer.org, seat, names),
    isTest,
    date,
    visits: rows.map((row) => {
      const visit = mapVisitRow(row, names, { sight, org: viewer.org, productManagerRoles, actorHrId: viewer.hrId });
      const recording = recordings.get(visit.visitId);
      if (!recording) return visit;
      const countsInKpi = visit.countsInKpi && recording.reviewStatus === "approved";
      const reviewed = { ...visit, countsInKpi, recordingReview: recording.reviewStatus };
      return hears && recording.seconds !== null ? { ...reviewed, recordingSeconds: recording.seconds } : reviewed;
    }),
    canAdd: date === today && canEnterVisits(viewer, seat.seatId, isTest),
    dayActivity: activity,
    canSetDayActivity: date === today && canWriteAsRep(viewer, seat, isTest),
    canSetOwnDayActivity: ownSeat !== null,
    ownDayActivity,
    canAddVisitDetail: canWriteAsRep(viewer, seat, isTest),
    dayStart,
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
  /**
   * The OTHER days of this field week on which he stands on the rep's SENT plan and has not been seen
   * yet (owner, 2026-10-02: "Moved-day reason pre-filled"). When the rep picks Out of plan for him, the
   * reason fills itself in from these days and the rep can still change it — no step added, typing
   * removed. Empty for everyone else. His own plan, never a check on him.
   */
  plannedOtherDays: string[];
  visitedToday: boolean;
  visitsThisMonth: number;
  target: number | null;
  /**
   * Carried over from iReports360 and not validated yet: he has no place, the visit saves with no
   * location to compare against, and it counts in nothing until he is validated.
   */
  pending: boolean;
  /**
   * 🔴 HIS THIRD VISIT HERE WOULD BE REFUSED: nobody has validated this customer and the seat already holds
   * two visits to him (owner, 2026-10-28, `unvalidatedVisitRefused`). Add visit says so on the row and
   * offers no visit, instead of letting him fill one in for the save to refuse — 21 refusals from 7 reps
   * on 31 Oct 2026, every one after a whole visit was written (System Audit). His own work and the way
   * out, the save's own sentence: never a count. False on a manager's form, whose visits still save.
   */
  validateFirst: boolean;
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
  /**
   * 🔴 A PHARMACY'S OWN PINNED LOCATION (owner, 2026-10-09) — null on every doctor, and on every
   * pharmacy nobody has pinned. It is what makes the Directions link work for a pharmacy at all: a
   * pharmacy has no validated place, so until it could be pinned there was nothing to drive to.
   *
   * It carries WHERE and never HOW WELL (Golden Rule #1): no accuracy, no brick distance, nothing the
   * rep could read as a measurement of himself. He pinned it himself, standing in the shop.
   */
  pharmacyPin: { lat: number; lon: number; address: string | null; governorate: string | null; areaName: string | null; brickName: string | null } | null;
  /** A pharmacy's responsible person's phone (owner, 2026-10-09). Pharmacies only, and optional. */
  pharmacyPhone: string | null;
};

/**
 * A pinned pharmacy as the picker reads it: where it is, and nothing about how well it was read.
 * Both coordinates or no pin at all, exactly as the database's own check constraint has it.
 */
function pickerPharmacyPin(row: Record<string, unknown>): VisitCustomerOption["pharmacyPin"] {
  const lat = numberOrNull(row.pharmacy_pin_lat);
  const lon = numberOrNull(row.pharmacy_pin_lon);
  if (lat === null || lon === null) return null;
  return {
    lat,
    lon,
    address: textOrNull(row.pharmacy_pin_address),
    governorate: textOrNull(row.pharmacy_pin_governorate),
    areaName: textOrNull(row.pharmacy_pin_area_name),
    brickName: textOrNull(row.pharmacy_pin_brick_name),
  };
}

export type VisitPerson = {
  /** The value the form sends back; shown by name only. */
  hrId: string;
  name: string;
  title: string;
  /** 0 = the territory's nearest manager; a senior manager sits at a higher position than the manager. */
  position: number;
};

/**
 * A product manager a rep may name on a visit. No `position`, deliberately: position is a rung on the
 * territory's manager chain, and he is on no rung of it — he holds no seat in the organogram at all.
 */
export type VisitProductManager = { hrId: string; name: string; title: string };

export type VisitFormView = {
  territory: TerritorySummary;
  isTest: boolean;
  cairoToday: string;
  enteredAs: "rep" | "manager";
  /** The territory's managers, nearest first: the manager and senior manager are chosen from these. */
  managers: VisitPerson[];
  /** Entering as a manager: the viewer's own position in `managers` (they are the visit's manager). */
  viewerPosition: number | null;
  /**
   * Entering as a manager who holds a DM or acting DM seat: "My own visit" is closed (owner, 2026-10-16
   * — he logs it on his own plan, where it counts in his own report only). False for a rep and for an
   * RSM or NSM entering.
   */
  ownVisitClosed: boolean;
  /**
   * 🔴 AND OPEN AGAIN ON A VACANT TERRITORY (owner, 2026-10-19): nobody holds the seat, so there is no
   * rep to make a double or a chain with. "My own visit" stays pickable and the save files it under My
   * single visits (`MANAGER_OWN_VISIT_ON_VACANT_LINE`). False for a rep, and false on a territory that
   * has a rep — there the option stays closed.
   */
  ownVisitVacant: boolean;
  /**
   * The product managers of the territory's LINE, listed beside the managers under "Double visit" and
   * "Chain visit" on "Who was on the visit" (owner, 2026-10-02; one list since 2026-10-06, so the rep
   * ticks one person for a double and two for a chain) — the same list the rep's own ask offers
   * (`loadLineProductManagers`). Empty where the line has none, and the list then holds managers only.
   */
  productManagers: VisitProductManager[];
  /**
   * The days the LAST question may offer (owner, 2026-10-16: "do you need a double visit with this
   * customer?"): today and every field day of the next four weeks, never a Friday or a public holiday.
   * Empty when a manager enters the visit, who asks nothing of anybody.
   */
  doubleVisitDays: string[];
  /** The line's discussed choices — the family names — for "Products discussed". */
  products: string[];
  /** The same products grouped by family, for the finer per-product pharmacy-stock check. */
  productFamilies: LineProductFamily[];
  /** Pharmacies this seat has typed on earlier visits, most recent first, for the name suggestions. */
  pharmacies: string[];
  /**
   * How far is far, and how rough a reading may be — the thresholds a visit is JUDGED by, so the
   * territory's own rep never receives them (`blindVisitForm`, audit 2026-10-02). Nothing on the form
   * draws either; a manager entering his own visit still gets them.
   */
  rules?: { visitFarMeters: number; weakGpsMeters?: number };
  customers: VisitCustomerOption[];
  todayVisits: VisitRow[];
  /**
   * Today's plan as it actually stands — the week plan's status, and how many stops he has SAVED for
   * today whatever that status is.
   *
   * It exists so Add visit can say WHY "Planned visit" has nobody to offer (today-rules.ts
   * `plannedStartEmptyNote`). `customers[].plannedToday` stays the SENT set and nothing else: it is
   * what the picker offers and what the ordering follows, and widening it to a draft is precisely the
   * defect the status filter below exists to prevent. These two numbers differ only when the rep has
   * planned his day and not sent it — the morning of 2026-10-01, which is what this answers.
   */
  planToday: { status: PhoenixCrmPlanStatus | null; saved: number };
  /** Why no visit can be saved here, in one sentence; null when nothing stops it. */
  blockedReason: string | null;
  /**
   * Where this territory stands on the out-of-plan allowance — two doctors a day, eight a week (owner,
   * 2026-10-10) — shown on the unplanned steps so nobody meets the limit by being refused. The door
   * enforces it either way (`phoenix_crm_visits_offplan_cap`).
   */
  offPlan: OffPlanAllowance;
  /**
   * Whether this rep must record the conversation before the visit form opens (owner, 2026-10-16). True
   * only for the territory's own rep, and only when the Super Admin has switched that rep on; a manager
   * entering a visit is never asked. The save refuses a chosen rep's visit with no recording either way.
   */
  recordingRequired: boolean;
};

/**
 * The pharmacy names the form suggests as he types: the ones this seat has typed before, most recent
 * first, then the pharmacies on his list (owner, 2026-10-03) — so picking a suggestion is picking the
 * pharmacy his visit is filed against (`linkNamedPharmacy`), spelled as the list spells it. One name
 * per pharmacy, keyed by `pharmacyNameKey`; he can always type a new one. A box he once filled with
 * two pharmacies is offered as the two it named (`splitNamedPharmacies`), never as one name.
 */
export async function loadSeatPharmacies(seatId: string, isTest: boolean): Promise<string[]> {
  const [typed, listed] = await Promise.all([
    getSupabaseAdmin()
      .from("phoenix_crm_visits")
      .select("pharmacy_name, captured_at")
      .eq("seat_id", seatId)
      .eq("is_test", isTest)
      .not("pharmacy_name", "is", null)
      // A name on a copied visit is the old system's. Offered here, picking it would file a new pending
      // pharmacy (loadListedPharmacies hides the imported one) and use up the 50 below on old names.
      .is("imported_from_ireports360_at", null)
      .order("captured_at", { ascending: false })
      .limit(500),
    loadListedPharmacies(seatId, isTest),
  ]);
  throwIfError(typed.error);
  const seen = new Set<string>();
  const names: string[] = [];
  const offer = (raw: unknown) => {
    const name = textOrNull(raw);
    if (!name) return;
    const key = pharmacyNameKey(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };
  // A box can name several pharmacies, so the 50 is checked per NAME, never per row.
  rows: for (const row of (typed.data ?? []) as Row[]) {
    for (const name of splitNamedPharmacies(textOrNull(row.pharmacy_name))) {
      if (names.length >= 50) break rows;
      offer(name);
    }
  }
  for (const pharmacy of listed) {
    if (pharmacy.status !== "dropped") offer(pharmacy.name);
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
export async function loadVisitRowsForDay(seatId: string, isTest: boolean, date: string, options: { sight: LocationSight; org: OrgIndex }): Promise<VisitRow[]> {
  const rows = await loadVisitRows(seatId, isTest, date);
  const [names, productManagerRoles] = await Promise.all([loadPeopleNames(visitPeople(rows)), productManagerRolesFor(options.org, seatId)]);
  return rows.map((row) => mapVisitRow(row, names, { ...options, productManagerRoles }));
}

/**
 * The customers on a SENT plan for one day, and whether a sent plan exists at all.
 *
 * `plannedCustomerIds` answers only the first half, and the Today screen needs the second: "no plan
 * sent yet" and "a sent plan with nobody on today" are different sentences to a rep, and showing the
 * wrong one sends him to the wrong screen.
 *
 * 🔴 `status` is what the plan says about THIS DAY (plan-rules.ts `planDayStatus`), never the week's
 * own status: a week returned for ONE day still stands on its other days as it stood when the day was
 * returned — sent, or approved — and only the returned day reads `returned` (owner, 2026-10-02,
 * "Still planned"). Planned visit, Today and the Super Admin's missed record all read it from here, so
 * they ask one rule — the one phoenix_crm_save_visit stamps the visit with.
 *
 * `planRow` is the week's plan row already being read (`loadWeekPlanRow`) — Today reads it once and
 * hands the same row to each of its readers, rather than asking for one row three times over.
 */
export async function plannedCustomersOn(
  seatId: string,
  isTest: boolean,
  date: string,
  options: { planRow?: Promise<Row | null> } = {},
): Promise<{ status: PhoenixCrmPlanStatus | null; customerIds: string[] }> {
  const supabase = getSupabaseAdmin();
  const plan = await (options.planRow ?? loadWeekPlanRow(seatId, isTest, date));
  if (!plan) return { status: null, customerIds: [] };
  const planId = String((plan as Row).id);
  const [facts, items] = await Promise.all([
    loadPlanDayFacts([plan as Row], isTest),
    supabase.from("phoenix_crm_plan_items").select("customer_id").eq("plan_id", planId).eq("plan_date", date),
  ]);
  throwIfError(items.error);
  const day = facts.get(planId);
  return {
    status: day ? planDayStatus({ ...day, date }) : null,
    customerIds: ((items.data ?? []) as Row[]).map((row) => String(row.customer_id)),
  };
}

/**
 * The plan row of the field week holding `date`, with every column the day rule reads — or null when
 * no plan exists. One read Today shares between the day's stops, its planned activities and its week.
 */
export async function loadWeekPlanRow(seatId: string, isTest: boolean, date: string): Promise<Row | null> {
  const { data: plan, error } = await getSupabaseAdmin()
    .from("phoenix_crm_plans")
    .select(`id, ${PLAN_DAY_COLUMNS}`)
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .eq("week_start", fieldWeekStart(date))
    .maybeSingle();
  throwIfError(error);
  return (plan as Row | null) ?? null;
}

/**
 * The seat's earlier visits to each of its customers nobody has validated yet — the number `saveVisit`
 * counts before it refuses a rep's third, read for the whole list at once so Add visit can say it first.
 * 🔴 THE SAME VISITS THE SAVE COUNTS, no more and no fewer: the seat's own, in the same test world, never a
 * pharmacy row filed from a doctor's visit, never a visit copied from iReports360 history. A pharmacy is
 * never asked about (it needs no validation). Pinned against the save by
 * `tests/phoenix-crm-unvalidated-visit-cap.test.ts`.
 */
async function loadUnvalidatedVisitCounts(seatId: string, isTest: boolean, customers: Row[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const unvalidated = customers
    .filter((row) => (row.validated_at === null || row.validated_at === undefined) && !isPharmacyListType(row.list_type))
    .map((row) => String(row.id));
  // A hundred ids a read keeps the address well inside what the API accepts. The chunks are read a few at a
  // time (1 Nov 2026, the speed root cause — each request is ~450 ms at Supabase's edge, and a list of two
  // hundred customers paid them one after the other); a count is a sum, so the order they land in is nothing.
  const chunks = Array.from({ length: Math.ceil(unvalidated.length / 100) }, (_unused, index) => unvalidated.slice(index * 100, index * 100 + 100));
  const answers = await mapWithConcurrency(chunks, 4, (ids) =>
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_visits")
          .select("id, customer_id")
          .eq("seat_id", seatId)
          .eq("is_test", isTest)
          .in("customer_id", ids)
          .is("linked_from_visit_id", null)
          .is("imported_from_ireports360_at", null),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  );
  for (const rows of answers) {
    for (const row of rows) {
      const customerId = String(row.customer_id);
      counts.set(customerId, (counts.get(customerId) ?? 0) + 1);
    }
  }
  return counts;
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
  // first, exactly as when it ran alone. Since 1 Nov 2026 it is the planners' throttled mint: a seat
  // minted in the last five minutes skips it (the speed root cause — the RPC gated the form's whole wave).
  const ensured = ensureReferenceCustomersRecently(seat, isTest);
  const visitRowsRead = loadVisitRows(seat.seatId, isTest, today);
  const productFamiliesRead = lineProductsByFamily(seat.lineName);
  // The products the last visits are narrowed to. `loadLastVisits` awaits this only once its own read
  // is in, so it is handled here, the moment it exists: a failure landing first must never be an
  // UNHANDLED rejection. The families' own failure still fails the wave below, as it always did.
  const lineProductsRead = productFamiliesRead.then((families) => families.map((entry) => entry.family));
  lineProductsRead.catch(() => undefined);
  // The product managers' names ride on the product managers' read, and a manager's own-visit switch
  // starts here too (2026-10-24, "performance acceleration"): both used to be awaited one after the
  // other once the whole wave was in, two more round trips before the form could paint. The switch is
  // read ONCE now, where the vacant-territory flag used to read it a second time.
  const lineProductManagersRead = loadLineProductManagers(seat);
  // The list, and the customers waiting outside it: a second visit to someone met outside the list
  // is another out-of-list visit to the same customer, never a second customer.
  const customersRead = ensured.then(() => loadTerritoryCustomers(seat.seatId, isTest, { onListOnly: true, includeOutside: true }));
  // Only a rep's own save refuses a third visit before validation, so only his form counts them — on the
  // wave, the moment the list it counts for is in.
  const unvalidatedVisitsRead =
    enteredAs === "rep"
      ? customersRead.then(({ customers }) => loadUnvalidatedVisitCounts(seat.seatId, isTest, customers))
      : Promise.resolve(new Map<string, number>());
  const wave = Promise.all([
    customersRead,
    loadMonthVisitCounts(seat.seatId, isTest, monthStartOf(today), today),
    // Today's plan row WHATEVER its status: the sent set is filtered out of it below, and the status
    // itself is what Add visit needs to say why Planned has nobody to offer.
    plannedCustomersOn(seat.seatId, isTest, today),
    visitRowsRead,
    productFamiliesRead,
    loadSeatPharmacies(seat.seatId, isTest),
    // Narrowed to what the line still sells, which is why its pick waits for the families.
    loadLastVisits(seat.seatId, isTest, today, lineProductsRead),
    visitRowsRead.then((rows) =>
      loadPeopleNames([...territoryPeople(viewer.org, [seat]), ...chain.map((member) => member.hrId), ...visitPeople(rows)]),
    ),
    // The other days of this week each customer stands on the SENT plan, for the reason Out of plan
    // fills in by itself (owner, 2026-10-02). One more read of the same wave, never awaited after it.
    loadPlannedOtherDays(seat.seatId, isTest, today),
    // The line's product managers, for "A product manager" on "Who was on the visit" (owner,
    // 2026-10-02). The same cached list the rep's ask offers, so the two can never disagree about who
    // his product managers are; on the wave because it never blocks anything else.
    lineProductManagersRead,
    // The out-of-plan doctors of this field week, for the allowance on the unplanned steps.
    loadOffPlanRows([seat.seatId], isTest, offPlanWeekWindow(today)),
    // Whether the Super Admin requires this rep to record the visit (owner, 2026-10-16).
    enteredAs === "rep" ? isRecordingRequired(viewer.hrId) : Promise.resolve(false),
    // The days the LAST question may offer (owner, 2026-10-16): only a rep's own entry asks it, so a
    // manager's form never pays for the holiday read.
    enteredAs === "rep" ? loadPlanHolidays(viewer.cairoToday, visitAskLastDay(viewer.cairoToday)) : Promise.resolve(new Map<string, string>()),
    // The customers a named exception covers (owner, 2026-10-17): the day and the week never block them.
    // The seat's rep is whose dated window it reads (owner, 2026-10-26: a new hire's first month).
    loadOffPlanExemptions(seat.seatId, enteredAs === "rep" ? viewer.hrId : (seat.occupantHrId ?? null), today),
    // Their names are read apart from the day's: a product manager holds no seat, so he is neither in
    // the day's visits nor in the chain.
    lineProductManagersRead.then((managers) => loadPeopleNames(managers.map((manager) => manager.hrId))),
    enteredAs === "manager" ? managerOwnVisitClosedNow(viewer) : Promise.resolve(false),
    unvalidatedVisitsRead,
  ]);
  // Handled at once: if the mint fails, `await ensured` below throws its error and the wave is dropped.
  wave.catch(() => undefined);
  await ensured;
  const [
    { customers, placesByCustomer },
    visitCounts,
    planDay,
    visitRows,
    productFamilies,
    pharmacies,
    lastVisits,
    names,
    plannedOtherDays,
    lineProductManagers,
    offPlanRows,
    recordingRequired,
    doubleVisitHolidays,
    offPlanExemptions,
    productManagerNames,
    managerOwnVisitClosed,
    unvalidatedVisits,
  ] = await wave;
  // The SENT set, and only it, is what the picker offers and what the ordering follows — a draft is the
  // rep's own to edit today, so counting one would let him place the doctor at the door and never be off
  // plan (plan-rules.ts `isPlanSentForReview`). The count he has SAVED rides beside it, for the sentence.
  // `planDay.status` is TODAY's status, so a week returned for one other day still offers today's plan.
  const planned = new Set(isPlanSentForReview(planDay.status) ? planDay.customerIds : []);
  const products = productFamilies.map((entry) => entry.family);
  const visitedToday = new Set(visitRows.map((row) => String(row.customer_id)));
  const ramadan = isRamadanDay(today, viewer.config.ramadanOverrides);
  const settings = viewer.config.settings;

  const options: VisitCustomerOption[] = customers.map((row) => {
    const customerId = String(row.id);
    const grade = parseGrade(row.grade);
    const customerPlaces = placesByCustomer.get(customerId) ?? [];
    // A customer seated in a polyclinic or centre is AM or PM by his seating (owner, 2026-10-10), and
    // the visit is filed in that session; every other customer keeps his own list.
    const listType: PhoenixCrmListType = customerPlaces.find((place) => place.session)?.session ?? parseListType(row.list_type);
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
      plannedOtherDays: plannedOtherDays.get(customerId) ?? [],
      visitedToday: visitedToday.has(customerId),
      visitsThisMonth: visitCounts.get(customerId) ?? 0,
      target: doctorListType(row.list_type) === null ? null : gradeTarget(settings, listType as "AM" | "PM", grade),
      // A pharmacy needs no validation (owner, 2026-10-03): never "not validated yet" to him.
      pending: row.status === "pending" && !isPharmacyListType(row.list_type),
      // The save's own question, with the save's own answers: his raw list (a pharmacy is never counted)
      // and `validated_at`, never the seating's AM/PM or the status above.
      validateFirst:
        enteredAs === "rep" &&
        unvalidatedVisitRefused({
          listType: row.list_type,
          validated: row.validated_at !== null && row.validated_at !== undefined,
          earlierVisits: unvalidatedVisits.get(customerId) ?? 0,
        }),
      outside: row.status === "outside",
      referenceContactCrmId: numberOrNull(row.reference_contact_crm_id),
      // Pharmacies only, both of them: a doctor's phone is shown on his own page and the picker has
      // never carried it, and a doctor's location is a validated place, never a pin.
      pharmacyPin: isPharmacyListType(row.list_type) ? pickerPharmacyPin(row) : null,
      pharmacyPhone: isPharmacyListType(row.list_type) ? textOrNull(row.phone) : null,
    };
  });
  // Today's planned customers first, then the rest by name. The picker groups by brick on top of this,
  // so within a brick the planned doctors still lead.
  options.sort((left, right) => Number(right.plannedToday) - Number(left.plannedToday) || left.name.localeCompare(right.name));

  let blockedReason: string | null = null;
  if (!seat.lineCode) blockedReason = "This territory has no line in the organogram, so visits cannot be saved.";
  else if (products.length === 0) blockedReason = `No products are on file for ${seat.lineName ?? "this line"} yet, so a visit cannot record the products discussed.`;
  const sight = locationSight(viewer, seat);
  const productManagerRoles = new Map(lineProductManagers.map((manager) => [personKey(manager.hrId) ?? manager.hrId, manager.role]));

  // 🔴 THROUGH THE BLIND SHAPER, LAST (Golden Rule #1): a field his browser receives counts as shown.
  return blindVisitForm(viewer, seat, {
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
    ownVisitClosed: enteredAs === "manager" && managerOwnVisitClosed,
    ownVisitVacant: enteredAs === "manager" && isVacantTerritory(seat) && managerOwnVisitClosed,
    productManagers: lineProductManagers.map((manager) => ({
      hrId: manager.hrId,
      name: nameOf(productManagerNames, manager.hrId),
      // His APP ROLE is his title here: "Product Manager", "Group Product Manager", or the Marketing
      // Manager on CNS. The organogram holds no seat for him, so it has no title to give.
      title: manager.role,
    })),
    products,
    productFamilies,
    pharmacies,
    rules: { visitFarMeters: settings.visitFarMeters, weakGpsMeters: settings.weakGpsMeters },
    customers: options,
    todayVisits: visitRows.map((row) => mapVisitRow(row, names, { sight, org: viewer.org, productManagerRoles })),
    planToday: { status: planDay.status, saved: planDay.customerIds.length },
    blockedReason,
    offPlan: offPlanAllowance({ rows: offPlanRows, day: today, caps: settings, exemptions: offPlanExemptions }),
    recordingRequired,
    doubleVisitDays: enteredAs === "rep" ? doubleVisitDayChoices(viewer.cairoToday, doubleVisitHolidays) : [],
  });
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
  /**
   * What became of the double visit his next step "Arrange a double visit" asked for (owner,
   * 2026-10-02): who is asked, or that it was already asked. Null when the step was something else, or
   * when there was nobody to ask — the ask is HIS request, so its words are his to read.
   */
  visitAskNote: string | null;
  /**
   * What became of the double visit his LAST question asked for (owner, 2026-10-16): who is asked, or
   * that it was already asked. Null when he answered No, or the customer is not an AM or PM account.
   */
  doubleVisitNote: string | null;
  /**
   * What became of a pharmacy (owner, 2026-10-03): a pharmacy visit's own "no plan, no approval", or
   * that the pharmacy he named on this visit is logged as a pharmacy visit too. Null otherwise.
   */
  pharmacyNote: string | null;
  /** A recorded visit's own line (owner, 2026-10-16): it counts once it is approved. Null otherwise. */
  recordingNote: string | null;
  /**
   * The district manager's own visit on a VACANT territory went into his own single visits, not this
   * territory's visits (owner, 2026-10-19) — so the Visits tab reloads My single visits rather than the
   * day it is showing. False for every other visit.
   */
  filedAsOwnSingleVisit: boolean;
};

/**
 * Is the visit just saved the FIRST this person has ever submitted (owner, 2026-10-03)?
 *
 * Asked of `entered_by_hr_id`, which the database stores upper-cased (`phoenix_crm_save_visit` does
 * `upper(trim(...))` on the actor), so the question is asked in the same shape — `personKey` here, the
 * stored key there. One row is enough: ANY other row of his own means this is not the first.
 *
 * 🔴 A FAILED READ ANSWERS "NO", NEVER "YES". An email announcing a rep's first visit cannot be taken
 * back, and a rep who started weeks ago must not be announced because one read errored. The cost of the
 * wrong answer is asymmetric, so the fallback is the quiet one.
 *
 * The test world is asked separately (`is_test`), so a Super Admin trying the form out can never consume
 * a real rep's one-and-only first visit — nor be announced as one.
 */
async function isFirstVisitSubmittedBy(actorHrId: string, visitId: string, isTest: boolean): Promise<boolean> {
  const actor = personKey(actorHrId);
  if (!actor) return false;
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_visits")
    .select("id")
    .eq("entered_by_hr_id", actor)
    .eq("is_test", isTest)
    .neq("id", visitId)
    // A visit copied from iReports360 history (20261029212200) was never submitted here.
    .is("imported_from_ireports360_at", null)
    // The pharmacy visit his doctor's visit filed beside it (owner, 2026-10-03) is part of THIS
    // submission, written in the same transaction — counting it would make no visit ever a first.
    .is("linked_from_visit_id", null)
    .limit(1);
  if (error) return false;
  return (data ?? []).length === 0;
}

/**
 * 🔴 THE DISTRICT MANAGER'S OWN VISIT ON A VACANT TERRITORY, FILED WHERE IT BELONGS (owner,
 * 2026-10-19: "It is a vacant area. So he must submit it there single").
 *
 * It is handed to `logManagerVisit` exactly as "My single visits" would have sent it — his own table,
 * his own report only, the same one-day-a-week cap, the same vacant place rule — so there is still ONE
 * writer of these visits and no second copy of their rules here. The slot is looked up first, because
 * Add visit knows nothing about his week and an unplanned filing would cost him a half-day he planned.
 *
 * 🔴 THE PLACE RULE IS ALREADY ANSWERED: Add visit will not save without a reading (`NO_FIX_FOR_A_VISIT`),
 * so the pin always travels and `locateInReach` fills the address, area and brick from it.
 *
 * What `phoenix_crm_manager_visits` has no column for is not carried — the pharmacy's stock answers,
 * the kept audio of a spoken note, the objection, the next step and what he left. Dictated words land
 * in the comment, which IS carried; the rest start folded, and the form says in one line what this
 * record keeps (`MANAGER_OWN_VISIT_ON_VACANT_LINE`) before he fills any of it in.
 */
async function fileAsOwnSingleVisit(viewer: PhoenixCrmViewer, visitId: string, visit: VisitDraft, isTest: boolean): Promise<SavedVisit> {
  const slotId = await plannedSingleVisitSlotFor(viewer, visit.customerId, isTest);
  await logManagerVisit(viewer, {
    clientRef: visitId,
    customerId: visit.customerId,
    products: visit.products,
    comment: visit.comment,
    slotId,
    pin: { lat: visit.lat, lon: visit.lon, accuracyMeters: visit.accuracyMeters },
    test: isTest,
  });
  return {
    visitId,
    visitDate: viewer.visitDay,
    capturedAt: new Date().toISOString(),
    customerId: visit.customerId,
    duplicate: false,
    // Golden Rule #1, and his own visits are measured against no saved place at all: there is nothing
    // about a location to tell him.
    ...BLIND_LOCATION,
    // His plan's own word, not a rep's: planned when today's plan already held this customer.
    isUnplanned: slotId === null,
    unplannedKind: null,
    unplannedNote: null,
    visitAskNote: null,
    doubleVisitNote: null,
    pharmacyNote: null,
    recordingNote: null,
    filedAsOwnSingleVisit: true,
  };
}

/**
 * Save one visit.
 *
 * `client` is which client sent it (`capture-client.ts`), and it decides exactly one thing: whether
 * the body's offline capture claim is read at all. Only the app queues visits, so only the app may
 * date one before the save arrived; a browser's save is always dated from the server's own clock or
 * from the photo slot it just took.
 */
export async function saveVisit(viewer: PhoenixCrmViewer, raw: unknown, client: CaptureClient): Promise<SavedVisit> {
  const body = record(raw);
  if (!isUuid(body.id)) throw validationError("Start the visit again from Add Visit.");
  const visitId = String(body.id).toLowerCase();
  const { seat, isTest, enteredAs } = territoryForVisit(viewer, body.seatId, readTestFlag(body.test));
  if (!seat.lineCode) throw validationError("This territory has no line in the organogram, so visits cannot be saved.");
  const draft = parseVisitDraft(body);
  if (!draft.ok) {
    // The reading survives the refusal (owner, 2026-10-03). Silent, void, and never throwing: the
    // rep reads exactly the refusal below, whether or not this lands. A refusal about anything else
    // — no comment, no products — records nothing.
    await recordRefusedReading({
      subjectKind: "visit",
      raw: body,
      seatId: seat.seatId,
      repHrId: viewer.hrId,
      customerId: isUuid(body.customerId) ? String(body.customerId).toLowerCase() : null,
      isTest,
    });
    throw validationError(draft.error);
  }
  const visit = draft.value;
  // The line's products are started here and awaited where they always were (2026-10-24, "performance
  // acceleration"), so they load while the participants and the double-visit ask are checked, and a
  // refusal from either still reaches the rep first. Handled at once, so an early refusal never leaves
  // it an unhandled rejection; its own failure still fails the save at the await below.
  const productFamiliesRead = lineProductsByFamily(seat.lineName);
  productFamiliesRead.catch(() => undefined);
  // The old "My own visit" is closed for a district manager who plans in Phoenix CRM (owner, 2026-10-16):
  // his single visits go on his own plan and count in his own report, never under a rep's seat. One still
  // on the legacy form keeps it. Double and chain are unchanged.
  if (enteredAs === "manager" && visit.kind === "single" && (await managerOwnVisitClosedNow(viewer))) {
    // 🔴 EXCEPT WHERE NOBODY HOLDS THE SEAT (owner, 2026-10-19). Double and Chain need a rep, so on a
    // vacant territory the closed option left the form a dead end — filled to the last step and refused
    // here. His own visit is filed under My single visits instead, never under the vacant seat.
    if (isVacantTerritory(seat)) return await fileAsOwnSingleVisit(viewer, visitId, visit, isTest);
    throw validationError(MANAGER_OWN_VISIT_CLOSED);
  }

  const participants = resolveVisitParticipants({
    index: viewer.org,
    territorySeatId: seat.seatId,
    actorHrId: viewer.hrId,
    enteredAs,
    kind: visit.kind,
    managerHrId: visit.managerHrId,
    seniorHrId: visit.seniorHrId,
    productManagerHrId: visit.productManagerHrId,
    // Read here rather than trusted from the form: a product manager holds no seat, so the organogram
    // cannot check him, and this list is the only thing that can say he is one of HIS line's. Needed
    // whenever anyone from the product side is named — in the fixed place or among the companions.
    productManagers:
      visit.productManagerHrId || visit.companions.some((entry) => entry.side === "product") ? await loadLineProductManagers(seat) : [],
    companions: visit.companions,
  });
  if (!participants.ok) throw validationError(participants.error);

  // The LAST question of the form (owner, 2026-10-16): "Do you need a double visit with this customer?".
  // Read and checked BEFORE the save, so a person or a day that was never offered is refused while the
  // visit is still on the rep's screen. Null on No, and for every visit a manager or the Super Admin
  // entered. The request itself is raised after the save (below).
  const doubleVisitRequest = await prepareDoubleVisitRequest(viewer, {
    seat,
    enteredAs,
    repHrId: participants.value.repHrId ?? viewer.hrId,
    raw: body.doubleVisit,
  });

  const productFamilies = await productFamiliesRead;
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
   *
   * 🔴 AND ONLY THE APP MAY MAKE THE CLAIM. The bound above is one-sided by design — it stops a
   * phone claiming MORE elapsed time than passed, and must not stop it claiming less, because a
   * capture taken moments after anchoring is honest. The web app has no offline queue at all, so in
   * a browser that one-sidedness is the whole exploit: an anchor taken this afternoon plus
   * `elapsedMs: 0` tomorrow files the visit on today, counted and read as today's. A browser's claim
   * is therefore not read, not partially honoured and not refused — the save proceeds exactly as an
   * ordinary one and is dated at arrival (`capture-client.ts`).
   */
  const offlineClaim = client === "app" ? parseOfflineCaptureClaim(body) : null;
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
  const [placesResult, issuedAt, listedPharmacies, unvalidatedCustomer, earlierVisits] = await Promise.all([
    supabase
      .from("phoenix_crm_places")
      // Both readings travel: the photograph's and the pin, the two a rep's visit is measured against below,
      // with `point_source` saying which of them `lat`/`lon` settled on.
      .select("id, lat, lon, photo_lat, photo_lon, photo_accuracy_meters, pin_lat, pin_lon, pin_accuracy_meters, point_source")
      .eq("customer_id", visit.customerId)
      .eq("seat_id", seat.seatId)
      .eq("is_test", isTest)
      .eq("status", "active"),
    // Only a caller that still sends a photo has a slot to read; the one-tap visit has none.
    visit.photoPath ? photoSlotIssuedAt(visit.photoPath) : Promise.resolve(null),
    // The pharmacy he named is a visit to that pharmacy too (owner, 2026-10-03): his list's pharmacies,
    // to find which one. No name, no read.
    visit.pharmacyName ? loadListedPharmacies(seat.seatId, isTest) : Promise.resolve([] as ListedPharmacy[]),
    // The third-visit rule below is the rep's alone, so only his save reads the customer and his count.
    enteredAs === "rep"
      ? supabase.from("phoenix_crm_customers").select("validated_at, list_type").eq("id", visit.customerId).maybeSingle()
      : Promise.resolve(null),
    enteredAs === "rep"
      ? supabase
          .from("phoenix_crm_visits")
          .select("id", { count: "exact", head: true })
          .eq("seat_id", seat.seatId)
          .eq("customer_id", visit.customerId)
          .eq("is_test", isTest)
          .is("linked_from_visit_id", null)
          // A visit copied from iReports360 history (20261029212200) is the old system's, never one of
          // his two here — counting it would refuse a visit he has every right to make.
          .is("imported_from_ireports360_at", null)
          // The visit being saved never counts against itself, so a retried save is never refused.
          .neq("id", visitId)
      : Promise.resolve(null),
  ]);
  // Decided here, where it can be tested without a database; the function only checks each pharmacy is
  // his and files its visit. It is ignored when the customer he visited is himself a pharmacy. ONE BOX
  // CAN NAME TWO PHARMACIES ("صيدليه التهامي، صيدليه الرحمه", owner 2026-10-03): each name is matched
  // on its own and sent in `linked_pharmacies`.
  const pharmacyLinks = linkNamedPharmacies(visit.pharmacyName, listedPharmacies);
  throwIfError(placesResult.error);
  const placeRows = (placesResult.data ?? []) as Row[];
  const places = placeRows.map((row) => ({ id: String(row.id), lat: Number(row.lat), lon: Number(row.lon) }));
  const settings = viewer.config.settings;

  // 🔴 TWO VISITS TO A CUSTOMER NOBODY HAS VALIDATED YET ARE SAVED; THE THIRD IS REFUSED (owner,
  // 2026-10-28: "the third time if the customer/account is not validated do not accept or pass the
  // visit"). A pharmacy is never counted — it needs no validation (owner, 2026-10-03). Asked of the REP's
  // own save only, exactly as the far rule below — a visit a manager enters and the Super Admin's "Record
  // a missed visit" still save — and asked before the recording is claimed and before anything is
  // written, so a refused visit leaves nothing behind. A customer the read cannot find is left to the
  // save, which refuses it in its own words.
  if (enteredAs === "rep" && unvalidatedCustomer && earlierVisits) {
    throwIfError(unvalidatedCustomer.error);
    throwIfError(earlierVisits.error);
    const customer = unvalidatedCustomer.data as Row | null;
    if (
      customer &&
      unvalidatedVisitRefused({
        listType: customer.list_type,
        validated: customer.validated_at !== null && customer.validated_at !== undefined,
        earlierVisits: earlierVisits.count ?? 0,
      })
    ) {
      throw validationError(UNVALIDATED_CUSTOMER_VISIT_REFUSED);
    }
  }

  // 🔴 A MEDICAL REP'S VISIT IS LOGGED AT THE CUSTOMER'S VALIDATED PLACE, OR NOT AT ALL (owner,
  // 2026-10-20: "not accept medical reps visits logged away from the validated picture of the customer
  // with maximum 300 m apart"). Asked of the REP's own save only — a visit a manager enters, and the
  // Super Admin's "Record a missed visit", keep saving as before — and asked HERE, before the recording
  // is claimed and before the save writes anything, so a refused visit leaves no row, no claimed
  // recording and no notice behind. The refused reading itself is kept for the SFE's board, and the rep
  // reads one plain sentence about his own work: never the line, never his metres.
  //
  // 🔴 AND ONLY FROM 2026-10-20 ON (owner: "do not refuse historical — start from today this rule"). The
  // day is the day the visit was CAPTURED, as the save itself will date it — the offline anchor, else the
  // photo slot, else now — so a visit taken before the rule existed and arriving after it is never refused.
  const captureDay = cairoBusinessDay(new Date(offlineCapturedAt ?? issuedAt ?? Date.now()));
  if (enteredAs === "rep" && farVisitRefusalApplies(captureDay)) {
    const away = visitAwayFromValidatedPlace({
      fix: { lat: visit.lat, lon: visit.lon },
      places: placeRows.map((row) => ({
        id: String(row.id),
        lat: Number(row.lat),
        lon: Number(row.lon),
        photoLat: numberOrNull(row.photo_lat),
        photoLon: numberOrNull(row.photo_lon),
        photoAccuracyMeters: numberOrNull(row.photo_accuracy_meters),
        pinLat: numberOrNull(row.pin_lat),
        pinLon: numberOrNull(row.pin_lon),
        pinAccuracyMeters: numberOrNull(row.pin_accuracy_meters),
        pointSource: typeof row.point_source === "string" ? row.point_source : null,
      })),
      farMeters: settings.visitFarMeters,
    });
    if (away.refused) {
      await recordFarVisitRefusal({
        visit,
        seatId: seat.seatId,
        repHrId: viewer.hrId,
        customerId: visit.customerId,
        placeId: away.placeId,
        metres: away.metres,
        farMeters: away.farMeters,
        isTest,
      });
      throw validationError(VISIT_AWAY_FROM_PLACE);
    }
  }
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
  // 🔴 Was the manager who would decide this visit one of the people ON it (owner, 2026-10-12)? If he
  // was, his step is unavailable and the visit starts at SFE — `unplannedFirstStatus` holds the rule
  // and the reasoning. It is resolved HERE, beside the reviewer himself, because this is the only
  // place that has both the organogram's answer and the companions the rep just recorded; the phone
  // never chooses a stage, exactly as it never chooses one for a vacant chain.
  const reviewerOnTheVisit = reviewerWasOnTheVisit(reviewer?.hrId ?? null, [
    participants.value.managerHrId,
    participants.value.seniorHrId,
    participants.value.productManagerHrId,
    ...participants.value.companions.map((person) => person.hrId),
  ]);
  // 🔴 THE VISIT RECORDING (owner, 2026-10-16): a rep the Super Admin switched on records the
  // conversation before the visit can be logged. Claimed HERE, before the save writes anything, under
  // the visit's own id — so a chosen rep's visit can never exist without its recording, and a save sent
  // again claims the same recording for the same visit. Only the rep's own save is asked: a manager
  // entering a double visit and the Super Admin recording a missed one are never on that list's path.
  //
  // 🔴 AND A RECORDED VISIT WAITS FOR THE ADMINISTRATOR FIRST, WHATEVER ITS TYPE (owner, 2026-10-16).
  // The database does the waiting — the countable view leaves it out and an off-plan one starts at
  // `admin_pending` — so here it only holds back the manager's notice and tells the rep it waits.
  const recorded = enteredAs === "rep" ? await claimRequiredRecording({ viewer, seat, isTest, visitId, raw: body }) : false;
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
      product_manager_hr_id: participants.value.productManagerHrId,
      // Everyone who came (2026-10-27), checked above; the database writes phoenix_crm_visit_companions.
      companions: participants.value.companions.map((entry) => ({ hr_id: entry.hrId, side: entry.side })),
      products: visit.products,
      pharmacy_name: visit.pharmacyName,
      linked_pharmacies: pharmacyLinks.map(({ name, link }) => ({
        name,
        id: link.kind === "existing" ? link.customerId : null,
        new: link.kind === "new",
      })),
      product_availability: productAvailability,
      comment: visit.comment,
      photo_path: visit.photoPath,
      reuse_place_photo: reusePlacePhoto,
      // The spoken note, when the rep recorded one. It is passed beside the photo and it is not one:
      // no term of the visit's date reads it, and phoenix_crm_take_voice returns void so that none can.
      voice_note_path: visit.voiceNotePath,
      voice_note_seconds: visit.voiceNoteSeconds,
      voice_note_bytes: visit.voiceNoteBytes,
      // Off the plan, if that is what it turns out to be. The reason is sent whatever the rep chose, and
      // it is OPTIONAL (owner, 2026-10-29): the database's OWN test decides the kind, so a rep who chose
      // "planned" for a doctor who was not planned is filed off the plan and raised for its approval —
      // never quietly filed as planned — with or without a reason. Where the approval starts is resolved from the
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
      unplanned_first_status: unplannedFirstStatus(reviewer !== null, reviewerOnTheVisit),
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
  // A dashboard may show the company's CRM window from a copy up to a minute old (owner, 2026-10-16);
  // a visit saved here is shown at once, so the copy is dropped. Never throws, never costs the visit.
  if (result.duplicate !== true) refreshSharedCrmWindows("phoenix-crm visit saved");

  // Was this position real? Judged AFTER the save, deliberately: the answer never reaches the rep,
  // never changes what comes back to him, and can never cost him a visit he actually made. A repeat
  // save (`duplicate`) is skipped — the first one was already judged.
  //
  // 🔴 AND AFTER THE REPLY (2026-10-24, "performance acceleration"): both writers below swallow their own
  // failures and answer nothing, so the rep no longer waits for them — the save measured p95 8 s on
  // production that afternoon. `afterResponse` runs them once the reply has gone, still in this order,
  // and simply awaits them where there is no request (the unit suite, a script).
  const capturedAt = new Date(String(result.captured_at));
  if (result.duplicate !== true && !Number.isNaN(capturedAt.getTime())) {
    await afterResponse("phoenix-crm save visit: capture evidence", async () => {
      await judgeCapture({
        subjectKind: "visit",
        subjectId: visitId,
        seatId: seat.seatId,
        repHrId: participants.value.repHrId ?? viewer.hrId,
        customerId: visit.customerId,
        isTest,
        fix: { lat: visit.lat, lon: visit.lon, accuracyMeters: visit.accuracyMeters, capturedAt },
        deviceMocked: visit.deviceMocked,
        readerReplaced: visit.readerReplaced ?? null,
        readerFindings: visit.readerFindings ?? [],
      });
      // And WHEN the phone took that position, and which install sent it. Written here for the same
      // three reasons as the judgement above — after the save, answering nothing, swallowing its own
      // failures — and written here rather than onto the visit itself because the save is a database
      // function nothing in this module may put at risk for evidence the save does not read
      // (server/capture-provenance.ts says why in full). A repeat save is skipped with the judgement.
      await recordCaptureProvenance({
        visitId,
        seatId: seat.seatId,
        repHrId: participants.value.repHrId ?? viewer.hrId,
        visitDate: String(result.visit_date),
        capturedAt,
        fixTakenAt: visit.fixTakenAt,
        deviceCapturedAt: visit.deviceCapturedAt,
        deviceInstallId: visit.deviceInstallId,
        isTest,
      });
    });
  }

  const isUnplanned = result.is_unplanned === true;
  const unplannedKind: UnplannedKind | null = isUnplanned ? (isUnplannedKind(result.unplanned_kind) ? result.unplanned_kind : "out_of_plan") : null;
  // An out-of-plan visit is the ONE visit that tells anybody (notifications.ts): it counts in nothing
  // until it is decided, so the manager who must decide it is told. An out-of-list visit raises no
  // approval of its own — its CUSTOMER's add request is what the district manager decides. A repeat
  // save is skipped — the first one already raised it, and the notice's idempotency key would drop
  // the second anyway.
  // A RECORDED off-plan visit tells nobody yet: it reaches its manager only once the Administrator has
  // approved it, and that approval sends this same notice (`reviewRecordedVisit`).
  if (unplannedKind === "out_of_plan" && result.duplicate !== true && !recorded) {
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
  // The rep's FIRST visit on Phoenix CRM (owner, 2026-10-03): his district manager, his national sales
  // manager and the SFE Manager are emailed, with the owner on the BCC every system email carries. It is
  // an adoption notice and nothing waits on anybody — so it is read and sent AFTER the visit is saved,
  // and `notifyPhoenixCrm` swallows its own failures: a rep must never lose a visit to an email.
  //
  // 🔴 ONLY A VISIT THE REP HIMSELF SUBMITTED. "Submitted" is the owner's word and it names the person
  // doing it, so a double visit a manager entered and a visit the Super Admin entered for a rep who
  // missed logging one are both NOT his first submission — the read asks for the actor's own rows.
  if (enteredAs === "rep" && result.duplicate !== true && (await isFirstVisitSubmittedBy(viewer.hrId, visitId, isTest))) {
    await notifyPhoenixCrm(
      {
        kind: "first_visit",
        org: viewer.org,
        seat,
        visitId,
        repHrId: participants.value.repHrId ?? viewer.hrId,
        customerName: textOrNull(result.customer_name) ?? "a customer",
        // The SERVER's stamp, as the save returned it — never the phone's clock.
        capturedAt: String(result.captured_at),
      },
      isTest,
    );
  }
  // "Arrange a double visit" (owner, 2026-10-02): the rep's own next step asks his manager for it, by
  // itself and once per visit — the database keys the ask on the visit id, so a save sent twice asks
  // once. Only the rep's own visit: a manager entering a visit is on it already. It never throws and
  // never costs the visit, which is saved by now (server/visit-asks.ts).
  const visitAsk =
    enteredAs === "rep" && raisesVisitAsk(visit.outcome.nextStep)
      ? await raiseVisitAskFromVisit(viewer, {
          seat,
          isTest,
          visitId,
          customerId: visit.customerId,
          repHrId: participants.value.repHrId ?? viewer.hrId,
          wishedOn: visit.outcome.nextStepOn,
        })
      : null;
  // The double visit the LAST question asked for (owner, 2026-10-16): raised once per visit, after the
  // save, and never costing the visit. Only an AM or PM customer can be asked about, so the list the
  // save returned decides, not the phone. A duplicate save asks again on purpose: the database keys the
  // request on the visit id, so a save retried after a dropped connection finishes what the first began.
  const doubleVisit =
    doubleVisitRequest
      ? await raiseDoubleVisitRequestFromVisit(viewer, {
          seat,
          isTest,
          visitId,
          customerId: visit.customerId,
          repHrId: participants.value.repHrId ?? viewer.hrId,
          listType: textOrNull(result.list_type),
          prepared: doubleVisitRequest,
        })
      : null;
  // The rep is told his visit is saved and nothing about where he was (Golden Rule #1); a manager who
  // entered it reads the distance only (owner, 2026-10-02).
  // `parseVisitDraft` refuses a save with no reading, so this visit always holds one.
  const location = visitLocationFor(locationSight(viewer, seat), flag, distance, visit.accuracyMeters, false, true);
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
          ? // No manager has decided anything the instant the visit saves, so the note must not claim
            // one did — which is what `sfe_pending` would otherwise say to a rep whose manager step
            // was never available.
            unplannedVisitRepNote(recorded ? "admin_pending" : unplannedFirstStatus(reviewer !== null, reviewerOnTheVisit), false)
          : null,
    // Every recorded visit, of every type, waits for approval before it counts. Said once, plainly,
    // with no person and no check named (Golden Rule #1).
    recordingNote: recorded ? RECORDED_VISIT_REP_NOTE : null,
    visitAskNote: visitAskSavedNote(visitAsk),
    doubleVisitNote: doubleVisitSavedNote(doubleVisit),
    pharmacyNote: savedPharmacyNote(result),
    filedAsOwnSingleVisit: false,
  };
}

/**
 * The line he reads about a pharmacy once the visit is saved: a pharmacy's own visit needs no plan and
 * no approval, and each pharmacy he named on a doctor's visit is logged as a visit to it too. Nothing
 * for one already visited today — its one visit of the day is already there.
 */
function savedPharmacyNote(result: Row): string | null {
  if (isPharmacyListType(result.list_type)) return PHARMACY_CALL_REP_NOTE;
  // Every pharmacy the box named that got a visit.
  const answered: unknown[] = Array.isArray(result.linked_pharmacies) ? result.linked_pharmacies : [];
  const filed = answered
    .filter((linked): linked is Row => Boolean(linked) && typeof linked === "object" && textOrNull((linked as Row).visit_id) !== null)
    .map((linked) => ({ name: textOrNull(linked.name) ?? "The pharmacy", created: linked.created === true }));
  return linkedPharmaciesNote(filed);
}
