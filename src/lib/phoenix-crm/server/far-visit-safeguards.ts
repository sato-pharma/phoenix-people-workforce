/**
 * Phoenix CRM — the four safeguards around a customer's place, with their I/O (owner, 2026-11-10).
 *
 * The rules and the numbers live in `@/lib/phoenix-crm/far-visit-safeguards` (pure, tested without a
 * database). This file reads what they judge and writes what they decide:
 *
 *   A · `guardPlaceReadings` — a validation's pin, or its photo's reading, that the rep could not have
 *       reached from his own visit saved minutes earlier is refused (the pin) or dropped (the photo).
 *   B · `farVisitOutcome` → `notifyStuckRep` — the fifth far refusal from one tight spot on one customer in
 *       one day tells the Super Admin and the SFE Manager, once, in-app, on Telegram and the phone.
 *   C · `farVisitOutcome` → a hold row — the next visit from that spot is saved and held for the SFE, and
 *       `decideFarVisitHold` is the SFE's answer. The two countable views leave a held visit out until then.
 *   D · the 500 m line of an account is applied by the caller (`farRefusalLineFor`), before any of this.
 *
 * 🔴 EVERY READ HERE FAILS OPEN TOWARDS THE RULE THAT WAS ALREADY THERE. A read that fails gives no anchor
 * (no impossible refusal), no tries (no hold, no alert) — the rep meets exactly the door he met before
 * these safeguards existed, never a new refusal on a count nobody could read.
 */

