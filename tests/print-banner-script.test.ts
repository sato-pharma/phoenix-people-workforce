import assert from "node:assert/strict";

import { ARABIC_FONT_STACK, printBanner } from "@/lib/hiring-pack/render-shared";

/**
 * The banner's Download PDF script must actually PARSE.
 *
 * This exists because it once did not, in production, on every printable document. The script is
 * authored inside a TypeScript template literal, where a backslash is an escape for the template
 * and never reaches the browser: `/\/print\/?$/` in the source arrived as `//print/?$/` — a line
 * comment — so the whole script died on a SyntaxError and the button stayed hidden everywhere.
 *
 * Nothing caught it. It is not a type error, so `typecheck` was green; the HTML is a string, so
 * every test comparing strings was green; and the feature was verified by extracting the script
 * text out of the SOURCE FILE and running that, which is the one artefact that is correct. The
 * browser gets the RENDERED output, and only that is worth asserting on.
 */
function testTheInjectedScriptParses() {
  const html = printBanner(["A4. 1 copy."]);
  const match = /<script>([\s\S]*?)<\/script>/u.exec(html);
  assert.ok(match, "the banner must carry its script — without it the button can never appear");

  // `new Function` compiles without executing, which is exactly the question: is this valid JS?
  assert.doesNotThrow(
    () => new Function(match[1]),
    "the Download PDF script must parse in a browser — check for escapes lost to the template literal",
  );
}

/** The button itself, and the id the script looks for, have to agree. */
function testTheButtonAndTheScriptAgree() {
  const html = printBanner(["A4. 1 copy."]);
  assert.match(html, /id="phx-pdf"/u, "the download link must be in the banner");
  assert.match(html, /hidden/u, "and must start hidden, so a dead button never shows on a document");
  assert.match(html, /getElementById\("phx-pdf"\)/u, "the script must look for that same id");
}

/**
 * The Print button carries no inline handler, and the banner's own script wires it.
 *
 * The hand-typed paper is shown in a srcdoc frame, which runs under the PAGE policy
 * (src/lib/security/content-security-policy.ts): its scripts run with the page nonce, but an inline
 * `onclick` is blocked whatever the nonce — so a button wired that way would show and do nothing.
 */
function testThePrintButtonIsWiredByTheScript() {
  const html = printBanner(["A4. 1 copy."]);
  assert.doesNotMatch(html, /\son[a-z]+=/iu, "🔴 no inline event handler in the banner — the page policy blocks it");
  assert.match(html, /<button type="button" class="print-banner__action" id="phx-print">Print<\/button>/u);

  const body = (/<script>([\s\S]*?)<\/script>/u.exec(html) as RegExpExecArray)[1];
  const listeners: Array<{ event: string; handler: () => void }> = [];
  const printButton = { addEventListener: (event: string, handler: () => void) => listeners.push({ event, handler }) };
  let printed = 0;
  const doc = {
    // No download link here (a file:// paper): the Print button must be wired all the same.
    getElementById: (id: string) => (id === "phx-print" ? printButton : null),
  };
  new Function("document", "window", "URL", body)(doc, { location: { href: "file:///C:/paper.html" }, print: () => (printed += 1) }, URL);
  assert.deepEqual(listeners.map((l) => l.event), ["click"], "🔴 the banner script must wire the Print button");
  listeners[0].handler();
  assert.equal(printed, 1, "a click opens the print dialog");
}

/**
 * The guard must admit a real print URL and refuse anything else.
 *
 * Run against the emitted script rather than a copy of its logic — a copy is what let the original
 * defect through.
 */
function testTheGuardAdmitsAPrintUrlAndRefusesOthers() {
  const html = printBanner(["A4. 1 copy."]);
  const body = (/<script>([\s\S]*?)<\/script>/u.exec(html) as RegExpExecArray)[1];

  const run = (href: string) => {
    // THE STUB MUST CARRY addEventListener. The script wires the click handler inside its own
    // try/catch, so a link object without it throws, the throw is swallowed, and the test still
    // sees a revealed button — passing while the button does nothing, which is the exact symptom
    // this whole file exists to catch.
    const handlers: string[] = [];
    const link = {
      hidden: true,
      href: undefined as string | undefined,
      textContent: "Download PDF",
      style: {} as Record<string, string>,
      addEventListener: (event: string) => handlers.push(event),
    };
    const doc = {
      getElementById: (id: string) => (id === "phx-pdf" ? link : null),
      createElement: () => ({ click: () => {}, style: {} }),
      body: { appendChild: () => {}, removeChild: () => {} },
    };
    new Function("document", "window", "URL", body)(doc, { location: { href }, fetch: () => {}, URL }, URL);
    return { link, handlers };
  };

  const ok = run("https://phoenix-hr.satopharma.com/api/hiring-pack/A-12/print?document=contract&copies=4");
  assert.equal(ok.link.hidden, false, "a real print URL must reveal the button");
  assert.match(String(ok.link.href), /format=pdf/u, "and point at the same document as a file");
  assert.deepEqual(
    ok.handlers,
    ["click"],
    "the click handler must attach — without it the button shows and does nothing, which is how it was reported",
  );

  const preview = run("https://phoenix-hr.satopharma.com/api/hiring-pack/A-12/print?document=contract&preview=1");
  assert.doesNotMatch(
    String(preview.link.href),
    /preview=1/u,
    "preview must be dropped — downloading is not previewing, and carrying it would file the paper as never printed",
  );

  const elsewhere = run("https://phoenix-hr.satopharma.com/hr/hiring-pack");
  assert.equal(elsewhere.link.hidden, true, "anywhere that is not the print route must leave the button hidden");
}

/**
 * The stack must name a face the SERVER actually has.
 *
 * Every other family in it is a Windows font. The container has none of them, and ttf-freefont —
 * what it falls through to — carries Arabic codepoints without shaping them, so Chromium drew each
 * letter isolated and a three-page contract was filed as sixteen. Nothing was red: it is not a type
 * error, not a string mismatch, and the HTML was correct. Only the printed page showed it.
 *
 * Paired with `font-noto-arabic` in the Dockerfile. If someone tidies this entry out of the stack,
 * or drops the package, filed contracts silently come apart again — so the two are pinned together.
 */
function testTheStackNamesAFontTheServerHas() {
  assert.match(
    ARABIC_FONT_STACK,
    /Noto Sans Arabic/u,
    "the Arabic stack must name a shaping face the Linux container has — every other family in it ships only with Windows",
  );
  assert.ok(
    ARABIC_FONT_STACK.indexOf("Tahoma") < ARABIC_FONT_STACK.indexOf("Noto Sans Arabic"),
    "Tahoma must still come first, so nothing changes for HR printing from a Windows desktop",
  );
}

export async function runPrintBannerScriptTests() {
  testTheStackNamesAFontTheServerHas();
  testTheInjectedScriptParses();
  testTheButtonAndTheScriptAgree();
  testThePrintButtonIsWiredByTheScript();
  testTheGuardAdmitsAPrintUrlAndRefusesOthers();
}
