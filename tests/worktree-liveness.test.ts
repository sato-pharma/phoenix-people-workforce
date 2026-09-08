// A worktree with a live PROCESS in it is never retirable — and "I could not tell" is not "free".
//
// WHY THIS EXISTS ALONGSIDE tests/repo-doctor-session-hold.test.ts. Both guard the same 2026-09-08
// incident, from opposite sides, and neither covers the other's case:
//
//   - `repo-doctor-session-hold.mjs` reads Claude's own session transcripts. It sees a session that
//     has JUST CLOSED, inside the grace window, which no process sweep can — the process is gone.
//     Its documented blind spot is `_wt-*`: a sibling worktree's session reports the PRIMARY as its
//     cwd (AGENTS.md 2.1), so its turns land in the primary's project directory.
//     THE PROCESS SWEEP DOES NOT CLOSE THAT GAP, and no assertion below pretends it does. The same
//     cwd fact defeats it: measured 2026-09-08, every `claude` process reported a
//     `.claude/worktrees/` path and not one reported an `_wt-*` folder. The `_wt-*` case in this
//     file pins the MECHANISM — a row whose cwd is inside the folder holds it — not coverage of
//     `_wt-*` sessions, which neither signal has.
//   - `worktree-liveness.mjs`, under test here, reads each process's working directory out of its
//     PEB. It sees a session that is OPEN BUT IDLE FOR HOURS, which the transcript signal reads as
//     dead once the newest turn ages past the window — and an open session sitting between turns is
//     exactly what both lost folders were.
//
// THE FIXTURES ARE REAL. {@link INCIDENT_PROBE} is the actual `find-worktree-holder.ps1 -Json`
// output from this machine on 2026-09-08, naming `claude pid 18860` in `zen-tu-c5980b` and
// `claude pid 19932` in `zealous-dewdney-7afb5e` — the two folders that were emptied under their
// running sessions minutes earlier.
//
// THE OLD ANSWER IS PINNED TOO. {@link preFixRetirable} reproduces the rule as it stood: content
// gates only, no liveness question at all. Asserting that it still says "retirable" for the very
// folder the fixed rule holds is what proves these tests discriminate rather than pass for free —
// AGENTS.md 2.1 records "a pinning test can pin the ANTI-pattern" as the trap here.
//
// EVERY UNKNOWN MUST ANSWER "LIVE". This verdict gates a printed `git worktree remove`, so the
// null cases below are the point of the file rather than decoration. The one that matters most is
// `readable: 0`: an empty row list is the SAME JSON whether nobody is in a worktree or the sweep
// failed outright, and only the process count tells those apart. Without it a broken probe reads as
// proof that every folder on the machine is free — the shape AGENTS.md 2.3 records for a dependency
// sweep, where an empty result is indistinguishable from a broken query.

import assert from "node:assert/strict";

import {
  CACHE_ACTIVITY_WINDOW_MIN,
  holdersInside,
  livenessVerdict,
  normalizeHolderPath,
  parseHolderProbe,
} from "../scripts/worktree-liveness.mjs";

/** The real sweep output, 2026-09-08, trimmed to the rows that matter. */
const INCIDENT_PROBE = JSON.stringify({
  readable: 225,
  rows: [
    {
      Pid: 18860,
      Name: "claude",
      KernelCpu: "541s",
      Suspect: "KERNEL-STUCK?",
      Cwd: "F:\\Phoenix Workforce\\phoenix-workforce\\.claude\\worktrees\\zen-tu-c5980b\\",
    },
    {
      Pid: 19932,
      Name: "claude",
      KernelCpu: "536s",
      Suspect: "KERNEL-STUCK?",
      Cwd: "F:\\Phoenix Workforce\\phoenix-workforce\\.claude\\worktrees\\zealous-dewdney-7afb5e\\",
    },
    {
      Pid: 11348,
      Name: "bash",
      KernelCpu: "0s",
      Suspect: "",
      Cwd: "F:\\Phoenix Workforce\\_wt-digest-bridge-wiring\\",
    },
  ],
});

