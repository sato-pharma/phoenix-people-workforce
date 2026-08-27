import assert from "node:assert/strict";

import { offerDraftWarnings, offerWarningsFor } from "@/lib/offers/draft-checks";

const CLEAN = {
  candidateEmail: "samaa@example.com",
  dateOfIssue: "2026-08-27",
  existingEmails: [] as string[],
  startDate: "2026-09-01",
  validUntil: "2026-09-03",
};

export function runOfferDraftCheckTests() {
  // ── The headline: a correctly filled offer must raise nothing at all ──
  //
  // A warning that fires on a good offer is worse than no warning. It gets ignored within a week,
  // and the real one is ignored with it.
  assert.deepEqual(
    offerDraftWarnings(CLEAN),
    [],
    "a correctly filled offer must raise no warnings — a note that cries wolf trains people to ignore every note",
  );

  // ── An offer that expires before it is issued ──
  const expired = offerDraftWarnings({ ...CLEAN, validUntil: "2026-08-20" });
  assert.equal(expired.length, 1, "one problem must produce one note, not several about the same dates");
  assert.equal(expired[0].field, "validUntil");
  assert.match(expired[0].message, /already expired/);

  const sameDay = offerDraftWarnings({ ...CLEAN, validUntil: "2026-08-27" });
  assert.equal(sameDay.length, 1);
  assert.match(sameDay[0].message, /same day it is issued/, "expiring on the issue date is its own problem");

  // ── A start date before the letter's own date ──
  const backdated = offerDraftWarnings({ ...CLEAN, startDate: "2026-08-01" });
  assert.equal(
    offerWarningsFor(backdated, "startDate").length,
    1,
    "a start date before the letter is dated asks the candidate to have started already",
  );

  // ── An acceptance window running past the start date must stay SILENT ──
  //
  // This one was implemented, and this test rejected it on the first run. Giving somebody a week
  // to decide about a job starting in four days is ordinary, and it is what the composer's own
  // defaults produce — issue today, valid a week, start on the first of next month. A note on the
  // default settings is the note that teaches people to ignore the amber triangle entirely.
  assert.deepEqual(
    offerDraftWarnings({ ...CLEAN, startDate: "2026-08-30", validUntil: "2026-09-10" }),
    [],
    "an offer still acceptable after its start date is ordinary and must not be flagged",
  );

  // A letter that is BOTH expired and starts late must not say two things about one pair of dates.
  const doubled = offerDraftWarnings({ ...CLEAN, startDate: "2026-08-25", validUntil: "2026-08-20" });
  assert.equal(
    offerWarningsFor(doubled, "validUntil").length,
    1,
    "two notes about the same two dates reads as two problems when there is one",
  );

  // ── Unset dates are not checked ──
  //
  // A half-filled form is a form being filled, not a form with mistakes in it.
  assert.deepEqual(
    offerDraftWarnings({ ...CLEAN, startDate: "", validUntil: "" }),
    [],
    "a date not yet chosen is not a date in the wrong order",
  );
  assert.deepEqual(
    offerDraftWarnings({ ...CLEAN, dateOfIssue: "", startDate: "", validUntil: "" }),
    [],
    "an empty form must be silent",
  );

  // ── The email ──
  assert.equal(offerWarningsFor(offerDraftWarnings({ ...CLEAN, candidateEmail: "" }), "candidateEmail").length, 0,
    "an address not yet typed is not a malformed address");

  for (const bad of ["samaa", "samaa@", "@example.com", "samaa@example", "a b@example.com"]) {
    assert.equal(
      offerWarningsFor(offerDraftWarnings({ ...CLEAN, candidateEmail: bad }), "candidateEmail").length,
      1,
      `"${bad}" cannot receive an offer and must be flagged`,
    );
  }
  for (const good of ["samaa@example.com", "s.shalaby+hr@sub.example.co.uk", "SAMAA@EXAMPLE.COM"]) {
    assert.equal(
      offerWarningsFor(offerDraftWarnings({ ...CLEAN, candidateEmail: good }), "candidateEmail").length,
      0,
      `"${good}" is a real address and rejecting it would stop a candidate receiving their offer`,
    );
  }

  // ── A second offer to the same address ──
  //
  // Sometimes right (a revised package) and sometimes somebody forgetting. Said, never blocked.
  const repeat = offerDraftWarnings({ ...CLEAN, existingEmails: ["samaa@example.com"] });
  assert.equal(offerWarningsFor(repeat, "candidateEmail").length, 1, "a repeat offer to one address is worth a look");

  const repeatDifferentCase = offerDraftWarnings({ ...CLEAN, existingEmails: ["  SAMAA@Example.COM "] });
  assert.equal(
    offerWarningsFor(repeatDifferentCase, "candidateEmail").length,
    1,
    "the same address in different case is the same person",
  );

  assert.equal(
    offerWarningsFor(offerDraftWarnings({ ...CLEAN, existingEmails: ["someone@else.com"] }), "candidateEmail").length,
    0,
    "a different candidate is not a duplicate",
  );

  // A malformed address must not ALSO be reported as a duplicate — one problem, one note.
  const malformedAndListed = offerDraftWarnings({
    ...CLEAN,
    candidateEmail: "samaa",
    existingEmails: ["samaa"],
  });
  assert.equal(
    offerWarningsFor(malformedAndListed, "candidateEmail").length,
    1,
    "an address that is not an address is one problem, not two",
  );

  // ── Every warning must name a field the composer can actually put it beside ──
  const all = [
    ...offerDraftWarnings({ ...CLEAN, validUntil: "2026-08-20" }),
    ...offerDraftWarnings({ ...CLEAN, startDate: "2026-08-01" }),
    ...offerDraftWarnings({ ...CLEAN, candidateEmail: "nope" }),
    ...offerDraftWarnings({ ...CLEAN, existingEmails: ["samaa@example.com"] }),
  ];
  assert.ok(all.length >= 4, "the cases above must actually produce warnings");
  for (const warning of all) {
    assert.ok(
      ["candidateEmail", "startDate", "validUntil"].includes(warning.field),
      `a warning on "${warning.field}" has no field to sit beside and would never be seen`,
    );
    assert.ok(warning.message.trim().length > 0, "a warning with no words is an amber triangle and nothing else");
    assert.ok(
      warning.message.trim().endsWith("."),
      `"${warning.message}" must read as a sentence — these appear under a field, in full`,
    );
  }
}
