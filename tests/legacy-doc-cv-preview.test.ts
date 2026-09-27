import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { detectCvFileKind } from "../src/lib/recruitment/cv-file-kind.ts";
import { extractLegacyDocText, legacyDocLines, NotALegacyDocError } from "../src/lib/recruitment/legacy-doc-text.ts";

/**
 * A WORD 97-2003 CV IS READABLE ON THE SCREEN.
 *
 * Until 2026-09-27 it was not. The preview recognised the format from its bytes and stopped:
 * "This is an older Word (.doc) format that can't be previewed here", with a link to download the
 * file and open it in Word — and for a hiring manager, who may not download a CV at all (the
 * owner's rule of 2026-09-09), not even that. The owner hit the notice himself on a CV that had
 * arrived that same afternoon.
 *
 * Measured on production (ozucdzovmcqvepbozvqf) the same day: 13 files across 12 candidates, and
 * they keep arriving, because an applicant sending a CV he wrote in 2009 has no idea his file is a
 * different format from everybody else's.
 *
 * WHY TEXT AND NOT A PAGE. The binary .doc is an OLE2 compound file; docx-preview unzips and
 * mammoth reads the same zip, so neither can open one, and nothing in a browser can. word-extractor
 * can, in Node — and has been reading exactly these files for the extraction pipeline since
 * 2026-08-27 (cv-extraction.ts), which is why they are searchable today even though nobody could
 * look at one. So the server reads the lines and the page paints them: no fonts, no columns, no
 * tables as tables, and a line on the page saying as much.
 *
 * WHAT IS PINNED HERE. The shaping of the text (pure, and the whole of the judgement); the guard
 * that refuses to read a non-OLE2 file as one; the routing change that lets a bare ".doc" name with
 * no mime type reach the Word branch at all; and the wiring across the three files that must agree
 * — the transport mode, the manager's allow-list, and the page that paints it.
 *
 * NOT PINNED, AND DELIBERATELY: word-extractor reading a real .doc. A fixture would have to be a
 * real applicant's CV (personal data, never in this repo) or a hand-built OLE2 file testing this
 * repo's ability to fake one rather than the reader. It was proved against a real production file
 * when this shipped instead.
 */
