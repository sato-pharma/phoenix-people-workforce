// `check-migrations-applied.ts`'s command line, pinned.
//
// Why this is a suite of its own rather than a line in staging-migration-applier.test.ts: the flag
// decides WHICH QUESTION the run answered, and the two answers are both called "clean". On
// 2026-10-15 the default run named four production files with no ledger row and `--no-grace` named
// four MORE — three of them money migrations merged that morning — so a flag that is accepted,
// ignored, or quietly dropped reports "production is clean" about a set it never looked at. That is
// the `sync-cloud-context.mjs --check` shape exactly (docs/agents-session-traps-clusters.md), and it
// is the reason the parser REFUSES an unknown flag instead of skipping it.
//
// The parser lives in scripts/lib/migration-inventory.ts, not in the script, because the script's
// `main()` runs on import and would open a database connection from a test process.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseDriftCheckFlags } from "../scripts/lib/migration-inventory.ts";

export function runMigrationDriftCheckFlagsTests(): void {
  // The default is the nightly question: the grace window stays on.
  assert.deepEqual(parseDriftCheckFlags([]), { ignoreGraceWindow: false });

  // The sweep question.
  assert.deepEqual(parseDriftCheckFlags(["--no-grace"]), { ignoreGraceWindow: true });
  assert.deepEqual(
    parseDriftCheckFlags(["--no-grace", "--no-grace"]),
    { ignoreGraceWindow: true },
    "repeating the flag is the same request, not an error",
  );

  // 🔴 THE POINT OF THE SUITE. Every one of these must throw rather than return
  // { ignoreGraceWindow: false } — a tolerated typo is a narrow run wearing the wide run's name.
  for (const argv of [
    ["--nograce"],
    ["--no-grace=true"],
    ["-no-grace"],
    ["--NO-GRACE"],
    ["no-grace"],
    ["--no-grace", "production"],
    ["--help"],
  ]) {
    assert.throws(
      () => parseDriftCheckFlags(argv),
      /unknown flag/,
      `parseDriftCheckFlags(${JSON.stringify(argv)}) must refuse, not silently ignore`,
    );
  }

  // The refusal has to name the flag it got, or the reader cannot see their own typo.
  assert.throws(() => parseDriftCheckFlags(["--nograce"]), /--nograce/);
  // ...and it has to name the one flag that does exist.
  assert.throws(() => parseDriftCheckFlags(["--nograce"]), /--no-grace/);

  // The script must actually PASS the parsed flag through. A parser nothing calls is decoration,
  // and this is the half a unit test of the parser alone cannot see. Read as text on purpose: the
  // script cannot be imported (see the header).
  const script = readFileSync("scripts/check-migrations-applied.ts", "utf8");
  assert.match(
    script,
    /parseDriftCheckFlags\(process\.argv\.slice\(2\)\)/,
    "check-migrations-applied.ts must parse its own argv through parseDriftCheckFlags",
  );
  assert.match(
    script,
    /selectMissingMigrations\(local, remote, \{ nowMs: now, ignoreGraceWindow \}\)/,
    "the parsed flag must reach selectMissingMigrations, or --no-grace is accepted and ignored",
  );

  // And the one-command form the owner asked for has to exist and carry the flag.
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.ok(
    pkg.scripts["check:migrations-swept"]?.includes("--no-grace"),
    "package.json must keep a check:migrations-swept script that passes --no-grace",
  );
  assert.ok(
    !pkg.scripts["check:migrations-applied"]?.includes("--no-grace"),
    "the nightly script must NOT pass --no-grace — the workflow runs it, and a PR's own migration is supposed to read unapplied at review time",
  );
}
