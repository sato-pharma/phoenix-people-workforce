import assert from "node:assert/strict";
import { join } from "node:path";

import {
  approvalReasonAfterMissingTicketAttached,
  canAttachMissingOutstationTicket,
  eligibilityAfterMissingTicketAttached,
  missingTicketAttachedSentence,
  OUTSTATION_ELIGIBLE_LOCATION_REASON,
  OUTSTATION_NO_TICKET_HOLD_REASON,
  OUTSTATION_OFFLINE_TICKET_HOLD_REASON,
  OUTSTATION_TICKET_EVIDENCE_REQUIRED_REASON,
} from "../src/lib/outstation/missing-ticket.ts";
import { JOURNEY_CHECK_MARKER } from "../src/lib/outstation/decision-note.ts";
import { stripComments } from "./support/comment-strip.ts";
import { cachedReadFile } from "./support/source-corpus.ts";

// A train or bus claim that arrived WITHOUT its ticket can have it attached afterwards, and a phone
// that only REPORTS no signal no longer drops the ticket it carried (owner, 2026-10-22: "fix the
// offline ticket gap in outstation").
//
// THE HOLE. Osama Mohamed El-said's 20 Oct train to Assiut arrived through the offline route with 0
// attachments and was held as "could not carry its ticket attachment". Two faults: the wizard stripped
// the ticket from any submit made while the phone said "offline", even when the request then reached
// the server; and once held, he had no control that could supply the ticket — "Add tickets" adds a
// paid leg, never proof for the one he claimed.

const ROOT = process.cwd();
const SERVICE = "src/lib/outstation/service.ts";
const ROUTE = "app/api/outstation/[id]/ticket/route.ts";
const SYNC_ROUTE = "app/api/outstation/sync-offline/route.ts";
const WIZARD = "src/components/outstation/mobile-outstation-wizard.tsx";

function code(relative: string): string {
  return stripComments(cachedReadFile(join(ROOT, relative)));
}

