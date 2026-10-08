import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { factsFingerprint, numbersIn, timesIn, verifyAssistAnswer } from "../src/lib/dispute-center/assist-verify.ts";
import type { DisputeCaseFact } from "../src/lib/dispute-center/types.ts";

/**
 * "HE MUST BE ACCURATE HUNDRED PERCENT" — the owner's condition on the case briefing, 2026-10-09.
 *
 * A model cannot be trusted to be, so it is not trusted: every statement it returns must name the
 * records it rests on, and every number, date, time and money figure in that statement must appear
 * in one of those records. Anything else is DROPPED and counted — never shown with a hedge, because
 * a reader cannot tell a hedged invention from a real finding, and this screen is where one person's
 * pay is decided.
 *
 * What the verifier does NOT claim to catch is pinned here too, so nobody later reads it as more
 * than it is: a sentence whose words are wrong while its numbers are right passes. That is why every
 * statement is rendered beside the records it cited.
 */

const FACTS: DisputeCaseFact[] = [
  { label: "Day", value: "Saturday 4 October 2026" },
  { label: "First punch", value: "08:52" },
  { label: "Visits recorded", value: "6 visits" },
  { label: "Deduction", value: "1 day, 420.50 EGP" },
  { label: "Trip claimed", value: "Cairo to Tanta, train ticket 85 EGP" },
];

