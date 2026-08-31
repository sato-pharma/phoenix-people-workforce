#!/usr/bin/env node
/*
 * Phoenix Workforce dev server launcher.
 *
 * WHY THIS FILE EXISTS — read before "simplifying" it back to `next dev --turbopack`.
 *
 * On Windows this repo runs the dev server with --webpack, NOT --turbopack. That choice has
 * now been made and un-made four times (PR #499 added the guard, #699 restored it, #1435
 * deleted it with the message "use Turbopack on Windows dev server, not webpack"), and each
 * deletion happened because the reason lived nowhere a session would read it. So it lives
 * here, next to the code it governs.
 *
 * MEASURED ON THE OWNER'S MACHINE, 2026-09-01:
 *   - Three consecutive `next dev --turbopack --port 3000` servers wedged solid: no answer to
 *     GET / in 25-60s, while holding 3.2-5.8 GB each and still climbing.
 *   - `next dev --webpack` on the same checkout served HTTP 200 in 11.1s.
 *
 * CORRECTED THE SAME DAY — this block first claimed the 6 GB watchdog kills were a TURBOPACK
 * trait ("killed FIFTEEN turbopack dev servers ... that sawtooth is what the slowness was").
 * That was wrong, and wrong in the direction that makes a future session stop looking. Kept
 * verbatim as the correction it is, because the wrong version shipped to `main` first.
 *
 * The kills CONTINUED after the switch to webpack. This launcher merged (#2847) at 02:08:38
 * Cairo on 2026-09-01. Kills that night, from mem-watchdog.log, ceiling 6 GB:
 *       02:07:27  pid=30584  commit=6.93GB   hand-started --webpack, 71s BEFORE the merge
 *                                            (I had called it "stable at 3.52 GB" 2 min earlier)
 *       ------------- #2847 merges 02:08:38, every dev server is webpack from here -------------
 *       02:19:23  pid=27996  commit=7.23GB
 *       02:25:06  pid=21948  commit=6.49GB
 *       02:27:48  pid=21180  commit=6.03GB
 *       02:28:10  pid=12376  commit=6.87GB
 *       02:34:43  pid=20416  commit=6.33GB
 *       02:38:17  pid=5008   commit=6.21GB   started by THIS launcher, WITH the memory cap set
 *       02:46:14  pid=21448  commit=6.10GB
 * Seven kills after the bundler switch, 6.03-7.23 GB, indistinguishable from the eight before it
 * (00:06-02:07, 6.02-7.27 GB). 100 kill attempts / 98 succeeded all-time, log opening 2026-08-26.
 * So the bundler choice does NOT stop the kill/restart cycle, and nothing in this file does. What
 * it does fix is turbopack WEDGING and turbopack being unable to start in a worktree.
 *
 * TRAP, if you go back to that log to re-check any of this: you CANNOT attribute a kill to a
 * bundler from the log itself. Both bundlers spawn the same child — next/dist/server/lib/
 * start-server.js — so the logged cmd line is identical and grepping it for "turbopack" returns
 * 0 of 100, which reads as "no turbopack kill ever happened". Attribute by TIMESTAMP against
 * when the server was started, as above. (Counting is a second trap: PowerShell Select-String
 * is case-INSENSITIVE by default, so /KILL/ also matches the "killed OK" line that follows each
 * one and the "total kills this run" tail — it reported 237. Pass -CaseSensitive.)
 *
 * The cycle's real shape: this codebase's dev server legitimately reaches ~6 GB under real use,
 * the watchdog's per-process ceiling IS 6 GB, so it reaps a healthy server and a session
 * restarts it. Each cycle drove physical RAM to 94%, Windows evicted working sets to the
 * pagefile, and dwm.exe ended up 4% resident — that is what "the whole machine is slow" was,
 * with CPU never above 9%. Fixing it means the watchdog THRESHOLD (and running one dev server
 * at a time, AGENTS.md 5), not the bundler. Do not re-file this under turbopack.
 *
 * ALSO (AGENTS.md 2.1, Worktrees): turbopack rejects the junctioned node_modules that every
 * `_wt-*` worktree uses, because it reads the junction as a symlink out of the project root.
 * --webpack serves a junctioned worktree fine (measured 2026-08-29, "Ready in 1770ms", HMR
 * working). So on this machine turbopack does not merely leak — in a worktree it cannot start.
 *
 * macOS/Linux keep --turbopack: none of the above reproduces there, and CI and cloud sessions
 * benefit from the faster refresh.
 *
 * ESCAPE HATCH: `pnpm run dev:turbopack` still forces turbopack on any platform, and
 * PHOENIX_DEV_BUNDLER=turbopack|webpack overrides the automatic choice.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const override = process.env.PHOENIX_DEV_BUNDLER?.trim().toLowerCase();
const isWindows = process.platform === "win32";

let bundler;
if (override === "turbopack" || override === "webpack") {
  bundler = override;
} else {
  bundler = isWindows ? "webpack" : "turbopack";
}

// Pass through anything the caller added, e.g. `pnpm run dev --port 3100`.
const passthrough = process.argv.slice(2);

// NO MEMORY CAP HERE, AND DO NOT ADD ONE BACK. This file shipped with
// `--max-old-space-size=4096` and a comment claiming it kept the server under the watchdog's
// 6 GB ceiling. The claim was false. It is corrected here rather than quietly deleted, because
// a session staring at a killed dev server will reach for exactly that flag next.
//
// MEASURED 2026-09-01 on this machine, with v8.getHeapStatistics().heap_size_limit:
//     no NODE_OPTIONS             ->  4288 MB
//     --max-old-space-size=4096   ->  4288 MB      IDENTICAL — the flag bound nothing
// Node already defaults to a ~4 GB old space here. And the server it was meant to protect was
// killed anyway, with the flag set: 02:38:17 KILL pid=5008 commit=6.21GB.
//
// The growth past 6 GB is OFF-HEAP — module graph, source maps, native allocations — which
// --max-old-space-size cannot bound by construction. AGENTS.md 2.1 already records this for the
// ExcelJS leak ("off-heap so --max-old-space-size cannot cap it"). It applies here identically.
//
// A cap that DID bind (say 2048) would be a real behaviour change — more GC, slower rebuilds,
// possible OOM — so it needs measuring before it is worth shipping. Nobody has measured it.

const args = ["dev", `--${bundler}`, ...passthrough];

// Resolve Next's bin through the filesystem, NOT through PATH. `pnpm run dev` happens to put
// node_modules/.bin on PATH, so `spawnSync("next", ...)` works under pnpm and fails with
// "'next' is not recognized" the moment anyone runs `node scripts/dev-server.mjs` directly -
// caught exactly that way on 2026-09-01, before this shipped. Resolving from THIS file's own
// location (not process.cwd()) also means it still works when invoked from a subdirectory,
// and it is the same form the working dev server already used:
//   node.exe node_modules/next/dist/bin/next dev --webpack --port 3100
// Dropping shell:true with it removes a quoting hazard too - this checkout's path contains a
// space, and every layer that re-parses a command line is a chance to split it there.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = path.join(repoRoot, "node_modules", "next", "dist", "bin", "next");
const haveBin = fs.existsSync(nextBin);

console.log(
  `[dev-server] ${process.platform} -> ${bundler}` +
    (override ? " (PHOENIX_DEV_BUNDLER override)" : "") +
    `  | next ${args.join(" ")}` +
    (haveBin ? "" : "  (next not found in node_modules - falling back to PATH)"),
);

const result = haveBin
  ? spawnSync(process.execPath, [nextBin, ...args], {
      stdio: "inherit",
    })
  : spawnSync("next", args, {
      stdio: "inherit",
      shell: true,
    });

process.exit(result.status ?? 1);
