/**
 * Phoenix CRM — the Phoenix Camera's items and the Super Admin's camera page (owner, 20 Nov 2026).
 *
 * Every photo the camera sends lands here as one `phoenix_crm_camera_items` row — "every camera visit and
 * validation lands there" — and nothing the camera sends is refused: "Phoenix will not reject anything ... leave the
 * decision to the decision maker." 🔴 NOTHING RECORDS ITSELF (owner, 21 Nov 2026: "EVERY VISIT GOES TO MANUAL REVIEW
 * FIRST"): every item arrives waiting and only the Super Admin's Approve records it, up to the rep's allowance for
 * that day (3, raised for one day only on the manager's email approval). The rules are pure, in
 * `camera-item-rules.ts`; this file is their I/O.
 *
 * 🔴 THE SUPER ADMIN ALONE (`canEnterMissedRecords`), NEVER THE SFE ("Exclude the SFE totally"). His Approve of a
 * visit goes through his own "Record a missed visit" door (`enterMissedVisit`), in his name; a validation is the
 * seal's own (`validateWithRepSeal`, the rep's photo slot, his decision); a new customer is added to the rep's list
 * (`phoenix_crm_camera_add_customer`) and validated at the photo's place. Reject archives the item; on an item that
 * was recorded at once before 21 Nov 2026 it also deletes the visit (`adminDeleteRecord`) and refuses the place
 * (`refuseValidatedPlace`), so a rejected item leaves nothing counted.
 *
 * 🔴 Golden rule #1: the rep's phone reads "sent" and nothing else. Every reason, number and check is here.
 */

