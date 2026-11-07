// Recruitment / Medical Rep hiring — what a request may say, checked before anything is read or written.
//
// PURE. Each parser takes the request body and returns a clean value or throws an Error whose message
// is the sentence the screen shows. The routes call these first, so a malformed request is refused
// before it costs a database round trip.

import { normalizeGovernorate } from "@/lib/recruitment/candidate-region";
import {
  MR_AREA_LIMIT,
  MR_COMMENT_LIMIT,
  MR_LOCATION_LIMIT,
  MR_PHONE_CALL_MINUTES,
  isMrInterviewRound,
  isMrLine,
  isMrRecommendation,
  isMrResult,
  isMrResultStep,
  type MrInterviewRound,
  type MrLine,
  type MrPlatform,
  type MrRecommendation,
  type MrResult,
  type MrResultStep,
} from "@/lib/recruitment/mr-hiring/vocabulary";
import { isRejectionReason, type RejectionReason } from "@/lib/recruitment/workspace/vocabulary";

export type MrResultInput = {
  step: MrResultStep;
  result: MrResult;
  rating: number | null;
  comment: string;
  decidedWithoutDsm: boolean;
  /** Screening only: why the CV is rejected, in the workspace's own reasons. */
  rejectionReason: RejectionReason | null;
  /** 1st interview only: the area the candidate is applying to, as HR confirmed it. */
  confirmedArea: string | null;
  /** 1st interview only: the line HR confirmed — Pedia adds the RSM interview. */
  confirmedLine: MrLine | null;
};

export type MrRecommendationInput = {
  recommendation: MrRecommendation;
  proposedSalary: number | null;
  proposedJoiningDate: string | null;
  note: string | null;
};

export type MrBookingInput = {
  round: MrInterviewRound;
  dateKey: string;
  startMinutes: number;
  durationMinutes: number;
  platform: MrPlatform;
  location: string | null;
  interviewerHrId: string | null;
  panelistHrIds: string[];
  notes: string | null;
};

/** The largest monthly salary a recommendation may propose — a typo guard, not a pay policy. */
export const MR_SALARY_CEILING = 1_000_000;

function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The request was empty — try again.");
  return raw as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

