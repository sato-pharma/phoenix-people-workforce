import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { hrBundleGrants } from "../src/lib/auth/hr-functions.ts";
import { permissionMatrix, phoenixRoles } from "../src/lib/auth/permissions.ts";
import {
  offerReturnRefusal,
  offerSendPath,
  offerSendRefusal,
  offerStatusLabel,
  offerStatusMoveRefusal,
} from "../src/lib/offers/approval-rules.ts";
import { offerExpiryRefusal } from "../src/lib/offers/expiry-notice.ts";
import { joiningFormState } from "../src/lib/offers/joining-form.ts";
import { offerResendRefusal } from "../src/lib/offers/resend-rules.ts";

/**
 * The HR Manager approves every job offer before it reaches a candidate (owner, 2026-11-10):
 *
 *   "When the talent acquisition sends a job offer, it doesn't send automatic. It comes to me, the HR
 *    manager, for my approval. If I approved, the email is pumped. If I reject or leave it pending,
 *    it leaves as it is. … I have the option to edit anything in the offer. But she never automatic
 *    sent. My approval first."
 *
 * Before this, Talent Acquisition's Send emailed the candidate on the spot. These pin the gate, who
 * holds it, and every door an unapproved offer could have slipped out through.
 */
export async function runOfferHrManagerApprovalTests() {
  // ── 1. Who approves: the Super Admin (the HR Manager) and nobody else ────────────────────────
  const approvers = phoenixRoles.filter((role) => permissionMatrix[role]?.offers?.includes("approve"));
  assert.deepEqual(approvers, ["Super Admin"], "only the HR Manager's seat may approve, and so send, an offer");
  assert.ok(permissionMatrix["HR Resourcing"].offers?.includes("create"), "Talent Acquisition still builds and presses Send");
  assert.ok(!hrBundleGrants("HR Resourcing").offers?.includes("approve"), "Talent Acquisition's bundle never carries approve");

  // ── 2. Send: email for the approver, a request for everybody else ────────────────────────────
  assert.equal(offerSendPath(true), "send");
  assert.equal(offerSendPath(false), "request_approval", "Talent Acquisition's Send never emails");
  assert.equal(offerSendRefusal("draft", false), null, "a draft may be sent for approval");
  assert.equal(offerSendRefusal("draft", true), null, "the HR Manager may send his own draft");
  assert.equal(offerSendRefusal("pending_approval", true), null, "his Approve and send on a waiting offer");
  assert.match(offerSendRefusal("pending_approval", false) ?? "", /already waiting/, "a second request is refused, not re-sent");
  for (const status of ["sent", "accepted", "declined", "withdrawn"] as const) {
    assert.ok(offerSendRefusal(status, true), `a ${status} offer is never sent again through Send`);
  }

  // ── 3. Reject: his alone, and only on a waiting offer ────────────────────────────────────────
  assert.equal(offerReturnRefusal("pending_approval", true), null);
  assert.ok(offerReturnRefusal("pending_approval", false), "Talent Acquisition cannot clear its own request");
  assert.ok(offerReturnRefusal("sent", true), "a sent offer is never pulled back to draft by Reject");
  assert.ok(offerReturnRefusal("draft", true));

  // ── 4. No hand-set status skips him ──────────────────────────────────────────────────────────
  assert.ok(offerStatusMoveRefusal("draft", "pending_approval"), "approval is reached through Send only");
  assert.ok(offerStatusMoveRefusal("draft", "sent"), "marking an unsent draft 'sent' would record a send that never happened");
  assert.ok(offerStatusMoveRefusal("pending_approval", "sent"), "and would skip his approval");
  assert.ok(offerStatusMoveRefusal("pending_approval", "accepted"), "the candidate cannot accept what never reached him");
  assert.ok(offerStatusMoveRefusal("pending_approval", "declined"));
  assert.equal(offerStatusMoveRefusal("pending_approval", "withdrawn"), null, "a waiting offer may still be withdrawn");
  assert.equal(offerStatusMoveRefusal("sent", "accepted"), null, "recording an answer on a sent offer is unchanged");
  assert.equal(offerStatusLabel("pending_approval"), "Awaiting approval", "never the raw key on screen");

  // ── 5. A waiting offer has not been sent, wherever that is asked ─────────────────────────────
  const snapshot = { blocks: [], fontFamily: "Inter", fontSizePt: 11, theme: {}, variant: "classic" } as never;
  assert.ok(offerResendRefusal({ candidateEmail: "c@example.com", status: "pending_approval", templateSnapshot: snapshot }));
  assert.ok(offerExpiryRefusal({ candidateEmail: "c@example.com", status: "pending_approval" }));
  assert.equal(
    joiningFormState({ employeeHrId: null, requiresSeat: false, seatOpen: true, status: "pending_approval" }),
    "not_sent",
    "the joining form stays shut until the letter actually went",
  );

  // ── 6. The one mail-sending function refuses without the approver's word ─────────────────────
  const send = stripComments(readFileSync("src/lib/offers/send.ts", "utf8"));
  const sendFn = send.slice(send.indexOf("export async function sendOfferEmail("), send.indexOf("export async function resendOfferEmail("));
  assert.match(sendFn, /approvedByHrManager: true;/, "the flag is a required literal type, never optional");
  assert.ok(
    sendFn.indexOf("options?.approvedByHrManager !== true") > -1 &&
      sendFn.indexOf("options?.approvedByHrManager !== true") < sendFn.indexOf("await getOffer(offerId)"),
    "refused before anything is read or sent",
  );

  // ── 7. The Send route asks the permission BEFORE the mail can leave ──────────────────────────
  const route = stripComments(readFileSync("app/api/offers/[id]/send/route.ts", "utf8"));
  const askAt = route.indexOf("await canApproveOffers(access)");
  const parkAt = route.indexOf("markOfferPendingApproval(");
  const mailAt = route.indexOf("sendOfferEmail(id, { approvedByHrManager: true");
  assert.ok(askAt > -1 && parkAt > askAt && mailAt > parkAt, "ask, then park for him, and only past that the email");
  assert.match(route, /offerSendPath\(canApprove\) === "request_approval"[\s\S]{0,1600}return NextResponse\.json\(\{ offer: pending, pendingApproval: true/,
    "a request returns before the send");
  assert.equal((route.match(/sendOfferEmail\(/g) ?? []).length, 1, "one send call, the approver's");
  assert.match(route, /afterResponse\("offers\.approvalRequested"/, "he is told after the reply, never before it");

  // ── 8. Reject's route, and its registration ──────────────────────────────────────────────────
  const reject = stripComments(readFileSync("app/api/offers/[id]/reject/route.ts", "utf8"));
  assert.match(reject, /assertSameOriginMutation\(request\)/);
  assert.match(reject, /assertPermission\(access, "offers", "approve"\)/, "Reject is the HR Manager's permission");
  assert.match(reject, /returnOfferToDraft\(/);
  assert.ok(!reject.includes("sendOfferEmail") && !reject.includes("sendPhoenixEmail"), "a rejection emails nobody");
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(registry, /pattern: "\/api\/offers\/:id\/reject", permission: \{ resource: "offers", action: "approve" \}/);

  // ── 9. The data layer: conditional writes, and only he edits a waiting offer ─────────────────
  const service = stripComments(readFileSync("src/lib/offers/service.ts", "utf8"));
  const park = service.slice(service.indexOf("export async function markOfferPendingApproval("), service.indexOf("export async function returnOfferToDraft("));
  assert.match(park, /status: "pending_approval"/);
  assert.match(park, /\.eq\("status", "draft"\)/, "only a draft is parked — a double press cannot re-stamp it");
  const back = service.slice(service.indexOf("export async function returnOfferToDraft("), service.indexOf("export async function markOfferSent("));
  assert.match(back, /status: "draft"/);
  assert.match(back, /\.eq\("status", "pending_approval"\)/, "Reject can never pull back a sent offer");
  const update = service.slice(service.indexOf("export async function updateOffer("), service.indexOf("export function offerEditRefusal("));
  assert.match(update, /current\.status === "pending_approval" && options\.canApprove === true/, "a waiting offer is his to edit, nobody else's");
  const patch = stripComments(readFileSync("app/api/offers/[id]/route.ts", "utf8"));
  assert.match(patch, /updateOffer\(id, patch, \{ canApprove \}\)/);
  assert.match(patch, /offerStatusMoveRefusal\(/, "the status PATCH consults the move rule");

  // ── 10. The notices never email ──────────────────────────────────────────────────────────────
  const notices = stripComments(readFileSync("src/lib/offers/approval.ts", "utf8"));
  assert.match(notices, /OFFER_APPROVAL_CHANNELS: readonly SystemNotificationChannel\[\] = \["in_app", "push", "telegram"\]/);
  assert.ok(!/"email"/.test(notices), "no approval notice goes by email");
  assert.match(notices, /resolveHrIdsForRole\(OFFER_APPROVER_ROLE/);
  assert.match(notices, /OFFER_APPROVER_ROLE = "Super Admin"/);

  // ── 11. The database admits the state ────────────────────────────────────────────────────────
  const migration = readFileSync("supabase/migrations/20261110190002_offer_hr_manager_approval.sql", "utf8");
  assert.match(migration, /check \(status in \('draft', 'pending_approval', 'sent', 'accepted', 'declined', 'withdrawn'\)\)/);
  assert.match(migration, /check \(status in \('draft', 'pending_approval'\) or sent_at is not null\)/);

  // ── 12. The screen says where Send goes ──────────────────────────────────────────────────────
  const composer = readFileSync("src/components/offers/offer-composer.tsx", "utf8");
  // An updated offer (2026-11-10) adds its own label for the HR Manager; Talent Acquisition's Send still only asks approval.
  assert.match(composer, /!canApprove \? "Send for approval" : reviewing \? "Approve and send" : updating \? "Send updated offer" : "Send offer"/);
  assert.match(composer, /payload\.pendingApproval/, "a request is never reported as sent");
  for (const page of ["app/(admin)/offers/page.tsx", "app/employee-portals/offers/page.tsx"]) {
    assert.match(readFileSync(page, "utf8"), /canAccess\(access, "offers", "approve"\)/, `${page} reads the approve grant`);
  }
}
