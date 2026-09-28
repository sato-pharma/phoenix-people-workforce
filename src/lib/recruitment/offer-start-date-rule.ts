// Recruitment / ATS — whether an offer letter in a given state may still hand over its first working
// day. One rule, one copy, and deliberately in a module of its own.
//
// 🔒 THE OWNER'S RULING, 2026-09-28: *"exclude declined and withdrawn letters from the start date"*.
//
// A DECLINED OR WITHDRAWN LETTER IS DEAD, AND ITS DATE IS A LIE. The live case is real: one wired
// candidate's only letter reads `declined` and still carries 01 October 2026, so before this rule a
// template aimed at her filled in a first working day from an offer she turned down — grammatical,
// plausible, and wrong about the one fact a new hire acts on.
//
// `draft` AND `sent` STILL COUNT, deliberately. A recruiter routinely sends the document request or
// the welcome message on a verbal yes, while the letter itself still reads `sent` — narrowing this to
// `accepted` alone would make the ordinary case ask for a date that is already agreed and on file.
// The rule withholds a date from a letter that is FINISHED, not from one that is merely unconfirmed.
//
// THE POINTER ITSELF IS UNTOUCHED BY IT. A declined letter stays linked to the person it was written
// for — that is history and it is true. What is withheld is only the date.
//
// 🔴 WHY THIS IS ITS OWN FILE, AND MUST STAY ONE: the candidate record PAGE reads this rule too, so
// the same sentence appears on screen and in a sent message. That page is a CLIENT component, and
// `candidate-context.ts` — where this rule used to live — imports the database client and the offers
// service, which are server-only and carry the service-role credential. Importing the rule from
// there dragged all of it into the browser bundle. **Nothing in this file may import anything that
// touches a database, a credential or a server-only module.**

const OFFER_STATUSES_WITH_NO_START_DATE = new Set(["declined", "withdrawn"]);

export function offerCanGiveAStartDate(status: string): boolean {
  return !OFFER_STATUSES_WITH_NO_START_DATE.has(String(status ?? "").trim().toLowerCase());
}
