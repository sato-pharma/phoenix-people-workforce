import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseLetterDate, toLetterDate } from "../src/lib/offers/dates.ts";
import { normalizeResendRequestId, offerResendIdempotencyKey, offerResendRefusal } from "../src/lib/offers/resend-rules.ts";

/**
 * Resend offer (owner, 2026-09-28).
 *
 * The night Resend accepted Norhan Gamal's offer and then failed it, the row read "sent" and the
 * module had no way to put the SAME letter in front of her again short of withdrawing it and
 * composing a new one under a new reference. He asked for a Resend button beside Accepted, Declined
 * and PDF. These pin what it may do and, as much, what it must not.
 */
export async function runOfferResendTests() {
  const snapshot = { blocks: [], fontFamily: "Inter", fontSizePt: 11, theme: {}, variant: "classic" } as never;
  const sent = { candidateEmail: "candidate@example.com", status: "sent" as const, templateSnapshot: snapshot };

  // ── 1. Only a SENT offer, with an address and its frozen letter ─────────────────────────────
  assert.equal(offerResendRefusal(sent), null, "a sent offer with its snapshot can be resent");
  assert.match(offerResendRefusal({ ...sent, status: "draft" }) ?? "", /Use Send/, "a draft has never gone out — that is Send");
  assert.ok(offerResendRefusal({ ...sent, status: "accepted" }), "an answered offer is not resent");
  assert.ok(offerResendRefusal({ ...sent, status: "declined" }), "an answered offer is not resent");
  assert.ok(offerResendRefusal({ ...sent, status: "withdrawn" }), "a withdrawn offer would re-issue terms nobody stands behind");
  assert.ok(offerResendRefusal({ ...sent, candidateEmail: "  " }), "no address, no resend");
  assert.match(
    offerResendRefusal({ ...sent, templateSnapshot: null }) ?? "",
    /cannot be resent unchanged/,
    "without the snapshot the only letter left is TODAY's template — never resend a different letter",
  );

  // ── 2. The key is NEVER the first send's key ────────────────────────────────────────────────
  // Resend dedupes a repeated key for 24 hours by returning the ORIGINAL message, so the first
  // send's key would answer with the very message that failed and deliver nothing.
  const firstSendKey = "offer-letter:OFFER-1"; // offerIdempotencyKey in src/lib/offers/send.ts
  const sendSource = readFileSync("src/lib/offers/send.ts", "utf8");
  assert.ok(sendSource.includes("return `offer-letter:${offerId}`;"), "the first-send key format this test compares against");
  const resendKey = offerResendIdempotencyKey("OFFER-1", "press-0001");
  assert.notEqual(resendKey, firstSendKey);
  assert.ok(resendKey.startsWith(`${firstSendKey}:resend:`), "a resend key is traceable to its offer");
  assert.notEqual(resendKey, offerResendIdempotencyKey("OFFER-1", "press-0002"), "each press is its own send");

  assert.equal(normalizeResendRequestId("3f1c2b8a-5d6e-4f70-8a9b-0c1d2e3f4a5b"), "3f1c2b8a-5d6e-4f70-8a9b-0c1d2e3f4a5b");
  assert.equal(normalizeResendRequestId("../../etc"), null, "only letters, digits and dashes reach a key");
  assert.equal(normalizeResendRequestId("short"), null);
  assert.equal(normalizeResendRequestId(42), null);

  // ── 3. The server resends the FROZEN letter and changes nothing on the row ──────────────────
  const resendFn = sendSource.slice(sendSource.indexOf("export async function resendOfferEmail"), sendSource.indexOf("async function deliverOfferLetter"));
  assert.ok(resendFn.length > 0, "resendOfferEmail must exist ahead of the shared delivery helper");
  assert.ok(resendFn.includes("offer.templateSnapshot"), "a resend renders the snapshot frozen at the first send");
  assert.ok(resendFn.includes("offerResendIdempotencyKey("), "a resend goes out under its own key");
  assert.ok(!resendFn.includes("markOfferSent"), "a resend must not move sent_at, the status or the snapshot");
  assert.ok(!resendFn.includes("getOfferTemplate") && !resendFn.includes("defaultOfferTemplate"), "never today's template");

  // ── 4. The route carries Send's gate and audits every copy ──────────────────────────────────
  const route = readFileSync("app/api/offers/[id]/resend/route.ts", "utf8");
  assert.ok(route.includes("assertSameOriginMutation(request)"), "same-origin guard");
  assert.ok(route.includes('assertPermission(access, "offers", "create")'), "the same permission as Send");
  assert.ok(route.includes('scope: "offers:send"'), "Send's rate-limit bucket, so the two cannot flood a candidate together");
  assert.ok(route.includes("writeRequiredAuditLog("), "every resent copy is audited");
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(
    registry,
    /audit: \{ classification: "mutation", required: true \}, methods: \["POST"\], pattern: "\/api\/offers\/:id\/resend", permission: \{ resource: "offers", action: "create" \}, csrfRequired: true/,
    "the access registry must declare the resend route exactly like Send",
  );

  // ── 5. The button: beside Accepted / Declined, on BOTH surfaces, confirmed, one id per press ─
  const composer = readFileSync("src/components/offers/offer-composer.tsx", "utf8");
  assert.ok(composer.includes("call(`/api/offers/${offer.id}/resend`, \"POST\", { requestId: crypto.randomUUID() })"));
  assert.ok(/async function resendOffer[\s\S]{0,1200}window\.confirm\(/.test(composer), "confirmed before a letter goes to a stranger");
  const buttons = composer.split("onClick={() => void resendOffer(offer)}").length - 1;
  assert.equal(buttons, 2, "the desktop row AND the phone card — a phone is how these are read");
  // Each Resend sits inside the same `canManage && offer.status === "sent"` block as Declined.
  for (const at of [composer.indexOf("void resendOffer(offer)"), composer.lastIndexOf("void resendOffer(offer)")]) {
    const gate = composer.lastIndexOf('canManage && offer.status === "sent"', at);
    const blockEnd = composer.indexOf(") : null}", gate);
    assert.ok(gate > -1 && at < blockEnd, "Resend is offered only to a manager, only on a sent offer");
  }

  // ── 6. Open draft: a saved draft can be reached again, and Send sends what is SHOWN ───────────
  // The same night the owner saved a draft and asked "how to open it and send": a draft's row carried
  // only a PDF button, so once the form cleared it could be neither edited nor sent (Alaa Mohsen's
  // had sat that way since 17 September).
  // Counted by the button's own label: `openDraft` also opens an offer waiting for the HR Manager's
  // approval (owner, 2026-11-10), from its row, its card and his queue — those are his, gated below.
  const label = '<Eye className="h-3.5 w-3.5" /> Open draft';
  const opens = composer.split(label).length - 1;
  assert.equal(opens, 2, "Open draft on the desktop row AND the phone card");
  for (const at of [composer.indexOf(label), composer.lastIndexOf(label)]) {
    const gate = composer.lastIndexOf('canManage && offer.status === "draft"', at);
    const blockEnd = composer.indexOf(") : null}", gate);
    assert.ok(gate > -1 && at < blockEnd, "Open draft is offered only to a manager, only on a draft");
  }
  const review = "/> Review and approve";
  for (let at = composer.indexOf(review); at > -1; at = composer.indexOf(review, at + 1)) {
    const gate = composer.lastIndexOf("canApprove", at);
    assert.ok(gate > -1 && composer.indexOf(") : null}", gate) > at, "Review and approve is offered only to the HR Manager");
  }
  const openFn = composer.slice(composer.indexOf("function openDraft("), composer.indexOf("async function sendOffer("));
  assert.ok(openFn.includes("markReferenceTyped(true)"), "an opened draft keeps its number — the title must never renumber it");
  assert.ok(openFn.includes("setSavedId(offer.id)"), "an opened draft is edited and sent as ITSELF, never saved as a second offer");
  // The stored dates are the letter's English form; the date pickers speak ISO. A round trip must be exact.
  for (const iso of ["2026-10-01", "2026-09-30", "2026-02-28"]) {
    assert.equal(parseLetterDate(toLetterDate(iso)), iso, `a stored ${iso} must come back to the picker unchanged`);
  }
  const draftFn = composer.slice(composer.indexOf("function draftFromOffer("), composer.indexOf("const STATUS_VARIANT"));
  for (const field of ["dateOfIssue", "startDate", "validUntil"]) {
    assert.ok(draftFn.includes(`${field}: parseLetterDate(offer.${field}) ?? ""`), `${field} goes back through parseLetterDate, blank when unreadable`);
  }
  // Send saves first. Before, it used the saved id as it stood, so an edit made after the last save
  // (a salary, a start date) was on screen and in the preview but NOT in the letter that went out.
  const sendFn = composer.slice(composer.indexOf("async function sendOffer("), composer.indexOf("const money ="));
  assert.ok(sendFn.includes("const id = await saveDraft();"), "Send must save what is on screen before sending it");
  assert.ok(!sendFn.includes("savedId ?? (await saveDraft())"), "never send the stale saved copy");
}
