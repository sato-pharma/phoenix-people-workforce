// The targeted PR build — scripts/ci-build-risk.mjs and the ci.yml step that feeds it.
//
// A pull request used to never build (#4802), so a build break first surfaced on `main` and withheld
// the deploy. Since 2026-10-08 a PR also builds when its diff can change the build. The classifier
// is defined by EXCLUSION so every mistake it can make is "built when it did not need to": these
// tests pin that direction — the false-negative cases (a change that CAN break the build must
// build), the fail-safe answers (empty, unreadable, error → build), the rename/delete handling, the
// one ci.yml consumer, and that `main` and the required checks are untouched.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SAFE_PATHS, classifyBuildRisk } from "../scripts/ci-build-risk.mjs";
import { STAGE_JOBS_PR } from "../scripts/remote-check-plan.mjs";

const SCRIPT = resolve("scripts/ci-build-risk.mjs");
const WORKFLOW = resolve(".github/workflows/ci.yml");

function cli(stdin: string): { stdout: string; status: number | null } {
  const run = spawnSync(process.execPath, [SCRIPT], { input: stdin, encoding: "utf8", timeout: 20000 });
  return { stdout: run.stdout, status: run.status };
}

/** One ci.yml step, from its `- name:` line to the next step at the same indent. */
function step(yml: string, name: string): string {
  const at = yml.indexOf(`      - name: ${name}\n`);
  assert.ok(at >= 0, `ci.yml has no step named "${name}"`);
  const next = yml.indexOf("\n      - name: ", at + 1);
  return yml.slice(at, next < 0 ? undefined : next);
}