import { ApiError, conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import {
  CAMERA_DAILY_CAP_DEFAULT,
  CAMERA_REVIEWS_PATH,
  CAMERA_INTENT_LABELS,
  CAMERA_PHOTO_KIND_LABELS,
  CAMERA_REASON_LABELS,
  cairoClockOf,
  cameraAlreadySavedText,
  cameraApproveAllowed,
  cameraArrival,
  cameraDayAllowance,
  cameraSenderName,
  cameraTakenAt,
  cameraVisitDayKey,
  cameraVisitDraft,
  isNamePhoto,
  parseCameraCap,
  parseCameraDayAllowance,
  type CameraIntent,
  type CameraItemRow,
  type CameraOutcome,
  type CameraPageView,
  type CameraPhotoKind,
  type CameraReason,
  type CameraTab,
  type CameraTimeSource,
} from "@/lib/phoenix-crm/camera-item-rules";
import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import type { SealPayload } from "@/lib/phoenix-crm/field-camera/seal-rules";
import { deriveOfflineCaptureTime } from "@/lib/phoenix-crm/offline-clock";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { seatOccupants, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { UNPLANNED_REASON_MIN } from "@/lib/phoenix-crm/unplanned-rules";
import { canEnterMissedRecords, territoryForMissedRecord, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { adminDeleteRecord } from "@/lib/phoenix-crm/server/admin-delete";
import { sealedPosition, validateWithRepSeal } from "@/lib/phoenix-crm/server/admin-photo";
import { callPhoenixCrm, numberOrNull, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { inspectFieldCameraPhoto, type FieldCameraReport } from "@/lib/phoenix-crm/server/field-camera";
import { enterMissedVisit } from "@/lib/phoenix-crm/server/missed-records";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { readSealedNamePhoto } from "@/lib/phoenix-crm/server/signboard-check";
import { readTimeAnchor } from "@/lib/phoenix-crm/server/time-anchor";
import { refuseValidatedPlace } from "@/lib/phoenix-crm/server/validation-reviews";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

export { CAMERA_REVIEWS_PATH };
export const CAMERA_BUCKET = "phoenix-field-camera";
const ITEMS_TABLE = "phoenix_crm_camera_items";
/** What the phone is told about every item it sent, whatever became of it (golden rule #1). */
export const CAMERA_RECEIVED = { success: true as const, status: "received" as const };

const ITEM_COLUMNS =
  "id, intent, seat_id, line_code, rep_hr_id, customer_id, proposed_customer, is_test, photo_path, photo_kind, seal_id, seal_holds, seal_problems, location_problems, seal_report, seal_payload, location_status, lat, lon, accuracy_meters, fix_age_ms, taken_at, time_source, taken_day, received_at, visit_draft, outcome, reasons, rule_refusal, visit_id, validated_place_id, reader, decision, decided_by_hr_id, decided_at, decision_note";

// ── The daily limit ─────────────────────────────────────────────────────────────────────────────

export async function loadCameraDailyCap(): Promise<number> {
  const { data, error } = await getSupabaseAdmin().from("phoenix_crm_settings").select("camera_daily_cap").eq("id", 1).maybeSingle();
  throwIfError(error);
  return parseCameraCap((data as Row | null)?.camera_daily_cap) ?? CAMERA_DAILY_CAP_DEFAULT;
}

export async function saveCameraDailyCap(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ cap: number }> {
  assertCameraDecider(viewer);
  const cap = parseCameraCap((raw as Row | null)?.cap);
  if (cap === null) throw validationError("Write a whole number from 1 to 20.");
  const { error } = await getSupabaseAdmin()
    .from("phoenix_crm_settings")
    .update({ camera_daily_cap: cap, updated_at: new Date().toISOString(), updated_by_hr_id: viewer.hrId })
    .eq("id", 1);
  throwIfError(error);
  return { cap };
}

// ── The one-day allowance (owner, 21 Nov 2026) ──────────────────────────────────────────────────

const ALLOWANCES_TABLE = "phoenix_crm_camera_day_allowances";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The Phoenix day a camera item belongs to: the photo's own day, else the day it arrived. */
function itemDay(row: Row): string {
  return textOrNull(row.taken_day) ?? cairoBusinessDay(new Date(String(row.received_at)));
}

type DayRaise = { allowance: number; setBy: string; managerApproval: string };

async function loadDayRaise(repHrId: string, day: string, isTest: boolean): Promise<DayRaise | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(ALLOWANCES_TABLE)
    .select("allowance, manager_approval, set_by_hr_id")
    .eq("rep_hr_id", repHrId)
    .eq("day", day)
    .eq("is_test", isTest)
    .maybeSingle();
  throwIfError(error);
  const row = data as Row | null;
  if (!row) return null;
  return { allowance: Number(row.allowance), setBy: String(row.set_by_hr_id ?? ""), managerApproval: String(row.manager_approval ?? "") };
}

/** Camera visits already recorded for this rep on this Phoenix day: approved, or recorded at once before 21 Nov. */
async function approvedVisitsThatDay(repHrId: string, day: string, isTest: boolean): Promise<number> {
  const admin = getSupabaseAdmin();
  const base = () =>
    admin.from(ITEMS_TABLE).select("taken_day, received_at").eq("rep_hr_id", repHrId).eq("is_test", isTest).eq("intent", "visit").eq("outcome", "recorded");
  const [onDay, noDay] = await Promise.all([base().eq("taken_day", day), base().is("taken_day", null)]);
  throwIfError(onDay.error);
  throwIfError(noDay.error);
  const undated = ((noDay.data ?? []) as Row[]).filter((row) => itemDay(row) === day).length;
  return ((onDay.data ?? []) as Row[]).length + undated;
}

/** Camera visits this rep SENT for the photo's own day and not rejected, before this one. */
async function sentVisitsThatDay(repHrId: string, takenDay: string | null, isTest: boolean): Promise<number> {
  if (!takenDay) return 0;
  const { count, error } = await getSupabaseAdmin()
    .from(ITEMS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("rep_hr_id", repHrId)
    .eq("taken_day", takenDay)
    .eq("is_test", isTest)
    .eq("intent", "visit")
    .neq("outcome", "archived");
  throwIfError(error);
  return count ?? 0;
}

export type CameraDayFacts = { day: string; allowance: number; approved: number; raisedBy: string | null; managerApproval: string | null };

async function cameraDayFacts(repHrId: string, day: string, isTest: boolean, cap: number): Promise<CameraDayFacts> {
  const [raise, approved] = await Promise.all([loadDayRaise(repHrId, day, isTest), approvedVisitsThatDay(repHrId, day, isTest)]);
  return {
    day,
    allowance: cameraDayAllowance(cap, raise?.allowance ?? null),
    approved,
    raisedBy: raise?.setBy || null,
    managerApproval: raise?.managerApproval || null,
  };
}

/**
 * The Super Admin raises ONE rep's camera visits for ONE Phoenix day, once the manager's approval is in by email
 * (owner, 21 Nov 2026: "SYSTEM ADMIN WILL UPDATE IT FOR THIS DAY ONLY"). The approval is written beside it, and it
 * cannot go below the visits already approved that day.
 */
export async function saveCameraDayAllowance(viewer: PhoenixCrmViewer, raw: unknown): Promise<CameraDayFacts> {
  assertCameraDecider(viewer);
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.itemId)) throw validationError("Choose the camera visit. Reload the page and try again.");
  const allowance = parseCameraDayAllowance(body.allowance);
  if (allowance === null) throw validationError("Write a whole number from 1 to 20.");
  const managerApproval = typeof body.managerApproval === "string" ? body.managerApproval.trim() : "";
  if (managerApproval.length < 3) throw validationError("Write the manager's email approval: who approved it and when.");
  if (managerApproval.length > 500) throw validationError("Keep the manager's approval under 500 characters.");

  const admin = getSupabaseAdmin();
  const read = await admin
    .from(ITEMS_TABLE)
    .select("id, intent, rep_hr_id, is_test, taken_day, received_at")
    .eq("id", String(body.itemId).toLowerCase())
    .maybeSingle();
  throwIfError(read.error);
  const item = read.data as Row | null;
  if (!item) throw notFoundError("This item is no longer there.");
  if (item.intent !== "visit") throw validationError("Only a camera visit has a day's allowance.");
  const repHrId = String(item.rep_hr_id ?? "").trim().toUpperCase();
  const isTest = item.is_test === true;
  const day = itemDay(item);
  if (!DAY_PATTERN.test(day)) throw validationError("This visit has no day to raise.");
  const approved = await approvedVisitsThatDay(repHrId, day, isTest);
  if (allowance < approved) throw validationError(`${approved} camera visits are already approved that day. Write ${approved} or more.`);

  const { error } = await admin.from(ALLOWANCES_TABLE).upsert(
    {
      rep_hr_id: repHrId,
      day,
      is_test: isTest,
      allowance,
      manager_approval: managerApproval,
      set_by_hr_id: viewer.hrId.trim().toUpperCase(),
      set_at: new Date().toISOString(),
    },
    { onConflict: "rep_hr_id,day,is_test" },
  );
  throwIfError(error);
  return cameraDayFacts(repHrId, day, isTest, await loadCameraDailyCap());
}

function assertCameraDecider(viewer: PhoenixCrmViewer): void {
  if (!canEnterMissedRecords(viewer)) throw forbiddenError("Only the Super Admin decides the camera's items.");
}

// ── Arrival: the camera's sync ──────────────────────────────────────────────────────────────────

type CustomerFacts = { name: string; listType: PhoenixCrmListType; seatId: string; isTest: boolean; hasPlace: boolean };

async function loadCustomerFacts(customerId: string): Promise<CustomerFacts | null> {
  const admin = getSupabaseAdmin();
  const [customer, places] = await Promise.all([
    admin.from("phoenix_crm_customers").select("id, name, list_type, seat_id, is_test").eq("id", customerId).maybeSingle(),
    admin.from("phoenix_crm_places").select("id").eq("customer_id", customerId).eq("status", "active").limit(1),
  ]);
  throwIfError(customer.error);
  throwIfError(places.error);
  const row = customer.data as Row | null;
  if (!row) return null;
  return {
    name: String(row.name ?? ""),
    listType: String(row.list_type ?? "PM") as PhoenixCrmListType,
    seatId: String(row.seat_id ?? ""),
    isTest: row.is_test === true,
    hasPlace: ((places.data ?? []) as Row[]).length > 0,
  };
}

async function storeItemPhoto(itemId: string, isTest: boolean, bytes: Uint8Array): Promise<string> {
  const path = `items/${isTest ? "test/" : ""}${itemId}.jpg`;
  const { error } = await getSupabaseAdmin()
    .storage.from(CAMERA_BUCKET)
    .upload(path, Buffer.from(bytes), { contentType: "image/jpeg", upsert: true });
  if (error) throw new ApiError(503, "storage_unavailable", "The photo could not be kept. The app sends it again.");
  return path;
}

/**
 * One sealed photo from the camera. Never refuses what it can read and never records it: it waits for the Super
 * Admin (or is archived when too old), and the phone is told "received" either way. A resend of the same item (same
 * visit id) is the same row and does nothing twice.
 */
export async function receiveCameraItem(input: {
  viewer: PhoenixCrmViewer;
  seat: OrgSeat;
  isTest: boolean;
  bytes: Uint8Array;
  draft: Record<string, unknown>;
  receivedAt?: Date;
}): Promise<typeof CAMERA_RECEIVED> {
  const { viewer, seat, isTest, bytes, draft } = input;
  const receivedAt = input.receivedAt ?? new Date();
  const repHrId = viewer.hrId.trim().toUpperCase();
  const inspection = await inspectFieldCameraPhoto(bytes, { occupantHrIds: seatOccupants(seat), viewerHrId: repHrId, seatId: seat.seatId });
  const payload = inspection.payload;
  const visit = payload?.visit ?? null;
  if (!payload || !visit || !isUuid(visit.visitId)) {
    throw validationError("This photo was not taken for a customer. Take it again from the customer.", "phoenix_crm_field_camera_no_visit");
  }
  const itemId = visit.visitId.toLowerCase();

  const admin = getSupabaseAdmin();
  const existing = await admin.from(ITEMS_TABLE).select("id").eq("id", itemId).maybeSingle();
  throwIfError(existing.error);
  if (existing.data) return CAMERA_RECEIVED;

  const intent: CameraIntent = visit.intent;
  const photoKind: CameraPhotoKind = visit.photoKind;
  let customer: CustomerFacts | null = null;
  if (intent !== "new_customer") {
    if (!isUuid(visit.customerId)) throw validationError("This photo names no customer. Take it again from the customer.");
    customer = await loadCustomerFacts(visit.customerId.toLowerCase());
    // A customer who is not on this territory's list cannot be filed under it; nothing about it can be decided.
    if (!customer || customer.seatId !== seat.seatId) {
      throw validationError("This customer is not on your list. Record the visit in Phoenix CRM.", "phoenix_crm_field_camera_other_customer");
    }
  }

  // The time: Phoenix's anchor (inside the seal), else the satellites, else not confirmed.
  let anchorCapturedAt: Date | null = null;
  if (inspection.sealHolds && visit.offline) {
    const anchor = await readTimeAnchor(visit.offline.anchorId).catch(() => null);
    const verdict = deriveOfflineCaptureTime(anchor, visit.offline, { receivedAt, hrId: repHrId, seatId: seat.seatId });
    if (verdict.ok) anchorCapturedAt = verdict.capturedAt;
  }
  const time = cameraTakenAt({ anchorCapturedAt, sealHolds: inspection.sealHolds, timeSource: payload.timeSource, takenAtUtc: payload.takenAtUtc });
  const takenDay = time.takenAt ? cairoBusinessDay(time.takenAt) : null;
  const cap = await loadCameraDailyCap();
  const [sentThatDay, raise]: [number, DayRaise | null] =
    intent === "visit" && takenDay
      ? await Promise.all([sentVisitsThatDay(repHrId, takenDay, isTest), loadDayRaise(repHrId, takenDay, isTest)])
      : [0, null];
  const arrival = cameraArrival({
    intent,
    sealHolds: inspection.sealHolds,
    locationProblems: inspection.locationProblems,
    time,
    receivedAt,
    sentThatDay,
    allowance: cameraDayAllowance(cap, raise?.allowance ?? null),
  });

  const photoPath = await storeItemPhoto(itemId, isTest, bytes);
  const reasons: CameraReason[] = [...arrival.reasons];
  const outcome: CameraOutcome = arrival.outcome;
  let reader: unknown = null;

  // A name photo for a customer with no place yet: the reader's verdict is written beside it for the Super Admin
  // (owner, point 6). A business card always waits as a name photo: it counts only with a location inside the
  // polyclinic, which he judges. Nothing is validated here: his Approve validates it.
  if (outcome === "waiting" && customer && !customer.hasPlace && !inspection.alreadyUsed && isNamePhoto(photoKind)) {
    if (photoKind === "business_card") {
      reasons.push("name_photo");
    } else {
      const reading = await readSealedNamePhoto({ bytes, customerName: customer.name, listType: customer.listType }).catch(() => null);
      reader = reading;
      if (!reading || reading.verdict !== "match") reasons.push("name_photo");
    }
  }

  const { error } = await admin.from(ITEMS_TABLE).insert({
    id: itemId,
    intent,
    seat_id: seat.seatId,
    line_code: seat.lineCode,
    rep_hr_id: repHrId,
    customer_id: customer ? visit.customerId.toLowerCase() : null,
    proposed_customer: intent === "new_customer" ? visit.newCustomer : null,
    is_test: isTest,
    photo_path: photoPath,
    photo_kind: photoKind,
    seal_id: inspection.report?.sealId ?? null,
    seal_holds: inspection.sealHolds,
    seal_problems: inspection.sealProblems,
    location_problems: inspection.locationProblems,
    seal_report: inspection.report,
    seal_payload: payload,
    location_status: payload.locationStatus,
    lat: payload.lat,
    lon: payload.lat === null ? null : payload.lon,
    accuracy_meters: payload.accuracyMeters,
    fix_age_ms: payload.fixAgeMs,
    taken_at: time.takenAt?.toISOString() ?? null,
    time_source: time.source,
    taken_day: arrival.takenDay,
    received_at: receivedAt.toISOString(),
    visit_draft: intent === "visit" ? draft : null,
    outcome,
    reasons,
    rule_refusal: null,
    visit_id: null,
    validated_place_id: null,
    reader,
  });
  // A second send that raced the first one is the same item: the first row stands.
  if (error && (error as { code?: string }).code !== "23505") throwIfError(error);
  return CAMERA_RECEIVED;
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────

export type { CameraItemRow, CameraPageView, CameraTab };

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)).filter(Boolean) : [];
}

