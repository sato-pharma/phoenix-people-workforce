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
 * the watchdog's per-process ceiling WAS 6 GB, so it reaped a healthy server and a session
 * restarted it. Each cycle drove physical RAM to 94%, Windows evicted working sets to the
 * pagefile, and dwm.exe ended up 4% resident — that is what "the whole machine is slow" was,
 * with CPU never above 9%. The fix was the watchdog THRESHOLD (and running one dev server
 * at a time, AGENTS.md 5), never the bundler. Do not re-file this under turbopack.
 *
 * SETTLED 2026-09-12: mem-watchdog.ps1 now EXEMPTS a next dev server from every one of its rules
 * ("A NEXT DEV SERVER IS THEREFORE TOUCHED BY NOTHING IN THIS SCRIPT AT ALL", its own header), so
 * this sawtooth cannot recur and there is no threshold left to tune. Under its floors the watchdog
 * reclaims NODE JOBS — a typecheck, a build, a test run. What stops a dev server, since 2026-09-17,
 * is ~/.claude/hooks/dev-server-reaper.mjs: the one the ENDING session started, and nobody else's.
 * Account: docs/agents-worktree-and-machine-limits.md.
 *
 * AMENDED 2026-09-21, the owner's choice ("Over 8 GB or unused 25 min"): the watchdog stops a dev
 * server again in two cases only. Rule 1 stops one at or over 8 GB of commit, a runaway; every healthy
 * server above peaked at 6.03-7.23 GB, so the sawtooth cannot return. Rule 3 stops one after 25 minutes
 * with no work. A server in use under 8 GB is still never touched. If this launcher reports its server
 * "ended from outside" (exit code 1 or -1), look in ~/.claude/scripts/mem-watchdog.log for
 * `runaway-dev-server-over-ceiling` or `abandoned-dev-server-idle` first.
 *
 * ALSO (AGENTS.md 2.1, Worktrees): turbopack rejects the junctioned node_modules that every
 * `_wt-*` worktree uses, because it reads the junction as a symlink out of the project root.
 * --webpack serves a junctioned worktree fine (measured 2026-08-29, "Ready in 1770ms", HMR
 * working). So on this machine turbopack does not merely leak — in a worktree it cannot start.
 *
 * SUPERSEDED 2026-10-13 — macOS/Linux no longer keep --turbopack. "None of the above reproduces
 * there" held only while no Linux dev server had been measured; the Hetzner box is one, and on
 * turbopack it answered healthz once while cold and then nothing at all, for every route, three
 * servers running. Webpack is now the default on every platform. See the decision below.
 *
 * ESCAPE HATCH: `pnpm run dev:turbopack` still forces turbopack on any platform, and
 * PHOENIX_DEV_BUNDLER=turbopack|webpack overrides the automatic choice.
 */

import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { explainDevServerExit } from "./dev-server-exit-reason.mjs";
import { resolveHeapCap } from "./dev-server-heap-cap.mjs";
import { resolveLeanMode } from "./dev-server-lean.mjs";

const override = process.env.PHOENIX_DEV_BUNDLER?.trim().toLowerCase();
const isWindows = process.platform === "win32";

// Pass through anything the caller added, e.g. `pnpm run dev --port 3100`. A bundler flag among
// them is the caller's own choice (`dev:turbopack` is this launcher plus --turbopack), so it wins
// over the variable and the platform default, and Next receives it once rather than beside a second.
// `--lean` is the launcher's own flag (scripts/dev-server-lean.mjs) and never reaches Next.
const lean = resolveLeanMode(process.argv.slice(2), process.env);
const passthrough = lean.passthrough;
const bundlerFlag = passthrough.find((arg) => arg === "--webpack" || arg === "--turbopack" || arg === "--turbo");

