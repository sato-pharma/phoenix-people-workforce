// The dev server's heap cap: 4,096 MB by default, with the caller's own choice always winning.
//
// WHY THIS EXISTS. Next 16 gives the server it forks (start-server.js, the process that grows) a
// heap limit of HALF THE MACHINE'S RAM whenever NODE_OPTIONS carries no --max-old-space-size, and
// restarts that server by itself only once 80% of the limit is in use. Measured 2026-09-21 on this
// 16 GB machine: a raw `next dev` child got 8,278 MB, so Next's own restart waited for 6.6 GB of
// heap, and the memory watchdog stopped one at 8.14 GB that morning. scripts/dev-server.mjs now puts
// --max-old-space-size=4096 in the child's NODE_OPTIONS (measured limit 4,288 MB), so Next restarts
// it in place near 3.4 GB instead.
//
// Three layers, because each one alone can pass while the cap does nothing:
//   1. the decision (resolveHeapCap) — what goes into NODE_OPTIONS for every combination of the
//      caller's NODE_OPTIONS and PHOENIX_DEV_HEAP_MB;
//   2. the launcher itself, run for real against a stand-in `next` that reports what it was handed —
//      a correct decision that never reaches the child's environment caps nothing;
//   3. the installed Next — the cap works only because Next keeps a max-old-space-size it finds in
//      NODE_OPTIONS and restarts the server at 80% of the limit. If an upgrade drops either, this
//      goes red instead of the cap silently doing nothing.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DEFAULT_HEAP_CAP_MB, MIN_HEAP_CAP_MB, resolveHeapCap } from "../scripts/dev-server-heap-cap.mjs";

function testTheDecision() {
  assert.equal(DEFAULT_HEAP_CAP_MB, 4096, "the default cap is 4,096 MB — 3,072 made the heaviest compiles 3-4x slower on 2026-09-09");
  assert.equal(MIN_HEAP_CAP_MB, 2048, "a cap below 2,048 MB cannot hold a cold compile of a heavy page (1,508 MB of heap measured)");

  const plain = resolveHeapCap({});
  assert.equal(plain.nodeOptions, "--max-old-space-size=4096", "with nothing set, the child gets the 4,096 MB cap");
  assert.equal(plain.note, "heap cap 4096 MB");
  assert.equal(plain.warning, null);

  assert.equal(
    resolveHeapCap({ NODE_OPTIONS: "--require=./probe.cjs" }).nodeOptions,
    "--require=./probe.cjs --max-old-space-size=4096",
    "the caller's other NODE_OPTIONS are kept, and the cap is added beside them",
  );

  for (const spelling of ["--max-old-space-size=6144", "--max_old_space_size=6144"]) {
    const caller = resolveHeapCap({ NODE_OPTIONS: spelling, PHOENIX_DEV_HEAP_MB: "3072" });
    assert.equal(caller.nodeOptions, spelling, `a cap already in NODE_OPTIONS (${spelling}) is the caller's choice and wins`);
    assert.equal(caller.note, "heap cap from the caller's NODE_OPTIONS");
  }

  assert.equal(resolveHeapCap({ PHOENIX_DEV_HEAP_MB: "3072" }).nodeOptions, "--max-old-space-size=3072");
  assert.equal(resolveHeapCap({ PHOENIX_DEV_HEAP_MB: " 3072 " }).note, "heap cap 3072 MB", "surrounding spaces are not an error");

  for (const off of ["0", "off", "OFF"]) {
    const none = resolveHeapCap({ PHOENIX_DEV_HEAP_MB: off });
    assert.equal(none.nodeOptions, "", `PHOENIX_DEV_HEAP_MB=${off} hands the choice back to Next`);
    assert.match(none.note, /no heap cap/);
  }
  assert.equal(
    resolveHeapCap({ PHOENIX_DEV_HEAP_MB: "0", NODE_OPTIONS: "--require=./probe.cjs" }).nodeOptions,
    "--require=./probe.cjs",
    "turning the cap off never drops the caller's other options",
  );

  for (const bad of ["abc", "512", "2047", "4096.5", "-1", "4g"]) {
    const fallback = resolveHeapCap({ PHOENIX_DEV_HEAP_MB: bad });
    assert.equal(fallback.nodeOptions, "--max-old-space-size=4096", `PHOENIX_DEV_HEAP_MB=${bad} falls back to the default`);
    assert.ok(fallback.warning?.includes(`PHOENIX_DEV_HEAP_MB=${bad} ignored`), `a bad value is named, never silently dropped: ${bad}`);
  }
}

/**
 * The real launcher, copied beside a stand-in for Next's CLI. The launcher resolves Next from its
 * own folder (`<root>/node_modules/next/dist/bin/next`), so this runs the shipped code path and
 * starts nothing but a script that prints what it was given.
 */