function approveFacts(row: Row, day: CameraDayFacts | null, savedAt: string | null | undefined): { label: string | null; cannot: string | null } {
  if (row.decision !== null && row.decision !== undefined) return { label: null, cannot: null };
  if (row.outcome !== "waiting") return { label: null, cannot: null };
  const intent = String(row.intent) as CameraIntent;
  // Already saved that day: Record would be refused (already_visited), so the row says so before he clicks.
  if (intent === "visit" && savedAt !== undefined) return { label: null, cannot: cameraAlreadySavedText(savedAt) };
  const hasPosition = row.lat !== null && row.lat !== undefined;
  if (intent === "new_customer") {
    return hasPosition ? { label: "Add to the rep's list", cannot: null } : { label: null, cannot: "No location: it cannot become the customer's place." };
  }
  if (intent === "validate") {
    return hasPosition ? { label: "Validate", cannot: null } : { label: null, cannot: "No location: it cannot become the customer's place." };
  }
  if (day) {
    const allowed = cameraApproveAllowed(day.approved, day.allowance);
    if (!allowed.ok) return { label: null, cannot: allowed.reason };
  }
  return { label: "Record the visit", cannot: null };
}

export async function loadCameraPage(viewer: PhoenixCrmViewer, rawTab: unknown): Promise<CameraPageView> {
  assertCameraDecider(viewer);
  const tab: CameraTab = rawTab === "recorded" || rawTab === "archive" ? rawTab : "waiting";
  const admin = getSupabaseAdmin();
  const [list, waiting, cap] = await Promise.all([
    admin.from(ITEMS_TABLE).select(ITEM_COLUMNS).eq("outcome", tab === "archive" ? "archived" : tab).order("received_at", { ascending: false }).limit(200),
    admin.from(ITEMS_TABLE).select("id", { count: "exact", head: true }).eq("outcome", "waiting"),
    loadCameraDailyCap(),
  ]);
  throwIfError(list.error);
  throwIfError(waiting.error);
  const rows = (list.data ?? []) as Row[];

  const customerIds = [...new Set(rows.map((row) => textOrNull(row.customer_id)).filter((id): id is string => Boolean(id)))];
  const customers = new Map<string, string>();
  if (customerIds.length > 0) {
    const read = await admin.from("phoenix_crm_customers").select("id, name").in("id", customerIds);
    throwIfError(read.error);
    for (const entry of (read.data ?? []) as Row[]) customers.set(String(entry.id), String(entry.name ?? ""));
  }
  const people = [...new Set(rows.flatMap((row) => [textOrNull(row.rep_hr_id), textOrNull(row.decided_by_hr_id)]).filter((id): id is string => Boolean(id)))];
  // Each waiting camera visit's day: its allowance and how many are already approved (one read per rep-day).
  const dayFacts = new Map<string, CameraDayFacts>();
  const dayKey = (row: Row) => `${String(row.rep_hr_id ?? "").trim().toUpperCase()}|${itemDay(row)}|${row.is_test === true}`;
  const waitingVisits = rows.filter((row) => row.outcome === "waiting" && row.intent === "visit");
  await Promise.all(
    [...new Map(waitingVisits.map((row) => [dayKey(row), row])).entries()].map(async ([key, row]) => {
      dayFacts.set(key, await cameraDayFacts(String(row.rep_hr_id ?? "").trim().toUpperCase(), itemDay(row), row.is_test === true, cap));
    }),
  );
  for (const facts of dayFacts.values()) if (facts.raisedBy) people.push(facts.raisedBy);
  // Each waiting camera visit whose customer already has a visit saved on that seat and day: the earliest one's time.
  const savedVisits = await loadSavedVisitTimes(waitingVisits);
  const names = await loadPeopleNames(people);
  const urls = new Map<string, string>();
  const paths = rows.map((row) => textOrNull(row.photo_path)).filter((path): path is string => Boolean(path));
  if (paths.length > 0) {
    const signed = await admin.storage.from(CAMERA_BUCKET).createSignedUrls(paths, 15 * 60);
    for (const entry of signed.data ?? []) if (entry.path && entry.signedUrl) urls.set(entry.path, entry.signedUrl);
  }

  return {
    tab,
    cap,
    waitingCount: waiting.count ?? 0,
    rows: rows.map((row) => {
      const intent = String(row.intent) as CameraIntent;
      const report = (row.seal_report && typeof row.seal_report === "object" ? row.seal_report : null) as Row | null;
      const readerRow = (row.reader && typeof row.reader === "object" ? row.reader : null) as Row | null;
      const fixAge = numberOrNull(row.fix_age_ms);
      const day = row.outcome === "waiting" && row.intent === "visit" ? (dayFacts.get(dayKey(row)) ?? null) : null;
      const savedKey = cameraVisitDayKey({ seatId: row.seat_id, customerId: row.customer_id, day: itemDay(row), isTest: row.is_test });
      const facts = approveFacts(row, day, row.outcome === "waiting" && row.intent === "visit" && savedVisits.has(savedKey) ? (savedVisits.get(savedKey) ?? null) : undefined);
      const repHrId = String(row.rep_hr_id ?? "");
      const decidedBy = textOrNull(row.decided_by_hr_id);
      return {
        id: String(row.id),
        intent,
        intentLabel: CAMERA_INTENT_LABELS[intent] ?? intent,
        photoKindLabel: CAMERA_PHOTO_KIND_LABELS[String(row.photo_kind) as CameraPhotoKind] ?? String(row.photo_kind),
        isTest: row.is_test === true,
        repName: cameraSenderName(nameOf(names, repHrId, repHrId), row.is_test === true),
        seatId: String(row.seat_id ?? ""),
        customerName: textOrNull(row.customer_id) ? (customers.get(String(row.customer_id)) ?? null) : null,
        proposedCustomer: (row.proposed_customer && typeof row.proposed_customer === "object" ? row.proposed_customer : null) as Record<string, unknown> | null,
        photoUrl: textOrNull(row.photo_path) ? (urls.get(String(row.photo_path)) ?? null) : null,
        sealHolds: row.seal_holds === true,
        sealProblems: strings(row.seal_problems),
        locationProblems: strings(row.location_problems),
        warnings: strings(report?.warnings),
        locationStatus: textOrNull(row.location_status),
        lat: numberOrNull(row.lat),
        lon: numberOrNull(row.lon),
        accuracyMeters: numberOrNull(row.accuracy_meters),
        fixGapSeconds: fixAge === null ? null : Math.round(fixAge / 1000),
        takenAt: textOrNull(row.taken_at),
        timeSource: String(row.time_source) as CameraTimeSource,
        takenDay: textOrNull(row.taken_day),
        receivedAt: String(row.received_at),
        outcome: String(row.outcome) as CameraOutcome,
        reasons: strings(row.reasons).map((key) => ({ key: key as CameraReason, label: CAMERA_REASON_LABELS[key as CameraReason] ?? key })),
        ruleRefusal: textOrNull(row.rule_refusal),
        readerVerdict: textOrNull(readerRow?.verdict),
        readerText: textOrNull(readerRow?.signText),
        visitId: textOrNull(row.visit_id),
        validatedPlaceId: textOrNull(row.validated_place_id),
        decision: row.decision === "approved" || row.decision === "rejected" ? row.decision : null,
        decidedByName: decidedBy ? nameOf(names, decidedBy, decidedBy) : null,
        decidedAt: textOrNull(row.decided_at),
        decisionNote: textOrNull(row.decision_note),
        approveLabel: facts.label,
        cannotApprove: facts.cannot,
        allowanceDay: day ? { ...day, raisedBy: day.raisedBy ? nameOf(names, day.raisedBy, day.raisedBy) : null } : null,
      };
    }),
  };
}