export function parseMrResultInput(raw: unknown): MrResultInput {
  const body = object(raw);
  if (!isMrResultStep(body.step)) throw new Error("Choose which step this result is for.");
  if (!isMrResult(body.result)) throw new Error("Choose Pass, Keep as backup or Do not pass.");
  const comment = text(body.comment);
  if (!comment) throw new Error("Write a short comment — every result carries one.");
  if (comment.length > MR_COMMENT_LIMIT) throw new Error(`Keep the comment under ${MR_COMMENT_LIMIT} characters.`);
  let rating: number | null = null;
  if (body.rating !== undefined && body.rating !== null && body.rating !== "") {
    const value = Number(body.rating);
    if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error("The rating is 1 to 5.");
    rating = value;
  }
  const decidedWithoutDsm = body.decidedWithoutDsm === true || body.decidedWithoutDsm === "true";
  if (decidedWithoutDsm && body.step !== "dsm") throw new Error("Deciding without feedback applies to the DSM interview only.");
  let rejectionReason: RejectionReason | null = null;
  if (body.step === "hr_screening" && body.result === "not_pass") {
    rejectionReason = isRejectionReason(body.rejectionReason) ? body.rejectionReason : "other";
  }
  // The 1st interview's result confirms where the candidate is applying and on which line (owner,
  // 7 Nov 2026). A pass needs both — the line decides the RSM interview, the area the DSM's folder; a
  // backup or a "do not pass" may carry them. No other step carries either.
  let confirmedArea: string | null = null;
  let confirmedLine: MrLine | null = null;
  if (body.step === "hr_first") {
    confirmedArea = text(body.confirmedArea).replace(/\s+/g, " ") || null;
    if (confirmedArea && confirmedArea.length > MR_AREA_LIMIT) throw new Error("Choose the area from the list.");
    if (body.confirmedLine !== undefined && body.confirmedLine !== null && body.confirmedLine !== "") {
      if (!isMrLine(body.confirmedLine)) throw new Error("Choose Pedia, Anti Infective or CNS.");
      confirmedLine = body.confirmedLine;
    }
    if (body.result === "pass" && !confirmedArea) throw new Error("Confirm the area the candidate is applying to.");
    if (body.result === "pass" && !confirmedLine) throw new Error("Confirm the line — Pedia, Anti Infective or CNS.");
  }
  return { comment, confirmedArea, confirmedLine, decidedWithoutDsm, rating, rejectionReason, result: body.result, step: body.step };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function realDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** `todayCairo` is YYYY-MM-DD in Cairo — a joining date in the past is refused. */
export function parseMrRecommendationInput(raw: unknown, todayCairo: string): MrRecommendationInput {
  const body = object(raw);
  if (!isMrRecommendation(body.recommendation)) throw new Error("Choose Make an offer or Keep as backup.");
  const note = text(body.note) || null;
  if (note && note.length > MR_COMMENT_LIMIT) throw new Error(`Keep the note under ${MR_COMMENT_LIMIT} characters.`);

  let proposedSalary: number | null = null;
  const salaryRaw = typeof body.proposedSalary === "string" ? body.proposedSalary.replace(/[,\s]/g, "") : body.proposedSalary;
  if (salaryRaw !== undefined && salaryRaw !== null && salaryRaw !== "") {
    const value = Number(salaryRaw);
    if (!Number.isFinite(value) || value <= 0) throw new Error("The proposed salary must be a number above zero.");
    if (value > MR_SALARY_CEILING) throw new Error("That salary looks mistyped — check the number.");
    proposedSalary = Math.round(value * 100) / 100;
  }
  let proposedJoiningDate: string | null = null;
  const dateText = text(body.proposedJoiningDate);
  if (dateText) {
    if (!realDay(dateText)) throw new Error("Choose the proposed joining date from the calendar.");
    if (dateText < todayCairo) throw new Error("The proposed joining date cannot be in the past.");
    proposedJoiningDate = dateText;
  }
  if (body.recommendation === "make_offer" && (proposedSalary === null || proposedJoiningDate === null)) {
    throw new Error("To recommend an offer, give the proposed salary and the proposed joining date.");
  }
  return { note, proposedJoiningDate, proposedSalary, recommendation: body.recommendation };
}

/** Cairo and Giza as the governorate field spells them — English (every row today) or Arabic. */
const CAIRO_OR_GIZA = new Set(["cairo", "giza", "القاهرة", "الجيزة"]);

/** Whether a governorate is Cairo or Giza — the §3 rule's own question, read from the governorate. */
export function isCairoOrGiza(governorate: string | null | undefined): boolean {
  return CAIRO_OR_GIZA.has(normalizeGovernorate(governorate));
}

/**
 * The booking request. For the 1st interview, §3 decides the place: Cairo or Giza is in person at the
 * office, anywhere else is Zoom — `inCairoOrGiza` is HR's confirmation of the answer the screen
 * pre-filled from the candidate's governorate — or HR holds it as a phone call, the 1st interview's
 * third way (owner, 7 Nov 2026: "only for hr first interview u will add a third option which is phone
 * call"). The other rounds are in person or Zoom (§5); a phone call is refused for them.
 */
export function parseMrBookingInput(raw: unknown): MrBookingInput {
  const body = object(raw);
  if (!isMrInterviewRound(body.round)) throw new Error("Choose the interview round.");
  const dateKey = text(body.dateKey);
  if (!realDay(dateKey)) throw new Error("Choose the interview day.");
  const startMinutes = Number(body.startMinutes);
  if (!Number.isInteger(startMinutes) || startMinutes < 0 || startMinutes >= 24 * 60) throw new Error("Choose the interview time.");
  let platform: MrPlatform;
  if (body.round === "hr_first") {
    if (body.platform === "phone") {
      platform = "phone";
    } else {
      if (body.inCairoOrGiza !== true && body.inCairoOrGiza !== false) {
        throw new Error("Say whether the candidate is in Cairo or Giza, or choose a phone call.");
      }
      platform = body.inCairoOrGiza ? "in_office" : "zoom";
    }
  } else {
    if (body.platform === "phone") throw new Error("A phone call is for the HR 1st interview only — choose In person or Zoom.");
    if (body.platform !== "zoom" && body.platform !== "in_office") throw new Error("Choose In person or Zoom.");
    platform = body.platform;
  }
  // A phone call's length is never asked: it holds MR_PHONE_CALL_MINUTES whatever the request sent.
  const durationMinutes =
    platform === "phone" ? MR_PHONE_CALL_MINUTES : body.durationMinutes === undefined || body.durationMinutes === "" ? 30 : Number(body.durationMinutes);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 10 || durationMinutes > 240) throw new Error("An interview lasts 10 minutes to 4 hours.");

  const location = platform === "in_office" ? text(body.location) || null : null;
  if (location && location.length > MR_LOCATION_LIMIT) throw new Error(`Keep the location under ${MR_LOCATION_LIMIT} characters.`);

  const interviewerHrId = text(body.interviewerHrId) || null;
  if (body.round !== "hr_first" && !interviewerHrId) throw new Error("Choose who conducts this interview.");
  const panelistHrIds = Array.isArray(body.panelistHrIds)
    ? body.panelistHrIds.filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim())
    : [];
  if (body.round === "joint_final" && panelistHrIds.length === 0 && !interviewerHrId) {
    throw new Error("A joint final has the HR Manager and the NSM — choose both.");
  }
  const notes = text(body.notes) || null;
  return { dateKey, durationMinutes, interviewerHrId, location, notes, panelistHrIds, platform, round: body.round, startMinutes };
}
