import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TEST_ACCOUNT_READONLY_POSTS, testAccountMayRun } from "@/lib/auth/test-persona";

// A test account "opens everything the real person sees" but must NEVER write as her. Rendering her
// keepsake — a milestone card, a spotlight sheet — is a READ that happens to be a POST (it can carry
// an uploaded photo). This test guards the read-only-POST allowlist two ways: every listed route
// actually runs for a test account, and every listed route is verifiably write-free — so a route that
// grows an insert/update/audit falls out of the list rather than letting a test account write as her.

const root = process.cwd();

// The route handler file for an /api/... path (Next.js app router).
function routeFileFor(apiPath: string): string {
  return join(root, "app", apiPath.replace(/^\//, ""), "route.ts");
}

// Anything that persists — a table write or an audit trail. If a listed route ever gains one of these,
// this test goes red and the route must leave the allowlist.
const WRITE_MARKERS = [
  /\.insert\(/,
  /\.update\(/,
  /\.upsert\(/,
  /\.delete\(/,
  /writeRequiredAuditLog/,
  /writeAuditLog/,
  /recordMilestonePrint/,
];

export function runTestAccountReadonlyPostsTests(): void {
  assert.ok(TEST_ACCOUNT_READONLY_POSTS.length > 0, "the read-only-POST allowlist is not empty");

  for (const apiPath of TEST_ACCOUNT_READONLY_POSTS) {
    // 1. A test account may run it (a POST that would otherwise be refused as a write).
    assert.equal(
      testAccountMayRun("POST", apiPath),
      true,
      `${apiPath} must run for a test account — it renders the real person's own keepsake`,
    );

    // 2. It is verifiably write-free: the handler contains no persistence call.
    const source = readFileSync(routeFileFor(apiPath), "utf8");
    for (const marker of WRITE_MARKERS) {
      assert.ok(
        !marker.test(source),
        `${apiPath} contains a write (${marker}) — a read-only-POST route must persist nothing, so `
          + "remove it from TEST_ACCOUNT_READONLY_POSTS or the write.",
      );
    }
  }

  // A write to a path NOT on either list is still refused for a test account.
  assert.equal(testAccountMayRun("POST", "/api/payroll/run"), false, "an unlisted POST stays refused");
  // A read anywhere is always allowed.
  assert.equal(testAccountMayRun("GET", "/api/anything"), true, "a GET is always allowed for a test account");
}