/**
 * The visits already saved for the waiting camera visits' customers, keyed like the visit insert's own
 * already_visited refusal (seat, customer, visit day, test world; an archived visit refuses too), with the earliest
 * capture time of each. One read for the whole page.
 */
async function loadSavedVisitTimes(waitingVisits: Row[]): Promise<Map<string, string | null>> {
  const saved = new Map<string, string | null>();
  const withCustomer = waitingVisits.filter((row) => textOrNull(row.customer_id));
  if (withCustomer.length === 0) return saved;
  const customerIds = [...new Set(withCustomer.map((row) => String(row.customer_id)))];
  const days = [...new Set(withCustomer.map((row) => itemDay(row)))];
  const read = await getSupabaseAdmin()
    .from("phoenix_crm_visits")
    .select("seat_id, customer_id, visit_date, is_test, captured_at")
    .in("customer_id", customerIds)
    .in("visit_date", days);
  throwIfError(read.error);
  for (const visit of (read.data ?? []) as Row[]) {
    const key = cameraVisitDayKey({ seatId: visit.seat_id, customerId: visit.customer_id, day: visit.visit_date, isTest: visit.is_test });
    const at = textOrNull(visit.captured_at);
    const kept = saved.get(key);
    if (!saved.has(key) || (at && (!kept || at < kept))) saved.set(key, at);
  }
  return saved;
}

