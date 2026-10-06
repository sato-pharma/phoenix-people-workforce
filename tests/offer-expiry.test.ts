import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  offerExpiryIdempotencyKey,
  offerExpiryRefusal,
  offerExpirySubject,
  renderOfferExpiryNotice,
} from "../src/lib/offers/expiry-notice.ts";

/**
 * Expire offer (owner, 2026-10-07).
 *
 * Beside Resend, a button that tells the candidate the offer has lapsed and withdraws it — the
 * candidate-facing half Withdraw never had. These pin what it may do and, as much, what it must not:
 * a SENT offer only, the same address the letter went to, a stable key, the notice before the
 * status write, and the offer letter itself NEVER re-sent in its place.
 */
export async function runOfferExpiryTests() {
  const sent = { candidateEmail: "candidate@example.com", status: "sent" as const };

  // ── 1. Only a SENT offer, with an address ───────────────────────────────────────────────────
  assert.equal(offerExpiryRefusal(sent), null, "a sent offer with an address can be expired");
  assert.match(offerExpiryRefusal({ ...sent, status: "draft" }) ?? "", /nothing to expire/, "a draft was never sent");
  assert.ok(offerExpiryRefusal({ ...sent, status: "accepted" }), "an answered offer is not expired");
  assert.ok(offerExpiryRefusal({ ...sent, status: "declined" }), "an answered offer is not expired");
  assert.ok(offerExpiryRefusal({ ...sent, status: "withdrawn" }), "an already-withdrawn offer is not expired again");
  assert.ok(offerExpiryRefusal({ ...sent, candidateEmail: "  " }), "no address, no notice");

  // ── 2. The key is stable and offer-specific ─────────────────────────────────────────────────
  assert.equal(offerExpiryIdempotencyKey("OFFER-1"), "offer-expiry:OFFER-1", "stable per offer, so a double-submit sends once");
  assert.notEqual(offerExpiryIdempotencyKey("OFFER-1"), offerExpiryIdempotencyKey("OFFER-2"), "one key per offer");
  // Never the first send's key, and never a resend key — those would dedupe against a DIFFERENT message.
  assert.notEqual(offerExpiryIdempotencyKey("OFFER-1"), "offer-letter:OFFER-1");

  // ── 3. The notice: says expired, speaks as Sato not Phoenix, has a text part, square-edge ─────
  const notice = renderOfferExpiryNotice({
    candidateName: "Samaa Shalaby",
    reference: "SP-HR-DSM-2026-019",
    salutationName: "Dr Samaa",
    territory: "Delta 3",
    title: "District Sales Manager",
  });
  assert.match(notice.html, /has expired/, "the heading tells the candidate plainly");
  assert.match(notice.html, /District Sales Manager/, "names the role so they know which offer");
  assert.ok(notice.html.includes("Sato Pharmaceuticals"), "the notice speaks as the company");
  assert.ok(!/Phoenix/i.test(notice.html), "an offer notice branded as the internal HR tool reads as phishing — never Phoenix");
  assert.ok(!notice.html.includes("border-radius"), "the square-edge golden rule — no rounded corners");
  assert.ok(notice.text.length > 0 && !/<[a-z]/i.test(notice.text), "a plain-text alternative, so the notice does not score as spam");
  assert.match(notice.text, /expired/i, "the text part says it too");
  // The subject names the role and is NOT the blunt word alone.
  assert.match(offerExpirySubject({ title: "District Sales Manager" }), /District Sales Manager/);
  assert.equal(offerExpirySubject({ title: "  " }), "Update on your offer of employment", "no role, no dangling dash");

  // ── 4. The server sends the notice, then withdraws — and NEVER the offer letter ───────────────
  const sendSource = readFileSync("src/lib/offers/send.ts", "utf8");
  const expireFn = sendSource.slice(sendSource.indexOf("export async function expireOfferEmail"));
  assert.ok(expireFn.length > 0, "expireOfferEmail must exist");
  assert.ok(expireFn.includes("offerExpiryRefusal(offer)"), "refused unless the offer can be expired");
  assert.ok(expireFn.includes("renderOfferExpiryNotice("), "sends the short notice");
  assert.ok(expireFn.includes("offerExpiryIdempotencyKey(offer.id)"), "under its own stable key");
  assert.ok(expireFn.includes('"offer_expired"'), "its own notification type, not the offer letter's");
  assert.ok(expireFn.includes("externalRecipients: [offer.candidateEmail]"), "the candidate is declared past the Recipient Assurance Guard");
  assert.ok(
    expireFn.includes('skipped ? offer : await setOfferStatus(offer.id, "withdrawn")'),
    "the offer is withdrawn ONLY when the notice actually left — a suppressed send changes nothing",
  );
  assert.ok(!expireFn.includes("renderOfferEmail("), "an expiry notice is never the offer letter");
  assert.ok(!expireFn.includes("renderOfferPdf(") && !expireFn.includes("markOfferSent("), "no PDF, no re-stamp of sent_at");

  // ── 5. The route carries Send's gate and audits the act ──────────────────────────────────────
  const route = readFileSync("app/api/offers/[id]/expire/route.ts", "utf8");
  assert.ok(route.includes("assertSameOriginMutation(request)"), "same-origin guard");
  assert.ok(route.includes('assertPermission(access, "offers", "create")'), "the same permission as Send");
  assert.ok(route.includes('scope: "offers:send"'), "Send's rate-limit bucket, so send/resend/expire cannot flood a candidate together");
  assert.ok(route.includes("writeRequiredAuditLog("), "the expiry is audited");
  assert.ok(route.includes("expireOfferEmail(id)"), "the route calls the server function");
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(
    registry,
    /audit: \{ classification: "mutation", required: true \}, methods: \["POST"\], pattern: "\/api\/offers\/:id\/expire", permission: \{ resource: "offers", action: "create" \}, csrfRequired: true/,
    "the access registry must declare the expire route exactly like Send and Resend",
  );

  // ── 6. The button: beside Withdraw, on BOTH surfaces, confirmed, only on a sent offer ─────────
  const composer = readFileSync("src/components/offers/offer-composer.tsx", "utf8");
  assert.ok(composer.includes("call(`/api/offers/${offer.id}/expire`, \"POST\", {})"), "the button posts to the expire route");
  assert.ok(/async function expireOffer[\s\S]{0,1600}window\.confirm\(/.test(composer), "confirmed before a notice goes out and the offer is retired");
  const buttons = composer.split("onClick={() => void expireOffer(offer)}").length - 1;
  assert.equal(buttons, 2, "the desktop row AND the phone card — a phone is how these are read");
  // Each Expire sits inside the same `canManage && offer.status === "sent"` block as Withdraw.
  for (const at of [composer.indexOf("void expireOffer(offer)"), composer.lastIndexOf("void expireOffer(offer)")]) {
    const gate = composer.lastIndexOf('canManage && offer.status === "sent"', at);
    const blockEnd = composer.indexOf(") : null}", gate);
    assert.ok(gate > -1 && at < blockEnd, "Expire is offered only to a manager, only on a sent offer");
  }
}
