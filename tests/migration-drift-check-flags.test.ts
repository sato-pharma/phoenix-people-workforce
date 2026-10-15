// `check-migrations-applied.ts`'s command line and credential resolution, pinned.
//
// Why this is a suite of its own rather than a line in staging-migration-applier.test.ts: these two
// things decide WHICH QUESTION the run answered and WHICH DATABASE it answered it about, and every
// wrong answer is still called "clean".
//
// On 2026-10-15 the default run named four production files with no ledger row and `--no-grace`
// named four MORE — three of them money migrations merged that morning — so a flag that is
// accepted, ignored, or quietly dropped reports "production is clean" about a set it never looked
// at. That is the `sync-cloud-context.mjs --check` shape (docs/agents-session-traps-clusters.md),
// and it is why the parser REFUSES an unknown flag instead of skipping it. The same evening the
// owner ran the script in a shell and it died on missing credentials, because it read only
// `process.env` — hence resolveEnvValue, and hence the rule that the process environment always
// wins, so an env file can never redirect a CI leg at the other project.
//
// The parser lives in scripts/lib/migration-inventory.ts, not in the script, because the script's
// `main()` runs on import and would open a database connection from a test process.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DRIFT_CHECK_ENV_FILES,
  parseDriftCheckFlags,
  resolveEnvValue,
} from "../scripts/lib/migration-inventory.ts";

function flagTests(): void {
  // The default is the nightly question, against production.
  assert.deepEqual(parseDriftCheckFlags([]), { ignoreGraceWindow: false, staging: false });

  assert.deepEqual(parseDriftCheckFlags(["--no-grace"]), { ignoreGraceWindow: true, staging: false });
  assert.deepEqual(parseDriftCheckFlags(["--staging"]), { ignoreGraceWindow: false, staging: true });
  assert.deepEqual(
    parseDriftCheckFlags(["--no-grace", "--staging"]),
    { ignoreGraceWindow: true, staging: true },
    "the staging sweep is both flags together — the form check:migrations-swept-staging runs",
  );
  assert.deepEqual(
    parseDriftCheckFlags(["--staging", "--no-grace", "--no-grace"]),
    { ignoreGraceWindow: true, staging: true },
    "order and repetition are the same request, not an error",
  );

  // 🔴 THE POINT OF THE SUITE. Every one of these must throw rather than return the DEFAULTS — a
  // tolerated typo is a narrow run wearing the wide run's name, or production answered in
  // staging's name.
  for (const argv of [
    ["--nograce"],
    ["--no-grace=true"],
    ["-no-grace"],
    ["--NO-GRACE"],
    ["no-grace"],
    ["--stage"],
    ["--staging=true"],
    ["staging"],
    ["--no-grace", "production"],
    ["--help"],
  ]) {
    assert.throws(
      () => parseDriftCheckFlags(argv),
      /unknown flag/,
      `parseDriftCheckFlags(${JSON.stringify(argv)}) must refuse, not silently ignore`,
    );
  }

  // The refusal has to name the flag it got, or the reader cannot see their own typo...
  assert.throws(() => parseDriftCheckFlags(["--nograce"]), /--nograce/);
  // ...and both flags that do exist, or they cannot find the right one.
  assert.throws(() => parseDriftCheckFlags(["--nograce"]), /--no-grace/);
  assert.throws(() => parseDriftCheckFlags(["--nograce"]), /--staging/);
}

