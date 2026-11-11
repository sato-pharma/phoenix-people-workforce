import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  dhashFromGreyscale,
  hammingDistance,
  hashHalves,
  isComparableHash,
  isAdministratorCapture,
  judgePhotoDuplicate,
  PHOENIX_CRM_STRONG_PHOTO_FLAGS,
  PHOTO_DHASH_MAX_DISTANCE,
  PHOTO_DHASH_MAX_SET_BITS,
  PHOTO_DHASH_MIN_SET_BITS,
  PHOTO_HASH_BITS,
  PHOTO_HASH_HEIGHT,
  PHOTO_HASH_WIDTH,
  setBits,
  type PhotoFingerprint,
} from "../src/lib/phoenix-crm/duplicate-photos.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the duplicate photo check (D5 of the owner's plan).
 *
 * The live photo is the one part of a visit a spoofed coordinate cannot fake. What it does not stop
 * is a rep photographing one door and sending the same picture again, for the next customer or for
 * a day he never left the house.
 *
 * ## The five things that would be wrong quietly
 *
 *   1. **The same-door rule.** A rep visiting one doctor every month photographs the same door from
 *      the same three feet of pavement. Those pictures are near-identical BY CONSTRUCTION, and a
 *      fuzzy hash accusing him of re-using one is a false accusation of fraud against a real person
 *      — worse than every catch it would buy. Near-identical fires only across a different customer
 *      or a different rep.
 *   2. **The plain-image rule.** A dhash asks "is this pixel brighter than its neighbour". Point a
 *      camera at a white wall and every answer is the same, so two photographs with nothing in them
 *      collide perfectly while having nothing to do with each other. A collapsed hash is refused,
 *      not matched.
 *   3. **A retry is not a duplicate.** The phone re-sends a capture whose reply was lost. Same
 *      visit, same photo — excluded by subject before anything is compared.
 *   4. **Not read is not clean.** A photo that could not be downloaded is recorded with a failure so
 *      it is never fetched again AND so the board can tell the two apart.
 *   5. **🔴 The unique key.** `judgeCapture` upserts on the capture alone, so a second detector
 *      filing evidence about one visit would REPLACE the GPS verdict instead of sitting beside it —
 *      the write succeeds, the row is there, and the flags are simply somebody else's.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

function sql(path: string): string {
  return stripSqlComments(readFileSync(new URL(path, ROOT), "utf8"));
}

const MIGRATION = "supabase/migrations/20260927120000_phoenix_crm_photo_fingerprints.sql";

/** A 9×8 greyscale thumbnail with a left-to-right ramp on every row — plenty of picture in it. */
function ramp(shift = 0): number[] {
  const pixels: number[] = [];
  for (let y = 0; y < PHOTO_HASH_HEIGHT; y += 1) {
    for (let x = 0; x < PHOTO_HASH_WIDTH; x += 1) {
      // Descending across the row, so every comparison is "brighter than its right neighbour" = 1.
      pixels.push(Math.max(0, 250 - x * 25 - ((y + shift) % 2) * 3));
    }
  }
  return pixels;
}

function photo(patch: Partial<PhotoFingerprint> = {}): PhotoFingerprint {
  return {
    subjectKind: "visit",
    subjectId: "VISIT-1",
    photoPath: "FAISAL/2026/09/visit/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg",
    repHrId: "B-200",
    customerId: "CUST-1",
    capturedAt: new Date("2026-09-20T09:00:00Z"),
    sha256: "a".repeat(64),
    dhash: "f0f0f0f0f0f0f0f0",
    ...patch,
  };
}

