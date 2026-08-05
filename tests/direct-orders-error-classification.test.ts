import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Every refusal in the Direct Orders module must reach the caller as the RIGHT status (audit C6.3,
// finding F7).
//
// `toApiError` passes `ApiError` instances through untouched, but classifies a BARE `new Error(...)`
// by matching its MESSAGE against a fixed list of patterns. A message matching none of them becomes
// `ApiError(500, "internal_error")` — so a user who was correctly refused is told the server broke.
//
// That is exactly what happened to "The global cap cannot be deleted.": a deliberate, correct
// refusal reported as a 500. Its sibling two lines up survived only by accident, because
// "… is required." happens to contain one of the patterns.
//
// Correctness that depends on wording is not correctness. This sweep fails the moment a new bare
// Error is added whose message the classifier cannot place.
// ─────────────────────────────────────────────────────────────────────────────

/** The message patterns toApiError recognises, mirrored from src/lib/http/api-errors.ts. */
const CLASSIFIED_PATTERNS = [
  "forbidden:",
  "was not found",
  "does not exist",
  "cannot remove or deactivate the last active super admin",
  "cannot deactivate your own active account",
  "cannot downgrade your own role",
  "cannot elevate your own role",
  "cannot assign peer or higher-privilege roles",
  "cannot modify peer or higher-privilege accounts",
  "only super admin",
  "unexpected end of json input",
  "is not valid json",
  "invalid ",
  " is required",
  "must be ",
  "unsupported",
  "critical audit log could not be persisted",
];

export function runDirectOrderErrorClassificationTests() {
  const dir = new URL("../src/lib/direct-orders/", import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 5, `expected the direct-orders module to have several files, saw ${files.length}`);

  const unclassifiable: string[] = [];
  let bareThrows = 0;

  for (const name of files) {
    const source = readFileSync(new URL(name, dir), "utf8");
    for (const match of source.matchAll(/throw new Error\(\s*"([^"]*)"/g)) {
      const message = match[1];
      bareThrows += 1;
      const normalized = message.toLowerCase();
      if (CLASSIFIED_PATTERNS.some((pattern) => normalized.includes(pattern))) continue;
      const line = source.slice(0, match.index).split("\n").length;
      unclassifiable.push(`${name}:${line}  "${message}"`);
    }
  }

  // ── THE HEADLINE ────────────────────────────────────────────────────────────────────────
  assert.equal(
    unclassifiable.length,
    0,
    `A bare Error in the Direct Orders module has a message toApiError cannot classify, so a correct ` +
      `refusal will reach the user as HTTP 500 "internal_error". Throw a typed error ` +
      `(validationError / forbiddenError / notFoundError) instead of relying on wording:\n  ` +
      unclassifiable.join("\n  "),
  );

  // Guard the guard: if the module stops using bare throws entirely the sweep would pass vacuously,
  // and if the pattern list drifts from api-errors.ts this test is measuring nothing.
  assert.ok(
    bareThrows > 5,
    `the sweep found only ${bareThrows} bare throws, which suggests it has stopped matching the real code`,
  );

  const apiErrors = readFileSync(new URL("../src/lib/http/api-errors.ts", import.meta.url), "utf8");
  for (const pattern of ["forbidden:", " is required", "was not found"]) {
    assert.ok(
      apiErrors.includes(pattern),
      `toApiError no longer recognises "${pattern}" — this test's mirrored pattern list is stale and must be updated with it`,
    );
  }
}
