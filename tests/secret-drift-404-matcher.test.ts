// The "BRANCH PROTECTION MAY BE GONE — MERGE NOTHING" alarm must fire on a 404, never on a SHA.
//
// WHY THIS EXISTS, MEASURED. secret-drift-check.yml captures the whole output of
// `scripts/check-required-checks.mjs` into `$out` and then asks whether it mentions a 404. Until
// 2026-10-06 it asked with `grep -q '404'` — a bare substring over the ENTIRE capture. That capture
// always contains the checkout's position line, `[required-checks] checkout <sha> — …`, and a short
// SHA is seven hex characters: roughly one tree in 500-1000 contains `404` somewhere, so ~0.1-0.2%
// of this daily alarm's runs declared `main` unprotected, told the owner to merge nothing, and
// failed the step — on a perfectly healthy gate, because of a commit id.
//
// A false alarm on a line that loud is worse than a missed catch: the second time it cries wolf the
// real one is ignored, and the real one is the condition under which every approval rule in
// AGENTS.md stops being true. So the matcher is anchored to the one line the script actually prints
// for this case, and this test holds it there.
//
// 🔴 IT PINS BOTH ENDS, WHICH IS THE POINT. The sample it matches against is COMPOSED from the two
// scripts' own string literals — `readProtectionContexts()`'s skip reason in
// scripts/required-check-names.mjs and the `SKIPPED — <why>.` template in
// scripts/check-required-checks.mjs. A test that hardcoded the sentence would go green while the
// script's wording drifted away from the workflow's pattern, which is exactly the failure that
// leaves a real missing protection undetected. Reword either script and this test says so.
//
// Each property is asserted SEPARATELY with its own message, for the reason
// tests/scheduled-alarms-never-withhold.test.ts states in its own header: a single combined regex
// makes every clause after the first unreachable.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORKFLOW = ".github/workflows/secret-drift-check.yml";
const NAMES_SCRIPT = "scripts/required-check-names.mjs";
const CHECK_SCRIPT = "scripts/check-required-checks.mjs";

function read(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

/**
 * The grep pattern the workflow uses to decide "branch protection answered 404".
 *
 * Found by its CONSEQUENCE rather than by its position: the escalation branch is the only one that
 * writes `gate_missing=true`, so the nearest `grep` above that line is the matcher under test. Step
 * names, comments and line numbers are all free to move without breaking this.
 */
function escalationMatcher(workflow: string): { pattern: string; body: string } {
  const lines = workflow.split(/\r?\n/);
  const flagAt = lines.findIndex((line) => line.includes("gate_missing=true"));
  assert.notEqual(
    flagAt,
    -1,
    `🔴 ${WORKFLOW} no longer writes \`gate_missing=true\` anywhere. That flag is what the "Report a ` +
      'required-check rotation" step reads to tell a missing gate apart from ordinary drift, so ' +
      "without it the 404 escalation has no way to say which of the two it found.",
  );

  for (let i = flagAt; i >= 0; i -= 1) {
    const found = /grep\s+-[A-Za-z]*q[A-Za-z]*\s+'([^']+)'/.exec(lines[i]);
    // The branch body is taken by LINE RANGE, not by searching the file for the pattern again: the
    // comment above the matcher legitimately quotes parts of it, and an indexOf would land there and
    // then assert against prose instead of against the shell.
    if (found) return { pattern: found[1], body: lines.slice(i, flagAt + 3).join("\n") };
  }

  assert.fail(
    `🔴 ${WORKFLOW} has no \`grep … '<pattern>'\` above its \`gate_missing=true\` line, so the 404 ` +
      "escalation is no longer driven by a greppable pattern. If the detection was rewritten, " +
      "rewrite this test with it — do not delete it: the condition it guards is the one where every " +
      "approval rule in AGENTS.md has silently stopped being enforced.",
  );
}

/** The exact line the script prints when branch protection answers 404, composed from the scripts. */
function realFourOhFourLine(): string {
  const names = read(NAMES_SCRIPT);
  const reason = /skipped:\s*'(protection returned 404[^']*)'/.exec(names);
  assert.ok(
    reason !== null,
    `🔴 ${NAMES_SCRIPT} no longer returns a \`{ skipped: 'protection returned 404 …' }\` for an HTTP ` +
      "404 from branch protection. That sentence is the ONLY thing the alarm in " +
      `${WORKFLOW} matches on, so rewording it here silently disarms the "main may not be protected ` +
      'at all" escalation — the run goes green and says nothing.',
  );

  const check = read(CHECK_SCRIPT);
  const prefix = "[required-checks] SKIPPED — ";
  assert.ok(
    check.includes(`${prefix}\${live.skipped}.`),
    `🔴 ${CHECK_SCRIPT} no longer prints the skip reason as \`${prefix}<why>.\`. The alarm in ` +
      `${WORKFLOW} anchors its 404 match to that exact prefix, so changing it here turns a real ` +
      "missing branch protection into a quiet skip warning.",
  );

  return `${prefix}${reason![1]}.`;
}

