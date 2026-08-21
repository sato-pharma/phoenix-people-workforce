import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  actionForOfferResponse,
  canSendOffer,
  isOfferResponse,
  isOfferStage,
  missingOfferTerms,
  offerSendBlockReason,
  prepareActionForStage,
} from "../src/lib/recruitment/offer-rules.ts";

/**
 * The offer chain existed in workflow_registry_modules long before it existed in code: twelve
 * role-gated actions, live in production, with approval restricted to Super Admin. What was missing
 * was anywhere to keep the terms, so every offer stage was unreachable and no application ever got
 * past offer_initiated.
 *
 * These cover the half the registry cannot express — whether the terms are complete, and whether an
 * offer is allowed to reach a candidate yet.
 */

function trail(overrides: Partial<Record<"submittedForApprovalAt" | "approvedAt" | "sentAt", string | null>> = {}) {
  return {
    jobTitle: "Medical Representative",
    monthlyGross: 12000,
    startDate: "2026-09-01",
    submittedForApprovalAt: "2026-08-21T09:00:00.000Z",
    approvedAt: "2026-08-21T10:00:00.000Z",
    sentAt: null,
    ...overrides,
  };
}

export function runRecruitmentOffersTests() {
  // ── The terms, named in the words the recruiter reads ────────────────────────────────────────
  assert.deepEqual(
    missingOfferTerms({ jobTitle: null, monthlyGross: null, startDate: null }),
    ["job title", "monthly gross salary", "start date"],
    "an empty offer must name all three missing terms, not just fail",
  );
  assert.deepEqual(
    missingOfferTerms({ jobTitle: "   ", monthlyGross: 12000, startDate: "2026-09-01" }),
    ["job title"],
    "a whitespace-only job title is not a job title",
  );
  assert.deepEqual(
    missingOfferTerms({ jobTitle: "Rep", monthlyGross: 0, startDate: "2026-09-01" }),
    ["monthly gross salary"],
    "a zero salary is not a salary",
  );
  assert.deepEqual(
    missingOfferTerms({ jobTitle: "Rep", monthlyGross: -5, startDate: "2026-09-01" }),
    ["monthly gross salary"],
    "a negative salary is not a salary",
  );
  assert.deepEqual(
    missingOfferTerms({ jobTitle: "Rep", monthlyGross: Number.NaN, startDate: "2026-09-01" }),
    ["monthly gross salary"],
    "NaN reaches here whenever the salary box holds something unparseable — it must not count as a figure",
  );
  assert.deepEqual(
    missingOfferTerms({ jobTitle: "Rep", monthlyGross: 12000, startDate: "2026-09-01" }),
    [],
    "a complete offer is missing nothing",
  );

  // ── THE HEADLINE: an unapproved offer can never be sent ──────────────────────────────────────
  // The owner chose "one approval before sending". The workflow registry alone does NOT deliver
  // that: it lists app_offer_sent as reachable from offer_initiated as well as offer_generated, so
  // the stage machine on its own would let an offer reach a candidate having never been approved.
  // This is the guard that closes that path, which is why it reads approvedAt and not the stage.
  assert.equal(
    canSendOffer(trail({ approvedAt: null })),
    false,
    "an offer that has not been approved must never be sendable — this is the owner's one-approval rule",
  );
  assert.match(
    offerSendBlockReason(trail({ approvedAt: null })) ?? "",
    /waiting for approval/i,
    "the refusal must say the offer is waiting for approval, so the recruiter knows what to do next",
  );

  assert.equal(canSendOffer(null), false, "there is nothing to send before an offer exists");
  assert.match(offerSendBlockReason(null) ?? "", /no offer/i, "a missing offer must say so plainly");

  assert.equal(
    canSendOffer(trail({ submittedForApprovalAt: null, approvedAt: null })),
    false,
    "an offer never submitted for approval cannot be sent",
  );
  assert.equal(
    canSendOffer({ ...trail(), monthlyGross: null }),
    false,
    "incomplete terms block the send even when the trail looks approved",
  );
  assert.equal(
    canSendOffer(trail({ sentAt: "2026-08-21T11:00:00.000Z" })),
    false,
    "an offer already sent must not be sendable twice",
  );
  assert.equal(canSendOffer(trail()), true, "a complete, approved, unsent offer is sendable");
  assert.equal(offerSendBlockReason(trail()), null, "a sendable offer has no blocking reason");

  // ── Where a draft can be prepared from ───────────────────────────────────────────────────────
  assert.equal(prepareActionForStage("offer_initiated"), "app_offer_prepare");
  assert.equal(
    prepareActionForStage("offer_negotiation"),
    "app_offer_prepare",
    "a candidate who came back negotiating must be able to get a fresh draft",
  );
  assert.equal(
    prepareActionForStage("offer_draft"),
    null,
    "editing a draft is not a transition — returning an action here would move the stage onto itself",
  );
  assert.equal(
    prepareActionForStage("cv_screening"),
    null,
    "an application nowhere near an offer has no prepare action",
  );

  // ── The candidate's answer maps to the registry's own action keys ────────────────────────────
  assert.equal(actionForOfferResponse("accepted"), "app_offer_accepted");
  assert.equal(actionForOfferResponse("declined"), "app_offer_declined");
  assert.equal(actionForOfferResponse("expired"), "app_offer_expired");
  assert.equal(isOfferResponse("accepted"), true);
  assert.equal(isOfferResponse("hired"), false, "a stage name is not a candidate answer");
  assert.equal(isOfferResponse(null), false);

  // ── The stages the offer panel owns ──────────────────────────────────────────────────────────
  for (const stage of ["offer_initiated", "offer_draft", "offer_pending_approval", "offer_sent", "offer_accepted"]) {
    assert.equal(isOfferStage(stage), true, `${stage} must open the offer panel`);
  }
  assert.equal(isOfferStage("final_selection"), false, "final selection is the step before an offer, not an offer");
  assert.equal(isOfferStage("hired"), false, "hired is past the offer");

  // ── The table the service writes to must actually be created ─────────────────────────────────
  // A migration file is not an applied migration (that is checked before the migration runs, not
  // here) — but a service writing to a table no migration creates is a defect this can catch.
  const migration = readFileSync("supabase/migrations/20260821160000_ats_offers.sql", "utf8");
  assert.match(migration, /create table if not exists public\.ats_offers/, "the migration must create ats_offers");
  assert.match(
    migration,
    /application_id uuid not null unique/,
    "one offer per application — without the unique constraint the upsert in offers.ts has no conflict target and would insert duplicates",
  );

  // ── The send guard must stay wired into the service ──────────────────────────────────────────
  // The pure rule above is only worth anything if markOfferSent still consults it.
  const service = readFileSync("src/lib/recruitment/offers.ts", "utf8");
  assert.match(
    service,
    /if \(!canSendOffer\(offer\)\)/,
    "markOfferSent must refuse through canSendOffer — removing that call reopens the registry's unapproved-send path",
  );
}
