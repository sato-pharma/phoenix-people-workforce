import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * bash-guard clause C9 — a repeat `workflow_dispatch` in one session.
 *
 * THE INCIDENT. On 2026-09-27 one session ran `gh workflow run` against ci.yml on
 * `codex/backup-tables-out-of-public` 71 times between 07:04 and 10:11 Cairo. Every run came back
 * `startup_failure`: GitHub creates the run, refuses to compile the workflow, and returns no logs, no
 * job list and no workflow name (they are filed under a synthetic `BuildFailed` workflow, id
 * 303299204). There was nothing to read, so the session retried — 58% of that day's failed runs from
 * one loop. The real cause was the repository losing its Pro entitlement, which no retry could reach.
 *
 * WHY A HOOK. `gh workflow run` is in neither the allow nor the deny list of `.claude/settings.json`,
 * and a wildcard grant in the gitignored `.claude/settings.local.json` or in `~/.claude/settings.json`
 * auto-approves it — a missing prompt is not a refusal (AGENTS.md §1.5). A permissions entry also
 * cannot COUNT, so "the third one" is only expressible as a hook with state.
 *
 * WHAT THIS TEST IS FOR. The allow half matters as much as the deny half, because each allowed shape
 * below is a recovery somebody actually needed:
 *   - `main` is exempt with no counter. It is §2.1's own outage recovery, main is not gated by a PR,
 *     and since #4537 main's CI run is the production deploy gate — a commit already serving
 *     production with no verdict is worse than any number of wasted runs. One session needed exactly
 *     this at 14:37 on 2026-09-27 after a push run was stranded with self-hosted labels.
 *   - `gh run rerun <id>` is never counted. It is the sanctioned recovery and what the deny points at.
 *   - the first TWO dispatches of any target are allowed, so a hand-fired workflow is untouched in
 *     normal use and a retry after a real fix still goes through.
 *   - every degraded state ALLOWS. A counter that cannot be read must never block a command, and a
 *     fail-closed read would refuse a legitimate first dispatch during an outage — precisely when it
 *     is needed.
 *
 * It drives the real hook as a subprocess, exactly as `.claude/settings.json` runs it: a test that
 * imported the matcher would pass against a hook wired to nothing. Same shape as
 * tests/local-typecheck-guard.test.ts, which pins C8.
 */
const guardPath = resolve(".claude/hooks/bash-guard.mjs");

type Decision = { decision: "allow" | "deny"; reason: string };

