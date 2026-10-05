import assert from "node:assert/strict";

import { formatPhoenixDateTime } from "../src/lib/i18n/format.ts";
import {
  enforcePhoenixCrmEmailBlock,
  enforcePhoenixCrmPushBlock,
  PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES,
  phoenixCrmChannels,
} from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { buildActivityMirrorDelivery } from "../src/lib/phoenix-crm/server/notifications.ts";

/**
 * Phoenix CRM — every action mirrors to the national sales manager and the SFE Managers in scope
 * (owner, 2026-10-05: "in nsm and sfe i want every single action that happens on Phoenix CRM by their
 * scope to be sent to telegram to them").
 *
 * The mirror is a PARALLEL delivery appended at the one notify choke point, so the module's tuned
 * notices are untouched. What this file pins, without a database:
 *   1. recipients = the NSM in the rep's chain + the SFE Managers, deduped against the native
 *      recipients of the SAME action, so nobody is told twice;
 *   2. never the rep (Golden Rule #1), and never the person who DID the action (an NSM is not told of
 *      his own approval);
 *   3. the day start carries the TIME ONLY — the place is the district manager's and SFE's alone;
 *   4. a vacant chain leaves the SFE Managers, and the first visit (already a native notice to NSM and
 *      SFE) raises no second message;
 *   5. in-app and Telegram only — email and the phone are both shut, like the 06:55 digest.
 */

function seat(overrides: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier" | "path">): OrgSeat {
  return {
    parentSeatId: overrides.path.length > 1 ? overrides.path[overrides.path.length - 2] : null,
    occupantHrId: null,
    lineCode: "pedia",
    lineName: "Pedia",
    areaName: null,
    regionName: null,
    seatLabel: null,
    ...overrides,
  };
}

const CEO = seat({ seatId: "SEAT-CEO", tier: "CEO", path: ["SEAT-CEO"], occupantHrId: "B-2", lineCode: null, lineName: null });
const NSM = seat({ seatId: "SEAT-PED-NSM", tier: "NSM", path: ["SEAT-CEO", "SEAT-PED-NSM"], occupantHrId: "A-12" });
const DM1 = seat({ seatId: "SEAT-PED-DM-D1", tier: "DM", path: [...NSM.path, "SEAT-PED-DM-D1"], occupantHrId: "B-40", regionName: "Delta (1)" });
const REP1 = seat({ seatId: "SEAT-PED-REP-D11", tier: "REP", path: [...DM1.path, "SEAT-PED-REP-D11"], occupantHrId: "B-7", areaName: "Tanta", regionName: "Delta (1)" });
// A line whose whole chain is vacant: the SFE Managers are then the only people the mirror reaches.
const CNS_NSM = seat({ seatId: "SEAT-CNS-NSM", tier: "NSM", path: ["SEAT-CEO", "SEAT-CNS-NSM"], occupantHrId: null, lineCode: "cns", lineName: "CNS" });
const CNS_DM = seat({ seatId: "SEAT-CNS-DM-C1", tier: "DM", path: [...CNS_NSM.path, "SEAT-CNS-DM-C1"], occupantHrId: null, lineCode: "cns", lineName: "CNS" });
const REPC = seat({ seatId: "SEAT-CNS-REP-K11", tier: "REP", path: [...CNS_DM.path, "SEAT-CNS-REP-K11"], occupantHrId: "B-121", lineCode: "cns", lineName: "CNS", areaName: "Heliopolis" });

const org = buildOrgIndex([CEO, NSM, DM1, REP1, CNS_NSM, CNS_DM, REPC]);

const SFE = ["B-150", "B-151"];

const NAMES = new Map([
  ["B-7", "Aya Ibrahim"],
  ["B-40", "Sara Nabil"],
  ["A-12", "Hossam Fouad"],
  ["B-121", "Kareem Adel"],
]);

const CUSTOMER = "احمد زهران"; // every Phoenix CRM customer name is Arabic — the mirror bidi-isolates it
const VISIT_ID = "8f1b2c3d-0000-4000-8000-00000000abcd";
const REQUEST_ID = "1a1a1a1a-0000-4000-8000-000000000001";
const PLAN_ID = "2b2b2b2b-0000-4000-8000-000000000002";
/** 19:42 Cairo (16:42Z) on Saturday 3 October 2026 — the same instant the first-visit test uses. */
const STARTED_AT = "2026-10-03T16:42:11.000Z";

