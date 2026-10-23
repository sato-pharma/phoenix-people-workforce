// The targeted PR build — scripts/ci-build-risk.mjs and the ci.yml step that feeds it.
//
// A pull request used to never build (#4802), so a build break first surfaced on `main` and withheld
// the deploy. Since 2026-10-08 a PR also builds when it touches a ROUTE or a BUILD CONFIG file —
// narrowed the same day at the owner's word ("narrow the PR build to routes and config") from a
// build-unless-inert rule that built 52.5% of PRs. These tests pin what must build, what is now
// deliberately skipped (a src/** library or component change — main's build catches it), the
// fail-safe answers (empty, unreadable, odd, error → build), rename/delete handling, the one ci.yml
// consumer, and that `main` and the required checks are untouched.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BUILD_PATHS, classifyBuildRisk } from "../scripts/ci-build-risk.mjs";
import { gradeActionsStages } from "../scripts/remote-check-plan.mjs";

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
  // 1 — every route and every build-config change builds.
  const mustBuild: Array<[string, string[]]> = [
    ["a page", ["app/(admin)/payroll/page.tsx"]],
    ["a deleted route (the diff lists the deleted path)", ["app/(admin)/payroll/page.tsx"]],
    ["an API route handler", ["app/api/employees/route.ts"]],
    ["a layout", ["app/(admin)/layout.tsx"]],
    ["an error boundary", ["app/(admin)/sales/error.tsx"]],
    ["a not-found boundary", ["app/not-found.tsx"]],
    ["a metadata route", ["app/robots.ts"]],
    ["the global stylesheet", ["app/globals.css"]],
    ["the lockfile", ["pnpm-lock.yaml"]],
    ["package.json", ["package.json"]],
    ["next.config", ["next.config.ts"]],
    ["tsconfig", ["tsconfig.json"]],
    ["proxy", ["proxy.ts"]],
    ["middleware", ["middleware.ts"]],
    ["instrumentation", ["instrumentation.ts"]],
    ["postcss", ["postcss.config.mjs"]],
    ["ci.yml itself (the Build step lives there)", [".github/workflows/ci.yml"]],
    ["the Dockerfile", ["Dockerfile"]],
    ["a mix: docs, tests, a library file and one route", ["docs/testing.md", "tests/a.test.ts", "src/lib/payroll/run.ts", "app/(admin)/payroll/page.tsx"]],
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

  // 3 — everything else skips the build. The src/** lines are the owner's accepted trade-off
  // (2026-10-08): a library or component break is caught by main's build, or earlier by remote-check all.
  const skip = [
    "src/lib/payroll/run.ts", "src/components/ui/form-kit.tsx", "src/config/system-settings.ts",
    "app/(admin)/payroll/payroll-table.tsx", "docs/testing.md", "README.md", "tests/ci-build-risk.test.ts",
    ".claude/rules/engineering.md", ".github/workflows/deploy-drift-check.yml", "mobile/app/index.tsx",
    "supabase/migrations/20261008000000_x.sql", "xlsx/sheet.xlsx", "scripts/remote-check.mjs",
    "public/brand/sato-pharma-logo.png", ".env.example",
  ];
  assert.equal(classifyBuildRisk(skip).build, false, `a diff with no route or build config must skip the build: ${classifyBuildRisk(skip).reason}`);
  for (const path of skip) {
    assert.equal(classifyBuildRisk([path]).build, false, `${path} alone must skip the build`);
  }
  assert.ok(BUILD_PATHS.length > 0 && BUILD_PATHS.length <= 12, "the build list changed shape — re-measure the build share on recent PRs");

  // 4 — the CLI: one `build=` line on stdout, and the same fail-safe.
  assert.equal(cli("app/x/page.tsx\n").stdout.trim(), "build=true");
  assert.equal(cli("src/lib/x.ts\n").stdout.trim(), "build=false", "a library file alone no longer builds (owner, 2026-10-08)");
  assert.equal(cli("docs/a.md\ntests/b.test.ts\n").stdout.trim(), "build=false");
  assert.equal(cli("").stdout.trim(), "build=true", "an empty diff on stdin must answer build=true");
  assert.equal(cli("docs/a.md\r\n").stdout.trim(), "build=false", "CRLF input must still classify");

  // 5 — a REAL git rename: `--no-renames` must list both halves, so moving a route out of app/ builds.
  const repo = mkdtempSync(join(tmpdir(), "phx-buildrisk-"));
  try {
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
      assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout;
    };
    git("init", "-q");
    mkdirSync(join(repo, "app", "reports"), { recursive: true });
    writeFileSync(join(repo, "app", "reports", "page.tsx"), "export default function Page() { return null; }\n".repeat(10));
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    mkdirSync(join(repo, "docs"), { recursive: true });
    git("mv", "app/reports/page.tsx", "docs/page.tsx");
    git("commit", "-q", "-m", "move");
    const listed = git("diff", "--name-only", "--no-renames", "HEAD^1", "HEAD");
    assert.match(listed, /^app\/reports\/page\.tsx$/m, "--no-renames must list a rename's OLD path");
    assert.match(listed, /^docs\/page\.tsx$/m, "--no-renames must list a rename's NEW path");
    assert.equal(cli(listed).stdout.trim(), "build=true", "moving a route out of app/ deletes it, so it must build");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

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
  // 🔴 THE BUILD STAYS TWO PROCESSES (23 Oct 2026). One `next build` ran the 7.9 GB runner out of
  // memory at "Collecting page data" (exit 137, the kernel's kill, read only as "The operation was
  // canceled"); compile-then-generate hands the compiler's ~6.5 GB back before page data starts.
  const build = step(yml, "Build");
  assert.match(
    build,
    /pnpm exec next build --experimental-build-mode compile\n {10}pnpm exec next build --experimental-build-mode generate\n/,
    "the CI build must compile and generate in two processes, compile first — one process OOMs the runner",
  );
  assert.doesNotMatch(build, /pnpm run build/, "a one-process `pnpm run build` here brings the out-of-memory kill back");
  assert.ok(
    build.indexOf("swapon") > -1 && build.indexOf("swapon") < build.indexOf("--experimental-build-mode compile"),
    "the extra swap must be switched on before the compile, the half that still peaks near the runner's RAM",
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
  // green with the Build skipped, so a run whose Build step was skipped answers NO VERDICT for `build`.
  const skippedBuild = [
    {
      name: "validate",
      status: "completed",
      conclusion: "success",
      steps: [
        { name: "Set up job", conclusion: "success" },
        { name: "Build", conclusion: "skipped" },
      ],
    },
  ];
  const graded = gradeActionsStages(["build"], skippedBuild);
  assert.equal(graded.verdict, "no-verdict", "a green PR validate whose Build was skipped is not a build PASS");
  assert.deepEqual(graded.stages, {}, "and it must not be recorded as a build verdict either");
}