function makeRunner(stateDir: string, cwd: string) {
  return function runGuard(
    command: string,
    opts: { tool?: string; session?: string; ambient?: boolean } = {},
  ): Decision {
    const env = { ...process.env };
    // Strip every other possible answerer, so each deny below is C9's and each allow is C9 standing
    // aside: CLAUDE_PROJECT_DIR would let C6 answer, PHX_TYPECHECK_OK belongs to C8.
    delete env.CLAUDE_PROJECT_DIR;
    delete env.PHX_TYPECHECK_OK;
    delete env.PHX_DISPATCH_OK;
    env.PHX_DISPATCH_STATE_DIR = stateDir;
    if (opts.ambient) env.PHX_DISPATCH_OK = "1";
    const payload: Record<string, unknown> = {
      tool_name: opts.tool ?? "Bash",
      cwd,
      tool_input: { command },
    };
    if (opts.session) payload.session_id = opts.session;
    const raw = execFileSync(process.execPath, [guardPath], {
      cwd,
      input: JSON.stringify(payload),
      encoding: "utf8",
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    if (!raw.trim()) return { decision: "allow", reason: "" };
    // C5 can print a relay line before the JSON, so scan rather than parse the whole of stdout.
    const start = raw.indexOf('{"hookSpecificOutput"');
    assert.ok(start >= 0, `hook emitted something that is not a decision:\n${raw}`);
    const output = JSON.parse(raw.slice(start)).hookSpecificOutput;
    return {
      decision: output.permissionDecision,
      reason: String(output.permissionDecisionReason ?? ""),
    };
  };
}

/** Shapes that must NEVER be counted, however many times they are run. */
const NEVER_COUNTED = [
  "gh run rerun 36326554673",
  "gh run rerun 36326554673 --failed",
  "gh run watch 36326554673 --exit-status",
  "gh run list --workflow=ci.yml --branch main --limit 5 --json databaseId,event,status,conclusion",
  "gh run view 36326554673 --log-failed",
  "gh pr checks 4535",
  "gh workflow list",
  "gh workflow view ci.yml --yaml",
  "gh api repos/Omar-3-xx/phoenix-people-workforce/actions/workflows",
  'git grep -n "gh workflow run" -- docs',
  'git commit -m "docs(ci): a third gh workflow run in one session is refused"',
  'echo "never gh workflow run ci.yml twice - use gh run rerun <id>"',
];

export function runWorkflowDispatchGuardTests() {
  assert.ok(existsSync(guardPath), `bash-guard not found at ${guardPath}`);
  const stateDir = mkdtempSync(join(tmpdir(), "phx-dispatch-state-"));
  const cwd = mkdtempSync(join(tmpdir(), "phx-dispatch-cwd-"));
  const runGuard = makeRunner(stateDir, cwd);

  try {
    // The override must be live before anything else is asserted. Without this, a dropped
    // PHX_DISPATCH_STATE_DIR would write into the real ~/.claude/relay/state and every case below
    // would be order-dependent on whatever this machine happened to have done today.
    assert.equal(runGuard("gh workflow run ci.yml --ref codex/probe", { session: "probe" }).decision, "allow");
    assert.ok(
      readdirSync(stateDir).some((name) => name.startsWith("dispatch-")),
      "the state-dir override is not being honoured — the counter wrote somewhere else, so nothing below proves anything",
    );

    // ── the cap ────────────────────────────────────────────────────────────────────────────────
    const target = "gh workflow run ci.yml --ref codex/backup-tables-out-of-public";
    assert.equal(runGuard(target, { session: "A" }).decision, "allow", "the FIRST dispatch must always be allowed");
    assert.equal(runGuard(target, { session: "A" }).decision, "allow", "the second is still a plausible retry");
    const denied = runGuard(target, { session: "A" });
    assert.equal(denied.decision, "deny", `the third dispatch of one target in one session must be refused:\n${target}`);

    // The deny has to be actionable, or the next session reads it as a policy to argue with.
    assert.match(denied.reason, /startup_failure/, `the deny must name what actually happened.\n${denied.reason}`);
    assert.match(denied.reason, /statusCheckRollup/, `the deny must say WHY a dispatch cannot help.\n${denied.reason}`);
    assert.match(denied.reason, /gh run rerun/, `the deny must name the real recovery.\n${denied.reason}`);
    assert.match(denied.reason, /71 times/, `the deny must carry the measurement.\n${denied.reason}`);
    assert.match(denied.reason, /\.protected/, `the deny must point at the entitlement read first.\n${denied.reason}`);

    const advice = /^ {2}(PHX_DISPATCH_OK=1 .+)$/m.exec(denied.reason)?.[1];
    assert.ok(advice, `the deny must put the stand-down on a line of its own.\n${denied.reason}`);
    assert.equal(
      runGuard(advice, { session: "A" }).decision,
      "allow",
      `the stand-down must not be refused — a deny whose own advice is refused IS the loop this clause exists to stop: ${advice}`,
    );

    // ── the dialect of the caller ──────────────────────────────────────────────────────────────
    const ps = "gh workflow run ci.yml --ref codex/ps";
    runGuard(ps, { tool: "PowerShell", session: "P" });
    runGuard(ps, { tool: "PowerShell", session: "P" });
    const psDeny = runGuard(ps, { tool: "PowerShell", session: "P" });
    assert.equal(psDeny.decision, "deny");
    assert.match(
      psDeny.reason,
      /^ {2}\$env:PHX_DISPATCH_OK=1; /m,
      `the stand-down must be in the dialect of the tool that asked — \`PHX_DISPATCH_OK=1 <cmd>\` is not something PowerShell can run.\n${psDeny.reason}`,
    );

    // ── main is exempt, with no counter at all ─────────────────────────────────────────────────
    for (let i = 1; i <= 5; i += 1) {
      assert.equal(
        runGuard("gh workflow run ci.yml --ref main", { session: "B" }).decision,
        "allow",
        "a dispatch on `main` must never be capped: main is not gated by a PR, it is §2.1's own outage " +
          "recovery, and since #4537 main's CI run is the production deploy gate",
      );
    }
    // 🔴 THE BARE FORM — the one a session actually types when it is already on main. `gh workflow
    // run ci.yml` with no flag targets the repository's DEFAULT branch, which is main. The first
    // version of C9 keyed it as `ci@(default)`, counted it, and denied the third call while
    // `--ref main` stayed exempt: measured 2026-09-27, allow/allow/DENY against allow/allow/allow.
    // Every one of the fifteen cases in this suite's first draft passed an explicit --ref, which is
    // exactly why it shipped. During an outage there is no reason to name a ref you are already on,
    // and since #4537 that denial lands on a commit already serving production with no verdict.
    for (let i = 1; i <= 4; i += 1) {
      assert.equal(
        runGuard("gh workflow run ci.yml", { session: "BARE" }).decision,
        "allow",
        `a bare dispatch targets the DEFAULT branch, which is main, so it must never be capped (run ${i})`,
      );
    }

    // The same exemption has to survive a heredoc-fed curl: withoutHeredocBodies strips the very
    // body carrying the ref, so reading it from the stripped text lost main and made it countable.
    const heredocCurl = [
      "curl -sS -X POST https://api.github.com/repos/o/r/actions/workflows/ci.yml/dispatches -d @- <<'JSON'",
      '{"ref":"main"}',
      "JSON",
    ].join("\n");
    for (let i = 1; i <= 3; i += 1) {
      assert.equal(
        runGuard(heredocCurl, { session: "HEREDOC" }).decision,
        "allow",
        `a heredoc-fed dispatch naming main must keep the exemption (run ${i})`,
      );
    }

    // THE NEGATIVE CONTROL for the two cases above, and they need one. Both widen what counts as
    // exempt — a bare ref now reads as main, and the ref is now read out of the RAW command — so the
    // failure direction is exempting EVERYTHING. If a heredoc body were ignored again, or an
    // unreadable ref were treated as main too eagerly, every assertion above would still pass while
    // the cap had quietly stopped existing. A branch ref fed the same way must still reach it.
    const heredocBranch = [
      "curl -sS -X POST https://api.github.com/repos/o/r/actions/workflows/ci.yml/dispatches -d @- <<'JSON'",
      '{"ref":"codex/heredoc-branch"}',
      "JSON",
    ].join("\n");
    assert.equal(runGuard(heredocBranch, { session: "HD-NEG" }).decision, "allow");
    assert.equal(runGuard(heredocBranch, { session: "HD-NEG" }).decision, "allow");
    assert.equal(
      runGuard(heredocBranch, { session: "HD-NEG" }).decision,
      "deny",
      "a heredoc-fed dispatch on a BRANCH must still cap on the third — otherwise the main exemption "
        + "has swallowed every ref and the clause no longer does anything",
    );

    // A flag before the positional must not be read as the workflow — otherwise `main` would be
    // taken for the workflow name and the exemption would silently not apply.
    for (let i = 1; i <= 3; i += 1) {
      assert.equal(runGuard("gh workflow run --ref main ci.yml", { session: "G" }).decision, "allow");
    }

    // ── the shapes that must never be counted ──────────────────────────────────────────────────
    for (const command of NEVER_COUNTED) {
      for (let i = 1; i <= 3; i += 1) {
        assert.equal(
          runGuard(command, { session: "D" }).decision,
          "allow",
          `this is not a dispatch and must never be counted (run ${i}):\n${command}`,
        );
      }
    }

    // ── the other spellings of the same dispatch ARE the same target ───────────────────────────
    runGuard("gh workflow run ci.yml --ref codex/y", { session: "E" });
    runGuard("gh workflow run CI --ref codex/y", { session: "E" });
    assert.equal(
      runGuard("gh workflow run .github/workflows/ci.yml --ref codex/y", { session: "E" }).decision,
      "deny",
      "`ci.yml`, the display name `CI` and the `.github/workflows/` path are ONE workflow — walking the spellings must not reset the count",
    );

    runGuard("gh workflow run ci.yml --ref codex/z", { session: "F" });
    runGuard("gh api -X POST repos/o/r/actions/workflows/ci.yml/dispatches -f ref=codex/z", { session: "F" });
    assert.equal(
      runGuard(
        'curl -X POST https://api.github.com/repos/o/r/actions/workflows/ci.yml/dispatches -d \'{"ref":"codex/z"}\'',
        { session: "F" },
      ).decision,
      "deny",
      "`gh api …/dispatches` and a raw curl at the same endpoint are the same act — a session that decides `gh` is the problem must not walk around the cap",
    );

    // ── every degraded state ALLOWS ────────────────────────────────────────────────────────────
    for (let i = 1; i <= 3; i += 1) {
      assert.equal(
        runGuard("gh workflow run ci.yml --ref codex/n", { session: "" }).decision,
        "allow",
        "with no session_id there is nothing to count, and there is deliberately no shared bucket: one session's count must never deny another's first dispatch",
      );
    }
    for (let i = 1; i <= 3; i += 1) {
      assert.equal(
        runGuard("gh workflow run ci.yml --ref codex/amb", { session: "H", ambient: true }).decision,
        "allow",
        "the ambient stand-down must work, not only the inline one",
      );
    }

    writeFileSync(join(stateDir, "dispatch-CORRUPT.json"), "{", "utf8");
    assert.equal(
      runGuard("gh workflow run ci.yml --ref codex/c", { session: "CORRUPT" }).decision,
      "allow",
      "a corrupt state file means NOTHING RECORDED, never `cap reached` — the deny may only come from a record that parsed",
    );
    runGuard("gh workflow run ci.yml --ref codex/c", { session: "CORRUPT" });
    assert.equal(
      runGuard("gh workflow run ci.yml --ref codex/c", { session: "CORRUPT" }).decision,
      "deny",
      "and it must HEAL — the next allowed dispatch replaces the file, rather than failing open for the rest of the session",
    );

    writeFileSync(
      join(stateDir, "dispatch-OLDVER.json"),
      JSON.stringify({ version: 0, dispatches: [{ key: "ci@codex/v", count: 9 }] }),
      "utf8",
    );
    assert.equal(
      runGuard("gh workflow run ci.yml --ref codex/v", { session: "OLDVER" }).decision,
      "allow",
      "a file from a different shape of this clause is inert, not misread",
    );

    writeFileSync(
      join(stateDir, "dispatch-OTHER.json"),
      JSON.stringify({ version: 1, dispatches: [{ key: "ci@codex/w", count: 9 }] }),
      "utf8",
    );
    assert.equal(
      runGuard("gh workflow run ci.yml --ref codex/w", { session: "FRESH" }).decision,
      "allow",
      "a crashed session's file must not deny a fresh session — the filename IS the session id",
    );

    // The sweep's `dispatch-` filter is load-bearing: this directory is shared with
    // trap-injector.mjs's `traps-<session>.json`, and an unfiltered sweep would delete every
    // session's injected-cluster state on this machine.
    writeFileSync(join(stateDir, "traps-someone-else.json"), JSON.stringify({ seen: ["Git"] }), "utf8");
    runGuard("gh workflow run ci.yml --ref codex/sweep", { session: "S" });
    assert.ok(
      readdirSync(stateDir).includes("traps-someone-else.json"),
      "the state sweep must leave trap-injector's files alone — they share this directory",
    );

    // ── other tools are none of this hook's business ───────────────────────────────────────────
    assert.equal(runGuard(target, { tool: "Read", session: "A" }).decision, "allow");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}
