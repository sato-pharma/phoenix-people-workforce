/**
 * Phoenix CRM — a territory's customer list: the iReports360 reference, the validated customers with
 * their places and timings, and the grade and drop requests.
 *
 * Owner, 2026-09-16:
 *   - the rep's iReports360 list is a REFERENCE only; a customer is real once validated with a live
 *     photo, the location captured on the spot and at least one timing;
 *   - a new customer's grade, a grade change and a drop go to the district manager (the territory's
 *     reviewer) — never approved by the system;
 *   - the list stays with the territory when the rep changes.
 *
 * Owner, 2026-09-29 — the rep's flow rebuilt (src/lib/phoenix-crm/list-request-rules.ts holds the
 * customer's whole life on the list):
 *   - a place is validated ONCE, with two readings — the Capture-location pin and the photo's own
 *     shutter reading. The photo's reading is the fixed point; the pin is the fallback. Only the Super
 *     Admin and the SFE Manager move a place, with a written reason (place-move.ts);
 *   - a customer met outside the list is validated at the door and WAITS outside it; adding him, dropping
 *     a listed one and bringing one back from the Archive go to the district manager, then SFE. The
 *     manager confirms the A/B/C grade of an add and sets its potential (AA..BC, shown only);
 *   - a customer's earlier visits are measured against his place once he has one (visit-locations.ts).
 *
 * Every write goes through one database function that re-checks the rule under a per-territory lock
 * (supabase/migrations/20260916150000_phoenix_crm.sql); this file checks who may ask, shapes the entry
 * and tells the people who must act.
 */