import { buildCaseMap, type CaseMap } from "@/lib/crm-integrity/integrity-case-map";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { phoenixCrmChannels } from "@/lib/notifications/phoenix-crm-channel-guard";
import { resolveHrIdsForRole } from "@/lib/notifications/role-recipients";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import { cleanText, type PlaceDraft, type VisitDraft } from "@/lib/phoenix-crm/entry-rules";
import {
  IMPOSSIBLE_LOCATION_REFUSED,
  IMPOSSIBLE_POINT_MEMORY_HOURS,
  IMPOSSIBLE_TRAVEL_LOOKBACK_MINUTES,
  holdInsteadOfRefuse,
  impossibleLocationApplies,
  judgeImpossibleLocation,
  parseFarVisitHoldStatus,
  stuckAtOneSpot,
  type FarVisitHoldStatus,
  type TimedReading,
} from "@/lib/phoenix-crm/far-visit-safeguards";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { personKey, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { numberOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { PHOENIX_CRM_NOTIFICATION_CATEGORY, PHOENIX_CRM_NOTIFICATION_MODULE, sfeManagerHrIds } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import {
  loadFarTriesOnDay,
  loadImpossiblePoints,
  recordFarVisitRefusal,
  recordImpossibleTravelRefusal,
} from "@/lib/phoenix-crm/server/refused-readings";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** The page the stuck-rep alert opens, and where the SFE decides a held visit. */
export const FAR_VISIT_HOLDS_PATH = "/admin/phoenix-crm/far-visit-holds";

/** Who may read the held visits and decide them: the Super Admin and the SFE Manager, nobody else. */
export function canDecideFarVisitHolds(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin || viewer.isSfeManager;
}

// ── A · an impossible location at validation ────────────────────────────────────────────────────

/**
 * The rep's own visits saved in the last hour, as anchors. Only visits HE entered as the rep (a manager's
 * phone is not his), never a copied old visit, never an archived one, and never a save the phone held for
 * want of signal (`phoenix_crm_visit_capture_provenance.queued_seconds`, or an offline anchor): those
 * arrived late, so their saved time is not when he stood there. Empty on any error.
 */
export async function loadVisitAnchors(input: { repHrId: string; isTest: boolean; now: Date }): Promise<TimedReading[]> {
  try {
    const since = new Date(input.now.getTime() - IMPOSSIBLE_TRAVEL_LOOKBACK_MINUTES * 60 * 1000).toISOString();
    const supabase = getSupabaseAdmin();
    const [visits, queued] = await Promise.all([
      supabase
        .from("phoenix_crm_visits")
        .select("id, lat, lon, accuracy_meters, captured_at, entered_by_hr_id, time_anchor_id")
        .eq("rep_hr_id", input.repHrId)
        .eq("is_test", input.isTest)
        .is("imported_from_ireports360_at", null)
        .is("archived_at", null)
        .gte("captured_at", since)
        .not("lat", "is", null)
        .limit(100),
      supabase
        .from("phoenix_crm_visit_capture_provenance")
        .select("visit_id")
        .eq("rep_hr_id", input.repHrId)
        .gte("captured_at", since)
        .not("queued_seconds", "is", null)
        .limit(100),
    ]);
    if (visits.error || queued.error) {
      console.error("[phoenix-crm] visit anchors not read", { message: visits.error?.message ?? queued.error?.message });
      return [];
    }
    const late = new Set(((queued.data ?? []) as Row[]).map((row) => String(row.visit_id)));
    const rep = personKey(input.repHrId);
    const anchors: TimedReading[] = [];
    for (const row of (visits.data ?? []) as Row[]) {
      if (late.has(String(row.id)) || row.time_anchor_id) continue;
      if (personKey(typeof row.entered_by_hr_id === "string" ? row.entered_by_hr_id : null) !== rep) continue;
      const lat = numberOrNull(row.lat);
      const lon = numberOrNull(row.lon);
      if (lat === null || lon === null || typeof row.captured_at !== "string") continue;
      anchors.push({ lat, lon, accuracyMeters: numberOrNull(row.accuracy_meters), at: row.captured_at });
    }
    return anchors;
  } catch (error) {
    console.error("[phoenix-crm] visit anchors not read", { error });
    return [];
  }
}

/**
 * A · judge a place's readings before it is saved. The rep's own save only (the caller asks), from
 * 2026-11-10 on. A PIN the rep could not have reached is refused, with his own work in the sentence and
 * nothing about the check; a PHOTO reading that is impossible beside a good pin is filed silently and
 * dropped from the draft, so the place is fixed from the pin (`pickPlacePoint` falls back to it).
 */
export async function guardPlaceReadings(input: {
  place: PlaceDraft;
  seatId: string;
  repHrId: string;
  customerId: string | null;
  isTest: boolean;
  now?: Date;
}): Promise<PlaceDraft> {
  const now = input.now ?? new Date();
  if (!impossibleLocationApplies(cairoBusinessDay(now))) return input.place;
  const [anchors, refusedPoints] = await Promise.all([
    loadVisitAnchors({ repHrId: input.repHrId, isTest: input.isTest, now }),
    loadImpossiblePoints({ repHrId: input.repHrId, isTest: input.isTest, since: new Date(now.getTime() - IMPOSSIBLE_POINT_MEMORY_HOURS * 3600 * 1000) }),
  ]);
  if (anchors.length === 0 && refusedPoints.length === 0) return input.place;
  const { place } = input;
  const pin = judgeImpossibleLocation({ reading: { lat: place.lat, lon: place.lon }, now, anchors, refusedPoints });
  const photoReading = place.photoLat !== null && place.photoLon !== null ? { lat: place.photoLat, lon: place.photoLon } : null;
  const photo = photoReading ? judgeImpossibleLocation({ reading: photoReading, now, anchors, refusedPoints }) : { impossible: false as const };
  const common = {
    photoPath: place.photoPath,
    deviceCapturedAt: place.deviceCapturedAt,
    deviceMocked: place.deviceMocked,
    seatId: input.seatId,
    repHrId: input.repHrId,
    customerId: input.customerId,
    isTest: input.isTest,
  };
  if (pin.impossible) {
    await recordImpossibleTravelRefusal({
      ...common,
      reading: { lat: place.lat, lon: place.lon, accuracyMeters: place.accuracyMeters },
      photo: photo.impossible && photoReading ? { ...photoReading, accuracyMeters: place.photoAccuracyMeters } : null,
      metres: pin.metres,
    });
    throw validationError(IMPOSSIBLE_LOCATION_REFUSED);
  }
  if (photo.impossible && photoReading) {
    await recordImpossibleTravelRefusal({
      ...common,
      reading: { ...photoReading, accuracyMeters: place.photoAccuracyMeters },
      photo: null,
      metres: photo.metres,
    });
    return { ...place, photoLat: null, photoLon: null, photoAccuracyMeters: null };
  }
  return place;
}

// ── B and C · a rep refused again and again from one spot ───────────────────────────────────────

export type FarVisitOutcome = { hold: false } | { hold: true; tries: number };

/**
 * A rep's visit is past the far line. Either it is HELD (C: the tries before it already put him at one
 * tight spot and this reading is at that spot) — the hold row is written now, before the save, so the
 * visit is never counted for an instant — or it is REFUSED exactly as before, its reading filed, and the
 * try that makes him stuck tells the Super Admin and the SFE Manager (B). The caller throws the refusal.
 *
 * 🔴 A HOLD THAT CANNOT BE WRITTEN REFUSES AS BEFORE: a visit saved without its hold would count.
 */
export async function farVisitOutcome(input: {
  visitId: string;
  visit: Pick<
    VisitDraft,
    "lat" | "lon" | "accuracyMeters" | "photoLat" | "photoLon" | "photoAccuracyMeters" | "photoPath" | "deviceCapturedAt" | "deviceMocked"
  >;
  seat: OrgSeat;
  repHrId: string;
  customerId: string;
  placeId: string | null;
  metres: number | null;
  farMeters: number;
  isTest: boolean;
  /** The day the visit was captured, as the save will date it — the hold's own day. Today when absent. */
  captureDay?: string;
  now?: Date;
}): Promise<FarVisitOutcome> {
  const now = input.now ?? new Date();
  const visitDate = cairoBusinessDay(now);
  const earlier = await loadFarTriesOnDay({
    seatId: input.seat.seatId,
    repHrId: input.repHrId,
    customerId: input.customerId,
    isTest: input.isTest,
    visitDate,
  });
  const reading = { lat: input.visit.lat, lon: input.visit.lon, accuracyMeters: input.visit.accuracyMeters };
  const verdict = holdInsteadOfRefuse(earlier, reading);
  if (verdict.hold) {
    const held = await writeHold({
      visitId: input.visitId,
      seatId: input.seat.seatId,
      repHrId: input.repHrId,
      customerId: input.customerId,
      placeId: input.placeId,
      metres: input.metres,
      farMeters: input.farMeters,
      tries: verdict.tries,
      spot: verdict.centre,
      visitDate: input.captureDay ?? visitDate,
      isTest: input.isTest,
    });
    if (held) return { hold: true, tries: verdict.tries };
  }
  await recordFarVisitRefusal({
    visit: input.visit,
    seatId: input.seat.seatId,
    repHrId: input.repHrId,
    customerId: input.customerId,
    placeId: input.placeId,
    metres: input.metres,
    farMeters: input.farMeters,
    isTest: input.isTest,
  });
  // B: told ONCE, on the try that makes him stuck — never again for the same customer that day.
  const before = stuckAtOneSpot(earlier);
  const after = stuckAtOneSpot([...earlier, reading]);
  if (!before.stuck && after.stuck && !input.isTest) {
    await notifyStuckRep({
      seat: input.seat,
      repHrId: input.repHrId,
      customerId: input.customerId,
      tries: after.tries,
      metres: input.metres,
      visitDate,
    });
  }
  return { hold: false };
}

async function writeHold(input: {
  visitId: string;
  seatId: string;
  repHrId: string;
  customerId: string;
  placeId: string | null;
  metres: number | null;
  farMeters: number;
  tries: number;
  spot: { lat: number; lon: number } | null;
  visitDate: string;
  isTest: boolean;
}): Promise<boolean> {
  try {
    const { error } = await getSupabaseAdmin()
      .from("phoenix_crm_far_visit_holds")
      // A retried save of the same visit finds its hold already written, and keeps it.
      .upsert(
        {
          visit_id: input.visitId,
          seat_id: input.seatId,
          rep_hr_id: input.repHrId.toUpperCase(),
          customer_id: input.customerId,
          place_id: input.placeId,
          distance_meters: input.metres === null || !Number.isFinite(input.metres) ? null : Math.round(input.metres),
          far_meters: Math.round(input.farMeters),
          tries: Math.min(1000, Math.max(1, input.tries)),
          spot_lat: input.spot?.lat ?? null,
          spot_lon: input.spot?.lon ?? null,
          visit_date: input.visitDate,
          is_test: input.isTest,
        },
        { onConflict: "visit_id", ignoreDuplicates: true },
      );
    if (error) {
      console.error("[phoenix-crm] far visit hold not written", { seatId: input.seatId, message: error.message });
      return false;
    }
    return true;
  } catch (error) {
    console.error("[phoenix-crm] far visit hold not written", { seatId: input.seatId, error });
    return false;
  }
}

/**
 * B · the alert. The Super Admin and the SFE Managers, in-app, on Telegram and the phone — never email
 * (`phoenixCrmChannels` bars it for the whole module). Once per rep, customer and day: the caller sends it
 * only on the try that crosses the line, and the key would fold a second send into the first. Never
 * throws: the rep is about to read his refusal either way.
 */
async function notifyStuckRep(input: {
  seat: OrgSeat;
  repHrId: string;
  customerId: string;
  tries: number;
  metres: number | null;
  visitDate: string;
}): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    const [admins, sfe, names, customer] = await Promise.all([
      resolveHrIdsForRole("Super Admin", "Phoenix CRM — a rep stuck at one spot"),
      sfeManagerHrIds(),
      loadPeopleNames([input.repHrId]),
      supabase.from("phoenix_crm_customers").select("name").eq("id", input.customerId).maybeSingle(),
    ]);
    const recipients = [...new Set([...admins.hrIds, ...sfe])].filter((hrId) => !hrId.startsWith("TEST-"));
    if (recipients.length === 0) return;
    const rep = nameOf(names, input.repHrId, "A rep");
    const customerName = typeof (customer.data as Row | null)?.name === "string" ? String((customer.data as Row).name) : "a customer";
    const away =
      input.metres === null || !Number.isFinite(input.metres)
        ? "away from"
        : input.metres < 1000
          ? `${Math.round(input.metres)} m from`
          : `${(input.metres / 1000).toFixed(1)} km from`;
    await createSystemNotificationForRecipients(
      {
        actionUrl: FAR_VISIT_HOLDS_PATH,
        category: PHOENIX_CRM_NOTIFICATION_CATEGORY,
        channels: phoenixCrmChannels("far_visit_stuck"),
        eventType: "far_visit_stuck",
        message:
          `${rep} (${territoryName(input.seat)}) has had ${input.tries} visits to ${customerName} refused today, every one from the same spot, ` +
          `${away} the place saved for this customer. The saved place is probably wrong. Their next visit from that spot is saved and held for SFE approval. ` +
          `Open Visits held for SFE to see the spot on the map and move the place there if it is right.`,
        metadata: { idempotencyKey: `phoenix_crm:far_visit_stuck:${personKey(input.repHrId)}:${input.customerId}:${input.visitDate}`, seatId: input.seat.seatId },
        module: PHOENIX_CRM_NOTIFICATION_MODULE,
        priority: "normal",
        recordId: input.customerId,
        subjectHrId: input.repHrId,
        telegram: { ctaLabel: "Open visits held for SFE", ctaUrl: FAR_VISIT_HOLDS_PATH },
        title: `Rep stuck at one spot: ${rep}, ${customerName}`,
      },
      recipients,
    );
  } catch (error) {
    logError("Phoenix CRM stuck-rep alert failed", { error, labels: { event: "phoenix_crm_far_visit_stuck_notify_failed" } });
  }
}

