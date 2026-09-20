import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { awardChequeDocumentHtml } from "../src/lib/spotlight/award-cheque.ts";
import {
  CHEQUE_MAX_PER_REQUEST,
  ChequeRequestError,
  blankChequeInput,
  parseChequeAmount,
  parseChequeInput,
  parseChequeRequest,
} from "../src/lib/spotlight/cheque-request.ts";

// Award cheque generator - what the form may type and what the sheet prints.
//
// A cheque states one amount three times (figures, Arabic words, machine line) and is handed to a
// person as a finished document, so the two things that must hold are: (1) the text the form sends is
// read one way, strictly, and an unreadable amount is refused rather than coerced into a different one;
// (2) every typed field reaches the sheet - piastres included - and the parts that used to be fixed
// for the Semester Achievers run (the edge text, the rank/achievement pair, the signatory) now follow
// what was typed. The routes' access gate is pinned from source below.

function throwsRequestError(fn: () => unknown, pattern: RegExp, message: string) {
  assert.throws(fn, (error: unknown) => error instanceof ChequeRequestError && pattern.test(error.message), message);
}

const filled = blankChequeInput({
  recipientName: "  Ahmed   Hamdan Ahmed ",
  positionTitle: "Senior Medical Representative",
  awardTitle: "Performance bonus - Q3 2026",
  amount: "12,500.50",
  transferDate: "2026-09-25",
});

