// The type gate is TypeScript 7, the NATIVE compiler, and it is held in place by a package alias
// rather than by any command naming it.
//
// WHY THIS EXISTS. `docs/ci-self-hosted-runner.md` measured the native compiler at 7.7x on
// 2026-09-30 and refused to adopt it, correctly: it was `@typescript/native-preview`, a dated dev
// build, and it reported three TS2871 "This expression is always nullish" diagnostics that are
// false. TypeScript 7.0.2 shipped stable on 2026-07-08, and on 2026-10-06 it was adopted here after
// a replay: every one of the 19 typecheck errors that failed CI across the 14 most recent red PRs
// is reported by 7 on the same commit. The three TS2871 sites were rewritten to a form both
// compilers accept (`src/lib/customer-360/service.ts`, `src/lib/verified-captures/distributor-codes.ts`);
// they are the ONLY places this cost anything.
//
// 🔴 WHAT CAN GO WRONG, AND WHY IT IS INVISIBLE. Nothing in `package.json`'s `typecheck` script or in
// `ci.yml` names a version — both run `tsc`, and WHICH `tsc` that is comes from pnpm linking
// `node_modules/.bin/tsc` to the higher of the two installed versions. So dropping the
// `typescript-native` alias, or letting `typescript` float past 7, does not fail: the gate silently reverts to the ~180s compiler, or silently moves to one nobody chose,
// with every command and every doc still reading correctly. The `--checkers` flag is the one
// mechanical tell, because TypeScript 5 rejects it outright — which is why it is passed rather than
// left at its default, and why this file asserts it is still there.
//
// `typescript` 5.x STAYS INSTALLED and must: typescript-eslint loads it through
// `eslint-config-next/typescript`, Next loads it because a tsconfig.json exists, twelve tests import
// the compiler API from it, and the editor's language service is it. Removing it to "finish the
// migration" breaks lint and the editor while the gate goes on passing.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(resolve(ROOT, relative), "utf8");
const manifest = () => JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** The major of a semver-ish string, or NaN. */
function major(version: string): number {
  return Number(/(\d+)/.exec(version.replace(/^npm:typescript@/, ""))?.[1] ?? NaN);
}

export function runTypecheckNativeCompilerTests() {
  const pkg = manifest();

  // 1 — the alias is declared, and it is the native compiler at 7 or above.
  const alias = pkg.devDependencies["typescript-native"];
  assert.ok(
    typeof alias === "string" && alias.startsWith("npm:typescript@"),
    "devDependencies['typescript-native'] must be an `npm:typescript@<version>` alias — it is what " +
      "pnpm links `node_modules/.bin/tsc` to, and therefore what `pnpm run typecheck` and ci.yml's " +
      "`static` job actually run. Read: " + JSON.stringify(alias),
  );
  assert.ok(
    major(alias) >= 7,
    `the typecheck gate must stay on TypeScript 7 or later; the alias reads ${JSON.stringify(alias)}. ` +
      "Below 7 this is the ~180s compiler again, and nothing else in the repo would say so.",
  );

  // 2 — typescript@5 stays, for the editor, Next and typescript-eslint (see the header).
  const classic = pkg.devDependencies.typescript;
  assert.ok(
    typeof classic === "string" && major(classic) === 5,
    "devDependencies.typescript must stay on 5.x. It is not the gate any more, but typescript-eslint, " +
      "Next's own tsconfig handling, the editor's language service and twelve tests that import the " +
      "compiler API all load it by that name. Read: " + JSON.stringify(classic),
  );

  // 3 — `--checkers` is the mechanical tell. TypeScript 5 refuses the flag, so if the alias is ever
  // lost the typecheck fails loudly on an unknown option instead of quietly running the old
  // compiler. The one caller left is ci.yml's `static` job, which runs the package script — so the
  // flag lives there, and the job must still run that script rather than a spelling of its own.
  assert.match(
    pkg.scripts.typecheck,
    /--checkers\s+\d+/,
    "package.json's `typecheck` script no longer passes `--checkers`. That flag is the only thing " +
      "that makes a lost `typescript-native` alias FAIL rather than silently fall back to " +
      "TypeScript 5 — every other part of the command is identical between the two compilers.",
  );
  const ci = read(".github/workflows/ci.yml")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.match(
    ci,
    /- name: Typecheck\n\s+run: pnpm run typecheck\n/,
    "ci.yml's Typecheck step must run `pnpm run typecheck` — the script that carries `--checkers`. A spelling of " +
      "its own (`tsc --noEmit`, `npx tsc`) would not, and a lost alias would then pass silently.",
  );

  // 4 — and the thing actually linked IS 7. This is the assertion the three above only approximate:
  // they read declarations, this one asks the binary that will run.
  // On Windows (the spare laptop) pnpm's `.bin/tsc` is a shell script that cannot be spawned (ENOENT); the
  // same link is `tsc.CMD`, which Node runs only through a shell, quoted for a folder with a space in it.
  const bin = resolve(ROOT, "node_modules/.bin/tsc");
  const version = (
    process.platform === "win32"
      ? execFileSync(`"${bin}.CMD"`, ["-v"], { encoding: "utf8", shell: true })
      : execFileSync(bin, ["-v"], { encoding: "utf8" })
  ).trim();
  assert.match(
    version,
    /\b7\.\d+/,
    "`node_modules/.bin/tsc -v` is not TypeScript 7, so the installed tree does not match what " +
      "package.json declares — a lockfile or an install is stale. Read: " + JSON.stringify(version),
  );
}
