import { strict as assert } from "node:assert";

import { ApiError } from "../src/lib/http/api-errors.ts";
import {
  assertCronAuthorized,
  cronSecretAuthorized,
  requiredTokenAuthorized,
} from "../src/lib/security/cron-auth.ts";

/**
 * Behaviour coverage for the shared cron/worker authorization policy.
 *
 * The companion source sweep (tests/cron-auth-single-guard.test.ts) proves no route spells the
 * policy out for itself any more. This file proves the policy it now shares is the RIGHT one — a
 * sweep over zero offenders is perfectly happy to pass on a guard that authorizes everybody.
 */

function requestWith(authorization?: string) {
  return new Request("https://phoenix-hr.satopharma.com/api/cron/probe", {
    headers: authorization ? { authorization } : {},
  });
}

/**
 * Run `fn` with NODE_ENV pinned, then restore it exactly — including having been unset.
 *
 * Next augments NodeJS.ProcessEnv with a required, READ-ONLY NODE_ENV, so both the assignment
 * and the delete are type errors against the bag itself (TS2540 / TS2704) — invisible to a local
 * test run, which strips types, and caught only by the PR's typecheck job. Go through a mutable
 * view, the same way tests/config-drift.test.ts:43-47 already does. AGENTS.md 2.1.
 */
const mutableEnv = process.env as Record<string, string | undefined>;

