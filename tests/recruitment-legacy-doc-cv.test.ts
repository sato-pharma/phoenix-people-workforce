import assert from "node:assert/strict";

import { detectCvFileKind, isLegacyDocBytes } from "../src/lib/recruitment/cv-file-kind.ts";

/**
 * Pins the Word-format split that left four real candidates permanently unreadable.
 *
 * Found 2026-08-27 re-running the CV extraction for the unresolved candidates. Both targets
 * failed identically:
 *
 *   hatem marzouk   ->  Could not find the body element: are you sure this is a docx file?
 *   Salma Ragab     ->  Could not find the body element: are you sure this is a docx file?
 *
 * detectCvFileKind answers "docx" for anything labelled application/msword, and the extractor
 * handed every "docx" to mammoth, which reads ONLY the modern OOXML ZIP. A Word 97-2003 binary
 * therefore threw on every run, forever — the re-read script retries failures, so these four
 * would have failed again on every future pass at zero progress.
 *
 * The trap that decides the shape of the fix: the MIME label is wrong in BOTH directions in
 * this corpus, so it cannot be the discriminator. Measured against production storage
 * (project ozucdzovmcqvepbozvqf), all five stored CVs labelled application/msword:
 *
 *   nagwa fanous     d0cf11e0a1b11ae1   legacy OLE2  .doc    0 extraction rows
 *   Mostafa Elgendy  d0cf11e0a1b11ae1   legacy OLE2  .doc    0 extraction rows
 *   hatem marzouk    d0cf11e0a1b11ae1   legacy OLE2  .doc    0 extraction rows
 *   Salma Ragab      d0cf11e0a1b11ae1   legacy OLE2  .doc    0 extraction rows
 *   Peter Nagy       504b03040a000000   real OOXML  .docx    2 rows, read fine by mammoth
 *
 * So routing on `mimeType === "application/msword"` would have BROKEN Peter Nagy's file, which
 * works today. Only the first bytes are true. That is what isLegacyDocBytes tests, and why the
 * check lives at the byte level rather than in detectCvFileKind (which never sees the bytes).
 *
 * THE FIVE NAMES ARE INVENTED. They were the real applicants' until 2026-08-28. The magic bytes,
 * the MIME label and the row counts are the measurement and are untouched — the identities were
 * never what this test is about.
 */
export function runLegacyDocCvTests() {
  const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  const OOXML_ZIP = [0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00];

  // The headline. A legacy .doc must be recognised from its bytes so it never reaches mammoth.
  assert.equal(
    isLegacyDocBytes(Buffer.from([...OLE2, 0x00, 0x11, 0x22])),
    true,
    "an OLE2 compound file (Word 97-2003 .doc) must be recognised as legacy",
  );

  // The other half of the same bug: a real .docx must NOT be diverted to word-extractor, even
  // though this corpus labels one of them application/msword. Peter Nagy's CV is exactly this.
  assert.equal(
    isLegacyDocBytes(Buffer.from([...OOXML_ZIP, 0x00])),
    false,
    "a real OOXML .docx must keep going to mammoth even when its MIME says msword",
  );

  // A PDF and a JPEG never reach this branch, but a signature check that answers "legacy" for
  // them would silently corrupt those paths if the routing ever changed.
  assert.equal(isLegacyDocBytes(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])), false, "a PDF is not a legacy .doc");
  assert.equal(isLegacyDocBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])), false, "a JPEG is not a legacy .doc");

  // Truncated/empty input must not throw or read past the end.
  assert.equal(isLegacyDocBytes(Buffer.from([])), false, "an empty buffer is not a legacy .doc");
  assert.equal(isLegacyDocBytes(Buffer.from(OLE2.slice(0, 4))), false, "a buffer shorter than the signature is not a legacy .doc");

  // A near-miss: the first four bytes match but the rest does not. Guards a truncated signature
  // constant, which would send real .docx files to the wrong reader.
  assert.equal(
    isLegacyDocBytes(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00, 0x00, 0x00])),
    false,
    "all eight signature bytes must match, not just the first four",
  );

  // detectCvFileKind must KEEP answering "docx" for both Word formats. Adding a fifth CvFileKind
  // would be the obvious "fix" and is the wrong one: the kind is consumed by four UI call sites
  // and by cv-file-choice/cv-intake-service, and a new member silently changes what those treat
  // as a usable CV. The format split belongs in the bytes, not in the kind.
  assert.equal(detectCvFileKind("application/msword", "Ibrahim El-tayeb CV.doc"), "docx", "a legacy .doc is still a Word file to the router");
  assert.equal(detectCvFileKind("application/msword", "Peter Nagy CV.docx"), "docx", "a mislabelled .docx is still a Word file to the router");
  assert.equal(detectCvFileKind("application/msword", "DOC-20250121-WA0002."), "docx", "an extensionless msword attachment is still a Word file");
  assert.equal(
    detectCvFileKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "cv.docx"),
    "docx",
    "the modern MIME type is unchanged",
  );
}
