import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { checkSecretShape, KEY_SHAPES } from "../scripts/secret-shape-rules.mjs";
import {
  AI_KEY_VARIABLES,
  CANONICAL_ORIGIN_VARIABLE,
  EXPECTED_VALUES,
  FORBIDDEN_VARIABLES,
  RAILWAY_CLI_PACKAGE,
  REQUIRED_VARIABLES,
  canonicalProductionOrigin,
  checkAiKeyPresent,
  checkCanonicalOrigins,
  checkExpectedValues,
  checkForbiddenVariables,
} from "../scripts/secret-policy.mjs";
import { variables as syncedVariables } from "../scripts/sync-railway-production-secrets.mjs";

// Guards scripts/secret-policy.mjs — the production-variable POLICY, added 2026-09-30 alongside
// tests/railway-secret-shape.test.ts (which guards the value SHAPE rules beside it).
//
// Both modules exist for the same structural reason: validate-railway-production-secrets.mjs exits
// at IMPORT time when RAILWAY_TOKEN, RAILWAY_PROJECT_ID or RAILWAY_SERVICE_NAME is unset, so a test
// can never import the validator. Anything a test must assert on therefore lives in a sibling
// module and is imported BY the validator — which is also why the few assertions below that can
// only be made about the validator itself read its SOURCE TEXT.
//
// What this file is defending, in order:
//   1. five variables that must never be set on production, each of which breaks something in
//      SILENCE — three redirect or suppress every employee email, one hands anybody a Super Admin
//      identity, one makes every deploy-verification report name the wrong revision;
//   2. APP_ENV, which arrives from an UNENCRYPTED GitHub repo variable and, set to "staging", flips
//      force-testing email delivery on for the whole of production;
//   3. that the shape rules reach EVERY variable, not only the required ones — the bug that left
//      GROQ_API_KEY's rule as dead code;
//   4. that the validator's required list and the sync script's `required: true` set stay equal.

/** The three scripts that must never fetch an unpinned Railway CLI again. */
const CLI_CALL_SITES = [
  "scripts/validate-railway-production-secrets.mjs",
  "scripts/sync-railway-production-secrets.mjs",
  "scripts/refresh-local-env.mjs",
];