let bundler;
if (bundlerFlag) {
  bundler = bundlerFlag === "--webpack" ? "webpack" : "turbopack";
} else if (override === "turbopack" || override === "webpack") {
  bundler = override;
} else {
  // 🔴 WEBPACK IS THE DEFAULT ON EVERY PLATFORM (measured 2026-10-13, the owner's instruction "fix
  // phx-preview the same way"). The line this replaces read `isWindows ? "webpack" : "turbopack"`,
  // on the header's claim that "none of the above reproduces" off Windows. It does. The Hetzner box
  // is Linux and runs this launcher, and there turbopack reproduced the exact wedge this whole file
  // was written for: THREE servers in a row answered `/api/healthz` once while cold, then every real
  // route — a portal page shipped that morning, the months-old `/admin/field-crm/validation-reviews`
  // and a plain `/api/employee-portals/navigation` alike — drove the process to its heap cap, where
  // it sat at 27-60% of a core and 4.8 GB RSS and answered NOTHING again, healthz included. Single
  // serial requests at 400 s, 420 s and 560 s all returned 000. On webpack, READY fell 38 s → 8 s
  // and the same board went from 000 to 200 in 25 s.
  //
  // 🔴 IT IS A PLATFORM DEFAULT RATHER THAN A PER-SERVER ENV FOR ONE REASON: the box has TWO dev
  // servers and only `phx-live` sets a variable of its own (PHX_LIVE). `phx-preview` sets none, and
  // its scope line lives in the box's `preview-scope.sh`, which this repo does not ship — so keying
  // on an env would have fixed one of the two and left the other wedging, with nothing in this repo
  // to show why. Here, both get it from the checkout they already run.
  //
  // What is given up is turbopack's faster refresh for a Linux or macOS developer. Nothing else: CI
  // and cloud sessions build and test, they do not run `next dev`. The ESCAPE HATCH in the header is
  // unchanged and now carries that case — PHOENIX_DEV_BUNDLER=turbopack, or `pnpm run dev:turbopack`.
  bundler = "webpack";
}

/*
 * ONE DEV SERVER AT A TIME — ENFORCED HERE, added 2026-09-09.
 *
 * AGENTS.md § 5 has said "One dev server at a time, ever" for weeks. Nothing checked it, and on
 * 2026-09-09 that cost the owner two hard freezes, at 17:34 and 20:36 Cairo. Neither left a
 * minidump; both left a GPU watchdog dump (video timeout 0x117 / 0x141), which is the signature
 * of the desktop compositor being paged out rather than a driver fault.
 *
 * The arithmetic is not close. Measured that night on this repo, one `next dev --webpack` server
 * serving ten admin routes from cold peaked at 10,221 MB of commit and 7,497 MB resident (5,933 /
 * 5,665 after the dev-only next.config.ts flags landed the same day). The machine has 16 GB, of
 * which roughly 10 GB is already held by the owner's sessions and browser before any server
 * starts. So a SECOND server has never been able to fit, and both freezes were exactly that
 * state: mem-watchdog.log shows four to seven node processes holding 5.1-8.6 GB together, with
 * every rule in the watchdog logging "no idle dev server" because all of them were busy.
 *
 * A refusal here is worth more than any amount of reclaiming afterwards: the watchdog can only
 * choose which server to kill once both exist, and by then the box has already been over the
 * line for however long the compile took.
 *
 * WHY IT SCANS PROCESSES AND NOT THE PORT. The second server is usually on a different port —
 * worktrees run 3100, 3200 and so on — so a port probe answers "free" in precisely the case
 * this exists to stop. The scan looks for the child Next actually spawns, start-server.js,
 * because the cheap `next dev` parent carries no memory and the child's own command line
 * contains no "dev" flag at all (mem-watchdog.ps1 records the same trap).
 *
 * ESCAPE HATCH: PHOENIX_ALLOW_MULTIPLE_DEV_SERVERS=1 skips the check. It is there because a
 * refusal that cannot be overridden becomes a reason to delete the whole guard the first time it
 * is wrong, which is how the --webpack guard in this same file was lost three times.
 */
function findRunningDevServers() {
  if (process.env.PHOENIX_ALLOW_MULTIPLE_DEV_SERVERS === "1") return [];
  try {
    if (isWindows) {
      // Name='node.exe' is what keeps the query from matching the PowerShell process running it —
      // a CommandLine filter alone matches the command carrying the filter, which is the trap
      // AGENTS.md § 2.1 records for Win32_Process sweeps.
      const ps = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
            "Where-Object { $_.CommandLine -and ($_.CommandLine -like '*next*dist*server*lib*start-server*' -or $_.CommandLine -like '*next*dev*') } | " +
            "ForEach-Object { \"$($_.ProcessId)`t$([math]::Round($_.PrivatePageCount/1MB))\" }",
        ],
        { encoding: "utf8", timeout: 20000 },
      );
      if (ps.status !== 0 || !ps.stdout) return [];
      return ps.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [pid, mb] = line.split("\t");
          return { pid: Number(pid), mb: Number(mb) };
        })
        .filter((p) => Number.isFinite(p.pid) && p.pid !== process.pid);
    }
    const ps = spawnSync("bash", ["-lc", "ps -eo pid=,rss=,args= | grep -i 'next' | grep -v grep"], {
      encoding: "utf8",
      timeout: 20000,
    });
    if (ps.status !== 0 || !ps.stdout) return [];
    return ps.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /start-server|next dev/.test(l))
      .map((l) => {
        const [pid, rss] = l.split(/\s+/);
        return { pid: Number(pid), mb: Math.round(Number(rss) / 1024) };
      })
      .filter((p) => Number.isFinite(p.pid) && p.pid !== process.pid);
  } catch {
    // A guard that cannot answer must not block the work. Say nothing and let the server start.
    return [];
  }
}

