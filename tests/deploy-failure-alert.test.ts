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
//   - the live revision is read REPEATEDLY, and a deployment a later one carried stays quiet: one
//     reading taken at the failure is the revision being replaced, which paged him for a shipped
//     change on 2026-10-24 (clause 7);
//   - both working steps are `continue-on-error` with their own timeout, because the run's check
//     suite attaches to the DEPLOYMENT'S COMMIT and a red or cancelled suite there is what makes a
//     release gate refuse that commit (tests/scheduled-alarms-never-withhold.test.ts, same rule);
//   - the Telegram step keeps its fallback text and the same secrets as the drift check;
//   - the message is HANDED OFF to a second run on main (clause 8): the Telegram pair lives only in the main-only
//     `main-secrets` environment, and a `deployment_status` run has no branch for its "only main" rule to match,
//     because Railway creates each deployment with a bare commit sha as its ref (credentials audit, 19 Nov 2026).
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
  const jobs = jobBlocks(source);
  assert.deepEqual(Object.keys(jobs), ["alert", "send"], "expected exactly two jobs: `alert` works out the message, `send` posts it from main");
  const stepCount: Record<string, number> = { alert: 2, send: 1 };
  for (const [id, body] of Object.entries(jobs)) {
    const jobCeiling = Number(/^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(body)?.[1] ?? "0");
    assert.ok(jobCeiling > 0, `job \`${id}\` needs its own timeout-minutes, otherwise its ceiling is six hours`);
    const steps = body.split(/^ {6}- name: /m).slice(1);
    assert.equal(steps.length, stepCount[id], `job \`${id}\`: expected ${stepCount[id]} step(s), found ${steps.length}`);
    let budget = 0;
    for (const step of steps) {
      const name = step.split("\n")[0];
      assert.match(step, /^ {8}continue-on-error:\s*true\s*$/m, `step "${name}" must be continue-on-error so a finding or a delivery failure never turns the commit red`);
      const t = /^ {8}timeout-minutes:\s*(\d+)\s*$/m.exec(step);
      assert.ok(t, `step "${name}" needs its own timeout-minutes: a step timeout is absorbed, a job timeout concludes cancelled`);
      budget += Number(t![1]);
    }
    assert.ok(jobCeiling > budget, `job \`${id}\`: the ceiling (${jobCeiling}) must sit above the sum of its step budgets (${budget})`);
  }

  // 5 — delivery: the same channel as the drift check, with a fallback so the facts step breaking never silences it.
  assert.match(jobs.send, /secrets\.TELEGRAM_BOT_TOKEN/, "the send job must use the existing TELEGRAM_BOT_TOKEN secret");
  assert.match(jobs.send, /secrets\.TELEGRAM_ALERT_CHAT_ID/, "the send job must use the existing TELEGRAM_ALERT_CHAT_ID secret, never a new recipient");
  assert.match(jobs.alert, /if: \$\{\{ always\(\) && env\.SEND != 'no' \}\}/, "the hand-off must run unless the facts step positively said this is a repeat");
  assert.match(jobs.alert, /if \[ -z "\$\{TEXT:-\}" \]/, "the hand-off must keep a bare fallback text for the case where the facts step broke");
  assert.match(jobs.send, /api\.telegram\.org\/bot\$\{TELEGRAM_BOT_TOKEN\}\/sendMessage/, "the send job must post to the Telegram Bot API");
  assert.doesNotMatch(source, /parse_mode/, "the commit subject is attacker-shaped text; it must go out as plain text, never parsed as HTML or Markdown");

  // 6 — event data reaches the shell through `env:`, never interpolated into the script body.
  // A block ends at the first non-blank line indented less than its own ten spaces (the next step, or the next job).
  const scriptBodies = source.split(/^ {8}run: \|\n/m).slice(1).map((b) => b.split(/^(?! {10}|\s*$)/m)[0]);
  assert.ok(scriptBodies.length === 3, `expected three run blocks (facts, hand-off, send), found ${scriptBodies.length}`);
  for (const body of scriptBodies) {
    assert.doesNotMatch(body, /\$\{\{/, "an expression inside a run block interpolates event data into shell source; pass it through env: instead");
  }

  // 7 — the live revision is read until it settles, and a deploy a later one carried is not an alarm.
  //
  // WHY. Railway posts `failure` for the deployment it is in the middle of replacing, so for the
  // seconds either side of that event /api/healthz still answers with the OLD revision. Measured
  // 2026-10-24 on #6432: the status arrived 17:49:33 Cairo, the one reading taken eight seconds later
  // sent "does NOT contain this change. It is not live", and the container answered with the merge's
  // own commit twenty-eight seconds after that. The owner was paged for a change that had shipped.
  const readings = Number(/^\s*READINGS=(\d+)\s*$/m.exec(source)?.[1] ?? "0");
  assert.ok(readings >= 6, `healthz must be read repeatedly — at least six readings; found READINGS=${readings}`);
  assert.match(source, /while \[ "\$i" -le "\$READINGS" \]; do/, "the readings must be a loop over READINGS, not a single curl taken at the moment the container is being replaced");
  assert.match(source, /^\s*sleep 20\s*$/m, "the readings must be spaced, or all of them land inside the same second and prove nothing");
  assert.match(source, /\[ "\$CARRIED" = "yes" \] && break/, "the loop must stop the moment production carries the commit, so a real failure is not delayed by four minutes of waiting");
  assert.match(
    source,
    /if \[ "\$CARRIED" = "yes" \] && \[ "\$\{WENT_LIVE:-0\}" = "0" \]; then/,
    "a deployment that never went live whose commit production is now serving was CARRIED by a later deploy — benign (AGENTS.md §2.3), and it must not reach the owner; the WENT_LIVE half is what keeps a crash AFTER going live loud",
  );
  const carried = /if \[ "\$CARRIED" = "yes" \] && \[ "\$\{WENT_LIVE:-0\}" = "0" \]; then[\s\S]*?\n {10}fi\n/.exec(source)?.[0] ?? "";
  assert.match(carried, /emit SEND "no"/, "the carried case must silence the alert, not merely reword it");
  assert.match(carried, /exit 0/, "the carried case must stop there rather than fall through and build a message it has already explained");

  // 8 — the message is handed to a run on main, because only main may read the Telegram pair.
  //
  // WHY. Since 19 Nov 2026 the Telegram pair lives only in `main-secrets`, which only `main` may use (credentials audit,
  // the owner's "fix those"). Railway creates its deployments with a bare commit sha as the ref, so a
  // `deployment_status` run has no branch for that rule to match and cannot stand in the environment. The `alert` job
  // therefore reads no secret and dispatches this workflow on main with `relay_text`; `send` posts it from there.
  assert.doesNotMatch(jobs.alert, /secrets\./, "the alert job runs on Railway's event, which no environment rule can admit, so it must read no secret");
  assert.doesNotMatch(jobs.alert, /^ {4}environment:/m, "the alert job must not stand in an environment: a deployment_status run has no branch, so main-secrets would refuse it and the alarm would die");
  assert.match(jobs.send, /^ {4}environment: main-secrets\b/m, "the send job must stand in main-secrets, the only place the Telegram pair lives");
  assert.match(jobs.alert, /^ {6}actions: write\b/m, "the alert job needs `actions: write` to dispatch the send run");
  assert.match(jobs.alert, /actions\/workflows\/deploy-failure-alert\.yml\/dispatches/, "the hand-off must dispatch this same workflow");
  assert.match(jobs.alert, /\{ref: "main", inputs: \{relay_text: \$t\}\}/, "the hand-off must dispatch on main (the only ref main-secrets admits), with the message as relay_text built by jq");
  const alertIf = /^ {4}if:\s*(.+)$/m.exec(jobs.alert)?.[1] ?? "";
  assert.match(alertIf, /github\.event_name == 'workflow_dispatch' && inputs\.relay_text == ''/, "a dispatch carrying relay_text must never re-enter the alert job, or the hand-off would loop for ever");
  const sendIf = /^ {4}if:\s*(.+)$/m.exec(jobs.send)?.[1] ?? "";
  assert.match(sendIf, /github\.event_name == 'workflow_dispatch' && inputs\.relay_text != ''/, "the send job must run only for a hand-off");
  assert.match(jobs.send, /^ {10}TEXT: \$\{\{ inputs\.relay_text \}\}$/m, "the send job must take the message from relay_text through env:, never into the script body");
  assert.match(source, /^ {6}relay_text:\s*$/m, "workflow_dispatch must declare the relay_text input");
}

/** Each top-level job's body, keyed by its id, in file order. */
function jobBlocks(source: string): Record<string, string> {
  const at = source.search(/^jobs:\s*$/m);
  assert.ok(at >= 0, "the workflow has no jobs: block");
  const out: Record<string, string> = {};
  let id = "";
  for (const line of source.slice(at).split("\n").slice(1)) {
    const head = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (head) {
      id = head[1];
      out[id] = "";
      continue;
    }
    if (id) out[id] += line + "\n";
  }
  return out;
}
