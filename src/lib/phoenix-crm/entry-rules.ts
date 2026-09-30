/**
 * Phoenix CRM — what a rep sends to validate a customer or enter a visit, checked with no I/O.
 *
 * Owner, 2026-09-16:
 *   - A customer is validated only with a LIVE photo (the clinic sign or door), the location captured
 *     on the spot, and at least one timing. Reference customers and brand-new ones go the same way.
 *   - A new customer's grade: the rep proposes, the district manager approves.
 *   - Dropping a customer needs a reason and the district manager's approval.
 *   - Each visit records the location check, the products discussed and a comment — the comment
 *     REQUIRED since 2026-09-30, typed or spoken (owner: "visit comment is required"). Since 2026-09-29
 *     it needs NO photo: "Log visit" is one tap, the server stamps the time and the location is read
 *     silently (owner: "the medical rep just presses; in the back end we take his location").
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
import { parseUnplannedReason } from "@/lib/phoenix-crm/unplanned-rules";
import { parseSamplesGiven, type SamplesGiven } from "@/lib/phoenix-crm/samples";
import { parseVisitOutcome, type VisitOutcome } from "@/lib/phoenix-crm/visit-outcome";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmTiming, PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";

export type EntryRuleResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const CUSTOMER_NAME_MAX = 120;
export const PLACE_TEXT_MAX = 200;
export const VISIT_COMMENT_MAX = 1000;
/** Owner, 2026-09-30: "visit comment is required" — typed or spoken, never left empty. */
export const VISIT_COMMENT_REQUIRED = "Write what happened on the visit — type it or speak it.";
export const DROP_REASON_MAX = 500;
export const VISIT_PRODUCTS_MAX = 12;
export const PHARMACY_NAME_MAX = 120;
/**
 * The pharmacy stock check answers one line's products, not the whole catalogue, so a genuine line
 * never approaches this. It is only a guard against a phone sending a bag of junk keys.
 */
export const PRODUCT_AVAILABILITY_MAX = 60;

/** Whether the pharmacy the rep took feedback from stocks a product, product by product. */
export type ProductAvailability = "has" | "missing";