export function runPhoenixCrmDuplicatePhotosTests(): void {
  // ── 1. The hash itself, against pixels written by hand ─────────────────────────────────────────
  {
    assert.equal(PHOTO_HASH_BITS, 64, "8 comparisons a row over 8 rows");

    const hash = dhashFromGreyscale(ramp());
    assert.equal(hash, "ffffffffffffffff", "every pixel brighter than the one on its right is 64 set bits");
    assert.equal(setBits(String(hash)), 64);

    // A flat image has no brighter-than anywhere, so the hash collapses to nothing at all.
    const flat = dhashFromGreyscale(new Array(PHOTO_HASH_WIDTH * PHOTO_HASH_HEIGHT).fill(200));
    assert.equal(flat, "0000000000000000", "a blank wall carries no picture");

    // A buffer of the wrong size is refused rather than hashed out of whatever is in memory: a wrong
    // hash is compared against everybody, while a missing one is recorded as not checked.
    assert.equal(dhashFromGreyscale([1, 2, 3]), null, "a thumbnail of the wrong size has no hash");
    assert.equal(dhashFromGreyscale(new Array(PHOTO_HASH_WIDTH * PHOTO_HASH_HEIGHT).fill(Number.NaN)), null);

    assert.equal(hammingDistance("0000000000000000", "ffffffffffffffff"), 64, "opposites differ in every bit");
    assert.equal(hammingDistance("f0f0f0f0f0f0f0f0", "f0f0f0f0f0f0f0f1"), 1);
    assert.equal(hammingDistance("f0f0f0f0f0f0f0f0", "nope"), null, "a hash that is not 16 hex characters is not compared");
  }

  // ── 2. 🔴 The plain-image rule ─────────────────────────────────────────────────────────────────
  //
  // Two different photographs of two different white corridors produce the same empty hash. Judging
  // them a match would accuse two honest reps at once, which is why a collapsed hash is refused.
  {
    assert.equal(isComparableHash("0000000000000000"), false, "an all-dark hash carries no picture");
    assert.equal(isComparableHash("ffffffffffffffff"), false, "and neither does an all-bright one");
    assert.equal(isComparableHash("f0f0f0f0f0f0f0f0"), true, `32 set bits is well inside the band (min ${PHOTO_DHASH_MIN_SET_BITS})`);
    assert.equal(isComparableHash(null), false);

    const blank = "0000000000000000";
    const verdict = judgePhotoDuplicate(
      photo({ dhash: blank, sha256: "b".repeat(64) }),
      [photo({ subjectId: "VISIT-2", photoPath: "p2.jpg", repHrId: "B-300", customerId: "CUST-9", dhash: blank, sha256: "c".repeat(64) })],
    );
    assert.deepEqual(verdict.flags, [], "🔴 two blank photographs are not the same photograph");
    assert.equal(verdict.signals.tooPlainToCompare, true, "and the board is told it could not be compared, not that it was clean");
  }

  // ── 3. 🔴 THE SAME-DOOR RULE ───────────────────────────────────────────────────────────────────
  //
  // The one rule that carries this whole detector. A rep at the same doctor month after month
  // photographs the same door from the same spot, and that is honest work.
  {
    const near = "f0f0f0f0f0f0f0f1";
    const mine = photo({ dhash: "f0f0f0f0f0f0f0f0", sha256: "b".repeat(64) });

    const sameDoor = judgePhotoDuplicate(mine, [
      photo({ subjectId: "VISIT-OLD", photoPath: "old.jpg", dhash: near, sha256: "c".repeat(64), capturedAt: new Date("2026-08-20T09:00:00Z") }),
    ]);
    assert.deepEqual(sameDoor.flags, [], "🔴 the same rep at the same customer photographs the same door — that is not a duplicate");

    const otherCustomer = judgePhotoDuplicate(mine, [
      photo({ subjectId: "VISIT-OLD", photoPath: "old.jpg", customerId: "CUST-2", dhash: near, sha256: "c".repeat(64) }),
    ]);
    assert.deepEqual(otherCustomer.flags, ["photo_near_identical"], "one doctor's door standing in for another's is not honest work");

    const otherRep = judgePhotoDuplicate(mine, [
      photo({ subjectId: "VISIT-OLD", photoPath: "old.jpg", repHrId: "B-999", dhash: near, sha256: "c".repeat(64) }),
    ]);
    assert.deepEqual(otherRep.flags, ["photo_near_identical"], "nor is one rep's photograph turning up in another rep's day");

    // An unknown customer on either side is not evidence of the same door, so the pair stays
    // comparable — treating two nulls as equal would switch the rule ON for every unlinked capture.
    const unlinked = judgePhotoDuplicate(photo({ ...mine, customerId: null }), [
      photo({ subjectId: "VISIT-OLD", photoPath: "old.jpg", customerId: null, dhash: near, sha256: "c".repeat(64) }),
    ]);
    assert.deepEqual(unlinked.flags, ["photo_near_identical"], "two unknown customers are not one known customer");
  }

  // ── 3b. 🔴 The administrator files evidence, he does not capture it (sweep, 11 Nov 2026) ─────────
  //
  // Six validations the owner made for Nada Saied on 10 Nov attached pictures already on file, and reached the
  // SFE Manager's board as exact duplicates. His captures are neither judged nor matched against — and a rep who
  // re-uses the original photograph is still caught by the original.
  {
    const bytes = "e".repeat(64);
    const original = photo({ subjectId: "PLACE-REP", photoPath: "rep.jpg", repHrId: "B-129", customerId: "CUST-1", sha256: bytes });
    const adminCopy = photo({ subjectKind: "place", subjectId: "PLACE-ADMIN", photoPath: "admin.jpg", repHrId: "B-10", customerId: "CUST-2", sha256: bytes });
    assert.equal(isAdministratorCapture(adminCopy), true);
    assert.equal(isAdministratorCapture({ repHrId: " b-10 " }), true, "compared as a person key, whatever the column's case and padding");
    assert.equal(isAdministratorCapture(original), false);

    const judgedAdmin = judgePhotoDuplicate(adminCopy, [original]);
    assert.deepEqual(judgedAdmin.flags, [], "🔴 the owner's validation with a photo already on file is not a duplicate");
    assert.equal(judgedAdmin.signals.administratorCapture, true, "and the record says why it was not compared");

    const repReuse = photo({ subjectId: "VISIT-REUSE", photoPath: "reuse.jpg", repHrId: "B-300", customerId: "CUST-3", sha256: bytes });
    assert.deepEqual(
      judgePhotoDuplicate(repReuse, [adminCopy, original]).flags,
      ["photo_exact_duplicate"],
      "a rep re-using the picture still matches the ORIGINAL",
    );
    const matched = judgePhotoDuplicate(repReuse, [adminCopy, original]).signals.exactMatches as Array<{ subjectId: string }>;
    assert.deepEqual(matched.map((entry) => entry.subjectId), ["PLACE-REP"], "and never the owner's copy of it");
  }

  // ── 4. The distance, and where it stops ────────────────────────────────────────────────────────
  {
    const base = "ffff0000ffff0000";
    // Six bits away is inside; seven is out. Both across a different customer, so the same-door rule
    // is not what is doing the work here.
    const sixAway = "ffff003fffff0000";
    const sevenAway = "ffff007fffff0000";
    assert.equal(hammingDistance(base, sixAway), PHOTO_DHASH_MAX_DISTANCE);
    assert.equal(hammingDistance(base, sevenAway), PHOTO_DHASH_MAX_DISTANCE + 1);

    const subject = photo({ dhash: base, sha256: "b".repeat(64) });
    const inside = judgePhotoDuplicate(subject, [photo({ subjectId: "V2", photoPath: "p2.jpg", customerId: "CUST-2", dhash: sixAway, sha256: "c".repeat(64) })]);
    assert.deepEqual(inside.flags, ["photo_near_identical"], `${PHOTO_DHASH_MAX_DISTANCE} bits is a re-encode`);
    assert.equal(inside.signals.nearestDistance, PHOTO_DHASH_MAX_DISTANCE);

    const outside = judgePhotoDuplicate(subject, [photo({ subjectId: "V2", photoPath: "p2.jpg", customerId: "CUST-2", dhash: sevenAway, sha256: "c".repeat(64) })]);
    assert.deepEqual(outside.flags, [], "a bit further out is a different picture");
  }

  // ── 5. The exact match, which no rule narrows ──────────────────────────────────────────────────
  //
  // Identical BYTES are not something a camera can produce twice — not at the same door, not
  // anywhere. So the same rep and the same customer are no defence, and this one flag is the only
  // one the board treats as standing on its own.
  {
    const shared = "d".repeat(64);
    const verdict = judgePhotoDuplicate(photo({ sha256: shared }), [
      photo({ subjectId: "VISIT-OLD", photoPath: "old.jpg", sha256: shared, capturedAt: new Date("2026-08-01T09:00:00Z") }),
    ]);
    assert.deepEqual(verdict.flags, ["photo_exact_duplicate"], "the same file at the same door is still the same file");
    assert.equal(verdict.strong, true, "and it stands on its own");
    assert.equal((verdict.signals.exactMatches as unknown[]).length, 1);

    // Near-identical is not also reported against a prior already matched exactly — one duplicate is
    // one duplicate, and a board that says it twice reads as two.
    assert.equal(verdict.flags.includes("photo_near_identical"), false, "one prior produces one flag");

    // A photo that could not be read has no sha256, and a null must never match another null.
    const unread = judgePhotoDuplicate(photo({ sha256: null, dhash: null }), [photo({ subjectId: "V2", photoPath: "p2.jpg", sha256: null, dhash: null })]);
    assert.deepEqual(unread.flags, [], "two photos nobody could read are not two copies of one photo");
  }

  // ── 6. A retried upload of the same capture is not a duplicate ─────────────────────────────────
  {
    const shared = "e".repeat(64);
    const retry = judgePhotoDuplicate(photo({ sha256: shared }), [photo({ photoPath: "second-slot.jpg", sha256: shared })]);
    assert.deepEqual(retry.flags, [], "the same visit sent twice is one visit");
    assert.equal(retry.signals.comparedWith, 0, "and there was nothing left to compare it with");

    const itself = judgePhotoDuplicate(photo(), [photo()]);
    assert.deepEqual(itself.flags, [], "a photo is not a duplicate of itself");
  }

  // ── 7. 🔴 The unique key, and the clobber it was hiding ────────────────────────────────────────
  {
    const migration = sql(MIGRATION);
    assert.ok(
      migration.includes("add constraint phoenix_crm_location_integrity_subject_source_key unique (subject_kind, subject_id, source)"),
      "🔴 one verdict per capture PER DETECTOR — without source in the key the photo sweep overwrites the GPS verdict",
    );
    assert.ok(
      migration.includes("drop constraint if exists phoenix_crm_location_integrity_subject_kind_subject_id_key"),
      "and the old two-column key goes, or the wider one can never hold two rows",
    );
    assert.ok(migration.includes("add column if not exists source text not null default 'gps'"), "every row already on file is the position detector's");

    const gps = source("src/lib/phoenix-crm/server/location-integrity.ts");
    assert.ok(gps.includes('source: "gps"'), "the position detector says who it is");
    assert.ok(gps.includes('{ onConflict: "subject_kind,subject_id,source" }'), "and conflicts on the wider key");
    assert.equal(gps.includes('{ onConflict: "subject_kind,subject_id" }'), false, "the narrow conflict target is gone, not merely joined");

    const sweep = source("src/lib/phoenix-crm/server/photo-dupes.ts");
    assert.ok(sweep.includes('source: "photo"'), "and so does the photo detector");
    assert.ok(sweep.includes('{ onConflict: "subject_kind,subject_id,source" }'), "which writes beside the position verdict, never over it");
  }

  // ── 8. Read once, forever — and not-read is not clean ──────────────────────────────────────────
  {
    const sweep = source("src/lib/phoenix-crm/server/photo-dupes.ts");
    assert.ok(sweep.includes("phoenix_crm_photos_to_fingerprint"), "the backlog is an anti-join in the database, not a table pulled into memory");
    assert.ok(sweep.includes("ignoreDuplicates: true"), "a photo already fingerprinted is never re-read");
    assert.ok(/failure = "the object is missing or empty"/.test(sweep), "a photo that could not be read is recorded as NOT CHECKED");
    assert.ok(sweep.includes("await import(\"sharp\")"), "sharp is loaded lazily — a top-level import of it has 500'd a whole page here before");
    assert.ok(sweep.includes("downloadPhoto"), "and the bucket is opened by photos.ts, never here");
    // Phoenix CRM performance audit, 2026-10-16: the photos are read a few at a time, each still in
    // its own try, and the rows are built back in the candidates' own order.
    assert.ok(sweep.includes("mapWithConcurrency(candidates, PHOTO_READS_AT_ONCE, async (candidate) => {"), "the photos are read a few at a time");
    assert.ok(sweep.includes("const PHOTO_READS_AT_ONCE = 4;"), "four at once — each holds one photo's bytes while sharp reads it");
    assert.ok(
      sweep.includes("for (const [position, candidate] of candidates.entries()) {"),
      "and the fingerprint rows are written in the candidates' own order, as the one-at-a-time walk wrote them",
    );

    const migration = sql(MIGRATION);
    // 🔴 Anchored on the absence of `desc`, not on the presence of the clause: "order by
    // c.captured_at" is a substring of "order by c.captured_at desc", so the obvious assertion
    // passes on the very change it exists to catch. It did, the first time this was written.
    assert.ok(/\border by c\.captured_at\s*\n/.test(migration), "the backlog is ordered by when the photo was captured");
    assert.equal(
      /\border by (?:c|picked)\.captured_at\s+desc/.test(migration),
      false,
      "🔴 OLDEST first — a newest-first sweep with a nightly cap leaves an old backlog permanently behind fresher work, and a photo never hashed can be re-used for ever",
    );
    assert.ok(migration.includes("constraint phoenix_crm_photo_fingerprints_photo unique (photo_path)"), "the photo path is the identity");
  }

  // ── 9. The rep is never told, and the sweep tells nobody at all ────────────────────────────────
  {
    const route = source("app/api/cron/phoenix-crm-integrity-sweep/route.ts");
    assert.ok(route.includes("assertCronAuthorized"), "the sweep is reachable only with the cron secret");
    assert.ok(route.includes("withDeadMansSwitch"), "and a night that never ran is visible as a night that never ran");
    // 🔴 It writes evidence and stops. A nightly message about a rep's honesty is a rumour on a
    // schedule, and a rep who hears a check exists is a rep who knows what to defeat.
    for (const word of ["notify", "sendNotification", "telegram", "sendEmail"]) {
      assert.equal(route.toLowerCase().includes(word.toLowerCase()), false, `the sweep must not ${word} anybody — it writes evidence and stops`);
    }
    const sweep = source("src/lib/phoenix-crm/server/photo-dupes.ts");
    for (const word of ["notify", "sendNotification", "telegram", "sendEmail"]) {
      assert.equal(sweep.toLowerCase().includes(word.toLowerCase()), false, `the sweep must not ${word} anybody`);
    }

    const board = source("src/lib/phoenix-crm/server/integrity-board.ts");
    assert.ok(board.includes("canReadIntegrityBoard"), "the photo cases are behind the same audience as the position cases");
    assert.ok(board.includes("PHOENIX_CRM_PHOTO_LABELS"), "and the board is the one place the two detectors' wording is read together");
  }

  // ── 10. 🔴 PERF-013: the integer hash maths gives BYTE-IDENTICAL verdicts ──────────────────────
  //
  // The string bit-by-bit maths was the nightly sweep's CPU, so it became two 32-bit XORs and a
  // popcount, with each prior's hash parsed once per fingerprint object. A false-positive photo flag
  // accuses a rep of fraud, so the only acceptable change is one that answers EXACTLY as before: the
  // old string implementations live below as the reference, and the new code must match them on
  // every pair and every verdict.
  {
    const random = seededRandom(0x5a70_2026);
    const randomHash = (): string => {
      let hex = "";
      for (let index = 0; index < 16; index += 1) hex += Math.floor(random() * 16).toString(16);
      return hex;
    };

    // Invalid inputs keep their null: uppercase, 15 characters, 17 characters, empty, non-hex, null.
    const invalid: Array<string | null> = [
      "F0F0F0F0F0F0F0F0",
      "f0f0f0f0f0f0f0f",
      "f0f0f0f0f0f0f0f00",
      "",
      "g0f0f0f0f0f0f0f0",
      " 0f0f0f0f0f0f0f0",
      null,
    ];
    for (const bad of invalid) {
      assert.equal(setBits(bad as string), null, `setBits(${JSON.stringify(bad)}) must stay null, exactly as the string version answered`);
      assert.equal(referenceSetBits(bad as string), null, `the reference itself answers null for ${JSON.stringify(bad)}`);
      assert.equal(
        hammingDistance(bad as string, "f0f0f0f0f0f0f0f0"),
        null,
        `hammingDistance with ${JSON.stringify(bad)} on the left must stay null`,
      );
      assert.equal(
        hammingDistance("f0f0f0f0f0f0f0f0", bad as string),
        null,
        `hammingDistance with ${JSON.stringify(bad)} on the right must stay null`,
      );
      assert.equal(hashHalves(bad as string), null, `hashHalves(${JSON.stringify(bad)}) keeps the HEX_HASH validity check`);
    }
    // The sign bit of each half: a high nibble of 8–f makes `| 0` negative, which XOR must not mind.
    assert.equal(hammingDistance("8000000080000000", "0000000000000000"), 2, "the sign bit of each half counts as one bit");
    assert.equal(setBits("ffffffff00000000"), 32, "a negative high half still counts 32 bits");

    for (let index = 0; index < 10_000; index += 1) {
      const left = randomHash();
      // Every fourth pair is a near neighbour, so small distances are exercised and not only ~32.
      const right = index % 4 === 0 ? flipBits(left, Math.floor(random() * 8), random) : randomHash();
      assert.equal(
        hammingDistance(left, right),
        referenceHammingDistance(left, right),
        `🔴 hammingDistance(${left}, ${right}) must equal the string reference — a different count changes who is flagged`,
      );
      assert.equal(setBits(left), referenceSetBits(left), `🔴 setBits(${left}) must equal the string reference`);
    }

    // A seeded 2,000-photo corpus with near-duplicates, plain walls, unreadable photos, re-sent files,
    // shared customers and shared reps — every verdict must deep-equal the reference judge's.
    const bases = Array.from({ length: 40 }, () => randomHash());
    const shas = Array.from({ length: 30 }, (_, index) => index.toString(16).padStart(64, "0"));
    const corpus: PhotoFingerprint[] = [];
    for (let index = 0; index < 2_000; index += 1) {
      const roll = random();
      let dhash: string | null;
      if (roll < 0.05) dhash = null;
      else if (roll < 0.1) dhash = random() < 0.5 ? "0000000000000001" : "fffffffffffffffe";
      else if (roll < 0.12) dhash = "NOT-A-HASH";
      else if (roll < 0.7) dhash = flipBits(bases[Math.floor(random() * bases.length)], Math.floor(random() * 10), random);
      else dhash = randomHash();
      corpus.push({
        subjectKind: random() < 0.8 ? "visit" : "place",
        subjectId: `S-${Math.floor(random() * 1_900)}`,
        photoPath: `photos/${index}.jpg`,
        repHrId: `B-${100 + Math.floor(random() * 12)}`,
        customerId: random() < 0.1 ? null : `CUST-${Math.floor(random() * 25)}`,
        capturedAt: new Date(Date.UTC(2026, 8, 1) + index * 60_000),
        sha256: random() < 0.08 ? null : random() < 0.15 ? shas[Math.floor(random() * shas.length)] : `${index}`.padStart(64, "f"),
        dhash,
      });
    }

    let exactFlagged = 0;
    let nearFlagged = 0;
    let tooPlain = 0;
    // Every fifth photo is judged against all 2,000 — the reference string judge is the slow part,
    // and 400 full-corpus verdicts already exercise every branch (asserted just below).
    for (let index = 0; index < corpus.length; index += 5) {
      const subject = corpus[index];
      const actual = judgePhotoDuplicate(subject, corpus);
      const expected = referenceJudge(subject, corpus);
      assert.deepEqual(
        actual,
        expected,
        `🔴 judgePhotoDuplicate must deep-equal the reference judge for corpus photo ${index} — a changed verdict is a changed accusation`,
      );
      if (actual.flags.includes("photo_exact_duplicate")) exactFlagged += 1;
      if (actual.flags.includes("photo_near_identical")) nearFlagged += 1;
      if (actual.signals.tooPlainToCompare === true) tooPlain += 1;
    }
    assert.ok(exactFlagged > 0 && nearFlagged > 0 && tooPlain > 0, "the corpus must exercise exact, near and too-plain verdicts or it proves nothing");

    // The per-object memo must not answer from a stale parse when a fingerprint's dhash changes.
    const mutable = corpus.map((entry) => ({ ...entry }));
    const subject = mutable[0];
    judgePhotoDuplicate(subject, mutable);
    for (const entry of mutable) entry.dhash = entry.dhash === null ? null : flipBits(subject.dhash ?? randomHash(), 1, random);
    assert.deepEqual(
      judgePhotoDuplicate(subject, mutable),
      referenceJudge(subject, mutable),
      "🔴 a fingerprint whose dhash changed after it was first judged must be re-parsed, never answered from the memo",
    );

    // The sweep yields to the event loop while it judges, so a large batch never stalls live requests.
    const sweep = source("src/lib/phoenix-crm/server/photo-dupes.ts");
    assert.ok(
      /for\s*\(\s*let i = 0;\s*i < fresh\.length;[^]*?if\s*\(\s*i % 25 === 24\s*\)\s*await new Promise\(\s*\(resolve\)\s*=>\s*setImmediate\(resolve\)\s*\);[^]*?judgePhotoDuplicate\(photo, corpus\)/.test(
        sweep,
      ),
      "the photo sweep's judging loop must yield via setImmediate every 25 photos before it judges",
    );
  }

  console.log("phoenix-crm duplicate photos: OK");
}

// ── The reference: the string implementations as they stood before PERF-013 ─────────────────────

const REFERENCE_HEX_HASH = /^[0-9a-f]{16}$/;

function referenceBitsOf(hash: string): string | null {
  if (!REFERENCE_HEX_HASH.test(hash)) return null;
  let bits = "";
  for (const character of hash) bits += parseInt(character, 16).toString(2).padStart(4, "0");
  return bits;
}

function referenceSetBits(hash: string): number | null {
  const bits = referenceBitsOf(hash);
  if (bits === null) return null;
  let count = 0;
  for (const bit of bits) if (bit === "1") count += 1;
  return count;
}

function referenceHammingDistance(left: string, right: string): number | null {
  const a = referenceBitsOf(left);
  const b = referenceBitsOf(right);
  if (a === null || b === null) return null;
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) distance += 1;
  return distance;
}

