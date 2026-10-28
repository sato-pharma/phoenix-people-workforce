// `pnpm run dev:lean` — the dev server set up the way it was measured to fit on a 16 GB laptop.
//
// WHY THIS EXISTS. Measured 2026-10-29, /admin from cold on the owner's machine: the launcher's
// defaults peaked at 4,862 MB private and took free RAM down to 64 MB; with the server compilers'
// source maps off, webpack's cache kept in memory only and a 2,560 MB heap, the peak was 2.8-3.4 GB.
// The switches are read in two places — scripts/dev-server-lean.mjs decides them, next.config.ts's
// `webpack` hook acts on them — so three layers, because each one alone can pass while the lean
// mode does nothing:
//   1. the decision (resolveLeanMode) — `--lean` turns both switches and the heap on, a value the
//      caller already set wins, and without it nothing changes;
//   2. the launcher itself, run for real against a stand-in `next` that reports what it was handed —
//      Next must never see `--lean` (it refuses an unknown flag) and must see the switches;
//   3. next.config.ts's hook, called with a plugin built from the INSTALLED Next's own source-map
//      class — the filter matches by class name, so a Next upgrade that renames it goes red here
//      instead of the switch silently removing nothing. And the hook never touches `next build`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { LEAN_FLAG, LEAN_HEAP_CAP_MB, resolveLeanMode } from "../scripts/dev-server-lean.mjs";

const SWITCHES = ["PHOENIX_DEV_LEAN", "PHOENIX_DEV_LEAN_SERVER_MAPS", "PHOENIX_DEV_NO_DISK_CACHE", "PHOENIX_DEV_HEAP_MB"] as const;

function testTheDecision() {
  assert.equal(LEAN_FLAG, "--lean");
  assert.equal(LEAN_HEAP_CAP_MB, 2560, "the measured runs used a 2,560 MB heap and peaked at 1.6 GB of it");

  const plain = resolveLeanMode(["--port", "3000"], { PATH: "x" });
  assert.equal(plain.lean, false, "without --lean the launcher behaves exactly as before");
  assert.deepEqual(plain.passthrough, ["--port", "3000"]);
  assert.deepEqual(plain.env, { PATH: "x" }, "…and adds nothing to the environment");
  assert.equal(plain.note, null);

  const lean = resolveLeanMode(["--lean", "--port", "3000"], {});
  assert.equal(lean.lean, true);
  assert.deepEqual(lean.passthrough, ["--port", "3000"], "--lean is the launcher's own flag and never reaches Next, which would refuse it");
  assert.equal(lean.env.PHOENIX_DEV_LEAN_SERVER_MAPS, "1", "--lean turns the server source maps off");
  assert.equal(lean.env.PHOENIX_DEV_NO_DISK_CACHE, "1", "--lean keeps webpack's cache in memory only");
  assert.equal(lean.env.PHOENIX_DEV_HEAP_MB, "2560", "--lean caps the heap at the measured 2,560 MB");
  assert.equal(lean.note, "lean: server source maps off, no disk cache");

  assert.equal(resolveLeanMode([], { PHOENIX_DEV_LEAN: "1" }).lean, true, "PHOENIX_DEV_LEAN=1 is the same as --lean");
  assert.equal(resolveLeanMode([], { PHOENIX_DEV_LEAN: "true" }).lean, false, "only the exact value 1 turns it on");

  const caller = resolveLeanMode(["--lean"], { PHOENIX_DEV_NO_DISK_CACHE: "0", PHOENIX_DEV_HEAP_MB: "3072" });
  assert.equal(caller.env.PHOENIX_DEV_NO_DISK_CACHE, "0", "a switch the caller set, even to 0, is the caller's choice");
  assert.equal(caller.env.PHOENIX_DEV_LEAN_SERVER_MAPS, "1", "…and the other one is still turned on");
  assert.equal(caller.env.PHOENIX_DEV_HEAP_MB, "3072", "a heap the caller chose wins over the lean one");
  assert.equal(caller.note, "lean: server source maps off");

  const input = { PHOENIX_DEV_LEAN: "1" } as Record<string, string | undefined>;
  resolveLeanMode([], input);
  assert.deepEqual(input, { PHOENIX_DEV_LEAN: "1" }, "the caller's own environment object is never written to");
}

