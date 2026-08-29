import { strict as assert } from "node:assert";

import { OFFER_BUILTIN_TEMPLATES } from "../src/lib/offers/builtin-templates.ts";
import { renderOfferEmail } from "../src/lib/offers/render-email.ts";
import { renderOfferBlock, buildOfferTokens } from "../src/lib/offers/render.ts";
import {
  OFFER_PROSE_BLOCK_TAGS,
  OFFER_PROSE_INLINE_TAGS,
  offerEditorToStoredHtml,
  offerProseIsEmpty,
  offerStoredToEditorHtml,
  offerTokenChipHtml,
} from "../src/lib/offers/rich-text.ts";
import type { OfferBlock, OfferFields } from "../src/lib/offers/types.ts";

/**
 * The letter's prose is now typed on a canvas rather than written as HTML in a textarea, and this
 * pins the boundary that makes that safe.
 *
 * Three different things can go wrong here and none of them is visible on the screen where the
 * mistake is made:
 *
 *   - a ROUND TRIP that is not lossless silently rewrites a letter every time somebody opens the
 *     block and clicks away. The greeting's `class="lead"` is the sharp case: a generic sanitiser
 *     strips `class`, both stylesheets size the greeting from it, and the letter simply reflows
 *     one day with nobody having edited anything.
 *   - a token turned into a CHIP inside an attribute breaks the attribute, and a chip that fails
 *     to turn back into a token puts the literal word "Name in the greeting" on a signed offer.
 *   - a tag the canvas can PRODUCE but the email renderer drops prints on the attached PDF and
 *     goes missing from the email body — so the letter a candidate reads differs from the one they
 *     sign, and nothing anywhere reports it.
 */
