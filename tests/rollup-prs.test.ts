import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { MIN_MEMBERS } from "../scripts/rollup-build-verdict.mjs";
import { pathDeltaLanded, registryAddedLinesLanded } from "../scripts/rollup-carried.mjs";
import { latestRunPerName, membersReadyToBuild, requiredCheckState, requiredGateUsable, waitForRequiredChecks } from "../scripts/rollup-check-state.mjs";
import { isRollupBranch, overlappingRollup, rollupMembers } from "../scripts/rollup-duplicate-guard.mjs";

/**
 * `scripts/rollup-prs.mjs` groups the open PRs into the fewest SAFE merges. The bill here is driven by
 * the number of merges (a full CI run on the PR and another on `main`, ~28 billable minutes, because
 * GitHub rounds every job up), so folding disjoint PRs together is real money — and the ways it can be
 * unsafe are all quiet.
 *
 * This drives the REAL script as a subprocess, with a fake `gh` on PATH so no network is touched and it
 * can run inside the required `checks` job. It asserts the refusals, because every one of them is a
 * rule that cost something:
 *
 *   * a migration is applied BY HAND before its merge and is the one thing CI never sees, so burying it
 *     in a roll-up is how it gets approved by accident;
 *   * a protected file needs the owner's word on that specific change;
 *   * `mobile/` is frozen at the owner's instruction;
 *   * two PRs sharing ONE file can merge cleanly and still be wrong together — `tests/run-tests.ts` is
 *     the standing example, where both sides append at the same anchor and keeping both yields a single
 *     `await runTest(...)` call taking four arguments, which compiles, goes green, and silently retires
 *     one of the two tests;
 *   * and a SUPERSEDED PR must not disqualify the PR that supersedes it. The script's first run got
 *     exactly this wrong: #4814 was reported SEPARATE for "shares a file with #4805" on the line after
 *     #4805 had been marked redundant to #4814 itself.
 *
 * It also pins that the script NEVER merges. Merging is a protected action and needs the owner's word
 * every time; the point of a roll-up is that he gives it once instead of N times.
 */

type FakePr = {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  paths: string[];
  author?: string;
  isDraft?: boolean;
  carried?: boolean;
  mergeStateStatus?: string;
  /** States the check verdict outright. Absent means GREEN, which is why every older fixture is unchanged. */
  redRequired?: boolean;
  /** States that the required checks have not FINISHED. Absent means finished, for the same reason. */
  checksPending?: boolean;
  /**
   * The real `gh pr list --json statusCheckRollup` shape, so the actual required-vs-not filter runs.
   * Explicit `null` is the LIVE shape for a commit with no check contexts yet, and is deliberately NOT
   * the same as omitting the field: omitted means "this fixture states its own verdict".
   */
  statusCheckRollup?: null | Array<{
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string | null;
    state?: string;
  }>;
};

/**
 * Drives the real script with `PHX_ROLLUP_FIXTURE`, which is why that seam exists.
 *
 * Shimming `gh` onto PATH does NOT work here and the failure is silent: `execFileSync('gh', …)` without
 * a shell resolves `.exe` but not a `.cmd` or an extensionless script, so the shim is skipped and the
 * REAL `gh.exe` runs. The first version of this test did exactly that and reached `api.github.com`,
 * timing out instead of failing as a miss — a test that quietly talks to production is worse than no
 * test. `where gh` listed the shim first, which is what made it look correct.
 */
