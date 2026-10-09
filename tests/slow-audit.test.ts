// scripts/slow-audit.mjs must keep answering "why is everything slow?" with the one counter that
// can tell, must never report a step that did not run as the step that dominated a job, and must
// stay safe to run on a box that is already at the freeze line.
//
// WHY THIS EXISTS. Three separate ways this script could rot into a confident wrong answer, and
// each of them has a real precedent in this repo:
//
// 1. THE COUNTER. The audit leads with `Memory\Pages Input/sec` because hard faults per second are
//    the only reading that separates "out of RAM" from "busy". It also reads
//    `PhysicalDisk % Idle Time` purely so the report can say out loud that it proves nothing — an
//    NVMe serves thousands of random 4K faults a second at a queue depth near zero and still
//    reports idle. A 2026-09-17 audit on this laptop reasoned from "disk sat 99.6-99.9% idle with
//    a 0.00 queue while the box was slow" to "the disk is not the problem, and therefore paging is
//    not either", and that second step is false. On 2026-10-08 the same box measured 9,447
//    faults/sec at 95% disk idle. So this test pins the counter ORDER, and pins that the verdict
//    never keys off the disk reading.
//
// 2. THE SENTINEL. GitHub reports a skipped job or step with `startedAt: "0001-01-01T00:00:00Z"`,
//    not null. Subtract that from a real `completedAt` and you get ~63 billion seconds, so a plain
//    max-by-duration names the step that NEVER RAN as the dominant one. The first version of this
//    script did exactly that: it reported main's `validate` as 719s of "Test" on a run that had
//    built for 246s and skipped Test entirely, because on a push event the Test step lives in
//    `checks`. That is the fail-open shape the session-trap notes already name — an ABSENT answer
//    arriving in the shape of a very large one — and it is why the arithmetic was moved out of a
//    `gh --jq` expression into Node, where this fixture can reach it.
//
// 3. WHAT IT IS ALLOWED TO SPAWN. An audit is run precisely when the machine is about to fall over,
//    so it must never be the thing that pushes it over. It may start short-lived PowerShell and
//    `gh` processes and it may time hook scripts; it must never run a build, a typecheck, a test
//    run or a dev server, and it must never spawn the two hooks that ACT rather than report
//    (dev-server-reaper.mjs stops servers, scratchpad-guard's `sweep` archives files).

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// Imported statically, exactly as the other script-backed suites here do, so the real exported
// signatures are the ones under test. An earlier cut declared the module's shape with a wholesale
// `as { ... }` cast and `tsc` rejected it (TS2352: neither type sufficiently overlaps) — the
// inferred tuple type is not what the cast claimed. The local suite could not have caught that:
// `--experimental-strip-types` ERASES types rather than checking them, so the cast ran green here
// and failed only on the box. The shapes now come from JSDoc on slow-audit.mjs itself.
import {
  HOOK_PROBES,
  HOOKS,
  MACHINE_COUNTERS,
  THRESHOLDS,
  TRANSCRIPT_LIMITS,
  cairoMidnightMs,
  contextBucket,
  createTranscriptStats,
  hookCost,
  hookLabel,
  spanSeconds,
  summarizeRun,
  transcriptAlarms,
  transcriptRates,
} from "../scripts/slow-audit.mjs";

const source = readFileSync("scripts/slow-audit.mjs", "utf8");

/** The counter that decides, and the one that must never be mistaken for it. */
function counterChoiceIsPinned(): void {
  assert.equal(
    MACHINE_COUNTERS[0],
    "\\Memory\\Pages Input/sec",
    "the hard-fault rate must be the FIRST counter read — it is the only one that separates out-of-RAM from busy",
  );
  assert.ok(
    MACHINE_COUNTERS.includes("\\Memory\\Available MBytes"),
    "available MB is the second half of the memory verdict",
  );
  assert.ok(
    MACHINE_COUNTERS.includes("\\PhysicalDisk(_Total)\\% Idle Time"),
    "the disk reading is kept deliberately, so the report can state that it proves nothing about paging",
  );

  // The disk figure may be PRINTED, but it must not be reasoned from. If it ever appears inside
  // verdict(), the 2026-09-17 inference ("disk idle, so not paging") has been rebuilt.
  const start = source.indexOf("function verdict(");
  assert.ok(start > 0, "verdict() must exist");
  const end = source.indexOf("\nfunction ", start + 1);
  const verdictBody = source.slice(start, end > start ? end : undefined);
  assert.ok(
    !verdictBody.includes("diskIdlePct"),
    "verdict() must never key off the disk reading: a 95%-idle NVMe was serving 9,447 hard faults/sec on 2026-10-08",
  );
  assert.ok(
    verdictBody.includes("pagesInPerSec"),
    "verdict() must reach its top finding from the hard-fault rate",
  );
}

/** Thresholds must stay ordered and tied to this box's measured failure points. */
function thresholdsAreCoherent(): void {
  assert.ok(
    THRESHOLDS.pagesInPressure < THRESHOLDS.pagesInThrashing,
    "the pressure threshold must sit below the thrashing threshold",
  );
  assert.ok(
    THRESHOLDS.availableFreezeMB < THRESHOLDS.availableFloorMB,
    "the freeze line must sit below mem-watchdog.ps1's reap floor, not above it",
  );
  assert.equal(
    THRESHOLDS.availableFloorMB,
    1800,
    "the reap floor is mem-watchdog.ps1's own 1,800 MB — changing it here desynchronises the audit from what actually reaps a job",
  );
  for (const [name, value] of Object.entries(THRESHOLDS)) {
    assert.ok(Number.isFinite(value) && value > 0, `${name} must be a positive number`);
  }
}

