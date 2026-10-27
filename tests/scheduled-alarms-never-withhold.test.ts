// A scheduled alarm must never be able to withhold a production deploy.
//
// WHY THIS EXISTS, MEASURED. A production deploy is gated on that commit's check suites (Railway
// "Wait for CI" — the production trigger reads `checkSuites: true`, confirmed live off Railway on
// 2026-09-30). Railway withholds the deploy when ANY suite on the commit fails OR is cancelled, and a
// withheld deploy goes `in_progress -> inactive`, never reaches `success`, and never resurrects: five
// seconds after the bad suite concludes, permanently, with `ci.yml` green before and after.
//
// A `schedule:` run always runs on the default branch, so its suite lands on whatever commit is
// `main` HEAD when it fires — a commit chosen purely by timing, belonging to somebody else's merge.
// That cannot be fixed by moving the trigger. So an alarm that goes red pays for its own honesty with
// a production deploy, and the worst case is circular: deploy-drift-check.yml's job is to notice that
// production is stale, and its red suite made production staler. That happened to cd9e0be03 on
// 2026-09-27, and staging-hr-drift-check.yml failing to parse froze production for nearly two hours
// on 2026-09-29 (#4778). Three more deploys were lost this way on 2026-09-30.
//
// The rule this repo already states, in staging-hr-drift-check.yml's own header: "NEITHER STEP MAY
// FAIL ON A FINDING … Only a BROKEN check fails." A finding is reported — annotation, job summary,
// Telegram — while the job concludes success. A broken check (checkout failed, pnpm install failed)
// still fails, because that is not a finding, it is the alarm itself not working.
//
// 🔴 THIS TEST PINS THE INVARIANT, NOT THE SPELLING. It deliberately does not hardcode step ids or
// step names: those are free to change, and a test that pinned them would go red on a rename while
// staying green on the thing that actually matters. What it asserts is that each alarm still has a
// step that cannot fail the job, and that its alert is NOT gated on `failure()` alone.
//
// That second assertion is the subtle one and the reason this file is worth its bytes. The moment a
// job stops concluding failure, `if: ${{ failure() }}` is permanently false — so the naive version of
// this fix silently DELETES the alarm while looking like it hardened it. Trading a withheld deploy for
// a lost alert is worse than the bug.
//
// Each invariant is asserted SEPARATELY with its own message. A single combined regex would make
// every clause after the first unreachable — the defect that hid a dead assertion in
// tests/next-build-cpu-cap.test.ts on 2026-09-27.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The alarms that must never withhold a deploy: every workflow with a `schedule:` trigger whose
 * failure modes are FINDINGS rather than writes.
 *
 * 🔴 attendance-weekly-digest.yml is ABSENT ON PURPOSE and must stay absent — see EXCLUDED below.
 */
const ALARMS = [
  "deploy-drift-check.yml",
  "origin-certificate-check.yml",
  "security-scan.yml",
  "synthetic-journeys.yml",
  "staging-hr-drift-check.yml",
  // Added 2026-09-30 in the same change as this test. It was built to this pattern from its first
  // commit rather than converted into it — a ninth scheduled workflow that could go red would have
  // paid for a secret check with the production deploys the secret check protects.
  "secret-drift-check.yml",
];

/**
 * Alarms with NO `schedule:` of their own, because a clock outside GitHub dispatches them.
 *
 * synthetic-journeys.yml is fired by cron-job.org through /api/cron/run-synthetic-journeys. It used to
 * carry a `schedule:` leg as well, so it ran ~26 times a day instead of the 6 it was meant to (owner,
 * 2026-10-14, cost cuts: one clock). A DISPATCHED run attaches its suite to main HEAD exactly like a
 * scheduled one, so every other assertion below still applies to it. Only step 1 changes, and it
 * changes to pin the single clock: the `schedule:` leg must not come back.
 */
const DISPATCH_ONLY = new Set(["synthetic-journeys.yml"]);

/**
 * The one scheduled workflow that MUST still be able to fail red, and why.
 *
 * attendance-weekly-digest.yml settles unanswered attendance days to salary and applies them to
 * payroll. A write that failed halfway is not a finding to report — it is real money in an unknown
 * state, and it must be impossible to miss. Converting it would be the obvious-looking tidy-up that
 * makes a failed payroll run conclude green, so its exclusion is asserted rather than left to a
 * comment.
 */
