import assert from "node:assert/strict";

import { decideOutstationRequest, type OutstationDecisionInput } from "../src/lib/outstation/decision.ts";

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
}