export async function runLegacyDocCvPreviewTests() {
  // ── 1 · The shaping of the lines ──────────────────────────────────────────────────────────────
  //
  // word-extractor has already turned every flavour of Word break into "\n" and every table cell
  // boundary into a tab (its filters.js). What is left is making that readable.

  assert.deepEqual(
    legacyDocLines("Ahmed Fathy\nMedical Rep\n\n\n\nCairo University"),
    ["Ahmed Fathy", "Medical Rep", "", "Cairo University"],
    "a run of blank lines collapses to ONE — an old CV is full of them, and printing every one puts the candidate's degree three screens down",
  );

  assert.deepEqual(
    legacyDocLines("\n\n\nAhmed Fathy\n\n\n"),
    ["Ahmed Fathy"],
    "blank lines at either end are dropped, so the page does not open on empty paper",
  );

  assert.deepEqual(
    legacyDocLines("Experience\r\nSato Pharma\rCairo"),
    ["Experience", "Sato Pharma", "Cairo"],
    "a bare \\r and a \\r\\n are line breaks too — a document written in 2003 has both",
  );

  assert.deepEqual(
    legacyDocLines("2019\t2023\tSato Pharma"),
    ["2019\t2023\tSato Pharma"],
    "THE TAB SURVIVES: it is the only structure a table in this format leaves behind, and the page prints it with pre-wrap",
  );

  assert.deepEqual(
    legacyDocLines("Ahmed\u0001 Fathy\u0007\nCairo\u001f"),
    ["Ahmed Fathy", "Cairo"],
    "control characters that survive in an old file are dropped, not printed as boxes",
  );

  assert.deepEqual(
    legacyDocLines("Skills:   \nSelling   "),
    ["Skills:", "Selling"],
    "trailing whitespace goes, so a line is not centred by accident when the page is fitted",
  );

  assert.deepEqual(legacyDocLines(""), [], "an empty document is no lines, not one empty one");
  assert.deepEqual(legacyDocLines("   \n\t\n  "), [], "a document of nothing but whitespace is no lines");

  // Arabic must come through untouched — a real share of these CVs is written in it, and the page
  // sets its direction per line.
  assert.deepEqual(
    legacyDocLines("أحمد فتحي\nمندوب دعاية"),
    ["أحمد فتحي", "مندوب دعاية"],
    "Arabic text passes through the shaping unchanged",
  );

  // ── 2 · The reader refuses anything that is not a legacy .doc ─────────────────────────────────
  //
  // The caller holds the bytes and has already tested them, so arriving here with a .docx is a
  // wiring mistake. It must SAY so: answering with an empty document would paint as a blank CV, and
  // a blank CV is read as "this candidate sent nothing".
  await assertRejects(
    () => extractLegacyDocText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00])),
    "a modern OOXML .docx must be refused by the legacy reader, not read as an empty document",
  );
  await assertRejects(
    () => extractLegacyDocText(Buffer.from("%PDF-1.7\n")),
    "a PDF must be refused by the legacy reader",
  );
  await assertRejects(() => extractLegacyDocText(Buffer.from([])), "empty bytes must be refused, never read");

  // ── 3 · A ".doc" NAME with no mime type reaches the Word branch ───────────────────────────────
  //
  // detectCvFileKind sees only a mime type and a file name, and an attachment off WhatsApp or
  // e-mail can arrive with neither a useful mime nor an extension the router knew. Before this, a
  // file called "CV.doc" with no mime answered "unsupported" — a reader was shown "no preview for
  // this file type" for a document that can now be read.
  assert.equal(detectCvFileKind("", "Ahmed Fathy CV.doc"), "docx", "a .doc name alone is a Word file");
  assert.equal(
    detectCvFileKind("application/octet-stream", "Ahmed Fathy CV.DOC"),
    "docx",
    "a generic mime with a .doc name is a Word file, whatever the case of the extension",
  );
  // And the rest of the router is untouched — a new CvFileKind for this format would have been the
  // obvious change and is the wrong one (recruitment-legacy-doc-cv.test.ts explains why: four UI
  // call sites and the intake service read this value).
  assert.equal(detectCvFileKind("application/msword", "CV.doc"), "docx", "the labelled legacy .doc is unchanged");
  assert.equal(detectCvFileKind("application/pdf", "CV.pdf"), "pdf", "a PDF is unchanged");
  assert.equal(detectCvFileKind("image/jpeg", "CV.jpg"), "image", "a photographed CV is unchanged");
  assert.equal(detectCvFileKind("text/plain", "notes.txt"), "unsupported", "a format with no reader is still unsupported");

  // ── 4 · The transport is a RENDER, with nothing a download manager can match on ────────────────
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  const response = read("../src/lib/recruitment/file-response.ts");
  const responseCode = response.replace(/^[ \t]*\/\/.*$/gm, "");
  const docTextBranch = responseCode.slice(
    responseCode.indexOf('format") === "doc-text"'),
    responseCode.indexOf('format") === "base64"'),
  );
  assert.ok(docTextBranch.length > 0, "the doc-text branch must come BEFORE the base64 one, which is where the other test slices");
  assert.doesNotMatch(
    docTextBranch,
    /Content-Disposition/,
    "the doc-text mode must send NO Content-Disposition — a filename is half of what a download manager matches on, and this mode is a render, not a file",
  );
  assert.doesNotMatch(
    docTextBranch,
    /download\.mimeType/,
    "the doc-text mode must not advertise the document's own mime type — it is JSON about the file, not the file",
  );
  assert.match(docTextBranch, /"Cache-Control": "private, no-store"/, "a CV's text may not be cached");
  assert.match(
    docTextBranch,
    /status: 415/,
    "bytes that are not a legacy .doc must be refused in plain words, never answered with an empty document",
  );

  // ── 5 · The manager's door is still shut, and this went through it as a RENDER ─────────────────
  //
  // The owner blocked the manager's download on 2026-09-09. That block is an allow-list of modes
  // that paint something, and `doc-text` joins it for the same reason `base64` is on it: it hands
  // over no file. candidate-call-claims.test.ts pins the list itself; what matters here is that
  // this format did not get onto the manager's screen by reopening the door.
  const managerRoute = read("../app/api/recruitment/hiring-manager/candidates/[candidateId]/files/[fileId]/route.ts");
  assert.match(
    managerRoute,
    /RENDER_ONLY_FORMATS\s*=\s*new Set\(\["base64", "doc-text"\]\)/,
    "the manager's route serves the legacy .doc as a RENDER, on the same closed allow-list",
  );

  // ── 6 · The page: read as text, redacted where it must be, and never a dead end ────────────────
  const modal = read("../src/components/recruitment/cv-preview-modal.tsx");
  const modalCode = modal.replace(/^[ \t]*\/\/.*$/gm, "");

  assert.doesNotMatch(
    modalCode,
    /can't be previewed here/,
    "the dead end is gone: a legacy .doc is read, not refused with a sentence",
  );
  assert.match(
    modalCode,
    /const docTextUrl = `\$\{downloadUrl\}\$\{separator\}format=doc-text`/,
    "the lines are fetched from the same file URL in the render mode, so every caller of this component gets them",
  );
  assert.match(
    modalCode,
    /setDocText\(\{ lines, truncated: Boolean\(payload\.truncated\), url: docTextUrl \}\)/,
    "the lines that came back are what gets painted, tagged with the URL they came from so the previous candidate's CV cannot linger under the new candidate's name",
  );
  assert.match(
    modalCode,
    /lines\.length === 0[\s\S]{0,200}CvPreviewNotice/,
    "a .doc with no text in it is a DESIGNED answer (never reported to the error monitor), not a failure",
  );

  // THE REDACTION RULE REACHES THIS PAGE TOO. A CV prints its own phone number, and on a manager's
  // portal that number is covered until he takes the call (the owner, 2026-09-09). A new way to
  // show a CV that skipped the mask would hand back exactly what every other control on that screen
  // takes away.
  assert.match(
    modalCode,
    /redactPhones \? maskPhoneLike\(line\) : line/,
    "every line is masked where phones must be covered — a new render path may not be the hole",
  );
  // And a manager may not lift the text out of the render either, which is the rule the PDF text
  // layer already follows.
  assert.match(
    modalCode,
    /allowDownload \? "" : "select-none"/,
    "where the document itself may not be taken, its text may not be selected out of the render",
  );
  // The page is fitted by the SAME mechanism as the other two formats, which is what keeps it off
  // the owner's no-horizontal-scroll rule at 375px.
  assert.match(
    modalCode,
    /querySelectorAll<HTMLElement>\("\.docx, \.cv-text-page, canvas"\)/,
    "the text page is measured by the fit-to-width pass, or it would overflow its column at its fixed Word width",
  );
  assert.match(modalCode, /cv-text-page/, "the page carries the class the measurement looks for");
}

/** node:assert's rejects() with a message that names what was being defended. */
async function assertRejects(run: () => Promise<unknown>, message: string): Promise<void> {
  let threw: unknown = null;
  try {
    await run();
  } catch (caught) {
    threw = caught;
  }
  assert.ok(threw instanceof NotALegacyDocError, message);
}