function unplannedRaised(repSeat: OrgSeat, repHrId: string) {
  return {
    kind: "unplanned_visit_raised" as const,
    org,
    seat: repSeat,
    visitId: VISIT_ID,
    repHrId,
    customerName: CUSTOMER,
    visitDate: "2026-10-03",
    clarification: "He was nearby and the doctor was free.",
  };
}

function dayStart(repSeat: OrgSeat, repHrId: string) {
  return {
    kind: "day_start" as const,
    org,
    seat: repSeat,
    repHrId,
    startedAt: STARTED_AT,
    lat: 30.123456,
    lon: 31.234567,
    plannedAmMinute: null,
  };
}

function requestCreated(repSeat: OrgSeat, requesterHrId: string) {
  return {
    kind: "request_created" as const,
    org,
    seat: repSeat,
    requestId: REQUEST_ID,
    requestKind: "grade" as const,
    requesterHrId,
    customerName: CUSTOMER,
    listType: "AM" as const,
    proposedGrade: "A",
    dropReason: null,
  };
}

function requestDecided(repSeat: OrgSeat, requesterHrId: string, deciderHrId: string) {
  return {
    kind: "request_decided" as const,
    seat: repSeat,
    requestId: REQUEST_ID,
    requestKind: "grade" as const,
    status: "approved" as const,
    deciderHrId,
    requesterHrId,
    customerName: CUSTOMER,
    proposedGrade: "A",
    note: null,
  };
}

function planSubmitted(repSeat: OrgSeat, submitterHrId: string) {
  return {
    kind: "plan_submitted" as const,
    org,
    seat: repSeat,
    planId: PLAN_ID,
    version: 1,
    weekStart: "2026-10-03",
    submitterHrId,
  };
}

function firstVisit(repSeat: OrgSeat, repHrId: string) {
  return {
    kind: "first_visit" as const,
    org,
    seat: repSeat,
    visitId: VISIT_ID,
    repHrId,
    customerName: CUSTOMER,
    capturedAt: STARTED_AT,
  };
}

