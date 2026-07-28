import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  candidateMatchKeys,
  findDuplicateFlags,
  findMatchingCandidate,
  normalizeEmail,
  normalizeNationalId,
  normalizePhone,
  type MatchableCandidate,
} from "../src/lib/recruitment/candidate-matching.ts";

export function runRecruitmentCandidateMatchingTests() {
  // Normalizers.
  assert.equal(normalizeNationalId("298-0101-234567"), "2980101234567");
  assert.equal(normalizeNationalId("  "), null);
  assert.equal(normalizeNationalId(null), null);
  assert.equal(normalizeEmail("  Foo@Bar.COM "), "foo@bar.com");
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizePhone("+20 100 123 4567"), "201001234567");
  assert.equal(normalizePhone("n/a"), null);

  const keys = candidateMatchKeys({ nationalId: "123 456", email: "A@B.com", phone: "010-1" });
  assert.deepEqual(keys, { nationalIdNorm: "123456", emailNorm: "a@b.com", phoneNorm: "0101" });

  const pool: MatchableCandidate[] = [
    { id: "nat", nationalIdNorm: "2980101234567", emailNorm: "old@x.com", phoneNorm: "111" },
    { id: "mail", nationalIdNorm: null, emailNorm: "match@x.com", phoneNorm: "222" },
    { id: "tel", nationalIdNorm: null, emailNorm: null, phoneNorm: "333" },
  ];

  // National ID wins even when the email matches a different record.
  assert.deepEqual(
    findMatchingCandidate(pool, { nationalIdNorm: "2980101234567", emailNorm: "match@x.com", phoneNorm: null }),
    { id: "nat", reason: "national_id" },
  );

  // Email match when no national id.
  assert.deepEqual(
    findMatchingCandidate(pool, { nationalIdNorm: null, emailNorm: "match@x.com", phoneNorm: null }),
    { id: "mail", reason: "email" },
  );

  // Phone match when no national id / email.
  assert.deepEqual(
    findMatchingCandidate(pool, { nationalIdNorm: null, emailNorm: null, phoneNorm: "333" }),
    { id: "tel", reason: "phone" },
  );

  // No match.
  assert.equal(
    findMatchingCandidate(pool, { nationalIdNorm: "999", emailNorm: "none@x.com", phoneNorm: "000" }),
    null,
  );

  // Empty keys never match (e.g., a blank candidate row).
  assert.equal(findMatchingCandidate(pool, { nationalIdNorm: null, emailNorm: null, phoneNorm: null }), null);

  // ---- Audit finding M17 ----
  // importCandidatesWorkbook previously called createCandidate() once per spreadsheet row, and
  // createCandidate itself re-ran loadMatchKeys() (a full, unfiltered recruitment_candidates scan)
  // on every call — an N-row import did up to N full-table scans sequentially. The bulk path now
  // loads the dedup key list ONCE and reuses a shared matchOrInsertCandidate helper that mutates
  // that list in place, so a later row in the same file can still match an earlier row in the same
  // file, without re-querying the database each time. The single-candidate creation path
  // (createCandidate) is unaffected — it still loads a fresh key list per call, correct for a
  // one-row-per-request API with no batching to do.
  const candidatesSource = readFileSync("src/lib/recruitment/candidates.ts", "utf8");
  assert.match(
    candidatesSource,
    /async function matchOrInsertCandidate\(\s*input: CreateCandidateInput,\s*access: AccessContext,\s*existingKeys: MatchableCandidate\[\],\s*\)/,
    "the shared match-or-insert helper accepts a caller-provided key list instead of loading its own",
  );
  const importFunctionSource = candidatesSource.slice(candidatesSource.indexOf("export async function importCandidatesWorkbook("));
  assert.match(
    importFunctionSource,
    /const existingKeys = await loadMatchKeys\(\);/,
    "the bulk import loads the dedup key list exactly once, before the row loop",
  );
  assert.match(
    importFunctionSource,
    /await matchOrInsertCandidate\(input, access, existingKeys\)/,
    "each row reuses the single shared key list instead of calling createCandidate (which would reload it)",
  );
  assert.doesNotMatch(
    importFunctionSource,
    /await createCandidate\(input, access\)/,
    "the N+1 per-row createCandidate call (and its implicit per-row full-table scan) is gone",
  );

  const createCandidateSource = candidatesSource.slice(
    candidatesSource.indexOf("export async function createCandidate("),
    candidatesSource.indexOf("export const candidateImportHeaders"),
  );
  assert.match(
    createCandidateSource,
    /const existingKeys = await loadMatchKeys\(\);\s*return matchOrInsertCandidate\(input, access, existingKeys\);/,
    "the single-candidate API still loads a fresh key list per call — correct for one row per request",
  );

  // --- findDuplicateFlags (advisory soft-dup markers, O(n)) -------------------------------------
  // The same person applying via email AND WhatsApp gets different exact keys but should be flagged
  // for a human to eyeball — never auto-merged.
  const dupPool = [
    { fullName: "Ahmed Ali", id: "c1", phoneNorm: "201001234567" }, // email application
    { fullName: "Ahmed Aly", id: "c2", phoneNorm: "01001234567" }, // whatsapp — same number, spelling drift
    { fullName: "Mona Hassan", id: "c3", phoneNorm: "201119998888" },
    { fullName: "mona  hassan", id: "c4", phoneNorm: null }, // same name, no phone
    { fullName: "Unique Person", id: "c5", phoneNorm: "201230000000" },
  ];
  const flags = findDuplicateFlags(dupPool);
  assert.deepEqual(flags.get("c1"), { id: "c2", reason: "phone_tail" }, "shared phone-tail flags c1 -> c2");
  assert.deepEqual(flags.get("c2"), { id: "c1", reason: "phone_tail" }, "the flag is mutual");
  assert.deepEqual(flags.get("c3"), { id: "c4", reason: "name" }, "shared normalized name flags c3 -> c4");
  assert.deepEqual(flags.get("c4"), { id: "c3", reason: "name" });
  assert.equal(flags.has("c5"), false, "a candidate matching no one is never flagged");
  assert.equal(findDuplicateFlags([{ fullName: "Solo", id: "x", phoneNorm: "201000000000" }]).size, 0, "a pool of one has no duplicates");
}
