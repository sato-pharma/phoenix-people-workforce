import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { OFFER_LIST_PAGE, OFFER_LIST_STATUSES, filterOffers, offerStatusCounts } from "@/lib/offers/list-filter";

/**
 * The Job Offers page polish (owner, 2026-11-10: "premium polish the page godmode design and ease and
 * perfection"): a search and a status filter on the list, the list in pages of 20, the form in numbered
 * sections, Save and Send pinned under the form, and the Hiring Documents tab strip instead of a
 * gradient pill.
 */
export function runOffersPagePolishTests() {
  const offers = [
    { candidateEmail: "samaa@example.com", candidateName: "Samaa Shalaby", reference: "SP-HR-MR-2026-001", status: "sent" as const, title: "Medical Representative" },
    { candidateEmail: "ahmed@example.com", candidateName: "Ahmed El Sayed", reference: "SP-HR-DSM-2026-002", status: "accepted" as const, title: "District Sales Manager" },
    { candidateEmail: "mona@example.com", candidateName: "Mona Fathy", reference: "SP-HR-MR-2026-003", status: "accepted" as const, title: "Medical Representative" },
    { candidateEmail: "rana@example.com", candidateName: "Ranà Adel", reference: "SP-HR-MR-2026-004", status: "pending_approval" as const, title: "Medical Representative" },
  ];

  // ── Search: every word, anywhere in name, email, title or reference; case, accents and spacing folded ──
  assert.deepEqual(filterOffers(offers, { query: "", status: "all" }).length, 4);
  assert.deepEqual(filterOffers(offers, { query: "  SAMAA   shalaby ", status: "all" }).map((o) => o.candidateName), ["Samaa Shalaby"]);
  assert.deepEqual(filterOffers(offers, { query: "rana", status: "all" }).map((o) => o.candidateName), ["Ranà Adel"], "an accent never hides a name");
  assert.deepEqual(filterOffers(offers, { query: "district", status: "all" }).map((o) => o.candidateName), ["Ahmed El Sayed"]);
  assert.deepEqual(filterOffers(offers, { query: "2026-003", status: "all" }).map((o) => o.candidateName), ["Mona Fathy"]);
  assert.deepEqual(filterOffers(offers, { query: "mona representative", status: "all" }).length, 1, "every word must match");
  assert.deepEqual(filterOffers(offers, { query: "nobody", status: "all" }), []);

  // ── Status filter, and search inside it, in the order given (newest first) ──
  assert.deepEqual(filterOffers(offers, { query: "", status: "accepted" }).map((o) => o.candidateName), ["Ahmed El Sayed", "Mona Fathy"]);
  assert.deepEqual(filterOffers(offers, { query: "mona", status: "accepted" }).map((o) => o.candidateName), ["Mona Fathy"]);
  assert.deepEqual(filterOffers(offers, { query: "samaa", status: "accepted" }), []);

  // ── Counts: every status present, zero included, and All is the whole list ──
  const counts = offerStatusCounts(offers);
  assert.equal(counts.all, 4);
  assert.equal(counts.accepted, 2);
  assert.equal(counts.pending_approval, 1);
  assert.equal(counts.declined, 0);
  assert.deepEqual(OFFER_LIST_STATUSES[0], "pending_approval", "what needs somebody comes first");
  assert.equal(OFFER_LIST_PAGE, 20);

  // ── The screen wires it: both the table and the phone cards draw the page, never the whole list ──
  const composer = readFileSync("src/components/offers/offer-composer.tsx", "utf8");
  assert.equal((composer.match(/\{shownOffers\.map\(\(offer\) => \(/g) ?? []).length, 2, "table and cards both draw the page");
  assert.doesNotMatch(composer, /\{offers\.map\(\(offer\) => \(/, "no view draws all 86 offers at once");
  assert.match(composer, /aria-label="Search offers"/);
  assert.match(composer, /aria-label="Filter offers by status"/);
  assert.match(composer, /setListLimit\(\(limit\) => limit \+ OFFER_LIST_PAGE\)/);
  assert.match(composer, /No offer matches this search\./);

  // ── The form: five numbered sections; Save and Send in the header AND the pinned bar, one definition ──
  for (const [step, title] of [[1, "Candidate"], [2, "The email"], [3, "The job"], [4, "Reference and dates"], [5, "Pay and letter design"]] as const) {
    assert.match(composer, new RegExp(`sectionHeading\\(${step}, "${title}"`));
  }
  assert.match(composer, /action=\{composerActions\}/, "the header carries the buttons");
  assert.match(composer, /\n {10}\{composerActions\}\n/, "and the pinned bar carries the same ones");
  assert.match(composer, /className="sticky bottom-0 z-10/);

  // ── Restraint: no gradient, glow or drop shadow on what this change touched ──
  const manager = readFileSync("src/components/offers/offers-manager.tsx", "utf8");
  assert.doesNotMatch(manager, /bg-gradient-to-r from-orange-500/, "the tab is an underline, never a gradient pill");
  assert.match(manager, /border-b-2 px-4 py-2 text-sm transition-colors/);
  assert.doesNotMatch(composer, /max-w-\[860px\][^"]*shadow-lg/, "the letter preview has no drop shadow");
  assert.doesNotMatch(composer, /bg-white px-4 py-3 shadow-sm" key=\{label\}/, "the pay boxes have no drop shadow");
}