function withNodeEnv(value: string | undefined, fn: () => void) {
  const had = "NODE_ENV" in process.env;
  const previous = process.env.NODE_ENV;
  try {
    if (value === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = value;
    fn();
  } finally {
    if (had) mutableEnv.NODE_ENV = previous;
    else delete mutableEnv.NODE_ENV;
  }
}

/** Capture whatever the structured logger emits while `fn` runs. */
function captureLogs(fn: () => void): string {
  const lines: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const collect =
    () =>
    (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  console.log = collect();
  console.warn = collect();
  console.error = collect();
  console.info = collect();
  try {
    fn();
  } finally {
    Object.assign(console, originals);
  }
  return lines.join("\n");
}

export function runCronAuthPolicyTests() {
  const SECRET = "s3cr3t-value-of-some-length";

  // ---------------------------------------------------------------- cronSecretAuthorized

  // 1. The happy path: an exact Bearer match authorizes.
  assert.equal(cronSecretAuthorized(requestWith(`Bearer ${SECRET}`), SECRET), true, "correct bearer authorizes");

  // 2. Wrong secret, right shape.
  assert.equal(cronSecretAuthorized(requestWith("Bearer wrong"), SECRET), false, "wrong secret refused");

  // 3. A same-length wrong secret — the case a naive === short-circuit would leak timing on.
  assert.equal(
    cronSecretAuthorized(requestWith(`Bearer ${"x".repeat(SECRET.length)}`), SECRET),
    false,
    "same-length wrong secret refused",
  );

  // 4. No header at all, and the raw secret without the Bearer prefix.
  assert.equal(cronSecretAuthorized(requestWith(), SECRET), false, "missing authorization header refused");
  assert.equal(cronSecretAuthorized(requestWith(SECRET), SECRET), false, "bare secret without Bearer refused");

  // 5. THE UNSET-SECRET POLICY. This is the whole reason the module exists: an unset secret is a
  //    dev-machine bypass and nothing else. The old spelling, !isProductionRuntime(), meant
  //    "anywhere not labelled production" and opened 18 routes on staging (AGENTS.md 2.3).
  withNodeEnv("development", () => {
    assert.equal(cronSecretAuthorized(requestWith(), undefined), true, "unset secret bypasses in development");
  });
  withNodeEnv("production", () => {
    assert.equal(cronSecretAuthorized(requestWith(), undefined), false, "unset secret FAILS CLOSED in production");
    assert.equal(
      cronSecretAuthorized(requestWith(`Bearer ${SECRET}`), undefined),
      false,
      "unset secret fails closed even when the caller presents a bearer token",
    );
  });
  withNodeEnv("test", () => {
    assert.equal(cronSecretAuthorized(requestWith(), undefined), false, "unset secret fails closed in test");
  });
  withNodeEnv(undefined, () => {
    assert.equal(cronSecretAuthorized(requestWith(), ""), false, "an EMPTY secret fails closed when NODE_ENV is unset");
  });

  // ---------------------------------------------------------------- assertCronAuthorized

  // 6. Authorized returns null, so the caller falls through to its handler.
  assert.equal(
    assertCronAuthorized(requestWith(`Bearer ${SECRET}`), "cron/probe", { secret: SECRET }),
    null,
    "authorized request returns null",
  );

  // 7. Denied returns a 401 carrying the bare body — byte-identical to the 15 routes with no message.
  const bare = assertCronAuthorized(requestWith("Bearer nope"), "cron/probe", { secret: SECRET });
  assert.ok(bare, "denied request returns a response");
  assert.equal(bare.status, 401, "denial is a 401");

  // 8. ...and the 8 routes that carried a message keep it verbatim.
  const withMessage = assertCronAuthorized(requestWith("Bearer nope"), "cron/probe", {
    secret: SECRET,
    message: "Birthday notification run is not authorized.",
  });
  assert.ok(withMessage, "denied request with a message returns a response");
  assert.equal(withMessage.status, 401, "message denial is still a 401");

  // 9. THE OBSERVABILITY GUARANTEE. Eight routes rejected callers and logged nothing; in production
  //    grep cron_unauthorized is the only detection there is. Rejection and log are now inseparable.
  const denialLog = captureLogs(() => {
    assertCronAuthorized(requestWith("Bearer nope"), "cron/some-job-slug", { secret: SECRET });
  });
  assert.match(denialLog, /cron_unauthorized/, "a denial emits the cron_unauthorized event");
  assert.match(denialLog, /cron\/some-job-slug/, "the log names the job slug");

  // 10. ...and an AUTHORIZED request must stay silent, or the alarm is worthless.
  const allowLog = captureLogs(() => {
    assertCronAuthorized(requestWith(`Bearer ${SECRET}`), "cron/some-job-slug", { secret: SECRET });
  });
  assert.doesNotMatch(allowLog, /cron_unauthorized/, "an authorized request logs nothing");

  // 11. FAIL CLOSED ON AN EXPLICIT UNDEFINED SECRET. A route on its own token whose token is unset
  //     must NOT silently inherit CRON_SECRET — that would authorize a caller holding the wrong
  //     one. This is why the implementation tests `"secret" in options`, not `options?.secret ?? x`.
  const previousCronSecret = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = SECRET;
    withNodeEnv("production", () => {
      assert.ok(
        assertCronAuthorized(requestWith(`Bearer ${SECRET}`), "cron/probe", { secret: undefined }),
        "an explicitly-undefined secret does not fall back to CRON_SECRET",
      );
      // The default path — no secret key at all — DOES read CRON_SECRET.
      assert.equal(
        assertCronAuthorized(requestWith(`Bearer ${SECRET}`), "cron/probe"),
        null,
        "omitting the secret option authorizes against CRON_SECRET",
      );
    });
  } finally {
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCronSecret;
  }

  // ---------------------------------------------------------------- requiredTokenAuthorized

  // 12. No dev bypass: an unset token is a misconfiguration and throws, in EVERY environment.
  for (const env of ["development", "production", undefined]) {
    withNodeEnv(env, () => {
      assert.throws(
        () => requiredTokenAuthorized(requestWith(`Bearer ${SECRET}`), undefined, "token_missing", "TOKEN is required."),
        (error: unknown) => error instanceof ApiError && error.status === 500 && error.code === "token_missing",
        `unset token throws ApiError(500) when NODE_ENV=${String(env)}`,
      );
    });
  }

  // 13. The happy path, and the refusals.
  assert.equal(
    requiredTokenAuthorized(requestWith(`Bearer ${SECRET}`), SECRET, "c", "m"),
    true,
    "correct required token authorizes",
  );
  assert.equal(
    requiredTokenAuthorized(requestWith("Bearer nope"), SECRET, "c", "m"),
    false,
    "wrong required token refused",
  );
  assert.equal(requiredTokenAuthorized(requestWith(), SECRET, "c", "m"), false, "missing header refused");
  assert.equal(
    requiredTokenAuthorized(requestWith("Bearer   "), SECRET, "c", "m"),
    false,
    "whitespace-only bearer refused",
  );

  // 14. THE TRIM SEMANTICS, kept deliberately. Both inline guards trimmed the expected token AND
  //     the sliced bearer value. bearerSecretMatches does NOT trim, so swapping it in here would
  //     start rejecting a token carrying trailing whitespace — silently breaking a live ingest
  //     endpoint (the attendance agent) in a way no source sweep could see.
  assert.equal(
    requiredTokenAuthorized(requestWith(`Bearer ${SECRET}   `), SECRET, "c", "m"),
    true,
    "a trailing-whitespace bearer still matches, as the inline guards did",
  );
  assert.equal(
    requiredTokenAuthorized(requestWith(`Bearer ${SECRET}`), `  ${SECRET}  `, "c", "m"),
    true,
    "a padded expected token still matches, as the inline guards did",
  );
}