// ── C · the SFE's decision, and the readers that must know a visit is held ──────────────────────

/**
 * The holds still waiting for the SFE, or refused by him, on visits dated `from` to `to` (Cairo visit days),
 * by visit id — what a screen reading the RAW visits needs to say what the countable views say. An approved
 * hold counts, so it is never read. One read, whatever the number of visits: the table holds only these
 * holds. A failed read throws — a reader must never count a held visit.
 */
export async function loadUncountedFarVisitHolds(range: { from: string; to: string }): Promise<Map<string, FarVisitHoldStatus>> {
  const statuses = new Map<string, FarVisitHoldStatus>();
  const page = 1000;
  for (let start = 0; ; start += page) {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_far_visit_holds")
      .select("visit_id, status")
      .neq("status", "approved")
      .gte("visit_date", range.from)
      .lte("visit_date", range.to)
      .order("visit_id", { ascending: true })
      .range(start, start + page - 1);
    throwIfError(error);
    const rows = (data ?? []) as Row[];
    for (const row of rows) {
      const status = parseFarVisitHoldStatus(row.status);
      if (status) statuses.set(String(row.visit_id), status);
    }
    if (rows.length < page) break;
  }
  return statuses;
}

/**
 * The hold carries the visit's own day, as the save dated it — the readers above find it by that day. The
 * save answers with the day only after the hold is written, so it is stamped here; a failed stamp leaves the
 * capture day, which is the same day for every visit that was not held on the phone.
 */
