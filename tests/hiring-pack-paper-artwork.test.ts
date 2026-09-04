import assert from "node:assert/strict";

import { inlineLocalAssets } from "@/lib/hiring-pack/paper-artwork";

// The scanned artwork a filed paper sits on.
//
// WHAT THIS IS GUARDING IS A SILENT WRONG DOCUMENT, not a crash. Four of the seven fileable papers
// are values placed over a scan. Chromium is handed the HTML through `setContent`, which gives the
// page no origin, so a root-relative `/forms/…` resolves to nothing — and Form 1 would render as
// correctly-placed values floating on a blank white page, then be filed under a slot called
// "Social insurance form" as the document the employee signed. It would look like a rendering
// glitch to anybody who opened it and like nothing at all to anybody who did not.
//
// So the two properties worth pinning are: a real asset becomes bytes, and anything that does not
// is REPORTED rather than skipped. The caller refuses to file on a non-empty `missing`.

/**
 * A real Phoenix asset is read off disk and embedded, so the PDF carries the artwork rather than a
 * reference to a server it will never reach.
 */
function testRealArtworkIsEmbeddedAsBytes() {
  const html = '<img src="/forms/social-insurance-form1-page1.svg" alt="" />';
  const result = inlineLocalAssets(html);

  assert.deepEqual(result.missing, [], "a shipped form asset resolves");
  assert.match(result.html, /src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"/);
  assert.equal(
    result.html.includes("/forms/social-insurance-form1-page1.svg"),
    false,
    "and the unreachable path is gone, not merely accompanied",
  );

  // The two logos are different files and neither is a fallback for the other: the plain one draws
  // SATO in white, which is invisible on paper.
  const light = inlineLocalAssets('<img src="/brand/sato-pharma-logo-on-light.png" />');
  assert.deepEqual(light.missing, []);
  assert.match(light.html, /src="data:image\/png;base64,/);
}

/**
 * THE ONE THAT MATTERS. An asset that cannot be read comes back named, and the HTML is left with
 * its original src rather than a broken data URI — so the caller can refuse, and whoever reads the
 * refusal learns which file to go and look at.
 */
function testAnUnreadableAssetIsReportedRatherThanSkipped() {
  const html = '<img src="/forms/a-form-nobody-shipped.svg" alt="" />';
  const result = inlineLocalAssets(html);

  assert.deepEqual(
    result.missing,
    ["/forms/a-form-nobody-shipped.svg"],
    "the missing file is named, not counted",
  );
  assert.equal(result.html, html, "and nothing was rewritten to a URI that resolves to nothing");
}

/**
 * The switch is the allow-list as well as the tracer's evidence: a path outside `/forms` and
 * `/brand` is not rewritten at all, and a traversal dressed up as one of them is reported missing
 * rather than read.
 */
function testOnlyPhoenixArtworkPathsAreTouched() {
  const external = '<img src="https://example.com/logo.png" /><img src="/_next/static/x.png" />';
  const untouched = inlineLocalAssets(external);
  assert.equal(untouched.html, external, "anything outside the two directories passes through");
  assert.deepEqual(untouched.missing, []);

  const traversal = inlineLocalAssets('<img src="/forms/../../.env.local" />');
  assert.deepEqual(traversal.missing, ["/forms/../../.env.local"], "not on the list, so not read");
  assert.equal(traversal.html.includes("data:"), false);
}

/**
 * A three-copy Form 1 names the same two files six times, and every occurrence has to be rewritten
 * — one substitution with five references left pointing at nothing would file five blank pages.
 */
function testEveryOccurrenceIsRewrittenNotJustTheFirst() {
  const page = '<img src="/forms/social-insurance-form1-page1.svg" />';
  const result = inlineLocalAssets(`${page}${page}${page}`);

  assert.deepEqual(result.missing, []);
  const embedded = result.html.match(/data:image\/svg\+xml;base64,/g) ?? [];
  assert.equal(embedded.length, 3, "all three copies carry the artwork");
  assert.equal(result.html.includes('src="/forms/'), false);
}

/**
 * A paper that draws no artwork at all passes through byte-for-byte. The contract and the two
 * clearances are typeset, and rewriting nothing is the correct answer for them — a document that
 * came back changed here would mean this touched something it was not asked to.
 */
function testATypesetPaperIsUnchanged() {
  const html = "<html><body><p>Employment contract, article 19.</p></body></html>";
  const result = inlineLocalAssets(html);
  assert.equal(result.html, html);
  assert.deepEqual(result.missing, []);
}

export async function runHiringPackPaperArtworkTests() {
  testRealArtworkIsEmbeddedAsBytes();
  testAnUnreadableAssetIsReportedRatherThanSkipped();
  testOnlyPhoenixArtworkPathsAreTouched();
  testEveryOccurrenceIsRewrittenNotJustTheFirst();
  testATypesetPaperIsUnchanged();
}
