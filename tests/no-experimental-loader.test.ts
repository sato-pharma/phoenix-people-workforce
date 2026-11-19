// No node in this repository loads its module hooks with `--experimental-loader` (20 Nov 2026).
//
// On Node 24.15.0 that flag ALONE — with an EMPTY hooks file — makes every allocating regular-expression
// call in the main thread 50-90x slower: splitting 41 MB on /\r?\n/ took 9.5-11.6 s under it and about
// 100 ms with no loader, with `module.register` through `--import`, or with `module.registerHooks`.
// The whole unit suite ran under it through package.json's `test` script, which CI's `unit` jobs run.
// The same hooks are now registered by a small `register-*.mjs` beside each hooks file and loaded with
// `--import`; this test keeps the old flag from coming back by copy-paste from an old script header.
// Account: docs/perf/2026-11-20-commit-push-pr-slowness.md.
//
// THE BREAK DIRECTION: put `--experimental-loader ./tests/alias-loader.mjs` back into package.json's
// `test` script and case 1 names it; put it in any tracked script and case 2 names the file; point a
// register file at a hooks file that is not there and case 3 names it; point an `--import` at a
// register file that does not exist and case 4 names it.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** The old flag, in every spelling node accepts: `--experimental-loader x`, `=x`, and `--loader`. */
const OLD_FLAG = /--experimental-loader\b|(?<![\w-])--loader(?:[ =]|"|'|`)/;

/**
 * Files that may NAME the old flag, each because it explains why the flag is gone. Nothing here may
 * USE it. Markdown is never scanned: the docs and the memory mirror tell the history.
 */
const MAY_NAME_THE_OLD_FLAG = new Map<string, string>([
  ["tests/no-experimental-loader.test.ts", "this pin"],
  ["tests/check-contracts.test.ts", "the first pin, on scripts/check-contracts-gates.mjs's own flags"],
  ["scripts/check-contracts-gates.mjs", "its header records the 20 Nov 2026 switch"],
  ["tests/register-alias-loader.mjs", "the comment that says why it exists"],
  ["tests/register-phase27-alias-loader.mjs", "the comment that says why it exists"],
  ["scripts/register-alias-loader.mjs", "the comment that says why it exists"],
  ["scripts/register-needs-you-fit-loader.mjs", "the comment that says why it exists"],
]);

const SCANNED = /\.(?:mjs|cjs|js|ts|tsx|mts|cts|json|ya?ml|sh|ps1|cmd|bat)$/;

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  return out.split("\0").filter(Boolean);
}

export function runNoExperimentalLoaderTests() {
  // ── 1. package.json: no script uses the old flag, and the suite's own script uses --import ───────
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const offenders = Object.entries(pkg.scripts)
    .filter(([, command]) => OLD_FLAG.test(command))
    .map(([name]) => name);
  assert.deepEqual(
    offenders,
    [],
    `package.json scripts must load module hooks with --import ./…/register-*.mjs, never --experimental-loader ` +
      `(it makes every allocating regex call 50-90x slower on Node 24): ${offenders.join(", ")}`,
  );
  for (const name of ["test", "coverage"]) {
    assert.match(
      pkg.scripts[name] ?? "",
      /--import \.\/tests\/register-alias-loader\.mjs tests\/run-tests\.ts/,
      `package.json "${name}" must run tests/run-tests.ts with --import ./tests/register-alias-loader.mjs`,
    );
  }

  // ── 2. every tracked script, test, source file and workflow ─────────────────────────────────────
  const files = trackedFiles();
  assert.ok(files.length > 1000, `git ls-files listed only ${files.length} files — the scan would prove nothing`);
  let scanned = 0;
  const usesOldFlag: string[] = [];
  for (const file of files) {
    if (!SCANNED.test(file) || MAY_NAME_THE_OLD_FLAG.has(file) || file.startsWith(".claude/cloud-context/")) continue;
    const full = path.join(ROOT, file);
    if (!existsSync(full)) continue;
    scanned += 1;
    if (OLD_FLAG.test(readFileSync(full, "utf8"))) usesOldFlag.push(file);
  }
  assert.ok(scanned > 1000, `only ${scanned} code files were scanned — the scan would prove nothing`);
  assert.deepEqual(
    usesOldFlag,
    [],
    `these files name --experimental-loader; spawn node with --import ./tests/register-alias-loader.mjs ` +
      `(or the register-*.mjs beside the hooks file you need) instead: ${usesOldFlag.join(", ")}`,
  );
  for (const file of MAY_NAME_THE_OLD_FLAG.keys()) {
    assert.ok(existsSync(path.join(ROOT, file)), `${file} is excused from the scan but no longer exists — drop it from the list`);
  }

  // ── 3. every register file registers a hooks file that is really beside it ─────────────────────
  const registerFiles = files.filter((file) => /(?:^|\/)register-[\w-]+\.mjs$/.test(file) && /^(?:tests|scripts)\//.test(file));
  assert.deepEqual(
    [...registerFiles].sort(),
    [
      "scripts/register-alias-loader.mjs",
      "scripts/register-needs-you-fit-loader.mjs",
      "tests/register-alias-loader.mjs",
      "tests/register-phase27-alias-loader.mjs",
    ],
    "the four register files (one per hooks file) must all be tracked",
  );
  for (const file of registerFiles) {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    const match = /register\("(\.\/[\w.-]+\.mjs)", import\.meta\.url\)/.exec(source);
    assert.ok(match, `${file} must call register("./<hooks>.mjs", import.meta.url)`);
    const hooks = path.join(ROOT, path.dirname(file), match[1]);
    assert.ok(existsSync(hooks), `${file} registers ${match[1]}, which does not exist beside it`);
  }

  // ── 4. every --import in package.json names a file that exists ───────────────────────────────────
  for (const [name, command] of Object.entries(pkg.scripts)) {
    for (const imported of command.matchAll(/--import[ =](\.\/[^\s"']+)/g)) {
      assert.ok(existsSync(path.join(ROOT, imported[1])), `package.json "${name}" imports ${imported[1]}, which does not exist`);
    }
  }
}
