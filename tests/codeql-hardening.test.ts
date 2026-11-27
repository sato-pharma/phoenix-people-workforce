import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { bareMessageId } from "../src/lib/email/brevo-webhook-events.ts";
import { DOM_TRANSLATE_GUARD_BOOT_SCRIPT } from "../src/lib/error-monitor/dom-translate-guard.ts";
import { downloadFromApiRoute, sameOriginApiPath } from "../src/lib/navigation/browser-navigation.ts";
import { normalizeSpeciality } from "../src/lib/phoenix-crm/speciality-list.ts";
import { findLinkedInUrl } from "../src/lib/recruitment/linkedin-profile.ts";
import { CSP_NONCE_CAPTURE_BOOT_SCRIPT } from "../src/lib/security/csp-nonce.ts";
import { inlineScriptLiteral } from "../src/lib/security/inline-script-literal.ts";

/** How long one call may take on an input built to be slow for a backtracking pattern. */
const LINEAR_BUDGET_MS = 250;

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

/** The source of one boot-script constant: from its declaration to the closing backtick and semicolon. */
function bootScriptSource(file: string, declaration: string): string {
  const source = readFileSync(file, "utf8");
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${file} still declares ${declaration}`);
  const end = source.indexOf("`;", start);
  assert.ok(end > start, `${declaration} in ${file} ends with a closing backtick`);
  return source.slice(start, end);
}

/**
 * The code-scanning hardening of 27 Nov 2026: inline boot scripts write their values through one
 * escaper, two text clean-ups trim with loops instead of a backtracking pattern, the LinkedIn slug is
 * cut with an anchored host, and a download button only ever follows a path under /api/ on this site.
 */
export function runCodeqlHardeningTests() {
  // 1. The inline-script literal reads back as the same value, and never closes the script.
  const awkward = ["</script><!--", "a\u2028b\u2029c", "line\nbreak\ttab", { key: "<b>" }, 42, null];
  for (const value of awkward) {
    const literal = inlineScriptLiteral(value);
    assert.ok(!literal.includes("<"), `the literal for ${JSON.stringify(value)} carries no raw "<"`);
    assert.ok(!literal.includes(">"), `the literal for ${JSON.stringify(value)} carries no raw ">"`);
    assert.ok(!/[\u2028\u2029\n\r]/.test(literal), "the literal carries no raw line break or line separator");
    assert.equal(JSON.stringify(runInNewContext(`(${literal})`)), JSON.stringify(value), "the literal reads back as exactly the same value");
  }
  assert.equal(inlineScriptLiteral("phx-display-scale"), JSON.stringify("phx-display-scale"), "a plain constant is written byte for byte as before");

  // 2. Every boot script writes its values through that escaper, never a bare JSON.stringify.
  const bootScripts: Array<[string, string]> = [
    ["app/layout.tsx", "const DISPLAY_SCALE_BOOT_SCRIPT ="],
    ["src/lib/security/csp-nonce.ts", "export const CSP_NONCE_CAPTURE_BOOT_SCRIPT ="],
    ["src/lib/error-monitor/dom-translate-guard.ts", "export const DOM_TRANSLATE_GUARD_BOOT_SCRIPT ="],
  ];
  for (const [file, declaration] of bootScripts) {
    const script = bootScriptSource(file, declaration);
    assert.ok(!script.includes("JSON.stringify("), `${declaration.split(" ").at(-2)} writes no value with a bare JSON.stringify`);
    assert.ok(script.includes("inlineScriptLiteral("), `${declaration.split(" ").at(-2)} writes its values with inlineScriptLiteral`);
  }
  for (const script of [CSP_NONCE_CAPTURE_BOOT_SCRIPT, DOM_TRANSLATE_GUARD_BOOT_SCRIPT]) {
    assert.ok(!script.toLowerCase().includes("</script"), "the rendered boot script never closes its own script tag");
  }

  // 3. A Brevo message id loses its angle brackets, and a long run of them is trimmed in linear time.
  assert.equal(bareMessageId("<<abc@smtp-relay.mailin.fr>>"), "abc@smtp-relay.mailin.fr");
  assert.equal(bareMessageId("  <abc@b>  "), "abc@b");
  assert.equal(bareMessageId("abc@b"), "abc@b");
  assert.equal(bareMessageId("<<>>"), "");
  const bracketRun = timed(() => bareMessageId(`a${">".repeat(60_000)}b`));
  assert.equal(bracketRun.value.length, 60_002, "an id with brackets in the middle keeps them");
  assert.ok(bracketRun.ms < LINEAR_BUDGET_MS, `a long run of ">" is trimmed in linear time (took ${bracketRun.ms.toFixed(0)} ms)`);

  // 4. A speciality still loses its end dots and still splits a combined box; a long dot run is linear.
  assert.equal(normalizeSpeciality("Pediatrics..."), normalizeSpeciality("Pediatrics"), "end dots are dropped before the lookup");
  assert.equal(normalizeSpeciality("باطنه وقلب"), "Internal Medicine", "the Arabic 'and' still splits a combined box");
  assert.equal(normalizeSpeciality("Internal Medicine + Cardiology"), "Internal Medicine", "a plus still splits a combined box");
  assert.equal(normalizeSpeciality("Internal Medicine / Cardiology"), "Internal Medicine", "a slash still splits a combined box");
  assert.equal(normalizeSpeciality("Internal Medicine and Cardiology"), "Internal Medicine", "the word 'and' still splits a combined box");
  const dotRun = timed(() => normalizeSpeciality(`a${".".repeat(60_000)}x`));
  assert.ok(dotRun.ms < LINEAR_BUDGET_MS, `a long run of dots is read in linear time (took ${dotRun.ms.toFixed(0)} ms)`);

  // 5. The LinkedIn profile is canonicalised exactly as before.
  assert.equal(findLinkedInUrl("see https://eg.linkedin.com/in/aban-ahmed/ ok"), "https://www.linkedin.com/in/aban-ahmed");
  assert.equal(findLinkedInUrl("linkedin.com/pub/omar-x/1a/2b"), "https://www.linkedin.com/in/omar-x/1a/2b");
  assert.equal(findLinkedInUrl("[linkedin.com/in/aban](https://www.linkedin.com/in/aban-ahmed-123)"), "https://www.linkedin.com/in/aban-ahmed-123");
  assert.equal(findLinkedInUrl("no profile here"), null);

  // 6. A download follows only a path under /api/ on this site.
  assert.equal(sameOriginApiPath("/api/payroll/export?month=2026-11"), "/api/payroll/export?month=2026-11");
  for (const refused of ["javascript:alert(1)", "//other.example/api/x", "https://other.example/api/x", "/\\other.example/api/x", "/api/x\nSet-Cookie", "api/x", "/apix", ""]) {
    assert.equal(sameOriginApiPath(refused), null, `${JSON.stringify(refused)} is not a download path`);
  }
  const assigned: string[] = [];
  const globals = globalThis as { window?: unknown };
  const hadWindow = "window" in globals;
  const previousWindow = globals.window;
  globals.window = { location: { assign: (url: string) => assigned.push(url) } };
  try {
    downloadFromApiRoute("javascript:alert(1)");
    downloadFromApiRoute("https://other.example/api/x");
    assert.deepEqual(assigned, [], "a download button never hands the browser an address that is not a path under /api/");
    downloadFromApiRoute("/api/recruitment/files/abc");
    assert.deepEqual(assigned, ["/api/recruitment/files/abc"], "a path under /api/ is followed as before");
  } finally {
    if (hadWindow) globals.window = previousWindow;
    else delete globals.window;
  }
}