export async function runDisputeCenterAssistAccuracyTests() {
  // The tokens a statement is checked on.
  assert.deepEqual(numbersIn("6 visits and 420.50 EGP"), ["6", "420.50"], "numbers are read as written, never reformatted");
  assert.deepEqual(numbersIn("1,250 EGP"), ["1250"], "a thousands separator is removed so 1,250 and 1250 are one figure");
  assert.deepEqual(timesIn("08:52 and 9:05"), ["8:52", "9:05"], "times normalize so 09:05 and 9:05 are the same claim");

  // A statement that cites its records and states only what they contain SURVIVES.
  const good = verifyAssistAnswer(
    [{ factIds: [1, 2], text: "On Saturday 4 October 2026 the first punch was at 08:52." }],
    FACTS,
  );
  assert.equal(good.dropped.length, 0, "a supported statement is not dropped");
  assert.equal(good.statements.length, 1);
  assert.deepEqual(
    good.statements[0]!.cited.map((fact) => fact.label),
    ["Day", "First punch"],
    "it carries the records it cited, in the order it cited them, for display beside it",
  );

  // A statement that names NO record is dropped, however plausible it reads.
  const uncited = verifyAssistAnswer([{ factIds: [], text: "She was not in Tanta that day." }], FACTS);
  assert.equal(uncited.statements.length, 0, "a statement resting on nothing is never shown");
  assert.equal(uncited.dropped.length, 1);
  assert.match(uncited.dropped[0]!.reason, /named no record/, "and the reader is told why");

  // A fact id outside the pack is not a citation — it is a made-up one.
  const outOfRange = verifyAssistAnswer([{ factIds: [99], text: "The ticket cost 85 EGP." }], FACTS);
  assert.equal(outOfRange.statements.length, 0, "a citation to a record that does not exist is no citation");

  // THE CENTRAL CASE: a figure that is not in the records it named. This is the invention that would
  // otherwise be read as a finding on a pay decision.
  const wrongNumber = verifyAssistAnswer([{ factIds: [3], text: "She recorded 9 visits that day." }], FACTS);
  assert.equal(wrongNumber.statements.length, 0, "a figure absent from the cited record is dropped");
  assert.match(wrongNumber.dropped[0]!.reason, /the figure 9 is not in the records it named/, "named exactly");

  // Same for a time.
  const wrongTime = verifyAssistAnswer([{ factIds: [2], text: "The first punch was at 10:15." }], FACTS);
  assert.equal(wrongTime.statements.length, 0, "a time absent from the cited record is dropped");
  assert.match(wrongTime.dropped[0]!.reason, /the time 10:15 is not in the records it named/);

  // Citing the WRONG record is caught by the same rule: the figure must be in what it named, not
  // merely somewhere in the pack.
  const wrongCitation = verifyAssistAnswer([{ factIds: [2], text: "The ticket cost 85 EGP." }], FACTS);
  assert.equal(wrongCitation.statements.length, 0, "a figure from another record does not count as supported");

  // A money figure with decimals survives only as written in the record.
  assert.equal(
    verifyAssistAnswer([{ factIds: [4], text: "The deduction is 1 day, 420.50 EGP." }], FACTS).statements.length,
    1,
    "the deduction can be stated exactly as the record holds it",
  );
  assert.equal(
    verifyAssistAnswer([{ factIds: [4], text: "The deduction is 420.75 EGP." }], FACTS).statements.length,
    0,
    "…and a nearly-right amount is still dropped",
  );

  // A time inside a statement does not also have to appear as two bare numbers.
  assert.equal(
    verifyAssistAnswer([{ factIds: [2], text: "08:52" }], FACTS).statements.length,
    1,
    "a time is checked as a time, not as the digits 8 and 52",
  );

  // Several statements: the good ones are kept and the bad ones counted, never all-or-nothing.
  const mixed = verifyAssistAnswer(
    [
      { factIds: [1], text: "The day disputed is Saturday 4 October 2026." },
      { factIds: [3], text: "There were 12 visits." },
      { factIds: [5], text: "The claim is a Cairo to Tanta trip with an 85 EGP train ticket." },
    ],
    FACTS,
  );
  assert.equal(mixed.statements.length, 2, "the supported statements survive on their own");
  assert.equal(mixed.dropped.length, 1, "and the unsupported one is reported, not hidden");

  // An empty statement is skipped silently — there is nothing to report and nothing to show.
  const blank = verifyAssistAnswer([{ factIds: [1], text: "   " }], FACTS);
  assert.equal(blank.statements.length, 0);
  assert.equal(blank.dropped.length, 0, "an empty statement is not a dropped finding");

  // THE LIMIT, stated plainly: wrong words with right numbers pass. The screen answers this by
  // showing the cited record beside every statement.
  const plausibleButWrong = verifyAssistAnswer(
    [{ factIds: [5], text: "The trip was Cairo to Mansoura, 85 EGP." }],
    FACTS,
  );
  assert.equal(
    plausibleButWrong.statements.length,
    1,
    "the verifier checks figures, not geography — which is why the record is rendered beside the sentence",
  );

  // THE STALENESS MARK — a saved briefing must never be read as current after the case moved.
  const first = factsFingerprint(FACTS);
  assert.equal(first, factsFingerprint([...FACTS]), "the same facts fingerprint the same");
  assert.notEqual(
    first,
    factsFingerprint([...FACTS, { label: "Reply", value: "She sent a photo of the ticket." }]),
    "a new record changes the fingerprint, so the old briefing shows as out of date",
  );
  assert.notEqual(
    first,
    factsFingerprint(FACTS.map((fact) => (fact.label === "Deduction" ? { ...fact, value: "0.5 day, 210.25 EGP" } : fact))),
    "a CHANGED figure changes it too — the dangerous case, where the briefing still reads plausibly",
  );
  assert.notEqual(
    factsFingerprint([FACTS[0]!, FACTS[1]!]),
    factsFingerprint([FACTS[1]!, FACTS[0]!]),
    "order is part of the fingerprint, because fact 1 is what a citation points at",
  );

  // The instructions the model is given must keep saying the things that make the check possible,
  // and must keep refusing to accuse anybody — the briefing describes records, it does not judge.
  const assist = readFileSync("src/lib/dispute-center/assist.ts", "utf8");
  const instructionsStart = assist.indexOf("const INSTRUCTIONS");
  assert.ok(instructionsStart > 0, "the instructions constant exists");
  // Read the constant ONLY — a comment nearby must never be what satisfies this.
  const instructions = assist.slice(instructionsStart, assist.indexOf("const TEXT_FORMAT", instructionsStart));
  for (const phrase of [
    "fact_ids",
    "Never state a number",
    "Never guess",
    "Do not accuse anybody",
    // The sentence is split across two concatenated lines in the source, so it is checked in halves.
    "Never use the words fraud, lying, guilty,",
    "innocent, or suspect",
    "Names, never codes",
    "Cairo times",
  ]) {
    assert.ok(instructions.includes(phrase), `the briefing instructions still say "${phrase}"`);
  }
  // The strict schema is what makes a citation compulsory rather than requested.
  assert.match(assist, /required: \["text", "fact_ids"\]/, "a statement cannot come back without its fact ids");
  assert.match(assist, /strict: true as const/, "the response schema is strict, so the shape is guaranteed");

  // Both callers verify, and the verification happens before the answer leaves the function.
  const runStart = assist.indexOf("export async function runDisputeAssist");
  const runBody = assist.slice(runStart, assist.indexOf("type EntryRow", runStart));
  const verifiedAt = runBody.indexOf("verifyAssistAnswer(");
  assert.ok(verifiedAt > 0, "runDisputeAssist verifies the answer");
  assert.ok(
    verifiedAt < runBody.indexOf("statements: verified.statements"),
    "…before anything is returned to the screen",
  );
  assert.ok(
    runBody.includes("statements: verified.statements") && !runBody.includes("statements: asked.statements"),
    "the screen is given the VERIFIED statements, never the model's own list",
  );
}