function referenceIsComparable(hash: string | null): boolean {
  if (!hash) return false;
  const count = referenceSetBits(hash);
  return count !== null && count >= PHOTO_DHASH_MIN_SET_BITS && count <= PHOTO_DHASH_MAX_SET_BITS;
}

function referenceDescribe(prior: PhotoFingerprint): Record<string, unknown> {
  return {
    subjectKind: prior.subjectKind,
    subjectId: prior.subjectId,
    photoPath: prior.photoPath,
    repHrId: prior.repHrId,
    customerId: prior.customerId,
    capturedAt: prior.capturedAt.toISOString(),
  };
}

function referenceJudge(subject: PhotoFingerprint, priors: ReadonlyArray<PhotoFingerprint>): ReturnType<typeof judgePhotoDuplicate> {
  const sameCustomer = (left: string | null, right: string | null) => left !== null && right !== null && left === right;
  const others = priors.filter((prior) => prior.subjectId !== subject.subjectId && prior.photoPath !== subject.photoPath);
  if (others.length === 0) return { flags: [], strong: false, signals: { comparedWith: 0 } };
  const flags: Array<"photo_exact_duplicate" | "photo_near_identical"> = [];
  const signals: Record<string, unknown> = { comparedWith: others.length };
  const exact = subject.sha256 ? others.filter((prior) => prior.sha256 !== null && prior.sha256 === subject.sha256) : [];
  if (exact.length > 0) {
    flags.push("photo_exact_duplicate");
    signals.exactMatches = exact.map((prior) => referenceDescribe(prior));
  }
  if (referenceIsComparable(subject.dhash)) {
    const alreadyExact = new Set(exact.map((prior) => prior.photoPath));
    const near = others
      .filter((prior) => !alreadyExact.has(prior.photoPath) && referenceIsComparable(prior.dhash))
      .filter((prior) => prior.repHrId !== subject.repHrId || !sameCustomer(prior.customerId, subject.customerId))
      .map((prior) => ({ prior, distance: referenceHammingDistance(String(subject.dhash), String(prior.dhash)) }))
      .filter((entry): entry is { prior: PhotoFingerprint; distance: number } => entry.distance !== null)
      .filter((entry) => entry.distance <= PHOTO_DHASH_MAX_DISTANCE)
      .sort((left, right) => left.distance - right.distance);
    if (near.length > 0) {
      flags.push("photo_near_identical");
      signals.nearMatches = near.map((entry) => ({ ...referenceDescribe(entry.prior), distance: entry.distance }));
      signals.nearestDistance = near[0].distance;
    }
  } else if (subject.dhash) {
    signals.tooPlainToCompare = true;
  }
  return {
    flags: [...flags].sort(),
    strong: flags.some((flag) => PHOENIX_CRM_STRONG_PHOTO_FLAGS.includes(flag)),
    signals,
  };
}

/** mulberry32 — a small seeded generator, so a failure reproduces exactly. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Flip `count` random bits of a 16-hex-character hash (a bit may flip back; that is fine). */
function flipBits(hash: string, count: number, random: () => number): string {
  const nibbles = hash.split("").map((character) => parseInt(character, 16));
  for (let flip = 0; flip < count; flip += 1) {
    const bit = Math.floor(random() * 64);
    nibbles[bit >> 2] ^= 1 << (3 - (bit & 3));
  }
  return nibbles.map((nibble) => nibble.toString(16)).join("");
}
