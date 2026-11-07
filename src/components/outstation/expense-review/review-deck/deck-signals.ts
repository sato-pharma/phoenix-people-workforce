import type { ClaimValidationOutcome } from "@/components/outstation/expense-claim-validation-panel";
import type { AttachmentsData } from "@/components/outstation/trip-attachments";
import type { TripWorkloadEvidence } from "@/components/outstation/trip-workload-evidence";
import { isWorkedTripDay } from "@/lib/crm/trip-day-meetings";
import { formatNumberValue } from "@/lib/i18n/format";
import { outstationRequestIdFromTripId } from "@/lib/outstation/expense-approval-decisions";

import type { LoadedRecord } from "../review-model";

/** One sentence of "What the system found", and how it reads at a glance. */
export type Signal = { line: string; tone: "danger" | "loading" | "neutral" | "ok" | "warn" };

export type TripSignals = { claim: Signal; crm: Signal; fieldWork: Signal; photos: Signal };

export const SIGNAL_TONE: Record<Signal["tone"], { bar: string; dot: string; text: string }> = {
  danger: { bar: "border-l-rose-500", dot: "bg-rose-500", text: "text-rose-700" },
  loading: { bar: "border-l-slate-300", dot: "bg-slate-500", text: "text-slate-500" },
  neutral: { bar: "border-l-slate-300", dot: "bg-slate-400", text: "text-slate-600" },
  ok: { bar: "border-l-emerald-500", dot: "bg-emerald-500", text: "text-emerald-700" },
  warn: { bar: "border-l-amber-500", dot: "bg-amber-500", text: "text-amber-800" },
};

/**
 * The four sentences the reviewer reads before anything else — field work, Phoenix CRM, claim checks,
 * photos — each worded from what its evidence panel loaded (`undefined` while it is still reading). A
 * meeting day is a worked day (trip-day-meetings.ts): said plainly, never in rose. The Phoenix CRM
 * sentence is the reading's own (crm-trip-evidence.ts), handed up by its section.
 */
export function tripSignals(input: {
  attachments: AttachmentsData | null | undefined;
  claimOutcome: ClaimValidationOutcome | undefined;
  crm: Signal;
  record: LoadedRecord;
  workload: TripWorkloadEvidence | null | undefined;
}): TripSignals {
  return {
    claim: claimSignal(input.record, input.claimOutcome),
    crm: input.crm,
    fieldWork: fieldWorkSignal(input.record, input.workload),
    photos: photoSignal(input.record, input.attachments),
  };
}

function fieldWorkSignal(record: LoadedRecord, workload: TripWorkloadEvidence | null | undefined): Signal {
  if (!record.hrId) return { line: "This trip is not linked to an employee, so its visits cannot be verified.", tone: "warn" };
  if (workload === undefined) return { line: "Reading the CRM", tone: "loading" };
  if (workload === null) return { line: "The workload evidence could not be loaded.", tone: "warn" };
  if (workload.matchStatus === "unmapped") return { line: "No CRM identity is mapped for this employee.", tone: "warn" };
  const days = workload.dateBreakdown;
  const idle = days.filter((day) => !isWorkedTripDay(day)).length;
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const meetingDays = days.filter((day) => day.total === 0 && isWorkedTripDay(day)).length;
  if (days.length > 0 && idle === days.length) {
    return {
      line: days.length > 1 ? `No field activity on any of the ${formatNumberValue(days.length)} days.` : "No field activity on this day.",
      tone: "danger",
    };
  }
  if (idle > 0) return { line: `${formatNumberValue(idle)} of ${formatNumberValue(days.length)} days with no field activity.`, tone: "warn" };
  if (meetingDays > 0) {
    if (total === 0) {
      return {
        line: days.length > 1 ? "A meeting recorded on every day · no field visits." : "A meeting recorded on the day · no field visits.",
        tone: "neutral",
      };
    }
    return {
      line: `Worked every day · ${formatNumberValue(total)} field visits, and a meeting on ${formatNumberValue(meetingDays)} day${meetingDays === 1 ? "" : "s"}.`,
      tone: "ok",
    };
  }
  return {
    line: days.length > 1 ? `Visits on every day · ${formatNumberValue(total)} field visits.` : `${formatNumberValue(total)} field visits on the day.`,
    tone: "ok",
  };
}

function claimSignal(record: LoadedRecord, outcome: ClaimValidationOutcome | undefined): Signal {
  if (outstationRequestIdFromTripId(record.tripId) === null) return { line: "Not available for an imported row.", tone: "neutral" };
  if (outcome === undefined) return { line: "Checking the claim", tone: "loading" };
  if (outcome === "clean") return { line: "Verified against the day's CRM activity.", tone: "ok" };
  if (outcome === "review") return { line: "Needs a look.", tone: "danger" };
  if (outcome === "unverifiable") return { line: "Could not verify: no CRM activity to compare against.", tone: "neutral" };
  if (outcome === "error") return { line: "The checks could not be loaded.", tone: "warn" };
  return { line: "Not available.", tone: "neutral" };
}

function photoSignal(record: LoadedRecord, attachments: AttachmentsData | null | undefined): Signal {
  if (outstationRequestIdFromTripId(record.tripId) === null) return { line: "Uploaded from sheet · no photos.", tone: "neutral" };
  if (attachments === undefined) return { line: "Loading the photos", tone: "loading" };
  if (attachments === null || !attachments.found) return { line: "The photos could not be loaded.", tone: "warn" };
  const photos = attachments.photos ?? [];
  const tickets = attachments.tickets?.length ?? 0;
  // Every upload is counted out loud — a manager's pictures must never hide behind "Not required".
  const uploaded = tickets > 0 ? `${formatNumberValue(tickets)} uploaded ${tickets === 1 ? "picture or file" : "pictures and files"}` : null;
  const departure = photos.find((photo) => photo.kind === "departure");
  const arrival = photos.find((photo) => photo.kind === "arrival");
  if (departure?.isFlagged && departure.review) return { line: departure.review, tone: "danger" };
  const missing = photos.find((photo) => !photo.url && photo.missingNote);
  const withUploads = (line: string) => (uploaded ? `${line} · ${uploaded}` : line);
  if (missing?.missingNote) {
    if (missing.missingNote.startsWith("Not required")) {
      return uploaded ? { line: `No trip photos owed · ${uploaded} to look at.`, tone: "ok" } : { line: missing.missingNote, tone: "neutral" };
    }
    return { line: withUploads(missing.missingNote), tone: "warn" };
  }
  if (arrival?.sourceNote) return { line: withUploads(`Arrival photo ${arrival.sourceNote.toLowerCase()}`), tone: "warn" };
  if (departure?.gpsMissingReason) return { line: withUploads(`Departure photo: ${departure.gpsMissingReason}`), tone: "warn" };
  return {
    line: `Arrival and departure photos captured live, with GPS${tickets > 0 ? ` · ${formatNumberValue(tickets)} ticket${tickets === 1 ? "" : "s"}` : ""}.`,
    tone: "ok",
  };
}