function credentialResolutionTests(): void {
  const dir = mkdtempSync(path.join(tmpdir(), "phx-drift-env-"));
  const first = path.join(dir, "first.local");
  const second = path.join(dir, "second.local");
  const name = "PHX_DRIFT_FIXTURE_URL";
  try {
    writeFileSync(first, `# a comment\n${name}="https://first.example"\n`, "utf8");
    writeFileSync(second, `${name}=https://second.example\n`, "utf8");

    // Absent everywhere is null, not a throw — the caller composes the message that names where it
    // looked.
    assert.equal(resolveEnvValue(name, []), null);

    // The FIRST file that sets it wins, quotes are stripped, comments ignored.
    assert.deepEqual(resolveEnvValue(name, [first, second]), {
      value: "https://first.example",
      source: first,
    });
    // A missing file is skipped rather than throwing.
    assert.deepEqual(resolveEnvValue(name, [path.join(dir, "nope.local"), second]), {
      value: "https://second.example",
      source: second,
    });

    // 🔴 THE PROCESS ENVIRONMENT MUST WIN, or an env file could point a CI leg at the other
    // database. The workflow sets each leg's pair explicitly.
    process.env[name] = "https://from-the-environment.example";
    try {
      assert.deepEqual(
        resolveEnvValue(name, [first, second]),
        { value: "https://from-the-environment.example", source: "the process environment" },
        "the process environment must beat every env file, or a file in the checkout could point a "
          + "CI leg at the other database — the workflow sets each leg's pair explicitly",
      );
    } finally {
      delete process.env[name];
    }

    // An empty assignment is not a value — it falls through to the next file rather than handing
    // back "" and failing later inside the Supabase client.
    const blank = path.join(dir, "blank.local");
    writeFileSync(blank, `${name}=\n`, "utf8");
    assert.deepEqual(resolveEnvValue(name, [blank, second]), {
      value: "https://second.example",
      source: second,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // The real fallback list, and its order: staging's own file first, production's .env.local last,
  // matching scripts/apply-sql-file.mjs so the two can never disagree about where a credential
  // came from.
  assert.deepEqual(DRIFT_CHECK_ENV_FILES, [
    ".env.staging.rls.local",
    ".env.production.rls.local",
    ".env.local",
  ]);
}

function wiringTests(): void {
  // A parser nothing calls is decoration, and this is the half a unit test of the parser alone
  // cannot see. Read as text on purpose: the script cannot be imported (see the header).
  const script = readFileSync("scripts/check-migrations-applied.ts", "utf8");
  assert.match(
    script,
    /parseDriftCheckFlags\(process\.argv\.slice\(2\)\)/,
    "check-migrations-applied.ts must parse its own argv through parseDriftCheckFlags",
  );
  assert.match(
    script,
    /selectMissingMigrations\(local, remote, \{ nowMs: now, ignoreGraceWindow \}\)/,
    "the parsed grace-window flag must reach selectMissingMigrations, or --no-grace is accepted and ignored",
  );
  assert.match(
    script,
    /loadRemoteMigrations\(staging\)/,
    "the parsed --staging flag must reach loadRemoteMigrations, or --staging silently reads production",
  );
  assert.match(
    script,
    /PHOENIX_STAGING_SUPABASE_SERVICE_ROLE_KEY/,
    "--staging must ask for the staging service key by name, not reuse production's",
  );
  assert.ok(
    !/console\.log\([^)]*\b(url|key)\.value/.test(script),
    "the run may name where a credential came from but must never print its value — one is a service-role key",
  );

  // And the one-command forms the owner asked for have to exist and carry the right flags.
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  const swept = pkg.scripts["check:migrations-swept"];
  const sweptStaging = pkg.scripts["check:migrations-swept-staging"];
  const nightly = pkg.scripts["check:migrations-applied"];
  assert.ok(swept?.includes("--no-grace"), "check:migrations-swept must pass --no-grace");
  assert.ok(!swept?.includes("--staging"), "check:migrations-swept is the PRODUCTION sweep");
  assert.ok(
    sweptStaging?.includes("--no-grace") && sweptStaging?.includes("--staging"),
    "check:migrations-swept-staging must pass both flags",
  );
  assert.ok(
    nightly && !nightly.includes("--no-grace") && !nightly.includes("--staging"),
    "the nightly script must carry NEITHER flag — the workflow runs it once per database with the "
      + "credentials in the environment, and a PR's own migration is supposed to read unapplied at review time",
  );
}

export function runMigrationDriftCheckFlagsTests(): void {
  flagTests();
  credentialResolutionTests();
  wiringTests();
}
