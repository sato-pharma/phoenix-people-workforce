import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { MIN_MEMBERS } from "../scripts/rollup-build-verdict.mjs";
import { membersReadyToBuild, waitForRequiredChecks } from "../scripts/rollup-check-state.mjs";
import { ROLLUP_BRANCH_PREFIX, overlappingRollup, rollupMembers } from "../scripts/rollup-duplicate-guard.mjs";

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
  /** The real `gh pr list --json statusCheckRollup` shape, so the actual required-vs-not filter runs. */
  statusCheckRollup?: Array<{
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
      source.includes("ROLLUP_BRANCH_PREFIX"),
      "and it must find the open roll-ups by the prefix rollupBranchName actually produces",
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
  assert.equal(ROLLUP_BRANCH_PREFIX, "codex/rollup-", "the prefix must match rollupBranchName's output");
}
