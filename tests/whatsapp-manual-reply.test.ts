import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import { REPLY_WINDOW_MS, replyWindow } from "../src/lib/recruitment/inbound/whatsapp-conversation.ts";

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

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
//
//   3. WHICH SCREEN IT IS ON. Added 2026-09-12. The box was built for the candidate drawer in the
//      pool and never reached the SCREENING WORKSTATION, which is the screen a recruiter actually
//      works in — so answering somebody who had just written in meant leaving the CV, finding them
//      in the pool and opening a drawer, and in practice it did not happen. Nothing was broken and
//      nothing went red; the capability simply was not where the work is. It is on both screens now,
//      and this pins that, because a rebuild of either surface would drop it again in silence.

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

  // --- and it is reachable from BOTH screens ----------------------------------------------------
  // Source pins rather than a render: these are client components sitting on a service-role data
  // path, and the thing that regresses is not behaviour, it is somebody rebuilding a header and not
  // carrying a child across. A missing import is exactly what that looks like.
  const workstationHeader = read("src/components/recruitment/workstation/workstation-review-header.tsx");
  assert.match(
    workstationHeader,
    /import \{ WhatsAppReplyBox \} from "@\/components\/recruitment\/whatsapp-reply-box"/,
    "the screening workstation must be able to answer an applicant, not only send a template",
  );
  assert.match(
    workstationHeader,
    /\{canReply \? \(\s+<div className="mt-2">\s+<WhatsAppReplyBox candidateId=\{row\.id\} \/>/,
    "and it is gated on the same recruitment:update the route enforces, so nobody is offered a refusal",
  );

  // AND AT FULL SCREEN. The focus strip collapses the identity band and the decision band into one
  // row, so the copy pinned above — which lives in the identity band — is not rendered there at all.
  // Reading a CV full screen and answering the person who sent it is one errand, and until
  // 2026-09-12 it cost leaving full screen and coming back. The owner asked for it there by name.
  assert.match(
    workstationHeader,
    /\{canReply && focus \? <WhatsAppReplyBox candidateId=\{row\.id\} \/> : null\}/,
    "full-screen reading must be able to answer the applicant without leaving full screen",
  );
  // The `&& focus` half is load-bearing in the other direction: `decisions` is also what the
  // ordinary layout's action bar renders, and without the guard the box would draw twice on one
  // screen — two mounts, two window checks, two boxes disagreeing about how long is left.
  assert.doesNotMatch(
    workstationHeader,
    /\{canReply \? <WhatsAppReplyBox/,
    "and never unguarded, or the ordinary layout gets a second copy of it",
  );
  assert.match(
    read("src/components/recruitment/workstation/screening-workstation.tsx"),
    /canReply=\{canReply\}/,
    "canReply IS recruitment:update on this page — see the two screening route files that set it. It rode on canDecide until 2026-09-18, when deciding moved to candidates:update",
  );

  const poolDrawer = read("src/components/recruitment/recruitment-workspace.tsx");
  assert.match(
    poolDrawer,
    /<WhatsAppReplyBox candidateId=\{profile\.candidate\.id\} \/>/,
    "the pool drawer keeps it too — one capability, two screens, never one of them quietly losing it",
  );

  // The box lands inside a header painted entirely in --phx-* tokens. Tailwind's own ramps read as a
  // pasted-in widget there, and `slate` carries a blue cast against a warm paper ground.
  const box = read("src/components/recruitment/whatsapp-reply-box.tsx");
  assert.doesNotMatch(
    box,
    /(?:bg|text|border|ring)-(?:slate|gray|zinc|orange|red)-\d{2,3}/,
    "the reply box is painted in the Phoenix palette, not Tailwind's",
  );
}
