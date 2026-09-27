/**
 * Phoenix CRM — is this photo the same photo? Pure arithmetic, no I/O.
 *
 * WHY THIS EXISTS. The live photo is the one part of a visit a spoofed coordinate cannot fake: the
 * phone asks for a single-use upload slot the moment the shutter fires, the server times the slot,
 * and the visit is dated by the slot rather than by anything the phone claims. What that does NOT
 * stop is a rep photographing one door and sending the same picture again — for the next customer,
 * for tomorrow, for a day he never left the house. The slot is honest about WHEN; only the pixels
 * can answer WHETHER IT IS A NEW PHOTO.
 *
 * THE REP IS NEVER TOLD (owner, 2026-09-25, and Golden Rule #1). Nothing here refuses a save, changes
 * a message, or adds a field to a screen a rep can open. The evidence goes to a table his app never
 * reads, and it is read by the Super Admin and the SFE Manager alone. A message reading "this photo
 * was used before" teaches the one person you caught exactly what to defeat, and he tells everyone.
 *
 * TWO HASHES, BECAUSE ONE OF THEM IS BLIND TO THE EASY DODGE.
 *
 *   sha256 — the same FILE sent twice. Exact, free, and impossible to reach by accident: two presses
 *   of a shutter never produce identical bytes, because the sensor noise alone differs in every
 *   frame. It is also trivially defeated — re-save the picture, screenshot it, let a different app
 *   re-encode it, and every byte changes while the picture does not.
 *
 *   dhash — the same PICTURE, whatever the bytes. A 64-bit difference hash over a 9×8 greyscale
 *   thumbnail: each bit says whether one pixel is brighter than the pixel to its right. Re-encoding,
 *   resizing, recompressing and mild cropping leave that comparison alone, so the dodge above walks
 *   straight into it. It is fuzzy, which is the whole point and also its whole danger — see below.
 *
 * NO FALSE POSITIVE IS WORTH A CATCH. A flag here is read by a human as a reason to look at a
 * photograph. Accusing an honest rep of re-using a picture is a far worse outcome than missing a rep
 * who did, so every bound below is set where honest work cannot reach it, and the two guards that
 * matter — the same-door rule and the plain-image rule — are in the code rather than in a comment.
 */

/** What a photo can be marked with. Only the exact match stands on its own. */
export type PhoenixCrmPhotoFlag =
  /** Byte-for-byte the same file as a photo already on record. */
  | "photo_exact_duplicate"
  /** The same picture, re-encoded — and at another customer, or another rep's. */
  | "photo_near_identical";

/**
 * 🔴 **Only the exact match is strong, and that is deliberate.**
 *
 * Byte-identical is a fact: a camera cannot produce it twice, so the file was kept and re-sent.
 * Near-identical is a judgement made by a 64-bit thumbnail, and a thumbnail can be fooled by two
 * genuinely different photographs of the same beige corridor. The board sorts strong cases to the
 * top, and the top of that board must never fill with honest reps standing in plain hospitals.
 */
export const PHOENIX_CRM_STRONG_PHOTO_FLAGS: readonly PhoenixCrmPhotoFlag[] = ["photo_exact_duplicate"];

/** Human wording for the board. Plain English — the reader is a manager, not an engineer. */
export const PHOENIX_CRM_PHOTO_LABELS: Record<PhoenixCrmPhotoFlag, string> = {
  photo_exact_duplicate: "The identical photo file was sent before",
  photo_near_identical: "The same picture as another rep's, or another customer's",
};

// ── The hash ────────────────────────────────────────────────────────────────────────────────────

/** 9 columns compared pairwise give 8 bits a row; 8 rows give 64. */
export const PHOTO_HASH_WIDTH = 9;
export const PHOTO_HASH_HEIGHT = 8;
export const PHOTO_HASH_BITS = (PHOTO_HASH_WIDTH - 1) * PHOTO_HASH_HEIGHT;

/**
 * How many of the 64 bits may differ and still be "the same picture".
 *
 * Six is about 9% of the hash. Re-encoding a JPEG at another quality moves one or two bits; a resize
 * moves two or three; a crop of a few percent moves a handful. Two photographs of DIFFERENT scenes
 * sit far away — the expected distance between unrelated images is 32, half the bits, and the tail
 * below ten is thin. The gap between "re-encoded" and "different" is wide enough that the exact
 * number matters much less than being inside it.
 */
