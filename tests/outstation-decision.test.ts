import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decideOutstationRequest,
  outstationTicketEvidenceRejection,
  type OutstationDecisionInput,
} from "../src/lib/outstation/decision.ts";

// The system decision engine: distance floor + governorate rule + DM/TM campaign
// cap + ticket evidence -> accepted_by_system / rejected_by_system.
export function runOutstationDecisionTests() {
  const base: OutstationDecisionInput = {
    actualDistanceKm: 120,
    policy: { officialMinimumDistanceKm: 60, toleranceMinimumDistanceKm: 58 },
    destinationGovernorate: "Sohag",
    residenceGovernorate: "Assiut",
    expenseType: "traveling",
    role: "Medical Rep",
    transportationType: "car",
    hasTicketAttachments: false,
    requiresTicketAttachment: false,
    campaignVisits: 0,
    totalDvVisits: 0,
  };

  // Happy path: far enough, different governorate, non-DM/TM role -> accepted.
  assert.equal(decideOutstationRequest(base).status, "accepted_by_system", "clean request is accepted");

  // 1. Distance floor.
  assert.equal(
    decideOutstationRequest({ ...base, actualDistanceKm: 40 }).status,
    "rejected_by_system",
    "below-minimum distance is rejected",
  );
  assert.equal(
    decideOutstationRequest({ ...base, actualDistanceKm: 59 }).status,
    "accepted_by_system",
    "within tolerance (58-60) is accepted",
  );
  assert.equal(
    decideOutstationRequest({ ...base, actualDistanceKm: null }).status,
    "accepted_by_system",
    "unmeasured distance falls through (admin can override), not auto-rejected",
  );

  // 2. Governorate rule (the Assiut -> Dairout case).
  const sameGov = decideOutstationRequest({
    ...base,
    destinationGovernorate: "Assiut",
    residenceGovernorate: "Assiut",
  });
  assert.equal(sameGov.status, "rejected_by_system", "same governorate as residence is rejected");
  assert.match(sameGov.reason, /same governorate/i, "reason names the governorate rule");
  assert.equal(
    decideOutstationRequest({ ...base, destinationGovernorate: null }).status,
    "accepted_by_system",
    "unresolved destination governorate does not auto-reject (fail-open)",
  );

  // 3. Campaign cap — District Manager / Training Manager, traveling only.
  const dmTravel = { ...base, role: "District Manager", expenseType: "traveling" as const };
  assert.equal(
    decideOutstationRequest({ ...dmTravel, totalDvVisits: 5, campaignVisits: 2 }).status,
    "accepted_by_system",
    "DM traveling with 2 campaign visits is accepted",
  );
  assert.equal(
    decideOutstationRequest({ ...dmTravel, totalDvVisits: 5, campaignVisits: 3 }).status,
    "rejected_by_system",
    "DM traveling with 3 campaign visits is rejected",
  );
  assert.equal(
    decideOutstationRequest({ ...dmTravel, totalDvVisits: 0, campaignVisits: 0 }).status,
    "rejected_by_system",
    "DM traveling with zero double-visits is rejected",
  );
  assert.equal(
    decideOutstationRequest({ ...base, role: "Training Manager", expenseType: "traveling", totalDvVisits: 4, campaignVisits: 4 }).status,
    "rejected_by_system",
    "Training Manager is subject to the campaign cap too",
  );
  // Non-traveling expense types bypass the campaign rule entirely.
  assert.equal(
    decideOutstationRequest({ ...dmTravel, expenseType: "meeting", totalDvVisits: 0, campaignVisits: 9 }).status,
    "accepted_by_system",
    "a meeting expense ignores the campaign/zero-visit rule",
  );
  // Non-DM/TM roles ignore the campaign rule.
  assert.equal(
    decideOutstationRequest({ ...base, role: "Medical Rep", expenseType: "traveling", totalDvVisits: 0, campaignVisits: 7 }).status,
    "accepted_by_system",
    "a Medical Rep is not subject to the campaign cap",
  );

  // Explicit submitter-role coverage (the four roles that submit outstation trips):
  // GPM / PM are NOT field double-visitors, so the campaign cap must NOT apply to them;
  // TM / DM ARE subject to it. Traveling + zero visits is the discriminating case.
  for (const role of ["Group Product Manager", "Product Manager"]) {
    assert.equal(
      decideOutstationRequest({
        ...base,
        role,
        expenseType: "traveling",
        totalDvVisits: 0,
        campaignVisits: 9,
      }).status,
      "accepted_by_system",
      `${role} is NOT subject to the campaign cap (traveling, 0 visits, 9 campaign -> accepted)`,
    );
  }
  for (const role of ["District Manager", "Training Manager"]) {
    assert.equal(
      decideOutstationRequest({
        ...base,
        role,
        expenseType: "traveling",
        totalDvVisits: 0,
        campaignVisits: 0,
      }).status,
      "rejected_by_system",
      `${role} IS subject to the campaign cap (traveling, zero double-visits -> rejected)`,
    );
    assert.equal(
      decideOutstationRequest({
        ...base,
        role,
        expenseType: "traveling",
        totalDvVisits: 5,
        campaignVisits: 2,
      }).status,
      "accepted_by_system",
      `${role} traveling with <=2 campaign visits is accepted`,
    );
    assert.equal(
      decideOutstationRequest({
        ...base,
        role,
        expenseType: "traveling",
        totalDvVisits: 5,
        campaignVisits: 3,
      }).status,
      "rejected_by_system",
      `${role} traveling with >2 campaign visits is rejected`,
    );
    // A meeting expense bypasses the cap even for TM / DM.
    assert.equal(
      decideOutstationRequest({
        ...base,
        role,
        expenseType: "meeting",
        totalDvVisits: 0,
        campaignVisits: 9,
      }).status,
      "accepted_by_system",
      `${role} meeting expense bypasses the campaign cap`,
    );
  }

  // 4. Ticket evidence for train/bus.
  assert.equal(
    decideOutstationRequest({ ...base, transportationType: "train", requiresTicketAttachment: true, hasTicketAttachments: false }).status,
    "rejected_by_system",
    "train without a required ticket attachment is rejected",
  );
  assert.equal(
    decideOutstationRequest({ ...base, transportationType: "train", requiresTicketAttachment: true, hasTicketAttachments: true }).status,
    "accepted_by_system",
    "train with a ticket attachment is accepted",
  );

  // Rule ordering: distance is checked before governorate.
  assert.match(
    decideOutstationRequest({ ...base, actualDistanceKm: 10, destinationGovernorate: "Assiut", residenceGovernorate: "Assiut" }).reason,
    /distance|policy/i,
    "distance rejection wins over governorate when both fail",
  );

  // Rule 4 is exported on its own because the live submit path must apply the
  // SAME rule; decideOutstationRequest is a pure engine production does not call
  // end-to-end (rules 1-3 are computed upstream in calculateOutstationExpense).
  assert.equal(
    outstationTicketEvidenceRejection({ hasTicketAttachments: false, requiresTicketAttachment: true, transportationType: "train" }),
    "Train or bus expenses require an attached ticket before they can be accepted.",
    "ticket rule rejects a ticketless train claim",
  );
  assert.equal(
    outstationTicketEvidenceRejection({ hasTicketAttachments: false, requiresTicketAttachment: true, transportationType: "bus" }),
    "Train or bus expenses require an attached ticket before they can be accepted.",
    "ticket rule rejects a ticketless bus claim",
  );
  assert.equal(
    outstationTicketEvidenceRejection({ hasTicketAttachments: true, requiresTicketAttachment: true, transportationType: "train" }),
    null,
    "a train claim carrying a ticket passes",
  );
  assert.equal(
    outstationTicketEvidenceRejection({ hasTicketAttachments: false, requiresTicketAttachment: true, transportationType: "car" }),
    null,
    "car transport is not ticket-based and is unaffected",
  );
  assert.equal(
    outstationTicketEvidenceRejection({ hasTicketAttachments: false, requiresTicketAttachment: false, transportationType: "train" }),
    null,
    "the mandate is policy-driven — a role whose policy does not require tickets is unaffected",
  );

  // The live money path. These pin the submit pipeline in service.ts, because a
  // green decision.ts alone proved nothing: production never called it, and an
  // offline train/bus claim with no ticket was written straight to payroll as
  // accepted_by_system.
  const serviceSource = readFileSync("src/lib/outstation/service.ts", "utf8");
  assert.match(
    serviceSource,
    /outstationTicketEvidenceRejection\(/,
    "submitOutstationRequest must apply the shared ticket rule, not re-implement or skip it",
  );
  assert.doesNotMatch(
    serviceSource,
    /!calculation\.offlineCaptured &&\s*\n?\s*ticketAttachmentInputs\.length === 0/,
    "the ticket mandate must not be silently exempted for offline captures — offline claims hold for review instead of auto-accepting",
  );
  assert.match(
    serviceSource,
    /gpsAccuracyThresholdMeters/,
    "the admin-editable GPS accuracy threshold must be enforced, not decorative",
  );
  assert.match(
    serviceSource,
    /maxOfflineSyncDelayHours/,
    "the admin-editable offline sync-delay window must be enforced, not decorative",
  );

  // The online submit route must not let a caller self-declare an offline
  // capture: that flag is what exempts a request from the ticket mandate, and
  // the genuine offline path posts to /api/outstation/sync-offline instead.
  const submitRouteSource = readFileSync("app/api/outstation/submit/route.ts", "utf8");
  assert.doesNotMatch(
    submitRouteSource,
    /offlineCaptured:\s*Boolean\(body\.offlineCaptured\)/,
    "the online submit route must not trust a client-supplied offlineCaptured flag",
  );
  assert.match(
    submitRouteSource,
    /offlineCaptured:\s*false/,
    "the online submit route must pin offlineCaptured to false",
  );
}
