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
//
// Since pdfjs-dist 6 it also copies `wasm/`, and that is not an optimization. pdf.js 6 moved the
// JBIG2 and CCITTFax decoders out of the JS bundle into jbig2.wasm, joining the JPEG2000 and ICC
// modules that were already external. CCITT Group 3/4 is how a scanned or faxed page is encoded,
// which is a large share of the CVs this app exists to read, and the library fetches those modules
// from the `wasmUrl` the viewer passes (`/pdfjs/wasm/`). Without them a scanned CV renders blank
// while an ordinary one looks perfect — the same shape of half-invisible failure as 2026-09-14.
// The directory is copied WHOLE, licences included, because we redistribute those binaries.
// Pinned by tests/pdfjs-legacy-browser-assets.test.ts.

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { PDFJS_BROWSER_POLYFILL, PDFJS_POLYFILL_VERSION } from "./pdfjs-browser-polyfill.mjs";

import { refuseArguments } from "./lib/refuse-arguments.mjs";

// This script takes no arguments, so it says so instead of ignoring one (scripts/lib/refuse-arguments.mjs).
refuseArguments({
  name: "sync-pdfjs-assets",
  usage: `sync-pdfjs-assets: regenerate the committed pdf.js assets under public/pdfjs/ from the
installed pdfjs-dist. Run it after bumping pdfjs-dist, and commit the diff it writes.

  node scripts/sync-pdfjs-assets.mjs      rewrite public/pdfjs/
  node scripts/sync-pdfjs-assets.mjs -h   this text

It takes no arguments: the version comes from the installed pdfjs-dist, and PHX_PDFJS_DIST_ROOT
overrides where that is read from.`,
  hints: [
    "the source directory is the env override PHX_PDFJS_DIST_ROOT, not an argument",
  ],
});

const require = createRequire(import.meta.url);
// Resolve pdfjs-dist's package root from its package.json, independent of the pnpm store layout.
// PHX_PDFJS_DIST_ROOT points this at an unpacked candidate instead — the same override
// tests/pdfjs-legacy-browser-assets.test.ts carries, and for the same reason: it is how a new major
// is judged, and its assets produced, before it is ever allowed near the lockfile. Nothing sets it
// in normal use.
const pkgRoot = process.env.PHX_PDFJS_DIST_ROOT || dirname(require.resolve("pdfjs-dist/package.json"));
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
// The wasm decoders, copied whole and byte-for-byte. Cleared first so a file the vendor DROPPED in
// a later version cannot linger here and be served forever — the committed directory is a mirror of
// the pinned version's own, nothing more.
const wasmSrc = join(pkgRoot, "wasm");
const wasmOut = join(outDir, "wasm");
rmSync(wasmOut, { recursive: true, force: true });
cpSync(wasmSrc, wasmOut, { recursive: true });
const wasmFiles = readdirSync(wasmOut).sort();
const wasmBytes = wasmFiles.reduce((total, name) => total + statSync(join(wasmOut, name)).size, 0);
console.log(
  `sync-pdfjs-assets: wrote public/pdfjs/wasm/ — ${wasmFiles.length} files, ${wasmBytes} bytes ` +
    `(${wasmFiles.join(", ")})`,
);

const version = process.env.PHX_PDFJS_DIST_ROOT
  ? String(JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version)
  : require("pdfjs-dist/package.json").version;
console.log(`sync-pdfjs-assets: done (pdfjs-dist ${version}).`);
