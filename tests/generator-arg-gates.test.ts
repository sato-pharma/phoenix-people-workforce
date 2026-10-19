import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { stripComments } from "./support/comment-strip.ts";

/**
 * EVERY GENERATOR THAT TAKES NO ARGUMENTS SAYS SO, INSTEAD OF IGNORING ONE.
 *
 * 🔴 A flag that is ignored rather than rejected turns a read into a write.
 * `scripts/sync-cloud-context.mjs` parsed no arguments at all until 2026-10-15, so `--check` — the
 * flag a session reaches for to ASK whether something has drifted — was accepted in silence and the
 * script did its one job: it rewrote the whole cloud mirror into whatever checkout the caller was
 * standing in, then exited 0, which reads exactly like a clean check. It left 7 modified tracked
 * files and 1 untracked note in a worktree another live session shared, and `git restore` on those
 * paths is refused by the auto-mode classifier as irreversible local destruction, so only the owner
 * could authorise cleaning it up. Account: docs/agents-session-traps.md.
 *
 * WHAT THIS PINS:
 *
 *  1. THE GATE ITSELF, BEHAVIOURALLY, against a fixture in a temp directory — all three paths,
 *     including the POSITIVE CONTROL that a bare run still proceeds and writes. A gate that refused
 *     everything would pass every other case here.
 *  2. EVERY LISTED GENERATOR CALLS IT, AND CALLS IT BEFORE ITS FIRST SIDE EFFECT. Read from the
 *     comment-stripped source, because a comment mentioning the call is not the call.
 *  3. 🔴 THE RATCHET: a tracked, non-library `scripts/**\/*.mjs` that WRITES FILES and parses no
 *     arguments of its own must appear in GATED, or in EXEMPT with a reason. A generator added later
 *     with no gate fails this test by name.
 *
 * 🔴 WHY THE REAL GENERATORS ARE NOT SPAWNED HERE: running one IS the write. `export-backup-local`
 * reads production Supabase, `optimize-brand-assets` and `generate-cairo-zone-transitions` overwrite
 * committed files, and `searchable-select-migration` codemods `src/components` in place — so a test
 * that spawned them to prove the gate would do the damage itself the day the gate broke. The gate is
 * one shared function: proving it on a fixture proves it for all of them, and the source assertions
 * prove each one calls it first. The single exception is `sync-cloud-context.mjs`, whose own test
 * spawns it and watches `.claude/cloud-context/README.md` for a write.
 *
 * THE BREAK DIRECTION: delete the early return in the helper and case 1's positive control fails (a
 * bare run must still write its marker); delete a `refuseArguments` call from any listed script and
 * case 2 names that file; add a writing script with no gate and case 3 names it.
 */

const HELPER = "scripts/lib/refuse-arguments.mjs";

/** Every entry-point generator here that takes no arguments. */
const GATED = [
  "scripts/analyze-checkin-brick-groundtruth.mjs",
  "scripts/build-xlsx-from-json.mjs",
  "scripts/export-backup-local.mjs",
  "scripts/export-derived-tables.mjs",
  "scripts/generate-cairo-zone-transitions.mjs",
  "scripts/optimize-brand-assets.mjs",
  "scripts/phase14-controlled-mutation-smoke.mjs",
  "scripts/run-tests-sharded.mjs",
  "scripts/searchable-select-migration.mjs",
  "scripts/sync-cloud-context.mjs",
  "scripts/sync-pdfjs-assets.mjs",
];

/**
 * Not entry points. A LIBRARY must never read `process.argv`: it is imported by an entry point that
 * does take arguments — `new-session.mjs <task>` — so a gate inside it would refuse its own caller's
 * argument. `scripts/lib/**` is excluded wholesale for that reason; this one sits outside that
 * folder and is a library all the same.
 */
const EXEMPT = new Map([
  [
    "scripts/delta-landed.mjs",
    "pure exports, imported by repo-doctor, repo-doctor-unpushed, branch-pr-state and the worktree-exit guard",
  ],
]);