/**
 * The sentinel. Each case here is a shape GitHub really returns, and the last one is the exact
 * payload shape that produced the 719s "Test" misreport.
 */
function skippedStepsAreNeverCountedAsWork(): void {
  assert.equal(
    spanSeconds("0001-01-01T00:00:00Z", "2026-10-07T22:08:01Z"),
    null,
    "a skipped step's sentinel start must yield null, never ~63 billion seconds",
  );
  assert.equal(
    spanSeconds("2026-10-07T22:02:55Z", "0001-01-01T00:00:00Z"),
    null,
    "the sentinel must be rejected on the completedAt side too",
  );
  assert.equal(spanSeconds(null, "2026-10-07T22:08:01Z"), null, "a null timestamp is not a duration");
  assert.equal(spanSeconds("not-a-date", "2026-10-07T22:08:01Z"), null, "an unparseable timestamp is not a duration");
  assert.equal(
    spanSeconds("2026-10-07T22:08:01Z", "2026-10-07T22:02:55Z"),
    null,
    "a negative span is corrupt data, not a fast job",
  );
  assert.equal(
    spanSeconds("2026-10-07T22:02:55Z", "2026-10-07T22:08:19Z"),
    324,
    "a real span must come back in seconds",
  );

  // Modelled on main run 37693593943: `validate` BUILT for 246s and SKIPPED Test; `checks` ran
  // Typecheck and Test. Before the fix, validate's dominant step was reported as the skipped
  // "Test" at ~63 billion seconds — i.e. the audit pointed at a step that does not run on a push.
  const payload = {
    jobs: [
      {
        name: "validate",
        conclusion: "success",
        startedAt: "2026-10-07T22:02:55Z",
        completedAt: "2026-10-07T22:08:19Z", // 324s
        steps: [
          { name: "Set up Node.js", conclusion: "success", startedAt: "2026-10-07T22:03:00Z", completedAt: "2026-10-07T22:03:15Z" },
          { name: "Build", conclusion: "success", startedAt: "2026-10-07T22:03:20Z", completedAt: "2026-10-07T22:07:26Z" }, // 246s
          { name: "Test", conclusion: "skipped", startedAt: "0001-01-01T00:00:00Z", completedAt: "0001-01-01T00:00:00Z" },
        ],
      },
      {
        name: "checks",
        conclusion: "success",
        startedAt: "2026-10-07T22:02:55Z",
        completedAt: "2026-10-07T22:07:14Z", // 259s
        steps: [
          { name: "Typecheck", conclusion: "success", startedAt: "2026-10-07T22:03:10Z", completedAt: "2026-10-07T22:03:57Z" }, // 47s
          { name: "Test", conclusion: "success", startedAt: "2026-10-07T22:04:00Z", completedAt: "2026-10-07T22:06:32Z" }, // 152s
        ],
      },
      {
        // A wholly skipped job carries the sentinel on the JOB as well, so the guard is needed twice.
        name: "full-e2e",
        conclusion: "skipped",
        startedAt: "0001-01-01T00:00:00Z",
        completedAt: "0001-01-01T00:00:00Z",
        steps: [],
      },
    ],
  };

  const s = summarizeRun(payload);
  assert.ok(s, "a run with two successful jobs must summarise");
  assert.deepEqual(
    s.jobs.map((j) => j.name).sort(),
    ["checks", "validate"],
    "a skipped job must not appear as work that happened",
  );

  const validate = s.jobs.find((j) => j.name === "validate")!;
  assert.equal(
    validate.dominant,
    "Build",
    "validate's dominant step on a push is Build — naming the skipped Test here is the bug this test exists for",
  );
  assert.equal(validate.dominantSecs, 246, "and it must be reported at its real duration");

  const checks = s.jobs.find((j) => j.name === "checks")!;
  assert.equal(checks.dominant, "Test", "checks really is dominated by the suite on a push event");
  assert.equal(checks.dominantSecs, 152);

  assert.equal(
    s.criticalPathSecs,
    324,
    "the critical path is the SLOWEST job, because jobs run in parallel — that is the wait",
  );
  assert.equal(s.billedSecs, 324 + 259, "billed seconds are the SUM across jobs");
  assert.equal(
    s.billedMinutesRounded,
    6 + 5,
    "Actions rounds every job up to a whole minute, so 324s + 259s bills as 6 + 5, not as 10",
  );
  assert.ok(
    s.billedMinutesRounded > Math.ceil(s.criticalPathSecs / 60),
    "the bill must always exceed the wait on a multi-job run — reporting one as the other is how a wait gets blamed on a bill",
  );

  assert.equal(summarizeRun({ jobs: [] }), null, "a run with no readable job must return null, not a zeroed summary");
  assert.equal(summarizeRun({}), null, "a payload with no jobs key must return null");
  assert.equal(summarizeRun(null), null, "an unreadable payload must return null rather than throw mid-audit");
}

