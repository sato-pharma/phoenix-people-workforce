/**
 * Building the email out of a document the sender uploaded.
 *
 * Owner 2026-09-23: "i want to have an option to for example upload pdf and the system absorb and
 * extract the data from the pdf and make it as email", with the Semester 2 2026 incentive policy
 * attached as the example — three pages, an achievement curve, a worked example in figures.
 *
 * That example is exactly what makes this mode dangerous, and every assertion here is about one of
 * four ways it could go wrong:
 *
 *   1. the guard that stops the OTHER two modes inventing a figure refuses the document's OWN
 *      figures — the policy's 21,000 comes back as "a figure nobody wrote" and the mode hands back
 *      nothing, every time, which is the do-nothing the owner has already rejected once;
 *   2. the guard is simply switched off for this mode, and a percentage the model reasoned its way
 *      to reaches the sales force inside a company announcement as if the paper had said it;
 *   3. a scan with no text in it is read as an empty document and the email is written from
 *      nothing at all, silently;
 *   4. the picker offers a file type the server cannot read, so the sender's first press is a
 *      refusal.
 *
 * Pure throughout: no pdf-parse, no network, no OpenAI. The reading half (`read-source-document.ts`)
 * is two library calls over these same decisions, and the decisions are what can be wrong.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildPolishPrompt,
  findPolishViolations,
  parseSatoAssistMode,
  SATO_DOCUMENT_INSTRUCTIONS,
  senderWriting,
  unverifiedFigures,
} from "@/lib/sato-email/polish";
import { prepareSatoEmailBody } from "@/lib/sato-email/render";
import {
  capSourceText,
  chooseSourceRoute,
  describeSourceRead,
  detectSatoSourceKind,
  htmlToSourceText,
  SATO_EMAIL_DOCUMENT_ACCEPT,
  SATO_EMAIL_SOURCE_MAX_CHARS,
  tidySourceText,
} from "@/lib/sato-email/source-document";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** The incentive policy the owner attached, shortened to the figures that matter. */
const POLICY_TEXT = [
  "Sato Pharma L.L.C.",
  "Semester Incentive Policy — Semester 2 2026, July to December 2026",
  "Base salary 15,000. Basic salary is base salary × 70% = 10,500.",
  "The semester incentive is two months of basic salary: 21,000 at 100% achievement.",
  "Below 90% nothing is paid. At 90% you receive 50%. At 150% the ceiling is 220%.",
  "The Pedia line is scored in two halves of 10,500 each.",
].join("\n");