/** How many items wait for the Super Admin, for his needs-you count. */
export async function countCameraItemsWaiting(): Promise<{ count: number; oldestAt: string | null }> {
  const { data, count, error } = await getSupabaseAdmin()
    .from(ITEMS_TABLE)
    .select("received_at", { count: "exact" })
    .eq("outcome", "waiting")
    .order("received_at", { ascending: true })
    .limit(1);
  throwIfError(error);
  return { count: count ?? 0, oldestAt: textOrNull(((data ?? []) as Row[])[0]?.received_at) };
}

// ── The decision ────────────────────────────────────────────────────────────────────────────────

/** A link to one file in the camera's private bucket (a release APK), or null when it cannot be signed. This file
 * is the only one that opens the bucket (tests/phoenix-crm-boundary.test.ts). */
export async function signCameraFile(path: string, seconds: number): Promise<string | null> {
  const signed = await getSupabaseAdmin().storage.from(CAMERA_BUCKET).createSignedUrl(path, seconds);
  return signed.error || !signed.data?.signedUrl ? null : signed.data.signedUrl;
}

async function loadItemBytes(path: string): Promise<Uint8Array> {
  const { data, error } = await getSupabaseAdmin().storage.from(CAMERA_BUCKET).download(path);
  if (error || !data) throw new ApiError(503, "storage_unavailable", "The photo could not be read. Try again in a minute.");
  return new Uint8Array(await data.arrayBuffer());
}

