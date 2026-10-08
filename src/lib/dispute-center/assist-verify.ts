import type { DisputeCaseFact } from "./types.ts";

// THE ACCURACY RULE — pure, so it is pinned by a test and never by a demo.
//
// The owner's condition (2026-10-09) was "he must be accurate hundred percent". A model cannot be
// trusted to be, so the briefing is not trusted: it is CHECKED. Every statement it returns must name
// the facts it rests on, and every number, date, time and money figure inside the statement must
// appear in one of those facts. A statement that fails is DROPPED and counted, never shown with a
// hedge — a reader cannot tell a hedged invention from a real finding, and this screen is where
// somebody decides another person's pay.
//
// What it cannot catch, and does not pretend to: a statement whose words are wrong while its numbers
// are right ("she was in Tanta" when the fact says Mansoura). That is why every statement carries its
// facts on screen: the reader sees the record the sentence came from, side by side with it.

export type AssistStatement = {
  /** 1-based fact numbers the statement rests on. */
  factIds: number[];
  text: string;
};

export type VerifiedStatement = AssistStatement & {
  /** The facts it cited, in the order cited, for display beside it. */
  cited: Array<{ id: number; label: string; value: string }>;
};

export type VerifiedAnswer = {
  statements: VerifiedStatement[];
  /** Statements removed because the facts did not support them, with the reason. */
  dropped: Array<{ reason: string; text: string }>;
};

/** Every number in a string, as the digits that were written — never re-formatted. */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((value) => value.replace(/,/g, ""));
}

/** Times a statement claims, normalized to H:MM so "9:05" and "09:05" are the same claim. */
export function timesIn(text: string): string[] {
  return (text.match(/\b\d{1,2}:\d{2}\b/g) ?? []).map((value) => {
    const [hour, minute] = value.split(":");
    return `${Number(hour)}:${minute}`;
  });
}

/**
 * The claim-bearing tokens of a piece of text: its times, then its numbers with the time digits
 * removed, so "09:05" does not also have to appear as "9" and "5".
 */
function claims(text: string): { numbers: string[]; times: string[] } {
  const times = timesIn(text);
  let stripped = text;
  for (const match of text.match(/\b\d{1,2}:\d{2}\b/g) ?? []) stripped = stripped.replace(match, " ");
  return { numbers: numbersIn(stripped), times };
}

/** Does `haystack` contain the number as a number (not as part of a longer one)? */
function hasNumber(haystack: string[], needle: string): boolean {
  return haystack.includes(needle) || haystack.includes(String(Number(needle)));
}

/**
 * Check one answer against the facts it was built from. `facts` is the pack in the order it was
 * given to the model, so fact id 1 is `facts[0]`.
 */
export function verifyAssistAnswer(statements: AssistStatement[], facts: DisputeCaseFact[]): VerifiedAnswer {
  const verified: VerifiedStatement[] = [];
  const dropped: Array<{ reason: string; text: string }> = [];

  for (const statement of statements) {
    const text = String(statement.text ?? "").trim();
    if (!text) continue;
    const ids = Array.from(new Set((statement.factIds ?? []).map((id) => Math.trunc(Number(id))))).filter(
      (id) => Number.isInteger(id) && id >= 1 && id <= facts.length,
    );
    if (ids.length === 0) {
      dropped.push({ reason: "it named no record", text });
      continue;
    }
    const cited = ids.map((id) => ({ id, label: facts[id - 1]!.label, value: facts[id - 1]!.value }));
    const haystack = cited.map((fact) => `${fact.label} ${fact.value}`).join(" | ");
    const inFacts = claims(haystack);
    const inText = claims(text);

    const missingTime = inText.times.find((time) => !inFacts.times.includes(time));
    if (missingTime) {
      dropped.push({ reason: `the time ${missingTime} is not in the records it named`, text });
      continue;
    }
    const missingNumber = inText.numbers.find((value) => !hasNumber(inFacts.numbers, value));
    if (missingNumber) {
      dropped.push({ reason: `the figure ${missingNumber} is not in the records it named`, text });
      continue;
    }
    verified.push({ cited, factIds: ids, text });
  }

  return { dropped, statements: verified };
}

/**
 * A stable fingerprint of the facts an answer was built from, stored beside it: a saved briefing can
 * then be shown with "the record has changed since this was written" rather than read as current.
 */
export function factsFingerprint(facts: DisputeCaseFact[]): string {
  const joined = facts.map((fact) => `${fact.label}=${fact.value}`).join("\n");
  let hash = 0x811c9dc5;
  for (let i = 0; i < joined.length; i += 1) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${facts.length}-${hash.toString(16)}`;
}
