import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  OFFER_COPY_MAX,
  planOfferCopies,
  splitOfferCopyAddresses,
} from "@/lib/offers/copy-recipients";
import { computeRecipientVolumeCeiling, resolveCeilingOverride } from "../src/lib/notifications/confidence-gate.ts";

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
    established! >= 1 + OFFER_COPY_MAX,
    "the gate's ceiling must cover the candidate plus every copy the send itself allows",
  );
  assert.ok(
    established! > computeRecipientVolumeCeiling([1, 1, 1, 1, 1, 1], 200).ceiling,
    "and it must actually lift the one-recipient baseline that would otherwise hold a copied offer",
  );

  // ── The wiring: the addresses reach the provider, and the guard is told they were intended ──
  const send = readFileSync("src/lib/offers/send.ts", "utf8");
  assert.match(send, /planOfferCopies\(\{ bcc: options\.bcc, candidateEmail: offer\.candidateEmail, cc: options\.cc \}\)/);
  assert.match(send, /externalRecipients: \[offer\.candidateEmail, \.\.\.copies\.cc, \.\.\.copies\.bcc\]/,
    "every copy must be declared to the Recipient Assurance Guard, or an outside address is blocked after HR pressed Send");
  assert.match(send, /bcc: copies\.bcc\.length > 0 \? copies\.bcc : undefined/);
  assert.match(send, /cc: copies\.cc\.length > 0 \? copies\.cc : undefined/);

  const route = readFileSync("app/api/offers/[id]/send/route.ts", "utf8");
  assert.match(route, /sendOfferEmail\(id, \{ bcc: body\?\.bcc, cc: body\?\.cc,/, "the route must hand the copies to the domain send");
  assert.match(route, /cc: outcome\.cc/, "the audit row must record who was copied");
  assert.match(route, /bcc: outcome\.bcc/, "including who was copied secretly");

  const composer = readFileSync("src/components/offers/offer-composer.tsx", "utf8");
  assert.match(
    composer,
    /call\(`\/api\/offers\/\$\{id\}\/send`, "POST", \{ bcc: copies\.bcc, cc: copies\.cc \}\)/,
    "the Send button must post the copies it shows",
  );
}
