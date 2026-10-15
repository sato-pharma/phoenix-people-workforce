import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
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
  "scripts/analyze-distributor-file.ts",
  "scripts/apply-migrations-to-staging.ts",
  "scripts/apply-sql-file.mjs",
  "scripts/apps-script-authorize.mjs",
  "scripts/audit-notification-email-identity.ts",
  "scripts/backfill-attribution-store-split.ts",
  "scripts/backfill-checkin-addresses.ts",
  "scripts/backfill-cvs-to-drive.mjs",
  "scripts/backfill-missing-access-profiles.ts",
  "scripts/backfill-whatsapp-classify-gaps.ts",
  "scripts/backup-source-of-sales.mjs",
  "scripts/build-closing-engine-template.mjs",
  "scripts/build-crm-vacation-target-rows.ts",
  "scripts/build-cv-cabinet.mjs",
  "scripts/check-dependabot-alerts.mjs",
  "scripts/check-dockerfile.mjs",
  "scripts/check-required-checks.mjs",
  "scripts/check-sales-truth.ts",
  "scripts/check-schema-shape.ts",
  "scripts/check-sos-source-files.ts",
  "scripts/check-tests-parse.mjs",
  "scripts/check-unbacked-branches.ts",
  "scripts/check-workbook-integrity.mjs",
  "scripts/ci-tree-reuse.mjs",
  "scripts/cloud-mirror-drift-refresh.mjs",
  "scripts/codemod-badge-tones.mjs",
  "scripts/codemod-hex-to-tokens.mjs",
  "scripts/codemod-type-scale.mjs",
  "scripts/correct-a7-vacation-records.ts",
  "scripts/correct-excuse-days-orgwide.ts",
  "scripts/cronjob-sync.mjs",
  "scripts/customer-pharmacy-pending-questions.ts",
  "scripts/customer-territory-questions.ts",
  "scripts/cv-area-questions.mjs",
  "scripts/cv-rule-extraction-report.ts",
  "scripts/cv-triage-questions.mjs",
  "scripts/dictation-corrector-eval.ts",
  "scripts/direct-orders-pharmacy-price-backfill.ts",
  "scripts/direct-orders-rebuild-approval-chains.ts",
  "scripts/dm-line-achievement.ts",
  "scripts/dry-run-dsm-no-record.ts",
  "scripts/dry-run-holiday-bridge.ts",
  "scripts/field-day/print-day.mjs",
  "scripts/field-day/run-nightly.mjs",
  "scripts/fwc-pull.ts",
  "scripts/headwind-bootstrap.mjs",
  "scripts/headwind-push-apk.ts",
  "scripts/healthchecks-sync.mjs",
  "scripts/import-crm-vacation-backfill.ts",
  "scripts/import-marketing-roi-sheet.ts",
  "scripts/import-pharmacy-code-references.ts",
  "scripts/learn-from-cleaned-dry-run.ts",
  "scripts/market-awareness-refire-pending-notices.ts",
  "scripts/marketing-pharmacy-code-questions.ts",
  "scripts/master-map-preview.ts",
  "scripts/measure-production-planning-fit.mjs",
  "scripts/memory-index-reachability.mjs",
  "scripts/merge-duplicate-cv-candidates.ts",
  "scripts/module-memory/build.mjs",
  "scripts/module-memory/fold.mjs",
  "scripts/module-memory/proof.mjs",
  "scripts/needs-you.mjs",
  "scripts/new-session.mjs",
  "scripts/phase19-fixture-cleanup-smoke.ts",
  "scripts/pin-coverage-report.mjs",
  "scripts/probe-weekly-xlsx.ts",
  "scripts/provision-missing-employee-accounts.ts",
  "scripts/push-apps-script.mjs",
  "scripts/rebuild-a9-marketing-manager-account.ts",
  "scripts/rebuild-source-of-sales-rollups.ts",
  "scripts/reconcile-month-customer-map.ts",
  "scripts/reconcile-payroll-deductions.ts",
  "scripts/record-a10-vacation-2025-10-29.ts",
  "scripts/recruitment-apply-reread-fields.ts",
  "scripts/recruitment-cv-fact-corrections.ts",
  "scripts/recruitment-fix-candidate-names.ts",
  "scripts/recruitment-reread-legacy-schema-cvs.ts",
  "scripts/recruitment-reread-never-read-cvs.ts",
  "scripts/recruitment-split-forwarded-candidates.ts",
  "scripts/refresh-local-env.mjs",
  "scripts/rep-seat-vacancies.ts",
  "scripts/repo-cleanup.mjs",
  "scripts/repo-doctor.mjs",
  "scripts/repoint-cv-mirror-to-cabinet.mjs",
  "scripts/resolve-brick-pins.mjs",
  "scripts/resolve-gap-bricks.mjs",
  "scripts/respread-swing-table.ts",
  "scripts/restate-area-month.ts",
  "scripts/restore-source-of-sales.mjs",
  "scripts/run-holiday-bridge-collection.ts",
  "scripts/seed-vlookup-master.mjs",
  "scripts/select-census.mjs",
  "scripts/setup-telegram-bot.mjs",
  "scripts/slow-audit.mjs",
  "scripts/source-of-sales-direct-import-cleanup.ts",
  "scripts/source-of-sales-warning-cleanup.ts",
  "scripts/staging-executive-dashboard-migration-reconciliation.ts",
  "scripts/staging-safe-rebuild.ts",
  "scripts/sync-railway-production-secrets.mjs",
  "scripts/sync-worktree-env.mjs",
  "scripts/synthetic-save-report.ts",
  "scripts/vacation-retention-purge.ts",
  "scripts/validate-railway-production-secrets.mjs",
  "scripts/verify-sofico-upload.ts",
  "scripts/wait-pr.mjs",
];

