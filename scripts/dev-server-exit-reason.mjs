/*
 * Why the dev server stopped — the words `scripts/dev-server.mjs` prints when Next exits on its own.
 *
 * Before this, the launcher ended with `process.exit(result.status ?? 1)` and said nothing, so a dev
 * server that DIED looked exactly like one that was closed. On 2026-09-14 it died twice in one
 * afternoon with no message at all, and the cause — physical RAM down to 334 MB, while ~30 Claude
 * processes, Edge and an image-upscaling job held the rest — had to be dug out of three separate logs.
 *
 * The exit code does reach the launcher: Next's own parent process exits with its worker's code
 * (`next/dist/cli/next-dev.js`, handleSessionStop: `child.exitCode || 0`). It was just never shown.
 *
 * Pure on purpose. The launcher gathers the facts; this turns them into sentences;
 * tests/dev-server-exit-reason.test.ts pins the sentences.
 */

/** Below this much free physical RAM the machine starts losing processes (mem-watchdog.ps1's floor). */
export const LOW_FREE_RAM_MB = 1800;

// Windows reports a console process ended by Ctrl+C as STATUS_CONTROL_C_EXIT.
const CTRL_C_EXIT = 0xc000013a;

const ABORTED = [
  "Node aborted on a fatal error. Read the last error printed just above this message:",
  '"JavaScript heap out of memory" means the server filled its memory; "items over 2MB can not be',
  'cached" is the unstable_cache trap (docs/agents-session-traps.md, "Next.js runtime").',
];

const ENDED_FROM_OUTSIDE = [
  "If no error is printed just above, something outside ended it: Task Manager, Stop-Process,",
  "another session freeing the port, or a memory tool.",
];

/** Keyed by the UNSIGNED exit code, so -1 and 0xFFFFFFFF are the same entry. */
const REASONS = new Map([
  [0xc0000409, ABORTED],
  [134, ABORTED],
  [1, ENDED_FROM_OUTSIDE],
  [0xffffffff, ENDED_FROM_OUTSIDE],
  [0xc0000005, ["Node crashed inside native code (access violation). On this machine that usually follows memory running out."]],
  [0xc0000017, ["Windows refused Node more memory: it ran out of memory."]],
  [0xc000012d, ["Windows ran out of commit memory (RAM plus pagefile)."]],
  [0xc0000142, ["A process could not start because Windows had no commit memory left."]],
]);

const mb = (value) => value.toLocaleString("en-US");

function formatExitCode(status) {
  const unsigned = status >>> 0;
  return unsigned > 255 ? `${status} (0x${unsigned.toString(16).toUpperCase().padStart(8, "0")})` : String(status);
}

/**
 * @param {{
 *   status: number | null,
 *   signal: string | null,
 *   lowestFreeMb: number | null,
 *   totalMb: number,
 *   stoppedAt: Date,
 * }} exit
 * @returns {string[] | null} the lines to print, or null when the stop was a normal one
 */
export function explainDevServerExit({ status, signal, lowestFreeMb, totalMb, stoppedAt }) {
  if (signal === "SIGINT" || signal === "SIGTERM") return null;
  if (status === 0 || status === 130 || (status != null && status >>> 0 === CTRL_C_EXIT)) return null;

  const when = stoppedAt.toLocaleTimeString("en-GB", {
    timeZone: "Africa/Cairo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const lines = ["", `[dev-server] The dev server STOPPED on its own at ${when} Cairo.`];

  if (status == null) {
    lines.push(`  It was ended by the signal ${signal ?? "(none reported)"}.`, ...ENDED_FROM_OUTSIDE.map((l) => `  ${l}`));
  } else {
    const reason = REASONS.get(status >>> 0) ?? ["That exit code has no known meaning here; the last lines above are the best clue."];
    lines.push(`  Exit code: ${formatExitCode(status)}.`, ...reason.map((l) => `  ${l}`));
  }

  if (lowestFreeMb != null) {
    lines.push(`  Lowest free RAM in its last minute: ${mb(lowestFreeMb)} MB of ${mb(totalMb)} MB.`);
    if (lowestFreeMb < LOW_FREE_RAM_MB) {
      lines.push(
        `  That is under ${mb(LOW_FREE_RAM_MB)} MB, where this machine starts losing processes.`,
        "  Close idle sessions before starting it again.",
      );
    }
  }

  lines.push("");
  return lines;
}
