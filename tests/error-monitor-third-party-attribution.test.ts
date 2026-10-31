import assert from "node:assert/strict";
import fs from "node:fs";

import { describeDomRewriters } from "../src/lib/error-monitor/dom-rewriter.ts";
import { decodeErrorMessage } from "../src/lib/error-monitor/message-decode.ts";
import { describeThirdPartyStack } from "../src/lib/error-monitor/third-party-stack.ts";

/**
 * Two failures of ATTRIBUTION, both of which sent real triage the wrong way.
 *
 * Ten rows on /employee-portals/submit-expense on 2026-09-09 read like an app bug in the trip
 * claim flow. Every frame was Google's map renderer, and both people submitted their claim
 * anyway. Separately, hydration error #418 kept arriving with no app-code cause anywhere in the
 * two worst routes' import graphs, and the `translate="no"` opt-out shipped for it did not stop
 * Samsung Internet.
 *
 * The stacks below are production rows, copied verbatim, because the one thing a hand-written
 * stack cannot pin is the shape a real browser actually emits.
 */
export function runErrorMonitorThirdPartyAttributionTests() {
  // ── The real Google Maps failure, Safari frame form ─────────────────────────
  const mapsStack = [
    "— Client context —",
    "seq=9 readyState=complete visibility=visible unloading=false sinceNavMs=176321 navType=navigate",
    "",
    "mq@https://maps.googleapis.com/maps-api-v3/api/js/66/3d/intl/en_gb/webgl.js:1024:450",
    "@https://maps.googleapis.com/maps-api-v3/api/js/66/3d/intl/en_gb/main.js:475:824",
    "Xm@https://maps.googleapis.com/maps-api-v3/api/js/66/3d/intl/en_gb/main.js:475:836",
  ].join("\n");

  const maps = describeThirdPartyStack(mapsStack);
  assert.ok(maps, "an all-Google stack must be attributed");
  assert.equal(maps.label, "maps.googleapis.com"); // the FIRST frame — the throw site
  assert.equal(maps.frameCount, 3);

  // The admin reads the origin before the message, which is the whole point.
  const mapsRow = decodeErrorMessage("undefined is not an object (evaluating 'this.rh.get(b).filter')", mapsStack);
  assert.match(mapsRow.display, /^Third-party script \(maps\.googleapis\.com\)/);
  assert.match(mapsRow.display, /this\.rh\.get\(b\)\.filter/); // the message is kept, never replaced
  assert.equal(mapsRow.raw, "undefined is not an object (evaluating 'this.rh.get(b).filter')");

  // ── A React error must NEVER be attributed away ─────────────────────────────
  // #418 carries `visit https://react.dev/errors/418` INSIDE its own message. Matching bare URLs
  // would read that documentation link as the thrower and label every hydration error in the
  // table as somebody else's code — the exact inversion this module exists to prevent.
  const reactMessage =
    "Minified React error #418; visit https://react.dev/errors/418?args[]=text&args[]= for the full message" +
    " or use the non-minified dev environment for full errors and additional helpful warnings.";
  const reactStack = [
    "— Client context —",
    "seq=1 readyState=complete visibility=visible unloading=false sinceNavMs=5715 navType=reload",
    "",
    `Error: ${reactMessage}`,
    "    at rJ (https://phoenix-hr.satopharma.com/_next/static/chunks/0xz6-s62g6oj6.js:1:46285)",
    "    at sh (https://phoenix-hr.satopharma.com/_next/static/chunks/0xz6-s62g6oj6.js:1:146822)",
  ].join("\n");

  assert.equal(describeThirdPartyStack(reactStack), null);
  const reactRow = decodeErrorMessage(reactMessage, reactStack);
  assert.doesNotMatch(reactRow.display, /Third-party/);
  assert.match(reactRow.display, /Hydration mismatch/); // still decodes as itself

  // Even with every app frame stripped away, the documentation link alone attributes nothing:
  // a frame needs its `:line:col`, and a link in prose has none.
  assert.equal(describeThirdPartyStack(`Error: ${reactMessage}`), null);

  // ── One app frame anywhere is enough to keep the row ours ───────────────────
  // A mixed stack means our code is on the path, so it must not read as somebody else's.
  const mixedStack = [
    "mq@https://maps.googleapis.com/maps-api-v3/api/js/66/3d/webgl.js:1024:450",
    "onMapReady@https://phoenix-hr.satopharma.com/_next/static/chunks/06fa7yadrmwnm.js:1:14209",
  ].join("\n");
  assert.equal(describeThirdPartyStack(mixedStack), null);

  // An inline script on one of our own pages carries the PAGE url and no /_next/ — still ours.
  assert.equal(
    describeThirdPartyStack("@https://phoenix-hr.satopharma.com/employee-portals/submit-expense:12:3"),
    null,
  );

  // ── A server throw locates no frames at all, and must stay unlabelled ───────
  const serverStack = [
    "Error: The destination stream closed early.",
    "    at PassThrough.<anonymous> (/app/node_modules/.pnpm/next@16.3.3/dist/server/render.js:114:23)",
  ].join("\n");
  assert.equal(describeThirdPartyStack(serverStack), null);
  assert.equal(describeThirdPartyStack(null), null);
  assert.equal(describeThirdPartyStack(""), null);

  // ── Both browser frame dialects, and an extension ───────────────────────────
  // Chromium writes `at name (url:l:c)`; Safari and Firefox write `name@url:l:c`.
  const chromium = describeThirdPartyStack("    at Bd (https://cdn.example.com/widget.js:2:99)");
  assert.equal(chromium?.label, "cdn.example.com");
  const bareChromium = describeThirdPartyStack("    at https://cdn.example.com/widget.js:2:99");
  assert.equal(bareChromium?.label, "cdn.example.com");

  // An extension id names nothing a reader can act on, so it is described by what it is.
  const extension = describeThirdPartyStack("h@chrome-extension://abcdefghijklmnop/inject.js:1:20");
  assert.equal(extension?.label, "a browser extension");

  // ── The DOM-rewriter probe ──────────────────────────────────────────────────
  // A clean page writes NOTHING, so an ordinary error row is unchanged.
  // The app's OWN attributes, not empty arrays: `app/layout.tsx` serves lang + class on <html> and
  // class on <body>, the display-scale script writes documentElement.style, and the portal's modals
  // write body.style.overflow. A fixture that left them out would pass while the allow-list was
  // broken, which is the one thing this clean case has to prove.
  const clean = {
    bodyAttributeNames: ["class", "style"],
    fontElementCount: 0,
    hasMicrosoftTranslateAttribute: false,
    htmlAttributeNames: ["lang", "class", "style"],
    htmlClassName: "h-full antialiased",
    htmlLang: "en",
  };
  assert.deepEqual(describeDomRewriters(clean), []);

  // Google Translate, which is what Chrome, Chrome iOS and Samsung Internet all invoke.
  assert.deepEqual(
    describeDomRewriters({ ...clean, htmlClassName: "h-full antialiased translated-ltr" }),
    ["google-translate"],
  );
  assert.deepEqual(describeDomRewriters({ ...clean, htmlClassName: "translated-rtl" }), ["google-translate"]);
  // Not a substring match: a class that merely contains the word is not the marker.
  assert.deepEqual(describeDomRewriters({ ...clean, htmlClassName: "untranslated-ltrx" }), []);

  // `<font>` is the tag Google Translate wraps every rewritten text node in, and the app emits
  // none — so a count above zero is a foreign rewrite whichever browser did it, including the
  // ones that leave no class behind.
  assert.deepEqual(describeDomRewriters({ ...clean, fontElementCount: 47 }), ["fontTags=47"]);
  assert.deepEqual(describeDomRewriters({ ...clean, hasMicrosoftTranslateAttribute: true }), ["microsoft-translate"]);

  // app/layout.tsx serves lang="en"; anything else means something rewrote the document.
  assert.deepEqual(describeDomRewriters({ ...clean, htmlLang: "ar" }), ["lang=ar"]);
  assert.deepEqual(describeDomRewriters({ ...clean, htmlLang: "EN" }), []);

  // A translated page usually trips several at once, and every one is recorded.
  assert.deepEqual(
    describeDomRewriters({ ...clean, fontElementCount: 12, htmlClassName: "translated-ltr", htmlLang: "ar" }),
    ["google-translate", "fontTags=12", "lang=ar"],
  );

  // The two rewriters that change page TEXT without touching <html> or <body>, so every marker above
  // stayed clean while they ran: an iPhone's own phone-number detection, which wraps a number such as
  // a direct order's distributor customer code ("0001518652") in a call link stamped
  // `x-apple-data-detectors`, and Cloudflare's email rewrite (`data-cfemail`). Both direct-order #418s
  // (an iPhone, 26 and 27 Oct 2026) came back with no marker at all; the next one says which.
  assert.deepEqual(describeDomRewriters({ ...clean, appleDataDetectorCount: 2 }), ["ios-data-detectors=2"]);
  assert.deepEqual(describeDomRewriters({ ...clean, cloudflareEmailCount: 3 }), ["cloudflare-email=3"]);
  assert.deepEqual(describeDomRewriters({ ...clean, appleDataDetectorCount: 0, cloudflareEmailCount: 0 }), [], "a zero count writes nothing");
  const reporter = fs.readFileSync(new URL("../src/lib/error-monitor/report-client-error.ts", import.meta.url), "utf8");
  assert.match(reporter, /appleDataDetectorCount:\s*countMatching\("\[x-apple-data-detectors\]"\)/, "🔴 the reporter must count the links an iPhone's phone-number detection inserted");
  assert.match(reporter, /cloudflareEmailCount:\s*countMatching\("\[data-cfemail\], a\.__cf_email__"\)/, "🔴 the reporter must count the addresses Cloudflare rewrote");
  // A document that cannot count (the guard test's stand-in has no querySelectorAll) answers 0 —
  // it must never throw, or the whole row loses seq, navType and domGuard with it.
  assert.match(reporter, /function countMatching\(selector: string\): number \{\s*if \(typeof document\.querySelectorAll !== "function"\) return 0;\s*try \{/, "🔴 countMatching must tolerate a document that cannot count");

  // ── Foreign attributes on <html>/<body>: the marker that names error #412's mutator ─────────
  // 🔴 WHY THIS EXISTS. #412 is a RECOVERED hydration error — React re-renders the subtree on the
  // client, so the page works and nothing turns red. It started 2026-09-15, reached 8 people on two
  // portal routes, and 22 of its 23 events were Firefox. Its own client context said
  // `readyState=complete`, whose documented meaning in report-client-error.ts is that the DOM was
  // mutated from OUTSIDE React, and every one of those rows came back clean on the four translator
  // markers above — a real negative, since the reporter omits the field only when the probe returns
  // []. So the mutator was something none of the existing markers could name. An extension stamping
  // <html> or <body> is the known cause of that shape, and Grammarly's is one of the best-known
  // causes of a React hydration mismatch anywhere.
  //
  // The 2026-09-08 `translate="no"` opt-out (#3487) is NOT the precedent to follow here — it was a
  // fix applied to a plausible cause and the owner removed it three days later (#3670) because it
  // cost every Arabic-speaking reader the translate offer and silenced nothing measurable. #3629's
  // probe is the precedent: make the next occurrence SAY what did it.
  //
  // 🔴 2026-10-07, what the probe then SAID. #412 decodes to React's "Connection closed." — a
  // client-side RSC stream aborted mid-flight (navigate-away / backgrounded tab / flaky mobile
  // network), the client-side sibling of the server's "destination stream closed early", not a
  // hydration mismatch at all. And the `foreignAttrs=` it was reporting was NOT an unnamed
  // extension: 175 of 175 probe rows in a 30-day production window carried the app's OWN
  // `data-route-transition-ready` (RouteTransitionProvider's mount effect), because it was missing
  // from the allow-list. The whole channel was noise. Those two app attributes are now allow-listed,
  // asserted below, so a genuine extension is no longer buried under them.
  assert.deepEqual(
    describeDomRewriters({ ...clean, htmlAttributeNames: ["lang", "class", "style", "data-darkreader-mode", "data-darkreader-scheme"] }),
    ["dark-reader"],
    "Dark Reader is reported ONCE by name however many of its attributes are present",
  );
  assert.deepEqual(
    describeDomRewriters({ ...clean, bodyAttributeNames: ["class", "style", "data-gr-ext-installed", "data-new-gr-c-s-check-loaded"] }),
    ["grammarly"],
    "Grammarly writes two attributes and both belong to one named mutator",
  );
  assert.deepEqual(
    describeDomRewriters({ ...clean, bodyAttributeNames: ["class", "cz-shortcut-listen"] }),
    ["colorzilla"],
  );

  // An UNKNOWN attribute is listed verbatim rather than counted — the next extension nobody has
  // heard of is precisely the one worth reading, and `foreignAttrs=2` would say nothing about it.
  assert.deepEqual(
    describeDomRewriters({ ...clean, htmlAttributeNames: ["lang", "class", "data-someext-v3"] }),
    ["foreignAttrs=data-someext-v3"],
  );
  // Sorted and de-duplicated, so the same page produces the same string on every load and a census
  // can group it. Two elements contributing the same name must not print it twice.
  assert.deepEqual(
    describeDomRewriters({
      ...clean,
      bodyAttributeNames: ["class", "zeta-attr", "shared-attr"],
      htmlAttributeNames: ["lang", "shared-attr", "alpha-attr"],
    }),
    ["foreignAttrs=alpha-attr|shared-attr|zeta-attr"],
  );
  // A named mutator and an unknown one both report, names first.
  assert.deepEqual(
    describeDomRewriters({ ...clean, htmlAttributeNames: ["lang", "data-darkreader-mode", "data-mystery"] }),
    ["dark-reader", "foreignAttrs=data-mystery"],
  );

  // 🔴 THE ALLOW-LIST MUST HOLD, and `style` is the one that matters: the app writes
  // documentElement.style (display scale) and body.style.overflow (every portal modal). If `style`
  // were ever dropped from it, every error row from a page with an open modal would accuse an
  // extension that was never there — and a probe that cries wolf is one the next session stops
  // believing, which is the failure this whole file exists to avoid.
  assert.deepEqual(describeDomRewriters({ ...clean, bodyAttributeNames: ["class", "style"] }), []);
  assert.deepEqual(describeDomRewriters({ ...clean, htmlAttributeNames: ["lang", "class", "style"] }), []);
  // Case and whitespace: HTML lower-cases attribute names, but a probe fed from anywhere else need
  // not, and `STYLE` is still the app's own.
  assert.deepEqual(describeDomRewriters({ ...clean, htmlAttributeNames: [" LANG ", "Class", "STYLE"] }), []);
  // An absent <body> mid-stream reports nothing rather than throwing.
  assert.deepEqual(describeDomRewriters({ ...clean, bodyAttributeNames: [] }), []);

  // 🔴 The app's OWN route-transition attributes on <html>, set by RouteTransitionProvider's effect
  // on essentially every page. Absent from the server markup, so before they were allow-listed they
  // stamped `foreignAttrs=data-route-transition-ready` on 175 of 175 probe rows in a 30-day
  // production window — the whole channel was noise. They must read as app-own.
  assert.deepEqual(
    describeDomRewriters({
      ...clean,
      htmlAttributeNames: ["lang", "class", "style", "data-route-transition-ready", "data-route-transition-pending"],
    }),
    [],
  );
  // But a REAL extension sitting alongside them is still named — the allow-list must not swallow the
  // signal it was built to carry.
  assert.deepEqual(
    describeDomRewriters({
      ...clean,
      htmlAttributeNames: ["lang", "class", "data-route-transition-ready", "data-darkreader-mode"],
    }),
    ["dark-reader"],
  );
}