const EXCLUDED = "attendance-weekly-digest.yml";

/**
 * Scheduled detectors that report every leg AND then go red on a finding (owner, 2026-10-23: "make the
 * Migration Drift Check go red again when its checks fail").
 *
 * The premise of ALARMS above was Railway's Wait-for-CI: a red suite on `main` HEAD withheld that
 * commit's production deploy. Wait-for-CI is OFF on every service since 2026-10-19/20 — the release
 * gate in ci.yml holds a deploy on `validate` + `checks` only — and the red Dependabot run on 12e535485
 * and the red Emergency host run on 68522a1bc both reached production `success` afterwards. Kept green
 * on purpose, migration-drift-check.yml showed 23 green nights in a row while every one had failing legs.
 *
 * So these keep the per-leg `continue-on-error` (every leg runs; the alert is gated on step outcomes)
 * and END with a step that fails the job. That is only safe while Wait-for-CI stays off, so the
 * precondition is pinned below: switch `checkSuites` back on and this test goes red until each of these
 * goes back into ALARMS.
 */
const REDS_ON_A_FINDING = ["migration-drift-check.yml"];

function workflow(file: string): string {
  return readFileSync(resolve(".github/workflows", file), "utf8");
}

/**
 * The block of YAML belonging to one named step, up to the next step at the same indent.
 *
 * Needed because "does this file contain `continue-on-error`" is the WRONG question. Seven of the
 * eight instances in this repo sit on a NOTIFY step, where it is correct and load-bearing: a Telegram
 * delivery that fails must not mask the real failure it was reporting. Only its presence on a step
 * that does the WORK changes whether a finding can fail the job. An unscoped assertion here failed a
 * workflow that was right — the test was wrong, not the YAML.
 */
function step(source: string, file: string, name: string): string {
  const start = source.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `${file} no longer has a step named "${name}".`);
  const rest = source.slice(start + 1);
  const nextAt = rest.indexOf("\n      - name: ");
  return nextAt === -1 ? rest : rest.slice(0, nextAt);
}

function assertRedsOnAFinding(): void {
  // The precondition. Every Railway source in the config-as-code must have Wait-for-CI OFF, or a red
  // run here withholds whatever commit is main HEAD again.
  const railway = readFileSync(resolve(".railway/railway.ts"), "utf8");
  const sources = railway.match(/checkSuites:\s*(true|false)/g) ?? [];
  assert.ok(sources.length >= 2, `expected to read checkSuites on the Railway services, found ${sources.length}`);
  assert.ok(
    sources.every((m) => /false$/.test(m)),
    "🔴 .railway/railway.ts turns Railway's Wait-for-CI (`checkSuites: true`) back on, so a red " +
      `scheduled run withholds main HEAD's production deploy again. Move ${REDS_ON_A_FINDING.join(", ")} ` +
      "back into ALARMS and restore its finish-green shape before switching it on.",
  );

  for (const file of REDS_ON_A_FINDING) {
    const source = workflow(file);
    assert.ok(!ALARMS.includes(file), `${file} is in both ALARMS and REDS_ON_A_FINDING`);
    assert.match(source, /^\s*schedule:\s*$/m, `${file} is no longer scheduled; remove it from REDS_ON_A_FINDING`);

    // Every leg still runs and reports: continue-on-error + an id, and the alert gated on outcomes.
    assert.match(source, /^\s*continue-on-error:\s*true\s*$/m, `🔴 ${file}: its legs lost continue-on-error, so the first red leg skips every later one`);
    const telegram = step(source, file, "Notify Telegram on failure");
    assert.match(
      telegram,
      /steps\.[A-Za-z0-9_-]+\.outcome\s*==\s*'failure'/,
      `🔴 ${file}: the Telegram alert is no longer gated on the legs' outcomes, so a finding can reach nobody`,
    );

    // The verdict: a step AFTER the alert, gated on the same outcomes, that exits non-zero, with no
    // continue-on-error of its own (that would make it green again).
    const verdict = step(source, file, "Fail the run when a check found something");
    assert.ok(
      source.indexOf("      - name: Fail the run when a check found something") > source.indexOf("      - name: Notify Telegram on failure"),
      `🔴 ${file}: the failing step must come AFTER the Telegram alert, or a finding fails the job before anyone is told`,
    );
    assert.match(verdict, /steps\.[A-Za-z0-9_-]+\.outcome\s*==\s*'failure'/, `🔴 ${file}: the failing step is not gated on the legs' outcomes`);
    assert.doesNotMatch(verdict, /test_alert/, `🔴 ${file}: a Telegram self-test is not a finding and must not fail the run`);
    assert.doesNotMatch(verdict, /continue-on-error:\s*true/, `🔴 ${file}: the failing step has continue-on-error, so the run is green on a finding again`);
    assert.match(verdict, /^\s*exit 1\s*$/m, `🔴 ${file}: the failing step no longer exits 1`);
    assert.match(verdict, /timeout-minutes:\s*\d+/, `🔴 ${file}: the failing step needs its own budget`);
  }
}

