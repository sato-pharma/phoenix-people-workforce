/**
 * Phoenix CRM — when a visit the phone is holding may be sent, and what its answer means.
 *
 * WHY THIS EXISTS. A rep who pressed Log visit where the signal dropped lost the whole visit, comment
 * and all, and had nothing to press afterwards. Owner, 3 Nov 2026: build the retry. So the press is
 * written to the phone BEFORE the request goes, and sent again while Phoenix is open.
 *
 * 🔴 NOTHING HERE DATES A VISIT. The server dates every browser save at ARRIVAL, as it always has, and
 * the one thing a resend adds is `queuedSeconds`, a DURATION that reaches the evidence and never the
 * save function (`parseVisitDraft`, `server/capture-provenance.ts`). That is why the window below is
 * two hours and stops at 02:00: past either, an arrival-dated visit is no longer the same visit — it
 * would land on the wrong day, or as off plan, and raise a manager's notice nobody earned. So the rep
 * is asked to log it again, one tap, in a case that should be rare. This module decides which.
 *
 * Pure, so every branch is provable with no browser: `tests/phoenix-crm-visit-resend-rules.test.ts`.
 */

import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";

/** The longest a press is held for sending. The same two hours a voice-note slot lives. */
export const VISIT_RESEND_MAX_SECONDS = 7_200;
/** How long one save may hang before it is treated as no signal. A hung request used to trap the form. */
export const VISIT_SAVE_TIMEOUT_MS = 30_000;
/** A pause between two sends, so a queue draining after a dead spot is not one burst. */
export const VISIT_RESEND_GAP_MS = 3_000;
/** How often the runner looks again, and only while something is waiting. */
export const VISIT_RESEND_TICK_MS = 60_000;
/** A request this long in flight is still somebody's; past it, the runner may take the entry. */
export const VISIT_RESEND_IN_FLIGHT_MS = VISIT_SAVE_TIMEOUT_MS + 5_000;

/** The most a phone holds for one person. A rep's whole day fits; past it the press behaves as before. */
export const VISIT_OUTBOX_MAX_ENTRIES = 40;

// ── What the rep reads. Nothing here names a check, a clock, a distance or lateness (Golden Rule #1). ──

export const VISIT_WAITING_PILL = "Waiting to send";
export const VISIT_WAITING_LINE = "Saved on this phone. It sends when you have signal and Phoenix is open.";
export const VISIT_REFUSED_TITLE = "This visit could not be sent";
export const VISIT_TOO_LATE_TITLE = "Not sent in time";
export const VISIT_LOG_AGAIN = "Log it again";
export const VISIT_REMOVE = "Remove";

export type QueuedVisitStatus = "waiting" | "refused" | "too_late";

/** How an entry ended, as the resend log files it. A CHECK on the table is the one list of these. */
export type VisitResendOutcome = "landed_late" | "already_saved" | "refused" | "timed_out" | "removed" | "relogged";

export type QueuedVisit = {
  visitId: string;
  /** Whose press it is. Sent, shown and counted for this person only (browser-storage/owner-scoped.ts). */
  ownerHrId: string;
  seatId: string;
  customerId: string;
  customerName: string;
  /** The visit day the phone thought it was at the press: only for finding "the same visit" again. */
  pressedDay: string;
  /** The press, on the phone's own clock. Only ever compared with that same clock. */
  pressedAtMs: number;
  /** A send is in flight until this moment, so two senders never race one id. Zero is none. */
  sendingUntilMs: number;
  attempts: number;
  status: QueuedVisitStatus;
  refusalCode: string | null;
  /** The server's own sentence, shown as it came. */
  refusalMessage: string | null;
  /** The very body the first press sent. */
  body: Record<string, unknown>;
};

/** The duration a resend carries: bounded, whole, and never a date. Null when there is nothing to say. */
export function queuedSecondsAt(entry: Pick<QueuedVisit, "pressedAtMs">, nowMs: number): number | null {
  const seconds = Math.floor((nowMs - entry.pressedAtMs) / 1000);
  if (!Number.isFinite(seconds) || seconds < 1) return null;
  return Math.min(seconds, VISIT_RESEND_MAX_SECONDS);
}

/**
 * Is it too late to send this automatically?
 *
 * 🔴 THE DAY IS JUDGED ON THE SERVER'S CLOCK, THE ELAPSED TIME ON THE PHONE'S. Each is right about the
 * one thing it can be right about: a phone an hour out still measures two hours truly, and only the
 * server knows which side of 02:00 the visit would land on. A phone clock that ran BACKWARDS measures
 * nothing, so it reads as too late too — the safe answer costs one tap and never a false visit.
 */
export function isTooLateToSend(entry: Pick<QueuedVisit, "pressedAtMs">, phoneNowMs: number, serverNowMs: number): boolean {
  const elapsedMs = phoneNowMs - entry.pressedAtMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return true;
  if (elapsedMs > VISIT_RESEND_MAX_SECONDS * 1000) return true;
  return cairoBusinessDay(new Date(serverNowMs)) !== cairoBusinessDay(new Date(serverNowMs - elapsedMs));
}

/** An entry a sender may take right now: still waiting, and nobody's request is in flight for it. */
export function isReadyToSend(entry: Pick<QueuedVisit, "status" | "sendingUntilMs">, nowMs: number): boolean {
  return entry.status === "waiting" && entry.sendingUntilMs <= nowMs;
}

/** Refusals that mean this customer's visit today is already on file, whichever id it went under. */
const ALREADY_ON_FILE = new Set(["phoenix_crm_already_visited"]);
const VOICE_REFUSAL_PREFIX = "phoenix_crm_voice_";

export type RefusalAnswer =
  /** On file after all. Removed in silence: he has nothing left to do and nothing to be told. */
  | "settled"
  /** Only the spoken note's slot failed, and his comment stands: the same visit, without the note. */
  | "send_without_voice"
  /** A real refusal. He reads the server's sentence, with Log it again and Remove. */
  | "show_refusal";

/**
 * What a refusal at RESEND means.
 *
 * 🔴 IT DOES NOT PROVE THE VISIT IS UNSAVED. The pre-checks run before the save function's own "this id
 * is already on file" answer, so a visit that landed on the first press and lost only its reply can be
 * refused on the second. The id is therefore read first (`idIsOnFile`), and a refusal is shown only for
 * a visit that truly is not there.
 */
export function answerToRefusal(input: { code: string | null; idIsOnFile: boolean; body: Record<string, unknown> }): RefusalAnswer {
  if (input.idIsOnFile) return "settled";
  if (input.code && ALREADY_ON_FILE.has(input.code)) return "settled";
  if (input.code?.startsWith(VOICE_REFUSAL_PREFIX) && input.body.voiceNotePath) {
    // A comment is required on every visit, so one is normally here. Without one there is nothing to
    // keep, and the visit is his to log again.
    return String(input.body.comment ?? "").trim() ? "send_without_voice" : "show_refusal";
  }
  return "show_refusal";
}

/** The same body with the spoken note taken off. Everything else, the id included, is untouched. */
export function withoutVoiceNote(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, voiceNotePath: null, voiceNoteSeconds: null, voiceNoteBytes: null };
}

/** What the form starts from when he presses Log it again: his own words and picks, not a blank page. */
export function loggedAgainStart(entry: Pick<QueuedVisit, "body"> | null): { comment: string; products: string[] } | null {
  if (!entry) return null;
  const products = Array.isArray(entry.body.products) ? entry.body.products.filter((value): value is string => typeof value === "string") : [];
  return { comment: typeof entry.body.comment === "string" ? entry.body.comment : "", products };
}