import { loadBrickNames } from "@/lib/crm/brick-geo";
// The iReports360 mirror, reached from inside this walled module exactly as brick-from-coordinates
// is: the sharing question can only be answered against the WHOLE company's contact roster, which
// Phoenix CRM's own tables do not hold.
import type { SharedWith } from "@/lib/crm/location-confidence";
import { loadObservedPointsFor, loadPlanDatesFor, loadSharedCustomersFor, loadVisitHistoryFor, type VisitHistory } from "@/lib/crm/shared-customers";
import { logError } from "@/lib/observability/log";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { monthStartOf, nextRamadan } from "@/lib/phoenix-crm/calendar";
import { coverageTier, gradeTarget, summarizeReadiness, type CoverageTier, type ReadinessSummary, type ReferenceState } from "@/lib/phoenix-crm/coverage";
import {
  cleanText,
  CUSTOMER_NAME_MAX,
  DEVICE_CLOCK_TOLERANCE_MINUTES,
  deviceClockSkewMinutes,
  dropReasonLabel,
  parseCustomerPhone,
  parseDropDraft,
  parseGrade,
  parseNewCustomer,
  parseOutsideCustomer,
  parsePharmacyPin,
  parsePlaceDraft,
  parsePotentialGrade,
  parseProductAvailability,
  PHARMACY_NAME_MAX,
  PLACE_TEXT_MAX,
  placePoint,
  PRODUCT_AVAILABILITY_MAX,
  type PharmacyPinDraft,
  type PlaceDraft,
  type PotentialGrade,
  type ProductAvailability,
} from "@/lib/phoenix-crm/entry-rules";
import {
  archiveReasonLabel,
  canReturnForComment,
  firstRequestStage,
  isRequestStage,
  isWithRep,
  listSectionOf,
  RETURN_NOTE_MAX,
  RETURN_NOTE_REQUIRED,
  RETURN_REPLY_REQUIRED,
  requestKindLabel,
  requestStageLabel,
  setsAdmissionGrades,
  stageAfterReply,
  WITH_REP_LABEL,
  type ListSection,
} from "@/lib/phoenix-crm/list-request-rules";
import { planWeekdays, type PlanWeekday } from "@/lib/phoenix-crm/plan-pattern";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { PHOENIX_CRM_ADMINISTRATOR_HR_ID } from "@/lib/phoenix-crm/plan-edit-rules";
import { personKey, territoryName, territoryReviewer, type OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  assertListCurator,
  assertListRequestApprover,
  canCurateList,
  canDecideListRequest,
  canMovePlaces,
  canOverrideDecision,
  canReviewTerritory,
  canWriteAsRep,
  readTestFlag,
  readsLocationDetail,
  territoryForRead,
  canValidateReference,
  territoryForRepWrite,
  territoryForValidation,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { blindTerritoryList } from "@/lib/phoenix-crm/server/blind-payloads";
import { callPhoenixCrm, chunk, numberOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { googleMismatchMessage, mismatchIsHeld, type LocationCheckState } from "@/lib/phoenix-crm/google-place-rules";
import { checkPlaceOnGoogle, googleCheckRecord, type GooglePlaceCheck } from "@/lib/phoenix-crm/server/google-place-check";
import { filePlaceCaptureTrust, judgeCapture } from "@/lib/phoenix-crm/server/location-integrity";
import { readPlaceSignboard, recordPlaceSignboard } from "@/lib/phoenix-crm/server/signboard-check";
import {
  signboardApplies,
  signboardHoldRecord,
  signboardHoldsForReview,
  signboardNameIsUsable,
  signboardUnjudged,
  type PhoenixCrmSignboardCheck,
} from "@/lib/phoenix-crm/signboard-rules";
import {
  loadLocationChecks,
  notifyValidationReviewWaiting,
  pendingLocationReview,
  withdrawValidationNotConfirmed,
} from "@/lib/phoenix-crm/server/validation-reviews";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadRepVisiblePlaceNotes, type RepPlaceNote } from "@/lib/phoenix-crm/server/place-notes";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { resolvePinGeography, resolvePlaceLocation, territoryOfSeat } from "@/lib/phoenix-crm/server/place-location";
import { photoSlotIssuedAt } from "@/lib/phoenix-crm/server/photos";
import { readPlaceSchedule, recordPlaceSchedule } from "@/lib/phoenix-crm/server/schedule-check";
import { scheduleHoldRecord, scheduleHoldsForReview, type PhoenixCrmScheduleCheck } from "@/lib/phoenix-crm/schedule-rules";
import {
  canDecideSharedPlaces,
  effectiveSeatedPhoto,
  seatedDraftOf,
  seatedPlacePayload,
  sharedPlaceForSeating,
} from "@/lib/phoenix-crm/server/shared-places";
import { countOffListingRefusals, recordOffListingRefusal, recordRefusedReading } from "@/lib/phoenix-crm/server/refused-readings";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import { restampVisitLocationsQuietly } from "@/lib/phoenix-crm/server/visit-locations";
import type { PlannerReference } from "@/lib/phoenix-crm/suggestions";
import {
  addedPharmacyNameProblem,
  collapsePharmacyName,
  doctorListType,
  isPharmacyListType,
  matchAddedPharmacy,
  parseListType,
  PHARMACY_LIST_TYPE,
  type ListedPharmacy,
} from "@/lib/phoenix-crm/pharmacy-call-rules";
import { parseTimings, sortTimings } from "@/lib/phoenix-crm/timings";
import { isCertainWholesalerVenue } from "@/lib/venues/wholesaler-venue-guard";
import type {
  PhoenixCrmCustomerStatus,
  PhoenixCrmGrade,
  PhoenixCrmListType,
  PhoenixCrmRequestKind,
  PhoenixCrmRequestStage,
  PhoenixCrmRequestStatus,
  PhoenixCrmTiming,
} from "@/lib/phoenix-crm/types";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

/** Decided requests stay on the rep's screen this long, so the answer is seen. */
const DECIDED_REQUESTS_DAYS = 45;

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function customerStatusOf(value: unknown): PhoenixCrmCustomerStatus {
  return value === "pending" || value === "outside" || value === "dropped" ? value : "active";
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A place as it was captured. Everything below the label is the location, resolved on the server from
 * the coordinates the camera reported and never editable afterwards (owner, 2026-09-23): the clean
 * address, the part of town, the Phoenix brick with the distance that justifies it, that brick's area
 * and region, and the raw fix itself.
 */
export type ListPlace = {
  placeId: string;
  label: string | null;
  address: string | null;
  brickId: string | null;
  brickName: string | null;
  /**
   * How far the point was from that brick's centre — the only place a wrong brick is visible.
   *
   * 🔴 THIS AND EVERY OTHER OPTIONAL FIELD BELOW IS A MEASUREMENT, AND ONLY THE SUPER ADMIN AND THE SFE
   * MANAGER RECEIVE ONE (owner, 2026-10-02): `placeWithoutMeasurements` (server/blind-payloads.ts)
   * rebuilds the place from an allow-list for every other reader — the rep, and his managers too —
   * before the List leaves the server. Optional because they are ABSENT, never zero or false.
   */
  brickDistanceKm?: number | null;
  /**
   * 🔴 WHETHER ANYBODY ACTUALLY LOOKED FOR THIS PLACE'S BRICK — a distinction the row could only ever
   * make by accident until 2026-10-08. A null brick has meant both "we looked and nothing is within
   * BRICK_TRUST_KM" and "the brick master could not be read, so nobody looked", separated only
   * incidentally by whether `brickDistanceKm` happened to be set. The outstation watermark makes the
   * same distinction in words, because an approver must be able to tell "the pin is nowhere near a
   * Phoenix brick" from "we could not look".
   *
   * Measured the day it landed: all 18 brick-less active places are `none_nearby` at 3.2–7.5 km and
   * ZERO are `could_not_look` — so those 18 record a brick-master coverage gap, not a lookup failure.
   *
   * A MEASUREMENT, so withheld from every reader but the Super Admin and the SFE Manager, beside the
   * `brickDistanceKm` it explains.
   */
  brickLookup?: "matched" | "none_nearby" | "could_not_look";
  areaCode: string | null;
  areaName: string | null;
  regionCode: string | null;
  regionName: string | null;
  zone: string | null;
  /** The FIXED point every later visit is measured against: the photo's reading, else the pin. */
  lat: number;
  lon: number;
  accuracyMeters?: number | null;
  timings: PhoenixCrmTiming[];
  photoPath: string;
  capturedAt: string;
  /** The phone's clock was more than 15 minutes off the server's when the photo was taken. */
  clockOff?: boolean;
  /**
   * Where the fixed point came from (owner, 2026-09-29): the photo's own shutter reading, the
   * Capture-location pin when the photo had none, or a move by the Super Admin or the SFE Manager.
   */
  pointSource?: "photo" | "pin" | "moved" | "shared_place";
  /**
   * The polyclinic, medical centre, medical tower or hospital outpatient suite this customer is SEATED
   * in — set only on a seated place, whose point is the venue's own (owner, 2026-10-09).
   *
   * 🔴 NOT A MEASUREMENT, so it is in `placeWithoutMeasurements`' allow-list and the rep keeps it: he
   * chose the venue himself at the door, and his own screen and his plan both have to say which
   * building a call is in — the cap is three visits a DAY inside one of them.
   */
  sharedPlaceId?: string | null;
  /**
   * AM or PM — the session a SEATED customer receives in at that building (owner, 2026-10-10). Null on a
   * clinic of his own, which follows the customer's list. Not a measurement, so the rep keeps it.
   */
  session?: "AM" | "PM" | null;
  /**
   * Whether the building this place is seated in has its timetable on file — not a measurement, so the
   * rep keeps it, for the same reason `sharedPlaceId` is kept: a customer the Super Admin moved in is
   * counted on his visits and held out of the KPIs until the board names him, and the rep has to be
   * told WHICH of the two he is waiting for. Undefined on a place that stands alone.
   */
  venueTimetableOnFile?: boolean;
  /**
   * Whether the building this place is seated in is still waiting for the Super Admin (owner, 2026-10-14).
   * Not a measurement and not a verdict on the rep: a customer seated there is saved, planned and visited
   * like any other, and joins the KPIs when the building is approved. The rep keeps it so his customer page
   * can say which of the two things the customer is waiting for. Undefined on a place that stands alone.
   */
  venueHeld?: boolean;
  /** The two raw readings, kept beside the fixed point for good. Null where one was not measured. */
  pinReading?: PlaceReading | null;
  photoReading?: PlaceReading | null;
  /** Set once the place was moved: when, and the written reason. */
  moved?: { at: string; reason: string | null } | null;
};

export type PlaceReading = { lat: number; lon: number; accuracyMeters: number | null };

/** What iReports360 said about a carried-over customer, so the rep can find him before he has a place. */
export type ListCustomerReference = {
  address: string | null;
  city: string | null;
  zone: string | null;
  lastVisitedOn: string | null;
  /**
   * The brick this customer already sits in, carried over from iReports360 — the "known brick" a
   * pending customer belongs to BEFORE he is captured. Owner, 2026-09-26: a pending customer is
   * grouped under this brick rather than an amber "locality not yet mapped" heading, because he does
   * have a territory — it just has not been confirmed on the spot yet. Null only when iReports360
   * has no brick for him (in production every carried-over customer has one). The RPC gives the brick
   * id only; `brickName` and `areaName` are resolved from the Source-of-Sales master through
   * `loadBrickNames` in `@/lib/crm/brick-geo` — that reach lives outside this walled module, exactly
   * as brick-from-coordinates does. The owner's rule is that a screen shows names, never the code, so
   * `brickName` is what the heading uses.
   */
  brickId: string | null;
  brickName: string | null;
  areaName: string | null;
};

/**
 * A pharmacy the rep took feedback from for this doctor, built from the visits that named it
 * (phoenix_crm_visits.pharmacy_name). The doctor↔pharmacy link is derived, not maintained: pharmacies
 * are free text, so they are grouped case-insensitively and the display name is the most recent
 * spelling. The rep pins one as primary (phoenix_crm_customers.primary_pharmacy_name).
 */
export type CustomerPharmacy = {
  /** The pharmacy as most recently spelled by the rep. */
  name: string;
  /** Matches the doctor's pinned primary (compared on the normalized name). */
  isPrimary: boolean;
  /** When feedback last named this pharmacy for this doctor (ISO). */
  lastFeedbackAt: string;
  /** How many of this doctor's visits took feedback here. */
  visits: number;
  /** The latest Has / Doesn't-have answer per product — the most recent visit wins. */
  products: { product: string; answer: ProductAvailability }[];
};

export type ListCustomer = {
  customerId: string;
  listType: PhoenixCrmListType;
  name: string;
  speciality: string | null;
  grade: PhoenixCrmGrade | null;
  origin: "reference" | "new";
  referenceContactCrmId: number | null;
  /**
   * "pending": carried over from iReports360 and not validated yet. It counts in no report.
   * "outside": met outside the list and validated at the door, waiting to be added (2026-09-29).
   * "dropped": in the Archive.
   */
  status: PhoenixCrmCustomerStatus;
  /** Which section of the List he sits in — the one place that decision is made (list-request-rules.ts). */
  section: ListSection;
  /**
   * The district manager's read of his potential, set when he approved adding him. Shown only: every
   * frequency, target and KPI reads the A/B/C grade.
   */
  potentialGrade: PotentialGrade | null;
  /** Set once validated AND on the list; an outside customer keeps it empty until he is admitted. */
  validatedAt: string | null;
  validatedByName: string | null;
  /** What iReports360 holds on him; null for a customer the rep added himself. */
  reference: ListCustomerReference | null;
  /**
   * What the SFE wrote for the rep when he loaded this list from a sheet: where to find the customer,
   * and anything else worth saying. Null for every customer who arrived any other way.
   *
   * 🔴 `where` IS A NOTE, NEVER A LOCATION THE SYSTEM READS. The place is captured at the door and its
   * address, brick, area and region resolved from that point; a typed address is the one thing that rule
   * forbids. This is how the rep knows which door to stand at, and nothing measures it.
   *
   * `timings` is the same kind of thing for the clinic's days and hours: a DRAFT the SFE typed in the
   * sheet, which the rep's validate screen offers him pre-ticked and which he confirms or corrects at the
   * door. The place still stores only what he confirmed — this never becomes the place's own hours.
   */
  intake: { where: string | null; note: string | null; timings: PhoenixCrmTiming[] | null } | null;
  droppedReason: string | null;
  droppedNote: string | null;
  statusChangedAt: string;
  places: ListPlace[];
  visitsThisMonth: number;
  target: number | null;
  tier: CoverageTier;
  /**
   * 🔴 ANOTHER REP CARRIES THIS CUSTOMER TOO (owner, 2026-09-30: "if a doctor is shared between this
   * rep and another rep, it was highlighted"). Null for the overwhelming majority.
   *
   * An INFERENCE, not a record: iReports360 gives every rep their own row for one doctor, so the
   * match is worked out from the name and the pin, or from a shared phone. The basis is printed
   * beside the highlight so a reader who disagrees can overrule it, and nothing is ever merged — a
   * two-line customer is a treasure, never a duplicate to tidy away.
   */
  sharedWith: SharedWith[] | null;
  /**
   * 🔴 WHERE THE REPS HAVE ACTUALLY STOOD in front of this doctor, averaged from iReports360's
   * check-ins on him (owner, 2026-09-30: "you will get the location of the doctor from the
   * check-ins ... and make an average"). Null when nobody has ever checked in.
   *
   * It beats the vendor's TYPED address, which on this data is a region — "Monofia III · Delta
   * West" — that cannot be driven to. It never beats a place the rep captured and confirmed at the
   * door: that is a deliberate act, this is an observation. `averageCheckinPoint` explains why the
   * average is taken over the fixes that agree with one another rather than over all of them.
   */
  observed: { lat: number; lon: number; address: string | null; at: string | null; agreed: number; total: number } | null;
  /**
   * 🔴 WHEN HE IS USUALLY PLANNED, from the iReports360 reference plans (owner, 2026-09-30). Null
   * when the mirror holds no plan for him. It is what the plans ALREADY SAY — not a target, not a
   * frequency, and never a count of whether the rep went.
   */
  planPattern: PlanWeekday[] | null;
  /**
   * 🔴 WHAT THE REP ALREADY DID WITH HIM, in iReports360 (owner, 2026-09-30). A carried-over row
   * has NO Phoenix visits by definition — its Phoenix history starts at validation — so reporting
   * the Phoenix count there could only ever say "never", under a line naming last week's visit.
   */
  referenceHistory: VisitHistory | null;
  pendingGradeRequestId: string | null;
  pendingGrade: PhoenixCrmGrade | null;
  pendingDropRequestId: string | null;
  /** Every request waiting on him, whatever its kind, with the step it is on. */
  waiting: Array<{ requestId: string; kind: PhoenixCrmRequestKind; stage: PhoenixCrmRequestStage | null; stageLabel: string | null }>;
  /**
   * The Google Maps check on his place (owner, 2026-10-03): `checking` while a held validation waits,
   * `not_confirmed` when the last one was turned down and he is back under To validate. Read by the rep
   * as the SYSTEM's doing — the screens name no person (google-place-rules.ts).
   */
  locationCheck: LocationCheckState;
  /**
   * 🔴 WHEN HE WENT BACK TO "TO VALIDATE" BECAUSE HIS PLACE WAS REFUSED (2026-10-08). Null for every
   * other customer, and nulled here once he is validated again — the stamp itself survives on the row
   * for the owner's board, which needs the AGE and not only the fact.
   *
   * It exists because `locationCheck === "not_confirmed"` proves the fact but cannot carry an age, and
   * the age is what was wrong: measured the day this shipped, 0 of the 22 reopened customers had been
   * validated again, average wait 40.8 hours, oldest 76.7.
   */
  reopenedAt: string | null;
  /**
   * What is wrong with the PHOTO he took, from the closed list in
   * `@/lib/phoenix-crm/validation-feedback` — the one thing he is ever told about a refusal. Null for
   * the 27 refusals that predate the column, and the screen falls back to the impersonal sentence.
   *
   * 🔴 NEVER THE FREE-TEXT NOTE BESIDE IT, and never that a person decided: his app stays easy and
   * blind (owner, 2026-10-03), so this is about his picture and nothing else.
   */
  validateAgainReason: string | null;
  /**
   * The comments written about this customer's place that the writer chose to SHOW HIM — the Super
   * Admin's or his own district manager's (owner, 2026-10-13). Each carries the writer's ROLE and
   * never a name, and never a recommendation.
   *
   * 🔴 THE ONE DOOR IN GOLDEN RULE #1, AND IT IS SILENT. Until this, nothing a rep received named any
   * person at all (owner, 2026-10-03: "do not show the rep that a person is accepting or rejecting").
   * A note he may NOT read never reaches this array: `loadRepVisiblePlaceNotes` filters `rep_visible`
   * in the query, because a field a browser receives counts as shown. Nothing is notified either — no
   * bell, no Telegram, no email, no badge — so a check being looked at never pings his phone.
   */
  notes: RepPlaceNote[];
  /** The pharmacy pinned as this doctor's primary, or null. */
  primaryPharmacyName: string | null;
  /**
   * His phone as the REP typed it — at validation, or corrected since in "Change the details" (owner,
   * 2026-09-30). Optional, so null for most. Never iReports360's: the owner chose "only what the rep
   * types", so the old list's phones are neither copied in nor shown.
   */
  phone: string | null;
  /**
   * 🔴 WHERE THIS PHARMACY IS, on the days a rep chose to pin it (owner, 2026-10-09: "visiting
   * pharmacy or adding a new pharmacy, make it optional to add its location by a pin button …
   * optional, if you want to save its location do this, if you want also don't do this … and of
   * course, when he captured the location, the location is then cleaned and separated into area,
   * brick, government"). Null on every doctor, and on every pharmacy nobody has pinned.
   *
   * A RECORD, never a check: no pharmacy visit is measured against it, nothing is refused, held,
   * approved or scored because of it, and a pharmacy is never "validated" at its door the way a
   * doctor is. The area, the brick and the governorate are resolved on the SERVER from the
   * coordinate alone (`resolvePharmacyPinLocation`) — the phone sends a position and nothing else.
   */
  pharmacyPin: PharmacyPin | null;
  /** The pharmacies feedback was taken from for this doctor, primary first, then most recent. */
  pharmacies: CustomerPharmacy[];
};

/**
 * A pinned pharmacy's own location, as the list and the visit picker read it.
 *
 * `brickLookup` keeps the two kinds of nothing apart, exactly as a place's does: `none_nearby` is a
 * pin that really is far from every Phoenix brick, `could_not_look` is a brick master that could not
 * be read — a reader deciding whether to trust a blank brick needs to know which.
 */
export type PharmacyPin = {
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  capturedAt: string | null;
  capturedByName: string | null;
  /** The clean address Google read for the point; null when the lookup was refused or quota-spent. */
  address: string | null;
  governorate: string | null;
  areaCode: string | null;
  areaName: string | null;
  brickId: string | null;
  brickName: string | null;
  brickDistanceKm: number | null;
  brickLookup: "matched" | "none_nearby" | "could_not_look" | null;
};

export type ListReferenceEntry = {
  contactCrmId: number;
  listType: PhoenixCrmListType;
  grade: PhoenixCrmGrade | null;
  name: string;
  speciality: string | null;
  address: string | null;
  city: string | null;
  zone: string | null;
  lastVisitedOn: string | null;
  state: ReferenceState;
  customerId: string | null;
  pendingDropRequestId: string | null;
};

export type ListRequest = {
  requestId: string;
  kind: PhoenixCrmRequestKind;
  status: PhoenixCrmRequestStatus;
  customerId: string | null;
  referenceContactCrmId: number | null;
  customerName: string;
  listType: PhoenixCrmListType;
  currentGrade: PhoenixCrmGrade | null;
  proposedGrade: PhoenixCrmGrade | null;
  dropReason: string | null;
  dropReasonLabel: string | null;
  note: string | null;
  requestedByName: string;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** "Add to the list", "Drop from the list"… */
  kindLabel: string;
  /** The step a waiting drop, add or bring-back is on; null for a grade change and once decided. */
  stage: PhoenixCrmRequestStage | null;
  stageLabel: string | null;
  /** An add, once the district manager approved it: the A/B/C he confirmed and the potential he set. */
  approvedGrade: PhoenixCrmGrade | null;
  potentialGrade: PotentialGrade | null;
  /** The district manager's step of a two-step request, once taken. */
  managerDecision: { byName: string; at: string; note: string | null } | null;
  /** The viewer decides the step this request is on (the caller sets it; the mapper cannot know). */
  canDecide: boolean;
  /**
   * Which customer it is about — the same for two requests on one customer, so the bulk drop can tell a
   * repeat ask (the database closes it itself once the first is approved). Never printed.
   */
  customerKey: string | null;
  /**
   * SFE sent it back to the rep to explain (owner, 2026-10-12). It is still pending, nobody can decide it
   * as an approval until the rep answers, and `stage` then reads the step it returns to.
   */
  withRep: boolean;
  /** What SFE asked, who asked it and when; kept after the rep answers. */
  returnNote: string | null;
  returnedByName: string | null;
  returnedAt: string | null;
  /** The rep's answer to the return, once given. */
  repReply: string | null;
  repliedAt: string | null;
  /** The viewer may return it for a comment (the caller sets it, like `canDecide`). */
  canReturn: boolean;
};

/**
 * One rep seat a curated customer can be handed to. Named, never coded: `seatId` is the picker's
 * value and is never printed, and a seat nobody holds today still reads by its territory — a list
 * belongs to the SEAT, not to the person on it (owner's pick, 2026-10-02).
 */
export type ListMoveTarget = {
  seatId: string;
  lineCode: string;
  lineName: string | null;
  territoryName: string;
  /** Null for a vacant seat. */
  repName: string | null;
};

export type TerritoryListView = {
  territory: TerritorySummary;
  isTest: boolean;
  /** The viewer is the territory's rep (or the Super Admin in test mode): the list can be changed. */
  canEdit: boolean;
  /**
   * The viewer may VALIDATE a carried-over customer here: the rep, and since 2026-10-02 a MANAGER of
   * the territory too (the owner's pick). It is deliberately narrower than `canEdit` — a manager
   * validates, and does not drop, grade, add or change the hours, which are the rep's own work.
   */
  canValidateReference: boolean;
  /** The viewer decides this territory's requests. */
  canReview: boolean;
  /** The viewer may move a validated place: the Super Admin and the SFE Manager, nobody else. */
  canMovePlaces: boolean;
  /** The Super Admin alone moves standalone customers INTO a validated polyclinic (owner, 2026-10-10). */
  canSeatInVenue: boolean;
  /**
   * The viewer reads a place's measurements — its accuracy, the phone-clock warning, the raw readings
   * and where the fixed point came from: the Super Admin and the SFE Manager alone (owner, 2026-10-02,
   * `readsLocationDetail`). For everyone else the server sends none of them (`blindTerritoryList`).
   */
  seesMeasurements: boolean;
  /**
   * The viewer decides the SFE step, so he may bring an archived customer back himself (the SFE manages
   * the Archive, owner 2026-09-29): the SFE Manager in scope, the Super Admin in test mode.
   */
  canBringBack: boolean;
  /**
   * The viewer may curate this rep's list from outside it — drop a customer himself, or hand him to
   * another rep (owner, 2026-10-06; `canCurateList`): the SFE Manager and the Super Admin. A rep's own
   * ask to drop still takes its two steps.
   */
  canCurateList: boolean;
  /**
   * Where a curated customer may be moved: every OTHER rep seat the viewer reaches, by the rep's own
   * name. Empty for everybody else, so an ordinary viewer's List payload is exactly what it was and
   * costs no extra read.
   */
  moveTargets: ListMoveTarget[];
  readiness: ReadinessSummary & { readyAt: string | null };
  /** Whose iReports360 list the reference is; the name is null when that person is not on record. */
  referenceSource: { name: string | null; isCurrent: boolean } | null;
  reference: ListReferenceEntry[];
  customers: ListCustomer[];
  requests: ListRequest[];
  monthStart: string;
  /**
   * The places a customer can hold, and the weak-signal threshold — which is how a reading is judged,
   * so only the Super Admin and the SFE Manager receive it (`blindTerritoryList`).
   */
  rules: { weakGpsMeters?: number; placesMax: number };
  /** The Ramadan in force or coming next (with the Super Admin's moved days), for the Ramadan hours note. */
  ramadan: { startsOn: string; endsOn: string } | null;
};

/** The database refuses a sixth active place (phoenix_crm_add_place, too_many_places). */
export const PHOENIX_CRM_PLACES_MAX = 5;

/**
 * The written reason moving a customer to another rep needs — the same bounds a place move has
 * (place-move.ts), because it is the same kind of act: rewriting a validated record somebody else
 * captured. `phoenix_crm_move_customer` repeats both bounds, so a phone cannot get round them.
 */
export const CUSTOMER_MOVE_REASON_MIN = 10;
export const CUSTOMER_MOVE_REASON_MAX = 500;

export function mapTimings(raw: unknown): PhoenixCrmTiming[] {
  if (!Array.isArray(raw)) return [];
  const timings: PhoenixCrmTiming[] = [];
  for (const entry of raw) {
    const body = record(entry);
    const weekday = Number(body.weekday);
    const startMinute = Number(body.startMinute);
    const endMinute = body.endMinute === null || body.endMinute === undefined ? null : Number(body.endMinute);
    if (!Number.isInteger(weekday) || !Number.isInteger(startMinute) || (endMinute !== null && !Number.isInteger(endMinute))) continue;
    timings.push({ weekday, startMinute, endMinute, season: body.season === "ramadan" ? "ramadan" : "normal" });
  }
  return sortTimings(timings);
}

export function mapPlaceRow(row: Row): ListPlace {
  const skew = numberOrNull(row.device_skew_minutes);
  return {
    placeId: String(row.id),
    label: text(row.label),
    address: text(row.address),
    brickId: text(row.brick_id),
    brickName: text(row.brick_name),
    brickDistanceKm: numberOrNull(row.brick_distance_km),
    // Unknown reads as `could_not_look`, never as a confident match: the column's own default says
    // the same thing, so a row written by code that does not set it can never pass for `matched`.
    brickLookup:
      row.brick_lookup === "matched" || row.brick_lookup === "none_nearby" ? row.brick_lookup : "could_not_look",
    areaCode: text(row.area_code),
    areaName: text(row.area_name),
    regionCode: text(row.region_code),
    regionName: text(row.region_name),
    zone: text(row.zone),
    lat: Number(row.lat),
    lon: Number(row.lon),
    accuracyMeters: numberOrNull(row.accuracy_meters),
    timings: mapTimings(row.timings),
    photoPath: String(row.photo_path),
    capturedAt: String(row.captured_at),
    clockOff: skew !== null && Math.abs(skew) > DEVICE_CLOCK_TOLERANCE_MINUTES,
    pointSource:
      row.point_source === "photo" || row.point_source === "moved" || row.point_source === "shared_place"
        ? row.point_source
        : "pin",
    sharedPlaceId: text(row.shared_place_id),
    session: row.session === "AM" || row.session === "PM" ? row.session : null,
    pinReading: readingOf(row.pin_lat, row.pin_lon, row.pin_accuracy_meters),
    photoReading: readingOf(row.photo_lat, row.photo_lon, row.photo_accuracy_meters),
    moved: text(row.moved_at) ? { at: String(row.moved_at), reason: text(row.move_reason) } : null,
  };
}

function readingOf(lat: unknown, lon: unknown, accuracy: unknown): PlaceReading | null {
  const latitude = numberOrNull(lat);
  const longitude = numberOrNull(lon);
  return latitude === null || longitude === null ? null : { lat: latitude, lon: longitude, accuracyMeters: numberOrNull(accuracy) };
}

/**
 * A pharmacy's pin, or null — which is what the overwhelming majority of rows carry, because pinning
 * one is optional by the owner's own instruction and a doctor never has one at all.
 *
 * BOTH coordinates must be present for a pin to exist: a half-written pair is no location, exactly as
 * `readingOf` treats a place's two readings, and the migration's own check constraint refuses the
 * half anyway.
 */
function mapPharmacyPin(row: Row, names: PeopleNames): PharmacyPin | null {
  const lat = numberOrNull(row.pharmacy_pin_lat);
  const lon = numberOrNull(row.pharmacy_pin_lon);
  if (lat === null || lon === null) return null;
  const by = text(row.pharmacy_pin_captured_by_hr_id);
  return {
    lat,
    lon,
    accuracyMeters: numberOrNull(row.pharmacy_pin_accuracy_meters),
    capturedAt: text(row.pharmacy_pin_captured_at),
    capturedByName: by ? nameOf(names, by) : null,
    address: text(row.pharmacy_pin_address),
    governorate: text(row.pharmacy_pin_governorate),
    areaCode: text(row.pharmacy_pin_area_code),
    areaName: text(row.pharmacy_pin_area_name),
    brickId: text(row.pharmacy_pin_brick_id),
    brickName: text(row.pharmacy_pin_brick_name),
    brickDistanceKm: numberOrNull(row.pharmacy_pin_brick_distance_km),
    // Unknown stays null here rather than becoming `could_not_look`: a place ALWAYS resolved its
    // brick at validation, so a blank there means the lookup failed; a pharmacy pinned by a build
    // that predates a later column simply never said.
    brickLookup:
      row.pharmacy_pin_brick_lookup === "matched" || row.pharmacy_pin_brick_lookup === "none_nearby" || row.pharmacy_pin_brick_lookup === "could_not_look"
        ? row.pharmacy_pin_brick_lookup
        : null,
  };
}

// 🔴 A POSTGREST SELECT IS ONE STRING, AND A COLUMN THAT DOES NOT EXIST FAILS THE WHOLE READ WITH
// 42703 — which here is the rep's list, the planner and the visit form at once. So a column named
// here must already exist on the database the branch deploys against: `brick_lookup` arrived in
// migration 20261008023051, `reopened_at` in 20261008023801 and `shared_place_id` in
// 20261010013001 and `session` in 20261010180118, each applied to staging and production before this line shipped.
const PLACE_COLUMNS =
  "id, customer_id, label, address, brick_id, brick_name, brick_distance_km, brick_lookup, area_code, area_name, region_code, region_name, zone, lat, lon, accuracy_meters, timings, photo_path, captured_at, device_skew_minutes, " +
  "pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, point_source, moved_at, move_reason, shared_place_id, session";
const CUSTOMER_COLUMNS =
  "id, list_type, name, speciality, grade, potential_grade, origin, reference_contact_crm_id, status, validated_at, validated_by_hr_id, dropped_reason, dropped_note, status_changed_at, reopened_at, primary_pharmacy_name, phone, intake_where, intake_note, intake_timings, " +
  // A pinned pharmacy's own location (2026-10-09). Every one is nullable and null on every doctor.
  "pharmacy_pin_lat, pharmacy_pin_lon, pharmacy_pin_accuracy_meters, pharmacy_pin_captured_at, pharmacy_pin_captured_by_hr_id, pharmacy_pin_address, " +
  "pharmacy_pin_governorate, pharmacy_pin_area_code, pharmacy_pin_area_name, pharmacy_pin_brick_id, pharmacy_pin_brick_name, pharmacy_pin_brick_distance_km, pharmacy_pin_brick_lookup";

/**
 * Every customer carried over from the territory's iReports360 list has a row here, pending until the
 * rep validates it at the clinic. Minting them is idempotent, so every read of the list, the planner
 * or the visit form calls this and the list keeps itself in step with iReports360 — a customer added
 * there appears, one taken off simply stops being minted.
 */
export async function ensureReferenceCustomers(seat: OrgSeat, isTest: boolean): Promise<void> {
  if (!seat.lineCode) return;
  const { error } = await getSupabaseAdmin().rpc("phoenix_crm_ensure_reference_customers", {
    p_seat_id: seat.seatId,
    p_line_code: seat.lineCode,
    p_is_test: isTest,
  });
  throwIfError(error);
}

/**
 * Every customer of a territory (on the list, outside it and in the Archive), with its active places.
 *
 * `onListOnly` keeps the list itself: validated, or carried over and waiting to be. `includeOutside`
 * adds the customers met outside the list and waiting to be added — the visit form offers them (a
 * second out-of-list visit to the same person), the planner deliberately does not.
 */
export async function loadTerritoryCustomers(
  seatId: string,
  isTest: boolean,
  options: { onListOnly?: boolean; includeOutside?: boolean } = {},
): Promise<{ customers: Row[]; placesByCustomer: Map<string, ListPlace[]> }> {
  const supabase = getSupabaseAdmin();
  const [customers, places] = await Promise.all([
    fetchAllRowsKeyset<Row>(
      () => {
        let query = supabase.from("phoenix_crm_customers").select(CUSTOMER_COLUMNS).eq("seat_id", seatId).eq("is_test", isTest);
        // On the list: validated, or carried over and waiting to be. A dropped customer is left out, and
        // one waiting outside the list only when the caller asks for him.
        if (options.onListOnly) query = query.in("status", options.includeOutside ? ["active", "pending", "outside"] : ["active", "pending"]);
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
    fetchAllRowsKeyset<Row>(
      () => supabase.from("phoenix_crm_places").select(PLACE_COLUMNS).eq("seat_id", seatId).eq("is_test", isTest).eq("status", "active"),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  ]);
  // Which of the buildings these places are seated in already have their timetable on file.
  const venueIds = [...new Set(places.map((row) => text(row.shared_place_id)).filter((id): id is string => id !== null))];
  const boardOnFile = new Map<string, boolean>();
  const venueHeld = new Map<string, boolean>();
  if (venueIds.length > 0) {
    const venues = await supabase.from("phoenix_crm_shared_places").select("id, schedule_photo_path, status").in("id", venueIds);
    throwIfError(venues.error);
    for (const venue of (venues.data ?? []) as Row[]) {
      boardOnFile.set(String(venue.id), text(venue.schedule_photo_path) !== null);
      venueHeld.set(String(venue.id), venue.status === "held");
    }
  }
  const placesByCustomer = new Map<string, ListPlace[]>();
  for (const row of places) {
    const customerId = String(row.customer_id);
    const list = placesByCustomer.get(customerId) ?? [];
    const mapped = mapPlaceRow(row);
    const venueId = text(row.shared_place_id);
    if (venueId) {
      mapped.venueTimetableOnFile = boardOnFile.get(venueId) === true;
      mapped.venueHeld = venueHeld.get(venueId) === true;
    }
    list.push(mapped);
    placesByCustomer.set(customerId, list);
  }
  for (const list of placesByCustomer.values()) list.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  return { customers, placesByCustomer };
}

/**
 * Visits a customer this month, by customer id.
 *
 * `phoenix_crm_countable_visits`, never the base table. This read feeds `visitsThisMonth` — the rep's
 * own standing against his grade norm on FOUR screens (the visit form, the weekly planner, the monthly
 * planner and the List board) and, through `coverageTier`, the day's suggestions. It is a PostgREST
 * read and not one of the phoenix_crm_report_* functions, so "I moved every report to the view" does
 * not reach it; leave it on the raw table and an off-plan visit nobody has approved quietly satisfies
 * a frequency norm everywhere a rep plans.
 *
 * 🔴 IT DOES NOT ASK FOR `customer_validated`, AND MUST NOT — THIS IS THE ONE COUNT THAT IS NOT A KPI.
 * The owner's rule of 2026-10-01 is that a visit to a customer who is not validated yet counts in no
 * KPI, and the tallies and rates all filter on it now. This number is a different sentence: beside an
 * unvalidated customer every screen prints it as `pendingVisitsText` — "3 visits saved here, not
 * counting yet" — which exists precisely to tell the rep his work was SAVED while saying plainly that
 * it is not counting. Filter here and that line becomes "No visits saved here yet" about three visits
 * he really made, which is the lie the sentence was written to avoid. For a customer on the list the
 * question does not arise: `phoenix_crm_customers_active_is_validated` makes `active` and validated
 * one statement, so his standing against his grade norm is unaffected either way.
 */
export async function loadMonthVisitCounts(seatId: string, isTest: boolean, monthStart: string, through: string): Promise<Map<string, number>> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_countable_visits")
        .select("id, customer_id")
        .eq("seat_id", seatId)
        .eq("is_test", isTest)
        .gte("visit_date", monthStart)
        .lte("visit_date", through),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    const customerId = String(row.customer_id);
    counts.set(customerId, (counts.get(customerId) ?? 0) + 1);
  }
  return counts;
}

/** The key a free-typed pharmacy name is grouped by — the same normalization the visit form suggests with. */
export function normalizePharmacyName(name: string): string {
  return collapsePharmacyName(name).toLowerCase();
}

/**
 * Every pharmacy on the seat's list, the Archive included — a match needs to know what he dropped. The
 * doctor's box (`linkNamedPharmacies`) and Add a pharmacy (`matchAddedPharmacy`) both read it.
 */
export async function loadListedPharmacies(seatId: string, isTest: boolean): Promise<ListedPharmacy[]> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_customers")
        .select("id, name, status")
        .eq("seat_id", seatId)
        .eq("is_test", isTest)
        .eq("list_type", PHARMACY_LIST_TYPE),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  return rows.map((row) => ({ customerId: String(row.id), name: String(row.name ?? ""), status: String(row.status ?? "") }));
}

/** At most this many pharmacies are shown per doctor, most-recent first. */
const CUSTOMER_PHARMACIES_MAX = 50;

/** One visit's pharmacy feedback, as the grouping reads it. */
export type PharmacyFeedback = {
  customerId: string;
  pharmacyName: string;
  productAvailability: Record<string, ProductAvailability>;
  capturedAt: string;
  /**
   * How many visits this row stands for — 1 when absent. The List reads only the rows that can change a
   * card (phoenix_crm_customer_pharmacy_feedback) and the database carries each stored name's whole
   * count on its newest row, 0 on the others, so the count is the same as reading every visit.
   */
  visits?: number;
};

type PharmacyAggregate = {
  name: string;
  lastFeedbackAt: string;
  visits: number;
  /** product → { answer, at } so a newer visit's answer wins per product. */
  products: Map<string, { answer: ProductAvailability; at: string }>;
};

/**
 * Group a doctor's visit feedback into his pharmacies, case-insensitively: the display name is the most
 * recent spelling, each product keeps its latest Has/Doesn't-have answer, and the list is most-recent
 * first. `isPrimary` is left false here and set by the caller, which knows the pinned primary. Pure, so
 * the grouping is tested without a database.
 *
 * `max` is how many pharmacies each key keeps — a customer's card shows his 50 most recent. The
 * missing-stock board (server/insight-reports.ts) groups a whole territory's answers through this SAME
 * function, one product at a time, and passes no limit: a board that dropped the 51st pharmacy short
 * of a product would be a board quietly telling a manager it was in stock.
 */
export function groupCustomerPharmacies(feedback: PharmacyFeedback[], max: number = CUSTOMER_PHARMACIES_MAX): Map<string, CustomerPharmacy[]> {
  // Oldest first, so a more recent visit's spelling and answers overwrite earlier ones.
  const rows = [...feedback].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));

  const byCustomer = new Map<string, Map<string, PharmacyAggregate>>();
  for (const row of rows) {
    const name = row.pharmacyName.trim();
    if (!name) continue;
    const key = normalizePharmacyName(name);
    let pharmacies = byCustomer.get(row.customerId);
    if (!pharmacies) {
      pharmacies = new Map();
      byCustomer.set(row.customerId, pharmacies);
    }
    const aggregate = pharmacies.get(key) ?? { name, lastFeedbackAt: row.capturedAt, visits: 0, products: new Map() };
    aggregate.name = name;
    aggregate.lastFeedbackAt = row.capturedAt;
    aggregate.visits += row.visits ?? 1;
    for (const [product, answer] of Object.entries(row.productAvailability)) {
      aggregate.products.set(product, { answer, at: row.capturedAt });
    }
    pharmacies.set(key, aggregate);
  }

  const result = new Map<string, CustomerPharmacy[]>();
  for (const [customerId, pharmacies] of byCustomer) {
    const list: CustomerPharmacy[] = [...pharmacies.values()]
      .map((aggregate) => ({
        name: aggregate.name,
        isPrimary: false,
        lastFeedbackAt: aggregate.lastFeedbackAt,
        visits: aggregate.visits,
        products: [...aggregate.products.entries()]
          .map(([product, latest]) => ({ product, answer: latest.answer }))
          .sort((left, right) => left.product.localeCompare(right.product)),
      }))
      .sort((left, right) => right.lastFeedbackAt.localeCompare(left.lastFeedbackAt))
      .slice(0, max);
    result.set(customerId, list);
  }
  return result;
}

