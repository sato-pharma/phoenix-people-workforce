import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { validateLiveArrivalEvidence } from "../src/lib/outstation/car-evidence.ts";
import { outstationTicketEvidenceRejection } from "../src/lib/outstation/decision.ts";
import {
  OUTSTATION_EVIDENCE_WAIVED_ROLES,
  isOutstationEvidenceWaivedRole,
  isOutstationTicketWaivedRole,
} from "../src/lib/outstation/evidence-waiver.ts";
import {
  outstationRequestMayReachPayroll,
  resolveOutstationGateState,
} from "../src/lib/outstation/expense-gate.ts";
import type { OutstationCarEvidenceMetadata } from "../src/lib/outstation/types.ts";

/**
 * Owner request (2026-08-19): Product Manager, Group Product Manager and National Sales Manager
 * submit outstation requests with NO evidence photo — on a car trip there is none at all, and on
 * a train or bus trip the ticket may be attached as a PDF or a photo but is optional.
 *
 * The Training Manager joined them on 2026-10-26 ("MAKE SURE THE OUTSTATION EXPENSES REQUESTS
 * FROM THE TRAINING MANAGER DOESN'T ASK FOR EVIDENCE PHOTO LIKE THE NSM AND GPM"), on the same
 * terms: both photos and the ticket. She had live bus claims, which is why the ticket half of it
 * was put to the owner rather than assumed.
 *
 * The rule is easy to state and has three ways of being wrong, so each gets its own block below:
 *
 *   - waived too widely — every other role losing the photo requirement with it;
 *   - waived too narrowly — the arrival photo dropped while the DEPARTURE photo still blocks,
 *     which parks the request at a checkpoint it can never pass and stops the money entirely;
 *   - waived in the form but not the gate (or the reverse) — the screen and the server
 *     disagreeing, which is the exact dead-end this wizard already had to be repaired for once.
 */

const WAIVED = [
  "Product Manager",
  "Group Product Manager",
  "National Sales Manager",
  "Training Manager",
] as const;
const NOT_WAIVED = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "Marketing Manager",
  "Employee",
] as const;

const validMetadata: OutstationCarEvidenceMetadata = {
  capturedAt: "2026-08-19T09:00:00.000Z",
  capturedLatitude: 30.0444,
  capturedLocationLabel: "Nasr City, Cairo, Egypt",
  capturedLongitude: 31.2357,
  employeeHrId: "A-10",
  requestDraftId: "draft-1",
  requestId: null,
  source: "live_camera",
};

