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
  cairoMidnightMs,
  contextBucket,
  createTranscriptStats,
  hookCost,
  hookLabel,
  spanSeconds,
  summarizeRun,
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

export async function runSlowAuditTests(): Promise<void> {
  counterChoiceIsPinned();
  thresholdsAreCoherent();
  skippedStepsAreNeverCountedAsWork();
  theAuditOnlyEverObserves();
  importingIsSideEffectFree();
  hookWaitIsTheSlowestNotTheSum();
  transcriptFoldMeasuresWhatSessionsWaitedFor();
}
