import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * The @napi-rs/canvas native addon must be REACHABLE in Next's standalone production build.
 *
 * THE BUG (found 2026-08-22 in a live Railway log). pdf-parse reaches @napi-rs/canvas through a
 * runtime createRequire that Next's tracer cannot follow, so the addon never entered
 * `.next/standalone` — and the Dockerfile's runner stage copies only that directory:
 *
 *   Warning: Cannot load "@napi-rs/canvas" package: "Error: Cannot find module '@napi-rs/canvas'
 *
 * getText() is unaffected (it never rasterizes), so CV text extraction kept working. getImage() —
 * how cv-ocr.ts pulls the pages out of a SCANNED PDF for free OCR — throws, and cv-ocr.ts turns any
 * failure into a null, so the free-OCR safety net was silently absent in production. It exists for
 * when the vision model is down, rate-limited or out of credit, so it was gone at the one moment it
 * was needed.
 *
 * THE FIRST FIX SHIPPED AND DID NOTHING (#2299), which is why this test asserts what it does.
 * Tracing an include copies real FILES (glob with `nodir: true`), never pnpm's symlinks. Under
 * pnpm a TRANSITIVE package is reachable only through symlinks — the one pdfjs-dist uses to see the
 * wrapper, and the one the wrapper uses to see its own Skia binary — and neither is recreated in
 * standalone. So the bytes shipped and production threw the identical MODULE_NOT_FOUND. Hoisting via
 * publicHoistPattern puts both packages in the ROOT node_modules, where Node's ordinary walk-up
 * finds them.
 *
 * Both halves are load-bearing and BOTH are asserted below, because either alone ships green and
 * broken:
 *   1. the hoist, or the root path does not exist at all;
 *   2. a glob that actually MATCHES it — `@napi-rs/**` matches ZERO files, since `**` does not
 *      traverse a symlinked directory. Only `@napi-rs/*\/**` works. A glob matching nothing is
 *      indistinguishable from a correct one by inspection, which is exactly how #2299 passed review.
 *
 * The last assertion therefore runs the config's own globs through NEXT'S OWN glob implementation
 * and requires real files back. Nothing weaker can tell a working entry from a decorative one.
 *
 * WHY THIS READS SOURCE rather than importing next.config.ts: that module evaluates `__dirname`,
 * which does not exist under the ESM test runner. Same reason csp-headers.test.ts reads source.
 */
export async function runPdfCanvasTraceTests() {
  const repoUrl = (relative: string) => new URL(`../${relative}`, import.meta.url);
  const repoPath = (relative: string) => fileURLToPath(repoUrl(relative));
  const config = readFileSync(repoUrl("next.config.ts"), "utf8");

  // ── Parse the "/api/**/*" trace list out of next.config.ts ─────────────────
  const block = /outputFileTracingIncludes:\s*\{([\s\S]*?)\n\s{2}\},/.exec(config);
  assert.ok(block, "next.config.ts must still declare outputFileTracingIncludes");
  const apiEntry = /"\/api\/\*\*\/\*"\s*:\s*\[([\s\S]*?)\]/.exec(block[1]);
  assert.ok(apiEntry, 'outputFileTracingIncludes must still carry a "/api/**/*" key — the CV routes live there');
  const globs = [...apiEntry[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(globs.length >= 4, "the /api trace list must not have been emptied");

  // ── 1. The hoist ───────────────────────────────────────────────────────────
  // Without it there is no root path to trace, and no amount of glob-fixing helps.
  const workspace = readFileSync(repoUrl("pnpm-workspace.yaml"), "utf8");
  assert.match(
    workspace,
    /publicHoistPattern:\s*\n\s*-\s*"@napi-rs\/\*"/,
    "pnpm-workspace.yaml must hoist @napi-rs/* — a transitive package is otherwise unreachable in .next/standalone",
  );
  assert.ok(
    existsSync(repoPath("node_modules/@napi-rs/canvas/index.js")),
    "@napi-rs/canvas must be hoisted to the root node_modules — re-run pnpm install if this fails locally",
  );

  // The platform binary must be hoisted alongside it: the wrapper loads it BY PACKAGE NAME, so it
  // needs the same walk-up treatment. Its name is platform-specific (musl in production, gnu on CI,
  // msvc locally), so this checks for any sibling carrying a native addon rather than a fixed name.
  const hoisted = readdirSync(repoPath("node_modules/@napi-rs"));
  const platformPackages = hoisted.filter((name) => name.startsWith("canvas-"));
  assert.ok(
    platformPackages.length > 0,
    `@napi-rs/canvas's platform binary package must be hoisted too, found only: ${hoisted.join(", ")}`,
  );

  // ── 2. The premise ─────────────────────────────────────────────────────────
  // If pdf-parse ever stops depending on canvas, all of this becomes dead weight and should go.
  const pdfParsePkg = JSON.parse(readFileSync(repoPath("node_modules/pdf-parse/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.ok(
    pdfParsePkg.dependencies?.["@napi-rs/canvas"],
    "pdf-parse no longer depends on @napi-rs/canvas — re-check whether the trace entries are still needed",
  );

  // ── 3. THE HEADLINE: the globs must MATCH, not merely exist ────────────────
  // Run them through the same glob Next runs, with the same options
  // (collect-build-traces.js: `globOrig(pattern, { cwd: dir, nodir: true, dot: true })`).
  const require_ = createRequire(import.meta.url);
  let globOrig: (p: string, o: object, cb: (e: unknown, f: string[]) => void) => void;
  try {
    globOrig = require_("next/dist/compiled/glob");
  } catch {
    assert.fail("next/dist/compiled/glob has moved — update this test to whatever collect-build-traces.js now uses");
  }
  const runGlob = (pattern: string) =>
    new Promise<string[]>((resolve, reject) => {
      globOrig(pattern, { cwd: repoPath("."), nodir: true, dot: true }, (error, files) =>
        error ? reject(error) : resolve(files),
      );
    });

  const matched = (await Promise.all(globs.map((glob) => runGlob(glob)))).flat().map((file) => file.replace(/\\/g, "/"));

  assert.ok(
    matched.some((file) => file.endsWith("node_modules/@napi-rs/canvas/index.js")),
    "the trace globs must actually RESOLVE the hoisted @napi-rs/canvas — a glob that matches nothing is how #2299 shipped green and broken",
  );
  assert.ok(
    matched.some((file) => file.includes("node_modules/@napi-rs/canvas-") && file.endsWith(".node")),
    "the trace globs must also resolve the native Skia binary — the wrapper alone cannot render anything",
  );

  // ── 4. The offer signatory's signature ─────────────────────────────────────
  // Same failure mode, different file. It is deliberately NOT in `public/` — the offer email never
  // fetches it (it points at the attached PDF instead), so keeping a real signature off the public
  // site costs nothing. The price is that the Dockerfile copies `public/` wholesale and `assets/`
  // not at all, so this file reaches production ONLY through the trace list. If the glob stops
  // matching, every offer silently prints UNSIGNED: `satoSignatureDataUri()` returns null on a read
  // failure and the letter renders with a bare rule — which nobody would catch before it reached a
  // candidate.
  assert.ok(
    matched.some((file) => file.endsWith("assets/brand/signature-omar-anwar-gawish.png")),
    "the trace globs must resolve the offer signature — without it every offer PDF prints unsigned in production",
  );
}