function sealedOf(row: Row): { payload: SealPayload; report: FieldCameraReport } | null {
  const payload = row.seal_payload && typeof row.seal_payload === "object" ? (row.seal_payload as SealPayload) : null;
  const report = row.seal_report && typeof row.seal_report === "object" ? (row.seal_report as FieldCameraReport) : null;
  return payload && report ? { payload, report } : null;
}

export type CameraDecision = { id: string; decision: "approved" | "rejected"; outcome: CameraOutcome };

export async function decideCameraItem(viewer: PhoenixCrmViewer, raw: unknown): Promise<CameraDecision> {
  assertCameraDecider(viewer);
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.id)) throw validationError("Choose the item to decide. Reload the page and try again.");
  const decision = body.decision === "approved" ? "approved" : body.decision === "rejected" ? "rejected" : null;
  if (!decision) throw validationError("Choose Approve or Reject.");
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  const id = String(body.id).toLowerCase();

  const admin = getSupabaseAdmin();
  const read = await admin.from(ITEMS_TABLE).select(ITEM_COLUMNS).eq("id", id).maybeSingle();
  throwIfError(read.error);
  const row = read.data as Row | null;
  if (!row) throw notFoundError("This item is no longer there.");
  if (row.decision !== null && row.decision !== undefined) throw conflictError("This item is already decided.");
  if (row.outcome === "archived") throw conflictError("This item is in the archive.");
  const isTest = row.is_test === true;
  const repHrId = String(row.rep_hr_id);
  const { seat } = territoryForMissedRecord(viewer, row.seat_id, isTest);
  if (!seat.occupantHrId || seat.occupantHrId.trim().toUpperCase() !== repHrId.trim().toUpperCase()) {
    throw conflictError("The rep who sent this no longer holds the territory, so it cannot be recorded in their name.");
  }

  let visitId = textOrNull(row.visit_id);
  let placeId = textOrNull(row.validated_place_id);
  let customerId = textOrNull(row.customer_id);

  if (decision === "rejected") {
    // An item recorded at once is taken back whole: the visit deleted, the place refused.
    if (row.outcome === "recorded") {
      if (visitId) await adminDeleteRecord(viewer, { kind: "visit", id: visitId, test: isTest });
      if (placeId) {
        if (typeof body.refusalReason !== "string") throw validationError("Choose what is wrong with the photo: the rep is told it.");
        await refuseValidatedPlace(viewer, { placeId, refusalReason: body.refusalReason, note });
      }
    }
  } else {
    const sealed = sealedOf(row);
    const position = sealed ? sealedPosition(sealed.payload) : null;
    const intent = String(row.intent) as CameraIntent;
    const slot = { hrId: repHrId, cairoToday: viewer.cairoToday };
    const bytes = sealed && position ? await loadItemBytes(String(row.photo_path)) : null;

    if (intent === "new_customer") {
      if (!sealed || !position || !bytes) throw validationError("This photo carries no location, so it cannot become the customer's place.");
      const proposed = (row.proposed_customer ?? {}) as Row;
      const grade = typeof proposed.proposedGrade === "string" && /^[ABC]$/.test(proposed.proposedGrade) ? proposed.proposedGrade : null;
      const added = await callPhoenixCrm<Row>("phoenix_crm_camera_add_customer", {
        p: {
          item_id: id,
          actor_hr_id: viewer.hrId,
          list_type: String(proposed.listType ?? "").toUpperCase(),
          name: proposed.name,
          line_code: seat.lineCode,
          speciality: proposed.speciality ?? null,
          customer_type: proposed.customerType ?? null,
          grade,
          potential_grade: null,
          phone: proposed.phone ?? null,
        },
      });
      customerId = String(added.customer_id);
      const validation = await validateWithRepSeal(slot, { seat, isTest, customerId, bytes, sealed, actorHrId: viewer.hrId });
      placeId = validation.placeId;
    } else {
      if (!customerId) throw validationError("This item names no customer.");
      // A second copy of a visit already saved is refused BEFORE the seal validates anything, so a refused Record
      // never leaves a place behind it.
      if (intent === "visit" && !visitId) {
        const saved = await loadSavedVisitTimes([row]);
        const key = cameraVisitDayKey({ seatId: row.seat_id, customerId: row.customer_id, day: itemDay(row), isTest: row.is_test });
        if (saved.has(key)) throw conflictError(cameraAlreadySavedText(saved.get(key) ?? null));
      }
      if (bytes && sealed && !placeId) {
        const validation = await validateWithRepSeal(slot, { seat, isTest, customerId, bytes, sealed, actorHrId: viewer.hrId });
        placeId = validation.placeId ?? placeId;
      } else if (intent === "validate") {
        throw validationError("This photo carries no location, so it cannot become the customer's place.");
      }
      if (intent === "visit" && !visitId) {
        const draft = cameraVisitDraft(row.visit_draft);
        const takenAt = textOrNull(row.taken_at);
        const day = itemDay(row);
        // The rep's allowance for that day (owner, 21 Nov 2026): 3, unless the Super Admin raised that one day.
        const facts = await cameraDayFacts(repHrId.trim().toUpperCase(), day, isTest, await loadCameraDailyCap());
        const allowed = cameraApproveAllowed(facts.approved, facts.allowance);
        if (!allowed.ok) throw conflictError(allowed.reason);
        const reason = draft.planned ? null : draft.reason && draft.reason.length >= UNPLANNED_REASON_MIN ? draft.reason : "Recorded from the Phoenix Camera, off the plan.";
        const entered = await enterMissedVisit(viewer, {
          id,
          seatId: seat.seatId,
          test: isTest,
          customerId,
          visitDate: day > viewer.visitDay ? viewer.visitDay : day,
          visitTime: takenAt ? cairoClockOf(new Date(takenAt)) : null,
          planned: draft.planned,
          kind: draft.kind,
          picked: draft.picked,
          products: draft.products,
          comment: draft.comment,
          reason,
        });
        visitId = entered.visitId;
      }
    }
  }

  const outcome: CameraOutcome = decision === "approved" ? "recorded" : "archived";
  const { error } = await admin
    .from(ITEMS_TABLE)
    .update({
      decision,
      decided_by_hr_id: viewer.hrId.trim().toUpperCase(),
      decided_at: new Date().toISOString(),
      decision_note: note,
      outcome,
      visit_id: decision === "approved" ? visitId : null,
      validated_place_id: decision === "approved" ? placeId : null,
      customer_id: customerId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .is("decision", null);
  throwIfError(error);
  return { id, decision, outcome };
}
