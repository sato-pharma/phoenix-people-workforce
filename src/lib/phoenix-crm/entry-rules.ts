/**
 * Phoenix CRM — what a rep sends to validate a customer or enter a visit, checked with no I/O.
 *
 * Owner, 2026-09-16:
 *   - A customer is validated only with a LIVE photo (the clinic sign or door), the location captured
 *     on the spot, and at least one timing. Reference customers and brand-new ones go the same way.
 *   - A new customer's grade: the rep proposes, the district manager approves.
 *   - Dropping a customer needs a reason and the district manager's approval.
 *   - Each visit records the location check, the products discussed, a live photo and a comment.
 *   - A double visit is the rep with the district manager; a chain visit adds a senior manager
 *     (regional or national). Both count for everyone on them straight away, with no confirmation.
 *
 * Photos never pass through this app: the phone uploads them straight to the private bucket through a
 * signed URL the server issued for one path (photos.ts). Here only the path's shape is checked; the
 * service checks the object exists before it saves.
 */

import { readAccuracyInput } from "@/lib/geo/coordinate-input";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { isUsableFix } from "@/lib/phoenix-crm/geo";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { parseTimings } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmTiming, PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";

export type EntryRuleResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const CUSTOMER_NAME_MAX = 120;
export const PLACE_TEXT_MAX = 200;
export const VISIT_COMMENT_MAX = 1000;
export const DROP_REASON_MAX = 500;
export const VISIT_PRODUCTS_MAX = 12;

export const DROP_REASONS = [
  { key: "moved", label: "Moved away" },
  { key: "retired", label: "Retired or stopped practising" },
  { key: "closed", label: "Clinic or account closed" },
  { key: "not_target", label: "Not a target for our line" },
  { key: "duplicate", label: "Duplicate of another customer" },
  { key: "other", label: "Other (write a note)" },
] as const;

export type DropReason = (typeof DROP_REASONS)[number]["key"];

const DROP_REASON_KEYS = new Set<string>(DROP_REASONS.map((reason) => reason.key));

export function dropReasonLabel(key: string | null): string | null {
  if (!key) return null;
  return DROP_REASONS.find((reason) => reason.key === key)?.label ?? null;
}

export function parseGrade(value: unknown): PhoenixCrmGrade | null {
  const grade = String(value ?? "").trim().toUpperCase();
  return grade === "A" || grade === "B" || grade === "C" ? grade : null;
}

/**
 * A reference grade as iReports360 stores it. The vendor has one "A+" doctor; it reads as A. Anything
 * else unknown is left without a grade rather than guessed.
 */
export function gradeFromReference(value: unknown): PhoenixCrmGrade | null {
  const grade = String(value ?? "").trim().toUpperCase();
  if (grade === "A+") return "A";
  return parseGrade(grade);
}

export function parseListType(value: unknown): PhoenixCrmListType | null {
  const listType = String(value ?? "").trim().toUpperCase();
  return listType === "AM" || listType === "PM" ? listType : null;
}

export function cleanText(value: unknown, max: number): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, max);
}

// ── The evidence captured on the spot ───────────────────────────────────────────────────────────

export type CapturedFix = {
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  /** The phone's clock when the photo was taken, compared with the server's on save. */
  deviceCapturedAt: string | null;
};

export function parseCapturedFix(raw: Record<string, unknown>): EntryRuleResult<CapturedFix> {
  if (!isUsableFix(raw.lat, raw.lon)) {
    return { ok: false, error: "Your location was not captured. Allow location on your phone and capture it again at the clinic." };
  }
  // Not `Number(...)`, which reads "" and " " as 0: a phone that reported no accuracy was saved as a
  // perfect 0 m fix and shown to the manager as "within 0 m". A blank accuracy is unknown.
  const accuracy = readAccuracyInput(raw.accuracyMeters);
  const deviceCapturedAt = typeof raw.deviceCapturedAt === "string" && !Number.isNaN(Date.parse(raw.deviceCapturedAt)) ? raw.deviceCapturedAt : null;
  return {
    ok: true,
    value: {
      lat: Number(raw.lat),
      lon: Number(raw.lon),
      accuracyMeters: accuracy !== null && accuracy >= 0 ? Math.round(accuracy * 10) / 10 : null,
      deviceCapturedAt,
    },
  };
}

// ── Validating a customer (a place with its timings) ────────────────────────────────────────────

/**
 * What the phone may say about a place: its NAME, its photo, its timings, and the raw fix.
 *
 * Owner, 2026-09-23: "the capture location is never editable and its separated when captured to
 * brick area region clean addresss and raw location". So the address, the part of town, the brick,
 * the area and the region are NOT on this type at all — they are derived on the SERVER from the
 * captured coordinates (`placePayload`, server/list.ts) and frozen there. A body that still carries
 * an `address`, `zone` or `brick` key is ignored rather than refused, so a phone still holding the
 * previous bundle keeps validating; its typed address simply stops being read.
 *
 * `label` stays typed: a place's NAME ("Evening clinic") is what the rep calls it, not where it is.
 */
