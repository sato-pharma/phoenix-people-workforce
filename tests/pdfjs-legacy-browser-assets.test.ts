import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * On 2026-09-14 managers across the field opened a CV and got "Promise.withResolvers is not a
 * function" instead of the page. public/pdfjs/ held pdf.js's MODERN build, which calls that
 * built-in with no fallback, so every phone browser older than roughly Chrome 119 / Safari 17.4
 * (older Samsung Internet included) could not render a single PDF. The legacy build carries the
 * same API with core-js polyfills inside both files. These pin the served assets — the emitted
 * files, not the sync script's intent — to that legacy build.
 */
export function runPdfjsLegacyBrowserAssetsTests() {
  const require = createRequire(import.meta.url);
  const pkgRoot = dirname(require.resolve("pdfjs-dist/package.json"));
  const publicDir = join(process.cwd(), "public", "pdfjs");

  for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
    const served = readFileSync(join(publicDir, file), "utf8");

    // Both the library and its worker call Promise.withResolvers, and a worker runs in its own
    // global — so each file must define the polyfill itself.
    assert.ok(
      served.includes("withResolvers:function withResolvers()"),
      `public/pdfjs/${file} carries no Promise.withResolvers polyfill — it is the modern pdf.js build, which fails on older phone browsers. Run node scripts/sync-pdfjs-assets.mjs`,
    );

    // And it is exactly the installed version's legacy file, so the API types the viewer imports
    // (pdfjs-dist/legacy/build/pdf.mjs) describe the code that actually runs.
    const legacy = readFileSync(join(pkgRoot, "legacy", "build", file), "utf8");
    assert.ok(
      served === legacy,
      `public/pdfjs/${file} is not the installed pdfjs-dist legacy/build/${file}. Run node scripts/sync-pdfjs-assets.mjs`,
    );
  }

  const syncScript = readFileSync(join(process.cwd(), "scripts", "sync-pdfjs-assets.mjs"), "utf8");
  assert.match(
    syncScript,
    /join\(pkgRoot, "legacy", "build", file\)/,
    "scripts/sync-pdfjs-assets.mjs must copy from legacy/build, or the next version bump reintroduces the modern build",
  );
}