export const PHOTO_DHASH_MAX_DISTANCE = 6;

/**
 * 🔴 **The plain-image guard, and the reason this detector does not accuse people in corridors.**
 *
 * A dhash asks "is this pixel brighter than its neighbour". Point a camera at a white wall, an
 * overexposed doorway or a dark stairwell and the answer is the same everywhere, so the hash
 * collapses towards all-zeros or all-ones — and two photographs with nothing in them collide
 * perfectly while having nothing whatever to do with each other. A hash whose set bits fall outside
 * this band carries too little picture to compare, and this module refuses to judge it at all rather
 * than calling it a match.
 */
export const PHOTO_DHASH_MIN_SET_BITS = 8;
export const PHOTO_DHASH_MAX_SET_BITS = 56;

/**
 * The difference hash of a greyscale thumbnail, as 16 lowercase hex characters.
 *
 * `pixels` is a row-major `PHOTO_HASH_WIDTH × PHOTO_HASH_HEIGHT` greyscale buffer — one byte a pixel,
 * exactly what an image library's raw output gives. A buffer of the wrong size returns null rather
 * than a hash of whatever happened to be in memory: a wrong hash is worse than no hash, because no
 * hash is recorded as "not checked" and a wrong one is compared against everybody.
 */
export function dhashFromGreyscale(pixels: ArrayLike<number>): string | null {
  if (pixels.length !== PHOTO_HASH_WIDTH * PHOTO_HASH_HEIGHT) return null;
  let bits = "";
  for (let y = 0; y < PHOTO_HASH_HEIGHT; y += 1) {
    for (let x = 0; x < PHOTO_HASH_WIDTH - 1; x += 1) {
      const here = Number(pixels[y * PHOTO_HASH_WIDTH + x]);
      const right = Number(pixels[y * PHOTO_HASH_WIDTH + x + 1]);
      if (!Number.isFinite(here) || !Number.isFinite(right)) return null;
      bits += here > right ? "1" : "0";
    }
  }
  let hex = "";
  for (let index = 0; index < bits.length; index += 4) hex += parseInt(bits.slice(index, index + 4), 2).toString(16);
  return hex;
}

const HEX_HASH = /^[0-9a-f]{16}$/;

function bitsOf(hash: string): string | null {
  if (!HEX_HASH.test(hash)) return null;
  let bits = "";
  for (const character of hash) bits += parseInt(character, 16).toString(2).padStart(4, "0");
  return bits;
}

/** How many of the 64 bits are set. Exported because the plain-image guard is worth reading. */
export function setBits(hash: string): number | null {
  const bits = bitsOf(hash);
  if (bits === null) return null;
  let count = 0;
  for (const bit of bits) if (bit === "1") count += 1;
  return count;
}

/** Bits that differ between two hashes, or null if either is not a 64-bit hash. */
export function hammingDistance(left: string, right: string): number | null {
  const a = bitsOf(left);
  const b = bitsOf(right);
  if (a === null || b === null) return null;
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) distance += 1;
  return distance;
}

/** Does this hash carry enough picture to be compared at all? See `PHOTO_DHASH_MIN_SET_BITS`. */
export function isComparableHash(hash: string | null): boolean {
  if (!hash) return false;
  const count = setBits(hash);
  return count !== null && count >= PHOTO_DHASH_MIN_SET_BITS && count <= PHOTO_DHASH_MAX_SET_BITS;
}

// ── The judgement ───────────────────────────────────────────────────────────────────────────────

export type PhotoFingerprint = {
  subjectKind: "visit" | "place";
  subjectId: string;
  photoPath: string;
  repHrId: string;
  customerId: string | null;
  capturedAt: Date;
  /** Null when the photo could not be read — "not checked", never "clean". */
  sha256: string | null;
  dhash: string | null;
};

export type PhotoDuplicateVerdict = {
  flags: PhoenixCrmPhotoFlag[];
  strong: boolean;
  /** The numbers behind the flags, kept so a later reading can audit the call rather than trust it. */
  signals: Record<string, unknown>;
};

