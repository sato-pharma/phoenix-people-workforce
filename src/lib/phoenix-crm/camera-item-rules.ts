/**
 * Phoenix CRM — what happens to a photo the Phoenix Camera sends (owner, 20 Nov 2026), decided here without a
 * database so every rule can be tested on its own.
 *
 * 🔴 NOTHING RECORDS ITSELF (owner, 21 Nov 2026: "EVERY VISIT GOES TO CAMERA REVIEWS EVERY VISIT", "EVERY VISIT
 * GOES TO MANUAL REVIEW FIRST"). Every item the camera sends arrives WAITING; only the Super Admin's Approve records
 * it. The reasons below are what his page shows beside it, never a gate that lets one through.
 *
 * His decisions, point by point:
 *   - The allowance (21 Nov 2026): "U ARE ALLOWED 3 A DAYS IF MORE NEEDED WE NEED APPROVAL FROM MANAGERS VIA EMAIL AND
 *     SYSTEM ADMIN WILL UPDATE IT FOR THIS DAY ONLY". A rep has `camera_daily_cap` camera VISITS (default 3) a Phoenix
 *     day; the Super Admin raises it for one rep and one day only (`phoenix_crm_camera_day_allowances`, with the
 *     manager's email approval written beside it). Approve refuses a visit past that day's allowance. The SFE is
 *     excluded totally.
 *   - Point 3: a photo with no usable position is sent as "no location" and waits.
 *   - Point 4: a photo that arrives after its Phoenix day ended (02:00) is marked "next day"; over 36 hours it is
 *     archived. The time comes from Phoenix's own anchor, else the satellites, else "time not
 *     confirmed" (which waits).
 *   - Point 5: "Phoenix will not reject anything ... leave the decision to the decision maker." A seal that does not
 *     hold is red on his page and waits. The rep reads only "sent".
 *   - Point 6: a name photo the reader cannot read clearly waits as "name photo to check".
 *   - A new customer always waits for his approval ("your camera page only").
 */

import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";

/** The Super Admin's camera page. */
export const CAMERA_REVIEWS_PATH = "/admin/field-crm/camera-reviews";

/** How many camera visits a rep may have approved in one Phoenix day, unless the Super Admin raises that day. */
export const CAMERA_DAILY_CAP_DEFAULT = 3;
export const CAMERA_DAILY_CAP_MIN = 1;
export const CAMERA_DAILY_CAP_MAX = 20;

/** Past this, a photo is archived on arrival: it is too old to be anybody's visit (owner, point 4: "over 36h"). */
export const CAMERA_ITEM_ARCHIVE_HOURS = 36;

export type CameraIntent = "visit" | "validate" | "new_customer";
export type CameraPhotoKind = "place" | "door_sign" | "banner" | "prescription" | "business_card";
export type CameraTimeSource = "anchor" | "satellites" | "unconfirmed";
export type CameraOutcome = "recorded" | "waiting" | "archived";

/** Why an item waits (or was archived), in the order the page lists them. */
export type CameraReason =
  | "too_old"
  | "seal_failed"
  | "new_customer"
  | "time_unconfirmed"
  | "next_day"
  | "no_location"
  | "over_cap"
  | "name_photo"
  | "rule_refusal";

export const CAMERA_REASON_LABELS: Record<CameraReason, string> = {
  too_old: "Taken more than 36 hours before it arrived",
  seal_failed: "The seal does not hold",
  new_customer: "A new customer",
  time_unconfirmed: "Time not confirmed",
  next_day: "Arrived after its Phoenix day ended",
  no_location: "No location",
  over_cap: "Over the day's allowance",
  name_photo: "Name photo to check",
  rule_refusal: "The visit rules did not accept it",
};

export const CAMERA_PHOTO_KIND_LABELS: Record<CameraPhotoKind, string> = {
  place: "Photo of the place",
  door_sign: "Door sign",
  banner: "Banner",
  prescription: "Prescription",
  business_card: "Business card",
};

export const CAMERA_INTENT_LABELS: Record<CameraIntent, string> = {
  visit: "Visit",
  validate: "Validation",
  new_customer: "New customer",
};

/** The four photos that carry the customer's name, read by the reader instead of standing as the place itself. */
export function isNamePhoto(kind: CameraPhotoKind): boolean {
  return kind !== "place";
}

// ── The time ────────────────────────────────────────────────────────────────────────────────────

export type CameraTime = { takenAt: Date | null; source: CameraTimeSource };

