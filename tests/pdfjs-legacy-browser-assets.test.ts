import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  PDFJS_BROWSER_POLYFILL,
  PDFJS_POLYFILL_VERSION,
  PDFJS_POLYFILLED_BUILTINS,
} from "../scripts/pdfjs-browser-polyfill.mjs";

/**
 * On 2026-09-14 managers across the field opened a CV and got "Promise.withResolvers is not a
 * function" instead of the page. public/pdfjs/ held pdf.js's MODERN build, which calls that
 * built-in with no fallback, so every phone browser older than roughly Chrome 119 / Safari 17.4
 * (older Samsung Internet included) could not render a single PDF.
 *
 * The answer that day was the LEGACY build, which carries core-js polyfills inside both files.
 * pdfjs-dist 6 then showed that answer was only half of one: 6.3.289's legacy build still bundles
 * core-js but no longer includes the Promise.withResolvers polyfill, while calling it 27 times in
 * pdf.min.mjs and 14 in the worker. So we now carry the fallback ourselves, prepended into each
 * served file by scripts/sync-pdfjs-assets.mjs.
 *
 * These pin the EMITTED files — what the browser actually downloads, not the sync script's intent:
 *   1. each served file opens with exactly our polyfill,
 *   2. everything after it is the installed version's legacy build, byte for byte,
 *   3. and no built-in the vendor build CALLS is left defined by nobody.
 * (3) is the one that generalises: it is what would have caught pdfjs 6 the morning it was
 * proposed, instead of a field outage.
 */
