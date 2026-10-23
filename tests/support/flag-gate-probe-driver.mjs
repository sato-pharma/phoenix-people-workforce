// tests/support/flag-gate-probe-driver.mjs
// ---------------------------------------------------------------------------
// ONE PROCESS, MANY GATES — the probe half of tests/unknown-flag-gates.test.ts.
//
// 🔴 That test used to spawn node once per pinned script: 118 startups, and 118 copies of the
// src/lib graph the `.ts` scripts share. Measured 2026-10-23 — 47,893 ms on CI, the slowest test in
// the suite and 53% of its shard; 178 s of CPU locally for 52.9 s of wall. The same 118 gates answer
// in 43.3 s inside ONE process, because the shared graph is compiled once.
//
// So this driver imports the scripts it is handed, one after another, in a single process:
//
//   * process.argv is truncated to [node, <the script>] and argv[1] rewritten for each one, so
//     refuseUnknownFlags' `entry` check still recognises the script as the process entry point and
//     judges a BARE command line — exactly what a real `node scripts/x.mjs` hands it;
//   * process.exit is intercepted, because a probed gate exits the moment it has answered and the
//     next script has to follow it in the same process. The gate's exit becomes a throw, which
//     stops the script's body at the same statement the exit did.
//
// It prints `##PROBE <file>` before each script and `##VERDICT <what became of it>` after it, with
// the gate's own stdout in between, and it NEVER judges a gate: the test reads these lines and
// asserts. A script whose body does not run reports a verdict with no GATE line, and the test
// re-probes THAT one with a spawn of its own — ESM evaluates a module once and caches the throw, so
// a script imported by an earlier target in the same process cannot answer for itself here.
// ---------------------------------------------------------------------------
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

class ProbeExit extends Error {
  constructor(code) {
    super(`probe exit ${code}`);
    this.exitCode = code;
  }
}

// Bound before the first import: a probed script may replace console.log or process.exit, and the
// driver's own protocol must survive that.
const say = console.log.bind(console);
const realExit = process.exit.bind(process);
const targets = process.argv.slice(2);
process.argv.length = 2;
process.exit = (code = 0) => {
  throw new ProbeExit(code);
};
process.env.PHX_FLAG_GATE_PROBE_BOTH = "1";

for (const target of targets) {
  const absolute = resolve(target);
  process.argv[1] = absolute;
  process.env.PHX_FLAG_GATE_PROBE = absolute;
  say(`##PROBE ${target}`);
  let verdict = "no exit — the gate did not answer in this process";
  try {
    await import(pathToFileURL(absolute).href);
  } catch (error) {
    verdict =
      error instanceof ProbeExit
        ? `exit ${error.exitCode ?? 0}`
        : `threw ${String((error && error.stack) || error).split("\n").slice(0, 3).join(" | ")}`;
  }
  say(`##VERDICT ${verdict}`);
}
realExit(0);
