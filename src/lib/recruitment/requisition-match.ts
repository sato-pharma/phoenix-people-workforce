// Recruitment / ATS — which OPEN REQUISITION one CV should be attached to, as a recommendation a
// person confirms with one press.
//
// ── THE OWNER'S RULING (2026-10-16) ─────────────────────────────────────────────────────────────
//
// "The system auto screens and matches and recommends, and then by one click from admin the CV is
// requisitioned, or kept shortlisted, or rejected." With three answers that shape this file:
//
//   • "Never recommend Reject." So there are two verdicts and only two: ATTACH, or KEEP. The Reject
//     button stays on the CV for a person to press; nothing here ever proposes it.
//   • "Primary source of truth WhatsApp screening questions; if not available, fall back to the
//     governorate in the CV." So the area the applicant TAPPED in the WhatsApp intake decides the
//     place, and only a CV with no such answer is placed from its own address and governorate.
//   • "Admin or TA." Who may press it is the route's question, not this file's.
//
// ── ONE MATCHING RULE, NOT A SECOND ONE ─────────────────────────────────────────────────────────
//
// The seat a CV is for is already answered in this module by `suggestPositions` (the send picker's
// "Looks like this one") and by `statedSeatQueueMatch` (the seat pile's "Chose Menoufia 1 on
// WhatsApp"). Both are reused here over the seats that have an open requisition, rather than
// re-implementing a title or place rule — see vacancy-applicants.ts for what a second rule costs.
//
// A requisition with NO seat behind it (Office Coordinator, REQ-2026-61D5A3) is offered to the
// same function as a seat with no area, which is exactly the case `suggestPositions` already
// answers on the job alone ("one seat of its kind needs no address").
//
// PURE. Read by a client component; nothing here may import a database client.

import { suggestPositions } from "@/lib/recruitment/position-suggestion";
import type { VacancyOption } from "@/lib/recruitment/vacancy-options";
import { seatPlaceName, statedSeatQueueMatch, type SeatQueueCandidate } from "@/lib/recruitment/vacancy-seat-queue";

/** One requisition that is recruiting now, in the words the recommendation shows. */
export type OpenRequisitionOption = {
  id: string;
  code: string;
  jobTitle: string;
  /** The seat behind it, when there is one. */
  vacancyId: number | null;
  areaName: string | null;
  lineName: string | null;
  regionName: string | null;
};

/** The two verdicts. There is no third: the owner ruled Reject is never recommended. */
export type RequisitionRecommendation =
  | {
      verdict: "attach";
      /** Best first. More than one only when the CV fits several equally — the person picks. */
      options: OpenRequisitionOption[];
      reason: string;
    }
  | { verdict: "keep"; reason: string };

/** Statuses after which a CV is no longer the screen's to place. */
const PLACED_OR_CLOSED = new Set(["hired", "rejected", "sent_to_manager", "withdrawn", "declined_offer"]);

/** "Medical Representative · Nasr City · Pedia" — never a code. */
export function requisitionOptionLabel(option: OpenRequisitionOption): string {
  return [option.jobTitle, option.areaName, option.lineName ?? option.regionName].filter(Boolean).join(" · ");
}

/** The requisitions as seats `suggestPositions` can rank. Seatless ones get a negative id of their own. */
function asSeats(
  requisitions: readonly OpenRequisitionOption[],
  vacancies: readonly VacancyOption[],
): Array<{ seat: VacancyOption; requisition: OpenRequisitionOption }> {
  const byId = new Map(vacancies.map((vacancy) => [vacancy.id, vacancy]));
  const out: Array<{ seat: VacancyOption; requisition: OpenRequisitionOption }> = [];
  const seen = new Set<number>();
  requisitions.forEach((requisition, index) => {
    const real = requisition.vacancyId === null ? undefined : byId.get(requisition.vacancyId);
    if (real) {
      if (seen.has(real.id)) return;
      seen.add(real.id);
      out.push({ requisition, seat: real });
      return;
    }
    out.push({
      requisition,
      seat: {
        areaName: requisition.areaName,
        id: -(index + 1),
        jobTitle: requisition.jobTitle,
        lineName: requisition.lineName,
        managerHrId: null,
        managerName: null,
        regionName: requisition.regionName,
        standingInFor: null,
      } as VacancyOption,
    });
  });
  return out;
}

