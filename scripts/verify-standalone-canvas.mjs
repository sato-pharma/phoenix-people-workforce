/**
 * Post-build gate: prove @napi-rs/canvas is RESOLVABLE inside .next/standalone.
 *
 * This exists because a fix shipped to production on 2026-08-22 (#2299) that was correct in every
 * way a PR can check — right globs, matching files, green CI — and changed nothing, because tracing
 * copies real FILES and never pnpm's symlinks. The bytes arrived somewhere nothing could require
 * them from, and the only place that was observable was a Railway boot log, after the deploy.
 *
 * Nothing short of asking the built artifact settles it, so that is what this does: it performs the
 * exact resolution production performs — `require('@napi-rs/canvas')` from pdfjs-dist's own file
 * inside the standalone tree — and fails the build if it throws.
 *
 * Run after `next build` (see the validate job in .github/workflows/ci.yml).
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

function fail(message) {
  console.error(`\n  FAIL  ${message}\n`);
  process.exit(1);
}

if (!existsSync(standalone)) {
  fail(
    `.next/standalone does not exist. This gate must run AFTER \`next build\`, and next.config.ts must keep output: "standalone".`,
  );
}

const nodeModules = path.join(standalone, "node_modules");
const pnpmDir = path.join(nodeModules, ".pnpm");
if (!existsSync(pnpmDir)) fail(`${pnpmDir} is missing — the standalone layout changed; this gate needs updating.`);

// 1. The wrapper must be present at the hoisted ROOT path. Its .pnpm path is NOT enough: that is
//    precisely what #2299 shipped, and pdfjs cannot reach it there.
const wrapper = path.join(nodeModules, "@napi-rs", "canvas", "index.js");
if (!existsSync(wrapper)) {
  fail(
    `@napi-rs/canvas is not at node_modules/@napi-rs/canvas inside .next/standalone.\n` +
      `        Check publicHoistPattern in pnpm-workspace.yaml and the "./node_modules/@napi-rs/*/**"\n` +
      `        entry in next.config.ts — note that "@napi-rs/**" matches ZERO files, because ** does\n` +
      `        not traverse a symlinked directory.`,
  );
}

// 2. The native Skia binary must be there too — the wrapper loads it by package name, so it needs
//    the same treatment. Its name is platform-specific (musl in the Alpine production image).
const scope = readdirSync(path.join(nodeModules, "@napi-rs"));
const platformPackages = scope.filter((name) => name.startsWith("canvas-"));
const binaries = platformPackages.flatMap((name) =>
  readdirSync(path.join(nodeModules, "@napi-rs", name))
    .filter((file) => file.endsWith(".node"))
    .map((file) => `${name}/${file}`),
);
if (binaries.length === 0) {
  fail(
    `@napi-rs/canvas's native binary is missing from .next/standalone (found in the scope: ${scope.join(", ") || "nothing"}).\n` +
      `        The wrapper alone cannot decode an image, so scanned-CV OCR would still fail in production.`,
  );
}

// 3. THE REAL QUESTION. Resolve exactly as production does — from pdfjs-dist's own module, which is
//    where the runtime createRequire actually runs. Existence proved nothing last time; reachability
//    is the whole bug.
const pdfjsDir = readdirSync(pnpmDir).find((name) => name.startsWith("pdfjs-dist@"));
if (!pdfjsDir) fail("pdfjs-dist is not in .next/standalone at all — CV extraction cannot work; investigate the build.");
const pdfjsEntry = path.join(pnpmDir, pdfjsDir, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs");
if (!existsSync(pdfjsEntry)) fail(`${pdfjsEntry} is missing — pdfjs-dist's legacy build did not survive tracing.`);

let resolved;
try {
  resolved = createRequire(pdfjsEntry).resolve("@napi-rs/canvas");
} catch (error) {
  fail(
    `pdfjs-dist CANNOT resolve @napi-rs/canvas inside .next/standalone (${error.code ?? "error"}).\n` +
      `        This is the exact production failure: Cannot load "@napi-rs/canvas" package.\n` +
      `        The files may well be present — being present is not the same as being reachable.`,
  );
}

console.log(`  OK  @napi-rs/canvas resolves from pdfjs-dist inside .next/standalone`);
console.log(`      -> ${path.relative(standalone, resolved)}`);
console.log(`      native binary: ${binaries.join(", ")}`);