export type PlaceDraft = CapturedFix & {
  label: string | null;
  photoPath: string;
  timings: PhoenixCrmTiming[];
};

export function parsePlaceDraft(raw: unknown): EntryRuleResult<PlaceDraft> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const photoPath = String(body.photoPath ?? "").trim();
  if (!photoPath) return { ok: false, error: "Take a live photo of the clinic sign or door." };
  const fix = parseCapturedFix(body);
  if (!fix.ok) return fix;
  const timings = parseTimings(body.timings);
  if (!timings.ok) return { ok: false, error: timings.error };
  return {
    ok: true,
    value: {
      ...fix.value,
      label: cleanText(body.label, PLACE_TEXT_MAX),
      photoPath,
      timings: timings.timings,
    },
  };
}

export type NewCustomerDraft = {
  listType: PhoenixCrmListType;
  name: string;
  speciality: string | null;
  proposedGrade: PhoenixCrmGrade;
};

export function parseNewCustomer(raw: unknown): EntryRuleResult<NewCustomerDraft> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const listType = parseListType(body.listType);
  if (!listType) return { ok: false, error: "Choose whether this is a doctor (PM) or an account (AM)." };
  const name = cleanText(body.name, CUSTOMER_NAME_MAX);
  if (!name || name.length < 3) return { ok: false, error: "Write the customer's full name." };
  const proposedGrade = parseGrade(body.proposedGrade);
  if (!proposedGrade) return { ok: false, error: "Propose a grade (A, B or C). Your district manager approves it." };
  return { ok: true, value: { listType, name, speciality: cleanText(body.speciality, 80), proposedGrade } };
}

export type DropDraft = { reason: DropReason; note: string | null };

export function parseDropDraft(raw: unknown): EntryRuleResult<DropDraft> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const reason = String(body.reason ?? "").trim();
  if (!DROP_REASON_KEYS.has(reason)) return { ok: false, error: "Choose why this customer should leave your list." };
  const note = cleanText(body.note, DROP_REASON_MAX);
  if (reason === "other" && !note) return { ok: false, error: "Write why this customer should leave your list." };
  return { ok: true, value: { reason: reason as DropReason, note } };
}

// ── A visit ─────────────────────────────────────────────────────────────────────────────────────

export type VisitDraft = CapturedFix & {
  customerId: string;
  kind: PhoenixCrmVisitKind;
  managerHrId: string | null;
  seniorHrId: string | null;
  products: string[];
  comment: string | null;
  photoPath: string;
};

export function parseVisitDraft(raw: unknown): EntryRuleResult<VisitDraft> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!isUuid(body.customerId)) return { ok: false, error: "Choose the customer you visited." };
  const kind = String(body.kind ?? "single").trim();
  if (kind !== "single" && kind !== "double" && kind !== "chain") return { ok: false, error: "Choose who was on the visit." };
  const managerHrId = cleanText(body.managerHrId, 40);
  const seniorHrId = cleanText(body.seniorHrId, 40);
  if ((kind === "double" || kind === "chain") && !managerHrId) {
    return { ok: false, error: "Choose the district manager who was on the visit." };
  }
  if (kind === "chain" && !seniorHrId) return { ok: false, error: "Choose the senior manager who was on the visit." };

  const productsRaw = Array.isArray(body.products) ? body.products : [];
  const products = [...new Set(productsRaw.map((product) => cleanText(product, 80)).filter((product): product is string => Boolean(product)))];
  if (products.length === 0) return { ok: false, error: "Choose the products you discussed." };
  if (products.length > VISIT_PRODUCTS_MAX) return { ok: false, error: `Choose at most ${VISIT_PRODUCTS_MAX} products.` };

  const commentText = String(body.comment ?? "").trim();
  if (commentText.length > VISIT_COMMENT_MAX) return { ok: false, error: `The comment is longer than ${VISIT_COMMENT_MAX} characters.` };

  const photoPath = String(body.photoPath ?? "").trim();
  if (!photoPath) return { ok: false, error: "Take a live photo of the clinic sign or door." };
  const fix = parseCapturedFix(body);
  if (!fix.ok) return fix;

  return {
    ok: true,
    value: {
      ...fix.value,
      customerId: String(body.customerId).toLowerCase(),
      kind,
      managerHrId: kind === "single" ? null : managerHrId,
      seniorHrId: kind === "chain" ? seniorHrId : null,
      products,
      comment: commentText || null,
      photoPath,
    },
  };
}

/**
 * Minutes between the phone's clock and the server's; beyond this the entry is marked "phone clock
 * off". The same 15 minutes the company's other live-capture checks allow.
 */
export const DEVICE_CLOCK_TOLERANCE_MINUTES = 15;

export function deviceClockSkewMinutes(deviceCapturedAt: string | null, serverNow: Date): number | null {
  if (!deviceCapturedAt) return null;
  const device = Date.parse(deviceCapturedAt);
  if (Number.isNaN(device)) return null;
  return Math.round((device - serverNow.getTime()) / 60000);
}

export function isReportMonth(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function isReportDay(value: unknown): value is string {
  return isIsoDay(value);
}