const WRITES =
  /\b(writeFileSync|appendFileSync|mkdirSync|rmSync|cpSync|copyFileSync|renameSync|unlinkSync|writeFile|mkdir)\s*\(/;
const SIDE_EFFECT =
  /\b(writeFileSync|appendFileSync|mkdirSync|rmSync|cpSync|copyFileSync|renameSync|unlinkSync|writeFile|createClient|chromium|postgres)\s*\(/;

export function runGeneratorArgGatesTests() {
  // ── 1. The gate itself, on a fixture, including the positive control ─────────────────────────
  const dir = mkdtempSync(join(tmpdir(), "phx-refuse-args-"));
  try {
    const helperUrl = pathToFileURL(resolve(HELPER)).href;
    const marker = join(dir, "it-ran.txt");
    const fixture = join(dir, "fixture.mjs");
    writeFileSync(
      fixture,
      [
        `import { refuseArguments } from ${JSON.stringify(helperUrl)};`,
        `import { writeFileSync } from "node:fs";`,
        ``,
        `refuseArguments({`,
        `  name: "fixture-generator",`,
        `  usage: "fixture-generator: a stand-in. It takes no other arguments.",`,
        `  hints: ["to ASK instead, read the banner"],`,
        `});`,
        ``,
        `writeFileSync(${JSON.stringify(marker)}, "ran");`,
      ].join("\n"),
    );
    const run = (...args: string[]) => spawnSync(process.execPath, [fixture, ...args], { encoding: "utf8" });

    for (const flag of ["--check", "--dry-run", "-n", "--wat", "whatever"]) {
      rmSync(marker, { force: true });
      const r = run(flag);
      assert.equal(r.status, 2, `the gate must refuse ${flag} with exit 2, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /REFUSED/, `${flag}: the refusal must say so`);
      assert.match(r.stderr, /no dry run/i, `${flag}: it must say there is no dry run`);
      assert.match(r.stderr, /to ASK instead/, `${flag}: it must print the hints it was given`);
      assert.match(r.stderr, /you passed: /, `${flag}: it must quote back what it was given`);
      assert.equal(r.stdout.trim(), "", `${flag}: a refused run prints nothing to stdout`);
      assert.equal(existsSync(marker), false, `${flag}: NOTHING after the gate may run`);
    }

    for (const flag of ["--help", "-h"]) {
      rmSync(marker, { force: true });
      const r = run(flag);
      assert.equal(r.status, 0, `${flag} must exit 0, got ${r.status}: ${r.stderr}`);
      assert.match(r.stdout, /takes no other arguments/, `${flag} must print the usage it was given`);
      assert.equal(existsSync(marker), false, `${flag} must not run the script body`);
    }

    // THE POSITIVE CONTROL. Without this, a gate that refused everything would pass every case above.
    rmSync(marker, { force: true });
    const bare = run();
    assert.equal(bare.status, 0, `a bare run must proceed, got ${bare.status}: ${bare.stderr}`);
    assert.equal(existsSync(marker), true, "a bare run must reach the body and write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // ── 2. Every listed generator calls the gate, before its first side effect ───────────────────
  for (const file of GATED) {
    const source = stripComments(readFileSync(file, "utf8"));
    assert.match(
      source,
      /import \{ refuseArguments \} from ['"]\.\/lib\/refuse-arguments\.mjs['"]/,
      `${file}: must import the shared gate from scripts/lib/refuse-arguments.mjs`,
    );
    const call = source.indexOf("refuseArguments({");
    assert.ok(call > 0, `${file}: must CALL refuseArguments, not merely import it`);
    const effect = source.search(SIDE_EFFECT);
    if (effect >= 0) {
      assert.ok(
        call < effect,
        `${file}: refuseArguments must be called BEFORE the first side effect, or a refused flag has already done something`,
      );
    }
  }

  // ── 3. The ratchet: nothing writes while ignoring every argument ─────────────────────────────
  {
    const tracked = execFileSync("git", ["ls-files", "scripts"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.mjs$/.test(f) && !f.startsWith("scripts/lib/"));
    assert.ok(tracked.length > 100, `expected the scripts tree, listed ${tracked.length}`);

    const unguarded: string[] = [];
    for (const file of tracked) {
      const raw = readFileSync(file, "utf8");
      if (!WRITES.test(raw)) continue;
      if (/process\.argv/.test(raw)) continue; // it parses its own arguments
      if (/refuseArguments/.test(raw)) continue; // gated
      unguarded.push(file);
    }
    const unexplained = unguarded.filter((f) => !EXEMPT.has(f));
    assert.deepEqual(
      unexplained,
      [],
      `these scripts write files and ignore every argument — add refuseArguments (${HELPER}) or list them in EXEMPT with a reason: ${unexplained.join(", ")}`,
    );
    for (const [file, reason] of EXEMPT) {
      assert.ok(existsSync(file), `EXEMPT names ${file}, which no longer exists — drop the entry`);
      assert.ok(reason.length > 20, `EXEMPT ${file}: the reason must say why a gate would be wrong`);
    }
    for (const file of GATED) {
      assert.ok(existsSync(file), `GATED names ${file}, which no longer exists — drop the entry`);
    }
  }
}