export const DROP_REASONS = [
  { key: "moved", label: "Moved away" },
  { key: "retired", label: "Retired or stopped practising" },
  { key: "closed", label: "Clinic or place closed" },
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

/**
 * The district manager's read of a new customer's potential, set when he approves an add (owner,
 * 2026-09-29). Stored and shown ONLY: frequency, targets and every KPI read the A/B/C grade.
 */
export const POTENTIAL_GRADES = ["AA", "AB", "AC", "BA", "BB", "BC"] as const;

export type PotentialGrade = (typeof POTENTIAL_GRADES)[number];

export function parsePotentialGrade(value: unknown): PotentialGrade | null {
  const grade = String(value ?? "").trim().toUpperCase();
  return (POTENTIAL_GRADES as readonly string[]).includes(grade) ? (grade as PotentialGrade) : null;
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
  /**
   * Android's own mark on a fix that came from a mock provider — a "Fake GPS" app — as
   * `expo-location` reports it. Null where the question cannot be asked: the web, and iOS.
   *
   * NOTHING IS REFUSED ON THIS (owner, 2026-09-25). It is recorded silently and read only by the
   * Super Admin's integrity board; the rep's save behaves exactly as it always did. A build could of
   * course be patched to stop sending it, which is why it is one signal among several and the others
   * are computed on the server — see src/lib/phoenix-crm/location-integrity.ts.
   */
  deviceMocked: boolean | null;
  /**
   * The PHOTO’s own fix, read at the shutter - never a copy of lat/lon above.
   *
   * Omitted by an older build, by the web, and by any handset whose shutter could not read a
   * position. That is NOT MEASURED and is never refused: a visit saves exactly as before without
   * it, and nothing downstream may read the absence as agreement with the pin.
   */
  photoLat: number | null;
  photoLon: number | null;
  photoAccuracyMeters: number | null;
  photoCapturedAt: string | null;
};

const NO_FIX_AT_THE_PLACE = "Your location was not captured. Allow location on your phone and capture it again at the clinic.";

/**
 * The one-tap visit takes its location silently. When there is none — location switched off or
 * refused — the save is refused in plain words about HIS OWN work (Golden Rule #1 hides checks, never
 * a save that did not happen): what to switch on, and nothing about any check.
 */
export const NO_FIX_FOR_A_VISIT = "Turn on location for Phoenix, then tap Log visit again.";

export function parseCapturedFix(raw: Record<string, unknown>, noFixMessage = NO_FIX_AT_THE_PLACE): EntryRuleResult<CapturedFix> {
  if (!isUsableFix(raw.lat, raw.lon)) {
    return { ok: false, error: noFixMessage };
  }
  // Not `Number(...)`, which reads "" and " " as 0: a phone that reported no accuracy was saved as a
  // perfect 0 m fix and shown to the manager as "within 0 m". A blank accuracy is unknown.
  const accuracy = readAccuracyInput(raw.accuracyMeters);
  const deviceCapturedAt = typeof raw.deviceCapturedAt === "string" && !Number.isNaN(Date.parse(raw.deviceCapturedAt)) ? raw.deviceCapturedAt : null;
  // Strictly a boolean or nothing. A body that omits it — an older build, the web, iOS — is
  // "not asked", never "clean", and is never refused for the omission.
  const deviceMocked = typeof raw.deviceMocked === "boolean" ? raw.deviceMocked : null;
  return {
    ok: true,
    value: {
      lat: Number(raw.lat),
      lon: Number(raw.lon),
      accuracyMeters: accuracy !== null && accuracy >= 0 ? Math.round(accuracy * 10) / 10 : null,
      deviceCapturedAt,
      deviceMocked,
      // Read through the SAME guards as the pin, and independently of it: a body carrying only
      // half a shutter pair contributes no coordinate at all rather than a lopsided one. Never
      // defaulted to the pin - that substitution is the defect #4781 removed elsewhere.
      photoAccuracyMeters: (() => {
        const photoAccuracy = readAccuracyInput(raw.shutterAccuracyMeters);
        return photoAccuracy !== null && photoAccuracy >= 0 ? Math.round(photoAccuracy * 10) / 10 : null;
      })(),
      photoCapturedAt:
        typeof raw.shutterCapturedAt === "string" && !Number.isNaN(Date.parse(raw.shutterCapturedAt))
          ? raw.shutterCapturedAt
          : null,
      photoLat: isUsableFix(raw.shutterLat, raw.shutterLon) ? Number(raw.shutterLat) : null,
      photoLon: isUsableFix(raw.shutterLat, raw.shutterLon) ? Number(raw.shutterLon) : null,
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

/**
 * The place's FIXED point: the photo's own reading, else the pin (owner, 2026-09-29 — "the photo + the
 * location of photo is the more trustable", his ruling for marketing and direct orders the same day).
 * Both raw readings are stored beside it; this only chooses which one the address, brick, area and
 * region are resolved from, and which one every later visit is measured against.
 */
export type PlacePoint = { lat: number; lon: number; accuracyMeters: number | null; source: "photo" | "pin" };

export function placePoint(fix: CapturedFix): PlacePoint {
  if (fix.photoLat !== null && fix.photoLon !== null) {
    return { lat: fix.photoLat, lon: fix.photoLon, accuracyMeters: fix.photoAccuracyMeters, source: "photo" };
  }
  return { lat: fix.lat, lon: fix.lon, accuracyMeters: fix.accuracyMeters, source: "pin" };
}

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

/**
 * A customer the rep met who is not on his list: AM or PM chosen BY HAND (owner, 2026-09-29 — "it is
 * not AM because he entered it in the morning; let him choose it"), the name and the speciality.
 */
export type OutsideCustomerDraft = Omit<NewCustomerDraft, "proposedGrade">;

export function parseOutsideCustomer(raw: unknown): EntryRuleResult<OutsideCustomerDraft> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const listType = parseListType(body.listType);
  if (!listType) return { ok: false, error: "Choose AM or PM." };
  const name = cleanText(body.name, CUSTOMER_NAME_MAX);
  if (!name || name.length < 3) return { ok: false, error: "Write the customer's full name." };
  return { ok: true, value: { listType, name, speciality: cleanText(body.speciality, 80) } };
}

/** "Add new customer": the same, plus the grade he proposes — the district manager, then SFE, decide. */
export function parseNewCustomer(raw: unknown): EntryRuleResult<NewCustomerDraft> {
  const base = parseOutsideCustomer(raw);
  if (!base.ok) return base;
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const proposedGrade = parseGrade(body.proposedGrade);
  if (!proposedGrade) return { ok: false, error: "Propose a grade (A, B or C). Your district manager and SFE approve it." };
  return { ok: true, value: { ...base.value, proposedGrade } };
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
  /**
   * The pharmacy the rep took feedback from before the customer; he types it, so it is free text.
   * OPTIONAL since 2026-09-29 (owner): the box stays, but a visit is never blocked on it.
   */
  pharmacyName: string | null;
  /** His answer, per line product, of whether that pharmacy stocks it. Products left blank are absent. */
  productAvailability: Record<string, ProductAvailability>;
  comment: string | null;
  /**
   * The photo slot, when the caller still takes one. The one-tap Log visit sends none (owner,
   * 2026-09-29) and the server's own clock dates the visit; a caller that sends one is served exactly
   * as before.
   */
  photoPath: string | null;
  /**
   * An optional spoken note, kept as audio and transcribed never.
   *
   * Null on most visits, and the visit saves either way — the note is a convenience, not evidence. It
   * is deliberately NOT part of `CapturedFix`: a fix is where and when somebody was, and a recording
   * can be made in a car an hour later, which is the whole reason it dates nothing.
   */
  voiceNotePath: string | null;
  voiceNoteSeconds: number | null;
  voiceNoteBytes: number | null;
  /**
   * The kind of visit the rep CHOSE on the first step (owner, 2026-09-29): "planned" offers only
   * today's sent plan; "out_of_plan" is someone on his list who is not on today's plan, and needs his
   * reason and the manager's then SFE's approval; "out_of_list" is someone not on his list at all, whom
   * he validates on the spot and who counts once the district manager and SFE admit him. A caller that
   * still says "unplanned" means out_of_plan.
   *
   * It is what he said, never what is true. The server resolves the truth from the plan's own history
   * and the customer's own status inside phoenix_crm_save_visit. It is carried only so the reason below
   * can be asked for HERE, before the save, instead of coming back as a refusal after it.
   */
  visitType: "planned" | "out_of_plan" | "out_of_list";
  /** His written "why I went", when he chose out of plan. */
  unplannedReason: string | null;
  /**
   * The objection the doctor raised and what the rep will do next — both optional, both chips.
   *
   * It never fails, by design. Every other field on this type can refuse the draft; these four are
   * extras on a visit that is otherwise complete, and a phone one release behind sending a value this
   * one does not know must not cost a rep a visit he actually made. The unknown value is dropped and
   * the visit saves. See `visit-outcome.ts`.
   */
  outcome: VisitOutcome;
  /**
   * What he handed over — free samples of his line's products, and pens, block notes and giveaways.
   *
   * 🔴 A RECORD, never a stock movement: nothing subtracts, nothing is allocated and no balance
   * exists. Junk is dropped rather than refused, for the same reason as the outcome above.
   */
  samplesGiven: SamplesGiven;
  /**
   * How long the form was open on the phone, in seconds — or null when it did not say.
   *
   * 🔴 SILENT (Golden Rule #1). It is never shown to the rep, never mentioned to him and never able
   * to refuse a visit; it is read only by the Super Admin's integrity board, where a CONSTANT value
   * across a rep's whole month is the signal and any single value is not. Clamped, never refused —
   * see `clampFormOpenSeconds`.
   */
  formOpenSeconds: number | null;
};

/** A photo slot lasts 2 hours, so nothing legitimate is longer than that between opening and saving. */
export const FORM_OPEN_SECONDS_MAX = 7200;

/**
 * The phone's stopwatch, clamped.
 *
 * Never refused and never thrown on: a build one release behind, a browser that lost the clock, a
 * value of "abc" — each lands as null and the visit saves. The rep is standing at a door with a photo
 * he cannot retake, and this is the one field on the whole form he is not even told exists.
 */
export function clampFormOpenSeconds(raw: unknown): number | null {
  // Explicitly, because `Number(null)` and `Number("")` are BOTH 0 — a body that said nothing would
  // otherwise land as a visit saved in under a second, which is the one reading that matters most.
  if (typeof raw !== "number" && !(typeof raw === "string" && raw.trim() !== "")) return null;
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(value, FORM_OPEN_SECONDS_MAX);
}

/** The recorder caps at 60s; the column allows 120, so a long note is clamped rather than refused. */
const VOICE_NOTE_SECONDS_MAX = 120;
const VOICE_NOTE_BYTES_MAX = 2 * 1024 * 1024;

/**
 * The duration and size the phone reported, clamped rather than trusted.
 *
 * Neither is evidence and neither gates the save — they are what the review screen prints beside the
 * play button, so a wrong one is a wrong label, not a wrong visit. What IS authoritative is the path,
 * and only the database can settle that: `phoenix_crm_take_voice` refuses a path this person was not
 * issued, so a forged one fails at the save with a named code rather than being guessed at here.
 */
function clampVoiceNumber(raw: unknown, max: number): number | null {
  const value = Math.round(Number(raw));
  if (!Number.isFinite(value) || value < 1) return null;
  return Math.min(value, max);
}

/**
 * The pharmacy stock answers the phone sent: an object of product → "has"/"missing". Anything else — a
 * blank product, an answer that is not one of the two, more entries than a line could hold — is dropped
 * rather than refused, so a stray key never blocks a visit. The keys are checked against the line's
 * real products on the server (saveVisit), the same way the discussed products are.
 */
export function parseProductAvailability(raw: unknown): Record<string, ProductAvailability> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ProductAvailability> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= PRODUCT_AVAILABILITY_MAX) break;
    const product = cleanText(key, 80);
    if (!product) continue;
    if (value === "has" || value === "missing") out[product] = value;
  }
  return out;
}

