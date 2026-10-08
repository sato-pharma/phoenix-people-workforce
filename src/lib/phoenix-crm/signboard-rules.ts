import { isMatchableName, normalizeContactName } from "@/lib/crm/campaign-contact-match";
import { jaccardSimilarity, nameTokens } from "@/lib/pharmacy-master/pharmacy-matching";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Does the photo show WHO the customer is?
//
// THE MODULE VALIDATED A LOCATION WHILE THE OWNER GRADED AN IDENTIFICATION, and only the first was
// ever built. Of 643 places validated in the five days from 03 Oct 2026, 233 photos were good, 231
// weak and 179 failed — street shots with no building in them, blank walls, a photo of a paper
// timetable, a photo taken from inside a moving car. The accuracy gate (both readings within
// PLACE_MAX_ACCURACY_METERS) was working the whole time and is not the problem: nothing anywhere
// asked the photograph to show whose doorway it is. The one identity check that existed, the Google
// listing comparison, is AM-only by `googleCheckApplies`, so 561 of the 643 (87%) had none at all.
//
// Owner, 2026-10-08: require the customer's name always, no exception for a building with no
// nameplate; frame the signboard in the camera; read the captured picture before accepting it; then
// validate or send it for review.
//
// 🔴 "NEVER A PERSON — AM SIGN / PM SIGN" (his own words, same day, asked directly). A hospital signs
// ITSELF, not the people who hold clinics inside it. So an AM capture is judged against the account
// name on his own list row and is NEVER judged against a person's name, and an AM signboard that
// names nobody is a MATCH — not a `no_name`. A PM capture is judged against the person. Getting this
// backwards would hold close to every hospital validation in the company, which is a different
// feature and not the one he asked for.
//
// IT ADVISES ON ONE AXIS AND GATES ON ANOTHER, deliberately. A confident negative HOLDS the place
// exactly as a Google mismatch holds it — saved, the customer left under To validate, one review row
// raised, the rep reading only that the system is checking. NO SIGNAL NEVER HOLDS: it saves and
// validates as before and records WHY it could not judge, because holding on the absence of an
// answer would hold every validation in the field the moment the provider is slow or the key lapses.
//
// 🔴 THE WORD "doctor" CANNOT APPEAR IN ANY STRING IN THIS FILE, nor "account", "doctors" or
// "accounts" — tests/phoenix-crm-am-pm-words.test.ts sweeps this whole tree with stripComments and
// refuses them inside any quoted string. "customer", "clinic" and "practice" are the words. Do not
// add an exception; the sweep is why the module's vocabulary is consistent in front of a rep.
//
// Invisible by rule: nothing here names a model, and `nameScore` is stored for later analysis and
// never rendered. The pure/server split is the house one — this file does the judging and holds no
// I/O; src/lib/phoenix-crm/server/signboard-check.ts fetches the bytes and calls the model.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type SignboardVerdictKind =
  /** The signboard names the customer this place was validated for. */
  | "match"
  /** The signboard names somebody else. A held place and a review row. */
  | "other_name"
  /**
   * No name the capture can be judged on: the photo shows no signboard at all (either list), or a PM
   * signboard carries no person's name. Held the same way. Never given to an AM signboard that names
   * nobody — that is a match.
   */
  | "no_name"
  /** No answer was obtained. NEVER a pass, and never a hold — see the header. */
  | "unjudged";

export type SignboardCheckReason =
  /** No key is configured in this environment. */
  | "no_api_key"
  /** The photo could not be read back out of the bucket. */
  | "no_bytes"
  /** An answer came back but carried nothing usable, or either name folded away to nothing. */
  | "unreadable"
  /** The call failed, timed out, or the image could not be decoded. */
  | "call_failed"
  /** The place is already held for another reason, so no call was made at all. */
  | "held_elsewhere"
  /** The signboard names somebody else. */
  | "sign_other_name"
  /** A PM signboard with no person's name on it. */
  | "sign_no_name";

export type PhoenixCrmSignboardCheck = {
  verdict: SignboardVerdictKind;
  /** Why, for every verdict but `match`. Null on a match. */
  reason: SignboardCheckReason | null;
  /** What the signboard reads, verbatim, in its own script. Arabic stays Arabic. */
  signText: string | null;
  /** The names on the signboard that read as PEOPLE. */
  personNames: string[];
  /** The names on the signboard that read as PLACES — a hospital, a centre, a unit. */
  placeNames: string[];
  /** 0–1. Stored for analysis, NEVER rendered. */
  nameScore: number | null;
  /** One sentence a Super Admin can act on. */
  note: string | null;
  checkedAt: string;
  /**
   * How much of the image was cropped off the bottom before it was read, so a stored verdict can be
   * understood on its own years later without re-deriving the stamp arithmetic below.
   */
  croppedFraction: number | null;
};