/** True when the database has no such function yet — a migration not applied here (PostgREST PGRST202). */
function isMissingFunction(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return code === "PGRST202" || code === "42883";
}

/**
 * The pharmacies each doctor's feedback came from, from this territory's visits.
 *
 * 🔴 ONLY THE VISITS THAT CAN CHANGE A CARD (2026-10-16 Phoenix CRM performance audit). This read every
 * visit the territory ever saved that named a pharmacy — its whole history, on every open of the List.
 * phoenix_crm_customer_pharmacy_feedback returns, in the same id order, only each stored name's and each
 * answered product's earliest and latest second (and any row over the answer cap), with each name's
 * whole count on its newest row; the grouping below adds those counts. Every card — its name, last
 * feedback, count, answers and order — is the one the whole history gave; the rule is argued in the
 * migration (20261016180201) and replayed against the full grouping in
 * tests/phoenix-crm-doctor-pharmacies.test.ts. NOT bounded by date: a pharmacy named seven months ago
 * still shows, with its true count. Until the function is applied, the whole-history read answers.
 */
export async function loadCustomerPharmacies(seatId: string, isTest: boolean): Promise<Map<string, CustomerPharmacy[]>> {
  let rows: Row[];
  try {
    rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin().rpc("phoenix_crm_customer_pharmacy_feedback", {
          p_seat_id: seatId,
          p_is_test: isTest,
          p_product_max: PRODUCT_AVAILABILITY_MAX,
        }),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
  } catch (error) {
    if (!isMissingFunction(error)) throw error;
    rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_visits")
          .select("id, customer_id, pharmacy_name, product_availability, captured_at")
          .eq("seat_id", seatId)
          .eq("is_test", isTest)
          .not("pharmacy_name", "is", null),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
  }
  const feedback: PharmacyFeedback[] = [];
  for (const row of rows) {
    const name = text(row.pharmacy_name);
    if (!name) continue;
    feedback.push({
      customerId: String(row.customer_id),
      pharmacyName: name,
      productAvailability: parseProductAvailability(row.product_availability),
      capturedAt: String(row.captured_at),
      // The whole-history read carries no weight: each of its rows is one visit.
      visits: row.visits === undefined || row.visits === null ? 1 : Number(row.visits),
    });
  }
  return groupCustomerPharmacies(feedback);
}

type ReferenceRow = {
  seat_id: string;
  source_hr_id: string;
  source_is_current: boolean;
  contact_crm_id: number;
  list_type: PhoenixCrmListType;
  grade: PhoenixCrmGrade | null;
  name: string;
  speciality: string | null;
  address: string | null;
  city: string | null;
  zone: string | null;
  brick_id: string | null;
  last_visited_on: string | null;
  customer_id: string | null;
  state: ReferenceState;
};

/**
 * The seat's live iReports360 list — AM, PM and, since 2026-10-02, the rep's PHARMACIES
 * (`supabase/migrations/20261002150353_phoenix_crm_pharmacy_reference.sql`).
 *
 * 🔴 A WHOLESALER IS FILTERED HERE, AND IT HAS TO BE HERE RATHER THAN IN THE SQL. A makhzan is never
 * shown as a candidate nor validated as a venue (`AGENTS.md` §4.1, owner 2026-09-22, "never never
 * never"), and the test for one is `wholesaler-venue-guard`, which reuses the monthly closing's own
 * name primitives so the two can never disagree and every owner pharmacy-override applies
 * automatically. Re-stating those rules in SQL would be a second answer that drifts, so the
 * reference function deliberately does not try, and this read is the one door they all come through.
 *
 * Only PHARMACY rows are tested. The rule is about a warehouse posing as a shop; running a
 * warehouse-name test over doctors would drop a clinic whose name merely reads like one, and no
 * owner ruling asks for that. Measured on production the day it shipped: of 1,930 vendor pharmacies,
 * **0 are hard-blocked** and 6 carry the ambiguous فارما word — the guard FLAGS those for a human
 * rather than refusing them, which is why only the certain half is filtered and the suspected half
 * travels on.
 */
export async function loadReference(seatId: string, isTest: boolean): Promise<ReferenceRow[]> {
  const rows = await rpcAll<ReferenceRow>(getSupabaseAdmin(), "phoenix_crm_seat_reference", { p_seat_ids: [seatId], p_is_test: isTest }, [
    "list_type",
    "contact_crm_id",
  ]);
  return rows.filter((row) => !(isPharmacyListType(row.list_type) && isCertainWholesalerVenue(row.name)));
}

/**
 * Where each customer NOT VALIDATED YET among `customers` sits, keyed by customer id — what the plan
 * board shows in the place a validated customer's clinic would fill (owner, 2026-09-30).
 *
 * The brick and its area come from `loadBrickNames`, i.e. the sales master, which agrees with the
 * organogram on every area name. iReports360's own `zone` and `city` are NOT read: they are a different
 * vocabulary that disagrees with the organogram on 37 of 39 areas (see `PlannerReference`). Only its
 * `address` — the town — is carried over.
 */
export async function loadPlannerReferences(seatId: string, isTest: boolean, customers: ReadonlyArray<Row>): Promise<Map<string, PlannerReference>> {
  const pending = customers.filter((row) => row.status === "pending" && numberOrNull(row.reference_contact_crm_id) !== null);
  const references = new Map<string, PlannerReference>();
  if (pending.length === 0) return references;
  const reference = await loadReference(seatId, isTest);
  const byContact = new Map(reference.map((row) => [Number(row.contact_crm_id), row]));
  // Only the bricks of the entries asked about (2026-10-16 performance audit): the loop below reads no
  // other, and a whole territory's reference holds hundreds where Today asks about a handful.
  const matched = pending.map((row) => byContact.get(Number(row.reference_contact_crm_id))).filter((entry): entry is ReferenceRow => Boolean(entry));
  const brickMeta = await loadBrickNames(matched.map((entry) => entry.brick_id).filter((brickId): brickId is string => Boolean(brickId)));
  for (const row of pending) {
    const entry = byContact.get(Number(row.reference_contact_crm_id));
    if (!entry) continue;
    const meta = entry.brick_id ? brickMeta.get(entry.brick_id) : undefined;
    references.set(String(row.id), { brick: meta?.brickName ?? null, area: meta?.areaName ?? null, address: entry.address });
  }
  return references;
}

export type SeatReadiness = ReadinessSummary & { seatId: string; readyAt: string | null };

/**
 * Real readiness for many territories in one call. With markReady, a complete territory is stamped ready once.
 * The answer holds every territory asked about, or the call throws: a territory the database did not
 * answer for is never read as ready (or as anything else).
 */
