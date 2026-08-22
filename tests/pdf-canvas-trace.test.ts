import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The @napi-rs/canvas native addon must survive Next's production file-tracing.
 *
 * THE BUG THIS PINS (found 2026-08-22 in a live Railway log). pdf-parse reaches @napi-rs/canvas
 * through a runtime createRequire, which Next's tracer cannot follow, so the addon was never copied
 * into `.next/standalone` — and the Dockerfile's runner stage copies ONLY that directory. The
 * package is a real dependency of pdf-parse and resolves fine on a dev machine, so this failed
 * exclusively in production:
 *
 *   Warning: Cannot load "@napi-rs/canvas" package: "Error: Cannot find module '@napi-rs/canvas'
 *
 * getText() (all CV text extraction) is unaffected because it never rasterizes. getImage() — how
 * cv-ocr.ts pulls the pages out of a SCANNED PDF for free OCR — throws, and cv-ocr.ts turns any
 * failure into a null, so the free-OCR safety net was simply absent in production with nothing said.
 * That net exists for exactly the case where the vision model is down, rate-limited or out of
 * credit, so it was missing at the one moment it was needed.
 *
 * This is the THIRD instance of the same tracer gap in this one dependency (DOMMatrix →
 * pdf-dommatrix-polyfill.ts; pdf.worker.mjs → outputFileTracingIncludes), which is why it is worth a
 * test rather than another comment.
 *
 * WHY THIS READS SOURCE rather than importing next.config.ts: that module evaluates `__dirname`,
 * which does not exist under the ESM test runner, so importing it throws. Same reason
 * csp-headers.test.ts reads source.
 *
 * The load-bearing assertion is the LAST one, and it is derived rather than hardcoded: the platform
 * binary's package name is read out of the installed @napi-rs/canvas loader, so if a pdf-parse bump
 * renames or restructures the platform packages, this test fails instead of production going quiet
 * again.
 */
export function runPdfCanvasTraceTests() {
  const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  const pnpmDir = fileURLToPath(new URL("../node_modules/.pnpm", import.meta.url));

  // ── Parse the "/api/**/*" trace list out of next.config.ts ─────────────────
  const block = /outputFileTracingIncludes:\s*\{([\s\S]*?)\n\s{2}\},/.exec(config);
  assert.ok(block, "next.config.ts must still declare outputFileTracingIncludes");
  const apiEntry = /"\/api\/\*\*\/\*"\s*:\s*\[([\s\S]*?)\]/.exec(block[1]);
  assert.ok(apiEntry, 'outputFileTracingIncludes must still carry a "/api/**/*" key — the CV routes live there');
  const globs = [...apiEntry[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(globs.length >= 4, "the /api trace list must not have been emptied");

  /**
   * Wildcard match, no regex compilation: every literal run between the `*`s must appear in order,
   * with the first anchored at the start. A half-matching prefix — the typo actually worth catching
   * here — fails, because a later literal run will not be found.
   */
  const matches = (glob: string, path: string) => {
    const parts = glob.replace(/^[.][/]/, "").split(/[*]+/);
    let cursor = 0;
    for (const [index, part] of parts.entries()) {
      if (part === "") continue;
      if (index === 0) {
        if (!path.startsWith(part)) return false;
        cursor = part.length;
        continue;
      }
      const at = path.indexOf(part, cursor);
      if (at < 0) return false;
      cursor = at + part.length;
    }
    return true;
  };

  // ── The wrapper package ────────────────────────────────────────────────────
  // Resolve what pnpm ACTUALLY installed, then require a glob to match it. A hardcoded version in
  // the config would rot on the next pdf-parse bump; a glob matching nothing would be silent.
  const canvasDir = readdirSync(pnpmDir).find((name) => name.startsWith("@napi-rs+canvas@"));
  assert.ok(canvasDir, "@napi-rs/canvas must be installed — it is a direct dependency of pdf-parse");
  const canvasRel = `node_modules/.pnpm/${canvasDir}/node_modules/@napi-rs/canvas/index.js`;
  assert.ok(
    existsSync(fileURLToPath(new URL(`../${canvasRel}`, import.meta.url))),
    "the installed @napi-rs/canvas layout changed — the trace globs are keyed on it",
  );
  assert.ok(
    globs.some((glob) => matches(glob, canvasRel)),
    "the @napi-rs/canvas JS wrapper must be traced into .next/standalone, or pdf-parse getImage() cannot load",
  );

  // ── The premise ────────────────────────────────────────────────────────────
  // If pdf-parse ever stops depending on canvas, these entries become dead weight and should go.
  const pdfParseDir = readdirSync(pnpmDir).find((name) => name.startsWith("pdf-parse@"));
  assert.ok(pdfParseDir, "pdf-parse must be installed");
  const pdfParsePkg = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../node_modules/.pnpm/${pdfParseDir}/node_modules/pdf-parse/package.json`, import.meta.url),
      ),
      "utf8",
    ),
  ) as { dependencies?: Record<string, string> };
  assert.ok(
    pdfParsePkg.dependencies?.["@napi-rs/canvas"],
    "pdf-parse no longer depends on @napi-rs/canvas — re-check whether these trace entries are still needed",
  );

  // ── THE HEADLINE: the platform binary Alpine actually loads ────────────────
  // The wrapper is pure JS; the Skia binary lives in a separate per-platform package that
  // js-binding.js picks at runtime. Production is node:24-alpine, so that is the MUSL build — and
  // tracing only the wrapper would fail in production exactly as before, one require deeper.
  const jsBinding = readFileSync(
    fileURLToPath(new URL(`../${canvasRel.replace("index.js", "js-binding.js")}`, import.meta.url)),
    "utf8",
  );
  const muslPackage = /require\('(@napi-rs\/canvas-linux-x64-musl)'\)/.exec(jsBinding)?.[1];
  assert.ok(
    muslPackage,
    "@napi-rs/canvas no longer loads a linux-x64-musl platform package — the production trace entry must be renamed to whatever replaced it",
  );
  assert.ok(
    globs.some((glob) => glob.includes(muslPackage)),
    "the musl canvas binary the Alpine production image loads must be traced into .next/standalone",
  );
}
