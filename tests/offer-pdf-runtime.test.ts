import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveChromiumPath } from "@/lib/offers/pdf";

import { RUNTIME_EXTRAS_DIR, lockedImporterVersion } from "../scripts/sync-runtime-extras.mjs";

/**
 * The two things that decide whether an offer arrives WITH its PDF attached in production.
 *
 * Neither of them can be caught by typecheck, lint, or a browser reload, and neither fails loudly:
 * `sendOfferEmail` degrades to a body-only email when the PDF cannot be produced, so a broken
 * runtime does not throw — it just quietly stops attaching the letter to offers of employment.
 * These assertions are the only place either mistake becomes visible before a candidate notices.
 *
 * 1. THE DRIVER VERSION. The Dockerfile installs puppeteer-core into the runtime image (Next's
 *    standalone trace cannot follow the dynamic import that loads it). It had drifted two majors —
 *    23.11.1 in the image against ^25.3.0 in the manifest — the whole time nothing called puppeteer,
 *    and on 2026-10-23 it was still 25.13.0 in the image against 25.15.0 in pnpm-lock.yaml (audit
 *    F-22). Since that day the image installs it with `npm ci` from infra/runtime-extras, and the
 *    version there must equal the one pnpm-lock.yaml resolves — the one every test here runs.
 *
 * 2. THE BROWSER PATH. `PUPPETEER_EXECUTABLE_PATH` is set to `/usr/bin/chromium-browser`, the name
 *    Alpine used up to 3.18. `apk add chromium` on the 3.2x that `node:24-alpine` is built from
 *    installs `/usr/bin/chromium`. Nothing in this repository can prove which one exists inside
 *    that image, so the resolver checks disk instead of trusting either.
 */
export async function runOfferPdfRuntimeTests(): Promise<void> {
  // Bare relative paths, like every other source-reading test here — the runner is always invoked
  // from the repo root.
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  // ── 1. the pin matches the manifest ────────────────────────────────────────────────────────
  const declared = manifest.dependencies?.["puppeteer-core"] ?? manifest.devDependencies?.["puppeteer-core"];
  assert.ok(
    declared,
    "package.json no longer declares puppeteer-core, but the Dockerfile still installs it and "
      + "src/lib/offers/pdf.ts still imports it — one of the three is wrong.",
  );
  const expected = declared.replace(/^[\^~>=<\s]+/, "").trim();
  assert.match(
    expected,
    /^\d+\.\d+\.\d+$/,
    `puppeteer-core is declared as "${declared}", which does not reduce to a single version this `
      + "test can pin the image against. Declare an exact version or a caret over one.",
  );

  const extras = JSON.parse(readFileSync(`${RUNTIME_EXTRAS_DIR}/package.json`, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const pinned = extras.dependencies?.["puppeteer-core"] ?? null;
  assert.ok(pinned, `${RUNTIME_EXTRAS_DIR} no longer installs a pinned puppeteer-core into the runtime image.`);
  assert.match(dockerfile, /\bnpm ci\b/, "the Dockerfile no longer installs the runtime extras (puppeteer-core) with npm ci.");
  const locked = lockedImporterVersion(readFileSync("pnpm-lock.yaml", "utf8"), "puppeteer-core");
  assert.equal(
    pinned,
    locked,
    `the image installs puppeteer-core@${pinned} but pnpm-lock.yaml resolves ${locked}. `
      + "Production would render offer PDFs with a driver nobody ran this code against. "
      + "Run `node scripts/sync-runtime-extras.mjs`.",
  );
  // And it sits inside package.json's declared range (a caret over `expected`): same major, not below it.
  const [pinnedMajor, pinnedMinor, pinnedPatch] = pinned.split(".").map(Number);
  const [floorMajor, floorMinor, floorPatch] = expected.split(".").map(Number);
  assert.ok(
    pinnedMajor === floorMajor
      && (pinnedMinor > floorMinor || (pinnedMinor === floorMinor && pinnedPatch >= floorPatch)),
    `the image installs puppeteer-core@${pinned}, outside package.json's ${declared}.`,
  );

  // The path the resolver falls back FROM has to still be the one the image sets, or the fallback
  // list below is guarding a hazard that no longer exists.
  assert.match(
    dockerfile,
    /ENV PUPPETEER_EXECUTABLE_PATH=\/usr\/bin\/chromium(-browser)?/,
    "the Dockerfile no longer points PUPPETEER_EXECUTABLE_PATH at a system Chromium.",
  );
  assert.match(dockerfile, /apk add[^\n]*(\n[^\n]*)*?chromium/, "the runtime image no longer installs chromium.");

  // ── 2. the browser path is probed, not assumed ─────────────────────────────────────────────
  const onDisk = (...present: string[]) => (candidate: string) => present.includes(candidate);

  assert.equal(
    resolveChromiumPath(onDisk("/usr/bin/chromium-browser"), "/usr/bin/chromium-browser"),
    "/usr/bin/chromium-browser",
    "a configured path that exists must win — this is the pre-Alpine-3.19 image and it is correct.",
  );

  // THE CASE THIS EXISTS FOR: the image sets the old name, the package installed the new one.
  assert.equal(
    resolveChromiumPath(onDisk("/usr/bin/chromium"), "/usr/bin/chromium-browser"),
    "/usr/bin/chromium",
    "when the configured path is absent and /usr/bin/chromium is present, the real binary must be "
      + "found — otherwise every offer in production ships with no PDF attached and no error.",
  );

  assert.equal(
    resolveChromiumPath(onDisk("/usr/bin/google-chrome"), ""),
    "/usr/bin/google-chrome",
    "an unset env var must still find a Chrome that is on disk.",
  );

  assert.equal(
    resolveChromiumPath(onDisk(), "/opt/custom/chrome"),
    "/opt/custom/chrome",
    "when nothing is on disk the configured path is handed back regardless, so the launch error "
      + "names the path that was expected instead of a bare 'Could not find browser'.",
  );

  assert.equal(
    resolveChromiumPath(onDisk(), ""),
    undefined,
    "local dev on Windows/macOS configures nothing and has none of the Linux paths — the resolver "
      + "must return undefined there so puppeteer-core runs its own channel discovery.",
  );

  // A resolver that just echoed its input would pass every case above except this one.
  assert.equal(
    resolveChromiumPath(onDisk("/usr/bin/chromium"), ""),
    "/usr/bin/chromium",
    "with nothing configured, the known Alpine location must still be probed.",
  );
}
