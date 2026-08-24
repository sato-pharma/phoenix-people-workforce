import assert from "node:assert/strict";

import { primaryCvFile } from "../src/lib/recruitment/cv-file-choice.ts";
import type { RecruitmentFile } from "../src/lib/recruitment/types.ts";

function file(overrides: Partial<RecruitmentFile> & { fileName: string }): RecruitmentFile {
  return {
    applicationId: null,
    candidateId: "c1",
    createdAt: "2026-08-01T00:00:00Z",
    driveFileId: null,
    externalUrl: null,
    id: overrides.fileName,
    kind: "cv",
    mimeType: null,
    sizeBytes: null,
    updatedAt: "2026-08-01T00:00:00Z",
    uploadedByHrId: null,
    ...overrides,
  };
}

export function runCvFileChoiceTests() {
  // --- Nothing to show is a real answer, not a crash. Screening mode says "no readable CV
  // --- attached" on the back of this, which is a fact the screener can act on.
  assert.equal(primaryCvFile([]), null);

  // --- Only files FILED as a CV count. An ID scan or a certificate stored under another kind must
  // --- never be presented as the person's CV.
  assert.equal(
    primaryCvFile([file({ fileName: "national-id.pdf", kind: "document" })]),
    null,
    "a non-cv attachment is not a CV, however renderable it is",
  );

  // --- A legacy binary .doc cannot be drawn by this app's viewer, so it must not be chosen and
  // --- left blank on screen — the caller needs the null to say so out loud.
  assert.equal(
    primaryCvFile([file({ fileName: "old-cv.xyz", mimeType: "application/octet-stream" })]),
    null,
    "an unsupported file type is not a candidate for the viewer",
  );

  // --- The newest wins. Candidates re-send updated CVs and the stale one must not be the one the
  // --- decision is made on.
  const chosen = primaryCvFile([
    file({ createdAt: "2026-01-05T00:00:00Z", fileName: "cv-old.pdf" }),
    file({ createdAt: "2026-08-20T00:00:00Z", fileName: "cv-new.pdf" }),
    file({ createdAt: "2026-04-11T00:00:00Z", fileName: "cv-middle.pdf" }),
  ]);
  assert.equal(chosen?.fileName, "cv-new.pdf");

  // --- The newest RENDERABLE one — a newer unsupported upload must not shadow an older CV the
  // --- viewer can actually draw, or screening mode goes blank on a candidate who has a fine CV.
  // --- (Note on the example: detectCvFileKind treats ANY image/* as renderable, so a .tiff would
  // --- be chosen here and then fail in the <img>. That is a gap in the detector, not in this
  // --- chooser, so it is not pinned here — the example below is unambiguously unsupported.)
  const skipUnsupported = primaryCvFile([
    file({ createdAt: "2026-08-24T00:00:00Z", fileName: "cover-letter.txt", mimeType: "text/plain" }),
    file({ createdAt: "2026-08-01T00:00:00Z", fileName: "real-cv.pdf", mimeType: "application/pdf" }),
  ]);
  assert.equal(skipUnsupported?.fileName, "real-cv.pdf");

  // --- Input is not mutated: the profile's file list is rendered elsewhere in its own order, and a
  // --- sort in place would silently reorder it.
  const input = [
    file({ createdAt: "2026-01-01T00:00:00Z", fileName: "a.pdf" }),
    file({ createdAt: "2026-09-01T00:00:00Z", fileName: "b.pdf" }),
  ];
  primaryCvFile(input);
  assert.deepEqual(input.map((f) => f.fileName), ["a.pdf", "b.pdf"], "the caller's array is left alone");
}
