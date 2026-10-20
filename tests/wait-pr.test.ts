import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `scripts/wait-pr.mjs` is the one merge wait, replacing the one each session used to write itself.
 *
 * Every failure it exists to stop was a CONFIDENT WRONG ANSWER rather than a crash, measured on
 * 2026-09-30 in a single session:
 *
 *   * a `sed` chain drifted and produced a wait that verified #4912 while its log said #4923;
 *   * a SETTLE wait armed on an already-red PR returned the failure instantly, reading like a verdict
 *     on a fresh run when nothing had been re-run;
 *   * a compound backgrounded command put two PRs' output in one log, so a SHIPPED line belonged to
 *     the wrong PR.
 *
 * So this drives the REAL script as a subprocess through `PHX_WAIT_PR_FIXTURE`, which replays a
 * scripted sequence of readings and skips sleeping entirely — the loop is exercised, not restated.
 */

type Poll = {
  mergedAt?: string | null;
  head?: string;
  checks?: Array<{ name: string; bucket: string }>;
  ship?: number;
};

function run(
  pr: number,
  polls: Poll[],
  extraArgs: string[] = [],
  required: string[] = ["validate", "checks"],
): { code: number; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "phx-waitpr-"));
  const fixture = path.join(dir, "polls.json");
  writeFileSync(fixture, JSON.stringify({ required, polls }), "utf8");
  try {
    const out = execFileSync(process.execPath, ["scripts/wait-pr.mjs", String(pr), ...extraArgs], {
      encoding: "utf8",
      env: { ...process.env, PHX_WAIT_PR_FIXTURE: fixture },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const pending = (head = "aaaaaaaaa") => ({
  head,
  checks: [
    { name: "validate", bucket: "pending" },
    { name: "checks", bucket: "pending" },
  ],
});
const green = (head = "bbbbbbbbb") => ({
  head,
  checks: [
    { name: "validate", bucket: "pass" },
    { name: "checks", bucket: "pass" },
  ],
});
const red = (head = "ccccccccc") => ({
  head,
  checks: [
    { name: "validate", bucket: "fail" },
    { name: "checks", bucket: "pass" },
  ],
});

export function runWaitPrTests(): void {
  // ── 1. Every line names the PR ───────────────────────────────────────────────────────────────
  // The drifted-sed failure: a wait reported another PR's verdict and nothing in its output said so.
  {
    const { out } = run(4927, [green()]);
    for (const line of out.trim().split("\n")) {
      assert.match(
        line,
        /\[wait-pr #4927\]/,
        `every line must name the PR, so a drifted script cannot look like a right answer. Got: ${line}`,
      );
    }
  }

  // ── 2. Green settles at 0 ────────────────────────────────────────────────────────────────────
  {
    const { code, out } = run(1, [pending(), pending(), green("deadbeef1")]);
    assert.equal(code, 0, `green must exit 0, got ${code}: ${out}`);
    assert.match(out, /GREEN on deadbeef1: validate=pass checks=pass/);
  }

  // ── 3. SETTLED RED is its own verdict, and does NOT exit 0 ───────────────────────────────────
  // A backgrounded task's notification reports the shell's exit status, so a red that exited 0 would
  // be announced as a success.
  {
    const { code, out } = run(2, [red("f00df00d1")]);
    assert.equal(code, 3, `a settled-red must exit 3, not 0 — a 0 reads as success in the notification`);
    assert.match(out, /SETTLED RED on f00df00d1: validate=fail checks=pass/);
    assert.doesNotMatch(out, /GREEN/, "and it must never use the word GREEN");
  }

  // ── 4. --green keeps waiting THROUGH a concluded red ─────────────────────────────────────────
  // Only a new push can change a red. A settle-wait armed on an already-red PR returns instantly and
  // reads like a verdict on a fresh run — that happened on #4925.
  {
    const { code, out } = run(3, [red(), red(), green("99999aaaa")], ["--green"]);
    assert.equal(code, 0, `--green must wait past the red and report the later green, got ${code}: ${out}`);
    assert.match(out, /GREEN on 99999aaaa/);
    assert.doesNotMatch(out, /SETTLED RED/, "--green never reports a red as its verdict");
  }

  // ── 5. An already-merged PR is not a failure ─────────────────────────────────────────────────
  {
    const { code, out } = run(4, [{ mergedAt: "2026-09-30T14:24:07Z", head: "abcabcabc", checks: [] }]);
    assert.equal(code, 0);
    assert.match(out, /ALREADY MERGED at 2026-09-30T14:24:07Z/);
  }

  // ── 6. Running out of readings gives up LOUDLY, never quietly green ──────────────────────────
  {
    const { code, out } = run(5, [pending(), pending()]);
    assert.equal(code, 7, "the timeout path must exit 7");
    assert.match(out, /GAVE UP/);
    assert.match(out, /last reading: validate=pending checks=pending/, "and it must say what it last saw");
  }

  // ── 7. Only REQUIRED checks count ────────────────────────────────────────────────────────────
  // `mobile` and `secret-scan` still run and no longer gate (protection read live 2026-09-29), so a
  // red one of those must not hold the wait — and `full-e2e` skipping must not read as pending.
  {
    const { code, out } = run(
      6,
      [
        {
          head: "1234abcd5",
          checks: [
            { name: "validate", bucket: "pass" },
            { name: "checks", bucket: "pass" },
            { name: "mobile", bucket: "fail" },
            { name: "full-e2e", bucket: "skipping" },
          ],
        },
      ],
    );
    assert.equal(code, 0, `a red NON-required check must not hold the wait, got ${code}: ${out}`);
    assert.doesNotMatch(out, /mobile/, "and a non-required check must not appear in the verdict");
  }

  // ── 8. The gate is never a list from this file ───────────────────────────────────────────────
  // main's required checks have rotted five times; a wait keyed on a remembered name waits forever.
  {
    const source = readFileSync("scripts/wait-pr.mjs", "utf8");
    assert.match(source, /readProtectionContexts/, "the gate must come from branch protection, live");
    // `checks` is deliberately NOT in this list and cannot be: it is also the `gh pr checks`
    // subcommand and an ordinary English word, so it cannot distinguish a hardcoded gate from
    // structure. The names below have no other job in this file, so any occurrence is a hardcode.
    for (const name of ["validate", "typecheck", "secret-scan", "mobile", "lint"]) {
      assert.doesNotMatch(
        source,
        new RegExp(`['"]${name}['"]`),
        `wait-pr.mjs must not hardcode the check name \`${name}\``,
      );
    }
  }

  // ── 9. --ship reports the deploy, and a non-ship verdict is not a 0 ──────────────────────────
  {
    const shipped = run(7, [{ ship: 2 }, { ship: 0 }], ["--ship"]);
    assert.equal(shipped.code, 0, "queued then shipped must end at 0");
    assert.match(shipped.out, /SHIPPED \(verify-shipped exit 0\)/);

    const notLive = run(8, [{ ship: 3 }], ["--ship"]);
    assert.equal(notLive.code, 4, "a NOT LIVE verdict must exit 4, never 0");
    assert.match(notLive.out, /NOT CONFIRMED \(verify-shipped exit 3\)/);

    // exit 6 is SHIPPED-but-main-is-red: it DID ship, so the wait succeeded; the red is reported
    // separately by verify-shipped and is not this script's verdict to give.
    const mainRed = run(9, [{ ship: 6 }], ["--ship"]);
    assert.equal(mainRed.code, 0, "shipped-with-a-red-main still shipped");
    assert.match(mainRed.out, /SHIPPED \(verify-shipped exit 6\)/);
  }

  // ── 10. A required check with NO ROW YET is unfinished — never "nothing pending among the rows
  //       that exist" ────────────────────────────────────────────────────────────────────────────
  // 20 Oct 2026, #6194, head e580286fe: the required `checks` job only starts after `static` and the
  // three `unit` jobs finish, so `gh pr checks` listed no row for it. The buckets were filtered down
  // to the names that existed, nothing in them was pending, and the script printed GREEN and exited 0
  // while `static` was still running and mergeStateStatus was BLOCKED. Each poll carries its own head
  // so the assertion can say WHICH reading produced a GREEN.
  {
    const validateOnly = (head: string): Poll => ({ head, checks: [{ name: "validate", bucket: "pass" }] });
    for (const extra of [[], ["--green"]]) {
      const { code, out } = run(10, [validateOnly("absent111"), validateOnly("absent222"), green("present33")], extra);
      assert.doesNotMatch(
        out,
        /GREEN on absent/,
        `a required check that has not reported yet must keep the wait going (${extra.join(" ") || "settle"}). Got: ${out}`,
      );
      assert.equal(code, 0, `the wait must still end green once the last required check reports, got ${code}: ${out}`);
      assert.match(out, /GREEN on present33: validate=pass checks=pass/, "and the GREEN line lists EVERY required name");
    }

    // It never reports (static never finished): the wait gives up loudly, naming the absent one.
    const never = run(11, [validateOnly("absent111"), validateOnly("absent222")]);
    assert.equal(never.code, 7, `a required check that never reports must end at the timeout (7), got ${never.code}: ${never.out}`);
    assert.doesNotMatch(never.out, /GREEN/, "and must never use the word GREEN");
    assert.match(never.out, /last reading: validate=pass checks=absent on absent222/, "and says which one it was missing");

    // A red is not SETTLED while a required name has yet to report — settle means "finished".
    const redWhileAbsent = run(12, [
      { head: "redabsent1", checks: [{ name: "validate", bucket: "fail" }] },
      { head: "redabsent2", checks: [{ name: "validate", bucket: "fail" }] },
    ]);
    assert.equal(redWhileAbsent.code, 7, `a red beside a required check that has not reported is not settled, got ${redWhileAbsent.code}: ${redWhileAbsent.out}`);
    assert.doesNotMatch(redWhileAbsent.out, /SETTLED RED/);

    // The same allow-list covers every other bucket that is not a pass: skipped, cancelled (a
    // superseded run), or one this script has never heard of.
    for (const bucket of ["skipping", "cancel", "queued-by-a-future-gh"]) {
      const { code, out } = run(13, [{ head: "oddbucket1", checks: [{ name: "validate", bucket: "pass" }, { name: "checks", bucket }] }]);
      assert.equal(code, 7, `a required check in bucket \`${bucket}\` is not a pass and must not read as green, got ${code}: ${out}`);
      assert.doesNotMatch(out, /GREEN/, `\`${bucket}\` must never be called GREEN`);
    }

    // No required row at all (an empty gate) is unfinished too, not vacuously green.
    const emptyGate = run(14, [{ head: "emptygate1", checks: [{ name: "validate", bucket: "pass" }] }], [], []);
    assert.equal(emptyGate.code, 7, `an empty required list must never read as green, got ${emptyGate.code}: ${emptyGate.out}`);
  }
}
