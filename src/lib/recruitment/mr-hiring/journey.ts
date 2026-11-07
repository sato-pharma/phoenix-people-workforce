// Recruitment / Medical Rep hiring — one candidate's whole journey (§10), on one line each.
//
// The email asks for one timeline from the WhatsApp CV to the offer: the arrival, the screening, every
// interview, every evaluation, the DSM's and the NSM's recommendations, the decision, and the offer's
// issue date, status, proposed joining date and expiry — visible to everyone involved, salary excluded.
//
// PURE. Takes the candidate's record (ALREADY redacted for the viewer — access.ts) plus the status
// history and the CV sends, and returns the same `CandidateTimelineEvent` lines the candidate page
// renders, so the two timelines read alike. NOTHING HERE INVENTS AN EVENT: every line comes off a
// stored timestamp, as candidate-timeline.ts insists.
//
// MONEY. The offer's pay (`total_monthly`, `cost_of_living`, the template) is never read at all. The
// NSM's proposed salary appears only where the record still carries it — the server has already set
// it to null for anyone who may not see it.

import { buildCandidateTimeline, type CandidateTimelineEvent } from "@/lib/recruitment/candidate-timeline";
import type { MrCandidateRecord } from "@/lib/recruitment/mr-hiring/facts-db";
import { dayLabel, mrWhere } from "@/lib/recruitment/mr-hiring/display";
import { firstOfficialArrival } from "@/lib/recruitment/mr-hiring/official-line";
import {
  MR_LINE_LABELS,
  MR_RECOMMENDATION_LABELS,
  MR_RESULT_STEP_LABELS,
  MR_ROUND_LABELS,
  mrResultLabel,
} from "@/lib/recruitment/mr-hiring/vocabulary";
import type { CandidateStatusEvent, SentForPosition } from "@/lib/recruitment/types";

const MONEY = new Intl.NumberFormat("en-EG", { maximumFractionDigits: 0 });

const OFFER_STATUS_WORDS: Record<string, string> = {
  accepted: "accepted",
  declined: "declined",
  draft: "drafted",
  sent: "sent",
  withdrawn: "withdrawn",
};

export function buildMrJourneyTimeline(
  record: MrCandidateRecord,
  extras: {
    statusEvents?: readonly CandidateStatusEvent[];
    sends?: ReadonlyArray<{ managerName: string | null; sentAt: string; position: SentForPosition | null }>;
    now?: Date;
  } = {},
): CandidateTimelineEvent[] {
  const events: CandidateTimelineEvent[] = [];
  const facts = record.facts;

  const arrival = firstOfficialArrival(record.intake);
  events.push({
    at: arrival?.at ?? facts.receivedAt,
    detail: arrival ? `On ${arrival.lineLabel}` : record.source ? `Arrived via ${record.source} — not on a company WhatsApp` : null,
    id: "mr:arrival",
    kind: "arrival",
    title: arrival ? "CV received on WhatsApp" : "CV received",
  });

  for (const booking of facts.bookings) {
    if (!booking.round) continue;
    const where = mrWhere(booking);
    events.push({
      at: booking.startsAt,
      detail: [where, booking.interviewerName ? `with ${booking.interviewerName}` : null].filter(Boolean).join(" · "),
      id: `mr:booking:${booking.id}`,
      kind: "interview",
      title: MR_ROUND_LABELS[booking.round],
    });
  }

  for (const result of facts.results) {
    const said = mrResultLabel(result.step, result.result);
    const who = result.decidedWithoutDsm ? "Decided by HR, no DSM feedback" : result.byName;
    events.push({
      at: result.createdAt,
      detail: [
        who,
        result.confirmedArea ? `Area ${result.confirmedArea}` : null,
        result.confirmedLine ? `${MR_LINE_LABELS[result.confirmedLine]} line` : null,
        result.rating ? `Rating ${result.rating} of 5` : null,
        result.comment,
      ]
        .filter(Boolean)
        .join(" · "),
      id: `mr:result:${result.id}`,
      kind: "decision",
      title: `${MR_RESULT_STEP_LABELS[result.step]} — ${said}`,
    });
  }

  for (const recommendation of facts.recommendations) {
    const parts = [
      recommendation.byName,
      recommendation.proposedJoiningDate ? `Joining ${dayLabel(recommendation.proposedJoiningDate)}` : null,
      // Present only when the server left it in for this viewer.
      recommendation.proposedSalary !== null ? `Salary EGP ${MONEY.format(recommendation.proposedSalary)} a month` : null,
      recommendation.note,
    ];
    events.push({
      at: recommendation.createdAt,
      detail: parts.filter(Boolean).join(" · "),
      id: `mr:recommendation:${recommendation.id}`,
      kind: "manager",
      title: `NSM recommendation — ${MR_RECOMMENDATION_LABELS[recommendation.recommendation]}`,
    });
  }

  const offer = facts.offer;
  if (offer?.issuedOn) {
    const expired = offer.status === "sent" && offer.validUntil && offer.validUntil < new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(extras.now ?? new Date());
    events.push({
      at: `${offer.issuedOn}T08:00:00.000Z`,
      detail: [
        `Status: ${expired ? "expired" : (OFFER_STATUS_WORDS[offer.status] ?? offer.status)}`,
        offer.validUntil ? `valid until ${dayLabel(offer.validUntil)}` : null,
        offer.startDate ? `proposed joining ${dayLabel(offer.startDate)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      id: `mr:offer:${offer.id}`,
      kind: "decision",
      title: "Offer issued",
    });
  }

  const base = buildCandidateTimeline({ sends: extras.sends ?? [], statusEvents: extras.statusEvents ?? [] });
  return [...events, ...base].sort((left, right) => {
    const difference = new Date(right.at).getTime() - new Date(left.at).getTime();
    return difference !== 0 ? difference : left.id.localeCompare(right.id);
  });
}