export async function loadReadiness(seatIds: string[], markReady = false): Promise<Map<string, SeatReadiness>> {
  const readiness = new Map<string, SeatReadiness>();
  const asked = [...new Set(seatIds)];
  // FOUR CHUNKS AT A TIME (2026-10-16 Phoenix CRM performance audit). Each chunk is a whole reference
  // computation for 150 territories, and the company-wide boards asked them one after another. The
  // answers are folded in chunk order, exactly as the loop did, so the map reads the same.
  const answers = await mapWithConcurrency(chunk(asked, 150), 4, async (part) => {
    const { data, error } = await getSupabaseAdmin().rpc("phoenix_crm_seat_readiness", { p_seat_ids: part, p_mark_ready: markReady });
    throwIfError(error);
    return (data ?? []) as Row[];
  });
  for (const rows of answers) {
    for (const row of rows) {
      const total = Number(row.reference_total ?? 0);
      const validated = Number(row.validated_count ?? 0);
      const dropped = Number(row.dropped_count ?? 0);
      const dropPending = Number(row.drop_pending_count ?? 0);
      const open = Number(row.open_count ?? 0);
      readiness.set(String(row.seat_id), {
        seatId: String(row.seat_id),
        total,
        validated,
        dropped,
        dropPending,
        open,
        // Measured once: a territory stamped ready stays ready when new reference customers appear later.
        // A territory with no reference list is ready but never stamped, so a list that reaches it later
        // (a new rep's first iReports360 list) is finished before planning.
        ready: Boolean(text(row.ready_at)) || (open === 0 && dropPending === 0),
        readyAt: text(row.ready_at),
      });
    }
  }
  const unanswered = asked.filter((seatId) => !readiness.has(seatId));
  if (unanswered.length > 0) {
    throw new Error(`phoenix_crm_seat_readiness answered no row for ${unanswered.length} of ${asked.length} territories`);
  }
  return readiness;
}

/**
 * The day ONE territory was stamped ready, or null — the only figure the List takes from readiness.
 *
 * WHY NOT `loadReadiness` (2026-10-16 Phoenix CRM performance audit). The List counts its reference
 * states itself, off the reference it has already read, and used the readiness call for nothing but
 * `ready_at`. Without `p_mark_ready` that call returns `coalesce(t.ready_at, m.ready_at)` where `m`
 * (the rows it stamps) is empty, so its `ready_at` IS this table's — yet it computed the whole seat
 * reference a second time to get there. Same row, same value, one primary-key read.
 */
async function loadStoredReadyAt(seatId: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin().from("phoenix_crm_territory_readiness").select("ready_at").eq("seat_id", seatId).maybeSingle();
  throwIfError(error);
  return text((data as Row | null)?.ready_at);
}

function requestKindOf(value: unknown): PhoenixCrmRequestKind {
  return value === "drop" || value === "add" || value === "restore" ? value : "grade";
}

/** The people a request row names, for one names read. */
export function requestPeople(rows: ReadonlyArray<Row>): Array<string | null> {
  return rows.flatMap((row) => [
    text(row.requested_by_hr_id),
    text(row.decided_by_hr_id),
    text(row.manager_decided_by_hr_id),
    text(row.returned_by_hr_id),
  ]);
}

export function mapRequestRow(row: Row, names: ReadonlyMap<string, string>): ListRequest {
  const dropReason = text(row.drop_reason);
  const kind = requestKindOf(row.kind);
  const status = String(row.status) as PhoenixCrmRequestStatus;
  // With the rep, the stored stage is 'rep'; the request's `stage` then reads the step it returns to, so
  // the screens that group by step keep working, and `withRep` is what stops anyone approving it.
  const withRep = status === "pending" && isWithRep(row.stage);
  const stage = withRep ? stageAfterReply(kind) : status === "pending" && isRequestStage(row.stage) ? row.stage : null;
  const managerBy = text(row.manager_decided_by_hr_id);
  const returnedBy = text(row.returned_by_hr_id);
  return {
    requestId: String(row.id),
    kind,
    status,
    customerId: text(row.customer_id),
    referenceContactCrmId: numberOrNull(row.reference_contact_crm_id),
    customerName: String(row.customer_name),
    listType: parseListType(row.list_type),
    currentGrade: parseGrade(row.current_grade),
    proposedGrade: parseGrade(row.proposed_grade),
    dropReason,
    dropReasonLabel: dropReasonLabel(dropReason),
    note: text(row.note),
    requestedByName: nameOf(names, text(row.requested_by_hr_id)),
    requestedAt: String(row.requested_at),
    // The Administrator is named by his title, never by name and never as HR (owner, 2026-10-08).
    decidedByName: text(row.decided_by_hr_id)
      ? personKey(text(row.decided_by_hr_id)) === personKey(PHOENIX_CRM_ADMINISTRATOR_HR_ID)
        ? "The Administrator"
        : nameOf(names, text(row.decided_by_hr_id))
      : null,
    decidedAt: text(row.decided_at),
    decisionNote: text(row.decision_note),
    kindLabel: requestKindLabel(kind),
    stage,
    stageLabel: withRep ? WITH_REP_LABEL : requestStageLabel(stage),
    approvedGrade: parseGrade(row.approved_grade),
    potentialGrade: parsePotentialGrade(row.potential_grade),
    managerDecision:
      managerBy && text(row.manager_decided_at)
        ? { byName: nameOf(names, managerBy), at: String(row.manager_decided_at), note: text(row.manager_note) }
        : null,
    canDecide: false,
    customerKey: text(row.customer_id) ?? (text(row.reference_contact_crm_id) ? `reference:${text(row.seat_id)}:${text(row.reference_contact_crm_id)}` : null),
    withRep,
    returnNote: text(row.return_note),
    returnedByName: returnedBy ? nameOf(names, returnedBy) : null,
    returnedAt: text(row.returned_at),
    repReply: text(row.rep_reply),
    repliedAt: text(row.replied_at),
    canReturn: false,
  };
}

/**
 * What the viewer may do with a request on this seat: decide it, or return it for a comment. One place,
 * so the List and the Team tab can never disagree. A request with the rep reads `canDecide: false`, so
 * no Approve or Refuse is drawn on it and the bulk drop cannot pick it; the database refuses an approval
 * of it too (`request_with_rep`). The Administrator's decline does not depend on this and still works.
 */
export function requestRights(
  viewer: PhoenixCrmViewer,
  seat: OrgSeat,
  isTest: boolean,
  request: Pick<ListRequest, "kind" | "status" | "stage" | "withRep">,
): { canDecide: boolean; canReturn: boolean } {
  const pending = request.status === "pending";
  const canDecide = pending && !request.withRep && canDecideListRequest(viewer, seat, isTest, request.stage);
  const canReturn = canReturnForComment({
    kind: request.kind,
    status: request.status,
    stage: request.stage,
    withRep: request.withRep,
    canDecide,
    hasReviewer: territoryReviewer(viewer.org, seat.seatId) !== null,
  });
  return { canDecide, canReturn };
}

const REQUEST_COLUMNS =
  "id, seat_id, kind, status, stage, customer_id, reference_contact_crm_id, customer_name, list_type, current_grade, proposed_grade, " +
  "approved_grade, potential_grade, drop_reason, note, requested_by_hr_id, requested_at, manager_decided_by_hr_id, manager_decided_at, " +
  "manager_note, decided_by_hr_id, decided_at, decision_note, is_test, return_note, returned_by_hr_id, returned_at, rep_reply, replied_at";

/** Waiting requests, and the ones decided lately, for some territories. */
export async function loadRequestRows(seatIds: string[], isTest: boolean, options: { pendingOnly?: boolean } = {}): Promise<Row[]> {
  const since = new Date(Date.now() - DECIDED_REQUESTS_DAYS * 86400000).toISOString();
  // Four chunks at a time, folded in chunk order (2026-10-16 performance audit): the rows, and so the
  // stable sort below, are exactly what the one-at-a-time loop produced.
  const pages = await mapWithConcurrency(chunk([...new Set(seatIds)], 100), 4, (part) =>
    fetchAllRowsKeyset<Row>(
      () => {
        let query = getSupabaseAdmin().from("phoenix_crm_list_requests").select(REQUEST_COLUMNS).in("seat_id", part).eq("is_test", isTest);
        query = options.pendingOnly ? query.eq("status", "pending") : query.or(`status.eq.pending,decided_at.gte.${since}`);
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  );
  const rows: Row[] = pages.flat();
  return rows.sort((left, right) => String(right.requested_at).localeCompare(String(left.requested_at)));
}

/**
 * How far back the reference plans are read for the "usually planned" column. Four months: long
 * enough that a doctor planned in week 4 only has had several chances to appear, short enough that a
 * pattern the rep abandoned in the spring is not read back to him as current.
 */
const PLAN_PATTERN_MONTHS = 4;

/** "2026-09-30" minus N whole months, as the first of that month. Arithmetic on the parts, so no
 * timezone can shift it: these are calendar months, not instants. */
function monthsBack(isoDay: string, months: number): string {
  const [year, month] = isoDay.split("-").map(Number);
  const shifted = year * 12 + (month - 1) - months;
  return `${String(Math.floor(shifted / 12)).padStart(4, "0")}-${String((shifted % 12) + 1).padStart(2, "0")}-01`;
}

export async function loadTerritoryList(viewer: PhoenixCrmViewer, seatId: unknown, test: unknown): Promise<TerritoryListView> {
  const { seat, isTest } = territoryForRead(viewer, seatId, readTestFlag(test));
  const monthStart = monthStartOf(viewer.cairoToday);

  // 🔴 ONE WAVE, BESIDE THE MINT (2026-10-16 Phoenix CRM performance audit — the visit form's own
  // pattern, loadVisitForm). The List waited for the reference mint before it read anything at all.
  // Only two reads depend on the mint: the reference (whose `customer_id` it fills in) and the customer
  // list (which it adds to). Nothing else here can name a customer minted a moment ago — he has no
  // request, no visit, no pharmacy feedback, no validation check and no comment yet, and the mint
  // writes nothing but customers and their list events. So every other read starts BESIDE the mint,
  // and the mint's own failure is still the one that surfaces, first, exactly as when it ran alone.
  const ensured = ensureReferenceCustomers(seat, isTest);
  const referenceRead = ensured.then(() => loadReference(seat.seatId, isTest));
  const customersRead = ensured.then(() => loadTerritoryCustomers(seat.seatId, isTest));
  const requestRowsRead = loadRequestRows([seat.seatId], isTest);

  // 🔴 WHO ELSE CARRIES THESE CUSTOMERS (owner, 2026-09-30: "if a doctor is shared between this rep
  // and another rep, it was highlighted"). Answered against the iReports360 roster, because only a
  // company-wide read can see the other rep's row — Phoenix CRM's own tables hold one territory.
  //
  // It NEVER takes the List down with it. A vacant territory has no rep to compare against, a test
  // world has no iReports360 rows at all, and the mirror can be missing entirely on a fresh
  // environment; every one of those is an ordinary answer of "nobody", not a failure to report. A
  // highlight is a nicety; the list itself is the page.
  //
  // 🔴 STARTED HERE, BESIDE THE NAMES AND THE BRICK NAMES, NOT AFTER THEM (2026-10-01, "slow to
  // transfer between page and page", Phoenix CRM first). All three need only what the wave answers —
  // the mirror reads the reference contact behind each customer and the seat's occupant — so awaiting
  // them in turn made the List as slow as the three added together. Since 2026-10-16 they start the
  // moment the CUSTOMER LIST lands, not after the whole wave (the pharmacy and request reads among
  // it). The keys are the same set as before; the order they are read in changes nothing, since every
  // answer is per contact.
  // `occupantHrId`, not `repHrId` — OrgSeat has no such field, and reading one that does not exist
  // made this whole block silently unreachable: no sharing, no check-in point, and no error to see.
  // NOT gated on `isTest`. Both reads key on the REAL iReports360 contact behind a customer
  // (`referenceContactCrmId`) and on the seat's real occupant, so they answer the same in a test
  // world as in the real one — and gating them out made the whole feature invisible to the one
  // account it would be tried on, since a TEST- login always reads as the test world.
  //
  // 🔴 AND WHERE EACH DOCTOR ACTUALLY IS, averaged from the check-ins the reps have already taken on
  // him (owner, 2026-09-30). Both questions are answered against the same mirror, so they are asked
  // together rather than one page load apart.
  // 🔴 AND WHEN HE IS USUALLY PLANNED, off the same mirror (owner, 2026-09-30: "based on the
  // reference weekly plans from iReports360, tell him you are visiting this doctor Sunday and Tuesday
  // in the first and the fourth week"). Four months of plan dates: long enough that a week-4-only
  // doctor has had chances to appear, short enough that a pattern abandoned in the spring is not read
  // back to him as current.
  const occupantHrId = seat.occupantHrId;
  const mirrorReads = customersRead.then(({ customers }) => {
    const sharedKeys = customers
      .map((row) => numberOrNull(row.reference_contact_crm_id))
      .filter((id): id is number => typeof id === "number");
    return occupantHrId && sharedKeys.length > 0
      ? Promise.all([
          loadSharedCustomersFor(sharedKeys, occupantHrId),
          loadObservedPointsFor(sharedKeys),
          loadPlanDatesFor(sharedKeys, monthsBack(viewer.cairoToday, PLAN_PATTERN_MONTHS)),
          loadVisitHistoryFor(sharedKeys),
        ])
      : null;
  });
  // Handled the moment it starts, because it is awaited only once the names are in: a failure landing
  // while they load would otherwise be an UNHANDLED rejection. The `await` below still receives it,
  // and logs it exactly as before. (A failure of the customer list itself fails the wave below first.)
  mirrorReads.catch(() => undefined);

  // 🔴 WHERE A CURATED CUSTOMER COULD GO (owner, 2026-10-06). Resolved only for the SFE Manager and
  // the Super Admin, and the occupants' names ride in the SAME batched read as this seat's own people:
  // one query for ~74 names rather than a second round trip, and nothing at all for every other
  // viewer, whose payload stays byte-for-byte what it was.
  const canCurate = canCurateList(viewer, seat, isTest);
  const targetSeats = canCurate
    ? viewer.scopeTerritories.filter((entry) => entry.seatId !== seat.seatId && Boolean(entry.lineCode))
    : [];

  const wave = Promise.all([
    referenceRead,
    customersRead,
    requestRowsRead,
    loadMonthVisitCounts(seat.seatId, isTest, monthStart, viewer.cairoToday),
    loadCustomerPharmacies(seat.seatId, isTest),
    // The stamped day only — the List counts the reference states itself (loadStoredReadyAt).
    isTest ? Promise.resolve(null) : loadStoredReadyAt(seat.seatId),
    loadLocationChecks(seat.seatId, isTest),
    // The comments somebody chose to show this territory's rep. Rep-visible only, in the query.
    loadRepVisiblePlaceNotes(seat.seatId, isTest),
    // The people named on the page, the moment the three reads that name them land.
    Promise.all([requestRowsRead, customersRead, referenceRead]).then(([requestRows, { customers }, reference]) =>
      loadPeopleNames([
        ...territoryPeople(viewer.org, [seat]),
        ...requestPeople(requestRows),
        ...customers.map((row) => text(row.validated_by_hr_id)),
        // The rep who pinned a pharmacy — shown by NAME beside the pin, never his HR id (AGENTS.md §4).
        ...customers.map((row) => text(row.pharmacy_pin_captured_by_hr_id)),
        ...targetSeats.map((entry) => entry.occupantHrId),
        reference[0]?.source_hr_id ?? null,
      ]),
    ),
    // The name and area of every brick iReports360 carries a reference customer in — so a pending
    // customer groups under his known brick rather than an amber "not yet mapped" heading. It needs the
    // reference alone, so it starts the moment the reference lands.
    referenceRead.then((reference) => loadBrickNames(reference.map((row) => row.brick_id).filter((brickId): brickId is string => Boolean(brickId)))),
  ]);
  // Handled at once: if the mint fails, `await ensured` below throws its error and the wave is dropped.
  wave.catch(() => undefined);
  await ensured;
  const [
    reference,
    { customers, placesByCustomer },
    requestRows,
    visitCounts,
    pharmaciesByCustomer,
    storedReadyAt,
    locationChecks,
    repNotes,
    names,
    referenceBrickMeta,
  ] = await wave;
  const requests = requestRows.map((row) => {
    const request = mapRequestRow(row, names);
    return { ...request, ...requestRights(viewer, seat, isTest, request) };
  });
  const pendingByCustomer = new Map<string, Partial<Record<PhoenixCrmRequestKind, ListRequest>>>();
  const pendingDropByContact = new Map<number, ListRequest>();
  for (const request of requests) {
    if (request.status !== "pending") continue;
    if (request.customerId) {
      const entry = pendingByCustomer.get(request.customerId) ?? {};
      entry[request.kind] = request;
      pendingByCustomer.set(request.customerId, entry);
    } else if (request.kind === "drop" && request.referenceContactCrmId !== null) {
      pendingDropByContact.set(request.referenceContactCrmId, request);
    }
  }

  const referenceByContact = new Map(reference.map((row) => [Number(row.contact_crm_id), row]));

  const listCustomers: ListCustomer[] = customers.map((row) => {
    const customerId = String(row.id);
    const listType: PhoenixCrmListType = parseListType(row.list_type);
    const grade = parseGrade(row.grade);
    const visits = visitCounts.get(customerId) ?? 0;
    // A pharmacy carries no grade target, so there is nothing to ask for and nothing to show.
    const doctorType = doctorListType(row.list_type);
    const target = doctorType === null ? null : gradeTarget(viewer.config.settings, doctorType, grade);
    const pending = pendingByCustomer.get(customerId);
    // His validation check and, where the last one was turned down, the one sentence about his photo.
    const check = locationChecks.get(customerId) ?? null;
    const droppedReason = text(row.dropped_reason);
    const validatedBy = text(row.validated_by_hr_id);
    const contactCrmId = numberOrNull(row.reference_contact_crm_id);
    const referenceRow = contactCrmId === null ? undefined : referenceByContact.get(contactCrmId);
    const primaryPharmacyName = text(row.primary_pharmacy_name);
    const primaryKey = primaryPharmacyName ? normalizePharmacyName(primaryPharmacyName) : null;
    const pharmacies = (pharmaciesByCustomer.get(customerId) ?? [])
      .map((pharmacy) => ({ ...pharmacy, isPrimary: primaryKey !== null && normalizePharmacyName(pharmacy.name) === primaryKey }))
      .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary) || right.lastFeedbackAt.localeCompare(left.lastFeedbackAt));
    const status = customerStatusOf(row.status);
    const origin = row.origin === "new" ? "new" : "reference";
    const validatedAt = text(row.validated_at);
    const intakeTimings = mapTimings(row.intake_timings);
    return {
      customerId,
      listType,
      name: String(row.name),
      speciality: text(row.speciality),
      grade,
      origin,
      referenceContactCrmId: contactCrmId,
      status,
      section: listSectionOf({ status, origin, validatedAt, listType: row.list_type }),
      potentialGrade: parsePotentialGrade(row.potential_grade),
      validatedAt,
      validatedByName: validatedBy ? nameOf(names, validatedBy) : null,
      reference: referenceRow
        ? {
            address: referenceRow.address,
            city: referenceRow.city,
            zone: referenceRow.zone,
            lastVisitedOn: referenceRow.last_visited_on,
            brickId: referenceRow.brick_id,
            brickName: referenceRow.brick_id ? (referenceBrickMeta.get(referenceRow.brick_id)?.brickName ?? null) : null,
            areaName: referenceRow.brick_id ? (referenceBrickMeta.get(referenceRow.brick_id)?.areaName ?? null) : null,
          }
        : null,
      // What the SFE wrote for the rep when he loaded this list from a sheet. Null for every customer
      // who did not arrive that way, which is nearly all of them.
      intake:
        text(row.intake_where) || text(row.intake_note) || intakeTimings.length
          ? { note: text(row.intake_note), where: text(row.intake_where), timings: intakeTimings.length ? intakeTimings : null }
          : null,
      droppedReason: archiveReasonLabel(droppedReason) ?? dropReasonLabel(droppedReason) ?? droppedReason,
      droppedNote: text(row.dropped_note),
      statusChangedAt: String(row.status_changed_at),
      places: placesByCustomer.get(customerId) ?? [],
      visitsThisMonth: visits,
      target,
      tier: coverageTier(visits, target),
      pendingGradeRequestId: pending?.grade?.requestId ?? null,
      pendingGrade: pending?.grade?.proposedGrade ?? null,
      pendingDropRequestId: pending?.drop?.requestId ?? null,
      waiting: Object.values(pending ?? {}).map((request) => ({
        requestId: request.requestId,
        kind: request.kind,
        stage: request.stage,
        stageLabel: request.stageLabel,
      })),
      // A turned-down check matters only while he still waits to be validated; once validated it is history.
      locationCheck: ((state) => (state === "not_confirmed" && status !== "pending" ? null : state))(check?.state ?? null),
      // 🔴 THE SAME ONE-LINER, DELIBERATELY: both of these are "while he still waits", and nothing in
      // SQL ever clears `reopened_at` — six writers would each need a clearing clause and one of them
      // would forget. The stamp stays on the row for the owner's board; the LIST simply stops carrying
      // it once the customer is validated again.
      reopenedAt: status === "pending" ? text(row.reopened_at) : null,
      validateAgainReason: status === "pending" ? (check?.reason ?? null) : null,
      // Unlike the two lines above, a comment is NOT "while he still waits": it was written to him
      // about this customer and it stays readable after the place is validated. Nothing clears it.
      notes: repNotes.get(customerId) ?? [],
      primaryPharmacyName,
      phone: text(row.phone),
      pharmacyPin: mapPharmacyPin(row, names),
      pharmacies,
      sharedWith: null,
      observed: null,
      planPattern: null,
      referenceHistory: null,
    };
  });
  listCustomers.sort((left, right) => left.listType.localeCompare(right.listType) || left.name.localeCompare(right.name));

  // The mirror reads started beside the names above; a highlight they cannot give leaves the list whole.
  // Null when there is nobody to compare against (no occupant, or no reference customer on the list).
  try {
    const mirror = await mirrorReads;
    if (mirror) {
      const [sharedByContact, observedByContact, planDatesByContact, historyByContact] = mirror;
      for (const customer of listCustomers) {
        if (customer.referenceContactCrmId === null) continue;
        const shared = sharedByContact.get(customer.referenceContactCrmId) ?? null;
        customer.sharedWith = shared && shared.length > 0 ? shared : null;
        const point = observedByContact.get(customer.referenceContactCrmId) ?? null;
        customer.observed = point ? { address: point.address, at: point.at, agreed: point.agreed, lat: point.lat, lon: point.lon, total: point.total } : null;
        const pattern = planWeekdays(planDatesByContact.get(customer.referenceContactCrmId) ?? []);
        customer.planPattern = pattern.length > 0 ? pattern : null;
        customer.referenceHistory = historyByContact.get(customer.referenceContactCrmId) ?? null;
      }
    }
  } catch (error) {
    logError("Phoenix CRM list: the shared-customer and check-in reads could not run", {
      error,
      labels: { event: "phoenix_crm_shared_customers_failed" },
    });
  }

  const referenceEntries: ListReferenceEntry[] = reference.map((row) => ({
    contactCrmId: Number(row.contact_crm_id),
    listType: row.list_type,
    grade: parseGrade(row.grade),
    name: row.name,
    speciality: row.speciality,
    address: row.address,
    city: row.city,
    zone: row.zone,
    lastVisitedOn: row.last_visited_on,
    state: row.state,
    customerId: row.customer_id,
    pendingDropRequestId: pendingDropByContact.get(Number(row.contact_crm_id))?.requestId ?? null,
  }));

  const summary = summarizeReadiness(referenceEntries.map((entry) => entry.state));
  const source = reference[0] ?? null;
  const ramadan = nextRamadan(viewer.cairoToday, viewer.config.ramadanOverrides);

  // 🔴 THROUGH THE BLIND SHAPER, LAST. The screen hid these measurements, and a field a browser receives
  // counts as shown even when React draws nothing from it: the rep receives none of them (Golden Rule #1)
  // and neither does any reader below the Super Admin and SFE (owner, 2026-10-02 — the distance only).
  return blindTerritoryList(viewer, {
    territory: describeTerritory(viewer.org, seat, names),
    isTest,
    canEdit: canWriteAsRep(viewer, seat, isTest),
    canValidateReference: canValidateReference(viewer, seat, isTest),
    canReview: canReviewTerritory(viewer, seat, isTest),
    canMovePlaces: canMovePlaces(viewer, seat, isTest),
    canSeatInVenue: canDecideSharedPlaces(viewer),
    seesMeasurements: readsLocationDetail(viewer),
    canBringBack: canDecideListRequest(viewer, seat, isTest, "sfe"),
    canCurateList: canCurate,
    moveTargets: targetSeats
      .map((entry) => ({
        seatId: entry.seatId,
        lineCode: entry.lineCode as string,
        lineName: entry.lineName,
        territoryName: territoryName(entry),
        repName: entry.occupantHrId ? nameOf(names, entry.occupantHrId) || null : null,
      }))
      // The line first, then the rep: the picker is read down a line, and a vacant seat sorts by its
      // own territory rather than to the top of the list.
      .sort(
        (left, right) =>
          (left.lineName ?? "").localeCompare(right.lineName ?? "") ||
          (left.repName ?? left.territoryName).localeCompare(right.repName ?? right.territoryName),
      ),
    readiness: { ...summary, ready: summary.ready || Boolean(storedReadyAt), readyAt: storedReadyAt },
    referenceSource: source ? { name: nameOf(names, source.source_hr_id, "") || null, isCurrent: source.source_is_current } : null,
    reference: referenceEntries,
    customers: listCustomers,
    requests,
    monthStart,
    rules: { weakGpsMeters: viewer.config.settings.weakGpsMeters, placesMax: PHOENIX_CRM_PLACES_MAX },
    ramadan: ramadan ? { startsOn: ramadan.startsOn, endsOn: ramadan.endsOn } : null,
  });
}

