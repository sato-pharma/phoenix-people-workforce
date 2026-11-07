import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decideOutstationRequest,
  outstationCampaignRuleOutcome,
  outstationDvEvidenceWindowClosed,
  outstationTicketEvidenceRejection,
  type OutstationDecisionInput,
} from "../src/lib/outstation/decision.ts";
import { isUnplannedFieldVisit } from "../src/lib/crm/visit-type-meaning.ts";

/** The body of one top-level function, so a pin can target the submit path alone. */
function functionSlice(src: string, declaration: string) {
  const start = src.indexOf(declaration);
  assert.notEqual(start, -1, `expected to find ${declaration}`);
  const rest = src.slice(start + declaration.length);
  const nextExport = rest.indexOf("\nexport ");
  const nextFn = rest.indexOf("\nasync function ");
  const ends = [nextExport, nextFn].filter((i) => i !== -1);
  const end = ends.length > 0 ? Math.min(...ends) : rest.length;
  return rest.slice(0, end);
}

// The system decision engine: distance floor + governorate rule + DM/TM campaign
// cap + ticket evidence -> accepted_by_system / held_for_review / rejected_by_system.
//
// NOTE the split of responsibility since the owner's 2026-08-09 rule: the engine still
// CLASSIFIES a breach as a rejection, because that is what the rule says about the claim. What
// changed is that the live submit path no longer ACTS on it — it flags for a Super Admin. The
// engine is the analysis; the human is the decision.
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
      /not in Phoenix CRM yet/i,
      `${role} hold reason says the evidence is not in yet, not that he did no double-visits`,
    );
    assert.doesNotMatch(
      sameDay.reason,
      /No field visits were recorded/i,
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

  // 3c. The cap counts UNPLANNED visits, his double visits' and his own (owner, 6 Nov 2026:
  // "replace campagin with unplanned visist"; a manager's own single visits count to him).
  // Phoenix serves every visit as visit_type 0, so unplanned is read from is_unplanned; on
  // archive days the old campaign visit (-8) still counts as unplanned.
  assert.equal(isUnplannedFieldVisit({ is_unplanned: true, visit_type: 0 }), true, "a Phoenix unplanned visit is unplanned");
  assert.equal(isUnplannedFieldVisit({ visit_type: -8 }), true, "an archived campaign visit counts as unplanned");
  assert.equal(isUnplannedFieldVisit({ is_unplanned: false, visit_type: 0 }), false, "a planned Phoenix visit is planned");
  assert.equal(isUnplannedFieldVisit({ visit_type: 0 }), false, "a plain archived visit is planned");

  const overCap = outstationCampaignRuleOutcome({
    campaignVisits: 3,
    dvEvidenceWindowClosed: true,
    expenseType: "traveling",
    role: "District Manager",
    totalDvVisits: 6,
  });
  assert.equal(overCap?.kind, "reject", "three unplanned visits break the cap");
  assert.match(overCap?.reason ?? "", /at most 2 unplanned visits/, "the refusal names unplanned visits, not campaign visits");
  assert.doesNotMatch(overCap?.reason ?? "", /campaign/i, "the word campaign is gone from the refusal");

  // His own visits could not be read: a zero total is unmeasured, so it HOLDS even after the window.
  assert.equal(
    outstationCampaignRuleOutcome({
      campaignVisits: 0,
      dvEvidenceWindowClosed: true,
      expenseType: "traveling",
      ownVisitsUnmeasured: true,
      role: "District Manager",
      totalDvVisits: 0,
    })?.kind,
    "hold",
    "a zero total with his own visits unread is held, never rejected",
  );
  const emptyTrip = outstationCampaignRuleOutcome({
    campaignVisits: 0,
    dvEvidenceWindowClosed: true,
    expenseType: "traveling",
    ownVisitsUnmeasured: false,
    role: "District Manager",
    totalDvVisits: 0,
  });
  assert.equal(emptyTrip?.kind, "reject", "a measured empty trip is still rejected once the window has closed");
  assert.match(emptyTrip?.reason ?? "", /no own visit/, "the refusal says both parts were empty");

  // The submit path feeds both parts: his own visits join the total and the unplanned count, and an
  // unread own count is passed as unmeasured.
  const campaignRuleSlice = functionSlice(readFileSync("src/lib/outstation/service.ts", "utf8"), "function campaignRuleOutcome(");
  assert.match(campaignRuleSlice, /ownVisitsUnmeasured:\s*ownTotal === undefined/, "an unread own count holds the claim");
  assert.match(campaignRuleSlice, /totalDvVisits:\s*doubleTotal \+ \(ownTotal \?\? 0\)/, "his own visits join the total");
  assert.match(campaignRuleSlice, /campaignVisits:\s*doubleUnplanned \+ \(ownTotal === undefined \? 0 : ownUnplanned\)/, "his own unplanned visits join the cap");

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
    outstationTicketEvidenceRejection({ role: "Medical Rep", hasTicketAttachments: false, requiresTicketAttachment: true, transportationType: "train" }),
    "Train or bus expenses require an attached ticket before they can be accepted.",
    "ticket rule rejects a ticketless train claim",
  );
  assert.equal(
    outstationTicketEvidenceRejection({ role: "Medical Rep", hasTicketAttachments: false, requiresTicketAttachment: true, transportationType: "bus" }),
    "Train or bus expenses require an attached ticket before they can be accepted.",
    "ticket rule rejects a ticketless bus claim",
  );
  assert.equal(
    outstationTicketEvidenceRejection({ role: "Medical Rep", hasTicketAttachments: true, requiresTicketAttachment: true, transportationType: "train" }),
    null,
    "a train claim carrying a ticket passes",
  );
  assert.equal(
    outstationTicketEvidenceRejection({ role: "Medical Rep", hasTicketAttachments: false, requiresTicketAttachment: true, transportationType: "car" }),
    null,
    "car transport is not ticket-based and is unaffected",
  );
  assert.equal(
    outstationTicketEvidenceRejection({ role: "Medical Rep", hasTicketAttachments: false, requiresTicketAttachment: false, transportationType: "train" }),
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
  assert.doesNotMatch(
    serviceSource,
    /campaignRejectionReason = campaignRuleOutcome\(/,
    "the campaign outcome must not be collapsed straight back into a rejection reason",
  );

  // ── Owner rule, 2026-08-09: THE SYSTEM FLAGS, IT NEVER REJECTS ──────────────────────────────
  // Every automated check still runs and every failure is still recorded — but a failure now
  // holds the claim for a Super Admin instead of refusing it. `rejected_by_system` must not be
  // reachable from the submit path at all; only a human rejects, as `rejected_by_admin`.
  //
  // Pinned against the SUBMIT SLICE rather than the whole file, because the admin reject path
  // lower down is a human decision and must keep working.
  const submitSlice = functionSlice(serviceSource, "export async function submitOutstationRequest");
  assert.doesNotMatch(
    submitSlice,
    /["']rejected_by_system["']/,
    "submitOutstationRequest must never write rejected_by_system — the system flags, a human rejects",
  );
  assert.doesNotMatch(
    submitSlice,
    /notifyOutstationDecision\(/,
    "no rejection email may be sent at submit time — the only rejection notice is one a Super Admin chose to send",
  );
  assert.match(
    submitSlice,
    /const workflowStatus = noHoldRole \? "accepted_by_system" : "submitted";/,
    "every submission lands in the pending queue — with exactly one exception, the owner's 2026-08-28 National Sales Manager rule (nsm-no-hold.ts). A second branch appearing here means someone else stopped waiting for a human",
  );
  // Each rule's failure reason must actually reach the approver. A rule that is neither enforced
  // nor surfaced has been deleted, not relaxed — that is the failure mode this rule change could
  // easily become.
  for (const [flag, why] of [
    ["eligibilityFlagReason", "a distance/governorate failure"],
    ["campaignRejectionReason", "a confirmed campaign-rule breach"],
    ["campaignHoldReason", "double-visit evidence that is not in yet"],
    ["gpsAccuracyHoldReason", "a GPS fix outside the policy limit"],
    ["offlineSyncHoldReason", "a late offline sync"],
  ] as const) {
    assert.match(
      submitSlice,
      new RegExp(`detectedHoldReasons = \\[[^\\]]*${flag}`, "s"),
      `${why} must still reach the approver via detectedHoldReasons — relaxed, not deleted`,
    );
  }
  assert.match(
    submitSlice,
    /const reviewHoldReasons = noHoldRole \? \[\] : detectedHoldReasons;/,
    "the flags above are what HOLD a claim for everyone except the one role the owner exempted — a list that stops feeding this line has been deleted, not renamed",
  );
  assert.match(
    submitSlice,
    /eligibilityFlagReason\s*=\s*\n?\s*calculation\.eligibilityStatus === "not_eligible"/,
    "a not_eligible calculation must become a flag, not a rejection",
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