/** The real launcher beside a stand-in `next` that prints what it was handed — as in tests/dev-server-heap-cap.test.ts. */
function testTheLauncher() {
  const root = mkdtempSync(join(tmpdir(), "phx-dev-lean-"));
  try {
    mkdirSync(join(root, "scripts"));
    for (const file of ["dev-server.mjs", "dev-server-heap-cap.mjs", "dev-server-exit-reason.mjs", "dev-server-lean.mjs"]) {
      copyFileSync(resolve("scripts", file), join(root, "scripts", file));
    }
    const bin = join(root, "node_modules", "next", "dist", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "next"),
      "const e = process.env;\n" +
        "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), nodeOptions: e.NODE_OPTIONS ?? null, maps: e.PHOENIX_DEV_LEAN_SERVER_MAPS ?? null, cache: e.PHOENIX_DEV_NO_DISK_CACHE ?? null }) + '\\n');\n",
    );
    const launcher = join(root, "scripts", "dev-server.mjs");

    const launch = (args: string[], extraEnv: Record<string, string> = {}) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PHOENIX_ALLOW_MULTIPLE_DEV_SERVERS: "1" };
      for (const key of ["NODE_OPTIONS", "PHOENIX_DEV_BIND_ALL", "PHOENIX_DEV_BUNDLER", ...SWITCHES]) delete env[key];
      Object.assign(env, extraEnv);
      const run = spawnSync(process.execPath, [launcher, ...args], { env, encoding: "utf8", timeout: 30000 });
      assert.equal(run.status, 0, `the launcher must hand over to Next.\n${run.stdout}\n${run.stderr}`);
      const lines = run.stdout.split(/\r?\n/);
      const report = lines.find((line) => line.startsWith('{"argv"'));
      assert.ok(report, `the stand-in for Next never ran.\n${run.stdout}\n${run.stderr}`);
      return {
        ...(JSON.parse(report) as { argv: string[]; nodeOptions: string | null; maps: string | null; cache: string | null }),
        line: lines.find((line) => line.startsWith("[dev-server]")) ?? "",
      };
    };

    const lean = launch(["--lean", "--port", "3999"]);
    assert.deepEqual(lean.argv, ["dev", "--webpack", "--port", "3999", "-H", "127.0.0.1"], "Next never receives --lean");
    assert.equal(lean.maps, "1", "Next's process must receive the source-map switch in its own environment");
    assert.equal(lean.cache, "1", "…and the disk-cache switch");
    assert.equal(lean.nodeOptions, "--max-old-space-size=2560", "…and the 2,560 MB heap");
    assert.match(lean.line, /heap cap 2560 MB/);
    assert.match(lean.line, /lean: server source maps off, no disk cache/, "the launcher says it is running lean");

    const byVariable = launch(["--port", "3999"], { PHOENIX_DEV_LEAN: "1" });
    assert.equal(byVariable.maps, "1", "PHOENIX_DEV_LEAN=1 reaches the same switches");
    assert.equal(byVariable.nodeOptions, "--max-old-space-size=2560");

    const plain = launch(["--port", "3999"]);
    assert.equal(plain.maps, null, "without --lean neither switch is set");
    assert.equal(plain.cache, null);
    assert.equal(plain.nodeOptions, "--max-old-space-size=4096", "and the heap stays at the launcher's 4,096 MB default");
    assert.doesNotMatch(plain.line, /lean:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type WebpackHook = (config: Record<string, unknown>, context: { dev: boolean; isServer: boolean }) => Record<string, unknown>;

/**
 * The hook exactly as next.config.ts writes it, compiled and run here. Not through Next's own config
 * loader: that loader re-reads .env.local and rewrites process.env for the whole test process, and
 * with a Sentry build token in .env.local it hands back Sentry's wrapper instead of this hook.
 */
function loadTheHookFromNextConfig(): WebpackHook {
  const source = readFileSync(resolve("next.config.ts"), "utf8");
  assert.equal(source.match(/\n {2}webpack\s*:/g)?.length ?? 0, 1, "next.config.ts carries exactly one `webpack` hook");
  const hook = source.match(/\n {2}webpack: (\(config, \{ dev, isServer \}\) => \{[\s\S]*?\n {2}\}),\n/)?.[1];
  assert.ok(hook, "next.config.ts must carry the dev-only `webpack: (config, { dev, isServer }) => { … }` hook that --lean relies on");
  const ts = createRequire(resolve("package.json"))("typescript") as { transpile: (input: string, options: object) => string };
  const js = ts.transpile(`(${hook})`, { target: 9 /* ES2022 */ });
  return new Function("process", `return ${js}`)(process) as WebpackHook;
}

function testTheConfigHook() {
  const nodeRequire = createRequire(resolve("package.json"));
  const NextEvalSourceMap = (nodeRequire("next/dist/build/webpack/plugins/eval-source-map-dev-tool-plugin.js") as {
    default: new (options: Record<string, unknown>) => object;
  }).default;
  assert.equal(
    NextEvalSourceMap.name,
    "EvalSourceMapDevToolPlugin",
    "next.config.ts removes Next's source-map plugin by this class name: renamed by an upgrade, the lean switch would remove nothing",
  );
  assert.match(
    readFileSync(nodeRequire.resolve("next/dist/build/webpack/config/blocks/base.js"), "utf8"),
    /config\.plugins\.push\(new _evalsourcemapdevtoolplugin\.default\(/,
    "the installed Next must still add its own source-map plugin in dev, or the lean switch has nothing to remove",
  );

  const hook = loadTheHookFromNextConfig();
  class OtherPlugin {}
  const fresh = () => ({ plugins: [new NextEvalSourceMap({}), new OtherPlugin()], cache: { type: "filesystem" } as unknown });
  const names = (config: Record<string, unknown>) => (config.plugins as object[]).map((plugin) => plugin.constructor.name);

  const saved = Object.fromEntries(SWITCHES.map((key) => [key, process.env[key]]));
  try {
    for (const key of SWITCHES) delete process.env[key];
    const off = hook(fresh(), { dev: true, isServer: true });
    assert.deepEqual(names(off), ["EvalSourceMapDevToolPlugin", "OtherPlugin"], "with no switch set the hook changes nothing");
    assert.deepEqual(off.cache, { type: "filesystem" });

    process.env.PHOENIX_DEV_LEAN_SERVER_MAPS = "1";
    process.env.PHOENIX_DEV_NO_DISK_CACHE = "1";
    const server = hook(fresh(), { dev: true, isServer: true });
    assert.deepEqual(names(server), ["OtherPlugin"], "the dev SERVER compiler drops Next's source-map plugin, and only it");
    assert.equal(server.cache, false, "the dev compiler keeps no disk cache");

    const client = hook(fresh(), { dev: true, isServer: false });
    assert.deepEqual(names(client), ["EvalSourceMapDevToolPlugin", "OtherPlugin"], "the BROWSER bundle keeps its source maps");
    assert.equal(client.cache, false);

    for (const isServer of [true, false]) {
      const build = hook(fresh(), { dev: false, isServer });
      assert.deepEqual(names(build), ["EvalSourceMapDevToolPlugin", "OtherPlugin"], "`next build` is never touched, even with both switches set");
      assert.deepEqual(build.cache, { type: "filesystem" }, "`next build` keeps its cache, even with both switches set");
    }
  } finally {
    for (const key of SWITCHES) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** The script exists and goes through the launcher (tests/dev-server-heap-cap.test.ts pins every dev script). */
function testTheScript() {
  const scripts = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["dev:lean"], "node scripts/dev-server.mjs --lean");
}

export function runDevServerLeanTests() {
  testTheDecision();
  testTheLauncher();
  testTheConfigHook();
  testTheScript();
}