export function runSpotlightChequeGeneratorTests() {
  // ---- the amount ------------------------------------------------------------------------------------
  assert.equal(parseChequeAmount("12,500.50"), 12500.5, "thousands separators and piastres are read");
  assert.equal(parseChequeAmount("١٢٬٥٠٠٫٥٠"), 12500.5, "Arabic-Indic digits and marks read the same as Latin ones");
  assert.equal(parseChequeAmount(" EGP 3000 "), 3000, "a leading currency word is tolerated");
  assert.equal(parseChequeAmount(""), null, "empty is 'no amount', never zero");
  assert.equal(parseChequeAmount(null), null);
  for (const bad of ["12.345", "-5", "abc", "1e6", "12,5,0.0.0"]) {
    throwsRequestError(() => parseChequeAmount(bad), /amount/, `"${bad}" must be refused, not coerced`);
  }
  throwsRequestError(() => parseChequeAmount("1000000000"), /above/, "an amount the words cannot spell is refused");

  // ---- one cheque ------------------------------------------------------------------------------------
  const strict = parseChequeInput(filled, 0, true);
  assert.equal(strict.recipientName, "Ahmed Hamdan Ahmed", "whitespace is collapsed");
  assert.equal(strict.amountEgp, 12500.5);
  assert.equal(strict.serial, "000001", "a blank cheque number falls back to the position in the run");
  assert.equal(strict.transferDate, "2026-09-25");
  assert.equal(strict.signed, true, "the signature prints unless it is switched off");
  assert.equal("ceoSignatureUri" in strict, false, "a request can never carry its own signature image");
  assert.equal(
    (parseChequeInput({ ...filled, ceoSignatureUri: "data:image/png;base64,AAAA" }, 0, true) as Record<string, unknown>)
      .ceoSignatureUri,
    undefined,
    "a signature smuggled into the request is dropped",
  );

  throwsRequestError(() => parseChequeInput({ ...filled, recipientName: "" }, 2, true), /^Cheque 3: .*paid to/, "a PDF needs a payee, and says which cheque");
  throwsRequestError(() => parseChequeInput({ ...filled, amount: "" }, 0, true), /amount is missing/, "a PDF needs an amount");
  throwsRequestError(() => parseChequeInput({ ...filled, amount: "0" }, 0, true), /amount is missing/, "zero is not an amount");
  throwsRequestError(() => parseChequeInput({ ...filled, awardTitle: "" }, 0, true), /"For" line/, "a PDF needs a memo or a rank/achievement");
  assert.equal(parseChequeInput({ ...filled, awardTitle: "", rank: "2" }, 0, true).rank, 2, "a rank stands in for the memo");
  throwsRequestError(() => parseChequeInput({ ...filled, transferDate: "2026-02-31" }, 0, false), /calendar date/, "an impossible day is refused");
  throwsRequestError(() => parseChequeInput({ ...filled, rank: "0" }, 0, false), /rank/, "rank starts at 1");
  throwsRequestError(() => parseChequeInput({ ...filled, achievementPct: "abc" }, 0, false), /achievement/, "achievement is a number");
  assert.equal(parseChequeInput({ ...filled, achievementPct: "112.4%" }, 0, false).achievementPct, 112.4, "a trailing % is tolerated");

  const draft = parseChequeInput(blankChequeInput(), 0, false);
  assert.equal(draft.amountEgp, null, "a half-typed cheque previews with an empty amount box, never EGP 0");
  assert.match(draft.recipientName, /RECIPIENT NAME/, "a half-typed cheque previews with placeholders");

  // ---- the request -----------------------------------------------------------------------------------
  throwsRequestError(() => parseChequeRequest({ cheques: [] }), /at least one/, "an empty run is refused");
  throwsRequestError(
    () => parseChequeRequest({ cheques: Array.from({ length: CHEQUE_MAX_PER_REQUEST + 1 }, () => filled) }),
    /At most/,
    "a run has a ceiling",
  );
  throwsRequestError(() => parseChequeRequest({ cheques: [filled], format: "docx" }), /format/, "an unknown format is refused");
  const preview = parseChequeRequest({ cheques: [blankChequeInput(), filled], format: "html", index: 1 });
  assert.equal(preview.rows.length, 1, "a preview reads only the cheque being drawn, so a half-typed neighbour never blocks it");
  assert.equal(preview.rows[0].amountEgp, 12500.5);
  assert.equal(parseChequeRequest({ cheques: [filled, filled] }).rows.length, 2, "a PDF carries the whole run");

  // ---- the sheet -------------------------------------------------------------------------------------
  const html = awardChequeDocumentHtml(strict);
  assert.match(html, /12,500<small>\.50<\/small>/, "piastres print in the figures box");
  assert.match(html, /قرش/, "piastres are spelled in the Arabic words");
  assert.match(html, /0001250050/, "the machine line carries the same cents");
  assert.match(awardChequeDocumentHtml({ ...strict, amountEgp: 1500 }), /1,500<small>\.00<\/small>/, "a whole-pound amount still prints .00");
  assert.match(html, /Ahmed Hamdan Ahmed/);
  assert.match(html, /Performance bonus - Q3 2026/, "the memo line prints when there is no rank or achievement");
  assert.doesNotMatch(html, /class="stat stat--rank"/, "no rank box without a rank");
  assert.doesNotMatch(html, /class="stat stat--wide"/, "no achievement box without an achievement");

  const rankOnly = awardChequeDocumentHtml({ ...strict, rank: 1 });
  assert.match(rankOnly, /class="stat stat--rank"/, "a rank alone draws the rank box");
  assert.doesNotMatch(rankOnly, /class="stat stat--wide"/, "and no empty achievement box beside it");
  const both = awardChequeDocumentHtml({ ...strict, rank: 3, achievementPct: 118.25 });
  assert.match(both, /118\.3<small>%<\/small>/, "achievement prints to one decimal");
  assert.match(both, /3<small>rd<\/small>/, "the rank carries its ordinal");

  const bonus = awardChequeDocumentHtml({ ...strict, programName: "Ramadan Bonus 2027", signerTitle: "Managing Director", signerTitleAr: "المدير العام" });
  assert.match(bonus, /RAMADAN BONUS 2027/, "the edge text follows the programme that was typed");
  assert.doesNotMatch(bonus, /SEMESTER ACHIEVERS/, "and nothing of the Semester Achievers run is left in a bonus cheque");
  assert.match(bonus, /Managing Director/, "the signatory line follows what was typed");
  assert.match(bonus, /المدير العام/);
  assert.doesNotMatch(bonus, /Chief Executive Officer/, "the CEO caption is a default, not a fixture");
  assert.match(html, /Chief Executive Officer/, "and it is still the default");
  assert.match(awardChequeDocumentHtml({ ...strict, programName: "Semester Achievers Award — S1 2026" }), /SEMESTER ACHIEVERS AWARD · S1 2026/, "the original edge text is unchanged");

  const hostile = awardChequeDocumentHtml({ ...strict, recipientName: "<script>alert(1)</script>", positionTitle: "<b>x</b>", awardTitle: "<img src=x>" });
  assert.doesNotMatch(hostile, /<script>alert\(1\)/, "a typed name cannot inject markup into the sheet");
  assert.doesNotMatch(hostile, /<img src=x>/);

  // ---- the routes: the gate is on the server, and a signature is never client-supplied ------------------
  const cheques = readFileSync("app/api/spotlight/cheques/route.ts", "utf8");
  const signature = readFileSync("app/api/spotlight/cheques/signature/route.ts", "utf8");
  const page = readFileSync("app/(admin)/spotlight/cheques/page.tsx", "utf8");
  assert.match(cheques, /assertPermission\(access, "spotlight", "export"\)/, "the cheque route asserts spotlight:export");
  assert.ok(
    cheques.indexOf("assertPermission(") < cheques.indexOf("parseChequeRequest("),
    "the gate runs before the request is even read",
  );
  assert.match(cheques, /loadChequeSignatureUri\(\)/, "the signature is read on the server, from its private store");
  assert.match(cheques, /assertExportRateLimit/, "the PDF is rate limited");
  assert.equal((signature.match(/assertPermission\(access, "spotlight", "export"\)/g) ?? []).length, 1, "the signature route has one shared gate");
  assert.equal((signature.match(/await gate\(request\)/g) ?? []).length, 3, "GET, PUT and DELETE all pass through it");
  assert.equal((signature.match(/assertSameOriginMutation\(request\)/g) ?? []).length, 2, "the two mutating verbs check the origin");
  assert.match(page, /assertPermission\(access, "spotlight", "export"\)/, "the page redirects anyone without the permission");
  const store = readFileSync("src/lib/spotlight/cheque-signature.ts", "utf8");
  assert.match(store, /public: false/, "the signature bucket is private");
}