export function runOfferRichTextTests() {
  const LABELS = new Map([
    ["salutationName", "Name in the greeting"],
    ["title", "Job title"],
  ]);

  const SAMPLE: OfferFields = {
    candidateEmail: "samaa.shalaby@example.com",
    candidateName: "SAMAA SHALABY",
    contractTerm: "One year, renewable",
    costOfLiving: 3500,
    dateOfIssue: "27 August 2026",
    reference: "SP-HR-DSM-2026-019",
    reportsTo: "National Sales Manager",
    salutationName: "Dr SAMAA SHALABY",
    startDate: "1 September 2026",
    territory: "Delta (3)",
    title: "District Sales Manager",
    totalMonthly: 30000,
    validUntil: "3 September 2026",
  };

  // ── The round trip is lossless for what the shipped letters actually contain ────────────────
  {
    const greeting = "<p class=\"lead\">Dear <strong>{{salutationName}}</strong>,</p>";
    const editor = offerStoredToEditorHtml(greeting, LABELS);

    assert.ok(
      editor.includes("Name in the greeting"),
      "the placeholder should read as its friendly label on the canvas, not as {{salutationName}}",
    );
    assert.ok(!editor.includes("{{salutationName}}"), "the raw token should not remain on the canvas");
    assert.equal(
      offerEditorToStoredHtml(editor),
      greeting,
      "stored → canvas → stored must return the letter unchanged, class and all",
    );
  }

  {
    // `class` is load-bearing, and it is the first thing a generic HTML sanitiser removes.
    const stored = offerEditorToStoredHtml('<p class="lead">Dear Samaa,</p>');
    assert.ok(stored.includes('class="lead"'), "the greeting's own class must survive the round trip");
  }

  {
    // The shipped templates are the real regression surface: whatever they hold today has to come
    // back byte-identical, or opening a built-in and closing it again quietly edits it.
    for (const builtin of OFFER_BUILTIN_TEMPLATES) {
      for (const block of builtin.blocks()) {
        if (block.type !== "text") continue;
        const html = String(block.props.html ?? "");
        // Entities are what a canvas cannot preserve — it decodes them to real characters. So the
        // comparison is made on the decoded form, which is what the letter has always rendered.
        const decoded = html
          .replace(/&rsquo;/g, "’")
          .replace(/&mdash;/g, "—")
          .replace(/'/g, '"');
        const back = offerEditorToStoredHtml(offerStoredToEditorHtml(decoded, LABELS));
        assert.equal(back, decoded, `${builtin.key}: a shipped paragraph block changed on round trip`);
      }
    }
  }

  // ── A token inside an ATTRIBUTE is not prose ────────────────────────────────────────────────
  {
    const stored = '<p>See <a href="https://x.test/{{reference}}">the offer</a>.</p>';
    const editor = offerStoredToEditorHtml(stored, LABELS);
    assert.ok(
      editor.includes("https://x.test/{{reference}}"),
      "a token inside an attribute must be left alone — chipping it would break the attribute",
    );
  }

  // ── Chips collapse back, whole ──────────────────────────────────────────────────────────────
  {
    const chip = offerTokenChipHtml("title", "Job title");
    assert.equal(
      offerEditorToStoredHtml(`<p>the ${chip} role</p>`),
      "<p>the {{title}} role</p>",
      "a chip must collapse to its token and take its label text with it",
    );
  }

  // ── Browser markup is normalised ────────────────────────────────────────────────────────────
  {
    assert.equal(
      offerEditorToStoredHtml("<div>Text with <b>bold</b> and <i>italic</i>.</div>"),
      "<p>Text with <strong>bold</strong> and <em>italic</em>.</p>",
      "the tags a browser emits should be stored as the ones both renderers draw",
    );
  }

  // ── A tag the letter cannot draw loses the tag, never the words ─────────────────────────────
  {
    const stored = offerEditorToStoredHtml("<p>Keep <h2>every</h2> <table><tr><td>word</td></tr></table></p>");
    for (const word of ["Keep", "every", "word"]) {
      assert.ok(stored.includes(word), `"${word}" was lost — an unsupported tag must be unwrapped, not deleted`);
    }
    assert.ok(!stored.includes("<h2"), "an unsupported tag should not reach storage");
    assert.ok(!stored.includes("<table"), "an unsupported tag should not reach storage");
  }

  {
    // Unwrapping an opener leaves its partner behind. An orphan `</span>` in the stored letter is
    // markup nobody typed, and it is exactly what makes a Source view unreadable.
    const stored = offerEditorToStoredHtml("<p>a <span>b</span> c</p>");
    assert.ok(!stored.includes("</span>"), `an orphaned closing tag reached storage: ${stored}`);
    assert.ok(stored.includes("a b c") || stored.includes("a  b  c"), `the words changed: ${stored}`);
  }

  // ── Links and colour ────────────────────────────────────────────────────────────────────────
  {
    assert.ok(
      offerEditorToStoredHtml('<p><a href="https://sato.test">go</a></p>').includes('href="https://sato.test"'),
      "an https link should be kept",
    );
    assert.ok(
      offerEditorToStoredHtml('<p><a href="mailto:hr@sato.test">mail</a></p>').includes("mailto:hr@sato.test"),
      "a mailto link should be kept",
    );
    const dangerous = offerEditorToStoredHtml('<p><a href="javascript:alert(1)">click</a></p>');
    assert.ok(!dangerous.includes("javascript:"), "a script link must not be stored");
    assert.ok(dangerous.includes("click"), "losing the link must not lose the words");
  }

  {
    // Kept as WRITTEN, spacing and all — normalising would make the round trip lossy for every
    // template already in the field, which is the same silent rewrite as dropping it.
    const coloured = offerEditorToStoredHtml('<p><span style="color: #B45309">warm</span></p>');
    assert.match(coloured, /color:\s*#B45309/i, "a colour a person chose should be kept");
    assert.ok(
      offerEditorToStoredHtml('<p style="margin-top:12px">spaced</p>').includes("margin-top:12px"),
      "a paragraph's own spacing must survive — the shipped classic letter relies on it",
    );
    // The colour is re-emitted inside a `style` attribute, so it must not be able to close it.
    const injected = offerEditorToStoredHtml('<p><span style="color: red&quot; onload=&quot;x">t</span></p>');
    assert.ok(!injected.includes("onload"), `a colour must not be able to smuggle another attribute: ${injected}`);
  }

  // ── Emptiness ───────────────────────────────────────────────────────────────────────────────
  {
    assert.equal(offerProseIsEmpty("<p><br></p>"), true, "what a browser leaves after Select-All + Delete is empty");
    assert.equal(offerProseIsEmpty("<p>&nbsp;</p>"), true, "a non-breaking space alone is empty");
    assert.equal(offerProseIsEmpty("<p>Dear Samaa,</p>"), false, "real writing is not empty");
  }

  // ── THE AGREEMENT: everything the canvas can store must survive BOTH renderers ───────────────
  {
    const prose =
      '<p class="lead">Dear <strong>{{salutationName}}</strong>,</p>' +
      "<p>We are pleased to offer you <em>the</em> <u>role</u>, " +
      '<span style="color:#B45309">effective</span> immediately.<br>Second line.</p>' +
      "<ul><li>First benefit</li><li>Second benefit</li></ul>" +
      "<ol><li>Step one</li><li>Step two</li></ol>" +
      '<p>Reply to <a href="mailto:hr@sato.test">HR</a>.</p>';

    const block: OfferBlock = { id: "prose", props: { html: prose }, type: "text" };
    const pdf = renderOfferBlock(block, buildOfferTokens(SAMPLE), {});
    const email = renderOfferEmail({ blocks: [block] }, SAMPLE);

    // Every word reaches both, and the greeting is filled in rather than printed as a token.
    for (const words of ["Dr SAMAA SHALABY", "First benefit", "Second benefit", "Step one", "Step two", "Second line"]) {
      assert.ok(pdf.includes(words), `the PDF lost "${words}"`);
      assert.ok(email.html.includes(words), `the email lost "${words}"`);
      assert.ok(email.text.includes(words), `the plain-text alternative lost "${words}"`);
    }

    // And the FORMATTING reaches the email, which is the half that used to be dropped in silence.
    assert.ok(/<ul[^>]*>/.test(email.html), "a bulleted list must reach the email, not just the PDF");
    assert.ok(/<ol[^>]*>/.test(email.html), "a numbered list must reach the email, not just the PDF");
    assert.ok(email.html.includes("<br>") || email.html.includes("<br/>"), "a line break must reach the email");
    assert.ok(/color:#B45309/i.test(email.html), "a chosen colour must reach the email");
    assert.ok(email.html.includes("<strong>") && email.html.includes("<em>") && email.html.includes("<u>"),
      "emphasis must reach the email");
    assert.ok(email.html.includes("mailto:hr@sato.test"), "a link must reach the email");

    // The plain-text alternative reads as a list rather than as one run-on line.
    assert.ok(/- First benefit/.test(email.text), `bullets should read as bullets in plain text:\n${email.text}`);

    // No tag the canvas cannot produce appears in the stored prose in the first place.
    const allowed = new Set([...OFFER_PROSE_BLOCK_TAGS, ...OFFER_PROSE_INLINE_TAGS]);
    for (const match of offerEditorToStoredHtml(prose).matchAll(/<\/?([a-zA-Z0-9]+)/g)) {
      assert.ok(allowed.has(match[1].toLowerCase()), `${match[1]} is not one of the tags both renderers draw`);
    }
  }

  // ── What a REAL browser actually emits ──────────────────────────────────────────────────────
  {
    /**
     * Captured out of Chrome on 2026-08-29 by driving a `contenteditable` with the same
     * `execCommand` calls the toolbar makes, then reading `innerHTML` back.
     *
     * Hand-written fixtures are the trap here. Every reasonable guess about what Bold produces is
     * wrong in some browser — this one emits `<span style="font-weight: bold;">` rather than
     * `<strong>`, wraps a new list INSIDE the paragraph it came from, and writes colours as
     * `rgb()` rather than as the hex that was asked for. None of that is visible from reading the
     * component, and all of it reaches the stored letter.
     */
    const CHIP =
      '<span class="phx-offer-token" contenteditable="false" data-token="salutationName"' +
      ' title="Filled in from the offer when the letter is sent">Name in the greeting</span>';

    const afterBold =
      `<p class="lead">Dear <strong>${CHIP}</strong>,</p>` +
      '<p><span style="font-weight: bold;">On behalf of Sato Pharmaceuticals.</span></p>';

    const bold = offerEditorToStoredHtml(afterBold);
    assert.ok(bold.includes("{{salutationName}}"), "the chip must come back as its token");
    assert.ok(!bold.includes("phx-offer-token"), "no trace of the chip may reach the stored letter");
    assert.match(bold, /font-weight:\s*bold/, "Bold is a styled span in this browser — it must survive");
    assert.ok(bold.includes('class="lead"'), "the greeting's class must survive a real edit");

    // A list Chrome has nested inside a paragraph. Invalid HTML, and every renderer repairs it
    // differently, so it must not reach storage that way.
    const afterList =
      '<p><ul><li><span style="font-weight: bold;">Medical cover</span></li></ul></p>';
    const listed = offerEditorToStoredHtml(afterList);
    assert.doesNotMatch(listed, /<p[^>]*>\s*<ul/i, `a list must not be stored inside a paragraph: ${listed}`);
    assert.ok(listed.includes("Medical cover"), "unwrapping the paragraph must not lose the bullet");

    // Colour, as the browser writes it rather than as it was asked for.
    const afterColour = '<p><span style="color: rgb(180, 83, 9);">Dear </span></p>';
    assert.match(
      offerEditorToStoredHtml(afterColour),
      /color:\s*rgb\(180,\s*83,\s*9\)/,
      "an rgb() colour must survive — it is what the browser stores, whatever the picker was given",
    );

    // And a `<font>` tag, which is what an engine emits when `styleWithCSS` could not be set.
    assert.match(
      offerEditorToStoredHtml('<p><font color="#b45309">warm</font></p>'),
      /color:#b45309/i,
      "a legacy <font> colour must be carried over rather than dropped with the tag",
    );

    // Everything above still renders in both places.
    const block: OfferBlock = { id: "real", props: { html: bold }, type: "text" };
    assert.ok(
      renderOfferBlock(block, buildOfferTokens(SAMPLE), {}).includes("Dr SAMAA SHALABY"),
      "the PDF must fill the greeting from the real browser's markup",
    );
    assert.ok(
      renderOfferEmail({ blocks: [block] }, SAMPLE).html.includes("Dr SAMAA SHALABY"),
      "the email must fill the greeting from the real browser's markup",
    );
  }

  // ── An existing letter's email output is UNCHANGED by the wider tag set ─────────────────────
  {
    // The renderer learned lists, breaks and colour. Prose that uses none of them must render
    // byte-identically, or every template in the library quietly changed the day this shipped.
    const plain: OfferBlock = {
      id: "plain",
      props: { html: '<p class="lead">Dear <strong>{{salutationName}}</strong>,</p><p>Plain body.</p>' },
      type: "text",
    };
    const email = renderOfferEmail({ blocks: [plain] }, SAMPLE);
    assert.ok(
      email.html.includes("<p style=\"margin:0 0 10px;"),
      "a plain paragraph must still render with exactly the styling it always had",
    );
    assert.ok(!email.html.includes("class="), "classes are still dropped from the email body");
  }
}
