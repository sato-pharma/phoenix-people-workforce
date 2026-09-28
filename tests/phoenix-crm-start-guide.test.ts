import assert from "node:assert/strict";

import {
  buildPhoenixCrmStartGuide,
  isStartGuideLanguage,
  START_GUIDE_DOCUMENT_CODE,
  START_GUIDE_LANGUAGES,
  START_GUIDE_UI_LABELS,
  startGuideDownloadName,
  startGuideUiLabel,
} from "../src/lib/phoenix-crm/start-guide.ts";

/**
 * Phoenix CRM — the one-page start guide a District Manager sends a rep.
 *
 * It exists because of something measured on production: on 25 September a rep recorded NINE voice
 * notes across a full working day, every one of them reaching the bucket, and not one attached to a
 * saved visit — because the photo is what dates and records a visit, and he never took one. Nobody
 * in the company had captured a place. The guide leads on exactly those two facts.
 *
 * WHAT THIS FILE PINS, and why each one is here rather than assumed:
 *
 *   1. THE ENGLISH BUTTON NAMES ON THE ARABIC PAGE ARE ISOLATED, EVERY ONE. They stay English
 *      because they are English on his screen; they are wrapped in <bdi> because an English run
 *      inside an Arabic paragraph drags the NEUTRAL characters beside it — the full stop after
 *      "Save" resolves to the paragraph direction and is painted at the wrong end. A bare label that
 *      slipped past the helper would look like a typo in review and read as broken to the only
 *      audience the page has, so the check is "no label appears outside a <bdi>", never "some label
 *      appears inside one".
 *
 *   2. THE SQUARE-EDGE GOLDEN RULE, on a document nothing else measures. `tokens.css` does not reach
 *      a standalone printed page.
 *
 *   3. THE ARABIC PAGE IS ARABIC-LED. `houseLetterhead` moves the Arabic title under an English one
 *      the moment `titleEn` is passed, so an Arabic page that quietly acquired an English h1 would
 *      still render, still look house-correct, and be the wrong document.
 *
 * The BLIND half is NOT pinned here, deliberately: `src/lib/phoenix-crm` minus `/server/` is one of
 * the roots `phoenix-crm-blind-half.test.ts` DERIVES its surface from, so this module is already
 * inside that check. Re-asserting it here would create a second, weaker copy that drifts.
 */

/** The page without its stylesheet — CSS legitimately contains words that are not page content. */
function bodyOf(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/g, "");
}

export async function runPhoenixCrmStartGuideTests(): Promise<void> {
  // ── Both languages build, and are the only two ───────────────────────────────────────────────
  {
    assert.deepEqual([...START_GUIDE_LANGUAGES], ["en", "ar"]);
    assert.ok(isStartGuideLanguage("ar"), "ar is a language");
    assert.ok(!isStartGuideLanguage("fr"), "an unlisted language is refused rather than rendered blank");
    assert.ok(!isStartGuideLanguage(undefined), "a missing language is not a language");
  }

  for (const language of START_GUIDE_LANGUAGES) {
    const html = buildPhoenixCrmStartGuide(language);

    // The house identity, from the module that owns it.
    assert.match(html, /class="lh"/, `${language}: the house letterhead is present`);
    assert.match(html, /class="lh__rule"/, `${language}: the engine-turned band is present`);
    assert.ok(
      html.includes(START_GUIDE_DOCUMENT_CODE),
      `${language}: every company document wears ${START_GUIDE_DOCUMENT_CODE}`,
    );

    // THE SQUARE-EDGE GOLDEN RULE — no round or semi-round corners, anywhere.
    const radii = [...html.matchAll(/border-radius:\s*([^;}]+)/g)].map((m) => m[1].trim());
    assert.ok(radii.length > 0, `${language}: the page states its corners rather than inheriting them`);
    for (const value of radii) {
      assert.match(value, /^0[a-z%]*$/i, `${language}: a corner is rounded — border-radius: ${value}`);
    }

    // THE INK RULE — the identity is carried by lines and type, never by filled area. The one
    // permitted fill is the 6% zebra row on a data table, and this page has no table.
    assert.ok(
      !/background(-color)?:\s*(?!none|transparent)/.test(bodyOf(html).replace(/&[a-z]+;/g, "")),
      `${language}: no filled area outside the band`,
    );

    // The six steps, numbered, each a ruled numeral rather than a filled disc.
    const steps = [...html.matchAll(/<span class="n">(\d+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(steps, ["1", "2", "3", "4", "5", "6"], `${language}: six steps, in order`);

    // The two facts the guide exists to deliver.
    const body = bodyOf(html);
    assert.ok(
      /photo is what records the visit|الصورة هي ما يسجل الزيارة/.test(body),
      `${language}: the page says the photo is what records the visit`,
    );
    assert.ok(
      /stored only when you press|لا تُحفظ إلا عند الضغط/.test(body),
      `${language}: the page says a voice note saves only with the visit`,
    );

    assert.ok(startGuideDownloadName(language).length > 0, `${language}: the download is named`);
  }

  // ── The Arabic page ──────────────────────────────────────────────────────────────────────────
  {
    const ar = buildPhoenixCrmStartGuide("ar");
    assert.match(ar, /<html lang="ar" dir="rtl">/, "the Arabic page lays out right-to-left");

    // ARABIC-LED. houseLetterhead promotes an English title to the h1 and pushes the Arabic under it
    // the moment `titleEn` is passed — a silent change of document, not a styling one.
    assert.match(ar, /<h1>تسجيل الزيارة<\/h1>/, "the Arabic title is the h1, with no English above it");
    assert.ok(!ar.includes('<h1 dir="ltr">'), "the Arabic page has no English h1");

    // EVERY English label is isolated. Strip the ones that went through the helper; if a label is
    // still standing in the body afterwards, it was written bare.
    let stripped = bodyOf(ar);
    for (const label of START_GUIDE_UI_LABELS) stripped = stripped.split(startGuideUiLabel(label)).join("");
    for (const label of START_GUIDE_UI_LABELS) {
      assert.ok(
        !stripped.includes(label),
        `the Arabic page has a bare "${label}" — an English run must be isolated in <bdi> or its punctuation swaps ends`,
      );
    }

    // And a label never breaks across a line: "Unplanned visit" split over two lines is a name the
    // rep has to reassemble before he can match it to his screen.
    assert.match(ar, /bdi\s*\{[^}]*white-space:\s*nowrap/, "an isolated label is unbreakable");

    // The digits inside the ruled numerals are pinned LTR so a two-digit step could not reverse.
    assert.match(ar, /\.n\s*\{[^}]*direction:\s*ltr/, "the step numeral is pinned left-to-right");
  }

  // ── The English page ─────────────────────────────────────────────────────────────────────────
  {
    const en = buildPhoenixCrmStartGuide("en");
    assert.match(en, /<html lang="en" dir="ltr">/, "the English page lays out left-to-right");
    assert.match(en, /<h1 dir="ltr">Phoenix CRM — Recording a Visit<\/h1>/, "English leads, Arabic sits under it");
    assert.match(en, /class="lh__ar"/, "the English page still carries the Arabic name of the document");
  }

  // ── The helper itself ────────────────────────────────────────────────────────────────────────
  {
    assert.equal(startGuideUiLabel("Save"), "<bdi><strong>Save</strong></bdi>");
    assert.ok(
      START_GUIDE_UI_LABELS.every((label) => buildPhoenixCrmStartGuide("ar").includes(startGuideUiLabel(label))),
      "every label the guide names is actually on the Arabic page",
    );
  }
}
