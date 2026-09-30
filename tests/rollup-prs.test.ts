import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
function runRollup(prs: FakePr[], extraArgs: string[] = []): { code: number; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "phx-rollup-"));
  const fixture = path.join(dir, "prs.json");
  writeFileSync(fixture, JSON.stringify(prs), "utf8");
  try {
    const out = execFileSync(process.execPath, ["scripts/rollup-prs.mjs", "--json", ...extraArgs], {
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

function verdicts(prs: FakePr[], extraArgs: string[] = []): Map<number, { kind: string; why: string }> {
  const { code, out } = runRollup(prs, extraArgs);
  assert.equal(code, 0, `rollup-prs.mjs exited ${code}:
${out}`);
  const parsed = JSON.parse(out) as { open: Array<{ number: number; verdict: { kind: string; why: string } }> };
  return new Map(parsed.open.map((p) => [p.number, p.verdict]));
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
}