export async function stampFarVisitHoldDay(visitId: string, visitDate: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) return;
  try {
    const { error } = await getSupabaseAdmin().from("phoenix_crm_far_visit_holds").update({ visit_date: visitDate }).eq("visit_id", visitId).neq("visit_date", visitDate);
    if (error) console.error("[phoenix-crm] far visit hold day not stamped", { visitId, message: error.message });
  } catch (error) {
    console.error("[phoenix-crm] far visit hold day not stamped", { visitId, error });
  }
}

export type FarVisitHoldDecision = { visitId: string; status: FarVisitHoldStatus; decidedAt: string };

/**
 * The SFE's answer on a held visit: approve (it counts, from its own day) or refuse (it never counts).
 * The Super Admin and the SFE Manager only. A second press of the same answer is the answer already
 * given, never an error; the opposite answer on a decided visit is refused — it was decided.
 */
export async function decideFarVisitHold(viewer: PhoenixCrmViewer, raw: unknown): Promise<FarVisitHoldDecision> {
  if (!canDecideFarVisitHolds(viewer)) throw forbiddenError("Only the SFE Manager or the Super Admin decides a held visit.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.visitId)) throw validationError("Choose the held visit to decide.");
  const visitId = String(body.visitId).toLowerCase();
  const decision = body.decision === "approve" ? "approved" : body.decision === "refuse" ? "refused" : null;
  if (!decision) throw validationError("Choose Approve or Refuse.");
  const note = cleanText(body.note, 500);
  const supabase = getSupabaseAdmin();
  const decidedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("phoenix_crm_far_visit_holds")
    .update({ status: decision, decided_by_hr_id: viewer.hrId.toUpperCase(), decided_at: decidedAt, decision_note: note })
    .eq("visit_id", visitId)
    .eq("status", "sfe_pending")
    .select("visit_id, status, decided_at")
    .maybeSingle();
  throwIfError(error);
  if (data) return { visitId, status: decision, decidedAt: String((data as Row).decided_at) };
  const { data: current, error: readError } = await supabase.from("phoenix_crm_far_visit_holds").select("status, decided_at").eq("visit_id", visitId).maybeSingle();
  throwIfError(readError);
  if (!current) throw notFoundError("This held visit is no longer on the list. Reload the page.");
  const status = parseFarVisitHoldStatus((current as Row).status);
  if (status === decision) return { visitId, status, decidedAt: String((current as Row).decided_at) };
  throw validationError("This held visit was already decided. Reload the page.");
}

export type FarVisitHoldRow = {
  visitId: string;
  status: FarVisitHoldStatus;
  seatId: string;
  territory: string;
  repName: string;
  customerName: string;
  visitDate: string;
  heldAt: string;
  tries: number;
  distanceMeters: number | null;
  farMeters: number;
  placeId: string | null;
  /** Where the rep stood, as the try map draws it (marker 1), with the tries' spread as its accuracy. */
  spot: { lat: number; lon: number; accuracyMeters: number | null } | null;
  place: { lat: number; lon: number; address: string | null } | null;
  /** The rep's spot beside the customer's saved place, the refused-readings board's own small map. */
  map: CaseMap | null;
  decidedBy: string | null;
  decidedAt: string | null;
  isTest: boolean;
};

export const HOLD_SPOT_LABEL = "Where the rep stood";
export const HOLD_PLACE_LABEL = "Customer's saved place";
const HOLD_MAP_SIZE = { width: 256, height: 256, padding: 32 };

/** The days of decided holds the page keeps beside the waiting ones. */
export const FAR_VISIT_HOLDS_DECIDED_DAYS = 14;

/**
 * The held visits for the page: every one still waiting, and those decided in the last 14 days. A hold
 * whose visit never saved (the save failed after the hold was written) names no visit and is left out.
 */
export async function loadFarVisitHolds(viewer: PhoenixCrmViewer): Promise<FarVisitHoldRow[]> {
  if (!canDecideFarVisitHolds(viewer)) throw forbiddenError("Only the SFE Manager or the Super Admin reads the held visits.");
  const supabase = getSupabaseAdmin();
  const since = new Date(Date.now() - FAR_VISIT_HOLDS_DECIDED_DAYS * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("phoenix_crm_far_visit_holds")
    .select("visit_id, status, seat_id, rep_hr_id, customer_id, place_id, distance_meters, far_meters, tries, spot_lat, spot_lon, visit_date, is_test, held_at, decided_by_hr_id, decided_at")
    .or(`status.eq.sfe_pending,decided_at.gte.${since}`)
    .order("held_at", { ascending: false })
    .limit(300);
  throwIfError(error);
  const holds = (data ?? []) as Row[];
  if (holds.length === 0) return [];
  const visitIds = holds.map((row) => String(row.visit_id));
  const customerIds = [...new Set(holds.map((row) => String(row.customer_id)))];
  const placeIds = [...new Set(holds.map((row) => (row.place_id ? String(row.place_id) : null)).filter((id): id is string => id !== null))];
  const [visits, customers, places, people] = await Promise.all([
    supabase.from("phoenix_crm_visits").select("id").in("id", visitIds).is("imported_from_ireports360_at", null),
    supabase.from("phoenix_crm_customers").select("id, name").in("id", customerIds),
    placeIds.length > 0 ? supabase.from("phoenix_crm_places").select("id, lat, lon, address").in("id", placeIds) : Promise.resolve({ data: [], error: null }),
    loadPeopleNames([...holds.map((row) => String(row.rep_hr_id)), ...holds.map((row) => (row.decided_by_hr_id ? String(row.decided_by_hr_id) : "")).filter(Boolean)]),
  ]);
  throwIfError(visits.error);
  throwIfError(customers.error);
  throwIfError(places.error);
  const saved = new Set(((visits.data ?? []) as Row[]).map((row) => String(row.id)));
  const customerName = new Map(((customers.data ?? []) as Row[]).map((row) => [String(row.id), String(row.name ?? "")]));
  const placeById = new Map(((places.data ?? []) as Row[]).map((row) => [String(row.id), row]));
  const out: FarVisitHoldRow[] = [];
  for (const row of holds) {
    const visitId = String(row.visit_id);
    if (!saved.has(visitId)) continue;
    const status = parseFarVisitHoldStatus(row.status);
    if (!status) continue;
    const seatId = String(row.seat_id);
    const seat = viewer.org.seats.get(seatId);
    const placeRow = row.place_id ? placeById.get(String(row.place_id)) : undefined;
    const placeLat = placeRow ? numberOrNull(placeRow.lat) : null;
    const placeLon = placeRow ? numberOrNull(placeRow.lon) : null;
    const spotLat = numberOrNull(row.spot_lat);
    const spotLon = numberOrNull(row.spot_lon);
    const spot = spotLat !== null && spotLon !== null ? { lat: spotLat, lon: spotLon, accuracyMeters: null } : null;
    const place = placeLat !== null && placeLon !== null ? { lat: placeLat, lon: placeLon, address: typeof placeRow?.address === "string" ? placeRow.address : null } : null;
    const map = spot
      ? buildCaseMap(
          [
            { label: HOLD_SPOT_LABEL, lat: spot.lat, lon: spot.lon, accuracyMeters: null },
            ...(place ? [{ label: HOLD_PLACE_LABEL, lat: place.lat, lon: place.lon, accuracyMeters: null }] : []),
          ],
          HOLD_MAP_SIZE,
        )
      : null;
    out.push({
      visitId,
      status,
      seatId,
      territory: seat ? territoryName(seat) : "A territory no longer on the team",
      repName: nameOf(people, String(row.rep_hr_id), "A rep"),
      customerName: customerName.get(String(row.customer_id)) || "A customer",
      visitDate: String(row.visit_date),
      heldAt: String(row.held_at),
      tries: Number(row.tries) || 0,
      distanceMeters: numberOrNull(row.distance_meters),
      farMeters: Number(row.far_meters) || 0,
      placeId: row.place_id ? String(row.place_id) : null,
      spot,
      place,
      map,
      decidedBy: row.decided_by_hr_id ? nameOf(people, String(row.decided_by_hr_id)) || null : null,
      decidedAt: typeof row.decided_at === "string" ? row.decided_at : null,
      isTest: row.is_test === true,
    });
  }
  return out;
}
