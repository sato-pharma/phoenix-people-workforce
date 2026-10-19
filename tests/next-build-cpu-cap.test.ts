import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

/**
 * The page-data worker cap: inert everywhere except a self-hosted runner.
 *
 * WHY IT EXISTS. `next build` sizes its page-data worker pool from the CPUs it can SEE, which inside
 * a container is the HOST's count rather than the container's allowance. On the self-hosted Railway
 * runner that read 47, spawned 47 tokio workers against a far lower pid/thread limit, and aborted
 * AFTER the compile had already succeeded:
 *
 *     ✓ Compiled successfully in 40s
 *     Collecting page data using 47 workers ...
 *     OS can't spawn worker thread: Resource temporarily unavailable (os error 11)
 *
 * Measured 2026-09-27 on jobs 108695670880 and 108696483287 — two different runners, same abort, so
 * it is the environment and not one bad replica.
 *
 * 🔴 WHAT THIS TEST IS REALLY PROTECTING: that a GitHub-hosted build is UNCHANGED. The cap must never
 * apply on GitHub's 4-core runners, where limiting workers would slow every build in the repo to buy
 * nothing. Two independent things have to hold for that, and both are easy to break by accident —
 * the config must leave `experimental.cpus` ABSENT when the variable is unset, and the workflow must
 * not pass it at all. Since 2026-10-19 CI is GitHub-hosted only and the self-hosted runner this cap
 * served is retired, so ci.yml sets no `PHX_BUILD_CPUS`; a future edit that adds a plain
 * `PHX_BUILD_CPUS: 4` would quietly cap every hosted build, which is why it is asserted by name.
 *
 * 🔴 AND WHY NO ENV VAR CAN DO THIS JOB DIRECTLY: read from the installed next@16.3.3,
 * `dist/build/index.js:371` decides the worker count from `config.experimental.cpus` alone. A
 * container variable — `NEXT_CPUS` was tried — is ignored however it is spelled, and the build log
 * still reported 47 workers. The option is the only knob, so the config is the only place this can
 * live.
 *
 * The predicate is LIFTED OUT OF `next.config.ts` AND EXECUTED rather than pattern-matched: the file
 * cannot be imported (it uses `__dirname`, so it is not loadable as an ES module), and a test that
 * re-implemented the condition would pass against a config whose guard had been inverted.
 */
const CONFIG = "next.config.ts";
const WORKFLOW = ".github/workflows/ci.yml";

/** Pulls the real spread out of the config and runs it against a controlled `process.env`. */
function capFor(source: string, value: string | undefined): Record<string, unknown> {
  const match = /\.\.\.\(Number\(process\.env\.PHX_BUILD_CPUS\)[\s\S]*?:\s*\{\}\)/.exec(source);
  assert.ok(
    match,
    `${CONFIG} no longer carries the \`...(Number(process.env.PHX_BUILD_CPUS) > 0 ? … : {})\` spread this test ` +
      "executes. Either the worker cap was removed — which returns the self-hosted build to aborting on " +
      "`OS can't spawn worker thread` — or it was rewritten in a form this test can no longer verify. Do not " +
      "delete this test to make it pass.",
  );
  const expr = match[0].replace(/process\.env/g, "env");
  const build = new Function("env", `return { ${expr} };`) as (env: Record<string, string | undefined>) => Record<string, unknown>;
  return build({ PHX_BUILD_CPUS: value });
}