const running = findRunningDevServers();
if (running.length > 0) {
  const list = running.map((p) => `      pid ${p.pid}  ${p.mb} MB`).join("\n");
  console.error(
    [
      "",
      "[dev-server] REFUSING TO START — a dev server is already running on this machine.",
      "",
      list,
      "",
      "  This box has 16 GB and one dev server on this repo peaks near 6 GB resident, so a second",
      "  one does not fit. Two of them running at once hard-froze the machine twice on 2026-09-09.",
      "",
      "  Stop the running one BY PORT, not by killing the task that started it (AGENTS.md § 5):",
      "      Get-NetTCPConnection -LocalPort 3000 -State Listen",
      "      Stop-Process -Id <OwningProcess> -Force",
      "",
      "  Then confirm the port is actually free before starting again — a curl that returns 000",
      "  is the only proof:",
      "      curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/healthz",
      "",
      "  If you genuinely need two (and you have measured the headroom for it):",
      "      PHOENIX_ALLOW_MULTIPLE_DEV_SERVERS=1 pnpm run dev",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// A 4,096 MB HEAP CAP, ON BY DEFAULT. Added 2026-09-21. It reverses the "NO MEMORY CAP HERE, AND
// DO NOT ADD ONE BACK" block that stood here from 2026-09-01, because that block was measured on the
// wrong process. Kept in summary below, since a session reading older notes will meet it.
//
// What Next does when NODE_OPTIONS carries no --max-old-space-size (next/dist/cli/next-dev.js,
// 16.3.3): it gives the server it forks HALF THE MACHINE'S RAM. It also restarts that server by
// itself only once the heap passes 80% of the limit (server/lib/start-server.js,
// getMemoryRestartStats). Measured 2026-09-21 on the child that does the growing (start-server.js),
// using a --require probe that reads v8.getHeapStatistics():
//     raw `next dev`, and this launcher before this change   8,278 MB   (child NODE_OPTIONS: --max-old-space-size=8086)
//     this launcher now                                     4,288 MB
// At the default, Next's own restart waits for 6.6 GB of heap, so a busy server grows to 7-8 GB
// first. mem-watchdog.log, the same morning:
//     09:07:53 KILL pid=4652 name=node commit=8.14GB reason=runaway-dev-server-over-ceiling
// With the cap, Next restarts it in place, on the same port, at about 3.4 GB of heap. The process as
// a whole runs a GB or two above its heap (see below), so it tops out around 5-6 GB rather than 8+.
//
// The old block's evidence: "heap_size_limit 4,288 MB with and without --max-old-space-size=4096,
// so the flag is a no-op". That was read from a plain `node`, whose own default here is about 4 GB,
// never from the child Next forks. The 6.21 GB kill it cited (02:38:17, pid 5008) was a server that
// really was capped. But it ran while next.config.ts still preloaded all 1,148 route entries (that
// stopped 2026-09-09) and while the watchdog stopped anything over 6 GB.
//
// Why 4,096 and not lower. This was measured 2026-09-09: same checkout, the same ten admin routes
// from cold, with the next.config.ts flags in place:
//                                  peak commit   peak working set   slowest route
//     no cap (Next: half of RAM)      5,933 MB          5,665 MB          14.1 s
//     --max-old-space-size=3072       4,835 MB          4,421 MB          62.1 s
// At 3,072 the heaviest compiles ran 3-4x slower. On 2026-09-21 a cold /admin/approvals-hub
// compile peaked at 1,508 MB of heap, so 4,096 leaves it room and still halves Next's ceiling. What
// no heap cap reaches: that same cold compile holds about 3.4 GB in all, because up to 1.4 GB of it
// is ArrayBuffers outside the heap. That reading was the same with the cap at 2,560 and at 4,096.
//
// Overrides, strongest first:
//   - a --max-old-space-size already in NODE_OPTIONS is the caller's choice and is kept as it is;
//   - PHOENIX_DEV_HEAP_MB=<MB> sets another cap, e.g. 3072 for a session where RAM matters more
//     than compile speed;
//   - PHOENIX_DEV_HEAP_MB=0 hands the choice back to Next (half of RAM).
// If a page ever ends the server with "JavaScript heap out of memory", raise the cap for that run.
// Nothing ran out of memory at 3,072 across the ten routes on 2026-09-09.
//
// Every path that starts a dev server now comes through here: the package.json dev scripts,
// scripts/dev-supervisor.ps1, and AGENTS.md 5's worktree line. .claude/hooks/bash-guard.mjs C7
// denies a raw `next dev` at the command line.
const heap = resolveHeapCap(lean.env);
if (heap.warning) console.warn(heap.warning);
const childEnv = { ...lean.env };
if (heap.nodeOptions) childEnv.NODE_OPTIONS = heap.nodeOptions;
else delete childEnv.NODE_OPTIONS;

// THE MEMORY RESTART WAITS FOR IN-FLIGHT REQUESTS (2026-10-31). Next's own restart at 80% of the cap
// exits in the middle of whatever else is streaming, which is React error 419 on the page being
// read. next.config.ts swaps it for scripts/dev-server-graceful-restart.mjs when this is "1".
// PHOENIX_DEV_GRACEFUL_RESTART=0 gives Next's own restart back.
const gracefulRestart = process.env.PHOENIX_DEV_GRACEFUL_RESTART !== "0";
if (gracefulRestart) childEnv.PHOENIX_DEV_GRACEFUL_RESTART = "1";
else delete childEnv.PHOENIX_DEV_GRACEFUL_RESTART;

const args = ["dev", `--${bundler}`, ...passthrough.filter((arg) => arg !== bundlerFlag)];

// LOOPBACK ONLY (owner-approved audit fix, 2026-10-26). A bare `next dev` listens on every interface,
// so anyone on the same Wi-Fi could reach this laptop's dev server — and through it the dev-preview
// sign-in, which mints a session as any role, against the PRODUCTION database .env.local points at.
// `-H 127.0.0.1` keeps it to this machine; `http://localhost:3000` still reaches it (Node and the
// browsers fall back from ::1 to 127.0.0.1). The header check behind it is
// `isLoopbackDevRequestHeaders` in src/lib/auth/dev-preview.ts.
// Opt-out, for a deliberate LAN test only: PHOENIX_DEV_BIND_ALL=1. A -H / --hostname the caller
// passed is kept as given and never doubled.
const callerChoseHost = passthrough.some(
  (arg) => arg === "-H" || arg === "--hostname" || arg.startsWith("--hostname=") || arg.startsWith("-H="),
);
const bindAll = process.env.PHOENIX_DEV_BIND_ALL === "1";
if (!callerChoseHost && !bindAll) args.push("-H", "127.0.0.1");
const bindNote = callerChoseHost
  ? "host from the caller"
  : bindAll
    ? "listening on EVERY interface (PHOENIX_DEV_BIND_ALL=1)"
    : "loopback only (127.0.0.1)";

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
    (bundlerFlag ? ` (${bundlerFlag} flag)` : override ? " (PHOENIX_DEV_BUNDLER override)" : "") +
    `  | ${heap.note}` +
    (gracefulRestart ? "  | memory restart waits for in-flight requests" : "  | Next's own memory restart") +
    (lean.note ? `  | ${lean.note}` : "") +
    `  | ${bindNote}` +
    `  | next ${args.join(" ")}` +
    (haveBin ? "" : "  (next not found in node_modules - falling back to PATH)"),
);

// SAY WHY IT STOPPED — added 2026-09-14, after the dev server died twice in one afternoon and this
// launcher exited without a word each time. The words live in dev-server-exit-reason.mjs.
//
// Free RAM is sampled WHILE the server runs, never after it dies: a dead server's gigabytes go back
// to Windows the instant it exits, so a reading taken then always looks healthy — which is exactly
// the wrong answer when running out of RAM is what killed it. The launcher is async (spawn, not
// spawnSync) only so this sampler can tick.
const ramSamples = [];
const sampleFreeRam = () => {
  const now = Date.now();
  ramSamples.push({ at: now, freeMb: Math.round(os.freemem() / 1048576) });
  while (ramSamples.length > 1 && now - ramSamples[0].at > 60_000) ramSamples.shift();
};
sampleFreeRam();
const ramSampler = setInterval(sampleFreeRam, 5_000);
ramSampler.unref();

// Ctrl+C reaches Next directly (it shares this console). The launcher only waits for Next to finish
// shutting down, then leaves with Next's own exit code.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

const child = haveBin
  ? spawn(process.execPath, [nextBin, ...args], {
      stdio: "inherit",
      env: childEnv,
    })
  : spawn("next", args, {
      stdio: "inherit",
      shell: true,
      env: childEnv,
    });

child.on("error", (err) => {
  console.error(`[dev-server] could not start Next: ${err.message}`);
  process.exit(1);
});

child.on("exit", (status, signal) => {
  clearInterval(ramSampler);
  const lines = explainDevServerExit({
    status,
    signal,
    lowestFreeMb: ramSamples.length ? Math.min(...ramSamples.map((s) => s.freeMb)) : null,
    totalMb: Math.round(os.totalmem() / 1048576),
    stoppedAt: new Date(),
  });
  if (lines) console.error(lines.join("\n"));
  process.exit(status ?? 1);
});