/**
 * When the photo was taken, and on whose word. Phoenix's own anchor first (the server wrote it, the phone only
 * counted the time since); else the satellites' time, but only inside a seal that holds; else not confirmed.
 * The phone's own clock and the clock it carried forward are never enough on their own (owner, point 4).
 */
export function cameraTakenAt(input: {
  anchorCapturedAt: Date | null;
  sealHolds: boolean;
  timeSource: string | null;
  takenAtUtc: string | null;
}): CameraTime {
  if (input.anchorCapturedAt && Number.isFinite(input.anchorCapturedAt.getTime())) {
    return { takenAt: input.anchorCapturedAt, source: "anchor" };
  }
  if (input.sealHolds && input.timeSource === "satellites" && input.takenAtUtc) {
    const at = new Date(input.takenAtUtc);
    if (Number.isFinite(at.getTime())) return { takenAt: at, source: "satellites" };
  }
  return { takenAt: null, source: "unconfirmed" };
}

// ── The arrival ─────────────────────────────────────────────────────────────────────────────────

export type CameraArrivalInput = {
  intent: CameraIntent;
  sealHolds: boolean;
  /** The seal's position cannot stand (none at all, too rough, outside ten minutes). */
  locationProblems: readonly string[];
  time: CameraTime;
  receivedAt: Date;
  /** Camera visits this rep already SENT for the photo's own Phoenix day and not rejected (this one excluded). */
  sentThatDay: number;
  /** The rep's allowance for that day: the daily limit, or the Super Admin's raise for that one day. */
  allowance: number;
};

export type CameraArrival = { outcome: CameraOutcome; reasons: CameraReason[]; takenDay: string | null };

/**
 * Waiting for the Super Admin, or archived — decided the moment it arrives, before anything is written. Nothing is
 * ever recorded here (owner, 21 Nov 2026: every visit goes to manual review first). Every reason is kept, so the page
 * says all of them at once; "over the day's allowance" is a camera VISIT past the rep's allowance for that day.
 */
export function cameraArrival(input: CameraArrivalInput): CameraArrival {
  const takenDay = input.time.takenAt ? cairoBusinessDay(input.time.takenAt) : null;
  if (input.time.takenAt && input.receivedAt.getTime() - input.time.takenAt.getTime() > CAMERA_ITEM_ARCHIVE_HOURS * 3_600_000) {
    return { outcome: "archived", reasons: ["too_old"], takenDay };
  }
  const reasons: CameraReason[] = [];
  if (!input.sealHolds) reasons.push("seal_failed");
  if (input.intent === "new_customer") reasons.push("new_customer");
  if (input.time.source === "unconfirmed") reasons.push("time_unconfirmed");
  if (takenDay && takenDay !== cairoBusinessDay(input.receivedAt)) reasons.push("next_day");
  if (input.locationProblems.length > 0) reasons.push("no_location");
  if (input.intent === "visit" && takenDay && input.sentThatDay >= cameraAllowance(input.allowance)) reasons.push("over_cap");
  return { outcome: "waiting", reasons, takenDay };
}

/** An allowance as the rules read it: never below one. */
export function cameraAllowance(raw: number): number {
  return Math.max(CAMERA_DAILY_CAP_MIN, Number.isFinite(raw) ? Math.floor(raw) : CAMERA_DAILY_CAP_DEFAULT);
}

/** The rep's allowance on one day: the Super Admin's raise for that day when there is one, else the daily limit. */
export function cameraDayAllowance(cap: number, raised: number | null): number {
  return cameraAllowance(raised !== null && raised > cap ? raised : cap);
}

/**
 * Whether Approve may record one more camera visit for this rep on this day, and the Super Admin's words when it may
 * not. `approved` counts the visits of that day already recorded (approved, or recorded at once before 21 Nov 2026).
 */
export function cameraApproveAllowed(approved: number, allowance: number): { ok: true } | { ok: false; reason: string } {
  const allowed = cameraAllowance(allowance);
  if (approved < allowed) return { ok: true };
  return {
    ok: false,
    reason: `${approved} of ${allowed} camera ${allowed === 1 ? "visit" : "visits"} already approved for this rep on that day. Raise the allowance for that day, once the manager's approval is in by email, to approve this one.`,
  };
}

/** The Super Admin's raise as he typed it: a whole number inside the column's own CHECK, or null. */
export function parseCameraDayAllowance(raw: unknown): number | null {
  return parseCameraCap(raw);
}

/** The daily limit as the Super Admin typed it: a whole number inside the column's own CHECK, or null. */
export function parseCameraCap(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(value) || value < CAMERA_DAILY_CAP_MIN || value > CAMERA_DAILY_CAP_MAX) return null;
  return value;
}

