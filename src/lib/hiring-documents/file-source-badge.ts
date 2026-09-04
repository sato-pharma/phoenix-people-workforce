// How each stored file says where it came from, on screen.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A LEAF MODULE, NOT A CONSTANT IN THE COMPONENT, for one reason: `Record<HiringDocumentFileSource,
// …>` looks like it gates the build and does not. `ignoreBuildErrors` lets a missing key compile,
// build and deploy, and the first anybody hears of it is `undefined.tone` throwing on the Hiring
// Documents screen. Backing an exhaustive Record with a runtime assertion in a registered test is
// the house rule, and a test cannot import a `.tsx` here — so the map lives in a `.ts` that
// `tests/hiring-document-file-source.test.ts` can read.
//
// `BadgeTone` is imported as a TYPE, which is erased, so nothing pulls the UI package into a test
// or towards a server bundle.

import type { BadgeTone } from "@/components/ui/badge";
import type { HiringDocumentFileSource } from "@/lib/hiring-documents/types";

/**
 * The wording matters as much as the tone.
 *
 * "Issued by Phoenix" says the thing somebody opening the file is entitled to know: this is the
 * document that was put in front of the employee, not a photograph of the ink on it. These land in
 * slots named "Signed employment contract", so a label that merely said "PDF" would let a reader
 * assume the opposite.
 */
export const FILE_SOURCE_BADGE: Record<
  HiringDocumentFileSource,
  { label: string; tone: BadgeTone }
> = {
  issued: { label: "Issued by Phoenix", tone: "info" },
  scan: { label: "Scanned in Phoenix", tone: "ok" },
  upload: { label: "Uploaded as-is", tone: "neutral" },
};
