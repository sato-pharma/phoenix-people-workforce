import assert from "node:assert/strict";

import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import { REPLY_WINDOW_MS, replyWindow } from "../src/lib/recruitment/inbound/whatsapp-conversation.ts";

// Answering an applicant from inside Phoenix, in a recruiter's own words.
//
// Two things here fail SILENTLY, which is why they are pinned rather than left to review.
//
//   1. THE 24-HOUR WINDOW. WhatsApp allows free-form text only within 24 hours of the person's
//      last message. Get the boundary wrong by a minute in the permissive direction and the
//      recruiter is shown a send that Meta refused; get it wrong the other way and a reply that
//      was allowed is blocked with a message about a window that has not closed.
//
//   2. THE PERMISSION. The route sits under /api/recruitment/candidates/**, whose catch-all grants
//      on candidates:read — the authority to LOOK at a record. Sending a message to a member of the
//      public in the company's name is not that. If the specific entry is ever removed the route
//      keeps working, the catch-all silently answers for it, and the gate widens to everyone who
//      can open a CV. Nothing goes red; there is just a broader audience able to message applicants.

const HOUR = 60 * 60 * 1000;

export function runWhatsAppManualReplyTests() {
  // --- the window boundary ----------------------------------------------------------------------
  const now = new Date("2026-09-11T12:00:00.000Z");

  const fresh = replyWindow(new Date(now.getTime() - HOUR), now);
  assert.equal(fresh.open, true, "an hour after their message the window is open");
  assert.equal(fresh.minutesLeft, 23 * 60, "23 hours remain, reported in whole minutes");

  const almostGone = replyWindow(new Date(now.getTime() - (REPLY_WINDOW_MS - 60_000)), now);
  assert.equal(almostGone.open, true, "one minute short of 24 hours is still open");
  assert.equal(almostGone.minutesLeft, 1);

  // THE BOUNDARY ITSELF. Exactly 24 hours is CLOSED, matching Meta rather than being generous:
  // being generous here means the recruiter types a reply, presses send, and gets a refusal from
  // Meta phrased in its own terms.
  const exactly = replyWindow(new Date(now.getTime() - REPLY_WINDOW_MS), now);
  assert.equal(exactly.open, false, "exactly 24 hours is closed, not open");
  assert.equal(exactly.minutesLeft, 0);

  const past = replyWindow(new Date(now.getTime() - 30 * HOUR), now);
  assert.equal(past.open, false);
  assert.equal(past.minutesLeft, 0, "a closed window never reports negative time left");

  // A clock that has slipped backwards must not read as a huge remaining window.
  const future = replyWindow(new Date(now.getTime() + HOUR), now);
  assert.equal(future.open, true);
  assert.ok(future.minutesLeft <= 25 * 60, "a future timestamp cannot invent more than a day of window");

  // --- the permission the route actually runs under ---------------------------------------------
  const entry = findAccessRegistryEntry("/api/recruitment/candidates/abc-123/whatsapp-reply", "POST");
  assert.ok(entry, "the reply route must be declared in the access registry");
  assert.deepEqual(
    entry?.permission,
    { resource: "recruitment", action: "update" },
    "messaging an applicant is recruitment:update, NOT the candidates:read the catch-all would give it",
  );
  assert.equal(entry?.csrf?.required, true, "a send is a mutation and must be same-origin");
  assert.equal(
    entry?.audit?.classification,
    "mutation",
    "the send is audited as a mutation, so what left the building is answerable from the audit trail too",
  );

  // The specific entry has to WIN over /api/recruitment/candidates/**, which is only true while it
  // is listed above it. This asserts the resolution, not the file order, so it still holds if the
  // registry is ever reordered by something other than a human reading the lines.
  const readOnlySibling = findAccessRegistryEntry("/api/recruitment/candidates/abc-123/timeline", "GET");
  assert.deepEqual(
    readOnlySibling?.permission,
    { resource: "candidates", action: "read" },
    "an ordinary candidate route still resolves to the catch-all, so the specific entry is not over-reaching",
  );
}
