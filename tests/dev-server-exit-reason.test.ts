import assert from "node:assert/strict";
import { explainDevServerExit, LOW_FREE_RAM_MB } from "../scripts/dev-server-exit-reason.mjs";

// 12:08:31 UTC is 15:08:31 in Cairo — the afternoon the dev server died twice with no message.
const stoppedAt = new Date("2026-09-14T12:08:31Z");

type ExitInput = { status: number | null; signal: string | null; lowestFreeMb?: number | null };

const explain = (input: ExitInput) =>
  explainDevServerExit({
    status: input.status,
    signal: input.signal,
    lowestFreeMb: input.lowestFreeMb ?? 6000,
    totalMb: 16174,
    stoppedAt,
  });
const text = (input: ExitInput) => (explain(input) ?? []).join("\n");

export function runDevServerExitReasonTests() {
  assert.equal(explain({ status: 0, signal: null }), null, "a clean stop prints nothing — only an unexpected stop earns a message");
  assert.equal(
    explain({ status: 0xc000013a, signal: null }),
    null,
    "Ctrl+C on Windows (STATUS_CONTROL_C_EXIT) is the owner closing the server, not a failure",
  );
  assert.equal(explain({ status: null, signal: "SIGINT" }), null, "Ctrl+C reported as a signal is not a failure either");

  const aborted = text({ status: 3221226505, signal: null });
  assert.match(aborted, /STOPPED on its own at 15:08:31 Cairo/, "the stop time is Cairo local, never raw UTC");
  assert.match(aborted, /0xC0000409/, "the Windows abort code is shown in the hex form that search results use");
  assert.match(aborted, /heap out of memory/, "an abort names the heap-full cause to look for above");
  assert.match(aborted, /over 2MB/, "an abort names the unstable_cache 2MB trap, the other known killer in this repo");

  for (const outside of [1, -1, 4294967295]) {
    assert.match(
      text({ status: outside, signal: null }),
      /something outside ended it/,
      `exit ${outside} is what a process killed by Stop-Process or Task Manager reports`,
    );
  }
  assert.match(text({ status: null, signal: "SIGKILL" }), /signal SIGKILL/, "a signal death names the signal");
  assert.match(text({ status: 0xc0000017, signal: null }), /ran out of memory/, "STATUS_NO_MEMORY is named as memory running out");
  assert.match(text({ status: 42, signal: null }), /Exit code: 42\./, "an unknown code is still printed rather than swallowed");

  const starved = text({ status: 1, signal: null, lowestFreeMb: 334 });
  assert.match(starved, /334 MB of 16,174 MB/, "the lowest free RAM while it ran is printed, not the reading after it died");
  assert.match(starved, /Close idle sessions/, "RAM under the floor tells the owner what to do before restarting");
  assert.doesNotMatch(aborted, /Close idle sessions/, "plenty of free RAM must not blame memory");
  assert.equal(LOW_FREE_RAM_MB, 1800, "the low-RAM line matches mem-watchdog.ps1's 1,800 MB pressure floor");
}
