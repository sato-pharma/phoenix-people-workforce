import assert from "node:assert/strict";

import { FILE_SOURCE_BADGE } from "@/lib/hiring-documents/file-source-badge";
import {
  HIRING_DOCUMENT_FILE_SOURCES,
  readHiringDocumentFileSource,
} from "@/lib/hiring-documents/types";

// How a stored file says where it came from.
//
// THE FAILURE THIS GUARDS IS A ROW THAT IS RIGHT IN THE DATABASE AND WRONG ON EVERY SCREEN. A
// filed paper is written with `source: 'issued'` and read back through one function; the shape to
// avoid is `value === "scan" ? "scan" : "upload"`, which quietly reports every issued document as
// "Uploaded as-is". Nothing errors, nothing looks broken, and an employment contract Phoenix
// generated is presented as a file somebody uploaded.

/** Every source survives the round trip, including the one added for filing. */
function testEverySourceReadsBackAsItself() {
  for (const source of HIRING_DOCUMENT_FILE_SOURCES) {
    assert.equal(
      readHiringDocumentFileSource(source),
      source,
      `${source} must read back as itself, not be narrowed away`,
    );
  }

  // The one that a two-way narrowing loses.
  assert.equal(readHiringDocumentFileSource("issued"), "issued");
}

/**
 * Anything unrecognised reads as `upload`, which is the right default because it claims the least:
 * it says only "this file arrived", with no assertion about polishing or about who produced it.
 * Defaulting to `issued` would be the dangerous direction — it would put Phoenix's name on a file
 * nobody can account for.
 */
function testAnUnknownSourceClaimsTheLeast() {
  assert.equal(readHiringDocumentFileSource(null), "upload");
  assert.equal(readHiringDocumentFileSource(""), "upload");
  assert.equal(readHiringDocumentFileSource("ISSUED"), "upload", "the match is exact, not casual");
  assert.equal(readHiringDocumentFileSource("something-new"), "upload");
}

/**
 * THE RUNTIME ASSERTION BEHIND AN EXHAUSTIVE `Record`. `Record<HiringDocumentFileSource, …>` looks
 * like it gates the build and does not — `ignoreBuildErrors` lets a missing key compile, build and
 * deploy, and the first anybody hears of it is `undefined.tone` throwing on the Hiring Documents
 * screen for whichever employee happens to have that file.
 */
function testEverySourceHasSomethingToSayOnScreen() {
  for (const source of HIRING_DOCUMENT_FILE_SOURCES) {
    const badge = FILE_SOURCE_BADGE[source];
    assert.ok(badge, `${source} has no badge, so the file list would throw on it`);
    assert.ok(badge.label.trim().length > 0, `${source} has an empty label`);
    assert.ok(badge.tone.trim().length > 0, `${source} has no tone`);
  }

  assert.equal(Object.keys(FILE_SOURCE_BADGE).length, HIRING_DOCUMENT_FILE_SOURCES.length);

  // The wording of this one is load-bearing. A filed copy sits in a slot named "Signed employment
  // contract" and IS the unsigned original, so the label has to say who produced it — a reader who
  // assumes the opposite is reading it as evidence that somebody signed something.
  assert.equal(FILE_SOURCE_BADGE.issued.label, "Issued by Phoenix");
}

export async function runHiringDocumentFileSourceTests() {
  testEverySourceReadsBackAsItself();
  testAnUnknownSourceClaimsTheLeast();
  testEverySourceHasSomethingToSayOnScreen();
}
