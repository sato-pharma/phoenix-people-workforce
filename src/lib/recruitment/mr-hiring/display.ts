// Recruitment / Medical Rep hiring — the words a screen prints for a candidate's place in the
// workflow. One spelling for the page, the drawer, the manager portal and the opened CV.
//
// PURE and client-safe: no database, no process.env. Times are printed in Cairo.

import type { MrNextAction, MrStage } from "@/lib/recruitment/mr-hiring/stage";
import { MR_CLOSED_LABELS, MR_STEP_LABELS, MR_STEPS, mrStepNumber } from "@/lib/recruitment/mr-hiring/vocabulary";

/** "Sun 9 Nov, 11:00" in Cairo. */
export function cairoWhen(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Cairo", weekday: "short" }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: "Africa/Cairo" }).format(date);
  return `${day}, ${time}`;
}

/** "9 Nov" in Cairo. */
export function cairoDayShort(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Cairo" }).format(date);
}

/** "9 Nov 2026" — a calendar date, as stored (YYYY-MM-DD), never shifted by a timezone. */
export function dayLabel(day: string | null): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, date)),
  );
}

/** "Step 3 of 8 · 2nd interview · DSM", or the closed reason. */
export function mrStageHeadline(stage: MrStage): string {
  if (!stage.open) return MR_CLOSED_LABELS[stage.closed];
  const label = stage.step === "final" && stage.jointFinal ? "Joint final · HR Manager + NSM" : MR_STEP_LABELS[stage.step];
  return `Step ${mrStepNumber(stage.step)} of ${MR_STEPS.length} · ${label}`;
}

/** The second line — what the step is waiting for, in plain words. */
export function mrStageStateLine(stage: MrStage): string {
  if (!stage.open) {
    if (stage.closed === "held") return "The CV did not come through a company WhatsApp, so it is not considered.";
    if (stage.closedAt) {
      const at = stage.closedAt === "final" && stage.jointFinal ? "Joint final · HR Manager + NSM" : MR_STEP_LABELS[stage.closedAt];
      return `At ${at}`;
    }
    return "";
  }
  const booking = stage.booking;
  const where = booking ? (booking.platform === "zoom" ? "Zoom" : `In person · ${booking.location?.trim() || "Head office"}`) : "";
  switch (stage.state) {
    case "to_record":
      return "Waiting for HR to screen the CV";
    case "to_book":
      return "To book";
    case "booked":
      return booking ? `Booked · ${cairoWhen(booking.startsAt)} · ${where}` : "Booked";
    case "awaiting_result": {
      const since = booking ? ` since ${cairoDayShort(booking.startsAt)}` : "";
      if (stage.waitingFor.kind === "interviewer") {
        const who = stage.waitingFor.name ? `${stage.waitingFor.name}'s` : "the interviewer's";
        if (stage.step === "dsm") return `Waiting for ${who} feedback${since}`;
        if (stage.step === "rsm") return `Waiting for ${who} evaluation${since}`;
        return `Waiting for ${who} result${since}`;
      }
      if (stage.waitingFor.kind === "hr_manager") return `Waiting for the HR Manager's result${since}`;
      return `Waiting for HR's result${since}`;
    }
    case "awaiting_recommendation": {
      const who = stage.waitingFor.kind === "interviewer" && stage.waitingFor.name ? `${stage.waitingFor.name}'s` : "the NSM's";
      return `Waiting for ${who} recommendation`;
    }
    case "awaiting_decision":
      return "Waiting for the HR Manager's decision";
    case "to_prepare_offer":
      return "The HR Manager decided to make an offer — prepare it";
    case "offer_draft":
      return "Offer drafted — not sent yet";
    case "offer_sent":
      return "Offer sent — waiting for the candidate";
    case "offer_expired":
      return "Offer expired — the candidate did not answer in time";
    case "offer_accepted":
      return "Offer accepted — mark as hired";
    case "offer_declined":
      return "Offer declined";
    default:
      return "";
  }
}

/** The button words for each next action. */
export const MR_ACTION_LABELS: Record<MrNextAction, string> = {
  book_dsm: "Book DSM interview",
  book_final: "Book final interview",
  book_hr_first: "Book 1st interview",
  book_hr_manager: "Book 3rd interview",
  book_rsm: "Book RSM interview",
  make_decision: "Make the decision",
  mark_hired: "Mark as hired",
  open_offer: "Open the offer",
  prepare_offer: "Prepare offer",
  record_dsm: "Record DSM feedback",
  record_final: "Record final result",
  record_hr_first: "Record 1st interview result",
  record_hr_manager: "Record 3rd interview result",
  record_recommendation: "Write the recommendation",
  record_rsm: "Record RSM evaluation",
  record_screening: "Screen the CV",
};

/** The tone of a stage's marker: done, in progress, waiting on someone, or out. */
export function mrStageTone(stage: MrStage): "orange" | "emerald" | "amber" | "rose" | "sky" | "slate" {
  if (!stage.open) {
    if (stage.closed === "hired") return "emerald";
    if (stage.closed === "rejected") return "rose";
    if (stage.closed === "held") return "slate";
    return "sky";
  }
  if (stage.state === "awaiting_result" || stage.state === "awaiting_recommendation" || stage.state === "awaiting_decision") return "amber";
  if (stage.state === "offer_accepted") return "emerald";
  if (stage.state === "offer_expired" || stage.state === "offer_declined") return "rose";
  return "orange";
}
