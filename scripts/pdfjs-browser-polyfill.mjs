// The polyfill that scripts/sync-pdfjs-assets.mjs prepends to BOTH files under public/pdfjs/.
//
// WHY IT EXISTS
// On 2026-09-14 managers across the field opened a CV and got "Promise.withResolvers is not a
// function" instead of the page: public/pdfjs/ held pdf.js's MODERN build, which calls recent
// built-ins with no fallback. The fix that day was to serve the LEGACY build instead, because it
// carries core-js polyfills inside both files. That fix depends on Mozilla's own build choices,
// and pdfjs-dist 6 quietly withdrew one of them: 6.3.289's legacy build still bundles core-js
// (3.50.0, up from 5.4.296's 3.45.1) but no longer includes the Promise.withResolvers polyfill,
// while calling it 27 times in pdf.min.mjs and 14 in pdf.worker.min.mjs. Taking that bump would
// have reproduced the outage exactly. So we stop depending on the vendor's browser baseline and
// carry the fallback ourselves.
//
// WHY IT IS PREPENDED RATHER THAN IMPORTED
// Two globals need it, and only one of them is ours. The library is loaded by four components
// (the CV preview modal, the hiring-pack template studio, the WhatsApp application print view and
// the visual-aids workspace) as a same-origin static asset. Its WORKER is loaded by pdf.js
// itself, from GlobalWorkerOptions.workerSrc, into a separate global where nothing the page did
// applies — a polyfill installed on window does not reach it. Prepending puts the fallback inside
// each file, ahead of the first line of pdf.js, so both globals are covered with no wiring in any
// component and no way for a new call site to be missed.
//
// WHAT IT COVERS, AND HOW THAT LIST WAS CHOSEN
// Measured by diffing 6.3.289's legacy build against 5.4.296's — the build serving the field
// since 2026-09-14, so anything missing from BOTH is proven harmless in practice and anything
// missing from v6 ALONE is a real regression:
//   * Promise.withResolvers  — polyfilled in v5, absent in v6, called 27x + 14x. The outage.
//   * Array.prototype.findLast — absent in both, but only CALLED in v6 (once, as [...x].findLast
//     in the filename-from-URL helper). Same defect class, found by the same measurement, so it
//     is covered here rather than left to bite later.
// Both guards are `if (!existing)`, so on a build that still ships its own polyfill — today's
// 5.4.296 does, for withResolvers — this is a no-op and the vendor's implementation is untouched.
//
// Pinned by tests/pdfjs-browser-polyfill.test.ts (behaviour, executed with the built-ins deleted)
// and tests/pdfjs-legacy-browser-assets.test.ts (that the served files actually carry it).

// Bump when the polyfill body changes, so a stale public/pdfjs copy is obvious in a diff.
export const PDFJS_POLYFILL_VERSION = 1;

export const PDFJS_BROWSER_POLYFILL = `/*! Phoenix pdf.js browser polyfill v${PDFJS_POLYFILL_VERSION} — prepended by scripts/sync-pdfjs-assets.mjs, not part of pdf.js.
 * Keeps a CV opening on phone browsers older than roughly Chrome 119 / Safari 17.4, which
 * pdfjs-dist 6 stopped polyfilling for. Source and reasoning: scripts/pdfjs-browser-polyfill.mjs */
(function () {
  "use strict";

  // Runs in the page AND in the pdf.js worker, so it touches no DOM and names no window.
  if (typeof Promise === "function" && typeof Promise.withResolvers !== "function") {
    Object.defineProperty(Promise, "withResolvers", {
      configurable: true,
      writable: true,
      value: function withResolvers() {
        // \`new this\` rather than \`new Promise\`, so a subclass gets its own kind back, as the
        // specification requires and as pdf.js's own capability helpers rely on.
        var resolve;
        var reject;
        var promise = new this(function (res, rej) {
          resolve = res;
          reject = rej;
        });
        return { promise: promise, resolve: resolve, reject: reject };
      },
    });
  }

  if (typeof Array === "function" && typeof Array.prototype.findLast !== "function") {
    Object.defineProperty(Array.prototype, "findLast", {
      configurable: true,
      writable: true,
      value: function findLast(predicate) {
        if (this === null || this === undefined) {
          throw new TypeError("Array.prototype.findLast called on null or undefined");
        }
        if (typeof predicate !== "function") {
          throw new TypeError(String(predicate) + " is not a function");
        }
        var list = Object(this);
        var length = list.length >>> 0;
        var thisArg = arguments.length > 1 ? arguments[1] : undefined;
        for (var index = length - 1; index >= 0; index--) {
          var value = list[index];
          if (predicate.call(thisArg, value, index, list)) {
            return value;
          }
        }
        return undefined;
      },
    });
  }
})();
`;

// The built-ins the polyfill above installs, as the property names a bundle would call them by.
// tests/pdfjs-legacy-browser-assets.test.ts reads this to decide whether a gap in a freshly
// synced vendor build is one we already cover, or a NEW one that needs a decision.
export const PDFJS_POLYFILLED_BUILTINS = ["Promise.withResolvers", "Array.prototype.findLast"];
