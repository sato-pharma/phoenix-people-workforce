import assert from "node:assert/strict";

import {
  customerIsEvidenceValidated,
  type FieldEvidenceGapInput,
} from "@/lib/marketing-requests/validation-report";
import type { MarketingEvidenceStatus } from "@/lib/marketing-requests/types";

/**
 * `customerIsEvidenceValidated` — the owner's live definition of a validated marketing customer
 * (2026-09-24): a complete live photo + location on the customer AND on EVERY pharmacy linked to
 * him, decided fresh from the evidence, never from the stored `validation_status` stamp.
 *
 * This is what the Validated / Validate tabs route on. It exists because the stamp goes stale in both
 * directions — a 2026-07-02 history backfill and the desk path minted a validated status with no
 * live photo, and a link kept its validated status after its shop's evidence was cleared — so a
 * customer could read "validated" for ever with nothing captured. These cases pin that only a full,
 * present capture on both halves counts, and that one short shop is enough to hold the whole customer
 * in the queue.
 */
function row(
  customerEvidenceStatus: MarketingEvidenceStatus,
  pharmacyEvidenceStatus: MarketingEvidenceStatus,
  markers?: Partial<Pick<FieldEvidenceGapInput, "deskValidated" | "inferredFromHistory" | "secondCodeBackfill">>,
): FieldEvidenceGapInput {
  return {
    customerEvidenceStatus,
    pharmacyEvidenceStatus,
    deskValidated: markers?.deskValidated ?? false,
    inferredFromHistory: markers?.inferredFromHistory ?? false,
    secondCodeBackfill: markers?.secondCodeBackfill ?? false,
  };
}

export function runMarketingValidationReportTests() {
  // Zero links → not validated: there is no captured venue to have validated the customer at all.
  assert.equal(customerIsEvidenceValidated([]), false, "a customer with no links is not validated");

  // The one validated shape: customer complete AND every linked shop complete.
  assert.equal(
    customerIsEvidenceValidated([row("complete", "complete")]),
    true,
    "customer + its one shop both captured → validated",
  );
  assert.equal(
    customerIsEvidenceValidated([row("complete", "complete"), row("complete", "complete")]),
    true,
    "customer + ALL shops captured → validated",
  );

  // One short shop holds the whole customer back — `every`, not `some`.
  assert.equal(
    customerIsEvidenceValidated([row("complete", "complete"), row("complete", "pending")]),
    false,
    "one shop still short of a live photo keeps the customer in the queue",
  );
  assert.equal(
    customerIsEvidenceValidated([row("complete", "complete"), row("complete", "missing")]),
    false,
    "one shop never visited keeps the customer in the queue",
  );

  // The customer half must be there too — a captured shop cannot validate an uncaptured customer.
  assert.equal(
    customerIsEvidenceValidated([row("pending", "complete")]),
    false,
    "a coordinate without a live photo on the customer is not enough",
  );
  assert.equal(
    customerIsEvidenceValidated([row("missing", "complete")]),
    false,
    "no customer capture at all → not validated, however complete the shop",
  );

  // The stored-stamp markers must NOT rescue an incomplete capture — the whole point of routing on
  // evidence instead of the frozen status. A desk pick (no live photo) and a history backfill both
  // fall to the queue on their own.
  assert.equal(
    customerIsEvidenceValidated([row("pending", "missing", { deskValidated: true })]),
    false,
    "a desk validation with no live photo does not count",
  );
  assert.equal(
    customerIsEvidenceValidated([row("missing", "missing", { inferredFromHistory: true })]),
    false,
    "a 2026-07-02 history-backfill stub with no capture does not count",
  );
}
