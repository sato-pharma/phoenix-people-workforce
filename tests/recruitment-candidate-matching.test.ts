import assert from "node:assert/strict";

import {
  candidateMatchKeys,
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
}
