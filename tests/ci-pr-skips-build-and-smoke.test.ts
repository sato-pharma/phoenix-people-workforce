// The Build and the Playwright login smoke must run on `main`, a dispatch and a schedule — and NOT
// on a pull request.
//
// WHY THIS EXISTS. Measured 2026-09-29 on run 36610968349: `validate` took 295s of which the Build
// alone was 200s (68%), and the Build's only consumer is a 37s login smoke test. GitHub rounds every
// JOB up to a whole minute, so validate billed 5 minutes per run against `checks`'s 6, on 185
// pull_request runs that day. Dropping the build from the PR takes validate to ~90s — about 555
// billable minutes a day, a fifth of the bill — and every PR finishes ~3.5 minutes EARLIER.
//
// The owner asked for cost cuts that do not slow the work down, and chose this one on that basis.
// The alternatives all cost speed: a merge cooldown (built, and he cut it the same evening), or
// folding `validate` into `checks` (they run in parallel, so merging doubles the wait).
//
// 🔴 WHAT A FUTURE READER WILL WANT TO "FIX", AND MUST NOT. Seeing a PR go green without ever
// building looks like a gap, and restoring the build on pull_request closes it — at the cost of the
// whole saving and 3.5 minutes on every PR. PRODUCTION IS NOT THE THING AT RISK: a red `main` fails
// its check suite and Railway's Wait for CI then withholds the deploy, so nothing ships unverified.
// What moved is WHEN a break is discovered, which the owner accepted knowingly. If it ever proves
// too expensive the middle setting is to build only on PRs touching `app/`, `src/` or
// `next.config.ts` — not a return to building on every PR.
//
// And do NOT reach for a `.next` cache instead: tried 2026-08-29, measured from both directions,
// 37KB cache, 148s warm against 143s cold. ci.yml records that evidence at the deleted cache step.
//
// 🔴 2026-11-05 — A PULL REQUEST NEVER BUILDS, WHATEVER IT TOUCHES. That middle setting went live on
// 2026-10-08 as `Build risk` (a PR touching a route or build config built). On 2026-11-05 CI moved onto
// one self-hosted laptop where every job waits for the one before it (the free plan's minutes ran out),
// and the owner chose "Yes, skip the PR build": Railway builds every merge, and a build that fails there
// keeps the old version serving. So on a pull request `validate` is ONE step that says so, and every
// other step in it is gated off — checkout and install included, since nothing after them runs. The job
// itself still runs and concludes `success`: `validate` is a required check name, and a job that is
// skipped whole reports nothing and blocks the PR. `main` and a dispatch still build, unchanged.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const WORKFLOW = ".github/workflows/ci.yml";
const SHIP_SKILL = ".claude/skills/ship/SKILL.md";
const TRAPS_CLUSTERS = "docs/agents-session-traps-clusters.md";
const TRAPS_ACCOUNT = "docs/agents-session-traps.md";
const ENGINEERING_RULES = ".claude/rules/engineering.md";
const ALERTS_DOC = "docs/security/open-dependency-alerts.md";

/** The steps whose cost this change removes from a pull request. */
const HEAVY_STEPS = [
  "Build",
  "Verify @napi-rs/canvas is reachable inside .next/standalone",
  "Assemble the standalone runtime (mirrors the Dockerfile)",
  "Cache Playwright browsers",
  "Install Playwright browsers",
  "Install Playwright system dependencies",
  "Run Playwright login smoke test",
  "Ingest synthetic-journey report (best-effort, never fails CI)",
  "Upload Playwright report on failure",
];

/** The validate job's steps: each one's name and its `if:` (null when it has none). */
function validateSteps(yml: string): { name: string; cond: string | null; body: string }[] {
  const start = yml.indexOf("\n  validate:\n");
  assert.ok(start >= 0, `${WORKFLOW} has no \`validate\` job`);
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  const job = next < 0 ? rest : rest.slice(0, next + 1);
  const out: { name: string; cond: string | null; body: string }[] = [];
  for (const chunk of job.split(/\n(?= {6}- name: )/).slice(1)) {
    const name: string = /^ {6}- name: (.*)$/m.exec(chunk)?.[1]?.trim() ?? "";
    const cond: string | null = /^ {8}if: (.*)$/m.exec(chunk)?.[1]?.trim() ?? null;
    out.push({ name, cond, body: chunk });
  }
  return out;
}