export function runRailwaySecretPolicyTests() {
  const validatorSource = readFileSync("scripts/validate-railway-production-secrets.mjs", "utf8");
  const syncSource = readFileSync("scripts/sync-railway-production-secrets.mjs", "utf8");

  // --- 1. every forbidden name is rejected when present -------------------------------------
  assert.ok(FORBIDDEN_VARIABLES.length >= 5, "the forbidden list must not be quietly emptied");
  for (const entry of FORBIDDEN_VARIABLES) {
    const failures = checkForbiddenVariables(new Map([[entry.name, "true"]]), "production");
    assert.equal(failures.length, 1, `${entry.name} present on production must produce exactly one failure`);
    assert.ok(
      failures[0].includes(entry.name) && failures[0].includes("must NOT be set on production"),
      `${entry.name}'s failure must name the variable and say it must be absent`,
    );
    assert.ok(
      failures[0].length > entry.name.length + 40,
      `${entry.name}'s failure must carry the REASON — every one of these breaks something silently, and a bare name does not convey that`,
    );
  }

  // The five measured on production 2026-09-30, and the exact harm each one does. Spelled out by
  // name so that removing one from the list is a visible, deliberate edit to this test.
  for (const name of [
    "PHOENIX_EMAIL_FORCE_TESTING",
    "NOTIFICATION_TEST_MODE",
    "PHOENIX_EMAIL_DELIVERY_MODE",
    "PHOENIX_ENABLE_DEV_AUTH_HEADERS",
    "COMMIT_SHA",
  ]) {
    assert.ok(
      FORBIDDEN_VARIABLES.some((entry) => entry.name === name),
      `${name} must stay on the production forbidden list`,
    );
  }

  // --- 2. and silent when absent, or present but empty ---------------------------------------
  assert.deepEqual(
    checkForbiddenVariables(new Map([["APP_URL", "https://phoenix-hr.satopharma.com"]]), "production"),
    [],
    "a healthy variable set with none of the forbidden names present must produce no failures",
  );
  assert.deepEqual(
    checkForbiddenVariables(new Map(), "production"),
    [],
    "an empty variable set must produce no failures — absence is the good state this locks in",
  );
  // Railway keeps a variable after its value is cleared, and the app itself treats an empty
  // PHOENIX_EMAIL_FORCE_TESTING as unset — so an empty value must not be reported as set.
  assert.deepEqual(
    checkForbiddenVariables(new Map([["PHOENIX_EMAIL_FORCE_TESTING", "   "]]), "production"),
    [],
    "a forbidden name held with an EMPTY value is not set, and must not fail",
  );

  // --- 3. the whole policy is production-only ------------------------------------------------
  // 🔴 This is the assertion that protects real inboxes. PHOENIX_EMAIL_FORCE_TESTING is
  // LEGITIMATELY set on staging — it is the single variable that stops staging emailing real
  // employees — and staging's APP_ENV is "staging" by design. The validator takes
  // RAILWAY_ENVIRONMENT from its own environment, so it CAN be pointed at staging; a rule that
  // fired there would fail a healthy staging and invite someone to "fix" it by unsetting the one
  // flag protecting those inboxes.
  const stagingLike = new Map([
    ["PHOENIX_EMAIL_FORCE_TESTING", "true"],
    ["APP_ENV", "staging"],
    ["NEXT_PUBLIC_APP_URL", "https://phoenix-people-workforce-staging.up.railway.app"],
  ]);
  assert.deepEqual(checkForbiddenVariables(stagingLike, "staging"), [], "staging legitimately sets PHOENIX_EMAIL_FORCE_TESTING");
  assert.deepEqual(checkExpectedValues(stagingLike, "staging"), [], 'staging\'s APP_ENV is "staging" by design');
  assert.deepEqual(checkCanonicalOrigins(stagingLike, "staging"), [], "staging's own origin is not the canonical production origin");

  // --- 4. APP_ENV: "staging" fails, "production" passes --------------------------------------
  assert.ok(
    EXPECTED_VALUES.some((rule) => rule.name === "APP_ENV" && rule.expected === "production"),
    'APP_ENV must be pinned to exactly "production"',
  );
  const stagingValue = checkExpectedValues(new Map([["APP_ENV", "staging"]]), "production");
  assert.equal(stagingValue.length, 1, 'APP_ENV="staging" on production must fail');
  assert.ok(
    stagingValue[0].includes("APP_ENV") && stagingValue[0].includes("staging") && stagingValue[0].includes("production"),
    "the failure must quote the wrong value — for APP_ENV the value IS the diagnosis, and it is not a credential",
  );
  assert.deepEqual(
    checkExpectedValues(new Map([["APP_ENV", "production"]]), "production"),
    [],
    'APP_ENV="production" is the good state and must be silent',
  );
  // A trailing newline or stray space is a paste artefact, not a different environment.
  assert.deepEqual(
    checkExpectedValues(new Map([["APP_ENV", " production\n"]]), "production"),
    [],
    "surrounding whitespace must not be read as a different value",
  );
  assert.equal(
    checkExpectedValues(new Map(), "production").length,
    1,
    "a missing APP_ENV on production must fail too — production is measured holding it, and NODE_ENV alone cannot distinguish production from staging",
  );

  // 🔴 The expected-value failures quote the value back, which every other check in this pipeline
  // deliberately never does. That is safe only while this list holds no credential-bearing name.
  for (const rule of EXPECTED_VALUES) {
    assert.doesNotMatch(
      rule.name,
      /KEY|SECRET|TOKEN|PASSWORD/i,
      `${rule.name} looks credential-bearing and must not be in EXPECTED_VALUES, whose failures print the value`,
    );
  }

  // --- 5. the shape check now reaches a NON-required variable --------------------------------
  // GROQ_API_KEY's gsk_… rule was registered on 2026-09-25 BEFORE any key was pasted, precisely
  // because that key is typed into Railway by hand the same way OPENAI_API_KEY's masked paste was.
  // It was dead code: checkSecretShape was called inside the requiredVariables loop, and an unset
  // GROQ_API_KEY is a supported state so the name is not on that list.
  assert.ok(
    KEY_SHAPES.some((shape) => shape.name === "GROQ_API_KEY"),
    "GROQ_API_KEY must still carry a shape rule — it is the witness for this whole assertion",
  );
  assert.ok(
    !REQUIRED_VARIABLES.includes("GROQ_API_KEY"),
    "GROQ_API_KEY is deliberately optional, which is exactly why a required-only shape loop could never reach it",
  );
  assert.ok(
    checkSecretShape("GROQ_API_KEY", "gsk_...abcdefghijklmnopqrstuvwxyz...").length >= 1,
    "a masked paste of a Groq key must be reported by the shape rules",
  );

  // The validator cannot be imported (it exits at import time), so this half is read from source.
  const shapeLoop = /for \(const \[name, rawValue\] of valuesByName\) \{\s*\n\s*failures\.push\(\.\.\.checkSecretShape\(name, rawValue\)\);/;
  assert.match(
    validatorSource,
    shapeLoop,
    "the validator must run checkSecretShape over EVERY variable Railway returns, pushing into failures",
  );
  const requiredLoop = validatorSource.slice(
    validatorSource.indexOf("for (const name of requiredVariables) {"),
    validatorSource.search(shapeLoop),
  );
  assert.ok(requiredLoop.length > 0, "the required-variables loop must still exist");
  assert.ok(
    !requiredLoop.includes("checkSecretShape"),
    "checkSecretShape must NOT be called inside the requiredVariables loop — that placement is what made the rule for every optional variable dead code",
  );
  // The raw value, never a trimmed copy: a BOM, a trailing newline and surrounding spaces are
  // themselves the corruption `railway variable set --stdin` introduces.
  assert.ok(
    !/checkSecretShape\(name, trimmed\)/.test(validatorSource),
    "the shape check must be fed the RAW value — trimming first hides a BOM, a stray newline and surrounding spaces",
  );

  // --- 6. the two required lists still agree -------------------------------------------------
  const syncRequired = syncedVariables.filter((entry) => entry.required).map((entry) => entry.railway);
  assert.deepEqual(
    [...syncRequired].sort(),
    [...REQUIRED_VARIABLES].sort(),
    "the validator's required list and the sync script's `required: true` set must stay identical — one demoted in only one of the two is drift nothing else catches",
  );
  assert.equal(
    syncRequired.length,
    REQUIRED_VARIABLES.length,
    "neither list may carry a duplicate that the set comparison above would hide",
  );

  // NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is demoted in BOTH, 2026-09-30: read by zero lines of
  // application code, so requiring it meant an emergency secret sync could abort over a no-op.
  assert.ok(
    !REQUIRED_VARIABLES.includes("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must not be required by the validator",
  );
  const publishable = syncedVariables.find((entry) => entry.railway === "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  assert.ok(publishable, "the sync script must still SYNC the publishable key, just not require it");
  assert.equal(publishable.required, false, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be optional in the sync script too");

  // --- 6b. no single AI key is required; at least one of the three is ----------------------
  // 2026-10-24: Claude answers first and OpenAI is the last resort, so production may run on
  // Claude alone. Requiring OPENAI_API_KEY made both setup scripts refuse that healthy state.
  for (const name of AI_KEY_VARIABLES) {
    assert.ok(!REQUIRED_VARIABLES.includes(name), `${name} must not be required on its own — any one AI key is enough`);
    const synced = syncedVariables.find((entry) => entry.railway === name);
    if (synced) assert.equal(synced.required, false, `${name} must be optional in the sync script too`);
  }
  assert.deepEqual(
    AI_KEY_VARIABLES,
    ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_2", "OPENAI_API_KEY"],
    "the AI keys are the two Claude accounts and OpenAI, in the order every AI call tries them",
  );
  for (const name of AI_KEY_VARIABLES) {
    assert.deepEqual(
      checkAiKeyPresent(new Map([[name, "configured-value"]]), "production"),
      [],
      `${name} alone is a working production`,
    );
  }
  const noAiKey = checkAiKeyPresent(new Map([["OPENAI_API_KEY", "  "], ["APP_URL", "https://phoenix-hr.satopharma.com"]]), "production");
  assert.equal(noAiKey.length, 1, "a production with none of the AI keys (an empty one counts as none) must fail once");
  assert.ok(
    AI_KEY_VARIABLES.every((name) => noAiKey[0].includes(name)),
    "the failure must name all three keys, so the reader knows any one of them fixes it",
  );
  assert.ok(!noAiKey[0].includes("configured-value"), "the failure must never print a value");
  assert.deepEqual(checkAiKeyPresent(new Map(), "staging"), [], "the AI-key rule is production-only, like the rest of the policy");
  assert.ok(
    validatorSource.includes("failures.push(...checkAiKeyPresent(valuesByName, railEnv));"),
    "the validator must actually run the AI-key rule",
  );

  // --- 7. the canonical origin, folded in from validate-env.mjs -----------------------------
  const canonical = canonicalProductionOrigin();
  assert.equal(
    canonical,
    "https://phoenix-hr.satopharma.com",
    "the canonical origin must still be single-sourced from src/config/system-settings.ts",
  );
  assert.deepEqual(
    checkCanonicalOrigins(new Map([[CANONICAL_ORIGIN_VARIABLE, `${canonical}/`]]), "production"),
    [],
    "a trailing slash on the canonical origin is the same origin",
  );
  assert.equal(
    checkCanonicalOrigins(new Map([[CANONICAL_ORIGIN_VARIABLE, "https://phoenix-hr-abc123-ew.a.run.app"]]), "production").length,
    2,
    "a .run.app value must be rejected BOTH as a dead Cloud Run host and as not the canonical origin",
  );
  assert.ok(
    checkCanonicalOrigins(new Map([["APP_URL", "https://phoenix-hr-abc123-ew.a.run.app"]]), "production")
      .some((failure) => failure.includes("APP_URL") && failure.includes("run.app")),
    "the dead-host rejection must cover APP_URL and PHOENIX_APP_URL as well, not only the canonical name",
  );

  // --- 8. the Railway CLI is pinned at all three call sites ---------------------------------
  assert.match(RAILWAY_CLI_PACKAGE, /^@railway\/cli@\d+\.\d+\.\d+$/, "the CLI must be pinned to an exact version");
  for (const file of CLI_CALL_SITES) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      !source.includes("@railway/cli@latest"),
      `${file} must not fetch @railway/cli@latest — a tool that writes production credentials must not change version between two runs of the same workflow`,
    );
    assert.ok(
      source.includes("RAILWAY_CLI_PACKAGE"),
      `${file} must take the pinned version from scripts/secret-policy.mjs rather than spelling one out`,
    );
  }

  // --- 9. --dry-run must never print a secret value ------------------------------------------
  // Five of the values this script syncs arrive from `vars.*` rather than `secrets.*`, and GitHub
  // masks a SECRET in a log while it does NOT mask a VARIABLE — so the old `NAME=VALUE` command
  // display would have written them in clear text into a log anyone with repo read access can open.
  assert.ok(
    !syncSource.includes("[dry-run] ${commandDisplay}"),
    "the dry run must not print the interpolated command — it contained NAME=VALUE for every synced credential",
  );
  assert.match(
    syncSource,
    /\$\{entry\.railway\}=<redacted \$\{value\.length\} chars>/,
    "the dry run must print the variable name and the value's LENGTH instead of the value",
  );
}