// ── Writing ─────────────────────────────────────────────────────────────────────────────────────

function lineCodeOf(seat: OrgSeat): string {
  if (!seat.lineCode) throw validationError("This territory has no line in the organogram, so its list cannot be changed.");
  return seat.lineCode;
}

/**
 * The place as the database function reads it — the whole location resolved HERE, from the captured
 * coordinates, and never taken from the phone.
 *
 * Owner, 2026-09-23: "the capture location is never editable and its separated when captured to brick
 * area region clean addresss and raw location". Five things, and each is written once:
 *
 *   - **raw location** — `lat`, `lon`, `accuracy_meters`, and the phone's clock compared with ours;
 *     the coordinates the camera reported, untouched;
 *   - **clean address** — Google's own formatted address for that point, read here through the same
 *     `resolveEvidenceLocation` the photo's watermark uses, so the address ON the picture and the
 *     address in the row are one lookup and cannot disagree;
 *   - **brick**, **area**, **region** — the Phoenix territory the point physically fell in, from the
 *     nearest brick centroid, with the distance that justifies it kept beside them. A match further
 *     than `BRICK_TRUST_KM` names no brick at all rather than a fabricated neighbouring one, and the
 *     distance is stored either way: a wrong brick is only ever visible in that number.
 *
 * Before this the phone sent `address`, `zone` and `brick` and the row took them as given, so the
 * evidence of where a customer is could be typed over on the way. It cannot now: `PlaceDraft` no
 * longer carries them, and nothing on this path reads the body for a location.
 *
 * Owner, 2026-09-29: the place is captured with TWO readings — the Capture-location pin and the
 * photo's own shutter reading — and "the photo + the location of photo is the more trustable". So
 * the location above is resolved from `placePoint` (the photo's reading, else the pin), `lat`/`lon`
 * hold that fixed point, and both raw readings are stored beside it for good.
 */
async function placePayload(place: PlaceDraft, seat: OrgSeat): Promise<Row> {
  const point = placePoint(place);
  const [issuedAt, located] = await Promise.all([photoSlotIssuedAt(place.photoPath), resolvePlaceLocation(point, territoryOfSeat(seat))]);
  return {
    photo_path: place.photoPath,
    lat: point.lat,
    lon: point.lon,
    accuracy_meters: point.accuracyMeters,
    point_source: point.source,
    pin_lat: place.lat,
    pin_lon: place.lon,
    pin_accuracy_meters: place.accuracyMeters,
    photo_lat: place.photoLat,
    photo_lon: place.photoLon,
    photo_accuracy_meters: place.photoAccuracyMeters,
    photo_captured_at: place.photoCapturedAt,
    device_skew_minutes: issuedAt ? deviceClockSkewMinutes(place.deviceCapturedAt, new Date(issuedAt)) : null,
    label: place.label,
    ...located,
    timings: place.timings,
  };
}

/**
 * The pin as the database takes it: the rep's one reading, plus the geography resolved from it.
 *
 * The owner asked for a pinned pharmacy to arrive "cleaned and separated into area, brick,
 * government" (2026-10-09), so the geography is resolved HERE, on the server, from the coordinate
 * alone — the phone sends a position and nothing else, and no client can name a brick, an area or a
 * governorate of its own. A pharmacy's pin is a RECORD, not a check: nothing is refused, flagged,
 * approved or scored against it (a pharmacy needs no validation), and a reading that resolves to no
 * brick is still saved, with `brick_lookup` saying which kind of nothing it was.
 */
async function resolvePharmacyPinPayload(pin: PharmacyPinDraft, seat: OrgSeat): Promise<Row> {
  const geo = await resolvePinGeography(pin, territoryOfSeat(seat));
  return {
    lat: pin.lat,
    lon: pin.lon,
    accuracy_meters: pin.accuracyMeters,
    captured_at: pin.capturedAt,
    address: geo.address,
    governorate: geo.governorate,
    area_code: geo.areaCode,
    area_name: geo.areaName,
    brick_id: geo.brickId,
    brick_name: geo.brickName,
    brick_distance_km: geo.brickDistanceKm,
    brick_lookup: geo.brickLookup,
  };
}

/**
 * Judge the position a place was captured at, once the place is safely on file.
 *
 * Separate from `placePayload` on purpose: that function builds what gets SAVED, and nothing about
 * this check may ever influence that. This runs afterwards, writes only to the private integrity
 * table, returns nothing and throws nothing — a rep validating a customer sees no difference at all.
 *
 * TWO detectors run here, under two different `source` values so neither can replace the other's
 * verdict: `judgeCapture` on the fixed point against the rep's history, and (since 2026-10-08)
 * `filePlaceCaptureTrust` on the place's own TWO readings against EACH OTHER — the one comparison
 * nothing in this module had ever made.
 */
async function judgeCaptureForPlace(
  viewer: PhoenixCrmViewer,
  seatId: string,
  isTest: boolean,
  placeId: string,
  customerId: string,
  capturedAtText: string,
  place: PlaceDraft,
): Promise<void> {
  const capturedAt = new Date(capturedAtText);
  if (Number.isNaN(capturedAt.getTime())) return;
  // 🔴 THE FIXED POINT, not the pin (owner, 2026-09-29 — "the photo + the location of photo is the
  // more trustable"). `placePayload` stores `placePoint` as the place's own lat/lon and every later
  // visit is measured against it; until 2026-10-02 this judged `place.lat`/`place.lon` instead, so a
  // place whose PHOTO reading was spoofed was judged on its honest pin, and a coordinate replayed
  // into the stored point was never compared against because the detectors never saw that point.
  const point = placePoint(place);
  await judgeCapture({
    subjectKind: "place",
    subjectId: placeId,
    seatId,
    repHrId: viewer.hrId,
    customerId,
    isTest,
    fix: { lat: point.lat, lon: point.lon, accuracyMeters: point.accuracyMeters, capturedAt },
    deviceMocked: place.deviceMocked,
    readerReplaced: place.readerReplaced ?? null,
    readerFindings: place.readerFindings ?? [],
  });
  // The photo's reading against the pin's. 🔴 EACH READING WAS ONLY EVER CHECKED AGAINST ITS OWN
  // CEILING, so three live active places sit with their two readings 687 m, 869 m and 1,553 m apart,
  // both individually "precise" and the gap unmeasured. A flag, never a refusal and never a hold: a
  // rep does not choose which of his two readings drifted, and the shutter's fix is taken once with
  // no retry. It has its OWN catch inside, so it can never turn a saved place into a 500.
  await filePlaceCaptureTrust({
    customerId,
    fixed: { lat: point.lat, lon: point.lon, accuracyMeters: point.accuracyMeters, capturedAt },
    isTest,
    photoFix: {
      accuracyMeters: place.photoAccuracyMeters,
      capturedAt: place.photoCapturedAt,
      latitude: place.photoLat,
      longitude: place.photoLon,
    },
    pinFix: {
      accuracyMeters: place.accuracyMeters,
      capturedAt: place.pinCapturedAt,
      latitude: place.lat,
      longitude: place.lon,
    },
    placeId,
    repHrId: viewer.hrId,
    seatId,
  });
}

export type ValidateResult = {
  customerId: string;
  customerName: string;
  listType: PhoenixCrmListType;
  placeId: string;
  capturedAt: string;
  restored: boolean;
  /** Kept for a caller one release behind: the request a new customer raised. Same as `requestId`. */
  gradeRequestId: string | null;
  /** Where the customer stands now: on the list, or waiting outside it. */
  status: PhoenixCrmCustomerStatus;
  /** The request this validation raised — an add for "Add new customer", a bring-back — if any. */
  requestId: string | null;
  requestKind: PhoenixCrmRequestKind | null;
  /**
   * Saved but NOT validated: Google has no listing the system is sure is this account, so the place
   * waits for the Super Admin (owner, 2026-10-03). The rep reads it as the system checking.
   */
  held: boolean;
};

/**
 * The customer a validation names, as the Google check needs him: the name ON THE LIST (never the
 * place label the rep typed — google-place-rules.ts), AM / PM / pharmacy, and his own row id where he
 * has one — `null` for "Add new customer" and for someone met outside the list, who has no row yet and
 * so nothing a refusal can be counted against.
 */
type ValidationSubject = { name: string; listType: PhoenixCrmListType; customerId: string | null };

/** Resolves that subject for the mode the rep is saving in. */
async function validationSubject(seatId: string, isTest: boolean, mode: string, body: Row): Promise<ValidationSubject | null> {
  if (mode === "reference") {
    const contact = Number(body.referenceContactCrmId);
    const entry = (await loadReference(seatId, isTest)).find((row) => Number(row.contact_crm_id) === contact);
    if (!entry) return null;
    // 🔴 The customer's OWN row id, which the carried-over list does not carry: a refusal is counted
    // against it (`countOffListingRefusals`), and without it a rep refused on an account whose pin has
    // moved would be refused again for ever. A carried-over customer HAS a row — status `pending`
    // until he is validated — so this finds one for every entry the seat is still to validate.
    const customerId = await customerIdForReference(seatId, isTest, contact);
    return { name: String(entry.name), listType: parseListType(entry.list_type), customerId };
  }
  if (mode === "listed") {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_customers")
      .select("id, name, list_type")
      .eq("id", String(body.customerId))
      .eq("seat_id", seatId)
      .eq("is_test", isTest)
      .maybeSingle();
    throwIfError(error);
    const row = data as Row | null;
    return row ? { name: String(row.name), listType: parseListType(row.list_type), customerId: String(row.id) } : null;
  }
  return null;
}

