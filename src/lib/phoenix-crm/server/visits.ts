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
import { describeDayWindows, isUuid } from "@/lib/phoenix-crm/plan-rules";
import { managerChain, resolveVisitParticipants, territoryReviewer } from "@/lib/phoenix-crm/scope";
import { readTestFlag, territoryForRead, territoryForVisit, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, numberOrNull, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { judgeCapture } from "@/lib/phoenix-crm/server/location-integrity";
import { ensureReferenceCustomers, loadMonthVisitCounts, loadTerritoryCustomers } from "@/lib/phoenix-crm/server/list";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { photoSlotIssuedAt } from "@/lib/phoenix-crm/server/photos";
import { lineProductsByFamily, type LineProductFamily } from "@/lib/phoenix-crm/server/products";
import { describeTerritory, seatTierTitle, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";
import {
  isUnplannedVisitStatus,
  unplannedFirstStatus,
  unplannedVisitRepNote,
  unplannedVisitStatusLabel,
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
 * What the REP reads on his own visit — the owner's polite sign, 2026-09-26.
 *
 * His words: "a polite small sign telling him take care, take care, you are away from the saved
 * location by, for example, five hundred meters". Care, with the distance in it, and nothing that
 * reads as a count or a verdict. "Far from", "flag" and "signal" are gone: the old wording told a
 * rep standing in the right clinic that he had done something wrong, when the usual cause is a place
 * saved from the wrong doorway months ago.
 *
 * A weak reading is about the PHONE, not about him, and is worded as such.
 *
 * The manager's place-vs-actual report is untouched and still says everything, in metres — this is
 * the rep's own screen only.
 */
export function visitLocationLabel(flag: VisitLocationFlag, distanceMeters: number | null, accuracyMeters: number | null): string {
  if (flag === "far") return `Take care — about ${formatDistance(distanceMeters)} from this customer's saved place`;
  if (flag === "weak_gps") return `The phone was not sure where it was (within ${formatDistance(accuracyMeters)})`;
  if (flag === "no_place") return "No place saved for this customer yet";
  return distanceMeters === null ? "At the saved place" : `At the saved place (${formatDistance(distanceMeters)})`;
}

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
  enteredByName: string;
  products: string[];
  /** The pharmacy the rep took feedback from before the doctor. */
  pharmacyName: string | null;
  /** Which of the rep's line products that pharmacy stocks, product by product. */
  productAvailability: Record<string, ProductAvailability>;
  comment: string | null;
  photoPath: string;
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
};

const VISIT_COLUMNS =
  "id, visit_date, captured_at, customer_id, list_type, kind, rep_hr_id, manager_hr_id, senior_hr_id, entered_by_hr_id, products, " +
  "comment, pharmacy_name, product_availability, photo_path, voice_note_path, voice_note_seconds, " +
  "accuracy_meters, distance_meters, location_flag, device_skew_minutes, is_unplanned, " +
  "customer:phoenix_crm_customers!customer_id(name), " +
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

function visitPeople(rows: ReadonlyArray<Row>): Array<string | null> {
  return rows.flatMap((row) => [
    textOrNull(row.rep_hr_id),
    textOrNull(row.manager_hr_id),
    textOrNull(row.senior_hr_id),
    textOrNull(row.entered_by_hr_id),
  ]);
}

function mapVisitRow(row: Row, names: PeopleNames): VisitRow {
  const kind = visitKind(row.kind);
  const flag = locationFlag(row.location_flag);
  const skew = numberOrNull(row.device_skew_minutes);
  const person = (value: unknown) => {
    const hrId = textOrNull(value);
    return hrId ? nameOf(names, hrId) : null;
  };
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
    enteredByName: nameOf(names, textOrNull(row.entered_by_hr_id)),
    products: Array.isArray(row.products) ? row.products.map(String) : [],
    pharmacyName: textOrNull(row.pharmacy_name),
    productAvailability: parseProductAvailability(row.product_availability),
    comment: textOrNull(row.comment),
    photoPath: String(row.photo_path),
    voiceNotePath: textOrNull(row.voice_note_path),
    voiceNoteSeconds: numberOrNull(row.voice_note_seconds),
    locationFlag: flag,
    locationLabel: visitLocationLabel(flag, numberOrNull(row.distance_meters), numberOrNull(row.accuracy_meters)),
    clockOff: skew !== null && Math.abs(skew) > DEVICE_CLOCK_TOLERANCE_MINUTES,
    unplanned: row.is_unplanned === true ? visitUnplanned(row) : null,
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
function canEnterVisits(viewer: PhoenixCrmViewer, seatId: string, isTest: boolean): boolean {
  try {
    territoryForVisit(viewer, seatId, isTest);
    return true;
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
};

export async function loadVisitDay(viewer: PhoenixCrmViewer, raw: { seatId: unknown; test: unknown; date: unknown }): Promise<VisitDayView> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  const date = isIsoDay(raw.date) && raw.date <= viewer.cairoToday ? raw.date : viewer.cairoToday;
  const rows = await loadVisitRows(seat.seatId, isTest, date);
  const names = await loadPeopleNames([...territoryPeople(viewer.org, [seat]), ...visitPeople(rows)]);
  return {
    territory: describeTerritory(viewer.org, seat, names),
    isTest,
    date,
    visits: rows.map((row) => mapVisitRow(row, names)),
    canAdd: date === viewer.cairoToday && canEnterVisits(viewer, seat.seatId, isTest),
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
 */
async function loadLastVisitProducts(
  seatId: string,
  isTest: boolean,
  today: string,
  lineProducts: readonly string[],
): Promise<Map<string, LastVisitProducts>> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_visits")
        .select("id, customer_id, visit_date, captured_at, products")
        .eq("seat_id", seatId)
        .eq("is_test", isTest)
        .lt("visit_date", today)
        .gte("visit_date", monthsBackFrom(today, LAST_VISIT_MONTHS)),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  return pickLastVisitProducts(
    rows.map((row) => ({
      customerId: String(row.customer_id ?? ""),
      visitDate: String(row.visit_date ?? ""),
      capturedAt: String(row.captured_at ?? ""),
      products: Array.isArray(row.products) ? (row.products as unknown[]).map((entry) => String(entry)) : [],
    })),
    lineProducts,
    VISIT_PRODUCTS_MAX,
  );
}

export async function loadVisitForm(viewer: PhoenixCrmViewer, raw: { seatId: unknown; test: unknown }): Promise<VisitFormView> {
  const { seat, isTest, enteredAs } = territoryForVisit(viewer, raw.seatId, readTestFlag(raw.test));
  const today = viewer.cairoToday;
  const chain = managerChain(viewer.org, seat.seatId);

  await ensureReferenceCustomers(seat, isTest);
  const [{ customers, placesByCustomer }, visitCounts, planned, visitRows, productFamilies, pharmacies] = await Promise.all([
    loadTerritoryCustomers(seat.seatId, isTest, { onListOnly: true }),
    loadMonthVisitCounts(seat.seatId, isTest, monthStartOf(today), today),
    plannedCustomerIds(seat.seatId, isTest, today),
    loadVisitRows(seat.seatId, isTest, today),
    lineProductsByFamily(seat.lineName),
    loadSeatPharmacies(seat.seatId, isTest),
  ]);
  const products = productFamilies.map((entry) => entry.family);
  // After the families, because what he discussed last time is narrowed to what the line still sells.
  const lastVisits = await loadLastVisitProducts(seat.seatId, isTest, today, products);
  const names = await loadPeopleNames([...territoryPeople(viewer.org, [seat]), ...chain.map((member) => member.hrId), ...visitPeople(visitRows)]);
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
      lastVisit: lastVisits.get(customerId) ?? null,
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
      referenceContactCrmId: numberOrNull(row.reference_contact_crm_id),
    };
  });
  // Today's planned customers first, then the rest by name. The picker groups by brick on top of this,
  // so within a brick the planned doctors still lead.
  options.sort((left, right) => Number(right.plannedToday) - Number(left.plannedToday) || left.name.localeCompare(right.name));

  let blockedReason: string | null = null;
  if (!seat.lineCode) blockedReason = "This territory has no line in the organogram, so visits cannot be saved.";
  else if (products.length === 0) blockedReason = `No products are on file for ${seat.lineName ?? "this line"} yet, so a visit cannot record the products discussed.`;
  else if (options.length === 0) blockedReason = "No customers on your list yet. Add them on the List tab first.";

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
    todayVisits: visitRows.map((row) => mapVisitRow(row, names)),
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
  const [placesResult, issuedAt] = await Promise.all([
    supabase
      .from("phoenix_crm_places")
      .select("id, lat, lon")
      .eq("customer_id", visit.customerId)
      .eq("seat_id", seat.seatId)
      .eq("is_test", isTest)
      .eq("status", "active"),
    photoSlotIssuedAt(visit.photoPath),
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
      unplanned_first_status: unplannedFirstStatus(reviewer !== null),
      reviewer_hr_id: reviewer?.hrId ?? null,
      lat: visit.lat,
      lon: visit.lon,
      accuracy_meters: visit.accuracyMeters,
      place_id: check.placeId,
      distance_meters: distance,
      location_flag: flag,
      device_skew_minutes: issuedAt ? deviceClockSkewMinutes(visit.deviceCapturedAt, new Date(issuedAt)) : null,
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
  // An off-plan visit is the ONE visit that tells anybody (notifications.ts): it counts in nothing
  // until it is decided, so the manager who must decide it is told. A repeat save is skipped — the
  // first one already raised it, and the notice's idempotency key would drop the second anyway.
  if (isUnplanned && result.duplicate !== true) {
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
  return {
    visitId: String(result.id),
    visitDate: String(result.visit_date),
    capturedAt: String(result.captured_at),
    customerId: String(result.customer_id),
    duplicate: result.duplicate === true,
    locationFlag: flag,
    locationLabel: visitLocationLabel(flag, distance, visit.accuracyMeters),
    isUnplanned,
    unplannedNote: isUnplanned ? unplannedVisitRepNote(unplannedFirstStatus(reviewer !== null)) : null,
  };
}