/** An audit must not be the thing that tips the box over, and must never spawn a hook that acts. */
function theAuditOnlyEverObserves(): void {
  // 🔴 Asserted against the DECLARATION, not the installed-and-filtered list. HOOKS() drops any
  // probe whose file is missing, so an acting hook declared with a path that does not resolve on
  // this machine would slip past a check made against HOOKS() — which is exactly how a deliberate
  // break passed while this test was being written. Every label AND every resolved script path is
  // checked, so neither the name nor the file can smuggle one in.
  const declared = HOOK_PROBES("F:/Phoenix Workforce/phoenix-workforce");
  assert.ok(declared.length > 0, "the hook probe list must not be empty");
  const surface = declared.flatMap(([label, script, args]) => [label, script, ...args]);

  for (const acting of [/dev-server-reaper/i, /\bsweep\b/i, /mem-watchdog/i, /repo-archive/i, /scratchpad-archive/i]) {
    const hit = surface.find((s) => acting.test(s));
    assert.equal(
      hit,
      undefined,
      `the audit may only time hooks that REPORT; ${JSON.stringify(hit)} matches ${acting} and acts (stops processes, archives or deletes files)`,
    );
  }
  assert.ok(
    declared.some(([label, , args]) => /scratchpad-guard/.test(label) && args.includes("pre")),
    "scratchpad-guard is timed in its read-only `pre` mode only — that mode is a real part of the per-call cost",
  );
  assert.ok(
    HOOKS("F:/Phoenix Workforce/phoenix-workforce").length <= declared.length,
    "HOOKS() must be the declaration filtered by existence, never a superset of it",
  );

  // Every externally-spawned command, by name. The script may start PowerShell (counters), gh (CI)
  // and node (hook probes, via process.execPath) and nothing else.
  const spawned = [...source.matchAll(/\brun\(\s*(['"])([^'"]+)\1/g)].map((m) => m[2]);
  const allowed = new Set(["powershell.exe", "gh"]);
  for (const cmd of spawned) {
    assert.ok(allowed.has(cmd), `slow-audit.mjs may not spawn ${cmd} — allowed: ${[...allowed].join(", ")} and node`);
  }

  // No heavy job, in any spelling, anywhere in the file.
  for (const forbidden of ["run build", "run typecheck", "run test", "next dev", "tsc ", "--noEmit", "test:sharded", "dev-server.mjs"]) {
    assert.ok(
      !source.includes(forbidden),
      `slow-audit.mjs must never invoke a heavy job: found ${JSON.stringify(forbidden)}`,
    );
  }

  // The hook probe payload must be a read-only command, or timing the guards would run work.
  assert.ok(
    source.includes("git status --porcelain"),
    "the hook probe payload must stay a read-only command",
  );
}

/** Importing the module must not launch an audit — the test suite would spawn PowerShell per run. */
function importingIsSideEffectFree(): void {
  assert.ok(
    source.includes("pathToFileURL(process.argv[1]).href === import.meta.url"),
    "main() must be gated on direct invocation, or importing this module from a test starts a real audit",
  );
  assert.ok(
    typeof summarizeRun === "function" && typeof spanSeconds === "function",
    "the pure helpers must be exported so they can be exercised without running an audit",
  );
}

/**
 * Claude Code starts every matching PreToolUse hook at once, so a tool call waits for the SLOWEST
 * one. The audit used to sum them and print the sum as the per-call cost — 1,008ms "per Bash call"
 * on 2026-10-08 was CPU across ten processes, not time the call stood still.
 */
function hookWaitIsTheSlowestNotTheSum(): void {
  const c = hookCost([
    { label: "bash-guard", ms: 120, fires: ["bash"] },
    { label: "trap-injector", ms: 300, fires: ["bash", "edit"] },
    { label: "session-lock beat", ms: 80, fires: ["bash", "edit"] },
    { label: "primary-write-guard", ms: 500, fires: ["edit"] },
  ]);
  assert.equal(c.waitPerBashCallMs, 300, "the Bash wait must be the slowest Bash hook, not the sum of all of them");
  assert.equal(c.slowestBashHook, "trap-injector", "the report must name the hook that sets the wait");
  assert.equal(c.cpuPerBashCallMs, 500, "the sum is still reported — as CPU, under its own name");
  assert.equal(c.waitPerEditCallMs, 500, "an Edit-only hook sets the Edit wait and never the Bash one");
  assert.equal(c.cpuPerEditCallMs, 880, "Edit CPU sums only the hooks registered for Edit");
  assert.equal(c.waitPerReadCallMs, 0, "a tool kind with no hook waits for nothing");
  assert.equal(c.spawnsPerBashCall, 3);
  assert.ok(!("perBashCallMs" in c), "the old summed field must not come back under the name that read as a wait");
  assert.ok(
    THRESHOLDS.hookBudgetMs < 1000 && /SLOWEST/.test(source.match(/hookBudgetMs:.*/)?.[0] ?? ""),
    "the hook budget must be documented as a limit on the slowest hook",
  );
}

/**
 * Layer 6 — the transcript fold. On 2026-10-08 the two costs that dominated were only visible in
 * the transcripts: 176 auto-compactions in three days at a median 132s each, and every compaction
 * re-running the SessionStart hooks (1,087 compact runs against 514 at startup). A before/after
 * comparison of a fix is only honest if both sides are computed by the same arithmetic, so each
 * rule of that arithmetic is pinned here against a fixture shaped like real transcript lines.
 */
function transcriptFoldMeasuresWhatSessionsWaitedFor(): void {
  // Cairo midnight, not UTC midnight — and DST-correct on both sides of Egypt's October change.
  assert.equal(cairoMidnightMs("2026-10-06"), Date.parse("2026-10-05T21:00:00Z"), "October is UTC+3 in Cairo");
  assert.equal(cairoMidnightMs("2026-12-01"), Date.parse("2026-11-30T22:00:00Z"), "December is UTC+2 in Cairo");
  assert.equal(cairoMidnightMs("not-a-day"), null, "an unreadable --since must be refused, not read as 1970");

  assert.equal(contextBucket(99_999), "<100k");
  assert.equal(contextBucket(100_000), "100-150k", "a bucket's lower edge belongs to it");
  assert.equal(contextBucket(450_000), "400k+");

  assert.equal(hookLabel('node "C:/x/.claude/hooks/scratchpad-guard.mjs" sweep'), "scratchpad-guard sweep", "a hook's mode word is part of its name");
  assert.equal(hookLabel('node "$DIR/scripts/sync-worktree-env.mjs" --all'), "sync-worktree-env", "a --flag is not");
  assert.equal(
    hookLabel("Checking memory index budget", "SessionStart:compact"),
    "Checking memory index budget",
    "a hook with a statusMessage is recorded with that text as its command — naming it by hookName folds every such hook into one row",
  );

  const line = (o: Record<string, unknown>) => JSON.stringify(o);
  const usage = (tokens: number) => ({ message: { usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0 } } });
  const stats = createTranscriptStats({ sinceMs: cairoMidnightMs("2026-10-06")!, untilMs: cairoMidnightMs("2026-10-09")! });

  stats.begin(); // session one
  for (const raw of [
    "not json — a torn last line must be skipped, never throw",
    // 23:30 Cairo on 5 Oct: before the window, so this compaction must not count.
    line({ type: "system", subtype: "compact_boundary", timestamp: "2026-10-05T20:30:00Z", compactMetadata: { durationMs: 999_000, preTokens: 1 } }),
    line({ type: "attachment", timestamp: "2026-10-07T09:59:00Z", attachment: { type: "hook_success", hookName: "SessionStart:startup", hookEvent: "SessionStart", command: 'node "C:/u/.claude/hooks/session-lock.mjs" start', durationMs: 500 } }),
    line({ type: "attachment", timestamp: "2026-10-07T09:59:00Z", attachment: { type: "hook_success", hookName: "SessionStart:startup", hookEvent: "SessionStart", command: "Checking memory index budget", durationMs: 2000 } }),
    line({ type: "attachment", timestamp: "2026-10-07T09:59:01Z", attachment: { type: "instructions", files: [{ content: "x".repeat(2048) }] } }),
    // nested_memory carries an OBJECT; measuring it as a string reads 0 bytes of module memory.
    line({ type: "attachment", timestamp: "2026-10-07T09:59:02Z", attachment: { type: "nested_memory", content: { path: "a", content: "y".repeat(4071) } } }),
    line({ type: "attachment", timestamp: "2026-10-07T09:59:03Z", attachment: { type: "hook_additional_context", hookName: "UserPromptSubmit", content: ["a".repeat(1024), "b".repeat(1024)] } }),
    line({ type: "user", timestamp: "2026-10-07T10:00:00Z" }),
    line({ type: "assistant", timestamp: "2026-10-07T10:00:05Z", ...usage(120_000) }), // 5s at 100-150k
    line({ type: "user", isMeta: true, timestamp: "2026-10-07T10:00:06Z" }),
    line({
      type: "system", subtype: "stop_hook_summary", timestamp: "2026-10-07T10:00:07Z",
      hookInfos: [
        { command: 'node "C:/u/.claude/hooks/relay-capture.mjs"', durationMs: 600 },
        { command: 'node "C:/u/.claude/hooks/next-step-capture.mjs"', durationMs: 200 },
        { command: "callback" }, // an in-app callback carries no duration and is not a hook wait
      ],
    }),
    line({ type: "system", subtype: "compact_boundary", timestamp: "2026-10-07T12:00:00Z", compactMetadata: { durationMs: 150_000, preTokens: 370_000 } }),
    line({ type: "attachment", timestamp: "2026-10-07T12:00:01Z", attachment: { type: "hook_success", hookName: "SessionStart:compact", hookEvent: "SessionStart", command: "Provisioning node_modules + env in all worktrees", durationMs: 1500 } }),
    line({ type: "user", timestamp: "2026-10-07T12:00:10Z" }),
    line({ type: "assistant", timestamp: "2026-10-07T12:00:16Z", ...usage(130_000) }), // the floor, and 6s at 100-150k
    line({ type: "user", timestamp: "2026-10-07T12:01:00Z" }),
    line({ type: "assistant", timestamp: "2026-10-07T12:01:08Z", ...usage(350_000) }), // 8s at 300-400k
    line({ type: "assistant", timestamp: "2026-10-07T12:01:09Z", ...usage(351_000) }), // no user line before it: not a wait
  ]) stats.line(raw);

  stats.begin(); // session two
  for (const raw of [
    // 01:30 Cairo on 8 Oct — still 7 Oct in UTC. The day must be Cairo's.
    line({ type: "system", subtype: "compact_boundary", timestamp: "2026-10-07T22:30:00Z", compactMetadata: { durationMs: 210_000 } }),
    // 00:30 Cairo on 9 Oct: --until is exclusive, so this must not count.
    line({ type: "system", subtype: "compact_boundary", timestamp: "2026-10-08T21:30:00Z", compactMetadata: { durationMs: 999_000 } }),
  ]) stats.line(raw);

  const r = stats.finish();
  assert.equal(r.sessions, 2);
  assert.equal(r.compactions.count, 2, "compactions outside the Cairo-day window must not count");
  assert.equal(r.compactions.hours, 0.1, "150s + 210s is 0.1 hours frozen");
  assert.deepEqual(r.compactions.byDay, [{ day: "2026-10-07", count: 1, hours: 0 }, { day: "2026-10-08", count: 1, hours: 0.1 }], "compactions are grouped by CAIRO day");
  assert.equal(r.compactions.medianPreTokens, 370_000, "a boundary with no preTokens is left out, not counted as zero");
  assert.equal(r.compactions.medianFloorTokens, 130_000, "the floor is the FIRST assistant context after a compaction");

  assert.deepEqual(
    r.turnLatency.map((t) => [t.bucket, t.turns]),
    [["100-150k", 2], ["300-400k", 1]],
    "a turn's wait is bucketed by its own context, and an assistant line with no user line before it is not a wait",
  );
  assert.equal(r.turnLatency[0].p50Secs, 6);

  assert.equal(r.stopWait.turns, 1);
  assert.equal(
    r.stopWait.p50Ms,
    600,
    "Stop hooks run in parallel: the turn-end wait is the SLOWEST timed hook (600ms), never the sum (800ms)",
  );
  const hook = (name: string) => r.hooks.find((h) => h.hook === name);
  assert.equal(hook("Stop relay-capture")?.p50Ms, 600);
  assert.ok(!r.hooks.some((h) => /callback|\?$/.test(h.hook)), "an untimed callback entry must not become a hook row");
  assert.equal(hook("SessionStart session-lock start")?.n, 1);
  assert.equal(hook("SessionStart Provisioning node_modules + env in all worktrees")?.p50Ms, 1500);

  assert.deepEqual(r.sessionStartRuns, { startup: 2, compact: 1 }, "SessionStart runs are counted by their source");
  assert.equal(r.injectedPerSessionKB.instructions, 1, "2 KB of rules over two sessions");
  assert.equal(r.injectedPerSessionKB.moduleMemory, 2, "module memory is measured as the JSON of its object, 4 KB over two sessions");
  assert.equal(r.injectedPerSessionKB.hookContext.UserPromptSubmit, 1);

  // The before/after rates divide by the window's length, so a 3-day baseline compares with a 1-day after.
  const rates = transcriptRates({
    days: 2,
    compactions: { count: 10, hours: 3 },
    sessionStartRuns: { compact: 40 },
    stopWait: { p50Ms: 500 },
    hooks: [{ hook: "PreToolUse hook-dispatch PreToolUse", p50Ms: 611 }],
    injectedPerSessionKB: { hookContext: { UserPromptSubmit: 55 } },
  });
  assert.deepEqual(rates, {
    compactionsPerDay: 5,
    hoursCompactingPerDay: 1.5,
    startHookRunsOnCompactPerDay: 20,
    stopWaitP50Ms: 500,
    dispatcherP50Ms: 611,
    promptHookKBPerSession: 55,
  });

  // Layer 6 reads files only. It must never start a process to do so.
  const start = source.indexOf("export function createTranscriptStats(");
  const end = source.indexOf("// The verdict.", start);
  assert.ok(start > 0 && end > start, "the transcript layer must exist where this test expects it");
  assert.ok(!/\b(run|ps|spawn)\(/.test(source.slice(start, end)), "the transcript layer must never spawn a process");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-09 (hook speed fixes) — four measurements added to the fold, the limits a record is
// checked against, and `--check`. Each was added so a fix to the hooks can be proved (or a
// regression caught) from what the sessions themselves recorded, not from a probe timed on an
// idle box. Every assertion below was watched failing against a deliberate break before it landed.
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW = () => ({ sinceMs: cairoMidnightMs("2026-10-06")!, untilMs: cairoMidnightMs("2026-10-09")! });
const jsonl = (o: Record<string, unknown>) => JSON.stringify(o);

/**
 * A tool call's wall time is its tool_use to its tool_result. A Read is near-instant on its own,
 * so in a Phoenix session its wall time is close to pure hook overhead — the figure a hook fix moves.
 */
function toolWallIsTimedPerProjectAndTool(): void {
  const call = (ts: string, id: string, name: string, input: Record<string, unknown> = {}) =>
    jsonl({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (ts: string, id: string) =>
    jsonl({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  const stats = createTranscriptStats(WINDOW());

  // A worktree's folder: "Phoenix" only in capitals, so the match must ignore case.
  stats.begin("F--Phoenix-Workforce--wt-hook-speed-9oct");
  for (const raw of [
    call("2026-10-07T10:00:00.000Z", "t1", "Read"),
    result("2026-10-07T10:00:00.250Z", "t1"),
    call("2026-10-07T10:00:01.000Z", "t2", "Read"),
    result("2026-10-07T10:00:01.350Z", "t2"),
    // A background Bash returns at once; counting it would drag the median DOWN.
    call("2026-10-07T10:00:02.000Z", "t3", "Bash", { command: "gh run watch", run_in_background: true }),
    result("2026-10-07T10:00:02.005Z", "t3"),
    call("2026-10-07T10:00:03.000Z", "t4", "Bash", { command: "git status --porcelain" }),
    result("2026-10-07T10:00:04.200Z", "t4"),
    // An Agent call is minutes of model work, not hook overhead.
    call("2026-10-07T10:00:05.000Z", "t5", "Agent"),
    result("2026-10-07T10:09:05.000Z", "t5"),
    result("2026-10-07T10:09:06.000Z", "never-opened"),
    call("2026-10-07T10:10:00.000Z", "t7", "Write"), // left open: its result never arrives in this file
  ]) stats.line(raw);

  stats.begin(); // no folder name: must still work, and counts as 'other'
  for (const raw of [
    result("2026-10-07T11:00:00.000Z", "t7"), // a result in ANOTHER file must never close t7
    call("2026-10-07T11:00:01.000Z", "t6", "Glob"),
    result("2026-10-07T11:00:01.090Z", "t6"),
  ]) stats.line(raw);

  const r = stats.finish();
  assert.deepEqual(
    r.toolWall.phoenix.Read,
    { n: 2, p50Ms: 350, p90Ms: 350 },
    "a Read's wall time runs from its tool_use to the tool_result with the same id, filed under 'phoenix' for a folder named Phoenix in any case",
  );
  assert.equal(r.toolWall.phoenix.Bash?.n, 1, "a run_in_background Bash returns at once and must not be timed");
  assert.deepEqual(
    r.toolWall.other,
    { Glob: { n: 1, p50Ms: 90, p90Ms: 90 } },
    "begin() with no folder name counts as 'other' (never inherits the previous file's kind), and a call left open in one file is never closed by a result in another",
  );
  assert.deepEqual(Object.keys(r.toolWall.phoenix), ["Read", "Bash"], "only the tools a hook can stretch are timed: Agent is not");
}

/** All SessionStart hooks of one start run in parallel, so the session waits for the slowest. */
function sessionStartWaitIsTheSlowestHookOfEachStart(): void {
  const row = (ts: string, durationMs: number, toolUseID?: string, hookEvent = "SessionStart", hookName = "SessionStart:startup") =>
    jsonl({ type: "attachment", timestamp: ts, attachment: { type: "hook_success", hookEvent, hookName, toolUseID, command: "x", durationMs } });
  const stats = createTranscriptStats(WINDOW());

  stats.begin("F--Phoenix-Workforce-phoenix-workforce");
  for (const raw of [
    row("2026-10-07T09:00:00Z", 200, "A"),
    row("2026-10-07T09:00:00Z", 900, "A"),
    row("2026-10-07T09:00:00Z", 400, "A"),
    row("2026-10-07T09:00:00Z", 99_999), // no toolUseID: cannot be tied to a start, skipped
    row("2026-10-07T09:00:01Z", 50_000, "A", "PreToolUse", "PreToolUse:Bash"), // not a SessionStart row
    row("2026-10-07T12:00:00Z", 1500, "B", "SessionStart", "SessionStart:compact"),
    row("2026-10-07T12:00:00Z", 300, "B", "SessionStart", "SessionStart:compact"),
  ]) stats.line(raw);
  stats.begin("F--Phoenix-Workforce-phoenix-workforce");
  stats.line(row("2026-10-07T13:00:00Z", 100, "A")); // the same id in another file is another start

  const r = stats.finish();
  assert.equal(r.sessionStartWait.starts, 3, "one start per toolUseID per file; a row with no toolUseID is skipped");
  assert.equal(r.sessionStartWait.maxMs, 1500, "a start waits for its SLOWEST hook (1,500ms), never the sum (1,800ms)");
  assert.deepEqual(r.sessionStartWait, { starts: 3, p50Ms: 900, p90Ms: 1500, maxMs: 1500 }, "starts of 900, 1,500 and 100ms");
}

/**
 * Hook text that repeats what the session already holds fills the context for nothing and brings
 * the next compaction closer. Module memory and rules files are deliberately NOT measured.
 */
function repeatedHookTextIsCountedPerCompactionCycle(): void {
  const ctx = (ts: string, content: string | string[]) =>
    jsonl({ type: "attachment", timestamp: ts, attachment: { type: "hook_additional_context", hookName: "UserPromptSubmit", content } });
  const X = "x".repeat(1000), W = "w".repeat(300), Z = "z".repeat(200);
  const stats = createTranscriptStats(WINDOW());

  stats.begin("F--Phoenix-Workforce-phoenix-workforce");
  for (const raw of [
    ctx("2026-10-05T20:00:00Z", W), // 23:00 Cairo on 5 Oct: before the window, so it only SEEDS
    ctx("2026-10-07T10:00:00Z", W), // ...and this in-window copy is therefore a repeat
    ctx("2026-10-07T10:00:01Z", [X]),
    ctx("2026-10-07T10:00:02Z", X), // a string body is a text too, and this one is a repeat
    jsonl({ type: "attachment", timestamp: "2026-10-07T10:00:03Z", attachment: { type: "nested_memory", content: { path: "m", content: X } } }),
    jsonl({ type: "attachment", timestamp: "2026-10-07T10:00:04Z", attachment: { type: "instructions", files: [{ content: X }] } }),
    jsonl({ type: "system", subtype: "compact_boundary", timestamp: "2026-10-07T11:00:00Z", compactMetadata: { durationMs: 60_000 } }),
    ctx("2026-10-07T11:00:01Z", [X, Z]), // after a compaction the context is new: NOT a repeat
    ctx("2026-10-07T11:00:02Z", [X]), // ...until it arrives twice in the new cycle
  ]) stats.line(raw);
  stats.begin("F--Phoenix-Workforce-phoenix-workforce");
  stats.line(ctx("2026-10-07T12:00:00Z", X)); // another file: new

  const r = stats.finish();
  assert.equal(r.repeatedHookText.chars, 5500, "only hook_additional_context is measured: module memory and rules files are never put against a limit");
  assert.equal(
    r.repeatedHookText.repeatedChars,
    2300,
    "a repeat is the same text again in the same file AND the same compaction cycle, with text from before the window still counted as seen",
  );
  assert.deepEqual(r.repeatedHookText, { chars: 5500, repeatedChars: 2300, share: 0.4182 }, "share is repeated chars over all chars");

  const empty = createTranscriptStats().finish();
  assert.deepEqual(
    {
      toolWall: empty.toolWall,
      sessionStartWait: empty.sessionStartWait,
      repeatedHookText: empty.repeatedHookText,
      compactSummaries: empty.compactSummaries,
    },
    {
      toolWall: { phoenix: {}, other: {} },
      sessionStartWait: { starts: 0, p50Ms: null, p90Ms: null, maxMs: null },
      repeatedHookText: { chars: 0, repeatedChars: 0, share: null },
      compactSummaries: { n: 0, p50Chars: null, maxChars: null, defaultNine: 0 },
    },
    "an empty window reports nulls, never a zero dressed as a measurement",
  );
}

/** A compaction freezes the session while its summary is written, so the summary's length is the cost. */
function compactSummariesAreSizedAndTheDefaultTemplateCaught(): void {
  const summary = (ts: string, content: unknown, isCompactSummary = true) =>
    jsonl({ type: "user", timestamp: ts, isCompactSummary, message: { role: "user", content } });
  const stats = createTranscriptStats(WINDOW());
  stats.begin("C--Users-satoh");
  for (const raw of [
    summary("2026-10-07T10:00:00Z", ("1. Primary Request and Intent: " + "p".repeat(20_000)).slice(0, 12_000)),
    summary("2026-10-07T11:00:00Z", [{ type: "text", text: "a".repeat(3500) }, { type: "text", text: "b".repeat(3499) }]), // 7,000 joined
    summary(
      "2026-10-07T12:00:00Z",
      ('## His words\n- count summaries containing "Key Technical Concepts" or "Primary Request and Intent"\n' + "h".repeat(5000)).slice(0, 4000),
    ),
    summary("2026-10-07T13:00:00Z", "Key Technical Concepts — an ordinary prompt quoting the heading", false),
  ]) stats.line(raw);

  const r = stats.finish();
  assert.equal(r.compactSummaries.n, 3, "only lines flagged isCompactSummary are summaries");
  assert.equal(
    r.compactSummaries.defaultNine,
    1,
    "a summary with Claude Code's default nine-section headings is counted; one that only quotes a heading mid-line is not",
  );
  assert.deepEqual(
    r.compactSummaries,
    { n: 3, p50Chars: 7000, maxChars: 12_000, defaultNine: 1 },
    "a summary's length is its string content, or its text blocks joined",
  );
}

/**
 * The limits. A value alarms only when strictly ABOVE its limit and only on its minimum sample, so a
 * quiet day cannot alarm on one slow call. The sentence is for the owner: no file names, and a hook
 * is named only in its own `hook` field.
 */
function transcriptLimitsAlarmOnlyOnRealSamples(): void {
  // A record sitting EXACTLY on every limit with EXACTLY the minimum sample: clean.
  const atLimit = () => ({
    toolWall: {
      phoenix: { Read: { n: 50, p50Ms: 400, p90Ms: 900 } },
      other: { Read: { n: 999, p50Ms: 9999, p90Ms: 9999 } }, // another project's reads are not Phoenix's limit
    },
    hooks: [
      { hook: "PreToolUse hook-dispatch PreToolUse", n: 20, p50Ms: 300, p90Ms: 3000, maxMs: 60_000 },
      { hook: "UserPromptSubmit relay-capture", n: 20, p50Ms: 800, p90Ms: 5000, maxMs: 90_000 },
      // Rows for other events are measured, never put against these limits.
      { hook: "SessionStart Provisioning node_modules + env in all worktrees", n: 99, p50Ms: 9000, p90Ms: 17_500, maxMs: 120_000 },
      { hook: "Stop next-step-capture", n: 99, p50Ms: 5000, p90Ms: 9000, maxMs: 120_000 },
    ],
    sessionStartWait: { starts: 10, p50Ms: 1000, p90Ms: 2500, maxMs: 9000 },
    stopWait: { turns: 20, p50Ms: 800, p90Ms: 2000 },
    repeatedHookText: { chars: 50_000, repeatedChars: 7500, share: 0.15 },
    compactSummaries: { n: 3, p50Chars: 10_000, maxChars: 30_000, defaultNine: 0 },
    compactions: { count: 3, p50Secs: 90 },
  });
  type Rec = ReturnType<typeof atLimit>;

  assert.deepEqual(transcriptAlarms(atLimit()), [], "a record exactly at every limit, other projects and other hook events included, crosses none");
  assert.ok(
    !Object.keys(TRANSCRIPT_LIMITS).some((k) => /memory|instruction|rules/i.test(k)),
    "module memory and rules files are never measured against a limit",
  );

  const PRE = "PreToolUse hook-dispatch PreToolUse";
  const UPS = "UserPromptSubmit relay-capture";
  // [limit, the value that crosses it, push it over, then thin its sample to one under the minimum, hook]
  const cases: [keyof typeof TRANSCRIPT_LIMITS, number, (r: Rec) => void, (r: Rec) => void, string | null][] = [
    ["phoenixReadP50Ms", 401, (r) => { r.toolWall.phoenix.Read.p50Ms = 401; }, (r) => { r.toolWall.phoenix.Read.n = 49; }, null],
    ["preToolUseP90Ms", 3001, (r) => { r.hooks[0].p90Ms = 3001; }, (r) => { r.hooks[0].n = 19; }, PRE],
    ["preToolUseMaxMs", 60_001, (r) => { r.hooks[0].maxMs = 60_001; }, (r) => { r.hooks[0].n = 0; }, PRE],
    ["sessionStartP90Ms", 2501, (r) => { r.sessionStartWait.p90Ms = 2501; }, (r) => { r.sessionStartWait.starts = 9; }, null],
    ["userPromptSubmitP50Ms", 801, (r) => { r.hooks[1].p50Ms = 801; }, (r) => { r.hooks[1].n = 19; }, UPS],
    ["stopWaitP50Ms", 801, (r) => { r.stopWait.p50Ms = 801; }, (r) => { r.stopWait.turns = 19; }, null],
    ["repeatedHookTextShare", 0.16, (r) => { r.repeatedHookText.share = 0.16; }, (r) => { r.repeatedHookText.chars = 49_999; }, null],
    ["compactSummaryP50Chars", 10_001, (r) => { r.compactSummaries.p50Chars = 10_001; }, (r) => { r.compactSummaries.n = 2; }, null],
    ["compactDefaultNine", 1, (r) => { r.compactSummaries.defaultNine = 1; }, (r) => { r.compactSummaries.n = 0; }, null],
    ["compactP50Secs", 91, (r) => { r.compactions.p50Secs = 91; }, (r) => { r.compactions.count = 2; }, null],
  ];
  assert.deepEqual(
    cases.map(([key]) => key).sort(),
    Object.keys(TRANSCRIPT_LIMITS).sort(),
    "every limit has a case that fires it and a case one sample short of its minimum",
  );

  for (const [key, value, over, thin, hook] of cases) {
    const hot = atLimit();
    over(hot);
    const alarms = transcriptAlarms(hot);
    assert.deepEqual(
      alarms.map((a) => [a.key, a.value, a.limit, a.hook ?? null]),
      [[key, value, TRANSCRIPT_LIMITS[key].limit, hook]],
      `${key}: one step over its limit must raise exactly one alarm${hook ? `, naming the hook in its own field` : ""}`,
    );
    const say = alarms[0].say;
    assert.ok(/^[A-Z0-9][^\n]*\.$/.test(say) && !/\.\s+[A-Z]/.test(say), `${key}: the owner gets one plain sentence, got ${JSON.stringify(say)}`);
    assert.ok(!/\.(mjs|js|ts|json|jsonl|md|ps1)\b|[\\/]/.test(say), `${key}: no file name or path in what the owner reads, got ${JSON.stringify(say)}`);
    assert.ok(!hook || !say.includes(hook.split(" ")[1]), `${key}: the hook is named only in its own field, never in the sentence`);

    const quiet = atLimit();
    over(quiet);
    thin(quiet);
    assert.deepEqual(transcriptAlarms(quiet), [], `${key}: one sample under its minimum must not alarm — a quiet day cannot`);
  }
}

/** `--check` judges the record it just logged, says so in plain words, and never fails the run. */
function checkFlagReportsWithoutFailing(): void {
  const start = source.indexOf("async function transcriptAudit(");
  const audit = source.slice(start, source.indexOf("// The verdict.", start));
  const check = audit.slice(audit.indexOf("if (CHECK)"));
  assert.ok(start > 0 && audit.includes("if (CHECK)") && check.includes("transcriptAlarms(rec)"), "--check must judge the very record --transcripts just built");
  assert.ok(
    audit.indexOf("appendFileSync(TRANSCRIPT_LOG") > 0 && audit.indexOf("appendFileSync(TRANSCRIPT_LOG") < audit.indexOf("if (CHECK)"),
    "the record is logged exactly as without --check, BEFORE it is judged",
  );
  assert.ok(check.includes("'no limit crossed'"), "a clean check must say so in words, not print nothing");
  assert.ok(!/exitCode|process\.exit\(/.test(check), "--check must leave the exit code at 0: a crossed limit is a finding, not a failed audit");
  assert.ok(
    /ALARMS_FILE = [^\n]*'slow-audit-alarms\.json'/.test(source) && check.includes("JSON.stringify({ at: rec.at, since: rec.since, until: rec.until, alarms }"),
    "--check writes { at, since, until, alarms } to ~/.claude/logs/slow-audit-alarms.json",
  );
}

export async function runSlowAuditTests(): Promise<void> {
  counterChoiceIsPinned();
  thresholdsAreCoherent();
  skippedStepsAreNeverCountedAsWork();
  theAuditOnlyEverObserves();
  importingIsSideEffectFree();
  hookWaitIsTheSlowestNotTheSum();
  transcriptFoldMeasuresWhatSessionsWaitedFor();
  toolWallIsTimedPerProjectAndTool();
  sessionStartWaitIsTheSlowestHookOfEachStart();
  repeatedHookTextIsCountedPerCompactionCycle();
  compactSummariesAreSizedAndTheDefaultTemplateCaught();
  transcriptLimitsAlarmOnlyOnRealSamples();
  checkFlagReportsWithoutFailing();
}
