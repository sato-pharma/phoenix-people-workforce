// How a standalone offer letter points at its candidate.
//
// THE DECISION, 2026-09-28, and the reason this file exists rather than a comment. The owner asked
// how a standalone offer — one written for somebody with no application behind it — should be joined
// to the person it was written for. There are only two places the pointer can live, and one of them
// is forbidden:
//
//   offers.candidate_id       -> FORBIDDEN. `src/lib/offers/types.ts` carries the owner's instruction
//                                that the offers module is independent of recruitment, because an
//                                offer may be issued to somebody who never entered the ATS: "the two
//                                must not be merged". This column was written on 2026-09-28, a pinned
//                                test caught it, and it was reverted the same night — from staging and
//                                production as well as from the branch.
//   ats_candidates.offer_id   -> THE DECISION. Recruitment points AT offers, which is the one
//                                permitted direction and the direction `candidate-context.ts` already
//                                read in through the offers module's own `getOffer`.
//
// WHY NOT `ats_applications.offer_id`, WHICH ALREADY EXISTED. Because it can only be written where an
// application exists, and production holds 27 offers against 15 applications — which is exactly why
// that column read 0 of 15 rows. An offer belongs to a PERSON, not to an application. It stays as the
// fallback read, because the bridge does write it and rows carry it.
//
// WHY ONE COLUMN AND NOT A JOIN TABLE. Measured on production 2026-09-28: every candidate holding
// more than one offer has exactly ONE distinct title-and-territory across them. Every multiple is a
// RE-SEND of the same offer, so one pointer loses nothing that happened, and a join table would model
// a history that does not exist.
//
// These assertions defend the DIRECTION above all. A future session reading "an offer has no
// candidate" will reach for the obvious column; that is the mistake, and it has already been made
// once.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { borrowableFields, describeBorrowedFields, mergeableFields } from "@/lib/recruitment/candidate-merge";
import { mapCandidate } from "@/lib/recruitment/db";
import { offerCanGiveAStartDate } from "@/lib/recruitment/whatsapp-templates/candidate-context";

function read(file: string): string {
  return readFileSync(file, "utf8");
}

