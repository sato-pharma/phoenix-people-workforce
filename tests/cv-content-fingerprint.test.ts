import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { cvContentFingerprint } from "../src/lib/recruitment/files.ts";
import { MATCH_REASON_LABEL } from "../src/lib/recruitment/inbound/recruitment-notify.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const readSource = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

export async function runCvContentFingerprintTests() {
  // 1. The algorithm is PINNED to MD5-hex, and this is the assertion that matters most here.
  //    The 986 rows uploaded before content_md5 existed are backfilled from the Supabase storage
  //    object's eTag, which IS the MD5 of the bytes. Swap this for SHA-256 and nothing throws — new
  //    uploads simply stop matching every backfilled row, the duplicate check silently answers "no
  //    match" for the whole existing pool, and duplicates start being created again exactly as
  //    before. "abc" is a standard MD5 test vector.
  assert.equal(
    cvContentFingerprint(Buffer.from("abc")),
    "900150983cd24fb0d6963f7d28e17f72",
    "cvContentFingerprint must stay MD5-hex — the backfill compares it against storage's eTag, which is the MD5",
  );
  assert.equal(
    cvContentFingerprint(Buffer.from("")),
    "d41d8cd98f00b204e9800998ecf8427e",
    "an empty file still has to hash, not throw",
  );

  // 2. Same bytes, same answer — the whole premise. Two candidates carrying the identical CV must
  //    land on one fingerprint however the bytes reached us.
  const pdfish = Buffer.from("%PDF-1.4\nMazen Roshdy — Medical Representative\n%%EOF");
  assert.equal(
    cvContentFingerprint(pdfish),
    cvContentFingerprint(Buffer.from(pdfish)),
    "identical content must produce one fingerprint",
  );

  // 3. A Buffer and the SAME bytes as an ArrayBuffer must agree. uploadCandidateFile's input type
  //    accepts either, and the intake and the manual upload route do not pass the same one — a
  //    mismatch here would mean a hand-uploaded CV never matches the identical CV that arrived by
  //    WhatsApp, which is one of the two shapes this feature exists to catch.
  const arrayBuffer = pdfish.buffer.slice(pdfish.byteOffset, pdfish.byteOffset + pdfish.byteLength);
  assert.equal(
    cvContentFingerprint(arrayBuffer),
    cvContentFingerprint(pdfish),
    "an ArrayBuffer and a Buffer holding the same bytes must fingerprint the same",
  );

  // 4. One byte apart is a different document. Guards against a truncating or length-only hash.
  const edited = Buffer.from("%PDF-1.4\nMazen Roshdy — Medical Representatiue\n%%EOF");
  assert.equal(edited.length, pdfish.length, "the fixture must differ by content, not by length");
  assert.notEqual(
    cvContentFingerprint(edited),
    cvContentFingerprint(pdfish),
    "a single changed byte must change the fingerprint",
  );

  // 5. It really is the hash of the bytes, not of some wrapper around them.
  assert.equal(
    cvContentFingerprint(pdfish),
    createHash("md5").update(pdfish).digest("hex"),
    "the fingerprint must be the MD5 of the file bytes themselves",
  );

  // 6. The upload path must actually STORE it. Without this write the column stays null, the
  //    lookup matches nothing, and the feature is inert while every test above still passes.
  const filesSource = readSource("src/lib/recruitment/files.ts");
  assert.ok(
    /content_md5:\s*cvContentFingerprint\(/.test(filesSource),
    "uploadCandidateFile must write content_md5 from the bytes — without it the column stays null and the check is inert",
  );

  // 7. ORDERING, which is the load-bearing part. createCandidate cannot be taken back: once it has
  //    inserted, the duplicate record exists. So the fingerprint lookup has to happen BEFORE it, not
  //    after. If a later edit moves the lookup below the call, the feature still "works" in a unit
  //    test and still creates a duplicate in production.
  const intakeSource = readSource("src/lib/recruitment/inbound/cv-intake-service.ts");
  const lookupAt = intakeSource.indexOf("await findContentFingerprintOwner(");
  const createAt = intakeSource.indexOf("await createCandidate(");
  assert.ok(lookupAt > 0, "the intake must consult the CV fingerprint");
  assert.ok(createAt > 0, "the intake must still be able to create a candidate");
  assert.ok(
    lookupAt < createAt,
    "the fingerprint lookup must run BEFORE createCandidate — after it, the duplicate record already exists",
  );

  // 7b. And BEFORE the paid CV read (audit 2026-10-26, point 5). The lookup used to sit below the
  //     read, so a byte-identical CV that was going to be matched to its owner anyway paid for a
  //     whole AI read first. The read is skipped exactly when the identical bytes are already filed
  //     as a CV — anything else filed under those bytes was never judged as a CV and is still read.
  const readAt = intakeSource.indexOf("await extractCvFieldsFromBytes(");
  assert.ok(readAt > 0, "the intake must still read a CV it does not already hold");
  assert.ok(
    lookupAt < readAt,
    "the fingerprint lookup must run BEFORE extractCvFieldsFromBytes — after it, a duplicate CV has already paid for a read",
  );
  const guardAt = intakeSource.lastIndexOf("if (!sameCvAlreadyFiledAsCv) {", readAt);
  assert.ok(
    guardAt > lookupAt && intakeSource.slice(guardAt, readAt).split("\n").length <= 4,
    "the CV read must be guarded by the same-CV result, directly — otherwise the earlier lookup saves nothing",
  );
  assert.ok(
    /sameCvAlreadyFiledAsCv = sameCvCandidate !== null && owner\?\.kind === "cv";/.test(intakeSource),
    "only bytes already filed as a CV may skip the read — an ID scan with the same bytes was never judged as a CV",
  );
  assert.ok(
    /findCandidateIdByContentFingerprint\([\s\S]{0,160}\)\s*:\s*Promise<string \| null> \{\s*return \(await findContentFingerprintOwner\(/.test(filesSource),
    "findCandidateIdByContentFingerprint must stay a thin wrapper over findContentFingerprintOwner, so the two can never answer differently",
  );

  // 8. The reason has to survive the round trip through match_reason, which is a free-text column
  //    narrowed back through CandidateMatchReason. Miss this set and every cv_content reuse reads
  //    back as an unexplained match, erasing the evidence that the fingerprint did the work.
  assert.ok(
    /MATCH_REASONS = new Set<CandidateMatchReason>\(\[[^\]]*"cv_content"/.test(intakeSource),
    "cv_content must be an accepted match_reason, or the reuse reads back as unexplained",
  );
  assert.ok(
    /export type CandidateMatchReason =[^;]*"cv_content"/.test(
      readSource("src/lib/recruitment/candidate-matching.ts"),
    ),
    "cv_content must be in the CandidateMatchReason union",
  );

  // 9. Every match reason has WORDS, and none of them is the stored code. `ignoreBuildErrors` is on
  //    for this repo's build, so an exhaustive Record does NOT gate a deploy: a missing key compiles,
  //    ships, and renders "(matched by cv_content)" into a recruiter's notification — a raw code in a
  //    human's message, which the owner's rules forbid outright. Only a runtime check catches it.
  const reasons = ["national_id", "email", "phone", "cv_content"] as const;
  for (const reason of reasons) {
    const label = MATCH_REASON_LABEL[reason];
    assert.ok(label, `match reason "${reason}" has no human label`);
    assert.notEqual(label, reason, `match reason "${reason}" renders its own raw code to a person`);
    assert.ok(!/_/.test(label), `match reason "${reason}" renders a snake_case code: "${label}"`);
  }
}
