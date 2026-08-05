import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveStoredHrId } from "../src/lib/hr-id.ts";

// user_access_profiles.hr_id is a FOREIGN KEY to employees.hr_id, which is exact and
// case-sensitive and stored uppercase (171 of 172 rows; the single exception is the
// "Unknown Manager / System Placeholder" row, which has no login profile and no auth user
// and so never reaches these writers).
//
// Both writers of that column took their value from an ADMIN-TYPED field with trim-only
// handling — `input.hrId?.trim() || loginId` and `input.hrId ?? input.loginId`. An admin
// typing "b-97" instead of "B-97" would be rejected by Postgres with a raw 23503 instead of
// matching the employee they meant. Unlike the resignation and probation cases this had not
// yet fired in production (0 orphaned, 0 lowercase rows when found) — it is a latent instance
// of the same class, closed off deliberately.

export function runAccessProfileHrIdCasingTests() {
  // (a) The shared helper normalises admin keystrokes to the stored spelling.
  assert.equal(resolveStoredHrId("b-97"), "B-97", "lowercase input must normalise to the stored uppercase spelling");
  assert.equal(resolveStoredHrId("  b-97  "), "B-97", "surrounding whitespace must not survive");
  assert.equal(resolveStoredHrId("B-97"), "B-97", "an already-correct id must pass through unchanged");
  assert.equal(resolveStoredHrId(""), null, "an empty value must not resolve, so callers can fall back");
  assert.equal(resolveStoredHrId(null), null, "a null value must not resolve");

  // (b) Both writers of user_access_profiles.hr_id route through it.
  const accessControl = readFileSync("src/lib/admin/access-control.ts", "utf8");
  assert.match(
    accessControl,
    /hr_id: resolveStoredHrId\(input\.hrId\) \?\? resolveStoredHrId\(loginId\) \?\? loginId,/,
    "access-control.ts must normalise the admin-typed hr_id before writing the FK column",
  );
  assert.doesNotMatch(
    accessControl,
    /hr_id: input\.hrId\?\.trim\(\) \|\| loginId,/,
    "access-control.ts must not write the raw trimmed admin keystrokes into a case-sensitive FK",
  );

  const identity = readFileSync("src/lib/auth/supabase-identity.ts", "utf8");
  assert.match(
    identity,
    /hr_id: resolveStoredHrId\(input\.hrId\) \?\? resolveStoredHrId\(input\.loginId\) \?\? input\.loginId,/,
    "supabase-identity.ts must normalise hr_id before writing the FK column",
  );
  assert.doesNotMatch(
    identity,
    /hr_id: input\.hrId \?\? input\.loginId,/,
    "supabase-identity.ts must not write an unnormalised hr_id into a case-sensitive FK",
  );

  // (c) Both must use the SHARED helper rather than growing another local variant — there were
  // already four near-duplicate stored-hr_id resolvers in the codebase when this was written.
  for (const [source, name] of [
    [accessControl, "access-control.ts"],
    [identity, "supabase-identity.ts"],
  ] as const) {
    assert.match(
      source,
      /import \{ resolveStoredHrId \} from "@\/lib\/hr-id";/,
      `${name} must import the shared resolveStoredHrId from @/lib/hr-id`,
    );
  }
}