export function runCiBuildRiskTests(): void {
  // 1 — FALSE NEGATIVES: every one of these can change what `next build` produces, so each must build.
  const mustBuild: Array<[string, string[]]> = [
    ["a src/lib change", ["src/lib/payroll/run.ts"]],
    ["a deleted route (the diff lists the deleted path)", ["app/(admin)/payroll/page.tsx"]],
    ["a renamed component (both halves listed by --no-renames)", ["src/components/old-card.tsx", "src/components/new-card.tsx"]],
    ["a component moved INTO docs/ (old half is code)", ["src/components/card.tsx", "docs/archive/card.tsx"]],
    ["the lockfile", ["pnpm-lock.yaml"]],
    ["package.json", ["package.json"]],
    ["next.config", ["next.config.ts"]],
    [".env.example", [".env.example"]],
    ["a public asset read at runtime", ["public/brand/sato-pharma-logo.png"]],
    ["an assets/ file read at runtime", ["assets/business-cards/Montserrat-Bold.ttf"]],
    ["tsconfig", ["tsconfig.json"]],
    ["middleware / proxy", ["proxy.ts"]],
    ["instrumentation", ["instrumentation.ts"]],
    ["postcss / tailwind", ["postcss.config.mjs"]],
    ["the global stylesheet", ["app/globals.css"]],
    ["ci.yml itself (the Build step lives there)", [".github/workflows/ci.yml"]],
    ["the Dockerfile", ["Dockerfile"]],
    ["a Supabase edge function (not a migration)", ["supabase/functions/x/index.ts"]],
    ["a mix: docs plus one code file", ["docs/testing.md", "tests/a.test.ts", "src/config/system-settings.ts"]],
    ["an unknown root file", ["something-new.json"]],
  ];
  for (const [what, paths] of mustBuild) {
    const verdict = classifyBuildRisk(paths);
    assert.equal(verdict.build, true, `${what} must build — got build=false (${verdict.reason})`);
  }

  // 2 — FAIL-SAFE: nothing to classify, or anything odd, builds.
  for (const [what, input] of [
    ["an empty list", []],
    ["only blank lines", ["", "  ", "\r"]],
    ["not an array", "src/x.ts"],
    ["null", null],
    ["a parent-escaping path", ["docs/../src/lib/x.ts"]],
    ["an absolute path", ["/etc/passwd"]],
  ] as Array<[string, unknown]>) {
    assert.equal(classifyBuildRisk(input).build, true, `${what} must answer build=true`);
  }
  const throwing = new Proxy([] as string[], {
    get(target, key) {
      if (key === "map") throw new Error("boom");
      return Reflect.get(target, key);
    },
  });
  const crashed = classifyBuildRisk(throwing);
  assert.equal(crashed.build, true, "a classifier error must answer build=true");
  assert.match(crashed.reason, /classifier error/, "the error path itself must be the one exercised");

  // 3 — the paths that genuinely never reach the build skip it.
  const safe = [
    "docs/testing.md", "README.md", "tests/ci-build-risk.test.ts", ".claude/rules/engineering.md",
    ".github/workflows/staging-branch-sync.yml", "mobile/app/index.tsx",
    "supabase/migrations/20261008000000_x.sql", "xlsx/sheet.xlsx", "scripts/remote-check.mjs",
    "src/lib/payroll/README.md",
  ];
  assert.equal(classifyBuildRisk(safe).build, false, `a diff of only build-inert paths must skip the build: ${classifyBuildRisk(safe).reason}`);
  assert.ok(SAFE_PATHS.length > 0 && SAFE_PATHS.length <= 10, "the safe list grew — every entry is a skip, so each needs its own proof here");

  // 4 — the CLI: one `build=` line on stdout, and the same fail-safe.
  assert.equal(cli("src/lib/x.ts\n").stdout.trim(), "build=true");
  assert.equal(cli("docs/a.md\ntests/b.test.ts\n").stdout.trim(), "build=false");
  assert.equal(cli("").stdout.trim(), "build=true", "an empty diff on stdin must answer build=true");
  assert.equal(cli("docs/a.md\r\n").stdout.trim(), "build=false", "CRLF input must still classify");

  // 5 — a REAL git rename: `--no-renames` must list both halves, so code → docs builds.
  const repo = mkdtempSync(join(tmpdir(), "phx-buildrisk-"));
  try {
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
      assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout;
    };
    git("init", "-q");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "card.tsx"), "export const card = 1;\n".repeat(20));
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    mkdirSync(join(repo, "docs"), { recursive: true });
    git("mv", "src/card.tsx", "docs/card.tsx");
    git("commit", "-q", "-m", "move");
    const listed = git("diff", "--name-only", "--no-renames", "HEAD^1", "HEAD");
    assert.match(listed, /^src\/card\.tsx$/m, "--no-renames must list a rename's OLD path");
    assert.match(listed, /^docs\/card\.tsx$/m, "--no-renames must list a rename's NEW path");
    assert.equal(cli(listed).stdout.trim(), "build=true", "moving code into docs/ must build — the 2026-10-02 rename blind spot");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  // 6 — `scripts/**` is safe ONLY while nothing the build compiles imports a script. Re-proved here
  // so the day an import appears, this goes red instead of the build silently skipping it.
  const importOfScripts = spawnSync(
    "git",
    ["grep", "-nE", "(from|import\\(|require\\()\\s*['\"][^'\"]*\\bscripts/", "--", "app", "src", "*.config.*", "proxy.ts", "middleware.ts", "instrumentation*.ts"],
    { encoding: "utf8" },
  );
  assert.equal(importOfScripts.stdout.trim(), "", `the build imports a file under scripts/, so scripts/** is no longer build-inert:\n${importOfScripts.stdout}`);
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.build, "next build", "the build script changed — re-check which paths it reads before trusting the safe list");
  assert.ok(!pkg.scripts.prebuild && !pkg.scripts.postbuild, "a pre/postbuild script now runs with the build — re-check the safe list");

  // 7 — ci.yml: the step, its one consumer, and everything that must NOT move.
  const yml = readFileSync(WORKFLOW, "utf8").replace(/\r\n/g, "\n");
  const risk = step(yml, "Build risk");
  assert.match(risk, /id: buildrisk/);
  assert.match(risk, /if: github\.event_name == 'pull_request'/, "the classifier runs on pull requests only");
  assert.match(risk, /git diff --name-only --no-renames HEAD\^1 HEAD/, "the diff must be read with --no-renames, against the merge commit's first parent");
  assert.match(risk, /\|\| files=""/, "an unreadable diff must not fail the step — it must fall through to the classifier's build=true");
  assert.match(risk, /node scripts\/ci-build-risk\.mjs >> "\$GITHUB_OUTPUT" \|\| echo "build=true" >> "\$GITHUB_OUTPUT"/, "a crashed classifier must still answer build=true");
  assert.ok(yml.indexOf("      - name: Build risk\n") < yml.indexOf("      - name: Build\n"), "Build risk must run before Build");

  assert.match(
    step(yml, "Build"),
    /\n {8}if: github\.event_name != 'pull_request' \|\| steps\.buildrisk\.outputs\.build == 'true'\n/,
    "the Build's condition must stay `<not a PR> || <build risk>` — `main` always builds, a PR builds on risk",
  );
  for (const name of [
    "Verify @napi-rs/canvas is reachable inside .next/standalone",
    "Assemble the standalone runtime (mirrors the Dockerfile)",
    "Run Playwright login smoke test",
  ]) {
    const block = step(yml, name);
    assert.match(block, /if: github\.event_name != 'pull_request'/, `"${name}" must stay main-only`);
    assert.doesNotMatch(block, /buildrisk/, `"${name}" must not follow the build-risk output — only the Build is added to a PR`);
  }
  assert.match(yml, /\n {2}validate:\n/, "the required `validate` job is gone or renamed");
  assert.match(yml, /\n {2}checks:\n/, "the required `checks` job is gone or renamed");
  const onBlock = yml.slice(yml.indexOf("\non:"), yml.indexOf("\njobs:"));
  assert.match(onBlock, /push:\s*\n(?:\s*#.*\n)*\s*branches:\s*\n\s*- main/, "`push: main` — the production deploy gate — must stay");

  // 8 — remote-check must never read a PR's skipped-or-run Build as a build verdict: the job can be
  // green with the Build skipped, so a pull_request run answers NO VERDICT for `build`.
  assert.equal((STAGE_JOBS_PR as Record<string, unknown>).build, null, "STAGE_JOBS_PR.build must stay null — a green PR validate is not a build PASS");
}
