/**
 * Phoenix CRM — a customer's own timeline: his past Phoenix visits, newest first. No I/O.
 *
 * Owner, 2026-10-02, one of the five reports he picked that day. The customer's page used to say only
 * how many times he was seen this month; this is what happened on each of those visits — the day, AM
 * or PM, the products discussed, what the customer objected to, the rep's own comment, and the next
 * step he committed to. It is read on the customer's page, by the rep and by everyone else who may
 * open that customer (`territoryForRead`).
 *
 * ## 🔴 NO LOCATION, NO DISTANCE, NO FLAG
 *
 * Golden Rule #1: the rep's screens never show a check. A timeline entry carries none of the visit's
 * location fields, its distance from the place, its accuracy or its location flag — the server does not
 * even read them for this — so a manager's copy and the rep's copy of a timeline are the same page.
 *
 * Every visit SAVED to the customer is on it, the way the rep's own day lists every visit he saved. An
 * off-plan visit says it was off the plan; whether it was approved is told where it is decided (Team)
 * and on the rep's own day, not here.
 */

import { isUnplannedKind, unplannedKindLabel } from "@/lib/phoenix-crm/unplanned-rules";
import { isVisitNextStep, isVisitObjection, visitNextStepLabel, visitObjectionLabel } from "@/lib/phoenix-crm/visit-outcome";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";

export type TimelineVisit = {
  visitId: string;
  visitDate: string;
  /** The server's own capture time — only ever the tiebreaker between two visits on one day. */
  capturedAt: string;
  listType: PhoenixCrmListType;
  products: ReadonlyArray<string>;
  objection: string | null;
  objectionNote: string | null;
  comment: string | null;
  nextStep: string | null;
  nextStepOn: string | null;
  /** Entered for the rep by the Super Admin, who was not on the visit (missed-records.ts). */
  enteredByAdmin: boolean;
  isUnplanned: boolean;
  unplannedKind: string | null;
};

export type TimelineEntry = {
  visitId: string;
  visitDate: string;
  listType: PhoenixCrmListType;
  products: string[];
  /** What the customer objected to, as the visit recorded it ("No objection" included — it is his answer). */
  objectionLabel: string | null;
  objectionNote: string | null;
  comment: string | null;
  nextStepLabel: string | null;
  nextStepOn: string | null;
  enteredByAdmin: boolean;
  /** "Out of plan" or "Out of list" on an off-plan visit; null on a planned one. */
  offPlanLabel: string | null;
};

function text(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

export function timelineEntry(visit: TimelineVisit): TimelineEntry {
  const objection = isVisitObjection(visit.objection) ? visit.objection : null;
  const nextStep = isVisitNextStep(visit.nextStep) ? visit.nextStep : null;
  return {
    visitId: visit.visitId,
    visitDate: visit.visitDate,
    listType: visit.listType,
    products: visit.products.map((name) => name.trim()).filter(Boolean),
    objectionLabel: objection ? visitObjectionLabel(objection) : null,
    // A note only ever sits beside a real objection (parseVisitOutcome clears it otherwise).
    objectionNote: objection && objection !== "none" ? text(visit.objectionNote) : null,
    comment: text(visit.comment),
    nextStepLabel: nextStep ? visitNextStepLabel(nextStep) : null,
    nextStepOn: nextStep && nextStep !== "none" ? text(visit.nextStepOn) : null,
    enteredByAdmin: visit.enteredByAdmin,
    offPlanLabel: visit.isUnplanned ? unplannedKindLabel(isUnplannedKind(visit.unplannedKind) ? visit.unplannedKind : "out_of_plan") : null,
  };
}

/** Newest first: the latest day, and within a day the latest capture. */
export function buildCustomerTimeline(visits: ReadonlyArray<TimelineVisit>): TimelineEntry[] {
  return [...visits]
    .sort((left, right) => right.visitDate.localeCompare(left.visitDate) || right.capturedAt.localeCompare(left.capturedAt))
    .map(timelineEntry);
}
