import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { toOfferWorkflowStatus } from "../src/lib/employee-lifecycle/workflow.ts";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const NEW_STATUSES = ["pending_approval", "approved", "approval_rejected", "generated", "negotiation_in_progress"];

export function runOfferPipelineStateMachineTests() {
  // toOfferWorkflowStatus maps the new offer statuses to offer_<status> registry keys.
  for (const status of NEW_STATUSES) {
    assert.equal(toOfferWorkflowStatus({ status }), `offer_${status}`, `status ${status} round-trip`);
  }

  // OfferStatus union includes the new pre-send states.
  const service = source("src/lib/offers/service.ts");
  for (const status of NEW_STATUSES) {
    assert.ok(service.includes(`| "${status}"`), `OfferStatus missing ${status}`);
  }

  // The new states must be NON-terminal (loop back / advance).
  const setMatch = service.match(/terminalOfferStatuses = new Set<OfferStatus>\(\[([\s\S]*?)\]\)/);
  assert.ok(setMatch, "terminalOfferStatuses set found");
  for (const status of NEW_STATUSES) {
    assert.ok(!setMatch![1].includes(`"${status}"`), `${status} must be non-terminal`);
  }

  // offers registry: send comes from generated; negotiation loops back to draft.
  const offersRegistry = source("supabase/migrations/20260605093807_20260606091000_offers_registry_pipeline.sql");
  assert.match(offersRegistry, /"key":"offer_send"[\s\S]*?"from":\["offer_generated"\]/, "send comes from generated");
  assert.match(
    offersRegistry,
    /"key":"offer_renegotiate_prepare"[\s\S]*?"to":"offer_draft"/,
    "negotiation re-prepare loops to draft",
  );

  // recruitment mirror: prepare targets offer_draft (from selection or negotiation).
  const recruitmentRegistry = source("supabase/migrations/20260605093925_20260606091500_recruitment_offer_pipeline_stages.sql");
  assert.match(recruitmentRegistry, /"key":"app_offer_prepare"[\s\S]*?"to":"offer_draft"/, "prepare targets offer_draft");
}
