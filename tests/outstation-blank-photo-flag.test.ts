import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  BLANK_FRAME_MAX_CEILING,
  BLANK_FRAME_MEAN_CEILING,
  classifyPhotoFrame,
  measureImageFrame,
  PHOTO_FRAME_INDEX_ATTRIBUTE,
  photoFrameMeasurementScript,
} from "@/lib/outstation/photo-frame";

/**
 * "Flag a black evidence photo on the review card." — owner, 2026-09-29.
 *
 * The evidence gate checks a photo EXISTS, never that the frame shows anything, so a capture taken
 * with the lens covered satisfies it completely and the approver is handed a black rectangle with
 * the Phoenix overlay printed on it — indistinguishable from a genuinely dark room.
 *
 * Every number below was measured on production that day, 60 arrival photos, mean luminance of the
 * TOP HALF of each frame (the overlay is white text on black and sits in the bottom half).
 */

/** The real readings. The two blank ones, and the darkest photo that is NOT blank. */
const PRODUCTION = {
  /** OUTSTATION-129, B-119 — a real, genuinely dark photograph. The nearest false positive. */
  darkestReal: { maxLuminance: 42, meanLuminance: 31.7 },
  /** OUTSTATION-102, A-7 — ordinary daylight. */
  brightest: { maxLuminance: 255, meanLuminance: 244.4 },
  /** OUTSTATION-148, AI-0013 — both photos, 07:50 and 08:04, in Cairo. */
  weaam148: { maxLuminance: 5, meanLuminance: 2 },
  /** OUTSTATION-151, AI-0014 — literally nothing. */
  samaa151: { maxLuminance: 0, meanLuminance: 0 },
  /** AI-0013's OTHER trips, which prove it is not her device. */
  weaam135: { maxLuminance: 233, meanLuminance: 180.6 },
} as const;