export function runCandidateOfferPointerTests(): void {
  // ── 1 · THE DIRECTION. Nothing in the offers module learns that a candidate exists ──────────────
  //
  // Checked over the WHOLE module, not the two files the earlier guard names: the reverted attempt
  // put its column in a migration and its field in `types.ts`, and the next attempt will not
  // necessarily land in the same two files.
  const offerFiles = readdirSync("src/lib/offers", { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, "/"))
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .map((name) => `src/lib/offers/${name}`);
  assert.ok(offerFiles.length > 0, "the offers module must still be here — re-point this test if it moved");

  for (const file of offerFiles) {
    const src = read(file);
    assert.ok(
      !/from "@\/lib\/recruitment/.test(src),
      `${file} must never import from recruitment — the offers module is deliberately independent `
        + '(owner: "the two must not be merged"), and an offer may be issued to somebody who never '
        + "entered the ATS",
    );
    assert.ok(
      !/candidate_id|ats_candidates/.test(src),
      `${file} must not learn that a candidate id exists — the pointer lives on the recruitment side. `
        + "A candidate_id column on offers was written on 2026-09-28 and reverted the same night.",
    );
  }

  // ── 2 · The migration puts the column on the CANDIDATE, pointing at offers ──────────────────────
  const migrations = readdirSync("supabase/migrations")
    .filter((name) => name.endsWith("_add_candidate_offer_pointer.sql"));
  assert.equal(
    migrations.length,
    1,
    `exactly one migration must add the candidate offer pointer. Found ${migrations.length}.`,
  );
  const migration = read(`supabase/migrations/${migrations[0]}`);
  assert.match(
    migration,
    /alter table public\.ats_candidates\s*\n?\s*add column if not exists offer_id uuid/,
    "the pointer column belongs on ats_candidates",
  );
  assert.match(
    migration,
    /references public\.offers\(id\) on delete set null/,
    "deleting an offer letter must never delete the candidate — on delete set null, never cascade",
  );
  assert.ok(
    !/add column[^\n]*candidate_id/.test(migration),
    "the migration must never add a candidate column to offers — that is the reverted design",
  );

  // ── 3 · mapCandidate reads it, so every screen fed by a candidate row can see it ────────────────
  const mapped = mapCandidate({ id: "c-1", offer_id: "offer-9" });
  assert.equal(mapped.offerId, "offer-9", "mapCandidate must expose the pointer as offerId");
  assert.equal(
    mapCandidate({ id: "c-2" }).offerId,
    null,
    "no pointer reads as null — which is where every candidate starts and where most stay",
  );

  // The slim pool read has to name it too. A column mapped in db.ts but missing from that list fails
  // SILENTLY — mapCandidate reads undefined, maps it to null, and the field is quietly blank on every
  // screen fed by the slim read. `tests/recruitment-screening-page.test.ts` re-derives the whole list;
  // this is the one column of it that decides a first working day.
  const candidatesSource = read("src/lib/recruitment/candidates.ts");
  const slimList = candidatesSource
    .slice(candidatesSource.indexOf("CANDIDATE_COLUMNS_WITHOUT_REPEATING_BLOCKS ="))
    .split(";")[0];
  assert.ok(
    /[",]offer_id[",]/.test(slimList),
    "the slim candidate read must name offer_id, or the pointer is blank on every screening screen",
  );

  // ── 4 · A merge carries the pointer, and never overwrites one ──────────────────────────────────
  //
  // This is the case that loses real data without it: the duplicate row is DELETED in step 6 of the
  // merge, and an offer letter is joined to a person by this pointer and by nothing else. Every other
  // borrowed field is also written on the CV and could be re-read from the document; this one cannot.
  const field = mergeableFields.find((entry) => entry.column === "offer_id");
  assert.ok(field, "offer_id must be a mergeable field — without it a merge silently strands a letter");
  assert.equal(field?.key, "offerId", "the mergeable field must read the mapped Candidate key");

  const borrowed = borrowableFields({ id: "survivor" }, { id: "duplicate", offerId: "offer-9" });
  assert.deepEqual(
    borrowed.filter((entry) => entry.column === "offer_id").map((entry) => entry.value),
    ["offer-9"],
    "a survivor with no offer must inherit the duplicate's",
  );
  assert.match(
    describeBorrowedFields(borrowed),
    /job offer letter/,
    "the recruiter has to be told the offer came across — it is the one borrowed field they may need to act on",
  );

  const collision = borrowableFields(
    { id: "survivor", offerId: "offer-1" },
    { id: "duplicate", offerId: "offer-2" },
  );
  assert.equal(
    collision.filter((entry) => entry.column === "offer_id").length,
    0,
    "a survivor that already points at a letter must keep its own — two different live offers on one "
      + "person is a thing only a human can resolve",
  );

  // …and that skip is SAID OUT LOUD, unlike every other skipped field. The letter survives in Offers
  // but nothing points at it from the ATS any more, and a recruiter who is not told cannot know to
  // look. Asserted on the source because `buildSummary` is private to the service.
  const mergeService = read("src/lib/recruitment/candidate-merge-service.ts");
  assert.match(
    mergeService,
    /const strandedOffer =\s*\n?\s*Boolean\(duplicate\.offerId\) && Boolean\(survivor\.offerId\) && duplicate\.offerId !== survivor\.offerId;/,
    "the merge must detect two DIFFERENT offer letters — the same letter on both rows is not a collision",
  );
  assert.match(
    mergeService,
    /pointed at a DIFFERENT job offer letter/,
    "the merge summary must say a letter was left disconnected, or a partial merge reads as a clean one",
  );

  // ── 5 · The reader prefers the candidate's own pointer ─────────────────────────────────────────
  //
  // Order matters and is the whole reason the column exists: the application pointer cannot answer
  // for the 27-against-15 majority that has no application at all.
  const contextSrc = read("src/lib/recruitment/whatsapp-templates/candidate-context.ts");
  const resolver = contextSrc.match(/async function resolveOfferStartDate[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(resolver.length > 0, "the start-date resolver must still be here — re-point this test if it moved");
  assert.match(
    resolver,
    /candidateOfferId\(candidateId\)\) \?\? \(await applicationOfferId\(candidateId\)/,
    "the candidate's own pointer is read first, and the application pointer is the fallback",
  );
  for (const forbidden of ["candidate_name", "candidate_email", "ilike"]) {
    assert.ok(
      !resolver.includes(forbidden),
      `the resolver must never match an offer by ${forbidden} — free-text matching put the wrong start `
        + "date in reach — and the address on a letter can be the SENDER'S: the owner's own inbox is "
        + "the recipient on six of production's 27 letters (his ruling, 2026-09-28)",
    );
  }
  assert.match(
    contextSrc,
    /\.from\("ats_candidates"\)\s*\.select\("offer_id"\)/,
    "the candidate pointer must be read from ats_candidates.offer_id",
  );

  // ── 5b · A DEAD LETTER GIVES NO START DATE ─────────────────────────────────────────────────────
  //
  // 🔒 THE OWNER'S RULING, 2026-09-28: "exclude declined and withdrawn letters from the start date".
  //
  // The live case that produced it: Yasmeen Adel's only letter reads `declined` and still carries
  // 01 October 2026, and her candidate row was wired to it the same night. Before this rule a template
  // aimed at her filled in a first working day from an offer she had turned down.
  //
  // `draft` and `sent` still count, deliberately — a recruiter sends the document request on a verbal
  // yes while the letter still reads `sent`, and narrowing this to `accepted` would make the ordinary
  // case ask for a date already agreed and on file.
  const expectedByStatus: Record<string, boolean> = {
    accepted: true,
    declined: false,
    draft: true,
    sent: true,
    withdrawn: false,
  };
  for (const [status, allowed] of Object.entries(expectedByStatus)) {
    assert.equal(
      offerCanGiveAStartDate(status),
      allowed,
      `a ${status} letter must ${allowed ? "still give" : "NEVER give"} its start date`,
    );
  }
  // Stored values are read back as text, so the check must not depend on their shape.
  assert.equal(offerCanGiveAStartDate(" Declined "), false, "the check must survive case and padding");
  assert.equal(offerCanGiveAStartDate(""), true, "an unknown state is not a reason to withhold a date");

  // EVERY status the offers module defines is answered for. A sixth one added later — "expired",
  // "cancelled" — would otherwise silently default to handing over its date, which is the same defect
  // this rule exists to close, one status along.
  const offerStatusUnion = read("src/lib/offers/types.ts").match(/export type OfferStatus =([^;]+);/)?.[1] ?? "";
  const declaredStatuses = [...offerStatusUnion.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
  assert.ok(declaredStatuses.length >= 5, "OfferStatus must still be a string union — re-point this test if it moved");
  assert.deepEqual(
    declaredStatuses.filter((status) => !(status in expectedByStatus)),
    [],
    "every OfferStatus needs an explicit answer here — a new one must not inherit 'hand over the date'",
  );

  assert.match(
    resolver,
    /if \(!offerCanGiveAStartDate\(offer\.status\)\) return "";/,
    "the resolver must apply the ruling, and before it reads the date",
  );
  // ── 6 · Both writers, and what each one is allowed to do ───────────────────────────────────────
  //
  // The bridge stamps the person as well as the application, so the two pointers cannot disagree
  // about a letter that does have an application. It writes OVER whatever was there, because reaching
  // it means a recruiter has just produced this letter for this person.
  const applicationsSrc = read("src/lib/recruitment/applications.ts");
  const bridge = applicationsSrc.match(/export async function recordApplicationOfferLetter[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(bridge.length > 0, "the offer-letter bridge must still be here — re-point this test if it moved");
  assert.match(
    bridge,
    /\.from\("ats_candidates"\)[\s\S]*?offer_id: offerLetterId/,
    "the bridge must stamp the pointer on the PERSON too, not only on the application",
  );
  assert.match(
    bridge,
    /\.select\("candidate_id"\)/,
    "the person is read back from the application row just updated — a passed-in id could stamp the "
      + "pointer onto somebody the application does not name",
  );

  // The human writer, for a letter with no application. It CONFIRMS the id against the offers module
  // before storing it: a uuid one character wrong points a candidate at somebody else's letter, and
  // that letter's start date is what reaches a new hire as the day they are expected at work.
  const writerSrc = read("src/lib/recruitment/candidate-offer-link.ts");
  assert.match(
    writerSrc,
    /from "@\/lib\/offers\/service"/,
    "the writer reads through the offers module's own service — recruitment -> offers, the one permitted direction",
  );
  const setter = writerSrc.match(/export async function setCandidateOfferLetter[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(setter.length > 0, "setCandidateOfferLetter must still be here — re-point this test if it moved");
  assert.ok(
    setter.indexOf("await getOffer(") < setter.indexOf('.from("ats_candidates")'),
    "the letter must be confirmed to exist BEFORE the pointer is stored",
  );
  assert.match(
    setter,
    /if \(isOfferNotFound\(error\)\) throw new Error/,
    "an id that names no letter is refused in words, never stored as a pointer to nothing",
  );
  // THE POINTER IS UNTOUCHED BY THE START-DATE RULING above. A declined letter stays linked to the
  // person it was written for — that is history and it is true — and only the DATE is withheld.
  assert.ok(
    !/status/.test(setter),
    "the writer must not filter on a letter's status: the link is history, the date is the judgement",
  );
  // …and it never looks a letter up by anything a human typed. Asserted on the QUERY rather than the
  // file, because the file's own comment names both columns to say it must not use them.
  assert.ok(
    !/\.(eq|ilike|or)\((\s*)"candidate_(name|email)"/.test(writerSrc),
    "the writer must never resolve a letter by the name or e-mail printed on it — the recipient "
      + "address can be the SENDER'S, and the owner's own inbox is on six of production's 27 letters",
  );

  // ── 6b · The record SHOWS the letter, and showing it carries no money and no leak ──────────────
  //
  // Until this row the pointer existed and no human could see it. Two things had to be true for it to
  // be safe to show: `candidates: read` is a WIDER set of seats than `offers: read`, and an offer
  // letter is where the salary lives.
  const linkSrc = read("src/lib/recruitment/candidate-offer-link.ts");
  const summary = linkSrc.match(/export type LinkedOfferSummary = \{[\s\S]*?\n\};/)?.[0] ?? "";
  assert.ok(summary.length > 0, "LinkedOfferSummary must still be here — re-point this test if it moved");
  for (const money of ["totalMonthly", "total_monthly", "costOfLiving", "salary"]) {
    assert.ok(
      !summary.includes(money),
      `LinkedOfferSummary must never carry ${money} — it is rendered on a record that every seat which `
        + "can read the pool can open, and the letter is where the salary lives",
    );
  }

  // The loader asks the offers module ONLY when the caller says the viewer may see letters, and the
  // default is off, so a caller that has not thought about it shows nothing rather than leaking.
  const recordSrc = read("src/lib/recruitment/candidate-record.ts");
  assert.match(
    recordSrc,
    /options: \{ withOffer\?: boolean \} = \{\}/,
    "the offer read is opt-in with an off default — a caller that forgets must leak nothing",
  );
  assert.match(
    recordSrc,
    /options\.withOffer\s*\n?\s*\? settle<LinkedOfferSummary \| null>\("offer", linkedOfferFor\(profile\.candidate\), null\)\s*\n?\s*: Promise\.resolve\(null\)/,
    "the false branch must not ask the offers module anything at all",
  );

  // BOTH pages ask the permission question separately from "may they open the record".
  for (const page of [
    "app/(admin)/recruitment/candidate/[id]/page.tsx",
    "app/employee-portals/recruitment/candidate/[id]/page.tsx",
  ]) {
    assert.match(
      read(page),
      /withOffer: await canAccess\(access, "offers", "read"\)/,
      `${page} must gate the offer letter on offers: read, not on candidates: read`,
    );
  }

  // And the row itself renders the SAME wording for "not allowed to see it" as for "has none" — a row
  // reading "hidden" would tell a reader that an offer exists, which is half the leak.
  const recordPage = read("src/components/recruitment/candidate-record-page.tsx");
  assert.match(recordPage, /label="Job offer"/, "the record must show the letter it points at");
  assert.match(recordPage, /No offer letter/, "no letter and no permission read the same");
  // Sliced FORWARD from the label so the row's own explanatory comment — which has to use the word
  // "hidden" to explain why nothing is — cannot satisfy or break this.
  const rowStart = recordPage.indexOf('label="Job offer"');
  const rowBlock = recordPage.slice(rowStart, recordPage.indexOf("</KeyValue>", rowStart));
  assert.ok(
    !/hidden|withheld|not permitted|no access|restricted/i.test(rowBlock),
    `the row must never say a letter is being withheld — that tells a reader one exists. Found: ${rowBlock}`,
  );
  assert.ok(
    rowBlock.includes("No offer letter") && rowBlock.includes("Could not be read"),
    "the row has exactly two fallbacks: nothing on file, and could not be read",
  );

  // ── 6c · The rule is READ by the screen, not copied — and reading it must not ship the server ───
  //
  // The record page prints "Declined" without a start date for the same reason the send screen sends
  // none, so both must read ONE rule. The trap is where that rule lives: `candidate-context.ts`
  // imports the database client and the offers service (server-only, service-role credential), and the
  // record page is a CLIENT component — importing the rule from there pulls all of it into the browser
  // bundle. Hence a module of its own that may import NOTHING.
  const ruleSrc = read("src/lib/recruitment/offer-start-date-rule.ts");
  assert.ok(
    !/^\s*import\s/m.test(ruleSrc),
    "offer-start-date-rule.ts must import nothing at all — it is read by a client component",
  );
  assert.match(
    recordPage,
    /import \{ offerCanGiveAStartDate \} from "@\/lib\/recruitment\/offer-start-date-rule"/,
    "the record page reads the rule from the standalone module, never from candidate-context",
  );
  assert.ok(
    !/from "@\/lib\/recruitment\/whatsapp-templates\/candidate-context"/.test(recordPage),
    "the record page must never import candidate-context — that module reaches the database",
  );
  assert.ok(
    !/OFFER_STATUSES_WITH_NO_START_DATE|"withdrawn"/.test(recordPage),
    "the record page must not carry its own copy of the status list",
  );
  assert.match(
    recordPage,
    /if \(!offer\.startDate \|\| !offerCanGiveAStartDate\(offer\.status\)\) return standing;/,
    "a dead letter shows its state on the record and withholds only its day",
  );

  // ── 6d · Every `Record<CandidateRecordPart, …>` names every part ────────────────────────────────
  //
  // 🔴 THIS IS THE ONE THAT COST TWO CI CYCLES. Adding a part to `CandidateRecordPart` breaks every
  // exhaustive map of it, and the maps are in files nobody editing the loader would think to open —
  // the print builder's copy was missed here, a whole-Candidate fixture was missed the night before,
  // and BOTH were found only by tsc in CI, three minutes and ~14 billable minutes per round trip. A
  // local typecheck is denied on this machine, so this stands in for it on the one union that keeps
  // growing. It reads the members from the source rather than listing them, so a part added later is
  // covered without touching this test.
  const partUnion = recordSrc.match(/export type CandidateRecordPart =([^;]+);/)?.[1] ?? "";
  const parts = [...partUnion.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
  assert.ok(parts.length >= 6, "CandidateRecordPart must still be a string union — re-point this test if it moved");
  for (const file of [
    "src/components/recruitment/candidate-record-page.tsx",
    "src/lib/recruitment/candidate-record-print.ts",
  ]) {
    const src = read(file);
    const map = src.match(/Record<CandidateRecordPart, string> = \{[\s\S]*?\n\};/)?.[0] ?? "";
    assert.ok(map.length > 0, `${file} must still hold a Record<CandidateRecordPart, string> — re-point this test`);
    const missing = parts.filter((part) => !new RegExp(`^\\s*${part}:`, "m").test(map));
    assert.deepEqual(missing, [], `${file} must name every part — missing: ${missing.join(", ")}`);
  }

  // ── 7 · The route that records a human's answer is gated as an UPDATE ──────────────────────────
  const routeSrc = read("app/api/recruitment/candidates/[id]/offer-letter/route.ts");
  assert.match(
    routeSrc,
    /requireRecruitmentAccess\(request, "candidates", "update"\)/,
    "linking an offer changes what the send screen fills in for a person — it is not a read",
  );
  assert.match(
    routeSrc,
    /assertSameOriginMutation\(request\)/,
    "every recruitment mutation carries the same-origin check",
  );
  assert.match(
    routeSrc,
    /str\(body\.offerId\) \|\| null/,
    "a blank must CLEAR the pointer — correcting a wrong link has to be as easy as making one",
  );
}