const EMPTY: PhotoDuplicateVerdict = { flags: [], strong: false, signals: {} };

/**
 * Judge one photo against the ones already on record.
 *
 * 🔴 **THE SAME-DOOR RULE, which governs this whole detector.** `photo_near_identical` fires ONLY
 * across a different customer or a different rep. A rep visiting the same doctor every month
 * photographs the same door from the same three feet of pavement, and those photographs are
 * near-identical BY CONSTRUCTION — a fuzzy hash cannot tell that apart from a picture re-used, and
 * it must never try, because the honest reading is overwhelmingly the likelier one. What a rep
 * cannot honestly produce is one doctor's door standing in for another doctor's, or one rep's
 * photograph turning up in another rep's day, and those two are exactly what is left.
 *
 * The exact match is not narrowed that way, and that is not an oversight: identical BYTES are not
 * something a camera can produce twice at the same door or anywhere else, so the same customer and
 * the same rep are no defence. The one innocent path to identical bytes — the same capture uploaded
 * twice after a lost reply — is excluded by subject, below, before anything is compared.
 */
export function judgePhotoDuplicate(
  subject: PhotoFingerprint,
  priors: ReadonlyArray<PhotoFingerprint>,
): PhotoDuplicateVerdict {
  // A retried upload of the SAME capture, and the photo comparing with itself. Both are the same
  // visit, and a visit cannot be a duplicate of itself however many times the phone sent it.
  const others = priors.filter((prior) => prior.subjectId !== subject.subjectId && prior.photoPath !== subject.photoPath);
  if (others.length === 0) return { ...EMPTY, signals: { comparedWith: 0 } };

  const flags: PhoenixCrmPhotoFlag[] = [];
  const signals: Record<string, unknown> = { comparedWith: others.length };

  const exact = subject.sha256
    ? others.filter((prior) => prior.sha256 !== null && prior.sha256 === subject.sha256)
    : [];
  if (exact.length > 0) {
    flags.push("photo_exact_duplicate");
    signals.exactMatches = exact.map((prior) => describe(prior));
  }

  if (isComparableHash(subject.dhash)) {
    const alreadyExact = new Set(exact.map((prior) => prior.photoPath));
    const near = others
      .filter((prior) => !alreadyExact.has(prior.photoPath) && isComparableHash(prior.dhash))
      // 🔴 The same-door rule. Read the header before widening this.
      .filter((prior) => prior.repHrId !== subject.repHrId || !sameCustomer(prior.customerId, subject.customerId))
      .map((prior) => ({ prior, distance: hammingDistance(String(subject.dhash), String(prior.dhash)) }))
      .filter((entry): entry is { prior: PhotoFingerprint; distance: number } => entry.distance !== null)
      .filter((entry) => entry.distance <= PHOTO_DHASH_MAX_DISTANCE)
      .sort((left, right) => left.distance - right.distance);
    if (near.length > 0) {
      flags.push("photo_near_identical");
      signals.nearMatches = near.map((entry) => ({ ...describe(entry.prior), distance: entry.distance }));
      signals.nearestDistance = near[0].distance;
    }
  } else if (subject.dhash) {
    // Recorded so the board can tell "compared and clean" from "too plain to compare".
    signals.tooPlainToCompare = true;
  }

  return {
    flags: [...flags].sort(),
    strong: flags.some((flag) => PHOENIX_CRM_STRONG_PHOTO_FLAGS.includes(flag)),
    signals,
  };
}

/**
 * Two captures are "the same customer" only when both name one and they agree.
 *
 * A null customer is not a match for another null: a place validated before its customer was linked,
 * and a visit with no customer, are not evidence of being at the same door. Treating two unknowns as
 * equal would silently switch the same-door rule ON for every unlinked capture and suppress real
 * matches — the safer reading of an unknown here is "we cannot claim these are the same door", which
 * leaves the pair comparable.
 */
function sameCustomer(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left === right;
}

function describe(prior: PhotoFingerprint): Record<string, unknown> {
  return {
    subjectKind: prior.subjectKind,
    subjectId: prior.subjectId,
    photoPath: prior.photoPath,
    repHrId: prior.repHrId,
    customerId: prior.customerId,
    capturedAt: prior.capturedAt.toISOString(),
  };
}
