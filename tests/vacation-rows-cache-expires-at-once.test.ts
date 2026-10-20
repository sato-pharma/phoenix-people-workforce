import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

// A vacation write must be visible on the very next read. In Next 16 revalidateTag(tag, "max") is
// stale-while-revalidate, so the router.refresh() that follows an HR edit was served the old rows
// (VAC-0686, 2026-10-20: three saves reached the database, the screen kept the old dates). The shared
// rows tag is therefore expired at once. next/cache is a no-op stub in this harness, so this pins
// the SOURCE SHAPE, like tests/org-tree-cache-invalidation.test.ts.

export function runVacationRowsCacheExpiresAtOnceTests() {
  const code = stripComments(readFileSync(new URL("../src/lib/dashboard/invalidation.ts", import.meta.url), "utf8"));

  assert.match(
    code,
    /revalidateTag\(\s*VACATION_REPORT_ROWS_CACHE_TAG\s*,\s*\{\s*expire:\s*0\s*\}\s*\)/,
    "the shared vacation rows tag must be expired at once, never served stale while it refreshes",
  );
  assert.doesNotMatch(
    code,
    /revalidateTag\(\s*VACATION_REPORT_ROWS_CACHE_TAG\s*,\s*"max"\s*\)/,
    'revalidateTag(rows tag, "max") serves the old rows to the refresh that follows a save',
  );

  assert.match(
    code,
    /revalidateTag\(\s*COMPANY_VACATION_REPORT_CACHE_TAG\s*,\s*\{\s*expire:\s*0\s*\}\s*\)/,
    "the Company Vacation Report tag is read by the same refresh after a leave write and must expire at once too",
  );
}
