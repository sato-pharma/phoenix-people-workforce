import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { stripComments } from "./support/comment-strip.ts";

/**
 * A SCRIPT THAT PARSES ARGUMENTS REFUSES THE ONE IT HAS NEVER HEARD OF.
 *
 * `tests/generator-arg-gates.test.ts` covers the scripts that take NO arguments. This is the same
 * defect one layer up: `args.includes("--apply")` answers false for `--aply`, `--apply-all` and
 * `--dryrun`, and the script then does the OTHER thing while the caller believes the flag took
 * effect. Measured 2026-10-15: 32 tracked `scripts/**\/*.mjs` parse arguments AND write files, and
 * only 5 refused an unknown flag. The sharpest instance is `module-memory/run-fold.mjs`, whose one
 * flag is `--dry-run` and whose bare run OPENS A REAL PULL REQUEST — so `--dryrun` used to be
 * ignored and file the inbox for real.
 *
 * WHAT THIS PINS, AND WHY IN THIS SHAPE:
 *
 *  1. THE GATE, behaviourally, against a fixture: a known flag passes, `--flag=value` compares on
 *     the part before the `=`, a positional and a flag's separate value pass, a typo is refused with
 *     exit 2 naming ONLY the unknown token, `--help` is answered with the vocabulary at exit 0 unless
 *     the script defines its own.
 *  2. 🔴 THE `entry` RULE. Several of these modules are imported by another entry point
 *     (`print-day.mjs` by the nightly, `build.mjs` by the fold), and a gate that judged
 *     `process.argv` on import would refuse its PARENT's flags — `fold.mjs --apply` would die on
 *     `build.mjs`'s vocabulary. The fixture proves an imported module never refuses.
 *  3. THE PROBE. `PHX_FLAG_GATE_PROBE=1` makes the gate decide and EXIT, so a test can spawn a REAL
 *     script and watch its gate without ever running its body — `backup-source-of-sales.mjs`
 *     treats `argv[2]` as a file it writes, so "spawn it with a bogus flag and see" is only safe
 *     when a failed gate cannot reach the body. Entry detection failing exits 3 instead of returning.
 *  4. 🔴 THE CALLER RATCHET — the one that earns this file. `.github/workflows/ci.yml` runs
 *     `node scripts/ci-tree-reuse.mjs --dry-run`, and `--dry-run` is not a literal anywhere in that
 *     script's code (it is the documented DEFAULT mode, accepted by being ignored). A vocabulary
 *     built from the script's own code would have refused it and turned a CI step red. So every
 *     flag a workflow, `package.json` or `.claude/settings.json` passes to a gated script must be in
 *     that script's `known` list. It cannot see callers outside the repo (`~/.claude`, scheduled
 *     tasks) — those were read by hand 2026-10-15 and pass only flags in the lists.
 *  5. THE RATCHET OVER WRITERS: a tracked non-library script that parses `process.argv` and writes
 *     files must be gated, or carry its own refusal, or a new one fails by name.
 *  6. `run-fold.mjs` IS GATED INLINE, NOT BY IMPORT: its header requires node builtins only, because
 *     it is the one script that has to survive an unattended run three times a day.
 *
 * 🔴 THE PROBE NEEDS THE STRIP-TYPES LOADER. `build-cv-cabinet.mjs` and the two CV question scripts
 * import `.ts` files, so a plain `node` dies in `ERR_MODULE_NOT_FOUND` before the gate is reached —
 * on `origin/main` too, so it predates the gate. Every probe runs through the same loader, which the
 * plain scripts accept as well.
 *
 * THE BREAK DIRECTION: disarm the helper and case 1 fails; delete one script's call and case 3 names
 * it; drop `--dry-run` from ci-tree-reuse's list and case 4 names ci.yml; drop the `entry` early
 * return and case 2's imported-module check fails; delete run-fold's inline gate and case 6 fails.
 */

const HELPER = "scripts/lib/refuse-arguments.mjs";
const LOADER = [
  "--experimental-strip-types",
  "--experimental-specifier-resolution=node",
  "--experimental-loader",
  "./tests/alias-loader.mjs",
];

