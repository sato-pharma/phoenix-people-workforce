import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decideOutstationRequest,
  outstationCampaignRuleOutcome,
  outstationDvEvidenceWindowClosed,
  outstationTicketEvidenceRejection,
  type OutstationDecisionInput,
} from "../src/lib/outstation/decision.ts";

// The system decision engine: distance floor + governorate rule + DM/TM campaign
// cap + ticket evidence -> accepted_by_system / held_for_review / rejected_by_system.
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
    // Default the whole existing suite to a CLOSED evidence window, so every pre-existing
    // assertion below keeps asserting what it always did. The open-window behaviour is the new
    // thing and is tested explicitly in its own block.
    dvEvidenceWindowClosed: true,
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

  // 3b. The double-visit EVIDENCE WINDOW. Reps enter their visits into iReports through and
  // after the working day, so a trip claimed on its own morning always reads zero double-visits.
  // That is a missing measurement, not proof of no field work, and it auto-rejected two genuine
  // Training Manager claims on 2026-08-09. Inside the window a zero HOLDS; once it closes the
  // rejection is back.
  assert.equal(
    outstationDvEvidenceWindowClosed({ cairoTodayIso: "2026-08-09", tripEndDate: "2026-08-09" }),
    false,
    "a trip claimed on its own day is still inside the evidence window",
  );
  assert.equal(
    outstationDvEvidenceWindowClosed({ cairoTodayIso: "2026-08-10", tripEndDate: "2026-08-09" }),
    false,
    "the day after the trip is still inside the window — visits are still being saved after midnight",
  );
  assert.equal(
    outstationDvEvidenceWindowClosed({ cairoTodayIso: "2026-08-11", tripEndDate: "2026-08-09" }),
    true,
    "two days after the trip the window is closed and an empty record is a real zero",
  );
  assert.equal(
    outstationDvEvidenceWindowClosed({ cairoTodayIso: "2026-08-09", tripEndDate: "2026-09-01" }),
    false,
    "a trip that has not happened yet cannot have evidence",
  );
  // Fail CLOSED: an unreadable date must never switch a live rejection rule off.
  assert.equal(
    outstationDvEvidenceWindowClosed({ cairoTodayIso: "2026-08-11", tripEndDate: "" }),
    true,
    "an unparseable trip date fails closed (window treated as closed), it does not disable the rule",
  );
  assert.equal(
    outstationDvEvidenceWindowClosed({ cairoTodayIso: "not-a-date", tripEndDate: "2026-08-09" }),
    true,
    "an unparseable today fails closed too",
  );

  for (const role of ["District Manager", "Training Manager"]) {
    const sameDay = decideOutstationRequest({
      ...base,
      role,
      expenseType: "traveling",
      totalDvVisits: 0,
      campaignVisits: 0,
      dvEvidenceWindowClosed: false,
    });
    assert.equal(
      sameDay.status,
      "held_for_review",
      `${role} claiming on the trip day is HELD, not rejected, when the CRM has no double-visits yet`,
    );
    assert.match(
      sameDay.reason,
      /not in the CRM yet/i,
      `${role} hold reason says the evidence is not in yet, not that he did no double-visits`,
    );
    assert.doesNotMatch(
      sameDay.reason,
      /No double-visit activity was recorded/i,
      `${role} must not be told he did no double-visits while the evidence window is open`,
    );
    // Once the window closes the original rejection is unchanged.
    assert.equal(
      decideOutstationRequest({
        ...base,
        role,
        expenseType: "traveling",
        totalDvVisits: 0,
        campaignVisits: 0,
        dvEvidenceWindowClosed: true,
      }).status,
      "rejected_by_system",
      `${role} with a genuinely empty double-visit record still rejects once the window has closed`,
    );
    // Over the cap rejects INSIDE the window too: a partial count already above the cap can only
    // grow as more visits are entered, so waiting cannot change the answer.
    assert.equal(
      decideOutstationRequest({
        ...base,
        role,
        expenseType: "traveling",
        totalDvVisits: 5,
        campaignVisits: 3,
        dvEvidenceWindowClosed: false,
      }).status,
      "rejected_by_system",
      `${role} over the campaign cap still rejects while the evidence window is open`,
    );
    // A trip with real double-visits is unaffected by the window either way.
    assert.equal(
      decideOutstationRequest({
        ...base,
        role,
        expenseType: "traveling",
        totalDvVisits: 5,
        campaignVisits: 2,
        dvEvidenceWindowClosed: false,
      }).status,
      "accepted_by_system",
      `${role} with real double-visits is accepted regardless of the window`,
    );
  }

  // The open window must not fail-open the rule for anyone it never covered.
  assert.equal(
    outstationCampaignRuleOutcome({
      campaignVisits: 0,
      dvEvidenceWindowClosed: false,
      expenseType: "traveling",
      role: "Medical Rep",
      totalDvVisits: 0,
    }),
    null,
    "a Medical Rep is outside the campaign rule, window open or closed",
  );
  assert.equal(
    outstationCampaignRuleOutcome({
      campaignVisits: 0,
      dvEvidenceWindowClosed: false,
      expenseType: "meeting",
      role: "District Manager",
      totalDvVisits: 0,
    }),
    null,
    "a meeting expense is outside the campaign rule, window open or closed",
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

  // The campaign rule is the one that auto-rejected two genuine same-day claims. The submit path
  // must CALL the shared rule (not keep a second copy that can drift back), must decide the
  // evidence window from the trip's own end date, and must route a hold into reviewHoldReasons —
  // which is what makes the request persist as `submitted` instead of `rejected_by_system`.
  assert.match(
    serviceSource,
    /outstationCampaignRuleOutcome\(/,
    "submitOutstationRequest must apply the shared campaign rule, not re-implement it",
  );
  assert.match(
    serviceSource,
    /outstationDvEvidenceWindowClosed\(\{\s*\n?\s*cairoTodayIso: cairoTodayIso\(\),\s*\n?\s*tripEndDate: input\.tripEndDate,/,
    "the evidence window must be resolved from the trip's end date against the Cairo calendar day",
  );
  assert.match(
    serviceSource,
    /const campaignHoldReason = campaignRule\?\.kind === "hold" \? campaignRule\.reason : null;/,
    "a campaign HOLD must be kept separate from a campaign rejection",
  );
  assert.match(
    serviceSource,
    /reviewHoldReasons = systemRejectionReason\s*\n?\s*\?\s*\[\]\s*\n?\s*:\s*\[\s*\n?\s*campaignHoldReason,/,
    "the campaign hold must join reviewHoldReasons, so the claim lands in the pending queue rather than being rejected",
  );
  assert.doesNotMatch(
    serviceSource,
    /campaignRejectionReason = campaignRuleOutcome\(/,
    "the campaign outcome must not be collapsed straight back into a rejection reason",
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