const TAKEN = "F:/Phoenix Workforce/phoenix-workforce/.claude/worktrees/zen-tu-c5980b";

/**
 * Retirability as it stood BEFORE any liveness question — content gates only. Reproduced here so
 * the fixed rule can be shown to disagree with it on the incident, rather than merely to agree with
 * itself.
 */
function preFixRetirable(
  { dirty, unpushed, newestPrMerged }: { dirty: number; unpushed: number; newestPrMerged: boolean },
): boolean {
  return dirty === 0 && unpushed === 0 && newestPrMerged;
}

export function runWorktreeLivenessTests() {
  // ── Path normalisation: three separate things defeat a plain startsWith ───────────────
  {
    assert.equal(
      normalizeHolderPath("F:\\Phoenix Workforce\\_wt-x\\"),
      "f:/phoenix workforce/_wt-x",
      "a PEB path must lose its trailing separator, flip to forward slashes and lower-case",
    );
    assert.equal(normalizeHolderPath("  "), null, "blank is not a path");
    assert.equal(normalizeHolderPath(null), null, "a missing path is not a path");
  }

  // ── The incident itself ──────────────────────────────────────────────────────────────
  {
    const probe = parseHolderProbe(INCIDENT_PROBE);
    assert.ok(probe, "the real sweep output must parse");
    assert.equal(probe.readable, 225, "the process count is the positive control and must survive parsing");

    const verdict = livenessVerdict({ dir: TAKEN, probe });
    assert.equal(
      verdict.live,
      true,
      "the folder emptied under a running session on 2026-09-08 must read as LIVE — a process was "
        + "sitting in it, and every content gate said it was retirable",
    );
    assert.match(
      verdict.reason ?? "",
      /claude pid 18860/,
      "the reason must NAME the holder, because the reader's next action is to close that session",
    );

    // The old rule, on the same folder, at the same moment. It was clean, pushed and merged.
    assert.equal(
      preFixRetirable({ dirty: 0, unpushed: 0, newestPrMerged: true }),
      true,
      "the pre-fix rule must still call that folder retirable — if this ever goes false the test "
        + "above has stopped discriminating and would pass without the fix",
    );
  }

  // ── Every unknown answers LIVE ───────────────────────────────────────────────────────
  {
    assert.equal(
      livenessVerdict({ dir: TAKEN, probe: null }).live,
      true,
      "a probe that could not run must never clear a folder",
    );
    assert.equal(parseHolderProbe("not json at all"), null, "garbage must parse to null, never to an empty sweep");
    assert.equal(parseHolderProbe('{"readable":"lots","rows":[]}'), null, "a non-numeric count is unusable");
    assert.equal(parseHolderProbe(undefined), null, "no output at all is unusable");

    // The one that would otherwise read as "the whole machine is free".
    const broken = parseHolderProbe('{"readable":0,"rows":[]}');
    assert.ok(broken, "a zero-process sweep still parses — it is well-formed, just meaningless");
    const verdict = livenessVerdict({ dir: TAKEN, probe: broken });
    assert.equal(
      verdict.live,
      true,
      "reading 0 processes means the sweep is BROKEN, not that no folder is held — without this "
        + "rule a failed probe clears every worktree on the machine at once",
    );
  }

  // ── A working sweep that genuinely finds nobody must clear the folder ────────────────
  {
    const empty = parseHolderProbe('{"readable":212,"rows":[]}');
    assert.ok(empty, "the fixture must parse — a null probe would make every assertion below vacuous");
    assert.equal(
      livenessVerdict({ dir: TAKEN, probe: empty }).live,
      false,
      "212 processes read and none in this folder is a real answer — if this held too, the gate "
        + "would never clear anything and the report would silently stop being useful",
    );
  }

  // ── The prefix boundary: this repo extends worktree names constantly ─────────────────
  {
    const probe = parseHolderProbe(
      JSON.stringify({ readable: 200, rows: [{ Pid: 5, Name: "node", Cwd: "F:\\Phoenix Workforce\\_wt-pharmacy-guard\\" }] }),
    );
    assert.ok(probe, "the fixture must parse — a null probe would make every assertion below vacuous");
    assert.equal(
      holdersInside("F:/Phoenix Workforce/_wt-pharmacy", probe.rows).length,
      0,
      "_wt-pharmacy must NOT match a holder in _wt-pharmacy-guard — a bare prefix test would hold "
        + "an unrelated folder forever, and this repo names worktrees off a shared stem",
    );
    assert.equal(
      holdersInside("F:/Phoenix Workforce/_wt-pharmacy-guard", probe.rows).length,
      1,
      "the folder itself must still match",
    );
    assert.equal(
      holdersInside("F:/Phoenix Workforce/_wt-pharmacy-guard/src", probe.rows).length,
      0,
      "a holder ABOVE the queried path does not hold it",
    );
  }

  // ── A process deeper inside the worktree still holds it ─────────────────────────────
  {
    const probe = parseHolderProbe(
      JSON.stringify({ readable: 200, rows: [{ Pid: 9, Name: "node", Cwd: "F:\\Phoenix Workforce\\_wt-a\\src\\lib\\" }] }),
    );
    assert.ok(probe, "the fixture must parse — a null probe would make every assertion below vacuous");
    assert.equal(
      livenessVerdict({ dir: "F:/Phoenix Workforce/_wt-a", probe }).live,
      true,
      "a shell sitting in a subdirectory holds the worktree just as firmly as one at its root",
    );
  }

  // ── Build-cache churn: a running dev server, seen without any process lookup ─────────
  {
    const empty = parseHolderProbe('{"readable":212,"rows":[]}');
    assert.ok(empty, "the fixture must parse — a null probe would make every assertion below vacuous");
    assert.equal(
      livenessVerdict({ cacheIdleMin: 2, dir: TAKEN, probe: empty }).live,
      true,
      "a .next written 2 minutes ago means a dev server is running in there",
    );
    assert.equal(
      livenessVerdict({ cacheIdleMin: CACHE_ACTIVITY_WINDOW_MIN + 1, dir: TAKEN, probe: empty }).live,
      false,
      "a cache older than the window is not a liveness signal",
    );
    assert.equal(
      livenessVerdict({ cacheIdleMin: null, dir: TAKEN, probe: empty }).live,
      false,
      "NO build cache is not evidence of life — most worktrees have never been built in",
    );
  }

  // ── The invariant that ties this to --strip-idle ─────────────────────────────────────
  //
  // repo-doctor already measured source idleness for the strip pass and never showed it to the
  // retirable pass, so one half of a single run could refuse to drop a worktree's node_modules
  // while the other half printed `git worktree remove` for the whole folder. Measured on
  // 2026-09-08 with `_wt-code-strand-guard`: "touched 18 min ago — a session may be mid-edit" and
  // cleared as retirable, in the same report.
  {
    const empty = parseHolderProbe('{"readable":212,"rows":[]}');
    assert.ok(empty, "the fixture must parse — a null probe would make every assertion below vacuous");
    assert.equal(
      livenessVerdict({ dir: TAKEN, probe: empty, sourceIdleMin: 18 }).live,
      true,
      "anything --strip-idle refuses as possibly-mid-edit must never be offered for DELETION by "
        + "the same run",
    );
    assert.equal(
      livenessVerdict({ dir: TAKEN, probe: empty, sourceIdleMin: CACHE_ACTIVITY_WINDOW_MIN + 1 }).live,
      false,
      "a worktree nobody has edited for longer than the window is genuinely idle",
    );
  }

  // ── A direct holder outranks an mtime in the REASON, since it is evidence not inference ──
  {
    const probe = parseHolderProbe(INCIDENT_PROBE);
    assert.ok(probe, "the fixture must parse — a null probe would make every assertion below vacuous");
    const verdict = livenessVerdict({ cacheIdleMin: 1, dir: TAKEN, probe, sourceIdleMin: 1 });
    assert.match(
      verdict.reason ?? "",
      /a live process is sitting in it/,
      "when several rules would fire, the reader gets the one naming a PID to close",
    );
  }
}
