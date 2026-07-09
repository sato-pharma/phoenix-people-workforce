import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Deeper audit finding G: recordLoginAttempt failures (both the failed-login and
// successful-login paths in registerFailedLoginAttempt / clearFailedLoginState) were
// swallowed with a bare .catch(() => undefined) — a DB blip there could silently
// undercount the IP-based rate-limit signal isLoginRateLimited reads, with no trace
// anywhere it happened. Behavior is unchanged (still resolves to undefined either way);
// this only adds Sentry visibility into a failure that was previously invisible.
export function runAuthAuditHardeningTests() {
  const source = readFileSync("src/lib/auth/audit.ts", "utf8");


  assert.doesNotMatch(
    source,
    /await recordLoginAttempt\(\{[\s\S]*?\}\)\.catch\(\(\) => undefined\);/,
    "recordLoginAttempt failures must not be swallowed without logging",
  );

  const failedLoginMatches = [...source.matchAll(/await recordLoginAttempt\(\{[\s\S]*?success: false,\s*\}\)\.catch\(\(error: unknown\) => \{\s*console\.error\(error, \{ tags: \{ component: "auth", context: "recordLoginAttempt\.failed" \} \}\);\s*\}\);/g)];
  assert.equal(failedLoginMatches.length, 1, "the failed-login recordLoginAttempt call must capture its error to Sentry");

  const successLoginMatches = [...source.matchAll(/await recordLoginAttempt\(\{[\s\S]*?success: true,\s*\}\)\.catch\(\(error: unknown\) => \{\s*console\.error\(error, \{ tags: \{ component: "auth", context: "recordLoginAttempt\.success" \} \}\);\s*\}\);/g)];
  assert.equal(successLoginMatches.length, 1, "the successful-login recordLoginAttempt call must capture its error to Sentry");
}