/**
 * Recommend where this CV goes, or why it stays shortlisted.
 *
 * Null when the CV is not the screen's to place any more — hired, rejected, already with a manager.
 * `attachedRequisitionIds` are the open requisitions it already has an application on.
 */
export function recommendRequisition(input: {
  candidate: SeatQueueCandidate & { status?: string | null };
  requisitions: readonly OpenRequisitionOption[];
  vacancies: readonly VacancyOption[];
  attachedRequisitionIds?: readonly string[];
}): RequisitionRecommendation | null {
  const status = String(input.candidate.status ?? "new").trim().toLowerCase();
  if (PLACED_OR_CLOSED.has(status)) return null;

  const attached = new Set(input.attachedRequisitionIds ?? []);
  const already = input.requisitions.find((requisition) => attached.has(requisition.id));
  if (already) return { reason: `Already attached to ${already.code}.`, verdict: "keep" };

  if (input.requisitions.length === 0) {
    return { reason: "No requisition is open right now.", verdict: "keep" };
  }

  const pairs = asSeats(input.requisitions, input.vacancies);
  const bySeatId = new Map(pairs.map((pair) => [pair.seat.id, pair.requisition]));
  const seats = pairs.map((pair) => pair.seat);
  const job = {
    appliedForJobTitle: input.candidate.appliedForJobTitle ?? null,
    currentJobTitle: input.candidate.currentJobTitle ?? null,
    hasMedicalRepExperience: input.candidate.hasMedicalRepExperience ?? null,
  };

  // 1. A seat a recruiter already sent this CV for — a stated fact, never second-guessed.
  const sentFor = input.candidate.sentForVacancyId;
  if (typeof sentFor === "number" && bySeatId.has(sentFor)) {
    return { options: [bySeatId.get(sentFor)!], reason: "Already sent to a manager for this seat.", verdict: "attach" };
  }

  // 2. THE WHATSAPP ANSWER IS THE SOURCE OF TRUTH FOR PLACE. Asked of the seat pile's own rule, with
  //    every other stated source blanked, so only the area they tapped can claim a seat.
  const declared = String(input.candidate.preferredAreaName ?? "").trim();
  if (declared) {
    const tapped = seats.filter((seat) =>
      statedSeatQueueMatch({ ...job, preferredAreaName: declared }, seat),
    );
    if (tapped.length > 0) {
      const options = tapped.map((seat) => bySeatId.get(seat.id)!);
      return {
        options,
        reason: `Chose ${seatPlaceName(tapped[0])} on WhatsApp.`,
        verdict: "attach",
      };
    }
    // Their answer names no open seat — but a seat with no place (head office) is still decided by
    // the job alone, so it is asked once more with the tapped area as the only address.
    const placeless = suggestPositions({ ...job, address: declared, governorate: null }, seats);
    const headOffice = placeless.confident && placeless.confident.vacancy.areaName === null ? placeless.confident : null;
    if (headOffice) {
      return {
        options: [bySeatId.get(headOffice.vacancy.id)!],
        reason: headOffice.reasons[0] ?? "Their job fits this requisition.",
        verdict: "attach",
      };
    }
    return { reason: `Chose ${declared} on WhatsApp — no requisition is open there.`, verdict: "keep" };
  }

  // 3. No WhatsApp answer: the CV's own address and governorate, through the send picker's rule.
  const read = suggestPositions(
    { ...job, address: input.candidate.address ?? null, governorate: input.candidate.governorate ?? null },
    seats,
  );
  if (read.shortlist.length > 0) {
    return {
      options: read.shortlist.map((entry) => bySeatId.get(entry.vacancy.id)!),
      reason: read.shortlist[0].reasons[0] ?? "Their address and job title match.",
      verdict: "attach",
    };
  }
  return {
    reason: "Their job and place match no open requisition — keep them shortlisted for the next one.",
    verdict: "keep",
  };
}
