import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

// The list-shaped callers of `listCandidates` take the slim read. `position_specific_fields` — the
// repeating CV blocks — is 59% of the bytes a whole-pool `select("*")` moves, and none of these
// paths reads it: the one screen that renders the blocks, the candidate profile, fetches them from
// GET /api/recruitment/candidates/[id]. The default stays the full read (pinned in
// recruitment-screening-page.test.ts), so a caller that drops the option silently pays for it again.

const SLIM_CALLERS = [
  "app/(admin)/cv-database/page.tsx",
  "app/employee-portals/cv-database/page.tsx",
  "app/(admin)/recruitment/previous/page.tsx",
  "app/employee-portals/recruitment/page.tsx",
  "src/lib/recruitment/contact-review-service.ts",
  "app/api/recruitment/candidates/file-declared/route.ts",
] as const;

export function runCandidateListSlimCallersTests() {
  for (const path of SLIM_CALLERS) {
    const source = stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
    assert.match(
      source,
      /listCandidates\(\{ withRepeatingCvBlocks: false \}\)/,
      `${path} must call listCandidates({ withRepeatingCvBlocks: false }) — nothing on this path reads the repeating CV blocks`,
    );
    assert.doesNotMatch(
      source,
      /listCandidates\(\)/,
      `${path} must not also make a full listCandidates() read beside the slim one`,
    );
  }
}
