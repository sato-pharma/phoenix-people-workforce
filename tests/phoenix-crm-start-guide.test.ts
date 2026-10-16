import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { VISIT_DAY_CUTOFF_HOURS } from "../src/lib/phoenix-crm/calendar.ts";
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
 * saved visit — because the photo is what dated and recorded a visit then, and he never took one.
 * Nobody in the company had captured a place. The guide led on exactly those two facts.
 *
 * Since 2026-09-29 a visit needs NO photo — "Log visit" is one tap, and the server takes the time (the
 * owner's rebuilt flow). So the guide now leads on the two facts that replaced them: logging is one
 * tap, and a voice note is kept only with the visit it belongs to.
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
 *   3. THE ARABIC PAGE IS ARABIC-LED. `premiumLetterhead` moves the Arabic title under an English one
 *      the moment `titleEn` is passed, so an Arabic page that quietly acquired an English h1 would
 *      still render, still look house-correct, and be the wrong document.
 *
 *   4. THE PREMIUM DRESS, AND ONLY THE DRESS (owner, 2026-10-13: "change to the premium look"). The
 *      masthead, the frame, the watermark and the running foot are the HR premium identity's; the
 *      chrome is appended LAST, says nothing about Phoenix, and is not drawn on a phone, where the
 *      masthead stacks instead — the guide is read on phones as much as it is printed. The steps,
 *      notes and labels are pinned by everything else in this file, which did not change.
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

    // The HR premium identity, from the module that owns it: the compact masthead (the page is one A4
    // side), its engine-turned band, and the chrome — frame, watermark and running foot.
    assert.match(html, /<header class="pm-mast pm-mast--compact">/, `${language}: the premium masthead is present`);
    assert.match(html, /<svg class="pm-band"/, `${language}: the engine-turned band is present`);
    assert.match(html, /<svg class="pm-frame"/, `${language}: the premium frame is present`);
    assert.match(html, /class="pm-watermark"/, `${language}: the watermark is present`);
    assert.ok(!/class="lh[ _"]/.test(html), `${language}: the old house letterhead is gone, not stacked under the new one`);
    assert.ok(
      html.includes(START_GUIDE_DOCUMENT_CODE),
      `${language}: every company document wears ${START_GUIDE_DOCUMENT_CODE}`,
    );
    // The identity code is carried by the premium foot, once. The old in-flow footer used to print it
    // as well, and a page that wore the code twice would be wearing two identities.
    const footCode = /<div class="pm-foot__code" dir="ltr">([^<]*)<\/div>/.exec(html)?.[1] ?? "";
    assert.ok(footCode.includes(START_GUIDE_DOCUMENT_CODE), `${language}: the premium foot carries the identity code`);
    assert.equal(
      bodyOf(html).split(START_GUIDE_DOCUMENT_CODE).length - 1,
      1,
      `${language}: the identity code is printed once`,
    );
    // The guide's own footer words stay in the page content, after the notes and ahead of the chrome.
    const closing = /<p class="closing">([^<]+)<\/p>/.exec(html);
    assert.ok(closing && /Phoenix CRM/.test(closing[1]), `${language}: the guide's own footer words stay on the page`);
    assert.ok(!/<footer/.test(html), `${language}: no in-flow footer is left to compete with the premium foot`);

    // THE CHROME IS APPENDED LAST AND SAYS NOTHING ABOUT PHOENIX. The guide's title says "Phoenix CRM"
    // because that is what the document is about; the frame, the foot and the watermark are Sato
    // Pharma's dress and name Sato Pharma alone (`PREMIUM_COMPANY_DOCUMENT_BRAND`).
    const chromeAt = html.indexOf('<div class="pm-chrome"');
    assert.ok(chromeAt > html.lastIndexOf('<div class="note">'), `${language}: the chrome is the sheet's last child`);
    assert.ok(!/phoenix/i.test(html.slice(chromeAt)), `${language}: the chrome does not say Phoenix`);

    // THE PAGE IS PRINTED BY THE USER'S BROWSER, so the sheet owns the whole page: `margin: 0` is what
    // lets the fixed frame and foot reach the edges, and it also drops the browser's own header and
    // footer text (the address, the date) from the printout.
    assert.match(html, /@page\s*\{[^}]*size:\s*A4;\s*margin:\s*0;/, `${language}: the page has no margin of its own`);

    // A PHONE gets the content as it always did: the 210 mm frame, watermark and foot are not drawn
    // below 830 px (a 210 mm frame on a 375 px screen is a sideways scroll), and the masthead stacks
    // its mark above its title instead of reserving a column on each side of a title 11 mm wide.
    const phone = /@media screen and \(max-width: 830px\)\s*\{([\s\S]*?)\n  \}/.exec(html)?.[1] ?? "";
    assert.match(phone, /\.pm-chrome\s*\{\s*display:\s*none;/, `${language}: the chrome is not drawn on a phone`);
    assert.match(
      phone,
      /\.pm-mast\.pm-mast--compact\s*\{[^}]*grid-template-columns:\s*1fr/,
      `${language}: the masthead stacks on a phone`,
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
      /Log visit is one tap|تسجيل الزيارة ضغطة واحدة/.test(body),
      `${language}: the page says logging a visit is one tap`,
    );
    assert.equal(
      /photo is what records the visit|الصورة هي ما يسجل الزيارة/.test(body),
      false,
      `${language}: the page no longer tells a rep a visit needs a photo (retired 2026-09-29)`,
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

    // ARABIC-LED. premiumLetterhead promotes an English title to the h1 and pushes the Arabic under it
    // the moment `titleEn` is passed — a silent change of document, not a styling one.
    assert.match(
      ar,
      /<h1 class="pm-mast__t" dir="rtl" lang="ar">تسجيل الزيارة<\/h1>/,
      "the Arabic title is the h1, with no English above it",
    );
    assert.equal([...ar.matchAll(/<h1[\s>]/g)].length, 1, "the Arabic page prints its title once, as its only h1");
    // The page WITHOUT its stylesheet: the premium stylesheet names both title classes for every paper.
    assert.ok(!bodyOf(ar).includes("pm-mast__t--en"), "the Arabic page has no English h1");
    assert.ok(!bodyOf(ar).includes("pm-mast__tar"), "and no second-language title under the Arabic one");

    // EVERY English label is isolated. Strip the ones that went through the helper; if a label is
    // still standing in the body afterwards, it was written bare.
    // Every ISOLATED run goes first — the rule is `<bdi>`, not "one of the registered buttons". The
    // plan's deadline (2026-10-02) is the first English run here that is not a button name: "11:55 PM"
    // carries a bare "PM" into the Arabic sentence, and it is isolated exactly as a label is, which is
    // what the rule asks for. What this must still catch is a label written with no isolation at all.
    let stripped = bodyOf(ar).replace(/<bdi>[\s\S]*?<\/bdi>/g, "");
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
    assert.match(
      en,
      /<h1 class="pm-mast__t pm-mast__t--en" dir="ltr" lang="en">Phoenix CRM — Recording a Visit<\/h1>/,
      "English leads, Arabic sits under it",
    );
    assert.equal([...en.matchAll(/<h1[\s>]/g)].length, 1, "the English page prints its title once, as its only h1");
    assert.match(
      en,
      /<p class="pm-mast__tar" dir="rtl" lang="ar">تسجيل الزيارة<\/p>/,
      "the English page still carries the Arabic name of the document",
    );
    assert.ok(
      bodyOf(en).indexOf("pm-mast__t--en") < bodyOf(en).indexOf("pm-mast__tar"),
      "the Arabic name sits UNDER the English title, never above it",
    );
  }

  // ── The helper itself ────────────────────────────────────────────────────────────────────────
  {
    assert.equal(startGuideUiLabel("Save"), "<bdi><strong>Save</strong></bdi>");
    assert.ok(
      START_GUIDE_UI_LABELS.every((label) => buildPhoenixCrmStartGuide("ar").includes(startGuideUiLabel(label))),
      "every label the guide names is actually on the Arabic page",
    );
  }

  // ── KEPT UPDATED: the page cannot quietly fall behind the screens ────────────────────────────
  //
  // Owner, 2026-10-01: "UPDATE AND KEEP ALWAYS UPDATED ARABIC OR EN". A guide that drifts sends a rep
  // to a button that no longer exists, which is the whole reason this page lives beside the code
  // rather than in a file somebody keeps. These four pins are the part a test can hold; a NEW field
  // nobody wrote a line about is not mechanically catchable, and the module header says so plainly.
  {
    // 1. THE LABEL LIST IS COMPLETE. Read back out of the built pages, so a label added to the prose
    //    without being registered is caught — and it matters: the <bdi> isolation check above can
    //    only strip labels it knows, so an unregistered one ships bare on the Arabic page. "Capture
    //    location" was in exactly that state before this block existed.
    const registered = new Set<string>(START_GUIDE_UI_LABELS);
    for (const language of START_GUIDE_LANGUAGES) {
      const used = [...buildPhoenixCrmStartGuide(language).matchAll(/<bdi><strong>([^<]+)<\/strong><\/bdi>/g)].map(
        (m) => m[1],
      );
      assert.ok(used.length > 0, `${language}: the page names at least one button`);
      for (const label of used) {
        assert.ok(
          registered.has(label),
          `${language}: "${label}" is named on the page but missing from START_GUIDE_UI_LABELS — register it, ` +
            "or it escapes the <bdi> isolation check and ships bare on the Arabic page",
        );
      }
    }

    // 2. EVERY LABEL STILL EXISTS ON A REAL SCREEN. This is the pin that makes a RENAME impossible to
    //    ship quietly: rename the button and the guide goes red in the same PR that renamed it.
    const componentDir = new URL("../src/components/phoenix-crm/", import.meta.url);
    const screens = readdirSync(componentDir)
      .filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
      .map((name) => readFileSync(new URL(name, componentDir), "utf8"))
      .join("\n");
    assert.ok(screens.length > 10_000, "the screens were actually read, rather than an empty directory passing");
    for (const label of START_GUIDE_UI_LABELS) {
      assert.ok(
        screens.includes(label),
        `the guide names "${label}" but no Phoenix CRM screen contains that text any more — the button was ` +
          "renamed or removed, and the guide now sends a rep looking for something that is not there",
      );
    }

    // 3. THE DEADLINE IS READ, NOT TYPED. `VISIT_DAY_CUTOFF_HOURS` is the one place the 02:00 rule
    //    lives (owner, 2026-09-29: "maximum 2 AM"); a guide that hard-codes it drifts the day it moves.
    const en = buildPhoenixCrmStartGuide("en");
    assert.ok(
      en.includes(`until ${VISIT_DAY_CUTOFF_HOURS} AM`),
      `the English page must say "until ${VISIT_DAY_CUTOFF_HOURS} AM", matching VISIT_DAY_CUTOFF_HOURS`,
    );
    // Arabic spells the hour as a word, so the pin is the ARABIC NUMERAL WORD for the same figure —
    // checked against a small map rather than a digit, because the page reads "الثانية صباحاً".
    const arabicHourWord: Record<number, string> = { 1: "الواحدة", 2: "الثانية", 3: "الثالثة", 4: "الرابعة" };
    const hourWord = arabicHourWord[VISIT_DAY_CUTOFF_HOURS];
    assert.ok(hourWord, `no Arabic word is known for hour ${VISIT_DAY_CUTOFF_HOURS} — add it to this map`);
    assert.ok(
      buildPhoenixCrmStartGuide("ar").includes(`حتى الساعة ${hourWord} صباحاً`),
      `the Arabic page must say the same hour as the English one (${VISIT_DAY_CUTOFF_HOURS} AM)`,
    );

    // 4. NEITHER LANGUAGE IS A STEP OR A NOTE BEHIND THE OTHER. The Arabic page is the half that gets
    //    forgotten, because the English one is the half a reviewer reads — so an English-only addition
    //    is the exact shape of the drift the owner asked to prevent, and it is cheap to catch.
    const counts = START_GUIDE_LANGUAGES.map((language) => {
      const html = buildPhoenixCrmStartGuide(language);
      return {
        language,
        steps: [...html.matchAll(/<span class="n">\d+<\/span>/g)].length,
        notes: [...html.matchAll(/<div class="note">/g)].length,
      };
    });
    const [first, ...rest] = counts;
    for (const other of rest) {
      assert.equal(
        other.steps,
        first.steps,
        `${other.language} has ${other.steps} steps and ${first.language} has ${first.steps} — one language was updated alone`,
      );
      assert.equal(
        other.notes,
        first.notes,
        `${other.language} has ${other.notes} notes and ${first.language} has ${first.notes} — one language was updated alone`,
      );
    }

    // 5. The phone the rep types is on BOTH pages — it is the newest thing the flow asks of him
    //    (owner, 2026-09-30, and the reason this guide was revisited at all).
    for (const language of START_GUIDE_LANGUAGES) {
      assert.ok(
        buildPhoenixCrmStartGuide(language).includes(startGuideUiLabel("Phone")),
        `${language}: the page names the Phone field the rep fills in at validation`,
      );
      assert.ok(
        buildPhoenixCrmStartGuide(language).includes(startGuideUiLabel("Change the details")),
        `${language}: and where he corrects it afterwards`,
      );
    }
  }

  // ── The route keeps each page for the life of the process, so the builder must stay pure ───────
  // (Phoenix CRM performance audit, 2026-10-16.) Held once per language, the page is only as fresh as
  // the process serving it — right for a pure function of the language, and wrong the day someone adds
  // a date or a name to it. Two builds of one language must be the same string.
  {
    for (const language of START_GUIDE_LANGUAGES) {
      assert.equal(buildPhoenixCrmStartGuide(language), buildPhoenixCrmStartGuide(language), `${language}: the page is a pure function of its language`);
    }
    const route = readFileSync(new URL("../app/api/phoenix-crm/start-guide/route.ts", import.meta.url), "utf8");
    assert.match(route, /return new Response\(startGuideHtml\(language\), \{/, "the route serves the kept page");
    assert.match(route, /await assertPermission\(access, "phoenix_crm", "read"\);/, "and still checks the permission on every request");
  }
}
