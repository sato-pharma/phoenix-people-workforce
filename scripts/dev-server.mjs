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
 *   - In ONE night the memory watchdog killed FIFTEEN turbopack dev servers for crossing its
 *     6 GB per-process ceiling (00:06, 00:14, 00:34, 00:48, 01:15, 01:15 ...). Each kill was
 *     followed by a session restarting the server, which climbed to 6 GB again. That sawtooth
 *     drove physical RAM to 94% over and over, and Windows responded by evicting working sets
 *     to the pagefile — dwm.exe ended up 4% resident, which is what "the whole machine is slow"
 *     actually was. CPU was never above 9%.
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

// Keep V8 well under the watchdog's 6 GB per-process ceiling so the server garbage-collects
// hard instead of being killed outright. A hard kill loses HMR state and triggers the restart
// sawtooth described above; GC pressure just makes it a little slower. Caller-set NODE_OPTIONS
// wins, so this never fights an explicit choice.
const nodeOptions = process.env.NODE_OPTIONS?.includes("--max-old-space-size")
  ? process.env.NODE_OPTIONS
  : `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=4096`.trim();

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
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
    })
  : spawnSync("next", args, {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
    });

process.exit(result.status ?? 1);