export function runPdfjsLegacyBrowserAssetsTests() {
  const require = createRequire(import.meta.url);
  // Normally the installed pdfjs-dist. PHX_PDFJS_DIST_ROOT points this at an unpacked candidate
  // tarball instead, so a version can be put through check (3) BEFORE it is installed — which is
  // how pdfjs-dist 6 was assessed without ever letting it near the lockfile. Nothing sets it in
  // CI or in any script; it only changes which vendor build is read, never what is required of
  // the served files.
  const candidateRoot = process.env.PHX_PDFJS_DIST_ROOT;
  const pkgRoot = candidateRoot ?? dirname(require.resolve("pdfjs-dist/package.json"));
  const publicDir = join(process.cwd(), "public", "pdfjs");
  const installedVersion = candidateRoot
    ? String(
        (JSON.parse(readFileSync(join(candidateRoot, "package.json"), "utf8")) as {
          version?: string;
        }).version ?? "unknown",
      )
    : String((require("pdfjs-dist/package.json") as { version?: string }).version ?? "unknown");

  for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
    const served = readFileSync(join(publicDir, file), "utf8");
    const vendor = readFileSync(join(pkgRoot, "legacy", "build", file), "utf8");

    // 1. The polyfill is FIRST, so it is defined before pdf.js's own first line runs. Both the
    //    library and its worker need it, and a worker has its own global — which is why it is
    //    prepended into each file rather than loaded once by the page.
    assert.ok(
      served.startsWith(PDFJS_BROWSER_POLYFILL),
      `public/pdfjs/${file} does not begin with the Phoenix pdf.js polyfill (v${PDFJS_POLYFILL_VERSION}). Run node scripts/sync-pdfjs-assets.mjs`,
    );

    // 2. And everything after it is the installed version's legacy file, untouched — so the API
    //    types the viewer imports (pdfjs-dist/legacy/build/pdf.mjs) describe the code that really
    //    runs, and nobody has hand-edited a vendor bundle.
    assert.equal(
      served.slice(PDFJS_BROWSER_POLYFILL.length),
      vendor,
      `public/pdfjs/${file} is not the polyfill followed by the installed pdfjs-dist ${installedVersion} legacy/build/${file}. Run node scripts/sync-pdfjs-assets.mjs`,
    );

    // 3. Whatever the vendor build calls, SOMEBODY defines — its own core-js, or us.
    //
    //    Detection reads core-js's two minified shapes, `name:function name(` and `name:function(`
    //    (it drops the inner name for reserved words like `try`). The list is deliberately
    //    curated: `Array.prototype.at` and `String.prototype.replaceAll` are NOT on it, because
    //    their call patterns also match ordinary methods of other objects and read as undefined
    //    even in 5.4.296 — the build that has served the field correctly since 2026-09-14 — so
    //    checking them would fail on a known-good build. Every entry below was verified to report
    //    truthfully against 5.4.296 before being added.
    const RISKY_BUILTINS: { label: string; calledBy: RegExp; definedAs: string; since: string }[] = [
      {
        label: "Promise.withResolvers",
        calledBy: /Promise\.withResolvers/g,
        definedAs: "withResolvers",
        since: "Chrome 119 / Safari 17.4",
      },
      {
        label: "Promise.try",
        calledBy: /Promise\.try\(/g,
        definedAs: "try",
        since: "Chrome 128 / Safari 18.2",
      },
      {
        label: "Array.prototype.findLast",
        calledBy: /\.findLast\(/g,
        definedAs: "findLast",
        since: "Chrome 97 / Safari 15.4",
      },
      {
        label: "Object/Map.groupBy",
        calledBy: /\.groupBy\(/g,
        definedAs: "groupBy",
        since: "Chrome 117 / Safari 17.4",
      },
      {
        label: "Array.prototype.toSorted",
        calledBy: /\.toSorted\(/g,
        definedAs: "toSorted",
        since: "Chrome 110 / Safari 16",
      },
      {
        label: "Set.prototype.union",
        calledBy: /\.union\(/g,
        definedAs: "union",
        since: "Chrome 122 / Safari 17",
      },
    ];

    // The vendor's core-js is read by ITS shape. Ours is not written that way — it installs each
    // built-in through Object.defineProperty, so pattern-matching core-js's shape against our own
    // source reports our polyfill as absent and fails a build we have in fact made safe. Ours is
    // therefore read from its declared list, and the list is held honest just below.
    const vendorDefines = (prop: string) =>
      vendor.includes(`${prop}:function ${prop}(`) || vendor.includes(`${prop}:function(`);

    for (const label of PDFJS_POLYFILLED_BUILTINS) {
      const prop = label.split(".").pop();
      assert.ok(
        PDFJS_BROWSER_POLYFILL.includes(`Object.defineProperty`) &&
          PDFJS_BROWSER_POLYFILL.includes(`"${prop}"`),
        `scripts/pdfjs-browser-polyfill.mjs lists ${label} as covered but its source never defines "${prop}" — the coverage list must not be able to lie, or a real gap reads as handled`,
      );
    }

    for (const builtin of RISKY_BUILTINS) {
      const calls = (vendor.match(builtin.calledBy) ?? []).length;
      if (calls === 0) continue;
      assert.ok(
        vendorDefines(builtin.definedAs) || PDFJS_POLYFILLED_BUILTINS.includes(builtin.label),
        `pdfjs-dist ${installedVersion}'s legacy/build/${file} calls ${builtin.label} ${calls} time(s) and NOTHING defines it — not its own core-js, not scripts/pdfjs-browser-polyfill.mjs. On a phone browser older than ${builtin.since} every CV stops opening, which is the 2026-09-14 outage. Cover ${builtin.label} in scripts/pdfjs-browser-polyfill.mjs before taking this version.`,
      );
    }
  }

  const syncScript = readFileSync(join(process.cwd(), "scripts", "sync-pdfjs-assets.mjs"), "utf8");
  assert.match(
    syncScript,
    /join\(pkgRoot, "legacy", "build", file\)/,
    "scripts/sync-pdfjs-assets.mjs must copy from legacy/build, or the next version bump reintroduces the modern build",
  );
  assert.match(
    syncScript,
    /PDFJS_BROWSER_POLYFILL \+ vendor/,
    "scripts/sync-pdfjs-assets.mjs must write the polyfill AHEAD of the vendor bytes, or the worker's global is left without it",
  );
}