/** The seat's own row for a carried-over contact, if it has one yet. Null is never an error here. */
async function customerIdForReference(seatId: string, isTest: boolean, contactCrmId: number): Promise<string | null> {
  if (!Number.isFinite(contactCrmId)) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_customers")
    .select("id")
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .eq("reference_contact_crm_id", contactCrmId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[phoenix-crm] reference customer id not read", { seatId, message: error.message });
    return null;
  }
  const row = (data ?? null) as Row | null;
  return row ? String(row.id) : null;
}

/**
 * The Google Maps check, before anything is written (owner, 2026-10-03). A mismatch is REFUSED here, at
 * the door; a match or a hold is handed to the database with its evidence. Null for a customer the check
 * does not cover (a doctor's clinic, a pharmacy) or one this read could not name.
 *
 * 🔴 THE FIRST MISMATCH IS REFUSED AND RECORDED; THE SECOND ON THE SAME ACCOUNT IS HELD, NOT REFUSED
 * AGAIN (`mismatchIsHeld`). A rep at the wrong door walks to the right one and passes on his next
 * capture, so he never reaches the Super Admin's board; a rep standing at an account that MOVED cannot
 * pass by standing anywhere, and before this his only ways out were a duplicate add request — refused
 * by this same gate — or an out-of-list visit that scores in nothing. A hold is not a pass: the place
 * is saved and NOT validated until the Super Admin decides it himself.
 */
async function googleCheckForSave(
  subject: ValidationSubject | null,
  place: PlaceDraft,
  who: { seatId: string; repHrId: string; isTest: boolean },
): Promise<{ check: GooglePlaceCheck; record: Row } | null> {
  if (!subject) return null;
  const point = placePoint(place);
  const check = await checkPlaceOnGoogle({ customerName: subject.name, listType: subject.listType, point });
  if (!check) return null;
  if (check.verdict.kind === "mismatch") {
    const priorRefusals = await countOffListingRefusals({ ...who, customerId: subject.customerId });
    if (!mismatchIsHeld(priorRefusals)) {
      // Recorded BEFORE the refusal is thrown, and awaited: an unawaited insert can die with the
      // serverless invocation, and this row is what lets his next attempt through.
      await recordOffListingRefusal({ ...who, customerId: subject.customerId, place });
      throw validationError(googleMismatchMessage(subject.name));
    }
  }
  return { check, record: googleCheckRecord(check, point) };
}

/**
 * Read the signboard in the photo the rep is saving, and say whether it names this customer.
 *
 * 🔴 AWAITED IN THE REQUEST, NOT AFTER THE SAVE, and there is no alternative. `held` is set at the
 * INSERT; the only route back from a validated customer retires the place and re-measures every visit
 * on it; and `phoenix_crm_validation_reviews_place_idx` is UNIQUE on `place_id`, so an automatic
 * post-save hold would consume the Super Admin's one review slot for that place. The rep would read
 * "validated" and, seconds later, "Validate again".
 *
 * 🔴 AFTER THE GOOGLE GATE, ALSO ON PURPOSE. A Google mismatch THROWS above, so a validation refused
 * at the door never pays for a model call; and a place Google already holds returns
 * `held_elsewhere` without making one, because a second reason to hold the same place buys nothing —
 * there is one review row and one decision.
 *
 * Returns null when the question does not apply at all: a pharmacy is not validated against a person
 * or a practice (`signboardApplies`), and a one-token name is not evidence of anything
 * (`signboardNameIsUsable`). Nothing is recorded in that case, and the nightly sweep's own read
 * excludes pharmacies for the same reason rather than picking them up for ever.
 */
async function signboardCheckForSave(
  subject: ValidationSubject | null,
  place: PlaceDraft,
  who: { seatId: string; repHrId: string; isTest: boolean },
  heldElsewhere: boolean,
): Promise<{ check: PhoenixCrmSignboardCheck; record: Row } | null> {
  if (!subject || !signboardApplies(subject.listType) || !signboardNameIsUsable(subject.name)) return null;
  const point = placePoint(place);
  const check = heldElsewhere
    ? signboardUnjudged("held_elsewhere")
    : await readPlaceSignboard({
        customerName: subject.name,
        isTest: who.isTest,
        listType: subject.listType,
        photoPath: place.photoPath,
        repHrId: who.repHrId,
        seatId: who.seatId,
      });
  return { check, record: signboardHoldRecord(check, point) };
}

/**
 * Validate a customer at the door: a live signboard photo, the two location readings and his days and
 * hours, once and for good. Three modes:
 *
 *   reference — a customer carried over from iReports360 goes on the list (refused for one in the Archive);
 *   new       — "Add new customer": he waits outside the list, and the add request (district manager
 *               with the A/B/C grade and the potential, then SFE) is filed at once;
 *   outside   — met on an out-of-list visit: he waits outside the list and the rep chooses later —
 *               "Request to add" or "Drop".
 *
 * 🔴 THERE WAS A FOURTH, `restore`, AND IT IS RETIRED — IT WAS A HOLE THROUGH THE FROZEN ARCHIVE. It
 * was "kept for a caller that still sends a fresh place with Bring back", and no caller sends it: the
 * web, the out-of-list entry and the phone all send `reference`, `new` or `outside`, and bringing a
 * customer back is a REQUEST (the district manager, then SFE) that goes nowhere near this function. What
 * it did do, for anybody who posted the shape by hand, was insert an ACTIVE place onto a customer sitting
 * in the Archive — no status check, and outside the five-clinic cap `addPlace` enforces. The Archive is
 * frozen, so a mode that writes into it is refused here and in `phoenix_crm_validate_customer`.
 */
export async function validateCustomer(viewer: PhoenixCrmViewer, raw: unknown): Promise<ValidateResult> {
  const body = record(raw);
  // A manager of the territory validates a CARRIED-OVER customer beside its rep (owner, 2026-10-02),
  // and nothing else here: the three other modes file a request whose first step is the territory's
  // reviewer, and that is him (`territoryForValidation`).
  const { seat, isTest, validatedAs } = territoryForValidation(viewer, body.seatId, readTestFlag(body.test));
  const lineCode = lineCodeOf(seat);
  // 🔴 A SEATING IN A POLYCLINIC IS THE SAME ACT WITH A DIFFERENT DOOR (owner, 2026-10-09): the venue
  // was captured once at its own door, so this customer brings a TIMETABLE photo and his hours and no
  // location at all — `body.seated` instead of `body.place`. Everything below is shared: the mode, the
  // phone, the request a `new` or `outside` customer files, the notice, the restamp.
  const seated = seatedDraftOf(body);
  const venue = seated ? await sharedPlaceForSeating({ seatId: seat.seatId, isTest, sharedPlaceId: seated.sharedPlaceId }) : null;
  let place: PlaceDraft | null = null;
  if (!seated) {
    const parsed = parsePlaceDraft(body.place);
    if (!parsed.ok) {
      // The reading survives the refusal (owner, 2026-10-03). Silent, void, and never throwing: the
      // rep reads exactly the refusal below, whether or not this lands.
      await recordRefusedReading({
        subjectKind: "place",
        raw: body.place,
        seatId: seat.seatId,
        repHrId: viewer.hrId,
        // Absent on `new` and `outside`, where no customer has been chosen yet. That is legitimate and
        // must not cost the row — the reading is about the phone, not about the customer.
        customerId: isUuid(body.customerId) ? String(body.customerId).toLowerCase() : null,
        isTest,
      });
      throw validationError(parsed.error);
    }
    place = parsed.value;
  }
  // Optional, and written in the same save as the validation (owner, 2026-09-30) — never a second
  // step that could fail after the first one landed.
  const phone = parseCustomerPhone(body.phone);
  if (!phone.ok) throw validationError(phone.error);

  const payload: Row = {
    seat_id: seat.seatId,
    line_code: lineCode,
    actor_hr_id: viewer.hrId,
    is_test: isTest,
    phone: phone.value,
    // Where a two-step request starts is read from the organogram, never from the phone: a territory
    // with no manager seat above it begins at SFE, as an off-plan visit's approval does.
    first_stage: firstRequestStage(territoryReviewer(viewer.org, seat.seatId) !== null),
  };
  let proposedGrade: PhoenixCrmGrade | null = null;
  const mode = String(body.mode ?? "");
  // A manager validates a customer who is ALREADY ON THE LIST, and nothing else: carried over from
  // iReports360 (`reference`) or loaded from the SFE's sheet (`listed`, added on the owner's answer of
  // 2026-10-03, asked directly). Both are the same act — somebody else admitted him and graded him, and
  // what is left is the door. `new` and `outside` are excluded for the reason they always were: they
  // FILE A REQUEST whose first step is the territory's reviewer, and that is him, so he would propose
  // and approve in one act. Without `listed` here, a VACANT seat's loaded list could be worked through
  // by nobody at all, which is the hole this screen exists to close.
  if (validatedAs === "manager" && mode !== "reference" && mode !== "listed") {
    throw forbiddenError(
      "A manager validates a customer already on the list. Adding a customer, or one met outside the list, is the rep's — the request it files is yours to decide.",
    );
  }
  if (mode === "reference") {
    const contact = Number(body.referenceContactCrmId);
    if (!Number.isSafeInteger(contact) || contact <= 0) throw validationError("Choose the customer from your reference list.");
    payload.mode = "reference";
    payload.reference_contact_crm_id = contact;
  } else if (mode === "listed") {
    // A customer the SFE loaded from a sheet: already on the list, already graded by him, and carrying
    // no iReports360 contact at all — so `reference` above can never reach him, and he is validated at
    // the door exactly like a carried-over one.
    //
    // 🔴 WITHOUT THIS ARM THE WHOLE LIST TEMPLATE IS DEAD. The screen sends `listed`, the SQL has had
    // its `listed` branch since 20261003000753, and this service fell through to "Reload the page and
    // try again." — so every loaded customer sat in To validate for ever and could never have his
    // photo and location captured. Nothing was red: the screen and the SQL were each pinned on their
    // own, and no test walked the chain between them. Found in review, 2026-10-03.
    if (!isUuid(body.customerId)) throw validationError("Choose the customer from your list.");
    payload.mode = "listed";
    payload.customer_id = body.customerId;
  } else if (mode === "new") {
    const draft = parseNewCustomer(body.customer);
    if (!draft.ok) throw validationError(draft.error);
    proposedGrade = draft.value.proposedGrade;
    Object.assign(payload, {
      mode: "new",
      name: draft.value.name,
      list_type: draft.value.listType,
      speciality: draft.value.speciality,
      proposed_grade: draft.value.proposedGrade,
      allow_same_name: body.allowSameName === true,
    });
  } else if (mode === "outside") {
    const draft = parseOutsideCustomer(body.customer);
    if (!draft.ok) throw validationError(draft.error);
    Object.assign(payload, {
      mode: "outside",
      name: draft.value.name,
      list_type: draft.value.listType,
      speciality: draft.value.speciality,
      allow_same_name: body.allowSameName === true,
    });
  } else {
    throw validationError("Reload the page and try again.");
  }
  // The owner's two steps (2026-10-03), before anything is written: is the Google listing this account,
  // and did he stand at it. A mismatch throws here; a hold is saved but not validated.
  const subject =
    mode === "new" || mode === "outside"
      ? { name: String(payload.name), listType: parseListType(payload.list_type), customerId: null }
      : await validationSubject(seat.seatId, isTest, mode, body);
  let signboard: { check: PhoenixCrmSignboardCheck; record: Record<string, unknown> } | null = null;
  let schedule: PhoenixCrmScheduleCheck | null = null;
  if (seated && venue) {
    // Which photograph this seating is saved against: the one he just took, or the BUILDING's own
    // board, already on file (owner, 2026-10-10 — "ask him for only one timetable, not for every
    // doctor"). It is read from the VENUE, never from the body, and it is the same value
    // `seatedPlacePayload` writes to the row.
    const seatedPhoto = effectiveSeatedPhoto(venue, seated);
    // 🔴 NEITHER GOOGLE NOR THE SIGNBOARD RUNS ON A SEATING, and that is the design rather than a gap.
    // Both are judged against the customer's own name at HIS door: the Google check asks whether the
    // listing at this point is him, and the signboard asks whether the sign names him. Inside a
    // polyclinic the listing and the sign are the BUILDING's, so both would refuse every customer for
    // the exact reason this feature exists. His evidence is the TIMETABLE — the one thing at that door
    // that does name him — and the administrator's review is the human gate behind it (owner,
    // 2026-10-09: "even if no Google check, he must validate by a live photo and location", the
    // location being the venue's, taken once).
    //
    // `signboardNameIsUsable` is the SAME guard the signboard read is given, deliberately: a name too
    // short or too generic to match ("Dr", a single initial) would be judged against a wall of forty
    // names and could only produce noise. `signboardApplies` is NOT applied — that one answers the
    // owner's AM/PM rule about whose name a SIGN carries, and a timetable names people whatever list
    // the customer is on.
    //
    // 🔴 THE READ STILL RUNS PER CUSTOMER, on the one shared image: the question is "does this board
    // name HIM", so three doctors behind one door are three different questions about the same
    // photograph — and each one's verdict is kept on his own row.
    schedule =
      subject && signboardNameIsUsable(subject.name)
        ? await readPlaceSchedule({
            customerName: subject.name,
            isTest,
            photoPath: seatedPhoto.path,
            repHrId: viewer.hrId,
            reusedTimetable: seatedPhoto.reused,
            seatId: seat.seatId,
          })
        : null;
    // A timetable that confidently names somebody else, or holds no timetable at all, rides the SAME
    // atomic `hold_review` a Google or signboard hold rides: the customer stays under To validate, one
    // review row is raised for the administrator, and the rep reads only that the system is checking.
    // 🔴 `unjudged` NEVER holds: see scheduleHoldsForReview.
    if (schedule && scheduleHoldsForReview(schedule)) {
      payload.hold_review = scheduleHoldRecord(schedule, {
        lat: venue.lat,
        lon: venue.lon,
        name: venue.name,
        sharedPlaceId: venue.sharedPlaceId,
      });
    }
    payload.place = await seatedPlacePayload(venue, seated);
  } else if (place) {
    const google = await googleCheckForSave(subject, place, { seatId: seat.seatId, repHrId: viewer.hrId, isTest });
    if (google?.check.verdict.kind === "match") payload.google = google.record;
    else if (google) payload.hold_review = google.record;
    // The owner's third step, 2026-10-08: and does the signboard in the photo name this customer. A
    // confident negative rides the SAME `hold_review` the Google hold rides, so the already-atomic hold
    // path does all of it — the customer stays under To validate, one review row is raised, and the rep
    // reads only that the system is checking. 🔴 `unjudged` NEVER holds: see signboardHoldsForReview.
    signboard = await signboardCheckForSave(subject, place, { seatId: seat.seatId, repHrId: viewer.hrId, isTest }, payload.hold_review !== undefined);
    if (signboard && payload.hold_review === undefined && signboardHoldsForReview(signboard.check)) {
      payload.hold_review = signboard.record;
    }
    payload.place = await placePayload(place, seat);
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_validate_customer", { p: payload });
  const requestKind = text(result.request_kind);
  const validated: ValidateResult = {
    customerId: String(result.customer_id),
    customerName: String(result.customer_name),
    listType: parseListType(result.list_type),
    placeId: String(result.place_id),
    capturedAt: String(result.captured_at),
    restored: result.restored === true,
    gradeRequestId: text(result.grade_request_id),
    status: customerStatusOf(result.status),
    requestId: text(result.request_id),
    requestKind: requestKind ? requestKindOf(requestKind) : null,
    held: result.held === true,
  };
  if (validated.held && !isTest) {
    await notifyValidationReviewWaiting({ customerName: validated.customerName, seat, repHrId: viewer.hrId, reviewId: text(result.review_id) });
  }
  // A validated place is the reference point every later visit to this customer is measured against,
  // so a spoof here is worth more to a cheat than a spoofed visit — one fake pin makes a year of
  // visits read "ok". Judged after the save, silently, exactly as a visit is.
  //
  // 🔴 A SEATING IS NOT JUDGED HERE, AND SKIPPING IT IS CORRECT RATHER THAN A HOLE. Both detectors
  // compare READINGS: `judgeCapture` the fixed point against this rep's own history, and
  // `filePlaceCaptureTrust` the pin against the photo's reading. A seated row has neither — its point
  // was copied from the venue, which WAS judged when the rep captured it at the door. Judging it again
  // would file one venue's single capture once per customer seated in it and read as a cluster.
  if (place) {
    await judgeCaptureForPlace(viewer, seat.seatId, isTest, validated.placeId, validated.customerId, validated.capturedAt, place);
  }
  // What the timetable said, kept on the seated row for every seating and not only the held ones — the
  // same reason the signboard verdict is kept below.
  if (schedule) await recordPlaceSchedule(validated.placeId, schedule);
  // The verdict is kept on the place row for EVERY place and not only the held ones, so "how many
  // validated places has the system actually read the sign of" is a query rather than 643 photographs
  // eyeballed by hand. A plain update, deliberately outside the RPC's transaction: the verdict is a
  // RECORD and the gate is `hold_review`, which the RPC already writes atomically with the row.
  if (signboard) await recordPlaceSignboard(validated.placeId, signboard.check);
  // He validated again, so the "could not be confirmed" notice about his last photo is withdrawn —
  // never left in his bell after the thing it asked for is done.
  if (!validated.held && !isTest) await withdrawValidationNotConfirmed(validated.customerId);
  // His visits from before he had a place get their distance now (owner, 2026-09-29). Never the rep's
  // to see; the managers' place-vs-actual report reads it.
  await restampVisitLocationsQuietly({
    seatId: seat.seatId,
    isTest,
    customerId: validated.customerId,
    actorHrId: viewer.hrId,
    settings: viewer.config.settings,
    scope: "unplaced",
  });
  if (validated.requestId && validated.requestKind) {
    await notifyRequestRaised(viewer, seat, isTest, {
      requestId: validated.requestId,
      requestKind: validated.requestKind,
      stage: payload.first_stage as PhoenixCrmRequestStage,
      customerName: validated.customerName,
      listType: validated.listType,
      proposedGrade,
      dropReason: null,
    });
  }
  return validated;
}

/**
 * Tell the district manager a request is waiting for him. The SFE step has no push of its own — the
 * SFE Manager holds no seat to address — and shows through the Team tab's counter instead.
 */
async function notifyRequestRaised(
  viewer: PhoenixCrmViewer,
  seat: OrgSeat,
  isTest: boolean,
  request: {
    requestId: string;
    requestKind: PhoenixCrmRequestKind;
    stage: PhoenixCrmRequestStage | null;
    customerName: string;
    listType: PhoenixCrmListType;
    proposedGrade: PhoenixCrmGrade | null;
    dropReason: string | null;
  },
): Promise<void> {
  if (request.stage === "sfe") return;
  await notifyPhoenixCrm(
    {
      kind: "request_created",
      org: viewer.org,
      seat,
      requestId: request.requestId,
      requestKind: request.requestKind,
      requesterHrId: viewer.hrId,
      customerName: request.customerName,
      listType: request.listType,
      proposedGrade: request.proposedGrade,
      dropReason: request.dropReason,
    },
    isTest,
  );
}

/**
 * The customer's name, speciality and phone, changed later.
 *
 * Owner, 2026-09-22: validating is the three captures and nothing else — "later can change his name,
 * can change his grade". The grade keeps its proposal flow (the district manager decides it, because it
 * sets the rep's own target); the name and speciality are the rep's own to correct. The territory's rep
 * only, and never on a customer that has left the list.
 *
 * Owner, 2026-09-30: the phone is corrected here too ("Yes, in Change the details"). It moves only when
 * the body carries the key — sent empty it clears the phone — so a caller one release behind, which
 * never sends it, leaves the phone exactly as it was.
 */
export async function renameCustomer(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ customerId: string; customerName: string; speciality: string | null; phone: string | null }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  if (!isUuid(body.customerId)) throw validationError("Choose the customer to change.");
  const name = cleanText(body.name, CUSTOMER_NAME_MAX);
  if (!name || name.length < 3) throw validationError("Write the customer's full name.");
  const phone = Object.prototype.hasOwnProperty.call(body, "phone") ? parseCustomerPhone(body.phone) : null;
  if (phone && !phone.ok) throw validationError(phone.error);
  const result = await callPhoenixCrm<Row>("phoenix_crm_rename_customer", {
    p: {
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      customer_id: String(body.customerId).toLowerCase(),
      name,
      speciality: cleanText(body.speciality, 80),
      allow_same_name: body.allowSameName === true,
      ...(phone?.ok ? { phone: phone.value } : {}),
    },
  });
  return {
    customerId: String(result.customer_id),
    customerName: String(result.customer_name),
    speciality: text(result.speciality),
    phone: text(result.phone),
  };
}