export function runOutstationEvidenceWaiverTests() {
  // ── Exactly four roles, and no more ─────────────────────────────────────────────
  assert.equal(
    OUTSTATION_EVIDENCE_WAIVED_ROLES.size,
    4,
    "the waiver covers the four roles the owner named and nothing else — a fifth arriving silently is how an evidence rule stops meaning anything",
  );
  for (const role of WAIVED) {
    assert.equal(isOutstationEvidenceWaivedRole(role), true, `${role} is waived`);
    assert.equal(isOutstationTicketWaivedRole(role), true, `${role}'s ticket is optional`);
  }
  for (const role of NOT_WAIVED) {
    assert.equal(
      isOutstationEvidenceWaivedRole(role),
      false,
      `${role} still owes both photos — the waiver is a named allowlist, never a seniority test`,
    );
    assert.equal(isOutstationTicketWaivedRole(role), false, `${role} still owes the ticket`);
  }
  assert.equal(isOutstationEvidenceWaivedRole(null), false, "an unknown role is never waived");
  assert.equal(isOutstationEvidenceWaivedRole(""), false, "an empty role is never waived");
  assert.equal(
    isOutstationEvidenceWaivedRole("  product manager  "),
    true,
    "the role arrives from a database column, so casing and stray spacing must not re-arm a removed requirement",
  );

  // ── The submit validator lets a waived role through with no photo ───────────────
  for (const employeeRole of WAIVED) {
    for (const transportationType of ["car", "train", "bus", "other"] as const) {
      assert.equal(
        validateLiveArrivalEvidence({
          carEvidenceMetadata: null,
          employeeRole,
          transportationType,
        }).isValid,
        true,
        `a ${employeeRole} submits a ${transportationType} trip with no arrival photo`,
      );
    }
  }

  // …and every other role is refused exactly as before. This is the assertion that catches a
  // waiver written as "if no photo, accept" with the role check forgotten.
  for (const employeeRole of NOT_WAIVED) {
    assert.equal(
      validateLiveArrivalEvidence({
        carEvidenceMetadata: null,
        employeeRole,
        transportationType: "car",
      }).isValid,
      false,
      `a ${employeeRole} still cannot submit a car trip without the live arrival photo`,
    );
  }

  // ── A photo that IS supplied is still judged, waiver or not ─────────────────────
  // The requirement was removed; the standard was not. A photo with no GPS on it is not lighter
  // evidence, it is evidence an approver cannot read, and letting it through by role would put
  // it in front of them looking like the real thing.
  assert.equal(
    validateLiveArrivalEvidence({
      carEvidenceMetadata: { ...validMetadata, capturedLatitude: Number.NaN },
      employeeRole: "Product Manager",
      transportationType: "car",
    }).isValid,
    false,
    "a waived role that DOES attach a photo still has to attach a complete one",
  );
  assert.equal(
    validateLiveArrivalEvidence({
      carEvidenceMetadata: { ...validMetadata, source: "gallery" } as unknown as OutstationCarEvidenceMetadata,
      employeeRole: "Product Manager",
      transportationType: "car",
    }).isValid,
    false,
    "an unrecognised source is refused for a waived role too — only live_camera and upload exist",
  );
  assert.equal(
    validateLiveArrivalEvidence({
      carEvidenceMetadata: { ...validMetadata, source: "upload" },
      employeeRole: "National Sales Manager",
      transportationType: "car",
    }).isValid,
    true,
    "a waived role may upload rather than capture live on a car trip — the live-camera mandate exists to make a REQUIRED photo hard to fake, and there is no required photo left here",
  );
  assert.equal(
    validateLiveArrivalEvidence({
      carEvidenceMetadata: { ...validMetadata, source: "upload" },
      employeeRole: "District Manager",
      transportationType: "car",
    }).isValid,
    false,
    "…and that relaxation must not leak to anyone else: a car trip that still REQUIRES a photo still requires a live one",
  );

  // ── The train/bus ticket is optional for these roles only ───────────────────────
  for (const role of WAIVED) {
    for (const transportationType of ["train", "bus"] as const) {
      assert.equal(
        outstationTicketEvidenceRejection({
          hasTicketAttachments: false,
          requiresTicketAttachment: true,
          role,
          transportationType,
        }),
        null,
        `a ${role} may submit a ${transportationType} trip with no ticket, even where the policy demands one`,
      );
    }
  }
  assert.equal(
    outstationTicketEvidenceRejection({
      hasTicketAttachments: false,
      requiresTicketAttachment: true,
      role: "District Manager",
      transportationType: "train",
    }),
    "Train or bus expenses require an attached ticket before they can be accepted.",
    "every other role still owes the ticket — this is the rule the waiver carves four names out of, not a rule it deletes",
  );

  // ── The payroll gate waives BOTH photos, not just the submitted one ─────────────
  // The half-waiver is the dangerous one and it is silent: waive the arrival photo alone and the
  // request parks at `pending_arrival_photo`, the departure card never appears for it, and the
  // trip is simply never paid. Nothing errors; the money just stops.
  for (const employeeRole of WAIVED) {
    const gate = resolveOutstationGateState({
      employeeRole,
      evidenceGateStatus: "pending_arrival_photo",
      hasArrivalPhoto: false,
      hasDeparturePhoto: false,
      workloadGateStatus: "complete",
    });
    assert.equal(
      gate.blocker,
      null,
      `a ${employeeRole}'s photo-less request is waiting for nothing — neither photo may block it`,
    );
    assert.equal(
      gate.isPayrollEligible,
      true,
      `…and it must actually reach payroll, or the waiver has only moved where the request gets stuck`,
    );
    assert.match(
      gate.message,
      /not required for this role|never held/i,
      "the reason must say the photo was waived, so a reviewer never reads a photo-less row as one that lost its evidence",
    );
  }

  // A National Sales Manager takes a STRONGER rule than this waiver as of 2026-08-28 — he is
  // never held at all (nsm-no-hold.ts) — so his gate message names that rule rather than the
  // photo waiver. Both readings are accepted above; what must never appear for a waived role is
  // a blocker.

  // The workload gate is untouched FOR EVERY WAIVED ROLE BUT THE NSM. Only the photographs were
  // waived for them, and folding the day's work into the same exemption would release them from
  // a rule the owner did not mention. National Sales Manager is no longer a valid subject for
  // this check — he carries the stronger no-hold rule — so the other three are asserted here.
  for (const employeeRole of ["Group Product Manager", "Product Manager", "Training Manager"]) {
    const waivedNoWorkload = resolveOutstationGateState({
      employeeRole,
      evidenceGateStatus: "pending_arrival_photo",
      hasArrivalPhoto: false,
      hasDeparturePhoto: false,
      workloadGateStatus: "pending_workload",
    });
    assert.equal(
      waivedNoWorkload.blocker,
      "workload",
      `a waived ${employeeRole} still waits for the AM/PM workload — the photos were waived, the trip's work was not`,
    );
    assert.equal(
      waivedNoWorkload.isPayrollEligible,
      false,
      `and a ${employeeRole}'s trip does not pay until that lands`,
    );
  }

  // Everyone else's gate is exactly what it was.
  for (const employeeRole of NOT_WAIVED) {
    assert.equal(
      resolveOutstationGateState({
        employeeRole,
        evidenceGateStatus: "pending_arrival_photo",
        hasArrivalPhoto: false,
        hasDeparturePhoto: false,
        workloadGateStatus: "complete",
      }).blocker,
      "arrival_photo",
      `a ${employeeRole} with no photos is still held on the arrival photo`,
    );
    assert.equal(
      resolveOutstationGateState({
        employeeRole,
        evidenceGateStatus: "pending_departure_photo",
        hasArrivalPhoto: true,
        hasDeparturePhoto: false,
        workloadGateStatus: "complete",
      }).blocker,
      "departure_photo",
      `a ${employeeRole} with one photo is still held on the second`,
    );
  }

  // The shorthand cannot drift from the resolver on the new branch either.
  for (const employeeRole of [...WAIVED, ...NOT_WAIVED]) {
    const scenario = {
      employeeRole,
      evidenceGateStatus: "pending_arrival_photo",
      hasArrivalPhoto: false,
      hasDeparturePhoto: false,
      workloadGateStatus: "complete",
    } as const;
    assert.equal(
      outstationRequestMayReachPayroll(scenario),
      resolveOutstationGateState(scenario).isPayrollEligible,
      "the shorthand must agree with the full resolver — two copies of a payroll gate drift apart",
    );
  }

  // ── The submit path applies the waiver, rather than describing it ───────────────
  // Source inspection, deliberately: submitOutstationRequest needs Supabase and an access
  // context, so the alternative is no coverage at all on the branch that decides whether a
  // photo-less claim is accepted.
  const service = readFileSync(
    new URL("../src/lib/outstation/service.ts", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");

  assert.ok(
    // A Meeting or Other expense (owner, 2026-09-19) is not a trip and owes no arrival photo, so the
    // refusal may ALSO be skipped for it — but never without the waiver clause, which is the point.
    service.includes("if (!nonTravel && !input.carEvidenceImageDataUrl && !evidencePhotoWaived) {") ||
      service.includes("if (!input.carEvidenceImageDataUrl && !evidencePhotoWaived) {"),
    "the submit path's missing-image refusal must be conditional on the waiver, or a waived role passes the validator and is then refused two lines later by a second, unwaived check",
  );
  assert.ok(
    // The Meeting/Other clause (owner, 2026-09-19) only ADDS a reason to skip the upload; the upload
    // must still be conditional on a photo existing.
    service.includes("if (input.carEvidenceImageDataUrl && storedCarEvidenceMetadata) {") ||
      service.includes("if (!nonTravel && input.carEvidenceImageDataUrl && storedCarEvidenceMetadata) {"),
    "and the storage upload must be conditional on a photo EXISTING — an unconditional upload throws on the very submissions this change exists to allow",
  );
  assert.ok(
    service.includes("employeeRole: calculation.employeeRole"),
    "the validator must be told the submitter's role, or the waiver silently never applies on the live path",
  );
  assert.ok(
    service.includes("role: calculation.employeeRole"),
    "and so must the ticket rule, for the same reason",
  );

  // Every gate call site has to pass the role through. One that forgets it does not fail loudly —
  // it holds a waived manager's money on a photo the form never offered him.
  // 9 since 2026-08-19: resendOutstationDeparturePhotoReminder resolves the gate a second time to
  // explain WHY a refused resend was refused. Raise this number only alongside a real new call
  // site — it is a census, and a census that drifts upward on its own stops counting anything.
  // 10 since 2026-11-13: approveOutstationRequestForPayroll resolves the gate on the claim as it stands to
  // decide whether a re-approve of an already-accepted claim changes anything (isUnchangedOutstationReapproval).
  const gateCallSites = service.match(/resolveOutstationGateState\(\{ employeeRole:/g) ?? [];
  assert.equal(
    gateCallSites.length,
    10,
    `every resolveOutstationGateState call in service.ts must pass employeeRole first — found ${gateCallSites.length} of 10`,
  );

  // ── The form and the gate agree ─────────────────────────────────────────────────
  const wizard = readFileSync(
    new URL("../src/components/outstation/mobile-outstation-wizard.tsx", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");

  assert.ok(
    wizard.includes("const isEvidencePhotoWaived = isOutstationEvidenceWaivedRole(employeeRole)"),
    "the wizard must derive the waiver from the SAME predicate the server uses, never from its own list of role names",
  );
  assert.ok(
    // `arrivalPhotoOwed` (owner, 2026-09-19) is "not a Meeting/Other expense AND not waived" — the waiver
    // stays in it (pinned in outstation-arrival-photo-capture-reachable), so the card is still hidden
    // for a waived role, and now for a non-travel expense as well.
    wizard.includes("{isEvidencePhotoWaived ? null : (") || wizard.includes("{!arrivalPhotoOwed ? null : ("),
    "the arrival-photo card must be hidden for a waived role — leaving it on screen as 'optional' is the same requirement asked more quietly",
  );
  assert.ok(
    wizard.includes("const isTicketRequired = isTicketBased && !isOutstationTicketWaivedRole(employeeRole)"),
    "the ticket must be required by transport AND role, so a waived manager is never blocked on an attachment he was told was optional",
  );
  // Since 2026-10-27 the ticket blocks neither Next nor Submit for anyone (the claim is held for
  // review until it is attached from My claims), so the flag now drives only the warning note — and
  // it must still be that flag, never the bare transport check, or a waived manager is warned too.
  assert.ok(
    wizard.includes("{isTicketRequired && ticketFiles.length === 0 ? ("),
    "…and the held-for-review note must read that flag rather than the bare transport check",
  );

  // The ticket card stays on screen for a waived role — with the photo gone it is the trip's only
  // evidence surface, and it must accept exactly what the server accepts.
  const ticketCard = readFileSync(
    new URL("../src/components/outstation/ticket-upload-card.tsx", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");
  assert.ok(
    ticketCard.includes('const TICKET_FILE_ACCEPT = "application/pdf,image/*"'),
    "the picker must offer PDF and photo, matching parseOutstationTicketAttachmentDataUrl — a picker narrower than the server is a control the owner asked for and cannot use",
  );
  assert.ok(
    ticketCard.includes("accept={TICKET_FILE_ACCEPT}"),
    "and the input must actually use it",
  );
  assert.ok(
    ticketCard.includes("required = true"),
    "`required` must default to true, so a caller that has not thought about the waiver keeps the stricter behaviour",
  );
}