/** Pinned BY NAME, so deleting a gate to quiet a failure shows up as a missing name and not a smaller list. */
const PINNED = [
  "scripts/apps-script-authorize.mjs",
  "scripts/backup-source-of-sales.mjs",
  "scripts/build-closing-engine-template.mjs",
  "scripts/build-cv-cabinet.mjs",
  "scripts/ci-tree-reuse.mjs",
  "scripts/codemod-badge-tones.mjs",
  "scripts/codemod-hex-to-tokens.mjs",
  "scripts/codemod-type-scale.mjs",
  "scripts/cv-area-questions.mjs",
  "scripts/cv-triage-questions.mjs",
  "scripts/field-day/print-day.mjs",
  "scripts/field-day/run-nightly.mjs",
  "scripts/measure-production-planning-fit.mjs",
  "scripts/module-memory/build.mjs",
  "scripts/module-memory/fold.mjs",
  "scripts/module-memory/proof.mjs",
  "scripts/needs-you.mjs",
  "scripts/new-session.mjs",
  "scripts/pin-coverage-report.mjs",
  "scripts/refresh-local-env.mjs",
  "scripts/repo-cleanup.mjs",
  "scripts/repo-doctor.mjs",
  "scripts/resolve-brick-pins.mjs",
  "scripts/resolve-gap-bricks.mjs",
  "scripts/slow-audit.mjs",
  "scripts/sync-worktree-env.mjs",
];