export function runSatoEmailDocumentTests() {
  // -- 1. Which files can be read at all ------------------------------------------------------

  assert.equal(detectSatoSourceKind("application/pdf", "policy.pdf"), "pdf");
  assert.equal(
    detectSatoSourceKind("", "Sato-Semester-2-2026-Incentive-Policy.pdf"),
    "pdf",
    "a PDF dragged from a folder can arrive with no MIME type at all — the extension has to answer",
  );
  assert.equal(detectSatoSourceKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "memo.docx"), "word");
  assert.equal(detectSatoSourceKind("application/msword", "memo.doc"), "word");
  assert.equal(detectSatoSourceKind("text/plain", "notes.txt"), "text");
  assert.equal(
    detectSatoSourceKind("application/vnd.ms-excel", "list.csv"),
    "text",
    "a CSV routinely arrives labelled as Excel — it is still text, and reading it as one is right",
  );
  assert.equal(detectSatoSourceKind("image/jpeg", "policy-page-1.jpg"), "picture");
  assert.equal(
    detectSatoSourceKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "targets.xlsx"),
    "unsupported",
    "a workbook is not a document to announce — refusing it is better than mailing a cell dump",
  );

  // 🔴 The picker must never offer something the server would refuse. A sender whose first press
  // ends in "that file cannot be read" has been told the feature does not work.
  for (const entry of SATO_EMAIL_DOCUMENT_ACCEPT.split(",")) {
    const offered = entry.trim();
    const kind = offered.startsWith(".")
      ? detectSatoSourceKind("", `example${offered}`)
      : detectSatoSourceKind(offered, "example");
    assert.notEqual(kind, "unsupported", `the file picker offers ${offered}, which the reader cannot read`);
  }

  // -- 2. What the words look like once the page furniture is gone -----------------------------

  const withFurniture = [
    "Semester Incentive Policy",
    "",
    "",
    "The semester incentive is 21,000 at 100%.",
    "-- 1 of 3 --",
    "\u200bسياسة حافز نصف السنة\u200e",
  ].join("\n");
  const tidied = tidySourceText(withFurniture);
  assert.equal(
    tidied.includes("-- 1 of 3 --"),
    false,
    "pdf-parse's page markers are the reader's furniture, not the document's words",
  );
  assert.equal(tidied.includes("\u200b"), false, "zero-width characters from a Word export must not reach the prompt");
  assert.equal(
    tidied.includes("سياسة حافز نصف السنة"),
    true,
    "🔴 an Arabic policy must survive tidying intact — most of what this company circulates is Arabic",
  );
  assert.equal(tidied.includes("\n\n\n"), false, "runs of blank lines are collapsed");
  assert.equal(tidied.includes("21,000"), true, "a figure is never touched");

  const long = `${"a".repeat(SATO_EMAIL_SOURCE_MAX_CHARS)}\nthe last paragraph`;
  const capped = capSourceText(long);
  assert.equal(capped.truncated, true, "a document past the cap is reported as cut, never silently shortened");
  assert.equal(capped.text.endsWith("…"), false, "🔴 nothing in this system is elided with an ellipsis (owner rule)");
  assert.equal(capSourceText(POLICY_TEXT).truncated, false, "a three-page policy is nowhere near the cap");

  // -- 3. Words, or the page itself -------------------------------------------------------------

  assert.equal(chooseSourceRoute({ kind: "pdf", text: POLICY_TEXT }), "text");
  assert.equal(
    chooseSourceRoute({ kind: "pdf", text: "-- 1 of 1 --" }),
    "picture",
    "🔴 a photographed policy saved as a PDF holds a page marker and nothing else — writing an email from those sixteen characters is the failure this route exists to stop",
  );
  assert.equal(chooseSourceRoute({ kind: "picture", text: "" }), "picture");
  assert.equal(
    chooseSourceRoute({ kind: "word", text: "Branch closing times move to 2 PM." }),
    "text",
    "a short Word memo is short, not scanned — only a PDF's missing text layer means a picture",
  );
  assert.equal(
    describeSourceRead({ characters: 0, fileName: "page.jpg", route: "picture", truncated: false }).includes("as a picture"),
    true,
    "the sender is told when nothing could be read out of his file",
  );
  assert.equal(
    describeSourceRead({ characters: 5078, fileName: "policy.pdf", route: "text", truncated: false }),
    "Read policy.pdf — 5,078 characters of text.",
    "the line names the file, so a draft built from the wrong upload is visible",
  );

  // -- 4. The mode, and where its facts may come from -------------------------------------------

  assert.equal(parseSatoAssistMode("document"), "document");
  assert.equal(parseSatoAssistMode("anything else"), "rewrite", "an unknown mode is the safest one");

  const sender = { bodyHtml: "", instruction: "Announce this to the Pedia line", sourceText: POLICY_TEXT, subject: "" };
  assert.equal(
    senderWriting(sender).includes("21,000"),
    true,
    "🔴 the document he uploaded IS his writing — without this every draft this mode produces is refused",
  );

  const faithful = {
    bodyHtml:
      "<p>From Semester 2 2026 the semester incentive is two months of basic salary — 21,000 on a base salary of 15,000.</p>" +
      "<p>Nothing is paid below 90% achievement, and the ceiling is 220%.</p>",
    subject: "Semester 2 2026 incentive policy",
  };
  assert.deepEqual(
    findPolishViolations(faithful, sender, "document"),
    [],
    "a draft that states only what the policy states is accepted",
  );
  assert.deepEqual(
    unverifiedFigures(faithful, sender),
    [],
    "🔴 every figure came off the page — a check list here would be noise the sender learns to ignore",
  );

  const invented = {
    bodyHtml: "<p>The semester incentive is 21,000, and the transport allowance rises to 1,850.</p>",
    subject: "Semester 2 2026 incentive policy",
  };
  assert.deepEqual(
    unverifiedFigures(invented, sender),
    ["1850"],
    "🔴 a figure that is in neither the document nor his request is named — this is the whole honesty of the mode",
  );
  assert.deepEqual(
    findPolishViolations(invented, sender, "document"),
    [],
    "but it is a CHECK, not a refusal: refusing would hand him no email at all, which is what write mode already settled",
  );

  // -- 5. What no mode may do, document mode included -------------------------------------------

  assert.equal(
    findPolishViolations(
      { bodyHtml: "<p>Read the full policy at <a href=\"https://sato-incentives.example.com\">this link</a>.</p>", subject: "Incentive" },
      sender,
      "document",
    ).some((violation) => violation.startsWith("links nobody wrote")),
    true,
    "🔴 a minted link reaches a whole distribution list without a click — refused in every mode",
  );
  assert.deepEqual(
    findPolishViolations(
      { bodyHtml: "<p>The policy is published at https://phoenix-hr.satopharma.com/policy.</p>", subject: "Incentive" },
      { ...sender, sourceText: `${POLICY_TEXT}\nPublished at https://phoenix-hr.satopharma.com/policy` },
      "document",
    ),
    [],
    "an address printed in his own document is his to keep",
  );
  assert.equal(
    findPolishViolations(
      { bodyHtml: "<p>This summary was prepared with AI assistance.</p>", subject: "Incentive" },
      sender,
      "document",
    ).includes("it named the assistant"),
    true,
    "🔴 the reader never learns a model was involved (owner rule 2026-08-04)",
  );

  // -- 6. What actually reaches the model --------------------------------------------------------

  const prompt = buildPolishPrompt({
    bodyHtml: "",
    instruction: "Announce this to the Pedia line",
    mode: "document",
    source: { fileName: "Sato-Semester-2-2026-Incentive-Policy.pdf", route: "text", text: POLICY_TEXT },
    subject: "",
  });
  assert.equal(prompt.includes("Sato-Semester-2-2026-Incentive-Policy.pdf"), true, "the model is told which file this is");
  assert.equal(prompt.includes("21,000"), true, "the document's words are what it works from");
  assert.equal(prompt.includes("Announce this to the Pedia line"), true, "his request travels with the document");

  const picturePrompt = buildPolishPrompt({
    bodyHtml: "",
    mode: "document",
    source: { file: { contentType: "application/pdf", data: "" }, fileName: "scan.pdf", route: "picture", text: "" },
    subject: "",
  });
  assert.equal(
    picturePrompt.includes("attached to this request as a file"),
    true,
    "a scan tells the model to read the file itself rather than leaving it with an empty document",
  );

  for (const line of [
    "Never say the document is attached",
    "must be in the document he uploaded",
    "[square bracket] gap",
    "Never mint a link",
  ]) {
    assert.equal(
      SATO_DOCUMENT_INSTRUCTIONS.includes(line),
      true,
      `the document prompt must carry the rule "${line}" — the guards above catch a breach, this is what prevents one`,
    );
  }
  assert.equal(
    SATO_DOCUMENT_INSTRUCTIONS.includes("<table"),
    true,
    "a policy's rate table is the part a reader needs — the toolbox has to reach this mode too",
  );
  assert.equal(
    SATO_DOCUMENT_INSTRUCTIONS.includes("A TABLE IN THE DOCUMENT ARRIVES AS A TABLE"),
    true,
    "🔴 owner 2026-09-23: \"it should be premium polished designed perfectly zebra tabled\" — the "
      + "first draft built from his incentive policy flattened the achievement curve into a list, "
      + "which is the one shape a reader cannot reassemble",
  );

  // -- 7. What that table looks like when it lands ------------------------------------------------
  //
  // 🔴 The assistant writes the toolbox's own cell markup, and until 2026-09-23 that inline
  // `border: 1px solid #cbd5e1; padding: 8px` WON: it was merged after the house cell, so every
  // table built from a document reached the reader in slate, with the 2px blue head rule wiped out
  // by the shorthand. The house owns the grid and the padding now; the sender still owns the ink.

  const drawn =
    '<table style="border-collapse: collapse; width: 100%"><tbody>' +
    '<tr><th style="border: 1px solid #cbd5e1; padding: 8px; text-align: left">Achievement</th>' +
    '<th style="border: 1px solid #cbd5e1; padding: 8px; text-align: left">Payout</th></tr>' +
    '<tr><td style="border: 1px solid #cbd5e1; padding: 8px">Below 90%</td>' +
    '<td style="border: 1px solid #cbd5e1; padding: 8px">Nothing</td></tr>' +
    '<tr><td style="border: 1px solid #cbd5e1; padding: 8px">100%</td>' +
    '<td style="border: 1px solid #cbd5e1; padding: 8px">21,000</td></tr>' +
    '<tr><td style="border: 1px solid #cbd5e1; padding: 8px">150%</td>' +
    '<td style="border: 1px solid #cbd5e1; padding: 8px">220%</td></tr>' +
    "</tbody></table>";
  const sent = prepareSatoEmailBody(drawn);

  assert.equal(/cbd5e1/i.test(sent), false, "🔴 no cell reaches the reader in the editor's slate");
  assert.equal(
    sent.includes("border-bottom:2px solid #0A6BA6"),
    true,
    "the head rule is ink, and a border shorthand written after it used to erase it",
  );
  assert.equal(
    (sent.match(/background:#F2F6FA/g) ?? []).length,
    2,
    "🔴 THE ZEBRA: Brand Blue at 6% on the second of three data rows — both its cells, and nothing else",
  );
  assert.equal(
    sent.includes("padding:8px 11px;border:1px solid #CFDCE7"),
    true,
    "the house grid and the house padding, on the cells themselves — email has no stylesheet",
  );

  // What the sender chose is still his. The toolbar has no border control and no padding control,
  // so nothing dropped above was ever a choice — his ink is, and it survives. (A fill is not: the
  // INK RULE strips every sender fill upstream, which is why the zebra is the only ground here.)
  const inked = prepareSatoEmailBody(
    '<table><tbody><tr><th>Item</th></tr>' +
      '<tr><td style="color: #B91C1C; background-color: #FEF3C7; padding: 8px">Deadline</td></tr></tbody></table>',
  );
  assert.equal(inked.includes("color:#B91C1C"), true, "the colour he pressed the button for outranks the house ink");
  assert.equal(
    /FEF3C7/i.test(inked),
    false,
    "🔴 and his fill does not reach the reader — one filled element in the house format, and it is the zebra",
  );

  // -- 8. And the composer shows him that table, not a different one -----------------------------
  //
  // The canvas is the only place the sender sees his email before it goes. It paints with a
  // stylesheet where the mail paints inline, so the two can drift apart silently — and they did:
  // the admin shell's own table rule (app/globals.css, RULE 2) put a light-orange hairline on every
  // cell it contains, with !important, so the composer showed orange and the mail went out
  // blue-grey. These are the four values that have to be the same on both sides.

  const editor = readFileSync(path.join(REPO_ROOT, "src/components/admin/email-body-editor.tsx"), "utf8");
  const canvasRules = editor.slice(editor.indexOf(".phx-email-editor table {"), editor.indexOf(".phx-email-editor .phx-var-chip"));

  for (const [value, what] of [
    ["#CFDCE7", "the house grid"],
    ["#0A6BA6", "the 2px rule under the head row"],
    ["#0A527D", "the head ink"],
    ["#F2F6FA", "Brand Blue at 6%, the zebra and the one fill the house identity allows"],
  ] as const) {
    assert.equal(
      canvasRules.includes(value),
      true,
      `the composer canvas must carry ${value} — ${what} — or it shows the sender a table the reader will not get`,
    );
  }
  assert.equal(
    canvasRules.includes("border: 1px solid #CFDCE7 !important"),
    true,
    "🔴 without !important the admin shell's own hairline wins and the canvas goes orange (measured 2026-09-23)",
  );
  assert.equal(
    canvasRules.includes(".phx-email-editor table td"),
    true,
    "and the extra `table` is what makes this selector outrank .admin-shell td, whichever stylesheet lands last",
  );

  // -- 9. It has to come back before the sender gives up ------------------------------------------
  //
  // Shipped on 2026-09-23 with the other two modes' settings, and it did not work once: the owner's
  // own 410 KB incentive policy took 115 seconds at "medium" effort against a 60-second budget, so
  // every attempt died on the timeout. What he saw was a spinner for a minute and then a message
  // about a rewrite he had not asked for.
  //
  // At "low" the same document came back in 28.9 s, 37.7 s and 38.6 s across three runs, each time
  // with all three tables, all eight achievement-curve figures and an empty check list. These two
  // assertions are what stops a later tidy-up from putting document mode back on the shared
  // settings, which would return it to failing every single time.

  const polish = readFileSync(path.join(REPO_ROOT, "src/lib/sato-email/polish.ts"), "utf8");

  assert.equal(
    /SATO_ASSIST_EFFORT\s*=\s*\{[^}]*document:\s*"low"/.test(polish),
    true,
    "🔴 document mode must think at LOW effort — at medium it took 115s against a 60s budget and timed out every time",
  );
  assert.equal(
    /timeoutMs:\s*mode === "document" \? SATO_DOCUMENT_BUDGET_MS/.test(polish),
    true,
    "🔴 and it must carry its own budget — a whole policy read and rewritten does not fit the 60s email budget",
  );
  assert.equal(
    /const SATO_DOCUMENT_BUDGET_MS = 120_000;/.test(polish),
    true,
    "120s is three times the slowest run measured; a smaller number puts the timeout back in the normal path",
  );

  // The message the sender actually reads. "The rewrite took too long" on a document he uploaded
  // names something he never pressed, which is how a slow answer reads as a broken feature.
  assert.equal(
    polish.includes('const what = mode === "document" ? "The document" : mode === "write" ? "The draft" : "The rewrite";'),
    true,
    "every assistant failure must name what the sender pressed, not always the rewrite",
  );
  assert.equal(
    /\$\{what\} took too long\. Try again\./.test(polish),
    true,
    "including the timeout, which is the one he has actually seen",
  );

  // -- 10. And the wait has to look like progress -------------------------------------------------
  //
  // Half a minute of a still spinner reads as broken. The seconds counter is the whole of the
  // answer to "its taking hilarious long time" that speed alone could not give.
  const composer = readFileSync(path.join(REPO_ROOT, "src/components/admin/sato-email-composer.tsx"), "utf8");
  assert.equal(
    composer.includes('counted("Reading the document")'),
    true,
    "the document button must count the seconds while it works — a still spinner reads as a hang",
  );
  assert.equal(
    /const counted = \(label: string\) => \(elapsed > 0 \? `\$\{label\} · \$\{elapsed\}s` : label\);/.test(composer),
    true,
    "and all three buttons share one counter, because the sender cannot know which mode is the slow one",
  );

  // -- 11. The email comes back in BOTH languages -------------------------------------------------
  //
  // Owner, 2026-09-23, on the English-only email this mode produced from his English incentive
  // policy: "i want it to be bilingual as the html u opened not only english". The reader is an
  // Egyptian colleague, and the language of the PAPER is not the language of the company.
  //
  // The instruction block is the only place this can live — nothing downstream can translate an
  // email that came back in one language. These assertions read the block the model is actually
  // handed, not a copy of it, which is why they go through the exported constant.

  assert.equal(
    /THE EMAIL IS BILINGUAL, WHATEVER LANGUAGE THE DOCUMENT IS IN/.test(SATO_DOCUMENT_INSTRUCTIONS),
    true,
    "🔴 an English document must still give an English AND an Arabic email — one language is half delivered",
  );
  assert.equal(
    SATO_DOCUMENT_INSTRUCTIONS.includes("Each English paragraph is followed immediately by the same paragraph in Arabic"),
    true,
    "interleaved paragraph by paragraph, so a reader of either language meets the email in the same order",
  );

  // 🔴 The direction rule, which is the one that silently ruins a bilingual body. dir=\"auto\"
  // reads only the FIRST strong character of a block and applies it to the whole of it, so an
  // English paragraph inside an Arabic-led email renders backwards. Direction per paragraph, on
  // BOTH languages, is the fix — and the English half needing it too is the half that gets left out.
  assert.equal(
    SATO_DOCUMENT_INSTRUCTIONS.includes('English paragraphs carry dir="ltr"'),
    true,
    "the English paragraphs need an explicit direction too, or the Arabic around them turns them backwards",
  );
  assert.equal(
    /Arabic paragraphs carry dir="rtl"/.test(SATO_DOCUMENT_INSTRUCTIONS),
    true,
    "and the Arabic ones carry rtl, which right-aligns them without a text-align of their own",
  );
  assert.equal(
    /A TABLE IS BUILT ONCE, NEVER TWICE/.test(SATO_DOCUMENT_INSTRUCTIONS),
    true,
    "🔴 a second copy of a figure table doubles its width and pushes the email off the side of a phone",
  );

  // -- 12. A web page is a document too -----------------------------------------------------------
  //
  // Owner, same day: "me able also to the system absorb uploaded html and write email from". What
  // he uploads is most often an email this composer itself produced. A plain utf8 decode of one is
  // tag soup — the whole house stylesheet arrives before the first word — so HTML is its own kind.

  assert.equal(detectSatoSourceKind("text/html", "announcement.html"), "html");
  assert.equal(
    detectSatoSourceKind("", "incentive-policy-email.htm"),
    "html",
    "a page saved from a browser can arrive with no MIME type and the short extension",
  );
  assert.equal(
    detectSatoSourceKind("text/html", "page.html") === "text",
    false,
    "HTML must not fall through to the plain-text branch: text/* would match it first and hand over the markup",
  );

  const page = [
    "<!doctype html><html><head><style>.sato-title{color:#0A527D;font-size:22px}</style></head>",
    "<body><h1>Semester 2 2026 incentive policy</h1>",
    "<p>The semester incentive is 21,000 at 100% achievement.</p>",
    "<table><thead><tr><th>Achievement</th><th>Payout</th></tr></thead>",
    "<tbody><tr><td>150%</td><td>46,200</td></tr><tr><td>90%</td><td>10,500</td></tr></tbody></table>",
    "<p>Nothing is paid below 90&#37;.</p>",
    "<script>window.ping = 1;</script></body></html>",
  ].join("");
  const read = tidySourceText(htmlToSourceText(page));

  assert.equal(read.includes("Semester 2 2026 incentive policy"), true, "the words a reader sees must survive");
  assert.equal(read.includes("21,000 at 100% achievement"), true, "and the figures with them, unchanged");
  assert.equal(
    read.includes("#0A527D") || read.includes("font-size") || read.includes("window.ping"),
    false,
    "🔴 the stylesheet and the script are not words on the page — they must not reach the prompt",
  );
  assert.equal(read.includes("<"), false, "no markup survives: what goes to the model is text, never HTML");
  assert.equal(
    read.includes("Nothing is paid below 90%."),
    true,
    "a numeric entity is a character the reader sees, so it is decoded rather than carried as &#37;",
  );

  // 🔴 THE GRID HAS TO SURVIVE. The instructions promise that a table in the document arrives
  // as a table in the email, and the model can only keep that promise if the rows still look like
  // rows. Flatten a rate card into one sentence here and no rule downstream puts it back.
  assert.equal(
    read.includes("Achievement | Payout"),
    true,
    "🔴 a table's cells must arrive joined into rows, or the achievement curve reaches the model as prose",
  );
  assert.equal(read.includes("150% | 46,200"), true, "one line per row, cells in the order the page printed them");
  assert.equal(
    /46,200\s*\|\s*$/m.test(read),
    false,
    "and a row does not end in a divider — the separator sits between cells, and there is no next cell",
  );

  // The picker has to offer it, or the feature exists only for someone who knows to drag the file.
  assert.equal(
    SATO_EMAIL_DOCUMENT_ACCEPT.includes(".html"),
    true,
    "the file picker must offer .html, or the sender never finds the capability",
  );
}
