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

console.log(
  `[dev-server] ${process.platform} -> ${bundler}` +
    (override ? " (PHOENIX_DEV_BUNDLER override)" : "") +
    `  | next ${args.join(" ")}`,
);

const result = spawnSync("next", args, {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});

process.exit(result.status ?? 1);
