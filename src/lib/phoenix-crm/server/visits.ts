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
 * The visit's date and time are the server's (when the photo's upload slot was issued), never the
 * phone's. One visit a customer a day per territory. A retry of the same visit (the phone keeps the
 * visit's id until it is saved) returns the saved visit instead of a second one.
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
  type ProductAvailability,
} from "@/lib/phoenix-crm/entry-rules";
import { checkVisitLocation, formatDistance } from "@/lib/phoenix-crm/geo";
import { describeDayWindows, isUuid } from "@/lib/phoenix-crm/plan-rules";
import { managerChain, resolveVisitParticipants } from "@/lib/phoenix-crm/scope";
import { readTestFlag, territoryForRead, territoryForVisit, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, numberOrNull, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { ensureReferenceCustomers, loadMonthVisitCounts, loadTerritoryCustomers } from "@/lib/phoenix-crm/server/list";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { photoSlotIssuedAt } from "@/lib/phoenix-crm/server/photos";
import { lineProductsByFamily, type LineProductFamily } from "@/lib/phoenix-crm/server/products";
import { describeTerritory, seatTierTitle, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";
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

export function visitLocationLabel(flag: VisitLocationFlag, distanceMeters: number | null, accuracyMeters: number | null): string {
  if (flag === "far") return `Far from the validated place (${formatDistance(distanceMeters)})`;
  if (flag === "weak_gps") return `Weak location signal (accuracy ${formatDistance(accuracyMeters)})`;
  if (flag === "no_place") return "No place saved yet to compare with";
  return distanceMeters === null ? "At the validated place" : `At the validated place (${formatDistance(distanceMeters)})`;
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
  locationFlag: VisitLocationFlag;
  locationLabel: string;
  clockOff: boolean;
};

const VISIT_COLUMNS =
  "id, visit_date, captured_at, customer_id, list_type, kind, rep_hr_id, manager_hr_id, senior_hr_id, entered_by_hr_id, products, " +
  "comment, pharmacy_name, product_availability, photo_path, accuracy_meters, distance_meters, location_flag, device_skew_minutes, " +
  "customer:phoenix_crm_customers!customer_id(name)";

function visitKind(value: unknown): PhoenixCrmVisitKind {
  return value === "double" || value === "chain" ? value : "single";
}

function locationFlag(value: unknown): VisitLocationFlag {
  return value === "far" || value === "weak_gps" || value === "no_place" ? value : "ok";
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
    locationFlag: flag,
    locationLabel: visitLocationLabel(flag, numberOrNull(row.distance_meters), numberOrNull(row.accuracy_meters)),
    clockOff: skew !== null && Math.abs(skew) > DEVICE_CLOCK_TOLERANCE_MINUTES,
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

async function plannedCustomerIds(seatId: string, isTest: boolean, date: string): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const { data: plan, error } = await supabase
    .from("phoenix_crm_plans")
    .select("id")
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .eq("week_start", fieldWeekStart(date))
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
  const names = await loadPeopleNames([...territoryPeople(viewer.org, [seat]), ...chain.map((member) => member.hrId), ...visitPeople(visitRows)]);
  const visitedToday = new Set(visitRows.map((row) => String(row.customer_id)));
  const ramadan = isRamadanDay(today, viewer.config.ramadanOverrides);
  const settings = viewer.config.settings;

  const options: VisitCustomerOption[] = customers.map((row) => {
    const customerId = String(row.id);
    const listType: PhoenixCrmListType = row.list_type === "AM" ? "AM" : "PM";
    const grade = parseGrade(row.grade);
    return {
      customerId,
      name: String(row.name),
      listType,
      grade,
      speciality: textOrNull(row.speciality),
      places: (placesByCustomer.get(customerId) ?? []).map((place) => ({
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
  // Today's planned customers first, then the rest by name.
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
      lat: visit.lat,
      lon: visit.lon,
      accuracy_meters: visit.accuracyMeters,
      place_id: check.placeId,
      distance_meters: distance,
      location_flag: flag,
      device_skew_minutes: issuedAt ? deviceClockSkewMinutes(visit.deviceCapturedAt, new Date(issuedAt)) : null,
    },
  });

  return {
    visitId: String(result.id),
    visitDate: String(result.visit_date),
    capturedAt: String(result.captured_at),
    customerId: String(result.customer_id),
    duplicate: result.duplicate === true,
    locationFlag: flag,
    locationLabel: visitLocationLabel(flag, distance, visit.accuracyMeters),
  };
}
