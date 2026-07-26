// Regenerates the committed pdf.js browser assets under public/pdfjs/ from the currently
// installed pdfjs-dist version. Run after bumping pdfjs-dist in package.json:
//
//   node scripts/sync-pdfjs-assets.mjs
//
// The recruitment CV viewer (src/components/recruitment/cv-preview-modal.tsx) loads these two
// files as same-origin static assets via a native (webpackIgnore) import, so they must stay in
// sync with the pinned pdfjs-dist version that provides its API types. They are committed (not
// generated at build time) so a bundler/install quirk can never leave the viewer without them —
// same posture as public/OneSignalSDKWorker.js. This script just re-copies them; commit the diff.

import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
// Resolve pdfjs-dist's package root from its package.json, independent of the pnpm store layout.
const pkgRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const outDir = join(process.cwd(), "public", "pdfjs");
mkdirSync(outDir, { recursive: true });

const files = ["pdf.min.mjs", "pdf.worker.min.mjs"];
for (const file of files) {
  copyFileSync(join(pkgRoot, "build", file), join(outDir, file));
  console.log(`sync-pdfjs-assets: copied build/${file} -> public/pdfjs/${file}`);
}
console.log(`sync-pdfjs-assets: done (pdfjs-dist ${require("pdfjs-dist/package.json").version}).`);
