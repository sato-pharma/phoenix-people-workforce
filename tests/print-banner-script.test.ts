import assert from "node:assert/strict";

import { printBanner } from "@/lib/hiring-pack/render-shared";

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
 * The guard must admit a real print URL and refuse anything else.
 *
 * Run against the emitted script rather than a copy of its logic — a copy is what let the original
 * defect through.
 */
function testTheGuardAdmitsAPrintUrlAndRefusesOthers() {
  const html = printBanner(["A4. 1 copy."]);
  const body = (/<script>([\s\S]*?)<\/script>/u.exec(html) as RegExpExecArray)[1];

  const run = (href: string) => {
    const link: { hidden: boolean; href?: string } = { hidden: true };
    const doc = { getElementById: (id: string) => (id === "phx-pdf" ? link : null) };
    new Function("document", "window", "URL", body)(doc, { location: { href } }, URL);
    return link;
  };

  const ok = run("https://phoenix-hr.satopharma.com/api/hiring-pack/A-12/print?document=contract&copies=4");
  assert.equal(ok.hidden, false, "a real print URL must reveal the button");
  assert.match(String(ok.href), /format=pdf/u, "and point at the same document as a file");

  const preview = run("https://phoenix-hr.satopharma.com/api/hiring-pack/A-12/print?document=contract&preview=1");
  assert.doesNotMatch(
    String(preview.href),
    /preview=1/u,
    "preview must be dropped — downloading is not previewing, and carrying it would file the paper as never printed",
  );

  const elsewhere = run("https://phoenix-hr.satopharma.com/hr/hiring-pack");
  assert.equal(elsewhere.hidden, true, "anywhere that is not the print route must leave the button hidden");
}

export async function runPrintBannerScriptTests() {
  testTheInjectedScriptParses();
  testTheButtonAndTheScriptAgree();
  testTheGuardAdmitsAPrintUrlAndRefusesOthers();
}
