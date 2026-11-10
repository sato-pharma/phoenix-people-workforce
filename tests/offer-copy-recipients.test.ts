import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  OFFER_COPY_MAX,
  planOfferCopies,
  splitOfferCopyAddresses,
} from "@/lib/offers/copy-recipients";
import { computeRecipientVolumeCeiling, resolveCeilingOverride } from "../src/lib/notifications/confidence-gate.ts";
import { OFFER_OWNER_BCC, offerBccWithOwnerCopy } from "../src/lib/offers/owner-copy.ts";

/**
 * CC and BCC on a job offer (owner, 2026-09-28: "add option to CC or BCC in the job offer module",
 * then "and to CC or BCC more than one recipient").
 *
 * Asked whether an offer — which carries a salary — may be copied outside the company, the owner
 * answered "anyone, no reason". So nothing here may refuse an address for its domain.
 */
export function runOfferCopyRecipientsTests() {
  // ── More than one recipient on each line — the owner's second message ──
  const several = planOfferCopies({
    bcc: "hr@satopharma.com; audit@satopharma.com",
    candidateEmail: "samaa@example.com",
    cc: "Manager@SatoPharma.com, head@satopharma.com",
  });
  assert.deepEqual(several.cc, ["manager@satopharma.com", "head@satopharma.com"], "CC must carry every address, lower-cased");
  assert.deepEqual(several.bcc, ["hr@satopharma.com", "audit@satopharma.com"], "BCC must carry every address too");
  assert.deepEqual(several.problems, [], "a clean pair of lines raises nothing");
  assert.deepEqual(several.notes, [], "and says nothing");

  // ── Every way an address list arrives ──
  assert.deepEqual(
    splitOfferCopyAddresses("a@x.com, b@x.com;c@x.com\nd@x.com e@x.com"),
    ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"],
    "commas, semicolons, new lines and plain spaces all separate addresses",
  );
  assert.deepEqual(
    splitOfferCopyAddresses("Omar Anwar <omar.anwar@satopharma.com>, Hany Saad <hany@satopharma.com>"),
    ["omar.anwar@satopharma.com", "hany@satopharma.com"],
    "a line pasted from a mail client means the address inside the angle brackets, not the name",
  );
  assert.deepEqual(splitOfferCopyAddresses(["a@x.com", "b@x.com, c@x.com"]), ["a@x.com", "b@x.com", "c@x.com"]);
  assert.deepEqual(planOfferCopies({ candidateEmail: "samaa@example.com" }).cc, [], "no copies is the normal case");
  assert.deepEqual(planOfferCopies({ bcc: "  ", cc: "", candidateEmail: "samaa@example.com" }).problems, []);

  // ── Anyone, no reason (owner's ruling) ──
  const outside = planOfferCopies({ candidateEmail: "samaa@example.com", cc: "recruiter@gmail.com" });
  assert.deepEqual(outside.cc, ["recruiter@gmail.com"], "an address outside the company is allowed");
  assert.deepEqual(outside.problems, [], "and needs no reason — the owner ruled it, do not add a company-only rule back");

  // ── A bad address stops the WHOLE send, and names the box it is in ──
  const bad = planOfferCopies({ bcc: "hr@satopharma.com, hr-at-satopharma", candidateEmail: "samaa@example.com", cc: "manager@satopharma.com" });
  assert.equal(bad.problems.length, 1, "one problem, one message");
  assert.match(bad.problems[0], /hr-at-satopharma/, "the message quotes the entry exactly as typed");
  assert.deepEqual(bad.invalid, { bcc: ["hr-at-satopharma"], cc: [] }, "and the screen can tell which box holds it");
  assert.deepEqual(bad.bcc, ["hr@satopharma.com"], "the good addresses are still read");

  // ── Redundant copies are left off, and SAID ──
  const redundant = planOfferCopies({
    bcc: "Manager@satopharma.com, hr@satopharma.com, hr@satopharma.com",
    candidateEmail: "Samaa@Example.com",
    cc: "samaa@example.com, manager@satopharma.com",
  });
  assert.deepEqual(redundant.cc, ["manager@satopharma.com"], "the candidate's own address is already To, so never a copy");
  assert.deepEqual(redundant.bcc, ["hr@satopharma.com"], "a person on CC is not also blind-copied, and a repeat is sent once");
  assert.equal(redundant.problems.length, 0, "redundancy is not a refusal");
  assert.equal(redundant.notes.length, 2, "each thing left off is reported — the candidate, and the CC repeat");

  // ── The cap, and the gate that must never be the thing that stops a copied offer ──
  const addresses = (n: number) => Array.from({ length: n }, (_, i) => `person${i}@satopharma.com`).join(", ");
  assert.deepEqual(planOfferCopies({ candidateEmail: "samaa@example.com", cc: addresses(OFFER_COPY_MAX) }).problems, []);
  const overCap = planOfferCopies({
    bcc: addresses(OFFER_COPY_MAX).replace(/person/g, "other"),
    candidateEmail: "samaa@example.com",
    cc: "one@satopharma.com",
  });
  assert.ok(overCap.limitProblem, "one past the cap must be refused");
  assert.ok(overCap.problems.includes(overCap.limitProblem!), "and the refusal is part of what stops the send");

  // A job offer went to one person for its whole life, so its established baseline reads ~1 and the
  // Notification Confidence Gate's ceiling sits at 3. Without an `always` override every offer copied
  // to three or more people would be HELD — a candidate waiting on a review queue nobody watches.
  const established = resolveCeilingOverride("offers", "offer_letter", "established");
  assert.ok(established !== undefined, "the override must survive the pair being established — that is the whole point");
  assert.ok(
    established! >= 1 + OFFER_COPY_MAX + 1,
    "the gate's ceiling must cover the candidate, every copy the send itself allows, and the owner's own copy",
  );
  assert.ok(
    established! > computeRecipientVolumeCeiling([1, 1, 1, 1, 1, 1], 200).ceiling,
    "and it must actually lift the one-recipient baseline that would otherwise hold a copied offer",
  );

  // ── The wiring: the addresses reach the provider, and the guard is told they were intended ──
  const send = readFileSync("src/lib/offers/send.ts", "utf8");
  assert.match(send, /planOfferCopies\(\{ bcc: options\.bcc, candidateEmail: offer\.candidateEmail, cc: options\.cc \}\)/);
  assert.match(send, /externalRecipients: \[offer\.candidateEmail, \.\.\.copies\.cc, \.\.\.bcc\]/,
    "every copy must be declared to the Recipient Assurance Guard, or an outside address is blocked after HR pressed Send");
  assert.match(send, /bcc: bcc\.length > 0 \? bcc : undefined/);

  // ── The owner's hidden copy of every job offer (owner, 2026-11-10: "all job offers i am by default
  // in the bcc", then "Yes, job offers only") ──
  // "Stop the BCC copies" (2026-11-06) took it off every automated email at once, offers included, and
  // 9 offers left without him. It is back for offers ALONE, added after HR's copies were planned.
  assert.deepEqual(
    offerBccWithOwnerCopy({ bcc: ["a@satopharma.com"], candidateEmail: "samaa@example.com", cc: [] }),
    ["a@satopharma.com", OFFER_OWNER_BCC],
    "HR's BCC first, then the owner",
  );
  assert.deepEqual(
    offerBccWithOwnerCopy({ bcc: [], candidateEmail: "samaa@example.com", cc: [] }),
    [OFFER_OWNER_BCC],
    "an offer with no copies at all still reaches him",
  );
  assert.deepEqual(
    offerBccWithOwnerCopy({ bcc: [], candidateEmail: "samaa@example.com", cc: [OFFER_OWNER_BCC.toUpperCase()] }),
    [],
    "never a second copy when HR already put him on the CC line",
  );
  assert.deepEqual(offerBccWithOwnerCopy({ bcc: [OFFER_OWNER_BCC], candidateEmail: "samaa@example.com", cc: [] }), [OFFER_OWNER_BCC]);
  const deliverAt = send.indexOf("async function deliverOfferLetter(");
  assert.ok(
    deliverAt > 0 &&
      send.indexOf("offerBccWithOwnerCopy({ bcc: copies.bcc, candidateEmail: offer.candidateEmail, cc: copies.cc })", deliverAt) > deliverAt,
    "added inside the one delivery every offer letter goes through — a send, an updated offer and a resend",
  );
  assert.match(send, /cc: copies\.cc\.length > 0 \? copies\.cc : undefined/);

  const route = readFileSync("app/api/offers/[id]/send/route.ts", "utf8");
  // `approvedByHrManager: true` first: only the HR Manager's Send reaches the domain send (owner, 2026-11-10).
  assert.match(route, /sendOfferEmail\(id, \{ approvedByHrManager: true, bcc: body\?\.bcc, cc: body\?\.cc,/, "the route must hand the copies to the domain send");
  assert.match(route, /cc: outcome\.cc/, "the audit row must record who was copied");
  assert.match(route, /bcc: outcome\.bcc/, "including who was copied secretly");

  const composer = readFileSync("src/components/offers/offer-composer.tsx", "utf8");
  assert.match(
    composer,
    /call\(`\/api\/offers\/\$\{id\}\/send`, "POST", \{ bcc: copies\.bcc, cc: copies\.cc \}\)/,
    "the Send button must post the copies it shows",
  );

  // ── Who was copied, SHOWN on the Offers list (owner, same evening) ──
  // The copies are stored on the offer in the SAME update that marks it sent, from exactly what was
  // handed to the provider — so the list can never name a copy that was not sent, or miss one that was.
  const service = readFileSync("src/lib/offers/service.ts", "utf8");
  const markSent = service.slice(service.indexOf("export async function markOfferSent("));
  const markSentBody = markSent.slice(0, markSent.indexOf("\n}\n"));
  assert.match(markSentBody, /bcc_recipients: copies\.bcc,/, "markOfferSent must write the BCC list");
  assert.match(markSentBody, /cc_recipients: copies\.cc,/, "markOfferSent must write the CC list");
  // A draft (the HR Manager's own) or an offer waiting for his approval (owner, 2026-11-10).
  assert.match(markSentBody, /\.in\("status", \["draft", "pending_approval"\]\)/, "in the same guarded update that stamps the send");
  assert.match(
    send,
    /options\.sentBy \?\? null,[\s\S]{0,200}\{ bcc: copies\.bcc, cc: copies\.cc \},\s*\)/,
    "the send must hand markOfferSent the copies it actually sent",
  );
  assert.match(
    service,
    /bccRecipients: Array\.isArray\(row\.bcc_recipients\) \? row\.bcc_recipients : \[\]/,
    "a row read from a database without the column must read as nobody copied, never throw",
  );
  assert.match(service, /ccRecipients: Array\.isArray\(row\.cc_recipients\) \? row\.cc_recipients : \[\]/);

  // One rendering, used by BOTH the desktop row and the phone card — counted, not matched, because
  // one occurrence passes while the phone (how these are read) shows nothing.
  assert.equal(
    composer.match(/<OfferCopiedTo offer=\{offer\} \/>/g)?.length ?? 0,
    2,
    "who was copied must show on the desktop row AND the phone card",
  );
  assert.doesNotMatch(
    composer.slice(composer.indexOf("function OfferCopiedTo"), composer.indexOf("export function OfferComposer")),
    /truncate|text-ellipsis/,
    "a copy list is never cut off with an ellipsis — reading every address is the point of it",
  );
  // The phone card's status badge must not shrink. Measured on production 2026-09-28 at 375px: the
  // first card carrying a copy line clipped "Sent" to 33 of its 36px, because a long copy line
  // widened the text column and flex took the difference out of the badge too.
  const phoneCard = composer.slice(composer.indexOf('<div className="flex flex-col gap-3 px-5 py-5 @4xl:hidden">'));
  assert.match(
    phoneCard,
    /<Badge className="shrink-0 capitalize" variant=\{STATUS_VARIANT\[offer\.status\]\}>/,
    "the phone card's status badge must be shrink-0, or a long copy line clips it",
  );

  const migration = readFileSync("supabase/migrations/20260928225001_add_offer_copy_recipients.sql", "utf8");
  assert.match(migration, /add column if not exists cc_recipients text\[\] not null default '\{\}'::text\[\]/);
  assert.match(migration, /add column if not exists bcc_recipients text\[\] not null default '\{\}'::text\[\]/);
}