/** The kind of visit he chose; "unplanned", from a caller one release behind, is out of plan. */
export function parseVisitType(value: unknown): VisitDraft["visitType"] {
  if (value === "out_of_list") return "out_of_list";
  if (value === "out_of_plan" || value === "unplanned") return "out_of_plan";
  return "planned";
}

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

  // Optional (owner, 2026-09-29): the box stays on the form, and a visit is never blocked on it.
  const pharmacyName = cleanText(body.pharmacyName, PHARMACY_NAME_MAX);

  const productsRaw = Array.isArray(body.products) ? body.products : [];
  const products = [...new Set(productsRaw.map((product) => cleanText(product, 80)).filter((product): product is string => Boolean(product)))];
  if (products.length === 0) return { ok: false, error: "Choose the products you discussed." };
  if (products.length > VISIT_PRODUCTS_MAX) return { ok: false, error: `Choose at most ${VISIT_PRODUCTS_MAX} products.` };

  const productAvailability = parseProductAvailability(body.productAvailability);

  const commentText = String(body.comment ?? "").trim();
  if (!commentText) return { ok: false, error: VISIT_COMMENT_REQUIRED };
  if (commentText.length > VISIT_COMMENT_MAX) return { ok: false, error: `The comment is longer than ${VISIT_COMMENT_MAX} characters.` };

  // No photo on the one-tap visit; a caller that still sends one keeps its path.
  const photoPath = cleanText(body.photoPath, 200);
  const fix = parseCapturedFix(body, NO_FIX_FOR_A_VISIT);
  if (!fix.ok) return fix;

  // The kind he chose. The reason is asked for here, before the save, so an off-plan visit never gets
  // as far as the server without one — the server still decides which kind it really was.
  const visitType = parseVisitType(body.visitType);
  let unplannedReason: string | null = null;
  if (visitType === "out_of_plan") {
    const reason = parseUnplannedReason(body.unplannedReason);
    if (!reason.ok) return { ok: false, error: reason.error };
    unplannedReason = reason.value;
  }

  // All three travel together or none does: a path with no numbers would print an empty player, and
  // numbers with no path would print a duration for a recording nobody can hear.
  const voiceNotePath = cleanText(body.voiceNotePath, 200);

  return {
    ok: true,
    value: {
      ...fix.value,
      customerId: String(body.customerId).toLowerCase(),
      kind,
      managerHrId: kind === "single" ? null : managerHrId,
      seniorHrId: kind === "chain" ? seniorHrId : null,
      products,
      pharmacyName,
      productAvailability,
      comment: commentText || null,
      photoPath,
      voiceNotePath,
      voiceNoteSeconds: voiceNotePath ? clampVoiceNumber(body.voiceNoteSeconds, VOICE_NOTE_SECONDS_MAX) : null,
      voiceNoteBytes: voiceNotePath ? clampVoiceNumber(body.voiceNoteBytes, VOICE_NOTE_BYTES_MAX) : null,
      visitType,
      unplannedReason,
      outcome: parseVisitOutcome(body),
      samplesGiven: parseSamplesGiven(body.samplesGiven),
      formOpenSeconds: clampFormOpenSeconds(body.formOpenSeconds),
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