export function runSecretDrift404MatcherTests() {
  const workflow = read(WORKFLOW);
  const { pattern, body: branchBody } = escalationMatcher(workflow);

  // 1. The bare substring must be gone. This is the defect itself, named literally, so a revert is
  //    caught rather than merely implied by the behavioural clauses below.
  assert.notEqual(
    pattern,
    "404",
    `🔴 ${WORKFLOW} is back to matching the bare substring \`404\` over the whole captured output of ` +
      "check-required-checks.mjs. That output always carries the checkout's short SHA, so a SHA " +
      'containing "404" raises "BRANCH PROTECTION MAY BE GONE — MERGE NOTHING" on a healthy gate ' +
      "(~0.1-0.2% of runs) and fails the step. Anchor it to the script's own SKIPPED line instead.",
  );

  // 2. Anchored. An unanchored pattern can be satisfied by text ANYWHERE on a line, including inside
  //    the position line, a file path, or a sentence quoting a different HTTP code.
  assert.ok(
    pattern.startsWith("^"),
    `🔴 ${WORKFLOW}'s 404 matcher \`${pattern}\` is not anchored to the start of a line. The capture ` +
      "it searches contains the checkout SHA and several prose sentences, so anything unanchored is " +
      "one unlucky commit id away from the false alarm this test exists to prevent.",
  );

  // 3. THE LOAD-BEARING PAIR. The pattern is exercised against real output rather than inspected.
  //    GNU grep's ERE and JavaScript agree on everything this pattern uses (an anchor, escaped
  //    brackets and literal text), so running it here is running the matcher itself.
  const matcher = new RegExp(pattern, "m");

  const shaWith404 = [
    "[required-checks] protection requires 2: validate, checks",
    "[required-checks] AGENTS.md §2 declares 2: validate, checks",
    "[required-checks] checkout a404f1e — up to date with origin/main",
    "[required-checks] OK — the declared list matches the live gate.",
  ].join("\n");

  assert.doesNotMatch(
    shaWith404,
    matcher,
    `🔴 ${WORKFLOW}'s 404 matcher fires on a HEALTHY run whose checkout SHA happens to contain ` +
      '"404". That is the measured false alarm: the gate is fine, every name matches, and the ' +
      "workflow still tells the owner that `main` may not be protected and that he must merge " +
      "nothing. Match the script's own `SKIPPED — protection returned 404` line, anchored.",
  );

  // 3b. The same false positive wearing its other face: a REAL drift report, which must keep going
  //     down the ordinary rc != 0 path and be reported as a rotation, not as a missing gate. Reading
  //     drift as "protection is gone" sends the owner to the wrong fix.
  const driftWith404 = [
    "[required-checks] protection requires 2: validate, checks",
    "[required-checks] AGENTS.md §2 declares 3: validate, checks, mobile",
    "[required-checks] checkout 404bead — 404 commit(s) BEHIND origin/main",
    "[required-checks] ERROR: AGENTS.md states `mobile` but protection does NOT require it.",
  ].join("\n");

  assert.doesNotMatch(
    driftWith404,
    matcher,
    `🔴 ${WORKFLOW}'s 404 matcher fires on an ordinary required-check DRIFT report that merely ` +
      'contains "404" (in the SHA and in a commits-behind count). Drift and a missing gate are not ' +
      "the same finding and the report step says different things about them — AGENTS.md §2 was " +
      "corrected, versus merge nothing until protection is understood.",
  );

  // 4. …and the real thing must still escalate. Clauses 3 and 3b are only safe to make strict if
  //    this one holds: weakening the detection to silence a false alarm trades a noisy alarm for no
  //    alarm, on the one condition under which nothing in AGENTS.md is enforced any more.
  const real404 = [
    realFourOhFourLine(),
    "[required-checks] checkout 1e4bf2a — up to date with origin/main",
    "  AGENTS.md §2 declares 2: validate, checks",
    "  That is the DECLARATION, not the gate. Nothing here confirms it matches protection.",
  ].join("\n");

  assert.match(
    real404,
    matcher,
    `🔴 ${WORKFLOW}'s 404 matcher does NOT match the line check-required-checks.mjs actually prints ` +
      "when branch protection answers 404. The alarm is disarmed: `main` could be completely " +
      "unprotected and this daily check would conclude with a routine skip warning.",
  );

  // 5. The escalation's own body must still be an escalation. A matcher that matches but no longer
  //    raises an ::error::, sets the flag and exits 1 is the same loss by another route.
  assert.match(
    branchBody,
    /::error::branch protection returned 404/,
    `🔴 ${WORKFLOW}'s 404 branch no longer emits its \`::error::branch protection returned 404\` ` +
      "annotation. The job concludes success on purpose so it cannot withhold a production deploy, " +
      "so the annotation is the only thing a human scanning the run list would see.",
  );

  assert.match(
    branchBody,
    /exit 1/,
    `🔴 ${WORKFLOW}'s 404 branch no longer exits non-zero. The step is \`continue-on-error\`, so its ` +
      "exit code does not fail the job — it is what makes `steps.required_checks.outcome` read " +
      "`failure`, which is what gates the report step. Without it the finding reaches nobody.",
  );
}