const WRITES =
  /\b(writeFileSync|appendFileSync|mkdirSync|rmSync|cpSync|copyFileSync|renameSync|unlinkSync|writeFile|mkdir)\s*\(/;
const SIDE_EFFECT =
  /\b(writeFileSync|appendFileSync|mkdirSync|rmSync|cpSync|copyFileSync|renameSync|unlinkSync|writeFile|createClient|chromium|postgres)\s*\(/;
const ALREADY_REFUSES = /(unknown (flag|argument|option)|unrecogni[sz]|refuseUnknownFlags|refuseArguments|parseDriftCheckFlags)/i;

const knownOf = (source: string): string[] => {
  const m = source.match(/refuseUnknownFlags\(\{[\s\S]*?known:\s*\[([^\]]*)\]/);
  assert.ok(m, "no refuseUnknownFlags({ known: [...] }) call found");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};

export async function runUnknownFlagGatesTests() {
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

    // A bare "--" is the end-of-options marker: `pnpm run x -- --apply` can hand it through, and it must
    // not be read as an unknown flag. Everything AFTER it is positional and is never judged either.
    for (const args of [["--", "--apply"], ["--apply", "--", "--not-a-flag"], ["--", "file.xlsx"]]) {
      fresh();
      const r = run(standalone, args);
      assert.equal(r.status, 0, `args [${args}] must pass: a bare -- is not a flag and what follows is positional, got ${r.status}: ${r.stderr}`);
      assert.equal(ran(), true, `args [${args}] must reach the body`);
    }
    {
      fresh();
      const r = run(standalone, ["--aply", "--", "--apply"]);
      assert.equal(r.status, 2, "an unknown flag BEFORE the -- is still refused");
      assert.equal(ran(), false);
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

      // The probe can also name its TARGET: a gated module imported by the probed script stays passive, and
      // only the probed file's own gate is strict. (validate-railway-production-secrets imports the gated
      // sync-railway-production-secrets; the all-strict form made that import look like a lost entry point.)
      fresh();
      const nested = run(parent, [], { PHX_FLAG_GATE_PROBE: parent });
      assert.equal(nested.status, 0, `a gated module IMPORTED by the probed script must pass quietly: ${nested.stderr}`);
      assert.equal(ran(), true, "the probed script's own body runs when it carries no gate of its own — the probe only guards a gate that exists");
      fresh();
      const targeted = run(parent, [], { PHX_FLAG_GATE_PROBE: child });
      assert.equal(targeted.status, 3, "a gate whose own file IS the probe target must exit 3 when it is not the entry point");
      assert.equal(ran(), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // ── 3b. Every pinned script: gated, called early, and the gate answers when probed ──────────
  const gated: string[] = [];
  const tracked = execFileSync("git", ["ls-files", "scripts"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(mjs|ts)$/.test(f) && !f.startsWith("scripts/lib/"));
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
  const probeFiles: string[] = [];
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

    probeFiles.push(file);
  }

  // The probes run in parallel batches: 105 scripts × 2 spawns is minutes if serial, and each one only loads
  // its imports and answers at the gate. The environment is MINIMAL on purpose — CI has no .env.local and no
  // production credentials, so a script that cannot even be imported without them must fail HERE, on the
  // laptop, and not first on the runner.
  const probeEnv: Record<string, string> = { PHX_FLAG_GATE_PROBE: "1" };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "ComSpec", "PATHEXT"]) {
    const value = process.env[key];
    if (value !== undefined) probeEnv[key] = value;
  }
  const spawnAsync = (args: string[], target: string) =>
    new Promise<{ status: number; stdout: string; stderr: string }>((done) => {
      execFile(process.execPath, args, { encoding: "utf8", env: { ...probeEnv, PHX_FLAG_GATE_PROBE: resolve(target) } as unknown as NodeJS.ProcessEnv, timeout: 120_000, maxBuffer: 1 << 24 }, (error: Error | null, stdout: string, stderr: string) => {
        const code = error ? (error as NodeJS.ErrnoException & { code?: unknown }).code : 0;
        done({ status: typeof code === "number" ? code : 1, stdout, stderr });
      });
    });
  for (let at = 0; at < probeFiles.length; at += 8) {
    const batch = probeFiles.slice(at, at + 8);
    const results = await Promise.all(
      batch.map(async (file) => ({
        file,
        bare: await spawnAsync([...LOADER, file], file),
        bogus: await spawnAsync([...LOADER, file, "--zzz-not-a-flag"], file),
      })),
    );
    for (const { file, bare, bogus } of results) {
      assert.equal(bare.status, 0, `${file}: a bare probe must pass its own gate, got ${bare.status}: ${bare.stderr.split("\n").slice(0, 3).join(" | ")}`);
      assert.match(bare.stdout, /GATE-OK/, `${file}: a bare probe must report GATE-OK`);
      assert.equal(bogus.status, 2, `${file}: an unknown flag must be refused with exit 2, got ${bogus.status}`);
      assert.match(bogus.stderr, /REFUSED/, `${file}: the refusal must say so`);
    }
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

  // ── 4b. Every flag a script TESTS FOR in its own code is in its known list ───────────────────
  // The caller ratchet above sees what a caller passes; nothing yet saw a flag the script itself reads. Dropping
  // `--apply` from `known` would leave every caller scan green and make the script refuse its own mutating flag.
  // Read straight from each pinned script's comment-stripped source: argv.includes("--x"), indexOf, startsWith,
  // has("--x"), and the helper style flag("x") / has("x") / argValue("x") of the scripts that build `--${name}`.
  {
    const DASHED = /\b(?:includes|indexOf|startsWith|has)\(\s*["'`](--?[A-Za-z][\w-]*)=?["'`]/g;
    const NAMED = /\b(?:flag|arg|argValue|readArg|value|has)\(\s*["'`]([A-Za-z][\w-]*)["'`]/g;
    let seen = 0;
    for (const file of PINNED) {
      const source = stripComments(readFileSync(file, "utf8"));
      const known = knownByScript.get(file) ?? [];
      const own = new Set<string>();
      for (const m of source.matchAll(DASHED)) own.add(m[1]);
      if (/`--\$\{(?:name|flag|key)\}/.test(source) || /["'`]--["'`]\s*\+/.test(source)) {
        for (const m of source.matchAll(NAMED)) own.add(`--${m[1]}`);
      }
      for (const flag of own) {
        if (flag === "--help" || flag === "-h") continue;
        seen += 1;
        assert.ok(known.includes(flag), `${file} tests for ${flag} itself, but its known list (${known.join(" ") || "none"}) lacks it — the script would refuse its own flag`);
      }
    }
    assert.ok(seen > 60, `the own-flag scan must see the scripts' flags (saw ${seen}); if it sees almost none it is blind`);
  }

  // A caller that passes flags through an ARRAY — execFileSync("node", [SYNC_SCRIPT, "--job", key, "--apply"]) —
  // is invisible to the line scan above, and it is the production cron arming path: cron-autoarm.yml runs it on
  // every deploy that adds a job. So the two flags it passes are pinned by name, read from its own source.
  {
    const autoarm = stripComments(readFileSync("scripts/cron-autoarm.mjs", "utf8"));
    const known = knownByScript.get("scripts/cronjob-sync.mjs") ?? [];
    for (const flag of ["--job", "--apply"]) {
      assert.ok(autoarm.includes(`"${flag}"`), `scripts/cron-autoarm.mjs no longer passes ${flag} to cronjob-sync — drop this check with it`);
      assert.ok(known.includes(flag), `cron-autoarm passes ${flag} to cronjob-sync, which would refuse it and leave a new cron unarmed`);
    }
  }

  // ── 5. The ratchet over every script that takes arguments ────────────────────────────────────
  // It started as "parses argv AND writes files" and that left the whole .ts tree and every read-only report
  // outside it — `rep-seat-vacancies.ts --perod=2026-10` read the DEFAULT month and printed a confident answer.
  // So: any tracked non-library script that PARSES arguments (a flag, a positional, or a parser) must refuse
  // an unknown one, or be listed here with the reason it must not.
  const EXEMPT: Record<string, string> = {
    "scripts/dev-server.mjs": "forwards every flag it does not own to `next dev`, so refusing one would break the passthrough",
    "scripts/office-rule-unlock.ts": "its own mode switch prints usage and exits 1 on anything but --set-password or --unlock",
    "scripts/weekly-export-design-unlock.ts": "its own mode switch prints usage and exits 1 on anything but --set-password or --unlock",
  };
  {
    const PARSES_ARGS =
      /process\.argv\.(includes|indexOf|find|some|filter|slice\(\s*[2-9])|process\.argv\[[2-9]\]|parseArgs\(/;
    const unguarded: string[] = [];
    for (const file of tracked) {
      if (file in EXEMPT) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (ALREADY_REFUSES.test(code)) continue;
      if (PARSES_ARGS.test(code) || (/process\.argv/.test(code) && WRITES.test(code))) unguarded.push(file);
    }
    assert.deepEqual(
      unguarded,
      [],
      `these scripts take arguments but ignore an unknown one — add refuseUnknownFlags (${HELPER}) with a vetted known list, or EXEMPT with a reason: ${unguarded.join(", ")}`,
    );
    for (const file of Object.keys(EXEMPT)) {
      assert.ok(tracked.includes(file), `EXEMPT lists ${file}, which is not a tracked script any more — remove the entry`);
      assert.equal(gated.includes(file), false, `${file} is gated now — drop its EXEMPT entry so the reason cannot go stale`);
    }
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
  // ── 7. The hourly backup refuses an unknown flag — INLINE, because it runs as a lone extracted file ──
  // `xlsx-snapshot.cmd` runs `git show origin/main:scripts/repo-doctor-xlsx-snapshot.mjs` into a temp file and
  // executes that file alone, so the shared helper cannot be imported here. The destination is pointed at a
  // folder that does not exist, so even a gate that failed would stop at its next statement and copy nothing.
  {
    const file = "scripts/repo-doctor-xlsx-snapshot.mjs";
    const source = stripComments(readFileSync(file, "utf8"));
    assert.doesNotMatch(source, /from\s+["']\.{1,2}\//, `${file}: must stay on node builtins — it is extracted ALONE by xlsx-snapshot.cmd`);
    const sandbox = mkdtempSync(join(tmpdir(), "phx-xlsx-snap-"));
    try {
      const env = { ...process.env, PHOENIX_XLSX_SNAPSHOT_ROOT: join(sandbox, "no-destination-here") };
      const go = (...args: string[]) => spawnSync(process.execPath, [file, ...args], { encoding: "utf8", env });
      const typo = go("--repo", sandbox, "--rot", "x");
      assert.equal(typo.status, 2, `${file}: an unknown flag must exit 2, got ${typo.status}: ${typo.stderr}`);
      assert.match(typo.stderr, /REFUSED — unknown flag --rot/, `${file}: the refusal must name the typo`);
      const equalsForm = go(`--repo=${sandbox}`);
      assert.match(equalsForm.stderr, /unknown flag --repo=/, `${file}: --repo=x is refused, because the parser reads only the separate-value form and would ignore it`);
      // The positive control: the flag the wrapper really passes gets PAST the gate and stops at the missing
      // destination — a different message, so a gate that refused everything cannot satisfy the cases above.
      const known = go("--repo", sandbox);
      assert.equal(known.status, 2);
      assert.doesNotMatch(known.stderr, /unknown flag/, `${file}: --repo <path> is what xlsx-snapshot.cmd passes and must not be refused`);
      assert.match(known.stderr, /does not exist\. Nothing was copied/, `${file}: it must reach the destination check`);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
}
