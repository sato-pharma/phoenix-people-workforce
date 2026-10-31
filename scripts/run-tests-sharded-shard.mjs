// One shard of `scripts/run-tests-sharded.mjs`: spawn it, stream its output, and STOP it if it hangs.
//
// WHY A THIRD FILE. The runner cannot be imported (its top level spawns the whole suite) and
// `run-tests-sharded-plan.mjs` holds only decisions, no child processes. The hang watch is only proven by a
// real child that really hangs, so the spawning lives here, where `tests/run-tests-sharded.test.ts` can hand
// it a fixture that never ends and watch it be stopped.
//
// 🔴 THE CLOCK IS HERE, IN THE PARENT, AND IT IS NODE'S OWN. The hung child is the process whose timers,
// fetch or event loop may be what broke, so a deadline inside it can be the thing that never fires. This
// file imports its timers from `node:timers` and its clock from `node:perf_hooks`, so a global an earlier
// test stubbed in the SAME process — the runner's own test runs inside the suite — cannot stop the watch.

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";

import { createHangWatch, isTestMarker } from "./run-tests-sharded-plan.mjs";

/**
 * Run one shard to the end, or until the hang watch stops it.
 *
 * Resolves `{ index, code, signal, out, hung, spawnError }`: `out` is everything the shard printed, and
 * `hung` is null unless the watch killed it, when it is what {@link createHangWatch} said it was stuck on.
 *
 * @param {{
 *   args: string[], cwd: string, env: Record<string, string | undefined>, index: number, total: number, hangMs: number,
 *   stdout?: { write(text: string): unknown }, stderr?: { write(text: string): unknown }, pollMs?: number,
 * }} options
 */
export function runShard({ args, cwd, env, index, total, hangMs, stdout = process.stdout, stderr = process.stderr, pollMs = 1_000 }) {
  return new Promise((resolveShard) => {
    const startedAt = performance.now();
    const watch = createHangWatch(hangMs, startedAt);
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...env, PHX_TEST_SHARD: `${index}/${total}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tag = total === 1 ? "" : `[shard ${index}/${total}] `;
    let out = "";
    /** @type {{ name: string | null, seconds: number, running: boolean } | null} */
    let hung = null;
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let grace;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (grace) clearTimeout(grace);
      resolveShard({ index, out, hung, ...result });
    };

    const pump = (stream, sink) => {
      let partial = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        out += chunk;
        partial += chunk;
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        const at = performance.now();
        for (const line of lines) {
          watch.observe(line, at);
          // FAIL and the stack behind it are what a reader needs immediately; PASS lines are noise at
          // 2,000 a run, so they are counted and summarised instead, and the watch's markers are for the
          // watch alone.
          if (!line.startsWith("PASS ") && !isTestMarker(line)) sink.write(`${tag}${line}\n`);
        }
      });
      stream.on("end", () => {
        if (partial && !isTestMarker(partial)) sink.write(`${tag}${partial}\n`);
      });
    };
    pump(child.stdout, stdout);
    pump(child.stderr, stderr);

    const timer = setInterval(() => {
      if (hung) return;
      const stuck = watch.check(performance.now());
      if (!stuck) return;
      hung = stuck;
      stderr.write(
        stuck.running
          ? `${tag}HUNG "${stuck.name}" — still running after ${stuck.seconds}s, so this shard is being stopped\n`
          : `${tag}HUNG — ${stuck.seconds}s without starting a test or exiting, so this shard is being stopped\n`,
      );
      child.kill("SIGKILL");
    }, pollMs);

    child.on("error", (error) => finish({ code: 1, signal: null, spawnError: error }));
    child.on("exit", (code, signal) => {
      // `close` also waits for the pipes, and a process the shard started that inherited them can hold them
      // open after the shard itself is gone. Give them five seconds to drain, then settle without them.
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ code: code ?? 1, signal });
      }, 5_000);
    });
    child.on("close", (code, signal) => finish({ code: code ?? 1, signal }));
  });
}