// ── The visit the rep typed, as the Super Admin's "Record a missed visit" door reads it ──────────────

export type CameraVisitDraft = {
  planned: boolean;
  reason: string | null;
  kind: "single" | "double" | "chain";
  picked: string[];
  products: string[];
  comment: string | null;
};

function hrIdOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null;
}

/**
 * The camera's visit block (`visitType`, `kind`, the people, products and comment) turned into what the missed-visit
 * door takes when the Super Admin records it. A visit with a product manager alone is a double with him.
 */
export function cameraVisitDraft(raw: unknown): CameraVisitDraft {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const planned = body.visitType !== "out_of_plan" && body.planned !== false;
  const reasonText = typeof body.unplannedReason === "string" ? body.unplannedReason.trim() : typeof body.reason === "string" ? body.reason.trim() : "";
  const products = (Array.isArray(body.products) ? body.products : [])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry, index, all) => entry && all.indexOf(entry) === index);
  const comment = typeof body.comment === "string" && body.comment.trim() ? body.comment.trim() : null;
  const companions = (Array.isArray(body.companions) ? body.companions : [])
    .map((entry) => hrIdOf((entry as Record<string, unknown> | null)?.hrId))
    .filter((id): id is string => Boolean(id));
  const manager = hrIdOf(body.managerHrId);
  const product = hrIdOf(body.productManagerHrId);
  const senior = hrIdOf(body.seniorHrId);
  let kind: CameraVisitDraft["kind"] = "single";
  let picked: string[] = [];
  if (body.kind === "double" || body.kind === "product_manager") {
    const one = manager ?? product;
    if (one) {
      kind = "double";
      picked = [one];
    }
  } else if (body.kind === "chain") {
    const people = [...new Set([...companions, ...[manager, senior, product].filter((id): id is string => Boolean(id))])];
    if (people.length >= 2) {
      kind = "chain";
      picked = people;
    } else if (people.length === 1) {
      kind = "double";
      picked = people;
    }
  }
  return { planned, reason: planned ? null : reasonText || null, kind, picked, products, comment };
}

/** "HH:MM" on Cairo's wall clock, for the missed-visit door's time box. */
export function cairoClockOf(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

// ── The page's words for a time and a gap ──────────────────────────────────────────────────────

/** "42 s", "7 min", "2 h 5 min", "1 day 3 h". */
export function cameraDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return `${days} ${days === 1 ? "day" : "days"}${rest ? ` ${rest} h` : ""}`;
}

/** Where the position was taken against the shutter, in words. */
export function cameraFixGapText(gapSeconds: number | null): string | null {
  if (gapSeconds === null) return null;
  if (gapSeconds === 0) return "Position taken with the photo";
  return gapSeconds > 0 ? `Position taken ${cameraDuration(gapSeconds)} before the photo` : `Position taken ${cameraDuration(-gapSeconds)} after the photo`;
}

// ── The camera page's rows, shared by the server loader and the browser board ──────────────────────

export type CameraTab = "waiting" | "recorded" | "archive";

export type CameraItemRow = {
  id: string;
  intent: CameraIntent;
  intentLabel: string;
  photoKindLabel: string;
  isTest: boolean;
  repName: string;
  seatId: string;
  customerName: string | null;
  proposedCustomer: Record<string, unknown> | null;
  photoUrl: string | null;
  sealHolds: boolean;
  sealProblems: string[];
  locationProblems: string[];
  warnings: string[];
  locationStatus: string | null;
  lat: number | null;
  lon: number | null;
  accuracyMeters: number | null;
  /** Shutter minus the position's time, in seconds; positive = before the photo. */
  fixGapSeconds: number | null;
  takenAt: string | null;
  timeSource: CameraTimeSource;
  takenDay: string | null;
  receivedAt: string;
  outcome: CameraOutcome;
  reasons: { key: CameraReason; label: string }[];
  ruleRefusal: string | null;
  readerVerdict: string | null;
  readerText: string | null;
  visitId: string | null;
  validatedPlaceId: string | null;
  decision: "approved" | "rejected" | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** What Approve would do, in his words, or null when it cannot be approved (and why, in `cannotApprove`). */
  approveLabel: string | null;
  cannotApprove: string | null;
  /** A waiting camera visit's day: its allowance and how many are already approved, for the one-day raise. */
  allowanceDay: { day: string; allowance: number; approved: number; raisedBy: string | null; managerApproval: string | null } | null;
};

export type CameraPageView = { tab: CameraTab; rows: CameraItemRow[]; waitingCount: number; cap: number };