// ── The stamp band ──────────────────────────────────────────────────────────────────────────────
//
// 🔴 THE CUSTOMER'S NAME IS BURNED INTO THE STORED PHOTO BEFORE THE UPLOADED FILE EXISTS.
// place-editor.tsx passes `title={`Phoenix CRM customer: ${customerName}`}` into
// buildEvidenceStampLines, which makes it the FIRST caption, drawn at the TOP of drawStamp's caption
// box; and live-photo-capture.tsx creates its one and only Blob AFTER drawStamp has already mutated
// the canvas. So reading the stored object directly would read the name off Phoenix's own caption
// and report a match on a photograph of a blank wall — a guaranteed false pass, every time.
//
// The band is therefore cropped off before the image is read, from drawStamp's OWN arithmetic
// applied to the DECODED image's own dimensions. 🔴 Never from a number the browser sends: at 1280
// wide the title's baseline sits 266 px above the bottom edge, so clamping a forged-small height to
// a one-line minimum still leaves the name in frame, and a forged number buys exactly the false pass
// this crop exists to prevent.
//
// Measured against the two canvas shapes getCompressedEvidenceCanvasSize produces (longest side
// 1280), with the frame guide's own bottom edge at 0.44 of the height:
//
//   portrait  720 x 1280  fontSize 16  lineHeight 22  pad 12  band 200 px  0.156 -> clamped 0.18
//   landscape 1280 x 720  fontSize 28  lineHeight 39  pad 21  band 354 px        0.49
//
// which is why SIGNBOARD_FRAME_NOTE's box sits HIGH in the viewfinder: the frame is what makes this
// crop free in both orientations, with 38 points of clearance in portrait and 7 in landscape.
// Moving that box down silently crops signboards off, and
// tests/phoenix-crm-signboard-check.test.ts asserts the clearance in both shapes so it cannot.

/**
 * A bound, not a measurement. The captions are the title (which wraps on a long name), "Photo
 * taken:", the address, the territory, the coordinates (the address wraps too) and "Location
 * captured:". Eight covers every shape seen; being generous here costs picture area and nothing else,
 * where being mean costs a false pass.
 */
export const SIGNBOARD_STAMP_WORST_CASE_LINES = 8;
/** A one-line band is ~0.06 of a portrait frame, and no real stamp is ever that short. */
export const SIGNBOARD_CROP_MIN_FRACTION = 0.18;
/** Past this the crop would be eating the picture, so stop and let the prompt's own guard carry it. */
export const SIGNBOARD_CROP_MAX_FRACTION = 0.6;

/**
 * What fraction of the bottom of a stored place photo is Phoenix's own caption box.
 *
 * 🔴 This restates `drawStamp` in src/components/phoenix-crm/live-photo-capture.tsx line for line.
 * The two must agree, and the test compares both canvas shapes against the frame guide, so a change
 * to one without the other goes red rather than quietly cropping a signboard away.
 */
export function stampBandFraction(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return SIGNBOARD_CROP_MAX_FRACTION;
  }
  const fontSize = Math.max(16, Math.round(width * 0.022));
  const lineHeight = Math.round(fontSize * 1.38);
  const pad = Math.round(fontSize * 0.75);
  const band = SIGNBOARD_STAMP_WORST_CASE_LINES * lineHeight + pad * 2;
  const fraction = band / height;
  if (fraction < SIGNBOARD_CROP_MIN_FRACTION) return SIGNBOARD_CROP_MIN_FRACTION;
  if (fraction > SIGNBOARD_CROP_MAX_FRACTION) return SIGNBOARD_CROP_MAX_FRACTION;
  return Math.round(fraction * 10000) / 10000;
}

// ── The name ────────────────────────────────────────────────────────────────────────────────────

