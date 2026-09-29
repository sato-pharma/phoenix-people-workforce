// The Build and the Playwright login smoke must run on `main`, a dispatch and a schedule — and NOT
// on a pull request.
//
// WHY THIS EXISTS. Measured 2026-09-29 on run 36610968349: `validate` took 295s of which the Build
// alone was 200s (68%), and the Build's only consumer is a 37s login smoke test. GitHub rounds every
// JOB up to a whole minute, so validate billed 5 minutes per run against `checks`'s 6, on 185
// pull_request runs that day. Dropping the build from the PR takes validate to ~90s — about 555
// billable minutes a day, a fifth of the bill — and every PR finishes ~3.5 minutes EARLIER.
//
// The owner asked for cost cuts that do not slow the work down, and chose this one on that basis.
// The alternatives all cost speed: a merge cooldown (built, and he cut it the same evening), or
// folding `validate` into `checks` (they run in parallel, so merging doubles the wait).
//
// 🔴 WHAT A FUTURE READER WILL WANT TO "FIX", AND MUST NOT. Seeing a PR go green without ever
// building looks like a gap, and restoring the build on pull_request closes it — at the cost of the
// whole saving and 3.5 minutes on every PR. PRODUCTION IS NOT THE THING AT RISK: a red `main` fails
// its check suite and Railway's Wait for CI then withholds the deploy, so nothing ships unverified.
// What moved is WHEN a break is discovered, which the owner accepted knowingly. If it ever proves
// too expensive the middle setting is to build only on PRs touching `app/`, `src/` or
// `next.config.ts` — not a return to building on every PR.
//
// And do NOT reach for a `.next` cache instead: tried 2026-08-29, measured from both directions,
// 37KB cache, 148s warm against 143s cold. ci.yml records that evidence at the deleted cache step.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const WORKFLOW = ".github/workflows/ci.yml";

/** The steps whose cost this change removes from a pull request. */
const HEAVY_STEPS = [
  "Build",
  "Verify @napi-rs/canvas is reachable inside .next/standalone",
  "Assemble the standalone runtime (mirrors the Dockerfile)",
  "Cache Playwright browsers",
  "Install Playwright browsers",
  "Install Playwright system dependencies",
  "Run Playwright login smoke test",
  "Ingest synthetic-journey report (best-effort, never fails CI)",
  "Upload Playwright report on failure",
];

export function runCiPrSkipsBuildAndSmokeTests(): void {
  const yml = readFileSync(WORKFLOW, "utf8");

  // 1. Every heavy step is gated on `heavy`, and none of them is still on `docs_only` alone.
  for (const name of HEAVY_STEPS) {
    const at = yml.indexOf(`      - name: ${name}\n`);
    assert.ok(at >= 0, `${WORKFLOW} no longer has a step named "${name}" — if it was renamed, this ` +
      `test must be updated with it, because an unlisted step is one nobody is checking the gate on`);
    const condition = yml.slice(at, yml.indexOf("\n", yml.indexOf("if:", at)));
    assert.match(
      condition,
      /steps\.detect\.outputs\.heavy == 'true'/,
      `"${name}" is no longer gated on \`heavy\`, so it runs on PULL REQUESTS again. That restores ` +
        `~3 billable minutes to each of ~185 PR runs a day (~555 minutes, about a fifth of the ` +
        `Actions bill) and adds ~3.5 minutes to every PR. The owner chose this on 2026-09-29 ` +
        `precisely because it cuts cost WITHOUT slowing the work. Production is not at risk either ` +
        `way: a red main withholds the deploy.`,
    );
  }

  // 2. `heavy` is computed once, from the event — not repeated as a compound `if:` that can drift.
  const answer = yml.slice(yml.indexOf("          answer() {"));
  assert.match(
    answer.slice(0, 600),
    /EVENT_NAME" != "pull_request"/,
    "the `heavy` output no longer excludes pull_request — the gate exists, but it now lets the " +
      "build run on PRs anyway, which is the same regression with none of the visible signs",
  );
  assert.match(
    answer.slice(0, 600),
    /heavy=\$heavy" >> "\$GITHUB_OUTPUT"/,
    "`heavy` is no longer emitted as a step output, so every step gated on it evaluates to the " +
      "empty string and the build silently stops running ANYWHERE — including on main, where it " +
      "is the only thing standing between a broken login and a deploy",
  );

  // 3. The main path is untouched: push to main must still trigger the workflow at all.
  const onBlock = yml.slice(yml.indexOf("\non:"), yml.indexOf("\njobs:"));
  assert.match(
    onBlock,
    /push:\s*\n\s*branches:\s*\n\s*- main/,
    "`push: main` is gone. That is the production deploy gate: Railway's Wait for CI waits on the " +
      "check suites attached to the pushed commit, so removing it ships every merge unverified, " +
      "silently. It is also now the ONLY place the build runs at all.",
  );
}