/**
 * Pin one pharmacy as this doctor's primary, or clear it (an empty name clears). The name is a
 * free-text pharmacy the rep chose from the ones his feedback already named; the territory's rep only,
 * and never on a customer that has left the list.
 */
export async function setPrimaryPharmacy(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ customerId: string; primaryPharmacyName: string | null }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  if (!isUuid(body.customerId)) throw validationError("Choose the customer to change.");
  const result = await callPhoenixCrm<Row>("phoenix_crm_set_primary_pharmacy", {
    p: {
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      customer_id: String(body.customerId).toLowerCase(),
      pharmacy_name: cleanText(body.pharmacyName, PHARMACY_NAME_MAX),
    },
  });
  return { customerId: String(result.customer_id), primaryPharmacyName: text(result.primary_pharmacy_name) };
}

/**
 * Add a pharmacy to his own list by its name (owner, 2026-10-03 — pharmacy-call-rules.ts rule 3d): no
 * photo, no hours, no request and no approval. The territory's rep only (the Super Admin in test mode),
 * from the List or from Add visit → Pharmacy visit (`from`).
 *
 * 🔴 ITS LOCATION AND ITS RESPONSIBLE PERSON'S PHONE ARE OPTIONAL EXTRAS, NOT A STEP (owner,
 * 2026-10-09). Both are saved in the SAME call as the name — never a second write that could fail
 * after the first one landed and leave a pharmacy whose pin went nowhere — and both are simply absent
 * for a rep who taps Add without touching them. The pin's geography is resolved here, on the server,
 * through the same resolver a doctor's place uses.
 *
 * The name is matched against his list FIRST, by its key and exactly (`matchAddedPharmacy`): one already
 * on it is handed back rather than added twice, and one in his Archive is refused with the way back. The
 * database repeats the exact-name check under a per-territory lock, so a double tap adds one pharmacy.
 */
export async function addPharmacy(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ customerId: string; customerName: string; created: boolean }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  const lineCode = lineCodeOf(seat);
  const problem = addedPharmacyNameProblem(typeof body.name === "string" ? body.name : null);
  if (problem) throw validationError(problem);
  const name = collapsePharmacyName(String(body.name));
  const phone = parseCustomerPhone(body.phone);
  if (!phone.ok) throw validationError(phone.error);
  const pin = parsePharmacyPin(body.pin);
  if (!pin.ok) throw validationError(pin.error);
  const match = matchAddedPharmacy(name, await loadListedPharmacies(seat.seatId, isTest));
  if (match.kind === "archived") {
    throw validationError(`${match.name} is in your Archive. Open it there to ask to bring it back to your list.`);
  }
  // Already his, and he captured nothing to go with it: hand it back without a write, exactly as before.
  // 🔴 WITH A PHONE OR A PIN IN HAND IT STILL GOES THROUGH, because dropping what the rep just captured
  // is the defect — the function fills ONLY the fields that are empty on it and overwrites neither.
  if (match.kind === "existing" && phone.value === null && pin.value === null) {
    return { customerId: match.customerId, customerName: match.name, created: false };
  }
  const result = await callPhoenixCrm<Row>("phoenix_crm_add_pharmacy", {
    p: {
      seat_id: seat.seatId,
      line_code: lineCode,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      name,
      from: body.from === "visit" ? "visit" : "list",
      // The row THIS match already found, Arabic-aware — so the database trusts it instead of
      // re-deriving "already on his list" from a weaker, case-only compare that reads "طاهر رمضان"
      // and "صيدلية طاهر رمضان" as two different pharmacies and would otherwise add one twice the
      // moment he also captures a pin or phone (the only path that still calls this function on an
      // "existing" match). Omitted when match.kind is "new", so the function's own name search runs.
      ...(match.kind === "existing" ? { existing_customer_id: match.customerId } : {}),
      // Omitted entirely when he captured nothing, so the function's own "a body with no phone and no
      // pin key does exactly what it did" path is the one that runs.
      ...(phone.value === null ? {} : { phone: phone.value }),
      ...(pin.value === null ? {} : { pin: await resolvePharmacyPinPayload(pin.value, seat) }),
    },
  });
  return { customerId: String(result.customer_id), customerName: String(result.customer_name), created: result.created === true };
}

/**
 * Set or correct a pharmacy's location and its responsible person's phone, on one already on his list
 * (owner, 2026-10-09). The pharmacy's own screen and the Pharmacy visit picker both call this.
 *
 * ABSENT MEANS LEAVE IT, NULL MEANS CLEAR IT — the same contract the phone on "Change the details"
 * already has, so a screen that sends only the phone can never blank a pin the rep captured yesterday.
 * The geography is resolved here from the coordinate, never read from the body.
 */
export async function setPharmacyDetails(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ customerId: string; customerName: string; phone: string | null; pinned: boolean }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  if (!isUuid(body.customerId)) throw validationError("Choose the pharmacy this belongs to.");
  const setsPhone = "phone" in body;
  const setsPin = "pin" in body;
  if (!setsPhone && !setsPin) throw validationError("Capture the pharmacy's location, or write the phone, then save.");
  const phone = parseCustomerPhone(body.phone);
  if (!phone.ok) throw validationError(phone.error);
  const pin = parsePharmacyPin(body.pin);
  if (!pin.ok) throw validationError(pin.error);
  const result = await callPhoenixCrm<Row>("phoenix_crm_set_pharmacy_details", {
    p: {
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      customer_id: String(body.customerId).toLowerCase(),
      // `null` is sent deliberately — it is how he clears one. The KEY is what says "set it".
      ...(setsPhone ? { phone: phone.value } : {}),
      ...(setsPin ? { pin: pin.value === null ? null : await resolvePharmacyPinPayload(pin.value, seat) } : {}),
    },
  });
  return {
    customerId: String(result.customer_id),
    customerName: String(result.customer_name),
    phone: text(result.phone),
    pinned: result.pinned === true,
  };
}

export async function addPlace(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ placeId: string; customerId: string; customerName: string; held: boolean }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  if (!isUuid(body.customerId)) throw validationError("Choose the customer this place belongs to.");
  const customerId = String(body.customerId).toLowerCase();
  // A customer already validated at his own clinic who ALSO receives in a polyclinic is seated in it
  // here, by the same route a first place takes. He legitimately ends with two places, which is what
  // the five-active cap in `phoenix_crm_add_place` has always allowed for.
  const seated = seatedDraftOf(body);
  const venue = seated ? await sharedPlaceForSeating({ seatId: seat.seatId, isTest, sharedPlaceId: seated.sharedPlaceId }) : null;
  let place: PlaceDraft | null = null;
  if (!seated) {
    const parsed = parsePlaceDraft(body.place);
    if (!parsed.ok) {
      // A second clinic's refused reading is filed exactly as the first one's is.
      await recordRefusedReading({
        subjectKind: "place",
        raw: body.place,
        seatId: seat.seatId,
        repHrId: viewer.hrId,
        customerId,
        isTest,
      });
      throw validationError(parsed.error);
    }
    place = parsed.value;
  }
  const subject = await validationSubject(seat.seatId, isTest, "listed", { customerId });
  let signboard: { check: PhoenixCrmSignboardCheck; record: Row } | null = null;
  let schedule: PhoenixCrmScheduleCheck | null = null;
  let matched: Row | null = null;
  let holdRecord: Row | null = null;
  if (seated && venue) {
    // Neither Google nor the signboard, for the reason `validateCustomer`'s seated branch records in
    // full: both are judged on the customer's name at HIS door, and this door is the building's.
    //
    // The timetable is the BUILDING's and is read from the venue, not from the body — the same rule,
    // and the same one call per customer against the one image.
    const seatedPhoto = effectiveSeatedPhoto(venue, seated);
    schedule =
      subject && signboardNameIsUsable(subject.name)
        ? await readPlaceSchedule({
            customerName: subject.name,
            isTest,
            photoPath: seatedPhoto.path,
            repHrId: viewer.hrId,
            reusedTimetable: seatedPhoto.reused,
            seatId: seat.seatId,
          })
        : null;
    if (schedule && scheduleHoldsForReview(schedule)) {
      holdRecord = scheduleHoldRecord(schedule, {
        lat: venue.lat,
        lon: venue.lon,
        name: venue.name,
        sharedPlaceId: venue.sharedPlaceId,
      });
    }
  } else if (place) {
    // Another clinic is checked against Google exactly as the first one is (owner, 2026-10-03). Held, it
    // is saved and waits for the Super Admin; the customer, already validated, is not touched.
    const google = await googleCheckForSave(subject, place, { seatId: seat.seatId, repHrId: viewer.hrId, isTest });
    // And its signboard is read exactly as the first one's is (2026-10-08) — a second doorway is a
    // second identification, not a free pass on the strength of the first.
    const googleHolds = google !== null && google.check.verdict.kind !== "match";
    signboard = await signboardCheckForSave(subject, place, { seatId: seat.seatId, repHrId: viewer.hrId, isTest }, googleHolds);
    holdRecord = googleHolds
      ? (google as { record: Row }).record
      : signboard && signboardHoldsForReview(signboard.check)
        ? signboard.record
        : null;
    if (google?.check.verdict.kind === "match") matched = google.record;
  }
  const result = await callPhoenixCrm<Row>("phoenix_crm_add_place", {
    p: {
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      customer_id: customerId,
      place: seated && venue ? await seatedPlacePayload(venue, seated) : await placePayload(place as PlaceDraft, seat),
      ...(matched ? { google: matched } : {}),
      ...(holdRecord ? { hold_review: holdRecord } : {}),
    },
  });
  const added = {
    placeId: String(result.place_id),
    customerId: String(result.customer_id),
    customerName: String(result.customer_name),
    held: result.held === true,
  };
  if (added.held && !isTest) {
    await notifyValidationReviewWaiting({ customerName: added.customerName, seat, repHrId: viewer.hrId, reviewId: text(result.review_id) });
  }
  // A second place is a second reference point, judged exactly as the first one is — unless it is a
  // seating, which carries no reading of its own to judge (`validateCustomer` records why in full).
  if (place) {
    const issuedAt = await photoSlotIssuedAt(place.photoPath).catch(() => null);
    if (issuedAt) await judgeCaptureForPlace(viewer, seat.seatId, isTest, added.placeId, added.customerId, issuedAt, place);
  }
  if (signboard) await recordPlaceSignboard(added.placeId, signboard.check);
  if (schedule) await recordPlaceSchedule(added.placeId, schedule);
  return added;
}

/**
 * Editing a place's timings and details (no new photo: the change is kept in the events).
 *
 * The rep edits his customer's days and hours and the place's name.
 *
 * 🔴 REMOVING A PLACE IS NOT HERE ANY MORE — it is `retirePlace` (server/place-move.ts), and this door
 * refuses it. Both doors reached the same `phoenix_crm_update_place` and `assertPlaceMover` guarded both,
 * so it was never a privilege hole; what it was is a SECOND implementation, and since 2026-10-02 a
 * removal carries a written reason and re-measures every visit to the customer. A removal through this
 * path would have done neither, silently, and nothing on screen would say so.
 */
export async function updatePlace(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ placeId: string; customerId: string }> {
  const body = record(raw);
  if (!isUuid(body.placeId)) throw validationError("Choose the place to change.");
  const placeId = String(body.placeId).toLowerCase();
  if (body.action === "retire") {
    throw validationError("Removing a clinic is done from the clinic itself, with the reason for removing it.");
  }
  if (body.action !== "edit") throw validationError("Reload the page and try again.");
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));

  const timings = parseTimings(body.timings);
  if (!timings.ok) throw validationError(timings.error);
  // An edit changes what the rep WROTE — the place's name and its days and hours. It never reaches
  // the location: the clean address, the part of town, the brick, the area and the region were
  // resolved from the captured coordinates and are the customer's record now (owner, 2026-09-23).
  // They are not read from the body and not passed back through, so `phoenix_crm_update_place` has
  // nothing to write them from even if an older phone still sends them.
  const payload: Row = {
    seat_id: seat.seatId,
    actor_hr_id: viewer.hrId,
    is_test: isTest,
    place_id: placeId,
    action: "edit",
    timings: timings.timings,
    label: cleanText(body.label, PLACE_TEXT_MAX),
  };
  const result = await callPhoenixCrm<Row>("phoenix_crm_update_place", { p: payload });
  return { placeId: String(result.place_id), customerId: String(result.customer_id) };
}

/**
 * The rep asks: a grade change (the district manager alone), or — the district manager, then SFE —
 * to drop a listed customer, to add one waiting outside the list, or to bring one back from the Archive.
 */