export function runNextBuildCpuCapTests() {
  const config = readFileSync(CONFIG, "utf8");
  const workflow = readFileSync(WORKFLOW, "utf8");

  // ── the config's own predicate, executed ─────────────────────────────────────────────────────
  for (const [label, value] of [
    ["unset", undefined],
    ["empty", ""],
    ["zero", "0"],
    ["non-numeric", "abc"],
    ["negative", "-2"],
  ] as const) {
    const result = capFor(config, value);
    assert.deepEqual(
      result,
      {},
      `with PHX_BUILD_CPUS ${label}, the config must leave \`experimental.cpus\` ABSENT — every GitHub-hosted ` +
        "run, every local build and production take this path, and a cap of 0 or NaN reaching Next would be far " +
        `worse than no cap at all. It produced: ${JSON.stringify(result)}`,
    );
  }
  assert.deepEqual(
    capFor(config, "4"),
    { cpus: 4 },
    "with PHX_BUILD_CPUS=4 the config must cap the pool at 4 workers as a NUMBER — Next compares " +
      "`config.experimental.cpus` against its default, and the string \"4\" is not that number",
  );

  // ── the workflow half: NO job passes the cap any more ────────────────────────────────────────
  // The cap existed for the self-hosted Railway replica that aborted with `os error 11`. CI is
  // GitHub-hosted only since 2026-10-19 (tests/ci-runner-switch.test.ts), so the workflow has nothing
  // to cap, and a value that reached a hosted build would slow every build in the repo for nothing.
  // The config's spread above stays: it is inert without the variable, and it is the one place the cap
  // can live if a constrained runner ever returns.
  assert.doesNotMatch(
    workflow
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n"),
    /PHX_BUILD_CPUS/,
    `${WORKFLOW} sets PHX_BUILD_CPUS again. CI runs on GitHub-hosted runners only, where capping the ` +
      "page-data worker pool slows every build and buys nothing; the cap was for the retired self-hosted container.",
  );

  // ── the dead knob must not come back as if it worked ─────────────────────────────────────────
  for (const [file, source] of [[CONFIG, config], [WORKFLOW, workflow]] as const) {
    const lines = source.split("\n").filter((line) => /NEXT_CPUS/.test(line) && !/^\s*(#|\/\/|\*)/.test(line.trim()) === true);
    const live = lines.filter((line) => !/^\s*(#|\/\/|\*)/.test(line));
    assert.deepEqual(
      live,
      [],
      `${file} must not set NEXT_CPUS as if it capped anything. next@16.3.3 reads the worker count from ` +
        "`config.experimental.cpus` only (dist/build/index.js:371), so that variable was set once, changed " +
        `nothing, and the log still said 47 workers. Found: ${JSON.stringify(live)}`,
    );
  }

  // ── CI must start the artifact PRODUCTION runs, not a mode that ships nowhere ────────────────────
  //
  // 🔴 `output: "standalone"` is unconditional and the Dockerfile runs `node server.js`
  // (Dockerfile:173). CI used to run `pnpm run start`, i.e. `next start`, which Next warns does not
  // work with that output — so the smoke test exercised a mode production never uses AND the real
  // artifact went untested. Measured 2026-09-27 on the self-hosted runner: identical output up to the
  // warning, then nothing for the full 120s timeout — no bind, no error, no server — while a hosted
  // runner satisfied the poll 0.62s after the same warning.
  //
  // 🔴 AND THE EARLIER READING OF THAT TIMEOUT AS AN IPv6 PROBLEM WAS WRONG. Moving the poll to
  // 127.0.0.1 changed nothing, because nothing was listening on ANY address. The address is still the
  // right spelling and is still asserted below, but it is not what fixed this — do not let the two
  // assertions imply otherwise.
  const playwrightConfig = readFileSync("playwright.config.ts", "utf8");
  const webServer = /webServer:\s*\{([\s\S]*?)\n\s{2}\},/.exec(playwrightConfig);
  assert.ok(webServer, "playwright.config.ts no longer has a `webServer: { … }` block this test can read");
  assert.match(
    webServer[1],
    /url:\s*"http:\/\/127\.0\.0\.1:3000\//,
    "playwright.config.ts's webServer readiness URL must use 127.0.0.1, never `localhost`: in a container " +
      "`localhost` can resolve to ::1 first, and the server is bound to 127.0.0.1 by HOSTNAME below, so the " +
      "two must not be able to disagree. On GitHub's runners they are identical, so this costs nothing there.",
  );
  assert.match(
    webServer[1],
    /command:\s*process\.env\.CI\s*\?\s*"node server\.js"/,
    "in CI the webServer must run `node server.js` — the artifact the Dockerfile ships (`CMD [\"node\", " +
      '"server.js"]`). `next start` is the mode Next warns does not work with `output: "standalone"`, it ' +
      "produced no server at all on the self-hosted runner, and using it means the smoke test never exercises " +
      "what production actually runs.",
  );
  assert.match(
    webServer[1],
    /cwd:\s*process\.env\.CI\s*\?\s*"\.next\/standalone"/,
    "the CI webServer must run from `.next/standalone` — that is where Next emits `server.js`, and the " +
      "Dockerfile copies that folder to the image root before running it",
  );
  assert.match(
    webServer[1],
    /HOSTNAME:\s*"127\.0\.0\.1"/,
    "the CI webServer must bind HOSTNAME=127.0.0.1 so the server and the readiness poll cannot resolve to " +
      "different addresses — the standalone server reads HOSTNAME and PORT, exactly as Dockerfile:169-171 sets them",
  );
  // 🔴 THE ONE ASSERTION THAT COVERS THE ACTUAL 2026-09-27 FAILURE. A self-hosted runner inherits its
  // Railway service's whole environment, including `PORT=8080`. Both `next start` and the standalone
  // server bind `process.env.PORT` and fall back to 3000 only when it is UNSET — true on GitHub's
  // runners, false in the container. Measured from inside it: `printenv PORT` -> 8080, and `next start`
  // -> "Local: http://localhost:8080  ✓ Ready in 93ms" while the poll watched 3000 for 120s. Inheriting
  // the port is the bug; pinning it is the fix.
  // Deliberately NOT a literal "3000" here: that would make the agreement check below unreachable,
  // since any wrong port would fail this assertion first. Pinned-at-all and pinned-to-the-same-number
  // are two different mistakes, so they get two assertions that can each actually fire.
  const pinnedPort = /PORT:\s*"(\d+)"/.exec(webServer[1]);
  assert.ok(
    pinnedPort,
    "the CI webServer must PIN a PORT rather than inherit one. A self-hosted runner inherits its Railway " +
      "service's environment, where PORT=8080, and the server then comes up healthily on a port nothing is " +
      "watching — no error, no clue, just the full readiness timeout. This single line is what fixed the " +
      "2026-09-27 smoke-test failure; neither the IPv6 spelling nor the standalone command did.",
  );
  const urlPort = /url:\s*"http:\/\/127\.0\.0\.1:(\d+)\//.exec(webServer[1]);
  assert.ok(urlPort, "playwright.config.ts's readiness URL must name the port it polls");
  assert.equal(
    pinnedPort[1],
    urlPort[1],
    "the PORT the CI webServer binds and the port its readiness URL polls must be the SAME number. Them " +
      "disagreeing IS the 2026-09-27 failure, and it is silent: the server is healthy, the poll times out, and " +
      `nothing in the log names either port. Found server ${pinnedPort[1]} vs poll ${urlPort[1]}.`,
  );
  const assemble = /- name: Assemble the standalone runtime[\s\S]*?\n\n/.exec(workflow);
  assert.ok(
    assemble,
    `${WORKFLOW} must assemble the standalone runtime before the smoke test. Next does NOT emit \`public\` or ` +
      "`.next/static` into `.next/standalone`, so without those copies the server starts and serves a page with " +
      "no CSS and no client bundle — a failure that looks like a broken app rather than a missing copy.",
  );
  for (const [needle, why] of [
    ["cp -r public .next/standalone/public", "mirrors Dockerfile:113"],
    ["cp -r .next/static .next/standalone/.next/static", "mirrors Dockerfile:122"],
    ["test -f .next/standalone/server.js", "fails loudly if the build stopped emitting the standalone output, rather than timing out later"],
  ] as const) {
    assert.ok(
      assemble[0].includes(needle),
      `${WORKFLOW}'s standalone assembly step must run \`${needle}\` (${why})`,
    );
  }
  const smokeStep = /- name: Run Playwright login smoke test\n([\s\S]*?)\n\n/.exec(workflow);
  assert.ok(smokeStep, `${WORKFLOW} no longer has a "Run Playwright login smoke test" step this test can read`);
  assert.match(
    smokeStep[1],
    /PLAYWRIGHT_BASE_URL:\s*http:\/\/127\.0\.0\.1:3000/,
    `${WORKFLOW}'s smoke step must set PLAYWRIGHT_BASE_URL to 127.0.0.1. tests/e2e/auth.setup.ts falls back ` +
      "to `localhost` when it is unset, so without it the readiness poll succeeds on 127.0.0.1 and the test's " +
      "very next navigation goes back to resolving `localhost` — the same failure, one request later.",
  );
}