export function runPhoenixCrmActivityMirrorTests() {
  // ── 1 · NSM + SFE, deduped against the native recipient (the district manager) ──────────────────
  {
    const d = buildActivityMirrorDelivery(unplannedRaised(REP1, "B-7"), org, NAMES, SFE, new Set(["B-40"]));
    assert.ok(d, "an off-plan visit reaches the NSM and SFE in scope");
    assert.deepEqual(d.recipients, ["A-12", "B-150", "B-151"], "the national sales manager above him, then the SFE Managers — the district manager is already a native recipient");
    assert.equal(d.eventType, "activity_mirror");
    assert.equal(d.tab, "team");
    assert.equal(d.subjectHrId, "B-7", "the line is about the rep, which names him on the row");
    assert.equal(d.idempotencyKey, `phoenix_crm:activity:unplanned:${VISIT_ID}:raised`);
    assert.match(d.message, /^Aya Ibrahim logged an off-plan visit to ⁨احمد زهران⁩ on Tanta · Pedia \(/, "the rep, the account bidi-isolated, the territory");
    assert.equal((d.message.match(/⁨/g) ?? []).length, 1, "exactly one isolate opens around the Arabic customer name");
    assert.doesNotMatch(d.message, /\bB-7\b/, "names, never HR codes (owner rule)");
  }

  // ── 1b · an SFE Manager who is already a native recipient is not told twice ──────────────────────
  {
    const d = buildActivityMirrorDelivery(unplannedRaised(REP1, "B-7"), org, NAMES, SFE, new Set(["B-40", "B-150"]));
    assert.deepEqual(d?.recipients, ["A-12", "B-151"], "B-150 was already told natively, so only the NSM and the other SFE Manager get the mirror");
  }

  // ── 2 · never the rep, never the actor ──────────────────────────────────────────────────────────
  {
    // The NSM himself approved the request: he is the ACTOR, the one person in scope who already knows.
    const d = buildActivityMirrorDelivery(requestDecided(REP1, "B-7", "A-12"), org, NAMES, SFE, new Set(["B-7"]));
    assert.deepEqual(d?.recipients, ["B-150", "B-151"], "the NSM is not told of his own decision");
    // The district manager decided instead: the NSM is not the actor, so he still hears of it.
    const d2 = buildActivityMirrorDelivery(requestDecided(REP1, "B-7", "B-40"), org, NAMES, SFE, new Set(["B-7"]));
    assert.deepEqual(d2?.recipients, ["A-12", "B-150", "B-151"], "a district manager's decision still reaches the NSM and SFE");
    assert.match(d2!.message, /^Sara Nabil approved Aya Ibrahim's request — grade A for ⁨احمد زهران⁩ on Tanta · Pedia\.$/);
  }

  {
    // A rep who also holds the SFE role is dropped as the subject, never addressed (Golden Rule #1).
    const d = buildActivityMirrorDelivery(dayStart(REP1, "B-7"), org, NAMES, ["B-7", "B-150"], new Set(["B-40"]));
    assert.deepEqual(d?.recipients, ["A-12", "B-150"], "the rep is excluded even when he appears in the SFE list");
  }

  // ── 3 · the day start carries the TIME only, never the location ──────────────────────────────────
  {
    // The district manager and both SFE Managers are native recipients of the day start, so the mirror
    // is the NSM alone — and it must not repeat the place, which the owner scoped to DM and SFE.
    const d = buildActivityMirrorDelivery(dayStart(REP1, "B-7"), org, NAMES, SFE, new Set(["B-40", "B-150", "B-151"]));
    assert.deepEqual(d?.recipients, ["A-12"], "only the NSM is left once the DM and SFE are native");
    assert.equal(formatPhoenixDateTime(STARTED_AT), "7:42 PM, Saturday, 3 October 2026");
    assert.equal(
      d?.message,
      "Aya Ibrahim confirmed they started working at 7:42 PM, Saturday, 3 October 2026 (Cairo), Tanta · Pedia.",
      "the time and the territory, and nothing else",
    );
    assert.doesNotMatch(d!.message, /maps|https?:|30\.|31\./, "the place never travels here — that is the DM's and SFE's alone");
    assert.equal(d?.idempotencyKey, "phoenix_crm:activity:day_start:B-7:2026-10-03");
  }

  // ── 4 · a vacant chain leaves SFE; the first visit raises no second message ──────────────────────
  {
    const d = buildActivityMirrorDelivery(planSubmitted(REPC, "B-121"), org, NAMES, SFE, new Set());
    assert.deepEqual(d?.recipients, ["B-150", "B-151"], "a line with no national manager in a seat still tells SFE");
    assert.match(d!.message, /^Kareem Adel sent the Heliopolis · CNS weekly plan for the week starting /);
    assert.equal(
      buildActivityMirrorDelivery(planSubmitted(REPC, "B-121"), org, NAMES, [], new Set()),
      null,
      "no NSM and no SFE leaves nobody, and the mirror is dropped rather than inventing a recipient",
    );
  }

  {
    assert.equal(buildActivityMirrorDelivery(firstVisit(REP1, "B-7"), org, NAMES, SFE, new Set()), null, "the first visit already notifies the NSM and SFE natively, so it raises no mirror");
  }

  // ── 5 · the recipients are normalised, so casing cannot send a second copy ───────────────────────
  {
    const d = buildActivityMirrorDelivery(requestCreated(REP1, "B-7"), org, NAMES, ["b-150"], new Set(["B-40"]));
    assert.deepEqual(d?.recipients, ["A-12", "B-150"], "a lower-case SFE id resolves to the one upper-case recipient");
    assert.match(d!.message, /^Aya Ibrahim proposed grade A for ⁨احمد زهران⁩ \(AM\) on Tanta · Pedia\.$/);
  }

  // ── 6 · in-app and Telegram only — email and the phone are both shut ─────────────────────────────
  {
    assert.equal(PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES.includes("activity_mirror"), true, "the mirror is on the push-blocked list, like the 06:55 digest");
    assert.deepEqual(phoenixCrmChannels("activity_mirror"), ["in_app", "telegram"], "in-app and Telegram, never the phone or email");
    assert.deepEqual(phoenixCrmChannels("activity_mirror", true), ["in_app"], "a test entry stays in the app");
    assert.deepEqual(enforcePhoenixCrmEmailBlock(["in_app", "email", "telegram"], "phoenix_crm", "activity_mirror"), ["in_app", "telegram"], "the guard strips email even if something asks for it");
    assert.deepEqual(enforcePhoenixCrmPushBlock(["in_app", "telegram", "push"], "phoenix_crm", "activity_mirror"), ["in_app", "telegram"], "and strips the phone");
    const policy = resolveNotificationPolicy({ module: "phoenix_crm", eventType: "activity_mirror" });
    assert.equal(policy.channels.includes("email"), false, "the policy row asks for no email");
    assert.equal(policy.channels.includes("push"), false, "and no phone");
    assert.equal(policy.channels.includes("telegram"), true);
    assert.equal(policy.channels.includes("in_app"), true);
  }
}
