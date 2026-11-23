/**
 * Place checks — the marks on a queue row: a door captured again, and an earlier decision on the same customer.
 * Moved out of `validation-reviews.ts` unchanged on 23 Nov 2026, so no file of Place checks is over 400
 * lines; that file re-exports everything here that it exported, so import from it.
 */

import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { doorCapturedAgain, type DoorPlace } from "@/lib/phoenix-crm/door-captured-again";
import { earlierDecisionOf, type EarlierDecisionSource } from "@/lib/phoenix-crm/earlier-decision";
import { numberOrNull, selectByIds } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames } from "@/lib/phoenix-crm/server/people";
import { validationRefusalLabel } from "@/lib/phoenix-crm/validation-feedback";
import { deciderLabel, type Row, text } from "@/lib/phoenix-crm/server/validation-reviews/shared";
import type { ValidationReviewRow } from "@/lib/phoenix-crm/server/validation-reviews/types";

/**
 * "Approve it after all" is drawn only where the database will take it (19 Nov 2026: the Super Admin pressed
 * it on a customer captured again at the same door and met `restore_door_captured_again`). For every
 * rejection still `restorable`, reads the customer's ACTIVE places once and asks `doorCapturedAgain` — the
 * restore function's own test. A captured-again row loses `restorable` and carries `capturedAgain`, so it
 * shows the reason, offers no button and no tick, and drops back under the ordinary 14-day window like any
 * rejection with nothing left to undo.
 *
 * 🔴 A FAILED READ CHANGES NOTHING — the row keeps its button and the database still refuses by name, which
 * is how the board behaved before; the page never fails over this.
 */
export async function markDoorsCapturedAgain(rows: ValidationReviewRow[], reviews: Row[], placeById: Map<string, Row>): Promise<void> {
  const customerByReview = new Map(reviews.map((review) => [String(review.id), String(review.customer_id)]));
  const candidates = rows.filter((row) => row.restorable && customerByReview.has(row.reviewId));
  if (candidates.length === 0) return;
  let active: Row[];
  try {
    active = await selectByIds<Row>(
      "phoenix_crm_places",
      "id, customer_id, lat, lon, shared_place_id",
      "customer_id",
      candidates.map((row) => customerByReview.get(row.reviewId)),
      (query) => query.eq("status", "active"),
    );
  } catch (error) {
    logError("Phoenix CRM captured-again read failed", { error, labels: { event: "phoenix_crm_captured_again_read_failed" } });
    return;
  }
  const doorOf = (row: Row): DoorPlace => ({
    id: String(row.id),
    customerId: String(row.customer_id),
    lat: numberOrNull(row.lat),
    lon: numberOrNull(row.lon),
    sharedPlaceId: text(row.shared_place_id),
  });
  const activeByCustomer = new Map<string, DoorPlace[]>();
  for (const row of active) {
    const door = doorOf(row);
    activeByCustomer.set(door.customerId, [...(activeByCustomer.get(door.customerId) ?? []), door]);
  }
  for (const row of candidates) {
    const customerId = customerByReview.get(row.reviewId) ?? "";
    const place = placeById.get(row.placeId);
    if (!place) continue;
    if (doorCapturedAgain(doorOf({ ...place, id: row.placeId, customer_id: customerId }), activeByCustomer.get(customerId) ?? [])) {
      row.restorable = false;
      row.capturedAgain = true;
    }
  }
}

/**
 * Every WAITING review learns the customer's latest decision made before it was captured (`earlier-decision.ts`).
 * One read of the decided reviews of the waiting rows' customers — 58 customers on 22 Nov 2026, so one page.
 * The decider's name rides only to a viewer who decides (`decides`), like `decidedByName`.
 *
 * 🔴 A FAILED READ CHANGES NOTHING — the waiting rows keep everything else and say nothing about the past.
 */
export async function markEarlierDecisions(rows: ValidationReviewRow[], reviews: Row[], decides: boolean): Promise<void> {
  const customerByReview = new Map(reviews.map((review) => [String(review.id), String(review.customer_id)]));
  const waiting = rows.filter((row) => row.status === "pending" && customerByReview.has(row.reviewId));
  if (waiting.length === 0) return;
  try {
    const decided = await selectByIds<Row>(
      "phoenix_crm_validation_reviews",
      "id, customer_id, status, decided_at, decided_by_hr_id, refusal_reason",
      "customer_id",
      [...new Set(waiting.map((row) => customerByReview.get(row.reviewId)))],
      (query) => query.in("status", ["approved", "rejected"]).not("decided_at", "is", null),
    );
    const names = decides ? await loadPeopleNames(decided.map((row) => text(row.decided_by_hr_id))) : null;
    const sources: EarlierDecisionSource[] = decided.map((row) => ({
      customerId: String(row.customer_id),
      status: row.status === "approved" ? "approved" : "rejected",
      decidedAt: String(row.decided_at),
      deciderName: names ? deciderLabel(names, text(row.decided_by_hr_id)) : null,
      refusalLabel: row.status === "rejected" ? validationRefusalLabel(text(row.refusal_reason)) : null,
    }));
    for (const row of waiting) {
      const earlier = earlierDecisionOf(customerByReview.get(row.reviewId) ?? "", row.createdAt, sources);
      row.earlierDecision = earlier
        ? {
            status: earlier.status,
            decidedAt: earlier.decidedAt,
            decidedAtText: formatPhoenixDateTime(earlier.decidedAt),
            deciderName: earlier.deciderName,
            refusalLabel: earlier.refusalLabel,
          }
        : null;
    }
  } catch (error) {
    logError("Phoenix CRM earlier-decision read failed", { error, labels: { event: "phoenix_crm_earlier_decision_read_failed" } });
  }
}