function makeLauncherSandbox(): { root: string; launcher: string } {
  const root = mkdtempSync(join(tmpdir(), "phx-dev-heap-cap-"));
  mkdirSync(join(root, "scripts"));
  for (const file of ["dev-server.mjs", "dev-server-heap-cap.mjs", "dev-server-exit-reason.mjs"]) {
    copyFileSync(resolve("scripts", file), join(root, "scripts", file));
  }
  const bin = join(root, "node_modules", "next", "dist", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "next"),
    "process.stdout.write(JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS ?? null, argv: process.argv.slice(2) }) + '\\n');\n",
  );
  return { root, launcher: join(root, "scripts", "dev-server.mjs") };
}

/** The launcher binds loopback by default since 2026-10-26 (tests/dev-preview-loopback-gate.test.ts). */
const LOOPBACK = ["-H", "127.0.0.1"];

type Launched = { nodeOptions: string | null; argv: string[]; line: string; stderr: string };

function launch(launcher: string, args: string[], extraEnv: Record<string, string> = {}): Launched {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // CI sets its own NODE_OPTIONS heap flag; inherited here it would win (by design) and every
  // default-case assertion below would be testing the caller-wins branch instead.
  for (const key of ["NODE_OPTIONS", "PHOENIX_DEV_HEAP_MB", "PHOENIX_DEV_BUNDLER", "NEXT_DISABLE_MEM_OVERRIDE", "PHOENIX_DEV_BIND_ALL"]) delete env[key];
  // Skips the machine-wide scan for a running dev server: it would refuse on a laptop that has one.
  env.PHOENIX_ALLOW_MULTIPLE_DEV_SERVERS = "1";
  Object.assign(env, extraEnv);

  const run = spawnSync(process.execPath, [launcher, ...args], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(run.status, 0, `the launcher must hand over to Next and exit cleanly.\n${run.stdout}\n${run.stderr}`);
  const lines = run.stdout.split(/\r?\n/);
  const report = lines.find((line) => line.startsWith('{"nodeOptions"'));
  assert.ok(report, `the stand-in for Next never ran.\n${run.stdout}\n${run.stderr}`);
  return {
    ...(JSON.parse(report) as { nodeOptions: string | null; argv: string[] }),
    line: lines.find((line) => line.startsWith("[dev-server]")) ?? "",
    stderr: run.stderr,
  };
}

function testTheLauncher() {
  const { root, launcher } = makeLauncherSandbox();
  try {
    const plain = launch(launcher, ["--webpack", "--port", "3999"]);
    assert.equal(plain.nodeOptions, "--max-old-space-size=4096", "Next's process must receive the cap in its own environment");
    assert.deepEqual(plain.argv, ["dev", "--webpack", "--port", "3999", "-H", "127.0.0.1"], "the bundler flag reaches Next once, never twice");
    assert.match(plain.line, /heap cap 4096 MB/, "the launcher says which cap it applied");

    assert.equal(launch(launcher, [], { PHOENIX_DEV_HEAP_MB: "3072" }).nodeOptions, "--max-old-space-size=3072");
    assert.equal(
      launch(launcher, [], { NODE_OPTIONS: "--max-old-space-size=6144" }).nodeOptions,
      "--max-old-space-size=6144",
      "a cap the caller already set reaches Next untouched",
    );

    const off = launch(launcher, [], { PHOENIX_DEV_HEAP_MB: "0" });
    assert.equal(off.nodeOptions, null, "with the cap off Next sees no NODE_OPTIONS at all, and picks half of RAM itself");
    assert.match(off.line, /no heap cap/);

    const bad = launch(launcher, [], { PHOENIX_DEV_HEAP_MB: "abc" });
    assert.equal(bad.nodeOptions, "--max-old-space-size=4096");
    assert.match(bad.stderr, /PHOENIX_DEV_HEAP_MB=abc ignored/, "a bad override is reported where the person starting the server sees it");

    // `dev:turbopack` is the launcher plus --turbopack: the caller's flag beats the variable.
    assert.deepEqual(launch(launcher, ["--turbopack"], { PHOENIX_DEV_BUNDLER: "webpack" }).argv, ["dev", "--turbopack", ...LOOPBACK]);
    assert.deepEqual(launch(launcher, [], { PHOENIX_DEV_BUNDLER: "webpack" }).argv, ["dev", "--webpack", ...LOOPBACK]);

    // 🔴 WEBPACK ON EVERY PLATFORM (2026-10-13). On turbopack the Hetzner box answered /api/healthz
    // once while cold and then nothing at all — not the page shipped that morning, not a months-old
    // admin page, not a plain API route. Three servers in a row, 400 s / 420 s / 560 s, every one 000.
    assert.deepEqual(
      launch(launcher, []).argv,
      ["dev", "--webpack", ...LOOPBACK],
      "the default is webpack everywhere: the box has two dev servers and only one of them sets an env var of its own",
    );
    // 🔴 AND THE ASSERTION ABOVE IS VACUOUS ON WINDOWS, where the default has always been webpack —
    // write `isWindows ? "webpack" : "turbopack"` back and it still passes on this laptop, leaving
    // only CI's Linux to catch it. So the decision line itself is read, which fires on any platform.
    assert.match(
      readFileSync(resolve("scripts/dev-server.mjs"), "utf8"),
      /\n {2}bundler = "webpack";\n/,
      "the bundler default must be webpack outright: a platform ternary here sends the box back to turbopack, where it serves nothing",
    );
    // Both escape hatches survive it — the flag and the variable still reach turbopack on purpose.
    assert.deepEqual(launch(launcher, ["--turbopack"]).argv, ["dev", "--turbopack", ...LOOPBACK]);
    assert.deepEqual(launch(launcher, [], { PHOENIX_DEV_BUNDLER: "turbopack" }).argv, ["dev", "--turbopack", ...LOOPBACK]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testTheInstalledNext() {
  const requireFromRepo = createRequire(resolve("package.json"));
  const utils = requireFromRepo("next/dist/server/lib/utils.js") as {
    getMaxOldSpaceSize: () => number | undefined;
    getMemoryRestartStats: (isDev: boolean, restart: boolean, stats: () => object) => object | undefined;
  };

  // next-dev.js adds its own half-of-RAM limit only when this returns nothing.
  const saved = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = resolveHeapCap({}).nodeOptions;
    assert.equal(utils.getMaxOldSpaceSize(), 4096, "Next must read the launcher's cap as already set, or it substitutes half of RAM");
    process.env.NODE_OPTIONS = resolveHeapCap({ NODE_OPTIONS: "--require=./probe.cjs" }).nodeOptions;
    assert.equal(utils.getMaxOldSpaceSize(), 4096, "…including when other options sit beside it");
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }

  // The in-place restart that turns the cap into a ceiling rather than a crash.
  const limit = 4288 * 1048576;
  const at = (share: number) => () => ({ used_heap_size: share * limit, heap_size_limit: limit });
  assert.ok(utils.getMemoryRestartStats(true, true, at(0.81)), "Next restarts the dev server once 80% of the heap limit is in use");
  assert.equal(utils.getMemoryRestartStats(true, true, at(0.79)), undefined, "…and not before");

  const nextConfig = readFileSync(resolve("next.config.ts"), "utf8");
  assert.doesNotMatch(
    nextConfig,
    /devMemoryThresholdRestart\s*:\s*false/,
    "turning off Next's memory restart would make the cap end the server with an out-of-memory crash instead",
  );
}

/** Every path that starts a dev server goes through the launcher; the files sessions copy from say so. */
function testEveryStartPathUsesTheLauncher() {
  const scripts = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  const devScripts = Object.entries(scripts).filter(([name]) => /^dev(:|$)/.test(name));
  assert.ok(devScripts.length >= 4, "dev, dev:webpack, dev:turbopack and dev:no-turbopack are all expected");
  for (const [name, body] of devScripts) {
    assert.ok(body.startsWith("node scripts/dev-server.mjs"), `package.json "${name}" must start the launcher, not Next: ${body}`);
  }

  const supervisor = readFileSync(resolve("scripts/dev-supervisor.ps1"), "utf8");
  const startLine = supervisor.split(/\r?\n/).find((line) => /^\s*\$cmd\s*=/.test(line)) ?? "";
  assert.match(startLine, /node scripts\\dev-server\.mjs/, `the dev supervisor must restart the server through the launcher: ${startLine}`);

  for (const file of ["AGENTS.md", ".claude/launch.json", "docs/agents-session-traps-clusters.md"]) {
    const text = readFileSync(resolve(file), "utf8");
    assert.ok(
      !text.includes("node node_modules/next/dist/bin/next dev"),
      `${file} tells sessions to start a raw \`next dev\`, which skips the cap and which bash-guard C7 refuses`,
    );
  }
  assert.ok(readFileSync(resolve("AGENTS.md"), "utf8").includes("node scripts/dev-server.mjs --port 3000"), "AGENTS.md §5 names the launcher");
}

export function runDevServerHeapCapTests() {
  testTheDecision();
  testTheLauncher();
  testTheInstalledNext();
  testEveryStartPathUsesTheLauncher();
}