/**
 * Is the customer's name on this signboard?
 *
 * 🔴 FOLDED WITH `normalizeContactName` AND NOTHING ELSE. This repository holds six Arabic folds and
 * five of them are wrong for this job. It is the only one that strips the honorifics (its
 * TITLE_TOKENS carries د, دكتور, الدكتور, dr, prof and the rest), and a signboard reading "د. أحمد
 * سمير" against a list row reading "أحمد سمير" is the single commonest shape here —
 * `normalizeArabicPharmacyName` would call that a partial match on a coin toss. It also already has
 * a SQL twin, `public.phoenix_crm_fold_name`, which tests/phoenix-crm-customer-name-fold.test.ts
 * compares against it literally, so a THIRD fold is the precise drift that test exists to refuse.
 *
 * `listingIsAccount` in google-place-rules.ts is the near miss: its stemWord and KIND_WORDS are
 * built for facility names and would stem a person's. Its QUORUM is sound, though, and is borrowed —
 * every folded token of three characters or more must appear on the signboard, except that a name of
 * three tokens or more may lose one, which is what lets a signboard drop a grandfather's name
 * without letting a bare "أحمد" match a stranger.
 *
 * Returns `matches: null` whenever either side folds away to nothing, following the direct-order
 * reader's own rule: an absence is not a mismatch, and the two must never be shown the same way.
 */
export function signNamesCustomer(input: {
  customerName: string | null;
  listType: PhoenixCrmListType;
  personNames: readonly string[];
  placeNames: readonly string[];
  signText: string | null;
}): { matches: boolean | null; score: number | null } {
  const wanted = normalizeContactName(input.customerName);
  if (!wanted) return { matches: null, score: null };

  // 🔴 The owner's AM/PM rule, in code: AM reads the PLACE names, PM reads the PEOPLE. The whole
  // signboard text is the fallback for both, because a model that did not split the names cleanly
  // has still transcribed them.
  const preferred = input.listType === "PM" ? input.personNames : input.placeNames;
  const haystacks = [...preferred, ...(input.signText ? [input.signText] : [])];
  if (haystacks.length === 0) return { matches: null, score: null };

  const wantedTokens = wanted.split(" ").filter((token) => token.length >= 3);
  if (wantedTokens.length === 0) return { matches: null, score: null };
  // A name of three tokens or more survives losing one; two tokens must both be there.
  const allowedMisses = wantedTokens.length >= 3 ? 1 : 0;

  let best: number | null = null;
  let matched = false;
  for (const candidate of haystacks) {
    const folded = normalizeContactName(candidate);
    if (!folded) continue;
    const have = new Set(folded.split(" ").filter(Boolean));
    const missing = wantedTokens.filter((token) => !have.has(token)).length;
    if (missing <= allowedMisses) matched = true;
    const score = jaccardSimilarity(nameTokens(candidate), nameTokens(input.customerName));
    best = best === null ? score : Math.max(best, score);
  }

  if (best === null) return { matches: null, score: null };
  return { matches: matched, score: Math.round(best * 100) / 100 };
}

/** A pharmacy is not validated against a person or a practice, so it is not asked this question. */
export function signboardApplies(listType: PhoenixCrmListType): boolean {
  return listType !== "Pharmacy";
}

/**
 * "No answer was obtained, and here is why" — the record every absence takes.
 *
 * 🔴 IT IS STILL WRITTEN, and that is the point: without it the place row cannot tell NOT CHECKED
 * from CHECKED AND CLEAN, which is the distinction the nightly photo sweep's own rules insist on for
 * the same reason. It is the shape the server builds on a missing key, missing bytes or a failed
 * call, and the shape a place held for another reason takes so no second model call is ever paid for.
 */
export function signboardUnjudged(
  reason: SignboardCheckReason,
  croppedFraction: number | null = null,
): PhoenixCrmSignboardCheck {
  return {
    checkedAt: new Date().toISOString(),
    croppedFraction,
    nameScore: null,
    note: null,
    personNames: [],
    placeNames: [],
    reason,
    signText: null,
    verdict: "unjudged",
  };
}

/**
 * What the database keeps when a signboard HOLDS the place — the review row's evidence.
 *
 * 🔴 IT LANDS IN A COLUMN LITERALLY NAMED `google`, AND THE NAME IS WRONG RATHER THAN THE CODE.
 * `phoenix_crm_validation_reviews.google` was added when the Google listing comparison was the only
 * thing that could hold a place; it is generically "the evidence the system judged on", and the one
 * review row per place (its UNIQUE index on `place_id`) is the only slot there is. Renaming it would
 * be a migration across two 300-line security-definer functions, the queue loader and its board, for
 * no behaviour at all — so `verdict: "signboard"` says which detector spoke and this comment says the
 * column name is a leftover. Do not "fix" the record into the Google shape to match the column.
 */