function functionSlice(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must exist - this test is pinned to it by name`);
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n(?:export )?async function /);
  return rest.slice(0, next === -1 ? rest.length : next);
}

function submit0(): string {
  const wizard = code(WIZARD);
  return wizard.slice(wizard.indexOf("async function submit()"), wizard.indexOf("async function submit()") + 4000);
}

export function runOutstationMissingTicketTests() {
  // -- who may attach ------------------------------------------------------------------------------
  assert.equal(
    canAttachMissingOutstationTicket({ status: "submitted", ticketAttachmentCount: 0, transportationType: "train" }),
    true,
    "HEADLINE: Osama's ticketless, undecided train claim takes its ticket",
  );
  assert.equal(canAttachMissingOutstationTicket({ status: "needs_review", ticketAttachmentCount: 0, transportationType: "bus" }), true);
  assert.equal(
    canAttachMissingOutstationTicket({ status: "submitted", ticketAttachmentCount: 1, transportationType: "train" }),
    false,
    "a claim that already carries a ticket is not a gap — a new leg goes through Add tickets",
  );
  assert.equal(
    canAttachMissingOutstationTicket({ status: "submitted", ticketAttachmentCount: 0, transportationType: "car" }),
    false,
    "a car trip's evidence is its photos",
  );
  for (const decided of ["accepted_by_admin", "accepted_by_system", "rejected_by_admin"]) {
    assert.equal(
      canAttachMissingOutstationTicket({ status: decided, ticketAttachmentCount: 0, transportationType: "train" }),
      false,
      `nothing is added once HR decided (${decided}) — the 2026-10-19 rule`,
    );
  }

  // -- only the ticket gap is closed ---------------------------------------------------------------
  assert.deepEqual(
    eligibilityAfterMissingTicketAttached({
      eligibilityReason: OUTSTATION_TICKET_EVIDENCE_REQUIRED_REASON,
      eligibilityStatus: "needs_review",
    }),
    { eligibilityReason: OUTSTATION_ELIGIBLE_LOCATION_REASON, eligibilityStatus: "eligible" },
    "the calculation's ticket downgrade is undone",
  );
  const otherHold = { eligibilityReason: "The destination is under the minimum distance.", eligibilityStatus: "needs_review" };
  assert.deepEqual(
    eligibilityAfterMissingTicketAttached(otherHold),
    otherHold,
    "a claim held for anything else keeps exactly what it had",
  );

  const sentence = missingTicketAttachedSentence("21:10, 22 October 2026", 1);
  assert.match(sentence, /attached the ticket on 21:10, 22 October 2026 \(1 file\)/);
  assert.match(missingTicketAttachedSentence("x", 2), /\(2 files\)/);

  const held = `${OUTSTATION_OFFLINE_TICKET_HOLD_REASON} ${JOURNEY_CHECK_MARKER} route reviewed.`;
  const after = approvalReasonAfterMissingTicketAttached(held, sentence);
  assert.ok(!after.includes(OUTSTATION_OFFLINE_TICKET_HOLD_REASON), "HEADLINE: the hold sentence, no longer true, is replaced");
  assert.ok(after.startsWith(sentence), "by the attached sentence, in its place");
  assert.ok(after.endsWith(`${JOURNEY_CHECK_MARKER} route reviewed.`), "the Journey check group stays the tail");
  // The ONLINE hold (owner, 2026-10-27) clears the same way once the ticket is attached.
  const heldOnline = `${OUTSTATION_NO_TICKET_HOLD_REASON} ${JOURNEY_CHECK_MARKER} route reviewed.`;
  const afterOnline = approvalReasonAfterMissingTicketAttached(heldOnline, sentence);
  assert.ok(!afterOnline.includes(OUTSTATION_NO_TICKET_HOLD_REASON), "the online hold sentence is replaced too");
  assert.ok(afterOnline.startsWith(sentence));
  const plain = approvalReasonAfterMissingTicketAttached(`GPS was weak. ${JOURNEY_CHECK_MARKER} ok.`, sentence);
  assert.equal(plain, `GPS was weak. ${sentence} ${JOURNEY_CHECK_MARKER} ok.`, "with no hold sentence it is added ahead of the Journey check");
  assert.equal(approvalReasonAfterMissingTicketAttached(null, sentence), sentence);

  // -- the service, the route and the offline path, on source ----------------------------------------
  const service = code(SERVICE);
  const attach = functionSlice(service, "export async function attachMissingTicketsToOwnOutstationRequest(");
  const refusals = attach.indexOf("canAttachMissingOutstationTicket(");
  assert.ok(refusals !== -1 && refusals < attach.indexOf("uploadOutstationTicketAttachments("), "every refusal comes before any file is uploaded");
  assert.match(attach, /\.in\("status", \[\.\.\.OUTSTATION_UNDECIDED_STATUSES\]\)/, "the write is pinned to an undecided claim");
  assert.match(attach, /\.eq\("attachment_count", existing\.attachmentCount\)/, "and to the claim still having no ticket");
  assert.doesNotMatch(attach, /updated_at|claimed_total_amount|expected_total_amount|ticket_amount/, "evidence only: no money and no approval revision move");
  assert.match(attach, /deleteOutstationTicketAttachments\(/, "a failed write deletes the uploaded files");
  assert.match(attach, /source: "employee_missing_ticket"/, "and every attach leaves an audit row");

  // A train or bus claim sent ONLINE with no ticket is HELD, never refused (owner, 2026-10-27: a
  // District Sales Manager's train claim could not get past the evidence step). The throw is gone and
  // the online hold sentence is chosen when the submit was not captured offline.
  assert.doesNotMatch(service, /A ticket attachment is required for train and bus expense requests/, "HEADLINE: an online ticketless claim is no longer refused");
  assert.match(
    service,
    /calculation\.offlineCaptured\s*\?\s*OUTSTATION_OFFLINE_TICKET_HOLD_REASON\s*:\s*OUTSTATION_NO_TICKET_HOLD_REASON/,
    "the online submit is held with its own sentence",
  );
  assert.doesNotMatch(submit0(), /attach the ticket — a train or bus claim needs it/, "and the form no longer refuses Submit without it");

  const route = code(ROUTE);
  assert.match(route, /assertSameOriginMutation\(request\)/);
  assert.match(route, /assertPermission\(access, "outstation", "create"\)/);
  assert.match(route, /attachMissingTicketsToOwnOutstationRequest\(id, access, \{ tickets \}\)/);
  assert.doesNotMatch(route, /amount/i, "the route takes no amount — a ticket that adds money is /extra-ticket");

  const sync = code(SYNC_ROUTE);
  assert.match(sync, /syncOfflineOutstationRequest\([\s\S]*\{ ticketAttachments \}\)/, "the offline route passes the ticket it was sent");
  assert.match(functionSlice(service, "export async function syncOfflineOutstationRequest("), /\{ \.\.\.options, dropRefusedTrainTickets: true \}/, "and the service passes it on (a refused train ticket is dropped there, never the claim)");

  const submit = submit0();
  assert.doesNotMatch(
    submit,
    /if \(!isOffline && \(isTicketBased \|\| isNonTravel\) && ticketFiles\.length > 0\)/,
    "HEADLINE: the wizard no longer strips the ticket from a submit made while the phone says offline",
  );
  assert.match(submit, /ticketFiles\.map\(prepareTicketAttachment\)/);
}
