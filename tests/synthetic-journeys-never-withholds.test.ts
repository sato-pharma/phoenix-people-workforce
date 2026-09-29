// The production smoke test must never be able to withhold a production deploy.
//
// WHY THIS EXISTS. A production deploy is gated on that commit's check suites (Railway "Wait for
// CI"), and Railway withholds the deploy when ANY suite on the commit fails — a withheld deploy is
// marked SKIPPED and never resurrects. A `schedule` run always runs on the default branch, so
// synthetic-journeys.yml attaches a suite to whatever `main` HEAD is when it fires. That cannot be
// avoided by moving the trigger: a side branch would run stale journeys against production.
//
// So if the journeys step failed the job, a production outage would suppress its own repair —
// production breaks, the journeys legitimately go red, that red suite lands on main HEAD, and the
// deploy carrying the fix is withheld. Once an hour, with ci.yml fully green.
//
// This is a TRUE alarm made harmful by where it lands, which is why the remedy differs from
// deploy-drift-check.yml's. That one was a FALSE alarm, fixed by comparing against a settled ref
// (tests/deploy-drift-settled-ref.test.ts). This one is fixed by keeping the job's CONCLUSION green
// while the failure is still reported — to the dashboard and as an ::error:: annotation.
//
// Twice in one month this class withheld a production deploy: deploy-drift-check's own cron on
// 2026-09-27 (cd9e0be03), and staging-hr-drift-check.yml failing to parse on 2026-09-29, freezing
// production for nearly two hours (#4778). A monitor must not gate the deploy it monitors.
//
// Each invariant is asserted SEPARATELY with its own message. A single combined regex would make
// every clause after the first unreachable — the defect that hid a dead assertion in
// tests/next-build-cpu-cap.test.ts on 2026-09-27.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORKFLOW = resolve(".github/workflows/synthetic-journeys.yml");

/** The block of YAML belonging to one named step, up to the next step at the same indent. */
function step(source: string, name: string): string {
  const start = source.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `synthetic-journeys.yml no longer has a step named "${name}".`);
  const rest = source.slice(start + 1);
  const nextAt = rest.indexOf("\n      - name: ");
  return nextAt === -1 ? rest : rest.slice(0, nextAt);
}

export function runSyntheticJourneysNeverWithholdsTests() {
  const source = readFileSync(WORKFLOW, "utf8");
  const journeys = step(source, "Run synthetic journeys");

  // 1. The step that actually exercises production must not fail the job. This single line is what
  //    stops a production outage withholding the deploy of its own fix.
  assert.match(
    journeys,
    /^\s*continue-on-error:\s*true\s*$/m,
    "🔴 The 'Run synthetic journeys' step lost `continue-on-error: true`. Without it a failing " +
      "production smoke test fails the job, that failed suite lands on main HEAD, and Railway " +
      "withholds the deploy carrying the fix — the outage suppresses its own repair.",
  );

  // 2. The step needs a stable id, because the reporting step below is gated on its outcome. If the
  //    id is renamed and the gate is not, the annotation silently stops firing and the failure goes
  //    completely quiet — the worst of both worlds.
  assert.match(
    journeys,
    /^\s*id:\s*journeys\s*$/m,
    "🔴 The 'Run synthetic journeys' step lost `id: journeys`. The failure annotation is gated on " +
      "`steps.journeys.outcome`, so renaming the id silences the only in-Actions signal.",
  );

  // 3. A failure must still be announced. Green conclusion, red annotation.
  const report = step(source, "Report a failed journey without failing the job");
  assert.match(
    report,
    /steps\.journeys\.outcome\s*==\s*'failure'/,
    "🔴 The failure report is no longer gated on the journeys step's outcome, so it will not fire " +
      "when production is actually broken.",
  );
  assert.match(
    report,
    /::error::/,
    "🔴 The failure report no longer emits an ::error:: annotation. With the job deliberately green, " +
      "that annotation is the only thing a human scanning the Actions list would see.",
  );

  // 4. The durable signal is the dashboard row, and it must still be written on a FAILED run. This
  //    is the reason keeping the job green is safe at all — remove it and the failure really does
  //    disappear.
  const save = step(source, "Save the run to the dashboard");
  assert.match(
    save,
    /if:\s*\$\{\{\s*always\(\)/,
    "🔴 'Save the run to the dashboard' is no longer `always()`. A failed run would stop reaching " +
      "public.synthetic_journey_runs, and since the job is deliberately green, the failure would " +
      "then be invisible everywhere.",
  );
}
