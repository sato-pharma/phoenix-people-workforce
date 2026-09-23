// Regenerates the committed pdf.js browser assets under public/pdfjs/ from the currently
// installed pdfjs-dist version. Run after bumping pdfjs-dist in package.json:
//
//   node scripts/sync-pdfjs-assets.mjs
//
// The recruitment CV viewer (src/components/recruitment/cv-preview-modal.tsx) loads these two
// files as same-origin static assets via a native (webpackIgnore) import, so they must stay in
// sync with the pinned pdfjs-dist version that provides its API types. They are committed (not
// generated at build time) so a bundler/install quirk can never leave the viewer without them —
// same posture as public/OneSignalSDKWorker.js. Commit the diff it writes.
//
// They come from `legacy/build/`, NEVER `build/`. The modern build calls Promise.withResolvers
// and other recent built-ins with no fallback, so on any phone browser older than roughly
// Chrome 119 / Safari 17.4 (older Samsung Internet included) every CV failed to open with
// "Promise.withResolvers is not a function" — managers across the field hit it on 2026-09-14.
// The legacy build ships the same API with core-js polyfills inside both files.
//
// It ships FEWER of them than it used to, which is why this script no longer merely copies.
// pdfjs-dist 6 withdrew the Promise.withResolvers polyfill from its legacy build while still
// calling that built-in 41 times across the two files, so "use the legacy build" stopped being
// enough on its own. Each file is now written as OUR polyfill followed by the vendor's bytes
// verbatim — see scripts/pdfjs-browser-polyfill.mjs for what it covers, and why it is prepended
// into the file rather than loaded beside it (the worker runs in its own global).
// Pinned by tests/pdfjs-legacy-browser-assets.test.ts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { PDFJS_BROWSER_POLYFILL, PDFJS_POLYFILL_VERSION } from "./pdfjs-browser-polyfill.mjs";

const require = createRequire(import.meta.url);
// Resolve pdfjs-dist's package root from its package.json, independent of the pnpm store layout.
const pkgRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const outDir = join(process.cwd(), "public", "pdfjs");
mkdirSync(outDir, { recursive: true });

const files = ["pdf.min.mjs", "pdf.worker.min.mjs"];
for (const file of files) {
  const vendor = readFileSync(join(pkgRoot, "legacy", "build", file), "utf8");
  // Prefix, then the vendor bytes untouched: the polyfill has to be defined before pdf.js's first
  // line runs, and nothing below it may be rewritten — the test asserts byte equality on the rest.
  writeFileSync(join(outDir, file), PDFJS_BROWSER_POLYFILL + vendor);
  const carries = vendor.includes("withResolvers:function withResolvers()");
  console.log(
    `sync-pdfjs-assets: wrote public/pdfjs/${file} — polyfill v${PDFJS_POLYFILL_VERSION} + legacy/build/${file} ` +
      `(vendor ships its own withResolvers polyfill: ${carries ? "yes, ours no-ops" : "NO, ours is what keeps old phone browsers working"})`,
  );
}
console.log(`sync-pdfjs-assets: done (pdfjs-dist ${require("pdfjs-dist/package.json").version}).`);