const PR_ANNOUNCEMENT = "Pull requests do not build";
const OWNER_SENTENCE =
  "Pull requests do not build: Railway builds every merge, and a build that fails there keeps the old version serving (owner, 2026-11-05)";

export function runCiPrSkipsBuildAndSmokeTests(): void {
  const yml = readFileSync(WORKFLOW, "utf8");

  // 0. On a pull request `validate` is one step, which says why, and nothing else runs (2026-11-05).
  const steps = validateSteps(yml);
  assert.ok(steps.length >= HEAVY_STEPS.length, `${WORKFLOW}: read only ${steps.length} steps in \`validate\``);
  const announce = steps[0];
  assert.equal(announce.name, PR_ANNOUNCEMENT,
    `\`validate\`'s first step must be "${PR_ANNOUNCEMENT}", so a pull request's log says why it did not build.`);
  assert.equal(announce.cond, "github.event_name == 'pull_request'",
    `"${PR_ANNOUNCEMENT}" must run on a pull request and nowhere else.`);
  assert.ok(announce.body.includes(OWNER_SENTENCE),
    `"${PR_ANNOUNCEMENT}" must print the owner's reason word for word: ${OWNER_SENTENCE}`);
  for (const step of steps.slice(1)) {
    assert.ok(
      step.cond !== null && /github\.event_name (!= 'pull_request'|== 'push')/.test(step.cond),
      `\`validate\` / "${step.name}" runs on a PULL REQUEST (if: ${step.cond ?? "none"}). Since 2026-11-05 a pull ` +
        `request never builds (owner: "Yes, skip the PR build") — CI is one self-hosted machine where every job ` +
        `waits for the one before it, and Railway builds every merge, keeping the old version serving if that ` +
        `build fails. Gate the step with \`github.event_name != 'pull_request'\`.`,
    );
  }
  const build = steps.find((st) => st.name === "Build");
  assert.equal(build?.cond, "github.event_name != 'pull_request'",
    "the Build's condition must be the event alone: no step output may add it back to a pull request.");
  assert.doesNotMatch(yml, /steps\.buildrisk\.|id: buildrisk|ci-build-risk\.mjs/,
    `${WORKFLOW} reads the PR's diff to decide whether to build again. Retired 2026-11-05: a PR never builds.`);

  // 1. Every heavy step is gated on `heavy`, and none of them is still on `docs_only` alone.
  for (const name of HEAVY_STEPS) {
    const at = yml.indexOf(`      - name: ${name}\n`);
    assert.ok(at >= 0, `${WORKFLOW} no longer has a step named "${name}" — if it was renamed, this ` +
      `test must be updated with it, because an unlisted step is one nobody is checking the gate on`);
    const condition = yml.slice(at, yml.indexOf("\n", yml.indexOf("if:", at)));
    assert.match(
      condition,
      /github\.event_name != 'pull_request'/,
      `"${name}" is no longer gated on the EVENT, so it runs on PULL REQUESTS again. That restores ` +
        `~3 billable minutes to each of ~185 PR runs a day (~555 minutes, about a fifth of the ` +
        `Actions bill) and adds ~3.5 minutes to every PR. The owner chose this on 2026-09-29 ` +
        `precisely because it cuts cost WITHOUT slowing the work. Production is not at risk either ` +
        `way: a red main withholds the deploy.`,
    );
  }

  // 2. The condition is the EVENT ITSELF, not a step output computed in shell.
  //
  // It used to be `steps.detect.outputs.heavy == 'true'`, emitted by the per-job docs-only
  // classifier. That classifier was removed on 2026-10-06 (see ci.yml's header: it skipped the
  // tests policing `.claude/**` and `docs/**` and cost three production deploys), and with it went
  // `heavy`. The condition it computed was only ever "this is not a pull request", so the steps now
  // say that directly — which also closes the failure mode this assertion was written for: a
  // mis-emitted step output evaluates to the empty string and silently gates the build OFF
  // EVERYWHERE, including on main where it is the only thing between a broken login and a deploy.
  // `github.event_name` cannot be empty.
  assert.doesNotMatch(
    yml,
    /steps\.detect\.outputs\.heavy/,
    "a step is gated on `steps.detect.outputs.heavy` again, but nothing emits that output any more — " +
      "the expression evaluates to the empty string, the condition is never true, and the build and " +
      "the login smoke stop running ANYWHERE, main included, with every job still green.",
  );

  // 3. The main path is untouched: push to main must still trigger the workflow at all.
  const onBlock = yml.slice(yml.indexOf("\non:"), yml.indexOf("\njobs:"));
  assert.match(
    onBlock,
    /push:\s*\n\s*branches:\s*\n\s*- main/,
    "`push: main` is gone. That is the production deploy gate: Railway's Wait for CI waits on the " +
      "check suites attached to the pushed commit, so removing it ships every merge unverified, " +
      "silently. It is also now the ONLY place the build runs at all.",
  );

  // 4. The ship skill describes THIS gate, not the docs-only fast path removed on 2026-10-06. It kept
  // telling sessions a docs-only PR ran no tests for four weeks after that, so a session could report
  // a real red as impossible, or a real green as proving nothing.
  const ship = readFileSync(SHIP_SKILL, "utf8");
  assert.doesNotMatch(
    ship,
    /docs_only|ran no tests|skips node setup|tests first run after the merge|first time the tests ran/,
    `${SHIP_SKILL} describes the docs-only fast path again, but ci.yml runs the whole suite on every ` +
      "pull request. What a PR does skip is the build and the login smoke test.",
  );
  assert.match(
    ship,
    /a pull request never builds/i,
    `${SHIP_SKILL} no longer says a pull request never builds (owner, 2026-11-05), so a session reads a ` +
      "PR's green as proof the app builds — only main's own run proves that.",
  );
  assert.doesNotMatch(
    ship,
    /ci-build-risk/,
    `${SHIP_SKILL} sends sessions to scripts/ci-build-risk.mjs again, but nothing reads it: since ` +
      "2026-11-05 a pull request never builds, whatever it touches.",
  );
  assert.doesNotMatch(
    ship,
    new RegExp("unit suite runs in `validate`|`validate` includes `pnpm audit`|turn `validate` red|`validate`'s audit"),
    `${SHIP_SKILL} places the suite or the audit in \`validate\` again. Both have been behind \`checks\`, ` +
      "in `unit` and `static`, since 2026-10-19; on a PR `validate` holds no tests at all.",
  );
  assert.doesNotMatch(
    readFileSync(ALERTS_DOC, "utf8"),
    new RegExp("`validate`"),
    `${ALERTS_DOC} names \`validate\` again. The audit it is about has been in \`static\`, behind ` +
      "`checks`, since 2026-10-19.",
  );

  // 5. So do the traps. The clusters file is what trap-injector.mjs hands every session, and the
  // account is where it sends them to read more. The account's dated snapshot of the old AGENTS.md
  // §2.1 keeps the old line on purpose, so this asks for the present-tense claims only.
  const clusters = readFileSync(TRAPS_CLUSTERS, "utf8");
  assert.doesNotMatch(
    clusters,
    /runs NO tests/,
    `${TRAPS_CLUSTERS} says a docs-only PR runs no tests again, and sessions are shown that line as the ` +
      "rule. ci.yml has run the whole suite on every pull request since 2026-10-06.",
  );
  const traps = readFileSync(TRAPS_ACCOUNT, "utf8");
  assert.doesNotMatch(
    traps,
    /`validate` never runs the tests|fast-paths and runs no tests/,
    `${TRAPS_ACCOUNT} describes the docs-only fast path as live again. It was removed on 2026-10-06; ` +
      "its account stays, in the past tense.",
  );

  // 6. And the memory note a session working in CI is handed through its module's rules file.
  assert.doesNotMatch(
    readFileSync(ENGINEERING_RULES, "utf8"),
    /going green in FOUR SECONDS is CORRECT/,
    `${ENGINEERING_RULES} says a docs-only PR going green in seconds is correct again. That was true ` +
      "only while the fast path existed, and today a green that quick would be a real fault.",
  );
}
