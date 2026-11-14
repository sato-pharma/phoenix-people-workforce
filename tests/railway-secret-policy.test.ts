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
import { parseOverwriteNames, planSecretSync, railwayValuesByName } from "../scripts/lib/secret-sync-plan.mjs";
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

  // --- 10. every value the workflow hands the sync step is a name the script READS ----------
  // The script reads `process.env[<name>]` for each name in an entry's `github:` list, and
  // nothing else. From 2026-08-08 to 2026-10-27 the workflow exported the dispatch token as
  // GITHUB_ACTIONS_DISPATCH_TOKEN while the entry read PHOENIX_ACTIONS_DISPATCH_TOKEN, so every
  // run skipped it as "empty" and the token only ever reached Railway by hand — found when the
  // repo moved to a new GitHub account and the re-minted token would not sync.
  const workflowSource = readFileSync(".github/workflows/sync-railway-production-secrets.yml", "utf8");
  const syncStep = workflowSource.split(/\n\s+- name: /).find((step) => step.startsWith("Sync production secrets to Railway"));
  assert.ok(syncStep, "the workflow must keep a step named 'Sync production secrets to Railway'");
  const exported = [...syncStep.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*\$\{\{/gm)].map((match) => match[1]);
  assert.ok(exported.length >= 40, `the sync step must still export its values (found ${exported.length})`);
  // The four the script consumes itself to reach Railway, never through an entry, and the one the
  // step's own command line reads (the names released for overwriting, section 11).
  const RAILWAY_CONTROL = new Set(["RAILWAY_API_TOKEN", "RAILWAY_TOKEN", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_NAME", "SYNC_OVERWRITE"]);
  const readByAnEntry = new Set(syncedVariables.flatMap((entry) => entry.github));
  const unread = exported.filter((name) => !RAILWAY_CONTROL.has(name) && !readByAnEntry.has(name));
  assert.deepEqual(
    unread,
    [],
    `the workflow exports ${unread.join(", ")} to the sync step but no entry in scripts/sync-railway-production-secrets.mjs reads that name — the value is dropped and the run logs it as empty`,
  );
  const dispatchEntry = syncedVariables.find((entry) => entry.railway === "GITHUB_ACTIONS_DISPATCH_TOKEN");
  assert.ok(
    dispatchEntry?.github.some((name) => exported.includes(name)),
    "the synthetic-journeys dispatch token must reach the sync step under a name its entry reads",
  );

  // --- 11. the sync never replaces a production value on its own -----------------------------
  // Until 14 Nov 2026 the script wrote every non-empty GitHub value over Railway's without reading
  // what Railway held. On 13 Nov 2026 a push that merely touched the script (run 43454705003) put a
  // GitHub secret from 4 November over the dispatch token set on Railway alone on 7 November, and
  // the workflow watch and the synthetic journeys were stranded for nine hours. The decision now
  // lives in scripts/lib/secret-sync-plan.mjs: add, confirm, HOLD, and replace only by name.
  const entries = [
    { railway: "HELD_ONE", github: ["HELD_ONE"], required: true },
    { railway: "SAME_ONE", github: ["SAME_ONE"], required: true },
    { railway: "NEW_ONE", github: ["NEW_ONE"], required: false },
    { railway: "BLANK_ON_RAILWAY", github: ["BLANK_ON_RAILWAY"], required: false },
    { railway: "RELEASED_ONE", github: ["RELEASED_ONE"], required: false },
    { railway: "EMPTY_OPTIONAL", github: ["EMPTY_OPTIONAL"], required: false },
    { railway: "EMPTY_REQUIRED", github: ["EMPTY_REQUIRED"], required: true },
    { railway: "ALIASED", github: ["ALIASED_FIRST", "ALIASED_SECOND"], required: false },
  ];
  const github: Record<string, string> = {
    HELD_ONE: "github-old-value",
    SAME_ONE: "one-value",
    NEW_ONE: "brand-new",
    BLANK_ON_RAILWAY: "restored",
    RELEASED_ONE: "github-rotated",
    ALIASED_SECOND: "from-the-second-name",
  };
  const githubValueOf = (names: string[]) => names.map((name) => github[name] ?? "").find(Boolean) ?? "";
  const railwayValues = new Map([
    ["HELD_ONE", "set-on-railway-by-hand"],
    ["SAME_ONE", "  one-value\n"],
    ["BLANK_ON_RAILWAY", "   "],
    ["RELEASED_ONE", "railway-behind"],
    ["ALIASED", "from-the-second-name"],
    ["NOT_SYNCED_AT_ALL", "left alone"],
  ]);

  const pushRun = planSecretSync({ entries, githubValueOf, railwayValues });
  assert.deepEqual(
    pushRun.held,
    ["HELD_ONE", "RELEASED_ONE"],
    "a run that names nothing must HOLD every value production holds differently — writing it is how a stale GitHub secret replaced a working production token on 13 Nov 2026",
  );
  assert.deepEqual(
    pushRun.writes.map((write) => `${write.entry.railway}:${write.reason}`),
    ["NEW_ONE:new", "BLANK_ON_RAILWAY:new"],
    "a run that names nothing writes only what production does not hold: an absent name and a blank one",
  );
  assert.ok(
    !pushRun.writes.some((write) => write.entry.railway === "HELD_ONE"),
    "a held value must never also be planned as a write",
  );
  assert.deepEqual(
    pushRun.unchanged,
    ["SAME_ONE", "ALIASED"],
    "a value production already holds is left alone, compared after trimming and through an entry's second GitHub name",
  );
  assert.deepEqual(pushRun.skippedEmpty.map((entry) => entry.railway), ["EMPTY_OPTIONAL"], "an empty optional GitHub value is skipped, never written as blank");
  assert.deepEqual(pushRun.missingRequired.map((entry) => entry.railway), ["EMPTY_REQUIRED"], "an empty required GitHub value is still a failure");

  const handRun = planSecretSync({ entries, githubValueOf, railwayValues, overwrite: ["RELEASED_ONE", "SAME_ONE", "NOT_A_SYNCED_NAME"] });
  assert.deepEqual(handRun.held, ["HELD_ONE"], "releasing one name must not release another: each held value is released by its own name");
  assert.deepEqual(
    handRun.writes.filter((write) => write.reason === "released").map((write) => `${write.entry.railway}=${write.value}`),
    ["RELEASED_ONE=github-rotated"],
    "a released value is written with GitHub's value",
  );
  assert.deepEqual(handRun.unknownOverwrite, ["NOT_A_SYNCED_NAME"], "a released name the script does not sync must be reported, never ignored");
  assert.deepEqual(handRun.unusedOverwrite, ["SAME_ONE"], "releasing a value production already holds is said, because nothing is written for it");

  assert.deepEqual(
    parseOverwriteNames(["--dry-run", "--overwrite=A, B,,A", "--overwrite=C", "--overwrite="]),
    { names: ["A", "B", "C"], problems: [] },
    "--overwrite takes a comma list, may repeat, and an empty one releases nothing (the workflow passes it empty on every push)",
  );
  assert.equal(
    parseOverwriteNames(["--overwrite"]).problems.length,
    1,
    "a bare --overwrite must be refused: read as 'everything', it is the unconditional write again",
  );

  for (const payload of [
    { A: "1", B: "2" },
    { variables: { A: "1", B: "2" } },
    { variables: [{ name: "A", value: "1" }, { key: "B", rawValue: "2" }] },
    [{ name: "A", value: "1" }, { name: "B", value: "2" }],
  ]) {
    assert.deepEqual(
      [...railwayValuesByName(payload)],
      [["A", "1"], ["B", "2"]],
      `Railway's variable list must be read in every shape the CLI has answered in (${JSON.stringify(payload).slice(0, 40)})`,
    );
  }
  assert.equal(railwayValuesByName("not json at all").size, 0, "an answer that is not a list of variables reads as nothing, which the script refuses to act on");

  // The script itself: it reads production before it writes, refuses an answer it cannot read, and
  // hands the names to the workflow, which passes a person's release through the environment.
  const listAt = syncSource.indexOf("runRailway(listArgs)");
  const planAt = syncSource.indexOf("planSecretSync({ entries: variables");
  // The call, not the helper's own declaration `function runRailway(cliArgs)` further up the file.
  const writeAt = syncSource.indexOf("const result = runRailway(cliArgs);");
  assert.ok(listAt > 0 && planAt > listAt && writeAt > planAt, "the script must list production's variables, then plan, and only then write");
  assert.match(
    syncSource,
    /if \(railwayValues\.size === 0\) \{[\s\S]{0,400}?process\.exit\(1\);/,
    "an empty or unreadable list must stop the run: read as 'production holds nothing', every value would look new and be written",
  );
  assert.match(syncSource, /for \(const \{ entry, value, reason \} of plan\.writes\)/, "the only values written are the plan's writes — never the whole variable list");
  assert.match(syncSource, /if \(plan\.held\.length > 0\) \{\s*finish\("held", plan\.held\);\s*process\.exit\(3\);/, "a held value must end the run red, or a push-started run has no signal at all");
  assert.match(workflowSource, /SYNC_OVERWRITE: \$\{\{ inputs\.overwrite \}\}/, "the released names must come from the hand-run input alone, so a push releases nothing");
  assert.match(
    workflowSource,
    /run: node scripts\/sync-railway-production-secrets\.mjs --overwrite="\$SYNC_OVERWRITE"/,
    "the input must reach the script through the environment, quoted — never interpolated into the command line",
  );
  assert.match(
    workflowSource,
    /if: \$\{\{ failure\(\) && steps\.sync\.outcome == 'failure' \}\}[\s\S]{0,400}?secrets\.TELEGRAM_ALERT_CHAT_ID/,
    "a held or failed sync must be told on Telegram, to the existing alert chat: a red run started by somebody else's push is read by nobody",
  );
}
