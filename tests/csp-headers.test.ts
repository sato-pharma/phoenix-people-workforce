import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Regression cover for the site-wide Content-Security-Policy.
 *
 * The CSP had no test at all, which is how this shipped: `script-src` was
 * missing `'wasm-unsafe-eval'`, so the Maps JavaScript API's vector renderer
 * threw "CompileError: call to WebAssembly.instantiate() blocked by CSP" on
 * every page that draws a map. That was 1,992 of 2,236 logged client errors
 * (89%) in the 14 days to 2026-08-09, across /employee-portals/submit-expense
 * and /admin/outstation/expense-command.
 *
 * It was invisible outside production because the non-production branch appends
 * 'unsafe-eval', which already implies WebAssembly compilation — so dev and
 * preview rendered maps fine while production did not.
 *
 * WHY THIS READS SOURCE RATHER THAN CALLING headers(): next.config.ts uses
 * `__dirname` (outputFileTracingRoot), which does not exist under a plain ESM
 * import, so the module cannot be loaded by the test runner. Next.js loads it
 * through its own pipeline. Rather than restructure a build config to suit a
 * test, this parses the script-src directive out of the file and asserts on its
 * tokens — so it still checks the policy's contents, not just that some string
 * appears somewhere in the file.
 */

const nextConfigSource = readFileSync(
  new URL("../next.config.ts", import.meta.url),
  "utf8",
);

/** The full `script-src ...` template literal as written in next.config.ts. */
function scriptSrcDirective(): string {
  const match = /`(script-src [^`]*)`/.exec(nextConfigSource);
  assert.ok(match, "next.config.ts must declare a script-src directive in the CSP array.");
  return match[1];
}

export function runCspHeaderTests() {
  const scriptSrc = scriptSrcDirective();

  // ── The regression this file exists for ────────────────────────────────────
  assert.ok(
    scriptSrc.includes("'wasm-unsafe-eval'"),
    "script-src must allow 'wasm-unsafe-eval' or the Google Maps vector renderer throws CompileError and every map-bearing page floods the error log.",
  );

  // 'wasm-unsafe-eval' must be unconditional, not inside the non-production
  // branch — production is the only environment where it was ever missing.
  const productionBranch = /\$\{isProduction \? "" : " 'unsafe-eval'"\}/.test(scriptSrc);
  assert.ok(
    productionBranch,
    "script-src must keep 'unsafe-eval' confined to non-production builds.",
  );
  const beforeInterpolation = scriptSrc.split("${")[0];
  assert.ok(
    beforeInterpolation.includes("'wasm-unsafe-eval'"),
    "'wasm-unsafe-eval' must sit in the unconditional part of script-src — putting it inside the non-production branch would leave production broken, which is the exact bug this guards.",
  );

  // Granting wasm compilation must not smuggle full JS eval into production.
  assert.ok(
    !/(^|\s)'unsafe-eval'/.test(beforeInterpolation),
    "script-src must not enable full 'unsafe-eval' unconditionally — 'wasm-unsafe-eval' covers WebAssembly without re-enabling eval().",
  );

  // The Maps JS API is loaded from these hosts (src/lib/google-maps/browser.ts).
  for (const host of ["https://maps.googleapis.com", "https://maps.gstatic.com"]) {
    assert.ok(
      scriptSrc.includes(host),
      `script-src must allow ${host} for the Maps JavaScript API.`,
    );
  }

  // OneSignal's JSONP-style sync script is a <script> tag, not a fetch — it must
  // be in script-src, not only connect-src. Push was dead for this reason once.
  for (const host of ["https://cdn.onesignal.com", "https://api.onesignal.com"]) {
    assert.ok(
      scriptSrc.includes(host),
      `script-src must allow ${host} or OneSignal.init() hangs and push never works.`,
    );
  }

  // ── Directives that must never quietly disappear ───────────────────────────
  for (const [directive, expected] of [
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
  ] as Array<[string, string]>) {
    assert.ok(
      new RegExp(`"${directive} ${expected.replace(/'/g, "'")}"`).test(nextConfigSource),
      `CSP must keep ${directive} ${expected}.`,
    );
  }

  assert.ok(
    nextConfigSource.includes("frame-ancestors"),
    "The CSP must declare frame-ancestors so the app cannot be framed.",
  );

  // The Maps JS API injects its own Google Sans stylesheet and font files.
  assert.ok(
    /"style-src [^"]*https:\/\/fonts\.googleapis\.com/.test(nextConfigSource),
    "style-src must allow Google's font stylesheet host for the Maps JS API controls.",
  );
  assert.ok(
    /"font-src [^"]*https:\/\/fonts\.gstatic\.com/.test(nextConfigSource),
    "font-src must allow Google's font file host for the Maps JS API controls.",
  );
}