export async function createListRequest(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ requestId: string; kind: PhoenixCrmRequestKind; stage: PhoenixCrmRequestStage | null }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  const lineCode = lineCodeOf(seat);
  const kind: PhoenixCrmRequestKind | null =
    body.kind === "grade" || body.kind === "drop" || body.kind === "add" || body.kind === "restore" ? (body.kind as PhoenixCrmRequestKind) : null;
  if (!kind) throw validationError("Reload the page and try again.");
  const customerId = isUuid(body.customerId) ? String(body.customerId).toLowerCase() : null;
  const contact = Number(body.referenceContactCrmId);
  const referenceContactCrmId = !customerId && kind === "drop" && Number.isSafeInteger(contact) && contact > 0 ? contact : null;
  if (!customerId && referenceContactCrmId === null) throw validationError("Choose the customer this request is for.");

  const payload: Row = {
    seat_id: seat.seatId,
    line_code: lineCode,
    actor_hr_id: viewer.hrId,
    is_test: isTest,
    kind,
    customer_id: customerId,
    reference_contact_crm_id: referenceContactCrmId,
    first_stage: firstRequestStage(territoryReviewer(viewer.org, seat.seatId) !== null),
  };
  let proposedGrade: PhoenixCrmGrade | null = null;
  let dropReason: string | null = null;
  if (kind === "grade" || kind === "add") {
    proposedGrade = parseGrade(body.proposedGrade);
    if (!proposedGrade) throw validationError("Choose the grade you propose (A, B or C).");
    payload.proposed_grade = proposedGrade;
  } else if (kind === "drop") {
    const drop = parseDropDraft(body, { requireNote: true });
    if (!drop.ok) throw validationError(drop.error);
    dropReason = drop.value.reason;
    payload.drop_reason = drop.value.reason;
    payload.note = drop.value.note;
  } else {
    payload.note = cleanText(body.note, 500);
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_create_request", { p: payload });
  const requestId = String(result.request_id);
  const stage = isRequestStage(result.stage) ? result.stage : null;
  await notifyRequestRaised(viewer, seat, isTest, {
    requestId,
    requestKind: kind,
    stage,
    customerName: String(result.customer_name),
    listType: parseListType(result.list_type),
    proposedGrade,
    dropReason,
  });
  return { requestId, kind, stage };
}

/**
 * The rep drops a customer he met outside his list instead of asking to add him — no approval: the
 * customer was never on the list, so nothing leaves it. He goes to the Archive, and the visits made to
 * him never count.
 */
export async function archiveOutsideCustomer(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ customerId: string; customerName: string }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  if (!isUuid(body.customerId)) throw validationError("Choose the customer to drop.");
  const result = await callPhoenixCrm<Row>("phoenix_crm_archive_outside", {
    p: {
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      customer_id: String(body.customerId).toLowerCase(),
      note: cleanText(body.note, 500),
    },
  });
  return { customerId: String(result.customer_id), customerName: String(result.customer_name) };
}

/**
 * The SFE Manager manages the Archive (owner, 2026-09-29): he can bring a customer back to the list
 * himself. It is filed as a bring-back request at the SFE step and decided in the same breath, so the
 * Archive's history reads the same whoever moved the customer — a request, who decided it, and when.
 */
export async function sfeBringBack(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ requestId: string; customerId: string }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRead(viewer, body.seatId, readTestFlag(body.test));
  assertListRequestApprover(viewer, seat, isTest, "sfe");
  if (!isUuid(body.customerId)) throw validationError("Choose the customer to bring back.");
  const customerId = String(body.customerId).toLowerCase();
  const note = cleanText(body.note, 500);
  const created = await callPhoenixCrm<Row>("phoenix_crm_create_request", {
    p: {
      seat_id: seat.seatId,
      line_code: lineCodeOf(seat),
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      kind: "restore",
      customer_id: customerId,
      first_stage: "sfe",
      note,
    },
  });
  const requestId = String(created.request_id);
  await callPhoenixCrm<Row>("phoenix_crm_decide_request", {
    p: { request_id: requestId, actor_hr_id: viewer.hrId, is_test: isTest, decision: "approve", note, stage: "sfe" },
  });
  return { requestId, customerId };
}

/**
 * The SFE Manager drops an irrelevant customer off a rep's list himself (owner, 2026-10-06: "make the
 * sfe able to enter on any med rep list and delete or drop from it any irrelevant customer").
 *
 * Filed as a `drop` request at the SFE step and decided in the same breath — exactly as `sfeBringBack`
 * does, and for the same reason: the Archive then reads the same whoever took the customer off the
 * list, with a reason, a decider and a time, rather than a customer who silently disappeared. So this
 * needed no database function of its own, and no new way for a customer to leave a list.
 *
 * 🔴 IT DOES NOT SHORTEN THE REP'S OWN PATH. A rep asking to drop a customer still goes to his
 * district manager and then to SFE (`createListRequest`): that ask is about the rep's own work, and the
 * two steps are the owner's rule of 2026-09-29. This is the SFE reaching into the list from outside it.
 *
 * The rep is not notified. A decided request notifies whoever ASKED, which here is the SFE himself, and
 * the rep asked for nothing; a notice invented for him would be the module telling him his list was
 * inspected (Golden Rule #1). What protects his figures instead is the plan report, which takes the
 * days after a customer leaves out of his denominator.
 */
export async function sfeDropFromList(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ requestId: string; customerId: string; customerName: string }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRead(viewer, body.seatId, readTestFlag(body.test));
  assertListCurator(viewer, seat, isTest);
  if (!isUuid(body.customerId)) throw validationError("Choose the customer to drop.");
  const customerId = String(body.customerId).toLowerCase();
  const drop = parseDropDraft(body);
  if (!drop.ok) throw validationError(drop.error);

  const created = await callPhoenixCrm<Row>("phoenix_crm_create_request", {
    p: {
      seat_id: seat.seatId,
      line_code: lineCodeOf(seat),
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      kind: "drop",
      customer_id: customerId,
      first_stage: "sfe",
      drop_reason: drop.value.reason,
      note: drop.value.note,
    },
  });
  const requestId = String(created.request_id);
  await callPhoenixCrm<Row>("phoenix_crm_decide_request", {
    p: {
      request_id: requestId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      decision: "approve",
      note: drop.value.note,
      stage: "sfe",
    },
  });
  return { requestId, customerId, customerName: String(created.customer_name) };
}

/**
 * The SFE Manager hands a customer from one rep's list to another's, choosing where (owner,
 * 2026-10-06: "or move this customer to and choose where").
 *
 * The customer TRAVELS — same row, same grade and potential, same validation, same clinics, a new seat
 * and that seat's line (`phoenix_crm_move_customer`). He is not dropped here and re-added there: a
 * validated place is fixed forever and is keyed on the customer, so re-adding would make the new rep
 * capture a second place for one doorway — the duplicate the duplicates board exists to catch.
 *
 * The destination is a rep SEAT the viewer reaches, which is also how a list is owned (owner's pick,
 * 2026-10-02: a seat's list belongs to the seat, not to the person), so a seat nobody holds today is a
 * legitimate destination and its line is read from the organogram rather than from the phone.
 */
export async function moveCustomerToSeat(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ customerId: string; customerName: string; toSeatId: string; places: number }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRead(viewer, body.seatId, readTestFlag(body.test));
  assertListCurator(viewer, seat, isTest);
  if (!isUuid(body.customerId)) throw validationError("Choose the customer to move.");
  const toSeatId = String(body.toSeatId ?? "").trim();
  if (!toSeatId) throw validationError("Choose the rep to move this customer to.");
  if (toSeatId === seat.seatId) throw validationError("That is the rep this customer is with already. Choose a different rep.");
  // The destination is resolved in the organogram and checked against the viewer's own reach — a seat
  // id arriving from a phone is never trusted, and a picker is never wider than its viewer.
  const target = viewer.scopeTerritories.find((entry) => entry.seatId === toSeatId);
  if (!target) throw forbiddenError("That rep is not one you can move a customer to.");
  const toLineCode = lineCodeOf(target);
  // The destination must be one he could curate too: moving a customer onto a list is a change to that
  // list, and the same people may make it.
  assertListCurator(viewer, target, isTest);
  const reason = cleanText(body.reason, CUSTOMER_MOVE_REASON_MAX);
  if (!reason || reason.length < CUSTOMER_MOVE_REASON_MIN) {
    throw validationError(`Write why the customer is moving (at least ${CUSTOMER_MOVE_REASON_MIN} characters).`);
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_move_customer", {
    p: {
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      customer_id: String(body.customerId).toLowerCase(),
      from_seat_id: seat.seatId,
      to_seat_id: toSeatId,
      to_line_code: toLineCode,
      reason,
    },
  });
  return {
    customerId: String(result.customer_id),
    customerName: String(result.customer_name),
    toSeatId: String(result.to_seat_id),
    places: Number(result.places ?? 0),
  };
}

export async function withdrawListRequest(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ requestId: string }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  if (!isUuid(body.requestId)) throw validationError("Choose the request to withdraw.");
  const result = await callPhoenixCrm<Row>("phoenix_crm_withdraw_request", {
    p: { seat_id: seat.seatId, actor_hr_id: viewer.hrId, is_test: isTest, request_id: String(body.requestId).toLowerCase() },
  });
  return { requestId: String(result.request_id) };
}

/**
 * SFE sends the request SFE holds back to the rep for a comment (owner, 2026-10-12). It is not a
 * decision: the request stays pending, with the rep, and returns to SFE the moment he answers. The note is
 * required, and only the step SFE holds can be returned — the district manager's own step never is.
 */
export async function returnListRequestForComment(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ requestId: string; stage: "rep" }> {
  const body = record(raw);
  if (!isUuid(body.requestId)) throw validationError("Choose the request to return.");
  const note = cleanText(body.note, RETURN_NOTE_MAX);
  if (!note) throw validationError(RETURN_NOTE_REQUIRED);

  const requestId = String(body.requestId).toLowerCase();
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_list_requests")
    .select("id, seat_id, is_test, kind, status, stage, customer_id")
    .eq("id", requestId)
    .maybeSingle();
  throwIfError(error);
  const request = data as Row | null;
  if (!request) throw notFoundError("This request is no longer there. Reload the page.");
  const seat = viewer.org.seats.get(String(request.seat_id));
  if (!seat) throw notFoundError("This territory is no longer in the organogram. Reload the page.");
  const isTest = request.is_test === true;
  const kind = requestKindOf(request.kind);
  if (request.status !== "pending") throw validationError("This request has already been decided. Reload the page.");
  if (isWithRep(request.stage)) throw validationError("This request has already been returned to the rep.");
  const stage = isRequestStage(request.stage) ? request.stage : null;
  // The Administrator only declines (owner, 2026-10-08); returning is a step in SFE's hands.
  assertListRequestApprover(viewer, seat, isTest, stage);
  const allowed = canReturnForComment({
    kind,
    status: "pending",
    stage,
    withRep: false,
    canDecide: true,
    hasReviewer: territoryReviewer(viewer.org, seat.seatId) !== null,
  });
  if (!allowed) throw validationError("Only the step SFE holds can be returned for a comment.");

  const result = await callPhoenixCrm<Row>("phoenix_crm_return_request", {
    p: { request_id: requestId, actor_hr_id: viewer.hrId, is_test: isTest, note, stage },
  });
  const requesterHrId = text(result.requested_by_hr_id);
  if (requesterHrId) {
    await notifyPhoenixCrm(
      {
        kind: "request_returned",
        seat,
        requestId,
        requestKind: kind,
        returnerHrId: viewer.hrId,
        requesterHrId,
        customerName: String(result.customer_name),
        note,
        returnedAt: text(result.returned_at) ?? new Date().toISOString(),
      },
      isTest,
    );
  }
  return { requestId, stage: "rep" };
}

/** The rep's comment on a request SFE returned. It goes straight back to SFE, at the step it left. */
export async function answerReturnedRequest(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ requestId: string; stage: PhoenixCrmRequestStage | null }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  if (!isUuid(body.requestId)) throw validationError("Choose the request to answer.");
  const reply = cleanText(body.reply, RETURN_NOTE_MAX);
  if (!reply) throw validationError(RETURN_REPLY_REQUIRED);
  const result = await callPhoenixCrm<Row>("phoenix_crm_answer_request", {
    p: { seat_id: seat.seatId, actor_hr_id: viewer.hrId, is_test: isTest, request_id: String(body.requestId).toLowerCase(), reply },
  });
  const returnerHrId = text(result.returned_by_hr_id);
  if (returnerHrId) {
    await notifyPhoenixCrm(
      {
        kind: "request_answered",
        seat,
        requestId: String(result.request_id),
        requestKind: requestKindOf(result.kind),
        requesterHrId: text(result.requested_by_hr_id) ?? viewer.hrId,
        returnerHrId,
        customerName: String(result.customer_name),
        reply,
        answeredAt: text(result.replied_at) ?? new Date().toISOString(),
      },
      isTest,
    );
  }
  return { requestId: String(result.request_id), stage: isRequestStage(result.stage) ? result.stage : null };
}

/**
 * A decision on a list request. Refusing needs a note for the rep.
 *
 * A grade change is the district manager's alone. A drop, an add or a bring-back takes two steps — the
 * district manager, then SFE — and the step being decided is read from the ROW, never from the phone;
 * a phone that names a step only makes the database refuse if the request has already moved on (two
 * people deciding at once). At the district manager's step of an add he confirms or changes the A/B/C
 * grade and must set the customer's potential (AA..BC).
 */
export async function decideListRequest(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ requestId: string; status: "approved" | "refused" | "pending"; stage: PhoenixCrmRequestStage | null; final: boolean }> {
  const body = record(raw);
  if (!isUuid(body.requestId)) throw validationError("Choose the request to decide.");
  const decision = body.decision === "approve" ? "approve" : body.decision === "refuse" ? "refuse" : null;
  if (!decision) throw validationError("Choose approve or refuse.");
  const note = cleanText(body.note, 500);
  if (decision === "refuse" && !note) throw validationError("Write a note for the rep explaining why.");

  const requestId = String(body.requestId).toLowerCase();
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_list_requests")
    .select("id, seat_id, is_test, kind, status, stage, manager_decided_at, customer_id")
    .eq("id", requestId)
    .maybeSingle();
  throwIfError(error);
  const request = data as Row | null;
  if (!request) throw notFoundError("This request is no longer there. Reload the page.");
  const seat = viewer.org.seats.get(String(request.seat_id));
  if (!seat) throw notFoundError("This territory is no longer in the organogram. Reload the page.");
  const isTest = request.is_test === true;
  const kind = requestKindOf(request.kind);
  // A request SFE returned for a comment is still pending but is NOT at a step anybody approves. Who may
  // refuse it is the holder of the step it returns to (`stageAfterReply`), and it cannot be approved at
  // all until the rep has answered (owner, 2026-10-12).
  const withRep = isWithRep(request.stage);
  if (withRep && decision === "approve") {
    throw validationError("This request is waiting for the rep's comment. It can be approved once the rep has answered.");
  }
  const rowStage = isRequestStage(request.stage) ? request.stage : withRep ? stageAfterReply(kind) : null;
  // The Administrator approves or declines at whichever step it waits at, in place of its holder, and is
  // no step himself (owner, 2026-10-14; before that he could only decline, 2026-10-08).
  if (!canOverrideDecision(viewer, isTest)) assertListRequestApprover(viewer, seat, isTest, rowStage);

  const approvedGrade = kind === "add" ? parseGrade(body.approvedGrade) : null;
  const potentialGrade = kind === "add" ? parsePotentialGrade(body.potentialGrade) : null;
  // Whoever takes the GRADING step of an add must set the potential — the district manager, or SFE on a
  // territory with no manager at all (owner's pick, 2026-10-02). One rule, shared with the card, so a
  // screen can never offer an approval this refuses or hide a field this demands.
  const grading = setsAdmissionGrades({ kind, stage: rowStage, managerDecidedAt: text(request.manager_decided_at) || null });
  if (decision === "approve" && grading && !potentialGrade) {
    throw validationError("Choose the customer's potential (AA to BC) before approving.");
  }
  // The step the phone saw, when it names one; otherwise the row's own — both guard the same race. A
  // request with the rep is at the stored stage 'rep', whatever step the card named.
  const stage = withRep ? "rep" : isRequestStage(body.stage) ? body.stage : rowStage;
  // SFE's step admits him to the list. While his place is still with the Super Admin it waits: only the
  // Super Admin approves or rejects a place the Google check could not confirm (owner, 2026-10-03).
  const customerId = text(request.customer_id);
  if (decision === "approve" && rowStage === "sfe" && (kind === "add" || kind === "restore") && customerId && (await pendingLocationReview(customerId))) {
    throw validationError("This customer's location is still being checked against Google Maps. They can be added once the check is finished.");
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_decide_request", {
    p: {
      request_id: requestId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      decision,
      note,
      stage,
      approved_grade: approvedGrade,
      potential_grade: potentialGrade,
    },
  });
  const final = result.final !== false;
  const status = !final ? "pending" : result.status === "approved" ? "approved" : "refused";
  const requesterHrId = text(result.requested_by_hr_id);
  // The rep hears the ANSWER: a refusal at either step, or the final approval. The district manager's
  // approval of the first step is not an answer yet — the request just moves on to SFE.
  if (requesterHrId && status !== "pending") {
    await notifyPhoenixCrm(
      {
        kind: "request_decided",
        seat,
        requestId,
        requestKind: kind,
        status,
        deciderHrId: viewer.hrId,
        requesterHrId,
        customerName: String(result.customer_name),
        proposedGrade: text(result.proposed_grade),
        note,
      },
      isTest,
    );
  }
  return { requestId, status, stage: isRequestStage(result.stage) ? result.stage : null, final };
}