const WRITES =
  /\b(writeFileSync|appendFileSync|mkdirSync|rmSync|cpSync|copyFileSync|renameSync|unlinkSync|writeFile|mkdir)\s*\(/;
const SIDE_EFFECT =
  /\b(writeFileSync|appendFileSync|mkdirSync|rmSync|cpSync|copyFileSync|renameSync|unlinkSync|writeFile|createClient|chromium|postgres)\s*\(/;
const ALREADY_REFUSES = /(unknown (flag|argument|option)|unrecogni[sz]|refuseUnknownFlags|refuseArguments)/i;

const knownOf = (source: string): string[] => {
  const m = source.match(/refuseUnknownFlags\(\{[\s\S]*?known:\s*\[([^\]]*)\]/);
  assert.ok(m, "no refuseUnknownFlags({ known: [...] }) call found");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};

export function runUnknownFlagGatesTests() {
  const dir = mkdtempSync(join(tmpdir(), "phx-unknown-flags-"));
  try {
    const helperUrl = pathToFileURL(resolve(HELPER)).href;
    const marker = join(dir, "ran.txt");
    const child = join(dir, "child.mjs");
    const parent = join(dir, "parent.mjs");
    const standalone = join(dir, "standalone.mjs");
    const ownHelp = join(dir, "own-help.mjs");
    const body = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`;

    // A script with a vocabulary, run directly.
    writeFileSync(
      standalone,
      `import { refuseUnknownFlags } from ${JSON.stringify(helperUrl)};\n` +
        `refuseUnknownFlags({ name: "fixture", entry: import.meta.url, known: ["--apply", "--dry-run"], hints: ["a hint line"] });\n` +
        body,
    );
    // A script that defines --help itself: the gate must not steal it.
    writeFileSync(
      ownHelp,
      `import { refuseUnknownFlags } from ${JSON.stringify(helperUrl)};\n` +
        `refuseUnknownFlags({ name: "own-help", entry: import.meta.url, known: ["--help"] });\n` +
        body,
    );
    // A module with its OWN gate that is imported by a parent entry point.
    writeFileSync(
      child,
      `import { refuseUnknownFlags } from ${JSON.stringify(helperUrl)};\n` +
        `refuseUnknownFlags({ name: "child", entry: import.meta.url, known: ["--child-only"] });\n` +
        `export const loaded = true;\n`,
    );
    writeFileSync(parent, `import "./child.mjs";\n` + body);

    const run = (file: string, args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [file, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    const ran = () => existsSync(marker);
    const fresh = () => rmSync(marker, { force: true });

    // ── 1. The gate ───────────────────────────────────────────────────────────────────────────
    for (const args of [[], ["--apply"], ["--dry-run=1"], ["--apply", "some-file.xlsx"], ["positional"]]) {
      fresh();
      const r = run(standalone, args);
      assert.equal(r.status, 0, `args [${args}] must pass the gate, got ${r.status}: ${r.stderr}`);
      assert.equal(ran(), true, `args [${args}] must reach the body`);
    }
    for (const [args, named] of [
      [["--aply"], "--aply"],
      [["--dryrun"], "--dryrun"],
      [["--apply", "--bogus"], "--bogus"],
      [["-x"], "-x"],
    ] as Array<[string[], string]>) {
      fresh();
      const r = run(standalone, args);
      assert.equal(r.status, 2, `args [${args}] must be refused with exit 2, got ${r.status}`);
      assert.match(r.stderr, /REFUSED/, `[${args}]: the refusal must say so`);
      assert.ok(r.stderr.includes(`: ${named}`), `[${args}]: it must name the unknown token ${named}`);
      assert.match(r.stderr, /accepts: --apply --dry-run/, `[${args}]: it must list what it DOES accept`);
      assert.match(r.stderr, /a hint line/, `[${args}]: it must print its hints`);
      assert.equal(ran(), false, `[${args}]: nothing after the gate may run`);
    }
    {
      fresh();
      const r = run(standalone, ["--apply", "--bogus"]);
      assert.equal(r.stderr.includes("--apply --bogus"), false, "a KNOWN flag beside an unknown one must not be named as unknown");
    }
    for (const flag of ["--help", "-h"]) {
      fresh();
      const r = run(standalone, [flag]);
      assert.equal(r.status, 0, `${flag} on a script that does not define it must be answered, exit 0`);
      assert.match(r.stdout, /accepts --apply --dry-run/, `${flag} must print the vocabulary`);
      assert.equal(ran(), false, `${flag} must not run the body`);
    }
    {
      fresh();
      const r = run(ownHelp, ["--help"]);
      assert.equal(r.status, 0, "a script that defines --help keeps it");
      assert.equal(ran(), true, "the gate must not steal a script's own --help");
    }

    // ── 2. An imported module never judges its parent's arguments ────────────────────────────
    fresh();
    const imported = run(parent, ["--parent-flag", "--another"]);
    assert.equal(imported.status, 0, `an imported gated module must not refuse its parent's flags: ${imported.stderr}`);
    assert.equal(ran(), true, "the parent must still run");

    // ── 3a. The probe never runs a body, in any branch ───────────────────────────────────────
    {
      fresh();
      const ok = run(standalone, ["--apply"], { PHX_FLAG_GATE_PROBE: "1" });
      assert.equal(ok.status, 0);
      assert.match(ok.stdout, /GATE-OK fixture/, "the probe must report the gate passed");
      assert.equal(ran(), false, "a probe must NEVER run the body, even when the gate passes");

      fresh();
      const bad = run(standalone, ["--aply"], { PHX_FLAG_GATE_PROBE: "1" });
      assert.equal(bad.status, 2, "a probe still refuses an unknown flag");
      assert.equal(ran(), false);

      fresh();
      const lost = run(parent, [], { PHX_FLAG_GATE_PROBE: "1" });
      assert.equal(lost.status, 3, "a module that is NOT the entry point must exit 3 under the probe, not return into its body");
      assert.equal(ran(), false, "and the body must not have run");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // ── 3b. Every pinned script: gated, called early, and the gate answers when probed ──────────
  const gated: string[] = [];
  const tracked = execFileSync("git", ["ls-files", "scripts"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.mjs$/.test(f) && !f.startsWith("scripts/lib/"));
  assert.ok(tracked.length > 100, `expected the scripts tree, listed ${tracked.length}`);
  for (const file of tracked) {
    if (/refuseUnknownFlags\(/.test(stripComments(readFileSync(file, "utf8")))) gated.push(file);
  }
  for (const name of PINNED) {
    assert.ok(gated.includes(name), `${name} must call refuseUnknownFlags — a pinned script lost its gate`);
  }
  assert.deepEqual(
    gated.filter((f) => !PINNED.includes(f)),
    [],
    "a script gained a refuseUnknownFlags call that PINNED does not list — add it so deleting it later goes red",
  );

  const knownByScript = new Map<string, string[]>();
  for (const file of PINNED) {
    const source = stripComments(readFileSync(file, "utf8"));
    const importPath = file.split("/").length === 2 ? "./lib/refuse-arguments.mjs" : "../lib/refuse-arguments.mjs";
    assert.ok(
      source.includes(`import { refuseUnknownFlags } from "${importPath}"`),
      `${file}: must import the shared gate as "${importPath}"`,
    );
    assert.match(source, /entry:\s*import\.meta\.url/, `${file}: must pass entry: import.meta.url so an import never judges its parent's flags`);
    knownByScript.set(file, knownOf(source));

    const call = source.indexOf("refuseUnknownFlags({");
    const effect = source.search(SIDE_EFFECT);
    if (effect >= 0) {
      assert.ok(call < effect, `${file}: refuseUnknownFlags must be called BEFORE the first side effect`);
    }

    const env = { ...process.env, PHX_FLAG_GATE_PROBE: "1" };
    const bare = spawnSync(process.execPath, [...LOADER, file], { encoding: "utf8", env });
    assert.equal(bare.status, 0, `${file}: a bare probe must pass its own gate, got ${bare.status}: ${bare.stderr.split("\n").slice(0, 3).join(" | ")}`);
    assert.match(bare.stdout, /GATE-OK/, `${file}: a bare probe must report GATE-OK`);
    const bogus = spawnSync(process.execPath, [...LOADER, file, "--zzz-not-a-flag"], { encoding: "utf8", env });
    assert.equal(bogus.status, 2, `${file}: an unknown flag must be refused with exit 2, got ${bogus.status}`);
    assert.match(bogus.stderr, /REFUSED/, `${file}: the refusal must say so`);
  }

  // ── 4. The caller ratchet — a flag a CALLER passes must be in the script's vocabulary ───────
  {
    const callerFiles = [
      "package.json",
      ".claude/settings.json",
      ...execFileSync("git", ["ls-files", ".github/workflows"], { encoding: "utf8" }).split("\n").filter((f) => /\.ya?ml$/.test(f)),
    ].filter((f) => existsSync(f));
    let controlSeen = false;
    for (const file of PINNED) {
      const needle = `scripts/${file.replace(/^scripts\//, "")}`;
      const known = knownByScript.get(file) ?? [];
      for (const caller of callerFiles) {
        for (const line of readFileSync(caller, "utf8").split("\n")) {
          // A YAML comment that MENTIONS the script is prose, not a caller: ci.yml documents
          // "node scripts/ci-tree-reuse.mjs --report" in a comment above the step that runs --dry-run.
          if (/^\s*#/.test(line)) continue;
          const at = line.indexOf(needle);
          if (at < 0) continue;
          const command = line.slice(at + needle.length).split(/&&|\|\||\||;|"|`/)[0];
          for (const m of command.matchAll(/(?:^|\s)(--?[a-z][\w-]*)(?==|\s|$)/g)) {
            const flag = m[1];
            assert.ok(
              known.includes(flag),
              `${caller} passes ${flag} to ${file}, which would refuse it — add it to that script's known list (${known.join(" ") || "none"})`,
            );
            if (file === "scripts/ci-tree-reuse.mjs" && flag === "--dry-run" && caller.endsWith("ci.yml")) controlSeen = true;
          }
        }
      }
    }
    assert.equal(
      controlSeen,
      true,
      "the scan must SEE .github/workflows/ci.yml passing --dry-run to ci-tree-reuse.mjs — the case that made this ratchet necessary; if it does not, the scan is blind",
    );
  }

  // ── 5. The ratchet over writers ──────────────────────────────────────────────────────────────
  {
    const unguarded: string[] = [];
    for (const file of tracked) {
      const raw = readFileSync(file, "utf8");
      if (!/process\.argv/.test(raw)) continue;
      if (!WRITES.test(raw)) continue;
      if (ALREADY_REFUSES.test(raw)) continue;
      unguarded.push(file);
    }
    assert.deepEqual(
      unguarded,
      [],
      `these scripts parse arguments and write files but ignore an unknown flag — add refuseUnknownFlags (${HELPER}) with a vetted known list: ${unguarded.join(", ")}`,
    );
  }

  // ── 6. run-fold is gated INLINE, on builtins only, before anything runs ──────────────────────
  {
    const file = "scripts/module-memory/run-fold.mjs";
    const source = stripComments(readFileSync(file, "utf8"));
    const refuse = source.indexOf("REFUSED");
    const fetch = source.indexOf('"fetch"');
    const worktree = source.indexOf('"worktree"');
    assert.ok(refuse > 0, `${file}: must refuse an unknown flag inline`);
    assert.ok(fetch > 0 && worktree > 0, `${file}: expected its fetch and worktree calls`);
    assert.ok(
      refuse < fetch && refuse < worktree,
      `${file}: the refusal must come BEFORE the fetch and the worktree — a typo like --dryrun must not open a real PR`,
    );
    assert.match(source, /unknown flag/, `${file}: the refusal must say unknown flag`);
    assert.doesNotMatch(
      source,
      /from\s+["']\.{1,2}\//,
      `${file}: must stay on node builtins only (its header) — gate inline, never import the helper`,
    );

    // 🔴 THE SOURCE ASSERTIONS ABOVE ARE NOT ENOUGH, AND BREAKING THE GATE PROVED IT: turning
    // `if (FOLD_UNKNOWN.length > 0)` into `if (false)` leaves the REFUSED text and its position in the
    // file exactly as they were, so dead code satisfied every one of them (measured 2026-10-15, break 5).
    // The script has to be RUN. That is safe here, and only here, because of two things it already
    // reads: PHX_FOLD_PRIMARY points it at an empty directory, where its next statement says "the
    // primary checkout is not at ..." and exits 1 BEFORE any fetch, worktree or pull request; and the
    // home directory is redirected so even that line lands in a temp log, not the owner's task log.
    // So a working gate answers exit 2, and a broken one answers exit 1 — a difference a test can see
    // without a real PR ever being at risk.
    const sandbox = mkdtempSync(join(tmpdir(), "phx-run-fold-"));
    try {
      const empty = join(sandbox, "no-checkout-here");
      const env = {
        ...process.env,
        PHX_FOLD_PRIMARY: empty,
        USERPROFILE: sandbox,
        HOME: sandbox,
      };
      const go = (...args: string[]) => spawnSync(process.execPath, [file, ...args], { encoding: "utf8", env });

      const typo = go("--dryrun");
      assert.equal(typo.status, 2, `${file} --dryrun must be REFUSED (exit 2), got ${typo.status}: ${typo.stdout}${typo.stderr}`);
      assert.match(typo.stderr, /REFUSED — unknown flag --dryrun/, `${file}: the refusal must name the typo`);
      assert.doesNotMatch(typo.stdout, /primary checkout is not at/, `${file}: a refused typo must stop BEFORE the checkout check`);
      assert.equal(existsSync(join(sandbox, ".claude")), false, `${file}: a refused typo must not even write its log`);

      const help = go("--help");
      assert.equal(help.status, 0, `${file} --help must be answered, exit 0`);
      assert.match(help.stdout, /accepts --dry-run/, `${file} --help must print its vocabulary`);

      // The positive controls: the KNOWN flag and a bare run both pass the gate and stop at the next,
      // harmless statement. Without these, a gate that refused everything would pass the case above.
      for (const args of [["--dry-run"], []]) {
        const r = go(...args);
        assert.equal(r.status, 1, `${file} [${args}] must pass the gate and stop at the missing checkout, got ${r.status}`);
        assert.doesNotMatch(r.stderr, /REFUSED/, `${file} [${args}] must not be refused`);
        assert.match(r.stdout, /primary checkout is not at/, `${file} [${args}] must reach the checkout check`);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
}