export function signboardHoldRecord(
  check: PhoenixCrmSignboardCheck,
  point: { lat: number; lon: number; accuracyMeters: number | null; source: string },
): Record<string, unknown> {
  return {
    verdict: "signboard",
    reason: check.reason,
    checkedAt: check.checkedAt,
    signText: check.signText,
    personNames: check.personNames,
    placeNames: check.placeNames,
    note: check.note,
    nameScore: check.nameScore,
    croppedFraction: check.croppedFraction,
    point: { lat: point.lat, lon: point.lon, accuracyMeters: point.accuracyMeters, source: point.source },
    // The queue renders Google's candidate listings from this key. A signboard hold has none, and an
    // empty list is what the loader already treats as "nothing to show" — never a missing key.
    listings: [],
  };
}

/**
 * Turn what the model reported into one of the four verdicts.
 *
 * 🔴 The AM half of the owner's rule lives here as well as in `signNamesCustomer`: a capture that is
 * not PM is never given `no_name`, however empty `personNames` is. A hospital that signs itself and
 * nobody else is exactly right, and the check must say so.
 */
export function judgeSignboard(input: {
  customerName: string | null;
  listType: PhoenixCrmListType;
  signPresent: boolean | null;
  signText: string | null;
  personNames: readonly string[];
  placeNames: readonly string[];
  note: string | null;
  croppedFraction: number;
}): PhoenixCrmSignboardCheck {
  const base = {
    checkedAt: new Date().toISOString(),
    croppedFraction: input.croppedFraction,
    note: input.note,
    personNames: [...input.personNames],
    placeNames: [...input.placeNames],
    signText: input.signText,
  };

  // 🔴 NO SIGNBOARD AT ALL, said confidently. The owner's first ruling is "require the customer's name
  // always, no exception for a building with no nameplate", and the commonest failure among the 643
  // was exactly this — a street, a blank wall, a car window. A model that is merely UNSURE answers
  // null and lands in `unjudged` below; only an explicit `false` with nothing transcribed holds.
  const nothingRead = input.personNames.length === 0 && input.placeNames.length === 0 && !input.signText;
  if (input.signPresent === false && nothingRead) {
    return { ...base, nameScore: null, reason: "sign_no_name", verdict: "no_name" };
  }

  // 🔴 THE AM HALF OF "NEVER A PERSON": an AM signboard is read for a PLACE name only. One that names
  // no place — the hospital signs its departments, or only the people holding clinics inside it — is a
  // MATCH, because the person's name is the one thing an AM capture is never judged on.
  if (input.listType !== "PM" && input.placeNames.length === 0 && !nothingRead) {
    return { ...base, nameScore: null, reason: null, verdict: "match" };
  }

  // A PM signboard that names a place and no person at all is the "no nameplate" case for a person.
  if (input.listType === "PM" && input.personNames.length === 0 && !input.signText && input.placeNames.length > 0) {
    return { ...base, nameScore: null, reason: "sign_no_name", verdict: "no_name" };
  }

  const { matches, score } = signNamesCustomer({
    customerName: input.customerName,
    listType: input.listType,
    personNames: input.personNames,
    placeNames: input.placeNames,
    signText: input.signText,
  });

  if (matches === true) return { ...base, nameScore: score, reason: null, verdict: "match" };

  if (matches === false) {
    // A PM capture with a readable signboard that names no person at all is the "no nameplate" case
    // the owner ruled on: it is held, not accepted. Everything else that read a name and found the
    // wrong one is `other_name`.
    const namesNobody = input.listType === "PM" && input.personNames.length === 0;
    return {
      ...base,
      nameScore: score,
      reason: namesNobody ? "sign_no_name" : "sign_other_name",
      verdict: namesNobody ? "no_name" : "other_name",
    };
  }

  // null — either side folded away, or nothing was transcribed. Never a pass, never a hold.
  return { ...base, nameScore: score, reason: "unreadable", verdict: "unjudged" };
}

/**
 * Does this verdict hold the place for the owner to look at?
 *
 * 🔴 `unjudged` is false here, in every one of its reasons, and that is the whole safety property of
 * this module. The key has run out of credits twice in this system's life, both times silently and
 * both times reading as a retryable rate limit; a hold on the absence of an answer would have held
 * every validation in the field on both days.
 */
export function signboardHoldsForReview(check: PhoenixCrmSignboardCheck): boolean {
  return check.verdict === "other_name" || check.verdict === "no_name";
}

/** A one-token name is not evidence of anything, here as everywhere else in this repository. */
export function signboardNameIsUsable(customerName: string | null): boolean {
  return isMatchableName(normalizeContactName(customerName));
}
