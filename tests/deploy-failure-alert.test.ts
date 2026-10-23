// A failed production deployment must reach the owner, once, and must never turn a commit red.
//
// WHY THIS EXISTS. On 2026-10-23 four production deployments failed and nothing told anyone;
// deploy-drift-check.yml (a half-hourly clock that GitHub starts late and skips) stayed green all
// morning. .github/workflows/deploy-failure-alert.yml is push-driven instead: Railway reports each
// deployment to GitHub as a `deployment_status` event. This test pins the parts that are easy to
// break with no local symptom and expensive to find out later:
//
//   - the trigger and the filter (a wrong state or environment test makes the alarm silent, or makes
//     it page for staging and for every in-progress status);
//   - one alert per deployment (Railway sends several `failure` statuses for one deployment);
//   - both working steps are `continue-on-error` with their own timeout, because the run's check
//     suite attaches to the DEPLOYMENT'S COMMIT and a red or cancelled suite there is what makes a
//     release gate refuse that commit (tests/scheduled-alarms-never-withhold.test.ts, same rule);
//   - the Telegram step keeps its fallback text and the same secrets as the drift check.
//
// Each invariant is asserted SEPARATELY with its own message, so a failing clause names itself.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORKFLOW = resolve(".github/workflows/deploy-failure-alert.yml");

/** The workflow with comment-only lines removed, so prose that quotes a key never satisfies a pin. */
function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

export function runDeployFailureAlertTests() {
  const raw = readFileSync(WORKFLOW, "utf8");
  const source = withoutComments(raw);

  // 1 — it is driven by Railway's own report, not a clock.
  assert.match(source, /^on:\s*\n\s+deployment_status:\s*$/m, "the workflow must be triggered by `deployment_status`");
  assert.doesNotMatch(source, /^\s{2}schedule:/m, "a `schedule:` leg would make this a clock again, which is what deploy-drift-check.yml already is");

  // 2 — the job filter: failure AND error, production only, plus the manual self-test.
  const jobIf = /^ {4}if:\s*(.+)$/m.exec(source)?.[1] ?? "";
  assert.ok(jobIf.length > 0, "the job must carry an `if:` filter, otherwise every in-progress and success status would alert");
  assert.match(jobIf, /deployment_status\.state == 'failure'/, "the filter must alert on state `failure`");
  assert.match(jobIf, /deployment_status\.state == 'error'/, "the filter must alert on state `error`");
  assert.match(jobIf, /contains\(github\.event\.deployment\.environment, 'production'\)/, "the filter must be limited to the production environment");
  assert.match(jobIf, /workflow_dispatch/, "the filter must let the manual self-test through");
  assert.doesNotMatch(jobIf, /secrets\./, "the `secrets` context in an `if:` makes GitHub reject the whole workflow");
  for (const quiet of ["in_progress", "success", "inactive", "queued", "pending"]) {
    assert.ok(!jobIf.includes(`'${quiet}'`), `the filter must not alert on state \`${quiet}\``);
  }

  // 3 — one alert per deployment: the status list is read, the OLDEST failure decides.
  assert.match(source, /deployments\/\$\{DEPLOY_ID\}\/statuses/, "the deployment's status history must be read to de-duplicate");
  assert.match(source, /select\(\.state=="failure" or \.state=="error"\)\] \| last/, "the OLDEST failure/error status (last of a newest-first list) must be the one that alerts");
  assert.match(source, /"\$FIRST_FAIL" != "\$STATUS_ID"/, "a repeat status must be recognised by comparing with the current status id");
  assert.match(source, /group:\s*deploy-failure-alert-/, "runs must be serialised per deployment so the second failure sees the first");

  // 4 — it can never leave a red or cancelled suite on the deployment's commit.
  assert.match(source, /concurrency:[\s\S]*?cancel-in-progress:\s*false/, "cancelling a run would leave a `cancelled` suite on the deployment's commit");
  const jobCeiling = Number(/^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(source)?.[1] ?? "0");
  assert.ok(jobCeiling > 0, "the job needs its own timeout-minutes, otherwise its ceiling is six hours");
  const steps = source.split(/^ {6}- name: /m).slice(1);
  assert.equal(steps.length, 2, `expected exactly two steps (facts, Telegram), found ${steps.length}`);
  let budget = 0;
  for (const step of steps) {
    const name = step.split("\n")[0];
    assert.match(step, /^ {8}continue-on-error:\s*true\s*$/m, `step "${name}" must be continue-on-error so a finding or a delivery failure never turns the commit red`);
    const t = /^ {8}timeout-minutes:\s*(\d+)\s*$/m.exec(step);
    assert.ok(t, `step "${name}" needs its own timeout-minutes: a step timeout is absorbed, a job timeout concludes cancelled`);
    budget += Number(t![1]);
  }
  assert.ok(jobCeiling > budget, `the job ceiling (${jobCeiling}) must sit above the sum of its step budgets (${budget})`);

  // 5 — delivery: the same channel as the drift check, with a fallback so the facts step breaking never silences it.
  assert.match(source, /secrets\.TELEGRAM_BOT_TOKEN/, "must use the existing TELEGRAM_BOT_TOKEN secret");
  assert.match(source, /secrets\.TELEGRAM_ALERT_CHAT_ID/, "must use the existing TELEGRAM_ALERT_CHAT_ID secret, never a new recipient");
  assert.match(source, /if: \$\{\{ always\(\) && env\.SEND != 'no' \}\}/, "the Telegram step must run unless the facts step positively said this is a repeat");
  assert.match(source, /if \[ -z "\$\{TEXT:-\}" \]/, "the Telegram step must keep a bare fallback text for the case where the facts step broke");
  assert.match(source, /api\.telegram\.org\/bot\$\{TELEGRAM_BOT_TOKEN\}\/sendMessage/, "must post to the Telegram Bot API");
  assert.doesNotMatch(source, /parse_mode/, "the commit subject is attacker-shaped text; it must go out as plain text, never parsed as HTML or Markdown");

  // 6 — event data reaches the shell through `env:`, never interpolated into the script body.
  const scriptBodies = source.split(/^ {8}run: \|\n/m).slice(1).map((b) => b.split(/^ {6}- name: /m)[0]);
  assert.ok(scriptBodies.length === 2, `expected two run blocks, found ${scriptBodies.length}`);
  for (const body of scriptBodies) {
    assert.doesNotMatch(body, /\$\{\{/, "an expression inside a run block interpolates event data into shell source; pass it through env: instead");
  }
}
