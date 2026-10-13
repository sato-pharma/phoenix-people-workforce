import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { findLinkedInUrl, linkedInProfileHref } from "../src/lib/recruitment/linkedin-profile.ts";
import { findLinkedInUrl as findLinkedInUrlForTheReader } from "../src/lib/recruitment/rule-extraction/patterns.ts";
import { stripComments } from "./support/comment-strip.ts";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

/**
 * Two things the owner asked for together on 2026-09-18.
 *
 * ONE: a LinkedIn button beside WhatsApp, Shortlist and Reject whenever the CV gave a LinkedIn
 * profile, that opens that person's profile. On the screening page's decision bar and in the
 * recruitment tab's candidate profile.
 *
 * TWO: the text of a CV can be selected and copied, in both tabs. A PDF is painted onto a canvas,
 * which is a picture, so pdf.js's text layer now lies over it — but NEVER where the reader may not
 * take the document away (the manager's portal) and never over a page whose phone numbers were
 * painted out, because the text under a black box is still text.
 */
export function runCvLinkedInAndSelectableTextTests() {
  // ── 1 · The link only ever goes to a LinkedIn profile ────────────────────────────────────────
  //
  // The stored column is written by the AI reader, record merges and hand edits, none of which
  // checks the host. The button must link to what the rule reader would have found, or to nothing.
  assert.equal(
    linkedInProfileHref("linkedin.com/in/mona-ali-5a1b2c/"),
    "https://www.linkedin.com/in/mona-ali-5a1b2c",
    "a bare address becomes the full https profile address",
  );
  assert.equal(
    linkedInProfileHref("https://eg.linkedin.com/in/ahmed-samir"),
    "https://www.linkedin.com/in/ahmed-samir",
    "a country subdomain opens the same profile on the main site",
  );
  assert.equal(
    linkedInProfileHref("[LinkedIn](https://www.linkedin.com/in/karim-adel-0b1c2d3e)"),
    "https://www.linkedin.com/in/karim-adel-0b1c2d3e",
    "a markdown link, as pdf-parse emits them, still resolves to the profile",
  );
  for (const nothing of [null, undefined, "", "   "]) {
    assert.equal(linkedInProfileHref(nothing), null, `no profile, no button: ${JSON.stringify(nothing)}`);
  }
  for (const notAProfile of [
    "https://www.facebook.com/mona.ali",
    "https://mona-portfolio.example/about",
    "https://www.linkedin.com/company/sato-pharma",
    "javascript:alert(document.cookie)",
  ]) {
    assert.equal(
      linkedInProfileHref(notAProfile),
      null,
      `a LinkedIn button must never open something that is not a LinkedIn profile: ${notAProfile}`,
    );
  }
  // A hostile value that CONTAINS a profile address still yields only the fixed https address.
  const smuggled = linkedInProfileHref("javascript:alert(1)//linkedin.com/in/x-y");
  assert.equal(smuggled, "https://www.linkedin.com/in/x-y", "only the profile address survives, never the scheme around it");
  for (const value of [
    "linkedin.com/in/mona-ali-5a1b2c/",
    "https://eg.linkedin.com/in/ahmed-samir",
    "javascript:alert(1)//linkedin.com/in/x-y",
    "http://www.linkedin.com/in/%D9%85%D9%86%D9%89",
  ]) {
    const href = linkedInProfileHref(value);
    assert.ok(
      href && /^https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9%_\-/]+$/.test(href),
      `every link is the fixed host plus a plain slug: ${value} -> ${href}`,
    );
  }
  // One matcher: the reader that fills the column and the button that reads it cannot drift apart.
  assert.equal(findLinkedInUrlForTheReader, findLinkedInUrl, "the CV reader and the button share ONE LinkedIn matcher");

  // ── 2 · The screening row carries the checked link, never the raw column ─────────────────────
  const workspace = stripComments(read("src/lib/recruitment/screening-workspace.ts"));
  assert.match(
    workspace,
    /linkedinUrl: linkedInProfileHref\(candidate\.linkedinUrl\),/,
    "the screening row resolves the profile on the server, through the same guard",
  );

  // ── 3 · The screening decision bar: beside WhatsApp, before the verdicts, a new tab ──────────
  const header = stripComments(read("src/components/recruitment/workstation/workstation-review-header.tsx"));
  const decisionsStart = header.indexOf("const decisions = (");
  const decisionsEnd = header.indexOf("const afterBands = (", decisionsStart);
  assert.ok(decisionsStart > 0 && decisionsEnd > decisionsStart, "the decision strip must still be one shared fragment");
  const decisions = header.slice(decisionsStart, decisionsEnd);
  assert.match(
    decisions,
    /\{row\.linkedinUrl \? \(\s*<DecisionLink\s+href=\{row\.linkedinUrl\}/,
    "the decision strip shows a LinkedIn link when, and only when, the row has a profile",
  );
  const whatsApp = decisions.indexOf('label="WhatsApp"');
  const linkedIn = decisions.indexOf('label="LinkedIn"');
  const shortlist = decisions.indexOf('label="Shortlist"');
  const reject = decisions.indexOf('label="Reject"');
  assert.ok(
    whatsApp > 0 && whatsApp < linkedIn && linkedIn < shortlist && shortlist < reject,
    "LinkedIn sits beside WhatsApp and before Shortlist and Reject — in the fragment BOTH bands render",
  );
  const decisionLink = header.slice(header.indexOf("function DecisionLink("));
  assert.match(
    decisionLink,
    /<a className=\{cn\(DECISION_SHAPE, decisionRest\("info"\)\)\} href=\{href\} rel="noopener noreferrer" target="_blank"/,
    "it opens in a new tab, so the queue, the open panels and a half-typed reason survive the look-up",
  );

  // ── 4 · The recruitment tab's candidate profile: beside the WhatsApp reply ───────────────────
  const recruitment = stripComments(read("src/components/recruitment/recruitment-workspace.tsx"));
  assert.match(
    recruitment,
    /<WhatsAppReplyBox candidateId=\{profile\.candidate\.id\} \/> : null\}\s*<LinkedInProfileLink linkedinUrl=\{profile\.candidate\.linkedinUrl\} \/>/,
    "the profile panel puts LinkedIn right beside its WhatsApp reply",
  );
  const profileLink = recruitment.slice(recruitment.indexOf("function LinkedInProfileLink("));
  assert.match(
    profileLink,
    /const href = linkedInProfileHref\(linkedinUrl\);\s*if \(!href\) return null;/,
    "the profile panel's link goes through the same guard and draws nothing without a profile",
  );
  assert.match(profileLink, /rel="noopener noreferrer" target="_blank"/, "and opens in a new tab too");

  // ── 5 · The CV's text is selectable — and never where it must not be ─────────────────────────
  const viewerSource = read("src/components/recruitment/cv-preview-modal.tsx");
  const viewer = stripComments(viewerSource);
  // THE HEADLINE. The manager's portal passes allowDownload={false}; a redacted page is painted over
  // on the canvas only. Either one must mean no text layer at all.
  assert.match(
    viewer,
    /const selectable = allowDownload && !redactPhones;/,
    "a text layer only where the reader may take the document AND nothing on it was painted out",
  );
  const textLayers = viewer.match(/new pdfjsLib\.TextLayer\(/g) ?? [];
  assert.equal(textLayers.length, 1, "exactly one place builds a text layer");
  const gate = viewer.indexOf("if (selectable) {");
  const build = viewer.indexOf("new pdfjsLib.TextLayer(");
  const gateEnd = viewer.indexOf("if (!active) return;", build);
  assert.ok(gate > 0 && gate < build && build < gateEnd, "and it is built only inside the `selectable` branch");
  const paint = viewer.indexOf("if (redactPhones) {", viewer.indexOf("page.render("));
  assert.ok(paint > 0 && paint < gate, "the phone numbers are painted out before anything else is laid over the page");
  assert.match(
    read("src/components/employee-portal/candidate-cv-actions.tsx"),
    /allowDownload=\{showPhoneNumbers\}/,
    "the manager's portal offers the download only to the reservation holder — whose page is also unredacted, so only he can select its text",
  );
  // `docTextUrl` joined the list on 2026-09-27 with the legacy-.doc read — it is the same file URL
  // in the doc-text mode, so it changes together with bytesUrl and adds no extra redraw.
  assert.match(
    viewer,
    /\}, \[kind, bytesUrl, docTextUrl, fileName, mimeType, redactPhones, allowDownload\]\);/,
    "a change to either switch redraws the page, with or without its layer",
  );

  // The layer has to land on the words. It is sized from the canvas's own scale, and the canvas is
  // never shrunk underneath it by the admin shell's `max-width: 100%` on every canvas.
  assert.match(
    viewer,
    /pageBox\.style\.setProperty\("--total-scale-factor", String\(viewport\.scale \* viewport\.userUnit\)\);/,
    "the layer uses the scale the canvas was drawn at",
  );
  assert.match(viewer, /canvas\.style\.maxWidth = "none";/, "the shell's canvas cap cannot shrink the page under its text");
  assert.match(viewer, /textLayer\.className = "cv-text-layer";/, "the layer wears the class its stylesheet targets");

  // A layer that fails costs the selection, never the CV.
  const layerCatch = viewer.slice(viewer.indexOf("} catch (layerError) {"), gateEnd);
  assert.ok(layerCatch.length > 0, "a failed text layer is caught on its own");
  assert.doesNotMatch(layerCatch, /setError\(/, "and does not replace the page with an error");
  assert.match(layerCatch, /stage: "text-layer"/, "it is reported under its own stage");

  // The stylesheet: transparent ink, including while selected — the app's own ::selection rules
  // colour selected text, which over a canvas showing the same word prints it twice.
  const css = read("app/globals.css");
  assert.match(
    css,
    /\.cv-text-layer :is\(span, br\) \{[^}]*color: transparent;[^}]*\}/,
    "the layer's text is invisible — the ink comes from the canvas",
  );
  assert.match(
    css,
    /\.cv-text-layer :is\(span, br\)::selection \{\s*color: transparent;\s*\}/,
    "and stays invisible when selected, beating the app's ink-coloured ::selection",
  );

  // pdf.js's measuring canvas. TextLayer appends an opaque (`alpha: false`) canvas to <body>, one
  // per language. Unhidden, preflight stacks them as 300x150 black blocks under the app shell on
  // every page the tab visits after a CV — the black band in the bottom-left of Direct Orders,
  // 2026-09-19.
  //
  // WHAT IS REQUIRED IS THAT IT IS HIDDEN, not how. pdf.js 5 gave it the class
  // `hiddenCanvasElement` and left the hiding to a stylesheet — ours, since we serve the build
  // ourselves — so the class name was load-bearing and this checked for it. pdf.js 6 stopped
  // relying on anyone else and sets `display:none` inline on the element it creates, which is the
  // stronger fix: there is no longer a name to get wrong. Pinning the 5.x mechanism would now fail
  // on a build that fixed the bug outright, so this asks the build actually served which of the two
  // it does, and holds it to that one. A build that does NEITHER is the 2026-09-19 regression
  // returning, and fails here rather than on a page.
  const servedViewer = read("public/pdfjs/pdf.min.mjs");
  const hidesItself = /style\.cssText\s*=\s*"[^"]*display:\s*none[^"]*"/.test(servedViewer);
  const usesTheClass = servedViewer.includes('"hiddenCanvasElement"');
  assert.ok(
    hidesItself || usesTheClass,
    "the pdf.js build the viewer loads neither hides its measuring canvas inline nor names it hiddenCanvasElement for our stylesheet to hide — unhidden it paints 300x150 black blocks under the app shell on every page visited after a CV, which is the 2026-09-19 regression",
  );
  if (usesTheClass) {
    assert.match(
      css,
      /(?:^|\n)\.hiddenCanvasElement \{[^}]*display: none;[^}]*\}/,
      "this pdf.js build hides its measuring canvas by class, so app/globals.css must still hide that class",
    );
  }
}