export function runScheduledAlarmsNeverWithholdTests() {
  assertRedsOnAFinding();

  for (const file of ALARMS) {
    const source = workflow(file);

    // 1. It is only in scope while it is actually scheduled. If a `schedule:` is ever removed the
    //    workflow stops attaching suites to main HEAD and this whole class evaporates for it — but
    //    then the list above is stale, and a stale list is how a real alarm quietly loses its cover.
    //    A DISPATCH_ONLY alarm inverts the question: its single clock is outside GitHub.
    if (DISPATCH_ONLY.has(file)) {
      assert.doesNotMatch(
        source,
        /^\s*schedule:\s*$/m,
        `🔴 ${file} has a schedule: trigger again. cron-job.org is its ONE clock; a second leg on ` +
          "GitHub's schedule is what made it fire ~26 times a day instead of 6. Remove the schedule: block.",
      );
      assert.match(
        source,
        /^\s*workflow_dispatch:/m,
        `🔴 ${file} lost workflow_dispatch:, so the cron-job.org dispatch has nothing to start.`,
      );
    } else {
      assert.match(
        source,
        /^\s*schedule:\s*$/m,
        `🔴 ${file} is listed here as a scheduled alarm but no longer has a schedule: trigger. Either ` +
          "remove it from ALARMS, or restore the trigger — a list that names workflows which are no " +
          "longer scheduled stops describing the actual risk surface.",
      );
    }

    // 2. At least one step must be unable to fail the job. This single property is what stops the
    //    alarm withholding the deploy it is reporting on.
    assert.match(
      source,
      /^\s*continue-on-error:\s*true\s*$/m,
      `🔴 ${file} has no step with \`continue-on-error: true\`, so a finding fails the job. That ` +
        "failed suite lands on whatever commit is main HEAD when the schedule fires, and Railway " +
        "then withholds that commit's production deploy permanently.",
    );

    // 3. A step that cannot fail the job needs an id, because the alert and the report are gated on
    //    its outcome. Without one there is nothing to gate on and the failure goes completely quiet.
    assert.match(
      source,
      /^\s*id:\s*\S+\s*$/m,
      `🔴 ${file} has a continue-on-error step but no \`id:\` anywhere. The alert has to be gated on ` +
        "`steps.<id>.outcome`, so with no id the only options are a silent failure or a red job.",
    );

    // 4. THE LOAD-BEARING ONE. Something must be gated on a per-STEP signal rather than on
    //    `failure()`. Once the job concludes success, `failure()` never fires again — so a workflow
    //    that still gates its alert that way has not been hardened, it has been muted.
    //
    //    Two spellings are accepted because this repo already uses both, and both are correct:
    //    `steps.<id>.outcome == 'failure'` (synthetic-journeys.yml, and the conversions modelled on
    //    it), and `steps.<id>.outputs.<name>` where the step itself triages its exit code and writes
    //    a flag to $GITHUB_OUTPUT (staging-hr-drift-check.yml, which distinguishes exit 2 "finding"
    //    from any other code "the check is broken"). Insisting on the first would have failed a
    //    workflow that already implements this invariant properly — the test would have been wrong,
    //    not the workflow.
    assert.ok(
      /steps\.[A-Za-z0-9_-]+\.outcome\s*==\s*'failure'/.test(source)
        || /steps\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+/.test(source),
      `🔴 ${file} gates nothing on a per-step signal — neither \`steps.<id>.outcome == 'failure'\` ` +
        "nor a `steps.<id>.outputs.<flag>` from its own exit-code triage. If its alert is still " +
        "gated on `failure()`, that condition is permanently false now the job concludes success: " +
        "the alarm is silent, which is worse than the withheld deploy this change was meant to fix.",
    );

    // 5. The failure must remain visible in the Actions UI. With the conclusion deliberately green,
    //    the annotation is the only thing a human scanning the run list would see.
    assert.match(
      source,
      /::error::/,
      `🔴 ${file} no longer emits an ::error:: annotation. Its job is deliberately green on a ` +
        "finding, so without the annotation a failed run is indistinguishable from a clean one.",
    );

    // 6. A SETUP step that can fail avoidably defeats the whole guarantee, and this one really did.
    //    `actions/setup-node` defaults `package-manager-cache` to true, hunts for the repo's package
    //    manager and dies with "Unable to locate executable file: pnpm" unless Corepack was enabled
    //    first. That is a setup failure, so it is outside the notify-and-finish-green promise by
    //    design (a broken check is not a finding) — and the job goes RED, which is exactly what these
    //    workflows must never do on a schedule.
    //
    //    Measured on secret-drift-check.yml's first dispatch (run 36772499136, 2026-09-30): it went
    //    red before reaching the validator, and would have done so on every 06:41 UTC run. So an
    //    alarm added to catch silent breakage would itself have been withholding deploys silently.
    //    Either enable Corepack before setup-node, or turn the cache off if the job needs no install.
    if (/uses:\s*actions\/setup-node/.test(source)) {
      assert.ok(
        /package-manager-cache:\s*false/.test(source) || /Enable Corepack/i.test(source),
        `🔴 ${file} uses actions/setup-node without either enabling Corepack first or setting ` +
          "`package-manager-cache: false`. setup-node will look for pnpm, fail to find it, and fail " +
          "the JOB — a red scheduled suite, which withholds the production deploy of whatever commit " +
          "is main HEAD. A setup failure is outside this workflow's finish-green guarantee, so the " +
          "guarantee is only worth as much as the setup is reliable.",
      );
    }

    // 7. A CANCELLED suite withholds a deploy exactly as a red one does. Several of these sleep in a
    //    grace window where a newer run would supersede them, so cancel-in-progress is the same bug
    //    wearing different clothes — and it is easy to add back without thinking about deploys.
    if (/^concurrency:/m.test(source)) {
      assert.doesNotMatch(
        source,
        /cancel-in-progress:\s*true/,
        `🔴 ${file} sets \`cancel-in-progress: true\`. AGENTS.md §2.3: "red, cancelled, or still ` +
          'queued = no deploy". A superseded run leaves a cancelled suite on main HEAD, which ' +
          "withholds that commit's production deploy just as a failure would.",
      );
    }
  }

  // 8. The payroll writer must still be able to fail. This is the assertion that stops a later
  //    session applying the pattern above uniformly and making a half-finished payroll write conclude
  //    green.
  assert.ok(
    !ALARMS.includes(EXCLUDED),
    `🔴 ${EXCLUDED} has been added to ALARMS. It settles attendance days to SALARY and applies them ` +
      "to payroll — a failed write there is real money in an unknown state, not a finding to " +
      "report, and it must stay red. Remove it from the list.",
  );

  const digest = workflow(EXCLUDED);

  // Scoped to the step that does the WORK. `continue-on-error` on the notify step is correct and
  // load-bearing — a Telegram delivery that fails must not mask the payroll failure it was reporting —
  // so the file-wide form of this assertion failed a workflow that was right.
  const settle = step(digest, EXCLUDED, "Bring the review weeks up to date");
  assert.doesNotMatch(
    settle,
    /^\s*continue-on-error:\s*true\s*$/m,
    `🔴 ${EXCLUDED}'s settle step now has \`continue-on-error: true\`. That step writes attendance ` +
      "days to SALARY and applies them to payroll: a half-finished write is real money in an " +
      "unknown state, not a finding to report. Whatever this was meant to fix, it must not be fixed " +
      "by making a broken payroll run conclude green.",
  );

  // 9. …but it must still ALERT. It was the one workflow here with no notification path at all, which
  //    meant a failed payroll settle reached nobody. Staying red is not the same as being noticed.
  assert.match(
    digest,
    /TELEGRAM_BOT_TOKEN/,
    `🔴 ${EXCLUDED} has no Telegram alert. It writes attendance days to salary, and before ` +
      "2026-09-30 a failure reached nobody at all — red in a tab no one was watching. Failing " +
      "loudly requires something that is actually loud.",
  );

  // 10. NO WORKFLOW MAY CARRY A LINE AT COLUMN 0 THAT IS NOT A TOP-LEVEL YAML KEY.
  //
  //     This clause is not about withholding a deploy — it is about the alarm existing at all, which
  //     every clause above silently assumes. A continuation line starting at column 0 inside a
  //     `run: |` block TERMINATES the block scalar, and GitHub then refuses to load the whole
  //     workflow: it never runs, nothing turns red, and the schedule just stops. An alarm that stops
  //     silently is worse than one that never existed, because the quiet reads as "no findings".
  //
  //     🔴 Caught on 2026-10-01 while wiring check:required-checks into this alarm. A multi-line
  //     Telegram message was written as a literal shell string, putting TEN lines at column 0 — and
  //     every regex clause above still passed, because they match raw text and never ask whether the
  //     file is loadable. There is no YAML parser in this repo's dependency tree, so this cheap
  //     structural rule stands in for one. The fix is the style the file already used everywhere
  //     else: build multi-line strings with `printf` and `\n`.
  for (const file of [...ALARMS, ...REDS_ON_A_FINDING, EXCLUDED]) {
    const source = workflow(file);
    const offenders = source
      .split(/\r?\n/)
      .map((line, index) => ({ line, lineNo: index + 1 }))
      .filter(({ line }) => /^[^\s#]/.test(line) && !/^[A-Za-z][A-Za-z0-9_-]*:/.test(line));

    assert.equal(
      offenders.length,
      0,
      `🔴 ${file} has line(s) at column 0 that are not top-level YAML keys, so the \`run: |\` block ` +
        "scalar they sit inside ends early and GitHub will REFUSE THE WHOLE FILE — the workflow " +
        "stops running, silently, with nothing red to show it. Build multi-line strings with " +
        "`printf 'a\\n\\nb'` rather than a literal multi-line shell string.\n" +
        offenders.map(({ line, lineNo }) => `  ${lineNo}: ${line.slice(0, 90)}`).join("\n"),
    );
  }

  // 11. EVERY `permissions:` KEY MUST BE A SCOPE GITHUB ACTUALLY ACCEPTS.
  //
  //     Same consequence as clause 10 and a different cause: an unknown scope makes GitHub refuse to
  //     parse the workflow — `HTTP 422 … Unexpected value '<scope>'` — so the file never runs and the
  //     schedule stops with nothing red anywhere.
  //
  //     🔴 Caught on 2026-10-01 in the same change as clause 10, and only because the workflow was
  //     dispatched on its own branch before merging. `administration: read` looks obviously right —
  //     it is the permission the REST API documents for branch-protection reads — but it is not a
  //     scope a workflow may request, so the file was unparseable. Clause 10 passed on it, because
  //     the YAML was structurally fine; it was the VALUE that GitHub rejected.
  const VALID_SCOPES = new Set([
    "actions", "attestations", "checks", "contents", "deployments", "discussions", "id-token",
    "issues", "models", "packages", "pages", "pull-requests", "repository-projects",
    "security-events", "statuses",
  ]);

  //     🔴 A LINE WALK, NOT A REGEX, AND THAT IS THE SECOND LESSON OF THIS CLAUSE. The first
  //     attempt matched the block with `/^(\s*)permissions:\s*$\n(…)/m` — and `\s` MATCHES A
  //     NEWLINE, so `\s*$` swallowed the line break, the body group captured the empty string, and
  //     the assertion inspected nothing while reporting success. It was caught only by planting an
  //     invalid scope and watching nothing happen. That is the dead-assertion defect this file's own
  //     header warns about, reproduced by the person who wrote the warning.
  for (const file of [...ALARMS, ...REDS_ON_A_FINDING, EXCLUDED]) {
    const lines = workflow(file).split(/\r?\n/);
    const indentOf = (line: string): number => line.length - line.trimStart().length;

    for (let i = 0; i < lines.length; i += 1) {
      const header = /^([ \t]*)permissions:[ \t]*$/.exec(lines[i]);
      if (!header) continue;
      const baseIndent = header[1].length;

      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j];
        const bare = line.trim();
        if (bare === "" || bare.startsWith("#")) continue;
        // The block ends at the first real line that is not indented past `permissions:`.
        if (indentOf(line) <= baseIndent) break;

        // A TRAILING COMMENT IS LEGAL AND REAL — deploy-drift-check.yml carries
        // `actions: read # read this workflow own past runs, to count the failure streak`. The first
        // version of this pattern demanded end-of-line after the value and failed a workflow that
        // was correct, which is the same mistake clause 8 records: an over-strict assertion is a
        // false positive, and a false positive in a test is a test people delete.
        const entry = /^[ \t]+([a-z-]+):[ \t]*(read|write|none)[ \t]*(#.*)?$/.exec(line);
        assert.ok(
          entry !== null,
          `🔴 ${file}:${j + 1} sits inside a \`permissions:\` block but is not a \`<scope>: ` +
            `read|write|none\` line, so GitHub may refuse the workflow: ${bare.slice(0, 80)}`,
        );
        assert.ok(
          VALID_SCOPES.has(entry[1]),
          `🔴 ${file}:${j + 1} requests the permission scope \`${entry[1]}\`, which GitHub does not ` +
            "accept. It answers `HTTP 422 — Unexpected value` and REFUSES TO PARSE THE WORKFLOW, so " +
            "the file never runs and its schedule stops silently. Note `administration` is NOT " +
            "requestable even though the REST API documents it for branch-protection reads — that " +
            `read needs a PAT. Valid scopes: ${[...VALID_SCOPES].join(", ")}.`,
        );
      }
    }
  }

  // 12. EVERY LEG THAT MAY FAIL MUST BE ABLE TO REACH THE ALERT.
  //
  //     A `continue-on-error` leg turns a finding into a step outcome and nothing else. If no Notify step
  //     reads that outcome, the finding is an annotation in a tab nobody opens: the job is green on
  //     purpose, so nothing else carries it. 🔴 Caught on 2026-10-27: secret-drift-check.yml's Railway
  //     trigger leg (`deploy_triggers`, added 23 Oct to catch the staging that went nine days without a
  //     deploy) was missing from its Notify step's `if`, so the one leg built after a silent failure was
  //     itself silent. Scoped to files that HAVE a Notify step; synthetic-journeys.yml and
  //     staging-hr-drift-check.yml alert from their own steps.
  for (const file of [...ALARMS, ...REDS_ON_A_FINDING]) {
    const lines = workflow(file).split(/\r?\n/);
    const starts = lines.flatMap((line, index) => (/^      - /.test(line) ? [index] : []));
    const blocks = starts.map((start, k) => lines.slice(start, starts[k + 1] ?? lines.length).join("\n"));
    const isNotify = (block: string) => /^      - name: Notify/m.test(block);
    if (!blocks.some(isNotify)) continue;
    const notifyIfs = blocks.filter(isNotify).map((block) => block.match(/^        if:.*$/m)?.[0] ?? "").join("\n");

    for (const block of blocks) {
      if (isNotify(block) || !/^        continue-on-error:\s*true\s*$/m.test(block)) continue;
      const name = block.split("\n")[0].replace(/^      - (name: )?/, "").slice(0, 80);
      const id = block.match(/^        id:\s*([A-Za-z0-9_-]+)\s*$/m)?.[1];
      assert.ok(id, `🔴 ${file}: the leg "${name}" may fail but has no \`id:\`, so no Notify step can read its outcome`);
      assert.match(
        notifyIfs,
        new RegExp(String.raw`steps\.${id}\.outcome\s*==\s*'failure'`),
        `🔴 ${file}: the leg \`${id}\` ("${name}") is not in any Notify step's \`if\`, so its finding reaches nobody. ` +
          "The job is green on a finding by design, so the alert is the only thing that carries it.",
      );
    }
  }
}