function runRollup(
  prs: FakePr[],
  extraArgs: string[] = [],
  env: Record<string, string> = {},
): { code: number; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "phx-rollup-"));
  const fixture = path.join(dir, "prs.json");
  writeFileSync(fixture, JSON.stringify(prs), "utf8");
  try {
    const out = execFileSync(process.execPath, ["scripts/rollup-prs.mjs", "--json", ...extraArgs], {
      encoding: "utf8",
      env: { ...process.env, PHX_ROLLUP_FIXTURE: fixture, PHX_MERGE_MIN_FILES: "4", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/**
 * The same run WITHOUT `--json`, because the human report is where the settle affordance appears — the
 * JSON shape deliberately carries no prose, so a `--json` run cannot see the line that tells a session
 * a PR only needs closing.
 */
function runRollupHuman(prs: FakePr[], extraArgs: string[] = []): { code: number; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "phx-rollup-"));
  const fixture = path.join(dir, "prs.json");
  writeFileSync(fixture, JSON.stringify(prs), "utf8");
  try {
    const out = execFileSync(process.execPath, ["scripts/rollup-prs.mjs", ...extraArgs], {
      encoding: "utf8",
      env: { ...process.env, PHX_ROLLUP_FIXTURE: fixture, PHX_MERGE_MIN_FILES: "4" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function verdicts(
  prs: FakePr[],
  extraArgs: string[] = [],
  env: Record<string, string> = {},
): Map<number, { kind: string; why: string }> {
  const { code, out } = runRollup(prs, extraArgs, env);
  assert.equal(code, 0, `rollup-prs.mjs exited ${code}:
${out}`);
  const parsed = JSON.parse(out) as { open: Array<{ number: number; verdict: { kind: string; why: string } }> };
  return new Map(parsed.open.map((p) => [p.number, p.verdict]));
}

/**
 * The verdict AND the check reading for each PR, because they are deliberately two different answers:
 * the verdict says whether a PR belongs in a roll-up, `checksSettled` says whether its required checks
 * have actually ANSWERED yet, and `--apply` needs the second before it commits a branch to the first.
 */
type ChecksReading = {
  verdict: { kind: string; why: string };
  checksSettled: boolean;
  redChecks: string[];
  pendingChecks: string[];
};

function verdictAndChecks(prs: FakePr[], env: Record<string, string> = {}): Map<number, ChecksReading> {
  const { code, out } = runRollup(prs, [], env);
  assert.equal(code, 0, `rollup-prs.mjs exited ${code}:
${out}`);
  const parsed = JSON.parse(out) as { open: Array<ChecksReading & { number: number }> };
  return new Map(parsed.open.map((p) => [p.number, p]));
}

const pr = (number: number, paths: string[], over: Partial<FakePr> = {}): FakePr => ({
  number,
  title: `pr ${number}`,
  headRefName: `codex/pr-${number}`,
  headRefOid: `${number}`.padStart(40, "0"),
  paths,
  ...over,
});

export function runRollupPrsTests(): void {
  // ── 1. Two disjoint small PRs are the case this exists for ──────────────────────────────────
  {
    const v = verdicts([pr(1, ["docs/a.md"]), pr(2, ["src/b.ts"])]);
    assert.equal(v.get(1)?.kind, "rollable", `#1 should be rollable, got ${v.get(1)?.kind}: ${v.get(1)?.why}`);
    assert.equal(v.get(2)?.kind, "rollable", `#2 should be rollable, got ${v.get(2)?.kind}: ${v.get(2)?.why}`);
  }

  // ── 2. Sharing ONE file keeps them apart ────────────────────────────────────────────────────
  // Clean-merging is not the test. tests/run-tests.ts merges cleanly into a four-argument call.
  {
    const v = verdicts([pr(1, ["tests/run-tests.ts", "tests/a.test.ts"]), pr(2, ["tests/run-tests.ts", "tests/b.test.ts"])]);
    for (const n of [1, 2]) {
      assert.equal(v.get(n)?.kind, "separate", `#${n} shares tests/run-tests.ts and must stay separate`);
      assert.match(v.get(n)?.why ?? "", /shares a file/);
    }
  }

  // ── 3. A migration, a protected file and a frozen path are never rolled up ──────────────────
  {
    const v = verdicts([
      pr(1, ["supabase/migrations/20260101000000_x.sql"]),
      pr(2, ["CLAUDE.md"]),
      pr(3, ["mobile/app.tsx"]),
      pr(4, ["src/lib/payroll/policy.ts"]),
      pr(5, ["src/lib/sales/office-allocation.ts"]),
      pr(6, ["docs/harmless.md"]),
    ]);
    assert.match(v.get(1)?.why ?? "", /migration/, "a migration must be called out by name");
    for (const n of [1, 2, 3, 4, 5]) {
      assert.equal(
        v.get(n)?.kind,
        "separate",
        `#${n} must be SEPARATE — it carries a migration, a protected file or a frozen path, each of `
          + `which needs its own visible approval. Got ${v.get(n)?.kind}: ${v.get(n)?.why}`,
      );
    }
    assert.equal(v.get(6)?.kind, "rollable", "an ordinary docs PR beside them is still rollable");
  }

  // ── 3b. A NEIGHBOUR of a protected file is NOT protected ────────────────────────────────────
  // 🔴 The test was a string PREFIX, so `src/lib/sales/office-allocation-drift.ts` — read-only, with
  // no locked formula anywhere near it — read as the Office golden rule. #5694 was reported to the
  // owner on 2026-10-09 as carrying a protected file, and a peer session had to correct that to him
  // by hand. Only the files CLAUDE.md names are locked.
  {
    const v = verdicts([
      pr(1, ["src/lib/sales/office-allocation-drift.ts", "src/lib/needs-you/sources.ts"]),
      pr(2, ["src/lib/payroll/policy-notes.ts"]),
      pr(3, ["src/lib/incentives/scheme-2026-archive.ts"]),
      pr(4, ["src/components/employee-portal/identity-card-styles.css"]),
      pr(5, ["eas.json.example"]),
    ]);
    for (const n of [1, 2, 3, 4, 5]) {
      assert.equal(
        v.get(n)?.kind,
        "rollable",
        `#${n} touches a NEIGHBOUR of a protected path, not the protected file itself, and must roll `
          + `up like any other PR. Got ${v.get(n)?.kind}: ${v.get(n)?.why}`,
      );
    }
  }

  // ── 3c. And a protected file SPLIT INTO A FOLDER is still protected ─────────────────────────
  // The one direction in which a loose match is the safe mistake.
  {
    const v = verdicts([
      pr(1, ["src/lib/sales/office-allocation/golden-rule.ts"]),
      pr(2, ["src/lib/payroll/policy/basic-salary.ts"]),
      pr(3, ["docs/harmless.md"]),
    ]);
    for (const n of [1, 2]) {
      assert.equal(
        v.get(n)?.kind,
        "separate",
        `#${n} edits a locked file that became a folder of the same name and must stay SEPARATE. `
          + `Got ${v.get(n)?.kind}: ${v.get(n)?.why}`,
      );
    }
    assert.equal(v.get(3)?.kind, "rollable", "and the ordinary PR beside them still rolls up");
  }

  // ── 4. A superseded PR must not disqualify the PR that supersedes it ────────────────────────
  // The script's own first run got this wrong, and it is the whole reason classification is two passes.
  {
    const v = verdicts([
      pr(1, ["pnpm-lock.yaml"], { author: "dependabot[bot]" }),
      pr(2, ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tests/scope.test.ts"]),
    ]);
    assert.equal(v.get(1)?.kind, "superseded", `#1 is a subset of #2 and should read superseded, got ${v.get(1)?.kind}`);
    assert.equal(
      v.get(2)?.kind,
      "rollable",
      "#2 supersedes #1, so #1's overlap must NOT disqualify it. This regressed once: the report said "
        + `SEPARATE "shares a file with #1" on the line after calling #1 redundant to #2. Got: ${v.get(2)?.why}`,
    );
  }

  // ── 4b. A PR whose content is already on main is CARRIED, never rollable ────────────────────
  // A squash merge does not make a branch's commits ancestors of main, so ancestry says "not merged"
  // for a PR that has fully landed — which is exactly how a roll-up's members look the moment it
  // merges. On 2026-09-30 this script proposed rolling #4817 up a SECOND time, minutes after roll-up
  // #4821 had carried all seven of its files into main verbatim: a whole CI run to ship nothing.
  {
    const v = verdicts([pr(1, ["src/a.tsx", "src/b.tsx"], { carried: true }), pr(2, ["docs/x.md"])]);
    assert.equal(
      v.get(1)?.kind,
      "carried",
      `a PR whose every file is byte-identical on main must read CARRIED, got ${v.get(1)?.kind}`,
    );
    assert.match(v.get(1)?.why ?? "", /close it, do not merge it/);
    const parsed = JSON.parse(runRollup([pr(1, ["src/a.tsx"], { carried: true }), pr(2, ["docs/x.md"])]).out) as {
      group: number[];
    };
    assert.deepEqual(parsed.group, [], "a carried PR must not be grouped, and one live PR alone is no roll-up");
  }

  // ── 4c. A PR whose REQUIRED checks have failed is never rolled up ───────────────────────────
  // Measured 2026-09-30 with three PRs open — #4877 red, #4882 green, #4883 pending — the script
  // printed `ONE branch can carry #4883 + #4882 + #4877`, so `--apply` would have built a branch
  // containing a PR whose required checks were FAILING. The owner's one approval could then never go
  // green until somebody else's unrelated fix landed: the exact opposite of "never hand him more than
  // one merge at a time" (AGENTS.md §6).
  //
  // `PHX_ROLLUP_REQUIRED` stands in for the live protection read, so the REAL filter runs offline.
  // Without it the three cases below are indistinguishable — red-but-not-required and still-pending
  // both look like "not red" from the outside.
  const REQUIRED = { PHX_ROLLUP_REQUIRED: "validate,checks" };
  {
    const red = pr(1, ["docs/a.md"], { statusCheckRollup: [{ name: "checks", conclusion: "FAILURE" }] });
    const v = verdicts([red, pr(2, ["src/b.ts"]), pr(3, ["src/c.ts"])], [], REQUIRED);
    assert.equal(
      v.get(1)?.kind,
      "red",
      `a PR whose required check has FAILED must not be rollable, got ${v.get(1)?.kind}: ${v.get(1)?.why}`,
    );
    assert.match(v.get(1)?.why ?? "", /checks \(failure\)/, "and the report must name the check and its state");

    const parsed = JSON.parse(runRollup([red, pr(2, ["src/b.ts"]), pr(3, ["src/c.ts"])], [], REQUIRED).out) as {
      group: number[];
    };
    assert.deepEqual(
      parsed.group.sort((a, b) => a - b),
      [2, 3],
      "the two green PRs still roll up together, and the red one is NOT in the branch that would be built",
    );
  }

  // Every terminal conclusion counts, not just FAILURE — a cancelled or timed-out required check is
  // just as red on the PR and just as stuck.
  for (const conclusion of ["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR", "STARTUP_FAILURE"]) {
    const v = verdicts(
      [pr(1, ["docs/a.md"], { statusCheckRollup: [{ name: "validate", conclusion }] }), pr(2, ["src/b.ts"])],
      [],
      REQUIRED,
    );
    assert.equal(v.get(1)?.kind, "red", `a required check concluding ${conclusion} must disqualify the PR`);
  }

  // And a WIDE red PR must be held out too. Dropping it from `rollable` alone would not do it: `group`
  // unions `rollable` with `ownMerge` unconditionally, so an own-merge PR rides along regardless — which
  // is why the verdict is assigned in the FIRST pass, where `isDraft` sits.
  {
    const wideRed = pr(1, ["a/1", "a/2", "a/3", "a/4", "a/5"], {
      statusCheckRollup: [{ name: "checks", conclusion: "FAILURE" }],
    });
    const v = verdicts([wideRed, pr(2, ["docs/small.md"])], [], REQUIRED);
    assert.equal(v.get(1)?.kind, "red", "a wide PR with a red required check is held out, not called own-merge");
    const parsed = JSON.parse(runRollup([wideRed, pr(2, ["docs/small.md"])], [], REQUIRED).out) as { group: number[] };
    assert.deepEqual(parsed.group, [], "and it must not be carried into the roll-up as an own-merge rider");
  }

  // ── 4d. A red check that is NOT required must not disqualify anything ───────────────────────
  // `mobile` and `secret-scan` both still RUN on a PR and NEITHER gates the merge (protection read
  // live 2026-09-29). A red one of those is a thing to read and judge, never a reason to refuse a
  // roll-up — and the required list is read from protection precisely because it has rotted five
  // times (4 -> 5 -> 6 -> 4 -> 2), so a hardcoded name here would disqualify on a check nothing
  // reports any more.
  {
    const v = verdicts(
      [
        pr(1, ["docs/a.md"], {
          statusCheckRollup: [
            { name: "mobile", conclusion: "FAILURE" },
            { name: "secret-scan", conclusion: "FAILURE" },
            { name: "checks", conclusion: "SUCCESS" },
            { name: "validate", conclusion: "SUCCESS" },
          ],
        }),
        pr(2, ["src/b.ts"]),
      ],
      [],
      REQUIRED,
    );
    assert.equal(
      v.get(1)?.kind,
      "rollable",
      `a red NON-required check must not disqualify a PR, got ${v.get(1)?.kind}: ${v.get(1)?.why}`,
    );
    const parsed = JSON.parse(
      runRollup(
        [
          pr(1, ["docs/a.md"], { statusCheckRollup: [{ name: "mobile", conclusion: "FAILURE" }] }),
          pr(2, ["src/b.ts"]),
        ],
        [],
        REQUIRED,
      ).out,
    ) as { group: number[] };
    assert.deepEqual(parsed.group.sort((a, b) => a - b), [1, 2], "and it still rides in the roll-up");
  }

  // ── 4e. PENDING is not red ──────────────────────────────────────────────────────────────────
  // A PR opened minutes ago has every required check QUEUED or IN_PROGRESS. That is the NORMAL case
  // and the one this tool is most often run against; treating it as a failure would make the script
  // propose nothing exactly when it is wanted.
  {
    const pending = pr(1, ["docs/a.md"], {
      statusCheckRollup: [
        { name: "checks", status: "IN_PROGRESS", conclusion: null },
        { name: "validate", status: "QUEUED", conclusion: null },
      ],
    });
    const v = verdicts([pending, pr(2, ["src/b.ts"])], [], REQUIRED);
    assert.equal(
      v.get(1)?.kind,
      "rollable",
      `required checks still running are NOT a failure, got ${v.get(1)?.kind}: ${v.get(1)?.why}`,
    );
    const parsed = JSON.parse(runRollup([pending, pr(2, ["src/b.ts"])], [], REQUIRED).out) as { group: number[] };
    assert.deepEqual(parsed.group.sort((a, b) => a - b), [1, 2], "a pending PR still rolls up — that is the normal case");

    // A StatusContext reports `state`, not `conclusion`, and PENDING there means the same thing.
    const ctx = verdicts(
      [
        pr(1, ["docs/a.md"], { statusCheckRollup: [{ context: "checks", state: "PENDING" }] }),
        pr(2, ["src/b.ts"]),
      ],
      [],
      REQUIRED,
    );
    assert.equal(ctx.get(1)?.kind, "rollable", "a PENDING StatusContext is not a failure either");
  }

  // ── 4e-bis. …but PENDING is not GREEN either, and the build is where that matters ────────────
  // #4886 taught the script to hold out a PR whose required checks have FAILED. It asked only about
  // terminal failure, so the third answer — nothing has finished yet — was read as the first. Measured
  // 2026-09-30: `--apply` built roll-up #4896 from #4895 (green) and #4894 (checks still QUEUED);
  // #4894's `checks` then failed on four TypeScript errors in `src/lib/phoenix-crm/server/list.ts` plus
  // two of its own tests, the roll-up inherited a red it could never clear, and because a roll-up's
  // members must not be merged separately (AGENTS.md §6) it held the GREEN PR hostage to another
  // session's fix. #4896 was closed and #4895 merged alone: one CI run spent to ship nothing.
  //
  // The fix is NOT to call pending red — 4e above pins why. It is that the classification keeps saying
  // ROLL UP while `checksSettled` says whether the checks have actually ANSWERED, and `--apply` waits
  // on that flag before committing a branch to a member. So these four cases assert the reading, and
  // the verdicts stay exactly as 4c/4d/4e left them.
  {
    // QUEUED — nothing has started. Still a candidate, not yet proven.
    const queued = verdictAndChecks(
      [
        pr(1, ["docs/a.md"], {
          statusCheckRollup: [
            { name: "validate", status: "QUEUED", conclusion: null },
            { name: "checks", status: "QUEUED", conclusion: null },
          ],
        }),
        pr(2, ["src/b.ts"]),
      ],
      REQUIRED,
    );
    assert.equal(queued.get(1)?.verdict.kind, "rollable", "queued required checks keep the PR a candidate");
    assert.equal(
      queued.get(1)?.checksSettled,
      false,
      "a PR whose required checks are QUEUED has NOT answered — that reading is the whole guard, and "
        + "without it #4896 was built over #4894 minutes before #4894 went red",
    );
    assert.deepEqual(
      queued.get(1)?.pendingChecks,
      ["validate (queued)", "checks (queued)"],
      "and both unfinished required checks are named with their state, so the wait can report them",
    );
    assert.deepEqual(queued.get(1)?.redChecks, [], "queued is not red");
    assert.equal(queued.get(2)?.checksSettled, true, "the green PR beside it is settled and buildable");

    // IN_PROGRESS — started, no verdict yet. Same answer.
    const running = verdictAndChecks(
      [
        pr(1, ["docs/a.md"], {
          statusCheckRollup: [
            { name: "validate", status: "IN_PROGRESS", conclusion: null },
            { name: "checks", status: "IN_PROGRESS", conclusion: null },
          ],
        }),
        pr(2, ["src/b.ts"]),
      ],
      REQUIRED,
    );
    assert.equal(running.get(1)?.verdict.kind, "rollable", "a running required check keeps the PR a candidate");
    assert.equal(running.get(1)?.checksSettled, false, "IN_PROGRESS has not answered either");
    assert.deepEqual(running.get(1)?.pendingChecks, ["validate (in_progress)", "checks (in_progress)"]);

    // COMPLETED GREEN — the one state `--apply` may build from.
    const green = verdictAndChecks(
      [
        pr(1, ["docs/a.md"], {
          statusCheckRollup: [
            { name: "validate", conclusion: "SUCCESS" },
            { name: "checks", conclusion: "SUCCESS" },
          ],
        }),
        pr(2, ["src/b.ts"]),
      ],
      REQUIRED,
    );
    assert.equal(green.get(1)?.verdict.kind, "rollable");
    assert.equal(green.get(1)?.checksSettled, true, "every required check finished green — nothing left to wait for");
    assert.deepEqual(green.get(1)?.pendingChecks, []);

    // FAILED — #4886's case, and its verdict must be exactly what it was.
    const red = verdictAndChecks(
      [
        pr(1, ["docs/a.md"], {
          statusCheckRollup: [
            { name: "validate", conclusion: "SUCCESS" },
            { name: "checks", conclusion: "FAILURE" },
          ],
        }),
        pr(2, ["src/b.ts"]),
        pr(3, ["src/c.ts"]),
      ],
      REQUIRED,
    );
    assert.equal(
      red.get(1)?.verdict.kind,
      "red",
      "#4886's guard is untouched: a terminally failed required check still holds the PR out of the group",
    );
    assert.deepEqual(red.get(1)?.redChecks, ["checks (failure)"]);
    assert.equal(red.get(1)?.checksSettled, false, "and a red PR is not 'settled' in the buildable sense");

    // A required check that appears NOWHERE is pending, not absent. A PR opened seconds ago reports an
    // empty rollup, and reading that as "nothing is red, build it" is the 2026-09-30 failure in its
    // purest form — the build would commit to a PR before a single check had been queued.
    const silent = verdictAndChecks([pr(1, ["docs/a.md"], { statusCheckRollup: [] }), pr(2, ["src/b.ts"])], REQUIRED);
    assert.equal(silent.get(1)?.verdict.kind, "rollable");
    assert.equal(
      silent.get(1)?.checksSettled,
      false,
      "a PR with NO check reported yet must not read as finished green — that is a fresh PR, not a proven one",
    );
    assert.deepEqual(silent.get(1)?.pendingChecks, ["validate (not reported yet)", "checks (not reported yet)"]);

    // And a fixture that says nothing about checks at all still reads finished-and-green, which is why
    // every fixture written before this field existed keeps its verdict (cases 1-9 below).
    const silentFixture = verdictAndChecks([pr(1, ["docs/a.md"]), pr(2, ["src/b.ts"])], REQUIRED);
    assert.equal(
      silentFixture.get(1)?.checksSettled,
      true,
      "a fixture with no check information defaults to finished green, or every older case here changes meaning",
    );

    // A fixture may also state it outright, the way `redRequired` does, for a case that is about the
    // grouping rather than about parsing a rollup shape.
    const stated = verdictAndChecks([pr(1, ["docs/a.md"], { checksPending: true }), pr(2, ["src/b.ts"])]);
    assert.equal(stated.get(1)?.verdict.kind, "rollable", "a stated-pending PR is still a candidate");
    assert.equal(stated.get(1)?.checksSettled, false, "and still not something to build over");

    // The human report has to SAY it, or a session reads `ONE branch can carry #1 + #2` and believes
    // both are green — which is what the #4896 build looked like from the outside.
    const human = runRollupHuman([pr(1, ["docs/a.md"], { checksPending: true }), pr(2, ["src/b.ts"])]);
    assert.equal(human.code, 0);
    assert.match(
      human.out,
      /#1 still have required checks running/,
      "the report must name the member whose checks have not finished",
    );
    assert.match(human.out, /--apply waits up to \d+ min/, "and say that --apply waits rather than building over it");
  }

  // ── 4e-ter. --apply waits for the members' checks, and builds only from what finished green ──
  // The wait itself needs the live repository, so what is pinned offline is the DECISION it feeds and
  // the PLACE it sits. `membersReadyToBuild` is the decision; the source order is the place.
  {
    const ready = membersReadyToBuild([
      { number: 1, red: [], pending: [] },
      { number: 2, red: [], pending: ["checks (in_progress)"] },
      { number: 3, red: ["validate (failure)"], pending: [] },
      { number: 4, red: [], pending: [] },
    ]);
    assert.deepEqual(ready.carry, [1, 4], "only the members whose required checks finished green are built from");
    assert.deepEqual(
      ready.dropped.map((d) => [d.number, d.kind]),
      [
        [2, "pending"],
        [3, "red"],
      ],
      "a member that never finished is dropped as PENDING and a failed one as RED — the two are different "
        + "sentences to the reader: one is unproven and rolls up next run, the other needs a fix",
    );
    assert.match(ready.dropped[0]?.why ?? "", /had not finished/);
    assert.match(ready.dropped[0]?.why ?? "", /rolls up on the next run/);
    assert.match(ready.dropped[1]?.why ?? "", /could never go green/);

    // Dropping members is always safe because the group was chosen for DISJOINT file sets and every
    // subset of a disjoint set is disjoint; what is never safe is carrying one we have not seen finish.
    assert.deepEqual(
      membersReadyToBuild([{ number: 1, red: [], pending: ["checks (queued)"] }]).carry,
      [],
      "a lone unfinished member leaves nothing to build, and MIN_MEMBERS then stops the build",
    );
    assert.ok(MIN_MEMBERS >= 2, "a roll-up of one is a rename with a full CI run attached");

    const source = readFileSync("scripts/rollup-prs.mjs", "utf8");
    const waitAt = source.indexOf("waiting up to");
    const branchAt = source.indexOf("'switch', '--quiet', '--create'");
    assert.ok(waitAt > 0, "--apply must actually wait for the members' required checks before building");
    assert.ok(branchAt > 0, "the build still creates the roll-up branch");
    assert.ok(
      waitAt < branchAt,
      "the wait must come BEFORE the branch is created. Waiting after it would park the session on a "
        + "half-built local branch for the duration, and `new-session.mjs --remove` judges a worktree by "
        + "whatever branch it finds checked out — the other half of the 2026-09-30 mess.",
    );
    assert.match(
      source,
      /for \(const pr of buildGroup\)/,
      "and the merge loop must iterate the POST-WAIT set, not the group the report proposed — that "
        + "difference is the entire fix",
    );
  }

  // ── 4e-quater. The wait loop itself, driven with an injected clock and reader ────────────────
  // A live `--apply` cannot be rehearsed — it pushes a branch and opens a PR — so the loop takes its
  // clock, its sleep and its GitHub read as arguments and is exercised here instead. Each case below is
  // a way the loop could be wrong while still looking like it worked.
  {
    // It waits, it polls only what can still change, and it stops as soon as the checks finish.
    let clock = 0;
    const sleeps: number[] = [];
    const reads: number[] = [];
    const answers: Array<{ red: string[]; pending: string[] } | null> = [
      { red: [], pending: ["checks (in_progress)"] },
      { red: [], pending: [] },
    ];
    const settled = waitForRequiredChecks({
      members: [
        { number: 1, red: [], pending: [] },
        { number: 2, red: [], pending: ["checks (queued)"] },
      ],
      timeoutMs: 10 * 60_000,
      pollMs: 30_000,
      reread: (n: number) => {
        reads.push(n);
        return answers.shift() ?? null;
      },
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    assert.deepEqual(reads, [2, 2], "only the unfinished member is polled — #1's checks already finished green");
    assert.equal(sleeps.length, 2, "and it sleeps between reads rather than spinning on the API");
    assert.deepEqual(
      membersReadyToBuild(settled).carry,
      [1, 2],
      "once the pending member's checks finish green, BOTH are built from — the wait is what makes the "
        + "roll-up safe, not what shrinks it",
    );
  }
  {
    // THE WAIT IS BOUNDED. A workflow that never reports must not park the session for ever, and the
    // member it belongs to is left out rather than gambled on.
    let clock = 0;
    const sleeps: number[] = [];
    const settled = waitForRequiredChecks({
      members: [
        { number: 1, red: [], pending: [] },
        { number: 2, red: [], pending: ["checks (queued)"] },
      ],
      timeoutMs: 90_000,
      pollMs: 30_000,
      reread: () => ({ red: [], pending: ["checks (in_progress)"] }),
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    assert.equal(sleeps.length, 3, "90s of wait at 30s a poll is three reads and then it gives up — bounded, not hopeful");
    assert.deepEqual(
      membersReadyToBuild(settled).carry,
      [1],
      "and the member that never finished is left out of the build, not carried on hope",
    );
  }
  {
    // A FAILED READ IS NOT NEWS. `gh` can fail for a minute; reading that as "nothing pending any more"
    // would promote an unproven member to green, which is the exact failure the wait exists to prevent.
    let clock = 0;
    const settled = waitForRequiredChecks({
      members: [{ number: 2, red: [], pending: ["checks (queued)"] }],
      timeoutMs: 60_000,
      pollMs: 30_000,
      reread: () => null,
      sleep: (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    });
    assert.deepEqual(
      settled[0]?.pending,
      ["checks (queued)"],
      "a read that failed keeps the previous reading — it can never promote a pending member to green",
    );
    assert.deepEqual(membersReadyToBuild(settled).carry, [], "so it is still not something to build over");
  }
  {
    // A member that has already gone RED is never polled. Nothing it reports later can make it
    // buildable, and re-reading it would only slow the wait for the members that can still settle.
    const reads: number[] = [];
    let clock = 0;
    const settled = waitForRequiredChecks({
      members: [{ number: 3, red: ["validate (failure)"], pending: ["checks (queued)"] }],
      timeoutMs: 60_000,
      pollMs: 30_000,
      reread: (n: number) => {
        reads.push(n);
        return { red: [], pending: [] };
      },
      sleep: (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    });
    assert.deepEqual(reads, [], "a member whose required check already failed is not waited on");
    assert.deepEqual(
      membersReadyToBuild(settled).dropped.map((d) => d.kind),
      ["red"],
      "and it is dropped as RED, which is #4886's rule, not as a timeout",
    );
  }

  // ── 4e-quinquies. A member that changes under the wait is STALE, never built from ────────────
  // The hole the wait left behind, and it is the original bug wearing a later timestamp: the checks
  // are re-read LIVE while the commit the build merges was captured BEFORE the wait. So a member
  // pushed meanwhile hands back green checks for a commit the build would not merge — and its file
  // set, which is what the group was chosen on, was measured on the old head too. Not hypothetical:
  // on 2026-09-30 #4907's head moved TWICE inside fifteen minutes while its checks ran, and each
  // move was a real commit with different content.
  {
    const reads: number[] = [];
    let clock = 0;
    const settled = waitForRequiredChecks({
      members: [
        { number: 1, red: [], pending: [] },
        { number: 2, red: [], pending: ["checks (queued)"] },
      ],
      timeoutMs: 10 * 60_000,
      pollMs: 30_000,
      reread: (n: number) => {
        reads.push(n);
        return { stale: `#${n} was pushed while we waited (aaaaaaaaa -> bbbbbbbbb)` };
      },
      sleep: (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    });
    assert.deepEqual(reads, [2], "a member that goes stale is read ONCE and then left alone, not polled to the deadline");
    assert.equal(settled.find((m) => m.number === 2)?.stale != null, true, "and it comes back carrying why it is stale");

    const readiness = membersReadyToBuild(settled);
    assert.deepEqual(
      readiness.carry,
      [1],
      "the moved member is NOT built from — green checks taken after the head moved describe a commit "
        + "the build would not merge, which is the thing all of this exists to refuse",
    );
    assert.deepEqual(readiness.dropped.map((d) => d.kind), ["stale"], "and it is dropped as STALE, not as red or a timeout");
    assert.match(readiness.dropped[0]?.why ?? "", /was pushed while we waited/);
    assert.match(readiness.dropped[0]?.why ?? "", /not\s+refused, only out of date/);

    // STALE outranks both other verdicts: a reading taken from a different commit is not evidence
    // about this one, so it must not be reported as that commit's own red or its own timeout.
    const mixed = membersReadyToBuild([
      { number: 3, red: ["checks (failure)"], pending: ["validate (queued)"], stale: "#3 is closed, not open any more" },
    ]);
    assert.deepEqual(mixed.carry, []);
    assert.equal(mixed.dropped[0]?.kind, "stale", "stale outranks red and pending — it says the reading is about something else");

    // An answer that is neither stale nor two lists is NO NEWS, exactly like a failed read. Reading a
    // malformed answer as empty lists would say "finished, and nothing is red" — the one direction that
    // carries an unverified member, and the direction a crash-free bug would take on its own.
    let tick = 0;
    const malformed = waitForRequiredChecks({
      members: [{ number: 9, red: [], pending: ["checks (queued)"] }],
      timeoutMs: 60_000,
      pollMs: 30_000,
      reread: () => ({ nonsense: true }) as unknown as { red: string[]; pending: string[] },
      sleep: (ms: number) => {
        tick += ms;
      },
      now: () => tick,
    });
    assert.deepEqual(
      malformed[0]?.pending,
      ["checks (queued)"],
      "an answer of an unexpected shape keeps the previous reading — it is never a verdict",
    );
    assert.deepEqual(membersReadyToBuild(malformed).dropped.map((d) => d.kind), ["pending"]);
  }

  // ── 4e-sexies. The live side asks for the sha, in the poll AND once more before the merge ────
  {
    const source = readFileSync("scripts/rollup-prs.mjs", "utf8");
    assert.match(
      source,
      /'--json', 'state,headRefOid,statusCheckRollup'/,
      "the poll must read the PR's state and head sha alongside its checks, or it cannot tell a green "
        + "reading about THIS commit from a green reading about a commit that replaced it",
    );
    const mergeAt = source.indexOf("'merge', '--no-edit'");
    const guardAt = source.indexOf("it was pushed since it was measured");
    assert.ok(guardAt > 0, "the build must re-read the head before merging — the wait cannot see a push that lands after it stops");
    assert.ok(
      guardAt < mergeAt,
      "and that check must come BEFORE the merge: this is the roll-up's `--match-head-commit`, so it "
        + "merges the commit whose checks and file set were measured, or it merges nothing",
    );
    assert.match(
      source,
      /skipped\.push\(pr\.number\);[\s\S]{0,400}?pushed since it was measured/,
      "a moved head is SKIPPED, never followed: the new commit's checks are unread and its files "
        + "unmeasured, so following it would carry exactly what the wait refuses",
    );
  }

  // ── 4e-septies. A LIVE read with no rollup at all is PENDING, never green ────────────────────
  // The hole the fixture default was hiding. GitHub returns `statusCheckRollup: null` for a commit with
  // no check contexts yet — exactly a PR opened seconds ago, the case a roll-up is most often built
  // against. Left as null it fell through to the branch where a FIXTURE states its own verdict, and a
  // fixture that says nothing defaults to finished-and-green: measured 2026-09-30, a null rollup read
  // `settled=true` and the member was carried, so #4906's wait was silently skipped for the freshest
  // PRs and `--no-wait` would have built from one outright.
  //
  // Present-and-null is therefore NOT the same as absent, and that distinction is the only way to reach
  // the live behaviour offline: absent means "the fixture states its verdict" (4e-bis pins that it still
  // reads green), present-and-null takes the same normalisation the live read takes.
  {
    const live = verdictAndChecks(
      [
        pr(1, ["docs/a.md"], { statusCheckRollup: null }),
        pr(2, ["src/b.ts"], {
          statusCheckRollup: [
            { name: "validate", conclusion: "SUCCESS" },
            { name: "checks", conclusion: "SUCCESS" },
          ],
        }),
      ],
      REQUIRED,
    );
    assert.equal(
      live.get(1)?.checksSettled,
      false,
      "a live PR whose rollup is null has reported NOTHING — reading that as finished-and-green is what "
        + "let a roll-up build over the freshest possible member",
    );
    assert.deepEqual(live.get(1)?.pendingChecks, ["validate (not reported yet)", "checks (not reported yet)"]);
    assert.equal(live.get(1)?.verdict.kind, "rollable", "it is still a candidate — the wait handles it, not a refusal");
    assert.equal(live.get(2)?.checksSettled, true, "and a genuinely green member beside it is still buildable");
  }

  // ── 4e-octies. An unknown flag is REFUSED, never ignored ─────────────────────────────────────
  // A session runs this from its own worktree, whose copy can be days older than `main`, and every flag
  // arrived in a different merge. An ignored unknown flag means `--no-wait` on a checkout that predates
  // the wait runs the OLD behaviour and reports success — the operator reads the flag they typed as the
  // behaviour they got. That is the most plausible account of roll-up #4937, reported as built by
  // `--apply --no-wait` over a member whose checks were still running, a shape the current code does
  // NOT reproduce (4e-bis measures it as `settled=false`).
  {
    const refused = runRollup([pr(1, ["docs/a.md"]), pr(2, ["src/b.ts"])], ["--no-such-flag"]);
    assert.notEqual(refused.code, 0, "an unrecognised flag must fail loudly rather than run the old behaviour silently");
    assert.match(refused.out, /unknown argument\(s\): --no-such-flag/);
    assert.match(refused.out, /REFUSED rather than ignored/);

    // Every real flag still parses, including the two that take a value — a refusal that also refused
    // `--wait 5` would be worse than the bug.
    for (const argv of [["--wait", "5"], ["--no-wait"], ["--max-files", "3"], ["--verify-heads"]]) {
      const ok = runRollup([pr(1, ["docs/a.md"]), pr(2, ["src/b.ts"])], argv);
      assert.doesNotMatch(ok.out, /unknown argument/, `${argv.join(" ")} must still be accepted`);
    }

    // 🔴 A READ-ONLY FLAG COMBINED WITH A WRITE FLAG MUST BE REFUSED, NOT ORDERED. `--verify-heads`
    // reports; `--settle` closes, `--apply` pushes and opens, `--close-superseded` closes bot PRs —
    // and every one of those blocks runs BEFORE the verification would print, so the combination
    // mutates GitHub during a run asked for as a look. Raised in review on #5201. The refusal has to
    // happen at PARSE time: putting the verification block above `--settle` would still leave
    // `--apply`'s push below it.
    for (const writeFlag of ["--settle", "--apply", "--close-superseded"]) {
      const clash = runRollup([pr(1, ["docs/a.md"]), pr(2, ["src/b.ts"])], ["--verify-heads", writeFlag]);
      assert.notEqual(clash.code, 0, `--verify-heads ${writeFlag} must fail rather than run both`);
      // 🔴 THE MESSAGE IS THE ASSERTION THAT DISCRIMINATES, NOT THE EXIT CODE. Measured by removing
      // the guard: the run still exited non-zero (the fixture refusal inside the verification block
      // does that too), so `notEqual(code, 0)` passed while the defect was fully present. Only this
      // match fired. An exit-code-only test here would have been green on broken code.
      assert.match(clash.out, /--verify-heads is READ-ONLY and cannot be combined with/);
      assert.ok(clash.out.includes(writeFlag), `the refusal must name ${writeFlag} so the operator knows which half to drop`);
      // The whole point: nothing may have been closed, pushed or opened on the way to that message.
      assert.doesNotMatch(clash.out, /closed #/, "a refused combination must not have closed anything first");
    }
  }

  // ── 4e-nonies. --settle: the suite registry is judged by its ADDED LINES, not byte-identity ──
  // `tests/run-tests.ts` is appended to by every PR that adds a test, so the moment ANY other PR
  // registers a suite, a carried PR's copy differs for reasons that say nothing about its own work.
  // Measured 2026-09-30: after roll-up #4937 merged, `--settle` closed #4930 and left #4936 open with
  // all of its work on `main` — two of three files byte-identical and its registry lines present.
  //
  // NARROWED, not loosened. "Most files match" is what must never happen here: a PR closed on a guess is
  // work thrown away, while one left open costs a single avoidable CI run.
  {
    const mainSource = [
      'import { runAlphaTests } from "./alpha.test.ts";',
      'import { runBetaTests } from "./beta.test.ts";',
      'await runTest("alpha does its thing", runAlphaTests);',
      'await runTest("beta does its thing", runBetaTests);',
    ].join("\n");

    const landed = registryAddedLinesLanded(
      ['import { runBetaTests } from "./beta.test.ts";', "", 'await runTest("beta does its thing", runBetaTests);', ");"],
      mainSource,
    );
    assert.equal(landed.landed, true, "every meaningful added line is on main, so the PR's own registration landed");
    assert.deepEqual(landed.missing, [], "and blank or punctuation-only lines are not held against it");

    const notLanded = registryAddedLinesLanded(
      ['import { runGammaTests } from "./gamma.test.ts";', 'await runTest("gamma", runGammaTests);'],
      mainSource,
    );
    assert.equal(notLanded.landed, false, "a registration NOT on main means the PR is not carried — failing closed, unchanged");
    assert.equal(notLanded.missing.length, 2, "and it names exactly which lines are missing");

    // Punctuation alone can never be evidence: it appears hundreds of times in the registry, so finding
    // it proves nothing and requiring it would turn a reformat into a false negative.
    assert.equal(registryAddedLinesLanded([");", "}", "", ","], "nothing like it").landed, true);

    const source = readFileSync("scripts/rollup-prs.mjs", "utf8");
    assert.match(
      source,
      /if \(p === SHARED_REGISTRY_PATH\) return registryLandedOnMain\(pr\)/,
      "the exception must be keyed on that ONE path — a pattern would quietly extend it to the next "
        + "shared file somebody adds, which is how a narrow rule becomes a loose one",
    );
    assert.match(
      source,
      /'merge-base', 'origin\/main'/,
      "and the delta must be taken against the MERGE BASE: a two-dot diff to main would read other "
        + "people's registrations as lines this PR had removed",
    );
  }

  // ── 4e-duodecies. Byte-identity is a PROOF, not the question (owner, 2026-10-02) ───────────
  //
  // Measured the night of 2026-10-01. Roll-up #5098 carried #5096's relocation verbatim — the account it
  // moved out of AGENTS.md was gone from main and present in the destination doc, byte-identical — and
  // `--settle` still refused to close it, because main's AGENTS.md had moved past the branch's copy
  // (114,585 against the PR's 115,060): the roll-up carried a SECOND member touching the same file. Two
  // of the three carried members that night needed a human decision for this, and one reached the owner.
  //
  // A patch-id cannot answer it alone, which is worth pinning so nobody "simplifies" it back: a roll-up
  // is a SQUASH, so the carrier's diff is strictly larger than any one member's and their patch-ids never
  // match. The question patch-id is a means to — IS THIS DELTA ALREADY APPLIED — is asked per path with
  // `git apply --check --reverse` against main's tree.
  {
    const settleSource = readFileSync("scripts/rollup-prs.mjs", "utf8");
    assert.equal(pathDeltaLanded({ blobsEqual: true }), true, "identical bytes stay the fast proof");
    assert.equal(
      pathDeltaLanded({ blobsEqual: false, hasDelta: true, reverseApplies: true }),
      true,
      "#5096's case: the bytes differ because main moved on, but this PR's own delta is already applied",
    );

    // Every other shape is NOT landed. A false negative costs one avoidable CI run; a false positive
    // closes somebody's unlanded work, so the direction never flips.
    assert.equal(pathDeltaLanded({ blobsEqual: false, hasDelta: true, reverseApplies: false }), false, "a delta that does not apply is not landed");
    assert.equal(pathDeltaLanded({ blobsEqual: false, hasDelta: false, reverseApplies: true }), false, "no delta of our own proves nothing");
    assert.equal(pathDeltaLanded({}), false, "and an unreadable reading is never a yes");
    assert.equal(pathDeltaLanded(undefined as never), false, "nor is a missing one");

    assert.match(
      settleSource,
      /return pathDeltaLanded\(\{ blobsEqual, \.\.\.pathDeltaReadings\(pr, p, blobsEqual\) \}\)/,
      "the per-path answer must go through the one pure decision, not a second copy of the rule",
    );
    assert.match(
      settleSource,
      /'apply', '--cached', '--check', '--reverse', '-'/,
      "the delta is asked of main's TREE with --check, so no file and no real index is ever touched",
    );
    assert.match(
      settleSource,
      /env: \{ GIT_INDEX_FILE: indexFile \}/,
      "and through a throwaway index, because this runs inside whatever worktree called the script",
    );
    assert.match(settleSource, /rmSync\(dirname\(indexFile\), \{ force: true, recursive: true \}\)/, "which is removed even when the read throws");
  }

  // ── 4e-decies. A check that ran BEFORE the head commit is the previous commit's result ───────
  // The one account left standing for roll-up #4937. A peer session ruled out both causes we proposed:
  // its copy of the script was byte-identical to `main` INCLUDING the stale-sha guard, and #4936's checks
  // had already started, so neither an older worktree nor a null rollup explains it. `statusCheckRollup`
  // is the rollup of the PR's latest commit, but right after a push it can still carry the PREVIOUS
  // commit's runs — green ones — so the member reads finished-and-green while its real checks have not
  // begun. The stale-SHA guard cannot see this: the head never moved, only the checks were old.
  {
    const HEAD_AT = "2026-09-30T14:45:38Z";
    const before = "2026-09-30T14:30:00Z"; // a run from the previous push
    const after = "2026-09-30T14:48:13Z"; // a run for this commit

    const stale = requiredCheckState(
      [
        { name: "validate", conclusion: "SUCCESS", startedAt: before },
        { name: "checks", conclusion: "SUCCESS", startedAt: before },
      ],
      new Set(["validate", "checks"]),
      HEAD_AT,
    );
    assert.deepEqual(stale.red, [], "green is green — this is not a failure");
    assert.equal(
      stale.pending.length,
      2,
      "but two SUCCESSES that ran before the head commit existed are the PREVIOUS commit's result, so "
        + "the member is not proven and must not be built from",
    );
    assert.match(stale.pending[0] ?? "", /ran before this commit existed/);

    const fresh = requiredCheckState(
      [
        { name: "validate", conclusion: "SUCCESS", startedAt: after },
        { name: "checks", conclusion: "SUCCESS", startedAt: after },
      ],
      new Set(["validate", "checks"]),
      HEAD_AT,
    );
    assert.deepEqual(fresh, { red: [], pending: [] }, "runs that started after the commit are its own, and it is green");

    // Unjudgeable is not the same as fine: no start time means it cannot be tied to this commit.
    const noTime = requiredCheckState(
      [{ name: "validate", conclusion: "SUCCESS" }, { name: "checks", conclusion: "SUCCESS", startedAt: after }],
      new Set(["validate", "checks"]),
      HEAD_AT,
    );
    assert.equal(noTime.pending.length, 1, "a check with no startedAt is pending, not green");
    assert.match(noTime.pending[0] ?? "", /no start time/);

    // A StatusContext has no `startedAt` at all — it reports `state` and `context`. Holding it to a start
    // time would make it pend FOR EVER: it can never gain one, so the wait always times out and that
    // member could never be built from. Raised by a peer session reviewing this change; measured before
    // fixing, two green StatusContexts came back as two "no start time" pending entries.
    assert.deepEqual(
      requiredCheckState(
        [{ context: "validate", state: "SUCCESS" }, { context: "checks", state: "SUCCESS" }],
        new Set(["validate", "checks"]),
        HEAD_AT,
      ),
      { red: [], pending: [] },
      "a green StatusContext is green — the staleness test only applies to a shape that can answer it",
    );
    // ...and an unfinished one is still pending, so the exemption did not buy a fail-open.
    assert.equal(
      requiredCheckState([{ context: "validate", state: "PENDING" }], new Set(["validate"]), HEAD_AT).pending.length,
      1,
      "a PENDING StatusContext is still pending — exempting the TIMING test must not exempt the state test",
    );

    // Omitting the head date skips the test entirely, which is what every older caller and fixture gets.
    assert.deepEqual(
      requiredCheckState(
        [{ name: "validate", conclusion: "SUCCESS", startedAt: before }, { name: "checks", conclusion: "SUCCESS", startedAt: before }],
        new Set(["validate", "checks"]),
      ),
      { red: [], pending: [] },
      "with no head date the staleness test is skipped — that is why no existing fixture changes verdict",
    );
  }

  // ── 4e-undecies. A running check is labelled in_progress, not "not started" ───────────────────
  // `conclusion` comes back as an EMPTY STRING for a running check, not null, and `??` does not skip an
  // empty string — so the report printed a check that was actively running as "not started". Cosmetic,
  // but it misdescribed the exact state the tool was waiting on, and it muddied the #4937 investigation
  // for both sessions looking at it.
  {
    const running = requiredCheckState(
      [{ name: "checks", status: "IN_PROGRESS", conclusion: "" }],
      new Set(["checks"]),
    );
    assert.deepEqual(running.pending, ["checks (in_progress)"], "the label must name the state gh actually reported");
  }

  // ── 4e-duodecies. The build says what reading it acted on, for every member ───────────────────
  {
    const source = readFileSync("scripts/rollup-prs.mjs", "utf8");
    assert.match(
      source,
      /at build time: settled=/,
      "every member's settled/red/pending reading must be printed at build time. Asked for by the peer "
        + "session that investigated #4937: when this goes wrong the branch is usually deleted before "
        + "anyone looks, so the run's own output has to be the evidence.",
    );
  }

  // ── 4e-terdecies. Nothing red and nothing pending is NOT green when the gate named nothing ───
  // Found by a peer session and reproduced here against this module before changing anything. Four ways
  // in, all of which read `{red: [], pending: []}` and were therefore BUILT FROM:
  //
  //   required = EMPTY Set, both required checks IN_PROGRESS
  //   required = EMPTY Set, no checks at all
  //   required = null,      no checks at all
  //   required = null,      only a non-gating check green
  //
  // The empty Set is the dangerous one because it arrives on a 200: `readProtectionContexts()` treats
  // `contexts: []` as a successful read, and that classic array is deprecated — a rule moved to a ruleset
  // empties it, at which point every open PR reads green at once.
  {
    const running = [
      { name: "validate", status: "IN_PROGRESS", conclusion: "" },
      { name: "checks", status: "IN_PROGRESS", conclusion: "" },
    ];
    for (const [label, rollup, gate] of [
      ["empty gate + running", running, new Set<string>()],
      ["empty gate + no checks", [], new Set<string>()],
      ["unreadable gate + no checks", [], null],
      ["unreadable gate + only a non-gating check green", [{ name: "mobile", conclusion: "SUCCESS" }], null],
    ] as Array<[string, Array<Record<string, unknown>>, Set<string> | null]>) {
      const state = requiredCheckState(rollup, gate);
      assert.deepEqual(state.red, [], `${label}: nothing is red`);
      assert.equal(
        state.pending.length > 0,
        true,
        `${label}: with no CONFIRMED required check this must not read green — both lists empty was being `
          + "taken as all-clear about a question the gate never let us ask",
      );
      assert.match(state.pending.join(" "), /nothing could be confirmed green/);
    }

    // A healthy gate with both required checks green is still green — the fix must not make everything pend.
    assert.deepEqual(
      requiredCheckState(
        [{ name: "validate", conclusion: "SUCCESS" }, { name: "checks", conclusion: "SUCCESS" }],
        new Set(["validate", "checks"]),
      ),
      { red: [], pending: [] },
      "a real gate, both required checks passed: that IS green and must stay buildable",
    );

    assert.equal(requiredGateUsable(new Set()).usable, false, "an empty gate is unusable");
    assert.equal(requiredGateUsable(null).usable, false, "an unreadable gate is unusable");
    assert.equal(requiredGateUsable(new Set(["validate", "checks"])).usable, true, "a named gate is usable");
    assert.match(requiredGateUsable(new Set()).why, /ruleset/, "and it says what an empty list usually means");

    const source = readFileSync("scripts/rollup-prs.mjs", "utf8");
    assert.match(
      source,
      /refusing to build: \$\{gate\.why\}/,
      "--apply must refuse the whole run on an unusable gate, so the reason is stated once at the top "
        + "rather than as N identical per-member lines",
    );
    assert.match(
      source,
      /live\.contexts\.length === 0/,
      "and an EMPTY contexts array must be recorded as an unreadable gate rather than kept as an empty "
        + "Set, which is the shape that makes every PR read green on a 200",
    );
  }

  // ── 4e-quaterdecies. Two runs of ONE required check on ONE commit — judge the LATEST ────────
  // Measured 2026-10-09 on PR #5605 at `6e8d0b9b96d3fb4bc676bf5772bdb10301239a39`. GitHub dropped the
  // `synchronize` event, the PR was closed and reopened to recreate the run, the dropped event was then
  // delivered late — so two `pull_request` runs existed on that one sha and `concurrency` cancelled the
  // first. `commits/<sha>/check-runs` returned `validate` TWICE (cancelled, run 37864635258; success,
  // run 37864679406) and `checks` twice the same way. `gh pr checks 5605 --required` read `pass` for
  // both. This module read the cancelled copies and the script printed
  // `RED CHECK #5605 ... required check(s) failing: validate (cancelled), checks (cancelled)`.
  //
  // A false red is the one direction AGENTS.md §6 cannot afford: a PR marked RED CHECK is held out of
  // the group and never reaches the owner, so a ready merge sits unmerged with nobody told why, while
  // the script's own "fix them and re-run" sends a session hunting a failure that does not exist.
  {
    const HEAD_AT = "2026-10-09T00:24:30Z";
    const RUN_URL = (run: string, job: string) =>
      `https://github.com/Phoenix-HR-CRM/phoenix-people-workforce/actions/runs/${run}/job/${job}`;
    const CANCELLED_RUN = "37864635258";
    const SURVIVING_RUN = "37864679406";
    // The four required-check entries exactly as gh returned them for #5605.
    const rollup = [
      { __typename: "CheckRun", name: "validate", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-10-09T00:24:46Z", completedAt: "2026-10-09T00:26:17Z", detailsUrl: RUN_URL(CANCELLED_RUN, "113608325621") },
      { __typename: "CheckRun", name: "validate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-09T00:26:22Z", completedAt: "2026-10-09T00:33:26Z", detailsUrl: RUN_URL(SURVIVING_RUN, "113608778532") },
      { __typename: "CheckRun", name: "checks", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-10-09T00:24:46Z", completedAt: "2026-10-09T00:26:18Z", detailsUrl: RUN_URL(CANCELLED_RUN, "113608325422") },
      { __typename: "CheckRun", name: "checks", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-09T00:26:22Z", completedAt: "2026-10-09T00:28:02Z", detailsUrl: RUN_URL(SURVIVING_RUN, "113608778846") },
    ];
    const gate = new Set(["validate", "checks"]);

    const state = requiredCheckState(rollup, gate, HEAD_AT);
    assert.deepEqual(
      state,
      { red: [], pending: [] },
      "#5605's own shape: the cancelled run of each name was SUPERSEDED by a later successful one, so "
        + "the gate passed — exactly what `gh pr checks --required` said — and reading the cancelled "
        + "copies held a ready PR out of the roll-up as RED CHECK",
    );
    assert.deepEqual(
      membersReadyToBuild([{ number: 5605, ...state }]).carry,
      [5605],
      "and the member is therefore rollable, which is the whole point: the owner gets the one merge",
    );
    // The API's order is not a contract — the earlier run came first for #5605, but nothing promises it.
    assert.deepEqual(
      requiredCheckState([...rollup].reverse(), gate, HEAD_AT),
      { red: [], pending: [] },
      "and the answer cannot depend on which copy the API happened to return first",
    );
    assert.equal(
      latestRunPerName(rollup).length,
      2,
      "two names, four runs, one entry each — the dedup is what the rest of the judgement runs on",
    );

    // Narrowing WHICH run is judged must not soften the judgement. A cancelled run that came LAST is
    // the live verdict and still red.
    assert.deepEqual(
      requiredCheckState(
        [
          { name: "validate", conclusion: "SUCCESS", startedAt: "2026-10-09T00:24:46Z", completedAt: "2026-10-09T00:26:17Z", detailsUrl: RUN_URL(CANCELLED_RUN, "113608325621") },
          { name: "validate", conclusion: "CANCELLED", startedAt: "2026-10-09T00:26:22Z", completedAt: "2026-10-09T00:33:26Z", detailsUrl: RUN_URL(SURVIVING_RUN, "113608778532") },
        ],
        new Set(["validate"]),
        HEAD_AT,
      ).red,
      ["validate (cancelled)"],
      "a cancelled run that is the LATEST one is this commit's verdict — the dedup narrows which run is "
        + "judged, it never excuses a cancellation",
    );

    // And a name with NOTHING to supersede it keeps its reading: not settled, and never green.
    const lone = requiredCheckState(
      [{ name: "validate", conclusion: "CANCELLED", startedAt: "2026-10-09T00:24:46Z", completedAt: "2026-10-09T00:26:17Z", detailsUrl: RUN_URL(CANCELLED_RUN, "113608325621") }],
      new Set(["validate"]),
      HEAD_AT,
    );
    assert.deepEqual(
      lone.red,
      ["validate (cancelled)"],
      "one run for the name and it was cancelled: nothing replaced it, GitHub will not count it as a "
        + "pass, so it stays UNSETTLED — dropping a cancelled run just because it is cancelled would "
        + "have turned this into a silent green",
    );
    assert.deepEqual(
      membersReadyToBuild([{ number: 5605, ...lone }]).carry,
      [],
      "and it is never built from",
    );

    // The run id is the last ordering key and has to work alone: a pair with no timestamps at all is
    // still ordered by the run it belongs to.
    assert.deepEqual(
      requiredCheckState(
        [
          { name: "validate", conclusion: "CANCELLED", detailsUrl: RUN_URL(CANCELLED_RUN, "113608325621") },
          { name: "validate", conclusion: "SUCCESS", detailsUrl: RUN_URL(SURVIVING_RUN, "113608778532") },
        ],
        new Set(["validate"]),
      ),
      { red: [], pending: [] },
      "GitHub's run ids increase, so the larger one is the later run — the only ordering left when a "
        + "pair carries no usable timestamps",
    );

    // Nothing orderable at all is a hand-written shape, and there the BLOCKING entry is kept: an
    // unorderable pair may only ever wait longer, never build sooner.
    for (const pair of [
      [{ name: "validate", conclusion: "CANCELLED" }, { name: "validate", conclusion: "SUCCESS" }],
      [{ name: "validate", conclusion: "SUCCESS" }, { name: "validate", conclusion: "CANCELLED" }],
    ]) {
      assert.deepEqual(
        requiredCheckState(pair, new Set(["validate"])).red,
        ["validate (cancelled)"],
        "with no timestamps and no run id there is no evidence which came last, so the blocking entry "
          + "is the one judged, whichever order they arrive in",
      );
    }
  }

  // ── 4f. The required list is READ, never written down here ──────────────────────────────────
  {
    const source = readFileSync("scripts/rollup-prs.mjs", "utf8");
    assert.match(
      source,
      /readProtectionContexts/,
      "the required list must come from branch protection, live. AGENTS.md §2: it has rotted five times "
        + "(4 -> 5 -> 6 -> 4 -> 2) and `lint`/`typecheck`/`test` stopped being check names on 2026-09-27.",
    );
    for (const name of ["validate", "checks", "lint", "typecheck", "secret-scan"]) {
      // Quotes only, never backticks: the file's own prose cites `checks` and the required `checks`
      // job by name, and that is documentation, not a constant the code reads.
      assert.doesNotMatch(
        source,
        new RegExp(`['"]${name}['"]`),
        `rollup-prs.mjs must not hardcode the check name \`${name}\` — a constant here disqualifies PRs on `
          + "a name nothing reports any more, or misses the one that actually gates.",
      );
    }
  }

  // ── 5. A draft is left alone ─────────────────────────────────────────────────────────────────
  {
    const v = verdicts([pr(1, ["docs/a.md"], { isDraft: true }), pr(2, ["docs/b.md"])]);
    assert.equal(v.get(1)?.kind, "skip", "a draft is not a merge candidate");
  }

  // ── 6. A lone small PR proposes nothing — a roll-up of one saves nothing ─────────────────────
  {
    const { code, out } = runRollup([pr(1, ["docs/only.md"])]);
    assert.equal(code, 0);
    const parsed = JSON.parse(out) as { group: number[]; saving: number };
    assert.deepEqual(parsed.group, [], "one PR cannot be rolled up with itself");
    assert.equal(parsed.saving, 0);
  }

  // ── 7. A wide PR rides along, but never forms a roll-up on its own ──────────────────────────
  // Two finished unrelated features should not be welded together purely for arithmetic; the problem
  // being solved is the SMALL PR with nowhere to go.
  {
    const wideOnly = JSON.parse(
      runRollup([pr(1, ["a/1", "a/2", "a/3", "a/4", "a/5"]), pr(2, ["b/1", "b/2", "b/3", "b/4", "b/5"])]).out,
    ) as { group: number[] };
    assert.deepEqual(wideOnly.group, [], "two wide PRs and no small one must propose no roll-up");

    const withSmall = JSON.parse(
      runRollup([pr(1, ["docs/small.md"]), pr(2, ["b/1", "b/2", "b/3", "b/4", "b/5"])]).out,
    ) as { group: number[]; saving: number };
    assert.deepEqual(
      withSmall.group.sort((a, b) => a - b),
      [1, 2],
      "a small PR plus a disjoint wide one is one merge instead of two — the wide one costs nothing to carry",
    );
    assert.ok(withSmall.saving > 0, "that grouping must report a saving");
  }

  // ── 8b. AGENTS.md must carry the rule, because a PR comment is not enforcement ───────────────
  // #4814 was merged out from under roll-up #4821 four minutes after the roll-up was built AND
  // commented on it, paying ~28 billable minutes for nothing. The tool and C10's refusal text were
  // not enough: only AGENTS.md is auto-loaded on every request by every session. If the rule is ever
  // trimmed out of it, this goes red rather than the next session rediscovering it the same way.
  {
    const agents = readFileSync("AGENTS.md", "utf8").replace(/\s+/g, " ");
    assert.match(
      agents,
      /scripts\/rollup-prs\.mjs/,
      "AGENTS.md must name `node scripts/rollup-prs.mjs` as the step before asking the owner to merge. "
        + "The owner's instruction is that triaging open PRs is never his job (2026-09-30: \"i till now "
        + "donot know what to do with small open prs\"), and a rule that lives only in a script or in a "
        + "hook's refusal text is one a session can merge straight past — which is exactly what happened.",
    );
    assert.match(
      agents,
      /NEVER HAND HIM MORE THAN ONE MERGE AT A TIME/,
      "AGENTS.md must still carry the one-merge-at-a-time rule verbatim in §6.",
    );

    // 🔴 AND THE WINDOW, because "do not merge the members separately" is unusable without it.
    // Measured 2026-09-30: roll-up #4911 opened at ~13:16 with a warning comment on each member, and
    // lost #4910 at 13:17:55 and #4909 at 13:18:55 — the first 90 seconds after being warned. With
    // that morning's #4814 that is three members lost in one day, every one of them told in writing.
    // An earlier reading of the same day put the window at ten minutes and concluded a roll-up should
    // be built once its members went green; that is backwards, and these assertions are what stop the
    // shorter, correct figure being trimmed back out of the one file every session auto-loads.
    assert.match(
      agents,
      /MERGED BEFORE ITS MEMBERS, NOT MERELY BUILT BEFORE THEM/,
      "AGENTS.md §6 must say a roll-up is MERGED before its members, not merely built before them — "
        + "they merged 90 seconds after being warned, so the window is what makes the rule usable.",
    );
    assert.match(
      agents,
      /the comment is a courtesy, never a guard/,
      "and it must say the comment does not enforce it — three sessions were each told on their own PR "
        + "and each merged anyway, so a session reading only the warning would go on trusting it.",
    );
    assert.match(
      agents,
      /if they land first, CLOSE it — never merge it/,
      "and it must say what to do once the members have landed: a roll-up whose members merged replaces "
        + "no merges and is byte-identical on main, so merging it is an empty squash paying a full main run.",
    );
  }

  // ── 8. --apply is refused against a snapshot, and the script never merges ────────────────────
  {
    const { code, out } = runRollup([pr(1, ["docs/a.md"]), pr(2, ["src/b.ts"])], ["--apply"]);
    assert.notEqual(code, 0, "--apply against a fixture must be refused: a snapshot is not the live repo");
    assert.match(out, /refused with PHX_ROLLUP_FIXTURE/);
  }
  {
    const source = execFileSync(
      process.execPath,
      ["-e", "process.stdout.write(require('node:fs').readFileSync('scripts/rollup-prs.mjs','utf8'))"],
      { encoding: "utf8" },
    );
    assert.doesNotMatch(
      source,
      /'pr',\s*'merge'|"pr",\s*"merge"|pr merge/,
      "rollup-prs.mjs must never invoke `gh pr merge`. Merging is a protected action (AGENTS.md §6) and "
        + "needs the owner's word on each one; this tool exists so that word is given ONCE instead of N times.",
    );
    assert.match(
      source,
      /--close-superseded/,
      "closing must stay behind an explicit flag, and only for a bot PR",
    );
  }

  // ── 9. A carried PR is CLOSED, not left open for someone to merge again ─────────────────────
  // Roll-up #4871 merged on 2026-09-30 and GitHub closed only the one member whose head the roll-up
  // branch carried verbatim. #4861 and #4870 stayed OPEN with their content already on `main` — the
  // state that costs a full CI run on the PR and another on `main` when someone merges one of them, to
  // ship nothing. The `carried` verdict already existed and already read "close it, do not merge it";
  // nothing ever acted on it, and `--close-superseded` reaches only a BOT PR subsumed by a wider one.
  {
    const v = verdicts([pr(1, ["docs/a.md"], { carried: true }), pr(2, ["src/b.ts"])]);
    assert.equal(v.get(1)?.kind, "carried", "a PR whose every file is byte-identical on main is carried");
    assert.equal(v.get(2)?.kind, "rollable", "and a live one beside it is untouched by the settle pass");

    // The default run writes nothing and still names the PR and the command, or the affordance is
    // invisible and closing by hand stays the habit. `--json` suppresses it, so this asks for the
    // human report the way a session actually runs the script.
    const human = runRollupHuman([pr(1, ["docs/a.md"], { carried: true })]);
    assert.equal(human.code, 0);
    assert.match(human.out, /--settle to close #1/, "the report must name the command and the PR it would close");

    // And `--settle` is refused against a snapshot, for the same reason `--apply` is: closing is a write
    // against the live repository, and a fixture cannot authorise one.
    const settled = runRollup([pr(1, ["docs/a.md"], { carried: true })], ["--settle"]);
    assert.notEqual(settled.code, 0, "--settle against a fixture must be refused");
    assert.match(settled.out, /--settle is refused with PHX_ROLLUP_FIXTURE/);
  }

  // ── 10. The close path selects on the blob comparison, and closes rather than merges ────────
  {
    const source = readFileSync("scripts/rollup-prs.mjs", "utf8");
    assert.match(
      source,
      /const carriedPrs = open\.filter\(\(p\) => p\.verdict\.kind === 'carried'\)/,
      "the settle pass must select on the carried verdict — every file byte-identical on main — and nothing looser",
    );
    assert.match(source, /'pr', 'close', String\(pr\.number\)/, "and it closes through gh pr close");
    // The roll-up body must stop asking a human to close the originals, or the tool still leaves the
    // work behind that this change exists to pick up.
    assert.doesNotMatch(source, /Close the originals once this merges\./, "the hand-off note is retired");
    assert.match(source, /--settle\\` closes them/, "and the roll-up body names the command that does it");
  }

  // ── 11. --apply puts the folder back on the branch it found, on SUCCESS as well as on failure ──
  //
  // `abandon()` restored `startedOn`; the happy path did not. So every run that WORKED left its
  // folder parked on the roll-up branch, and the runs that failed were the tidy ones. On 2026-09-30
  // that stranded the SHARED PRIMARY CHECKOUT on `codex/rollup-20260930-1000` — clean, silent, and
  // read by every session that used the primary afterwards, where a bare `git` command resolves
  // against whatever is checked out. Three more local `codex/rollup-*` branches were left the same
  // way, and `new-session.mjs --remove` judges a worktree by the branch it finds checked out.
  //
  // This is pinned on the SOURCE because the restore is the last effect of a script whose whole body
  // is top-level effects against a live repository and GitHub; the fixture harness above deliberately
  // refuses `--apply`, so there is no run in which to observe it.
  {
    const source = readFileSync("scripts/rollup-prs.mjs", "utf8");
    const push = source.indexOf("git(['push', '--quiet', '--set-upstream', 'origin', branch]");
    assert.notEqual(push, -1, "the push is still how the branch reaches origin");

    // Between the push and `gh pr create`, and nowhere later. `gh()` exits the process on a GitHub
    // failure, so a restore written after the PR call is skipped exactly when the build half-worked —
    // pushed, no PR, folder moved. Nothing from the push onwards needs the branch checked out: the PR
    // is created with `--head`, and a superseded PR is closed by number.
    const create = source.indexOf("'pr', 'create', '--repo'");
    assert.ok(create > push, "the PR is still created after the push");
    const between = source.slice(push, create);
    assert.match(
      between,
      /git\(\['switch', '--quiet', startedOn\], \{ cwd: root, allowFail: true \}\)/,
      "after pushing, --apply must switch the folder back to the branch it started on — before the PR "
        + "call, because gh() exits the process on failure and would skip a restore written below it",
    );

    // It must not be able to fail a roll-up that is already pushed and open, and it must not go quiet
    // if it cannot happen — a folder moving with nothing announcing it IS the defect.
    assert.match(between, /allowFail: true/, "a restore that cannot happen must not fail a pushed roll-up");
    assert.match(between, /could not switch .* back to/, "and it must say so rather than move the folder in silence");

    // The branch is pushed and carries an open PR, so unlike `abandon()` the success path deletes
    // nothing: `branch -D` here would throw away the local copy of a branch under review.
    assert.doesNotMatch(between, /'branch', '-D'/, "the success path must never delete the roll-up branch it just pushed");

    // And `abandon()` keeps its own restore — this change adds a second one, it does not move the first.
    const abandonStart = source.indexOf("function abandon(lines)");
    assert.notEqual(abandonStart, -1);
    assert.match(
      source.slice(abandonStart, abandonStart + 600),
      /git\(\['switch', '--quiet', startedOn\]/,
      "the abandon path must still put the folder back too",
    );
  }

  // ── 12. An open roll-up over the same PRs must REFUSE a second build ─────────────────────────
  // On 2026-09-30 #4904 and #4905 were opened 46 seconds apart with identical members (#4901, #4902,
  // #4903) over the same ten files, because `--apply` asked only whether its own BRANCH NAME was
  // free. The unique-name rule worked and prevented nothing: the names differed by a minute, so
  // neither run could see the other. Then #4901 and #4902 were merged individually out from under
  // #4904, turning three intended merges into four.
  {
    const rollups = [{ number: 4904, headRefName: "codex/rollup-20260930-1000", members: [4901, 4902, 4903] }];

    // identical members — the measured case
    const same = overlappingRollup({ wanted: [4903, 4901, 4902], rollups });
    assert.ok(same, "an open roll-up with identical members must be found");
    assert.equal(same!.number, 4904);
    assert.deepEqual(same!.shared, [4901, 4902, 4903], "and it names every member already carried, sorted");
    assert.equal(same!.unreadable, false);

    // 🔴 OVERLAP, not equality, is the test. Whichever roll-up merges first leaves the other carrying
    // members already on main, and its remaining members are then stuck behind a roll-up nobody can
    // merge — the same harm as the identical case, reached by a narrower path.
    const partial = overlappingRollup({ wanted: [4902, 4910], rollups });
    assert.ok(partial, "a PARTIAL overlap must refuse too, not just an identical member set");
    assert.deepEqual(partial!.shared, [4902]);

    // A disjoint roll-up is not a collision: two roll-ups over different PRs are exactly the point.
    assert.equal(overlappingRollup({ wanted: [4910, 4911], rollups }), null, "disjoint members must still build");
    assert.equal(overlappingRollup({ wanted: [], rollups }), null, "nothing wanted is not a collision");
    assert.equal(overlappingRollup({ wanted: [4901], rollups: [] }), null, "no open roll-up is not a collision");
  }

  // ── 12b. A roll-up whose members cannot be read counts as a COLLISION ────────────────────────
  // The one direction that matters: an unknown must never read as "carries nothing", because that is
  // how a second roll-up gets built over live work. Same rule the branch-name check already uses.
  {
    const unreadable = overlappingRollup({
      wanted: [4901],
      rollups: [{ number: 4904, headRefName: "codex/rollup-20260930-1000", members: [] }],
    });
    assert.ok(unreadable, "a roll-up whose members could not be parsed must refuse the build");
    assert.equal(unreadable!.unreadable, true, "and it must say WHY, so the refusal is not read as a real overlap");
    assert.deepEqual(unreadable!.shared, []);
  }

  // ── 12c. Members are read from the body's LIST, never from its prose ─────────────────────────
  // The body names AGENTS.md sections and quotes `tests/run-tests.ts`, and a member's own title can
  // carry an issue reference. A loose /#d+/ sweep would read those as members and refuse a build
  // for nothing — a false refusal is as bad here as a missed one, because it sends the session back
  // to merging small PRs one at a time.
  {
    const body = [
      "Rolls up several open pull requests into ONE merge, so the CI bill is paid once instead of 3 times.",
      "",
      "Each is carried by merging its own head commit, so authorship and history are preserved:",
      "",
      "- #4901 — feat(employee-portal): group Business Cards under a Social band (3 files)",
      "- #4902 — fix(#4123 regression): the name is an <h2> in the portal (5 files)",
      "",
      "Their file sets are disjoint, `tests/run-tests.ts` being the standing example. See AGENTS.md #6.",
    ].join("\n");
    assert.deepEqual(
      rollupMembers(body),
      [4901, 4902],
      "only the '- #N —' list lines are members: not the title's own #4123, not the prose's AGENTS.md #6",
    );
    assert.deepEqual(rollupMembers(""), [], "an empty body yields no members");
    assert.deepEqual(rollupMembers(undefined), [], "and a missing body must not throw");
  }

  // ── 12d. rollup-prs.mjs must actually GATE on it, before the members-wait ────────────────────
  // A pure function nothing calls is not a guard. And placement is load-bearing: refusing AFTER the
  // wait would spend minutes waiting for checks on members another roll-up already owns. Matched as
  // plain substrings rather than patterns — the thing under test is a call site, not a shape.
  {
    const source = readFileSync("scripts/rollup-prs.mjs", "utf8");
    const gate = source.indexOf("overlappingRollup({ wanted: group.map");
    assert.notEqual(gate, -1, "--apply must call the duplicate guard on the group it is about to build");
    assert.ok(
      source.includes("isRollupBranch(pr.headRefName)"),
      "it must find the open roll-ups by the generated SHAPE, not the codex/rollup- prefix: a "
        + "branch that merely fixes the roll-up tool is not a roll-up, and reading it as one made "
        + "--apply refuse every build",
    );
    // The CALL, not the import: `waitForRequiredChecks` also appears in the import list at the top
    // of the script, and indexOf would have found that instead — making the ordering assertion
    // compare the gate against line 59 and fail on a correctly placed guard.
    const wait = source.indexOf("waitForRequiredChecks({");
    assert.notEqual(wait, -1, "the members-wait must still be there");
    assert.ok(
      gate < wait,
      "the duplicate refusal must come BEFORE the members-wait, or a duplicate build spends minutes "
        + "waiting for required checks on members an open roll-up already carries",
    );
    // A collision must stop the build, not print and carry on.
    const after = source.slice(gate, gate + 1400);
    assert.ok(after.includes("process.exit(1)"), "a collision must exit non-zero");
    assert.ok(after.includes("REFUSED"), "and say REFUSED, so it is not mistaken for a warning");
  }
  // ── 13. A roll-up is never a MEMBER of another roll-up ───────────────────────────────────────
  // Measured 2026-09-30: with #4920 (itself a roll-up) open, the script offered #4922 + #4920 +
  // #4921. The duplicate guard above cannot see this — it asks whether an open roll-up CARRIES a
  // member we want, and here the roll-up IS the member we want. Nesting merges cleanly; what it
  // breaks is that AGENTS.md §6's "members must not be merged separately" becomes transitive with
  // nothing tracking it, and the saving is double-counted.
  {
    const v = verdicts([
      pr(1, ["src/a.ts"]),
      pr(2, ["scripts/b.mjs"], { headRefName: "codex/rollup-20260930-1000" }),
    ]);
    assert.equal(v.get(1)?.kind, "rollable", "an ordinary small PR is unaffected by this rule");
    assert.equal(
      v.get(2)?.kind,
      "separate",
      `a PR on a roll-up branch must never be rollable, got ${v.get(2)?.kind}: ${v.get(2)?.why}`,
    );
    assert.match(
      v.get(2)?.why ?? "",
      /itself a roll-up/,
      "and it must say so in words, since the reader has to decide what to do with it",
    );

    // 🔴 And a PR that FIXES the roll-up tool is not a roll-up. This exact branch name was flagged by
    // the first version of this rule, which matched on the `codex/rollup-` prefix alone.
    const w = verdicts([
      pr(1, ["src/a.ts"]),
      pr(3, ["scripts/rollup-prs.mjs"], { headRefName: "codex/rollup-dup-guard" }),
    ]);
    assert.equal(
      w.get(3)?.kind,
      "rollable",
      `a roll-up-TOOL PR must stay rollable, got ${w.get(3)?.kind}: ${w.get(3)?.why}`,
    );
  }
  // ── 14. A roll-up is recognised by its generated SHAPE, never by its prefix ──────────────────
  // 🔴 A measured false positive, found by running this fix against the live repo while its own PR
  // was open: `codex/rollup-dup-guard` FIXES the roll-up tool and is not a roll-up, but a prefix
  // match called it one. That was worse than the bug being fixed — the duplicate guard would have
  // found no `- #N —` list in its body, read 'unreadable', and so refused EVERY build for as long
  // as any roll-up-tool PR stayed open.
  {
    for (const name of [
      "codex/rollup-20260930-1000",
      "codex/rollup-20260930-1311",
      "codex/rollup-20260930-1000-2",
    ]) {
      assert.ok(isRollupBranch(name), name + " is a name rollupBranchName produces");
    }
    for (const name of [
      "codex/rollup-dup-guard",
      "codex/rollup-restore-branch",
      "codex/rollup-pending-checks",
      "codex/rollup-three",
      "codex/crm-list-polish",
      "",
    ]) {
      assert.equal(
        isRollupBranch(name),
        false,
        JSON.stringify(name) + " fixes or mentions the roll-up tool; it is not a roll-up",
      );
    }
    assert.equal(isRollupBranch(undefined), false, "a missing branch name must not throw");
  }
}