export function runOutstationBlankPhotoFlagTests() {
  // ── The two real blank frames are caught ─────────────────────────────────────────────────────

  for (const [name, reading] of [["OUTSTATION-151", PRODUCTION.samaa151], ["OUTSTATION-148", PRODUCTION.weaam148]] as const) {
    const frame = classifyPhotoFrame(reading);
    assert.equal(frame.verdict, "no-image", `${name} is black on production and must be flagged`);
    assert.ok(frame.headline, `${name} must carry a sentence the approver can act on`);
  }

  // ── 🔴 And the real photos are NOT ───────────────────────────────────────────────────────────
  //
  // This is the half that matters more. Telling an approver that real evidence is blank is worse
  // than missing the rare black frame: it invites them to disbelieve a photo that is right there.

  for (const [name, reading] of [
    ["the darkest real photo (OUTSTATION-129)", PRODUCTION.darkestReal],
    ["the brightest (OUTSTATION-102)", PRODUCTION.brightest],
    ["AI-0013's own later trip (OUTSTATION-135)", PRODUCTION.weaam135],
  ] as const) {
    const frame = classifyPhotoFrame(reading);
    assert.equal(frame.verdict, "has-image", `${name} must never be called blank`);
    assert.equal(frame.headline, null, `${name} must say nothing at all`);
  }

  // The margin, stated as a test rather than trusted: the nearest real photo must clear BOTH
  // ceilings comfortably, so a slightly darker real photo next month is still safe.
  assert.ok(
    PRODUCTION.darkestReal.meanLuminance > BLANK_FRAME_MEAN_CEILING * 3,
    "the darkest real photo must sit far above the mean ceiling, not just above it",
  );
  assert.ok(
    PRODUCTION.darkestReal.maxLuminance > BLANK_FRAME_MAX_CEILING * 1.5,
    "and comfortably above the peak ceiling too",
  );

  // ── BOTH readings have to be at the floor ────────────────────────────────────────────────────
  //
  // Either one alone is an ordinary photograph: a night shot has a low mean with a bright
  // streetlight in it, and a fogged lens has a flat mid grey with no peak.

  assert.equal(
    classifyPhotoFrame({ maxLuminance: 200, meanLuminance: 2 }).verdict,
    "has-image",
    "a very dark frame with one bright point has detail in it — that is a night photo, not a blank",
  );
  assert.equal(
    classifyPhotoFrame({ maxLuminance: 20, meanLuminance: 19 }).verdict,
    "has-image",
    "a flat dim frame with no peak is still not black, and must not be called one",
  );

  // ── 🔴 It fails to UNKNOWN, never to blank ───────────────────────────────────────────────────
  //
  // A photo that could not be measured is not a photo that is empty. A cross-origin image taints
  // the canvas and `getImageData` throws; that must never read as an accusation.

  for (const [why, reading] of [
    ["no reading at all", { maxLuminance: null, meanLuminance: null }],
    ["only a mean", { maxLuminance: null, meanLuminance: 2 }],
    ["only a peak", { maxLuminance: 5, meanLuminance: null }],
    ["a NaN", { maxLuminance: Number.NaN, meanLuminance: Number.NaN }],
    ["undefined", { maxLuminance: undefined, meanLuminance: undefined }],
  ] as const) {
    const frame = classifyPhotoFrame(reading);
    assert.equal(frame.verdict, "unknown", `${why} must be "unknown", never "no-image"`);
    assert.equal(frame.headline, null, `${why} must produce no claim about the photo`);
  }

  // ── The wording accuses nobody ───────────────────────────────────────────────────────────────

  const headline = classifyPhotoFrame(PRODUCTION.weaam148).headline ?? "";
  assert.match(
    headline,
    /carries no image/,
    "it must say what the FRAME contains — that is the only thing that was measured",
  );
  assert.match(
    headline,
    /time, place and GPS stamped on it are still recorded/,
    "and that the rest of the evidence survives, so a blank frame is not read as no evidence",
  );
  // A stairwell, a night trip and a thumb over the lens produce the same frame. Only a person can
  // tell them apart, and the sentence must not push the reader towards one of them.
  for (const word of ["fraud", "suspicious", "false", "fake", "deliberate", "covered", "refuse", "reject", "invalid"]) {
    assert.ok(
      !headline.toLowerCase().includes(word),
      `the sentence must not contain "${word}" — it reports a measurement, never a motive`,
    );
  }

  // ── 🔴 It never refuses, and it NEVER reaches the rep ────────────────────────────────────────

  const frameSource = readFileSync(
    new URL("../src/lib/outstation/photo-frame.ts", import.meta.url),
    "utf8",
  );
  // Comments STRIPPED first. A whole-file test matches the prose beside the code, and this file's
  // own documentation discusses what would throw inside Chromium — scoped to the whole file, this
  // assertion fails on its own explanation rather than on any statement.
  const frameCode = frameSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(
    !/\bthrow\b/.test(frameCode),
    "photo-frame must never throw: the house rule on this evidence is to flag, never block",
  );

  // THE CRM GOLDEN RULE #1 — the rep's app is easy and BLIND. The measurement is made on the
  // approver's screen, from an image already on it, and nothing is added to any rep-facing path.
  const card = readFileSync(
    new URL("../src/components/outstation/trip-evidence-photos.tsx", import.meta.url),
    "utf8",
  );
  assert.match(card, /classifyPhotoFrame/, "the approver's card must actually classify the frame");
  assert.match(card, /measureImageFrame\(event\.currentTarget\)/, "measured from the loaded image, with no second fetch");
  assert.match(
    card,
    /blankFrame\.verdict === "no-image" && blankFrame\.headline/,
    "and it must render only on a measured blank — never on unknown",
  );

  for (const repFacing of [
    "src/components/outstation/mobile-outstation-wizard.tsx",
    "src/lib/outstation/service.ts",
    "src/lib/outstation/decision.ts",
  ]) {
    const source = readFileSync(new URL(`../${repFacing}`, import.meta.url), "utf8");
    assert.ok(
      !source.includes("classifyPhotoFrame") && !source.includes("photo-frame"),
      `${repFacing} must not read this: a rep is never told a check exists, and it never reaches a `
        + "decision — the system flags an expense and never decides one",
    );
  }

  // The thumbnail measurement needs onLoad, and ZoomablePhoto is the only <img> on that path.
  const zoomable = readFileSync(
    new URL("../src/components/ui/zoomable-photo.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    zoomable,
    /onLoad=\{onLoad\}/,
    "ZoomablePhoto must forward onLoad to the real <img>, or the card measures nothing and the "
      + "flag silently never appears",
  );

  // ── 🔴 The PDF prints the SAME note, measured by the SAME function ───────────────────────────
  //
  // The document's whole contract is to be the review card on paper. A note the screen carries and
  // the PDF drops would make the PDF the less honest of the two — and nothing would look wrong.

  const script = photoFrameMeasurementScript();
  assert.ok(
    script.includes(String(measureImageFrame)),
    "the PDF must run measureImageFrame ITSELF, not a second copy of the measurement written out "
      + "beside it — two implementations of one reading is how the screen and the document drift",
  );
  assert.ok(
    script.includes(`img[${PHOTO_FRAME_INDEX_ATTRIBUTE}]`),
    "and it must select the photos the document actually marks",
  );

  // 🔴 SELF-CONTAINMENT. toString() carries the function's own source and NOTHING it closes over,
  // so a reference to a module constant here throws ReferenceError inside the page — where it is
  // caught, degrades to "unknown", and prints nothing at all. Silent, and permanent.
  for (const outside of [
    "BLANK_FRAME_MEAN_CEILING",
    "BLANK_FRAME_MAX_CEILING",
    "classifyPhotoFrame",
    "PHOTO_FRAME_INDEX_ATTRIBUTE",
  ]) {
    assert.ok(
      !String(measureImageFrame).includes(outside),
      `measureImageFrame must not reference ${outside}: it is shipped into Chromium by toString(), `
        + "which carries no scope, so the reference would be undefined there",
    );
  }

  const pdfRoute = readFileSync(
    new URL("../app/api/admin/outstation/[id]/pdf/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    pdfRoute,
    /photoFrameMeasurementScript\(\)/,
    "the PDF route must ship the shared measurement into its page",
  );
  assert.match(
    pdfRoute,
    /classifyPhotoFrame\(/,
    "and take the verdict on the server, from the same classifier the card uses, so the sentence "
      + "printed is the sentence shown",
  );
  assert.match(
    pdfRoute,
    /catch \{[\s\S]{0,240}return new Map\(\);/,
    "an unreadable measurement must produce no notes and no error — a PDF is never worth failing "
      + "over a note about a photograph",
  );

  const doc = readFileSync(
    new URL("../src/lib/outstation/review-document.ts", import.meta.url),
    "utf8",
  );
  assert.match(doc, /photo\.frameNote \?/, "the document must render the note when it has one");
  assert.ok(
    doc.includes('${PHOTO_FRAME_INDEX_ATTRIBUTE}="${index}"'),
    "and mark each photo with its index, or the readings cannot be matched back to the photos",
  );
}
