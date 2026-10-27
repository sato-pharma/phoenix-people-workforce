// The two Railway keys must each reach the Railway CLI under their own name (2026-10-27).
//
// WHY IT NEEDS A TEST. From 21 to 27 Oct the two keys broke each other: every swap fixed one job and
// broke another. The production-secrets check failed "Unauthorized… RAILWAY_TOKEN" on runs 40496318818
// and 40505513309 while a project key sat in RAILWAY_TOKEN, never once tried — because both CLI scripts
// read `RAILWAY_API_TOKEN || RAILWAY_TOKEN` into ONE value, and the workflows fed them the same `||`
// merge. Either half of that merge alone is enough to hide the project key, so both halves are pinned.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  describeAttempt,
  firstErrorLine,
  isAuthRejection,
  railwayCliAttempts,
  railwayCliEnv,
} from "../scripts/lib/railway-cli-credentials.mjs";

const CLI_SCRIPTS = ["scripts/validate-railway-production-secrets.mjs", "scripts/sync-railway-production-secrets.mjs"];

/** Every workflow step whose `run:` calls one of the CLI scripts, as raw step text. */
function cliSteps(file: string): string[] {
  const source = readFileSync(resolve(".github/workflows", file), "utf8");
  return source
    .split(/\n(?=\s*- name: )/)
    .filter((step) => CLI_SCRIPTS.some((script) => step.includes(`node ${script}`)));
}

export function runRailwayCliCredentialsTests() {
  // 1. Both secrets set to different values: the project key first, as a project key; the workspace
  //    key next, as a workspace key; only then each under the other name.
  const both = railwayCliAttempts({ RAILWAY_TOKEN: "project-key", RAILWAY_API_TOKEN: "workspace-key" });
  assert.deepEqual(
    both.map((a) => [a.varName, a.value]),
    [
      ["RAILWAY_TOKEN", "project-key"],
      ["RAILWAY_API_TOKEN", "workspace-key"],
      ["RAILWAY_TOKEN", "workspace-key"],
      ["RAILWAY_API_TOKEN", "project-key"],
    ],
    "🔴 with both secrets set, the project key must be tried as RAILWAY_TOKEN — the merge never tried it at all",
  );
  assert.ok(
    both.some((a) => a.varName === "RAILWAY_TOKEN" && a.value === "project-key"),
    "🔴 the RAILWAY_TOKEN secret's own value is never handed to the CLI under its own name",
  );

  // 2. One secret only: its value under both names, nothing invented.
  assert.deepEqual(
    railwayCliAttempts({ RAILWAY_API_TOKEN: "workspace-key" }).map((a) => a.varName),
    ["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"],
  );
  assert.deepEqual(
    railwayCliAttempts({ RAILWAY_TOKEN: "project-key", RAILWAY_API_TOKEN: "  " }).map((a) => a.varName),
    ["RAILWAY_TOKEN", "RAILWAY_API_TOKEN"],
  );
  assert.equal(railwayCliAttempts({}).length, 0, "no secret means no attempt, so the script says it is missing");

  // 3. The same value in both secrets is tried once per name, not twice.
  assert.equal(railwayCliAttempts({ RAILWAY_TOKEN: "k", RAILWAY_API_TOKEN: "k" }).length, 2);

  // 4. The child environment carries the value under ONE name and blanks the other, so the CLI cannot
  //    pick up an ambient copy and mis-classify it.
  const env = railwayCliEnv(both[0], { RAILWAY_PROJECT_ID: "p" }, { RAILWAY_API_TOKEN: "ambient", PATH: "/bin" });
  assert.equal(env.RAILWAY_TOKEN, "project-key");
  assert.equal(env.RAILWAY_API_TOKEN, "", "the other name must be blanked, not inherited");
  assert.equal(env.RAILWAY_PROJECT_ID, "p");
  assert.equal(env.PATH, "/bin");

  // 5. The log names the secret and the name, never the value.
  for (const attempt of both) {
    assert.doesNotMatch(describeAttempt(attempt), /project-key|workspace-key/, "an attempt's description printed a token");
  }
  assert.equal(describeAttempt(both[2]), "RAILWAY_API_TOKEN's value as RAILWAY_TOKEN");

  // 6. The first error line skips npx's download notice, or every refusal would read "npm warn exec".
  assert.equal(
    firstErrorLine({ stderr: "npm warn exec The following package was not found and will be installed: @railway/cli@5.63.1\nUnauthorized. Please login with `railway login`\n" }),
    "Unauthorized. Please login with `railway login`",
  );
  assert.equal(firstErrorLine({ status: 1, stderr: "", stdout: "" }), "exit 1, no output");
  assert.ok(isAuthRejection({ stderr: "Unauthorized. Please check that your RAILWAY_TOKEN is valid" }));
  assert.ok(!isAuthRejection({ stderr: "Project not found" }), "a bad project id is not retried under another key");

  // 7. Both CLI scripts use the shared attempts and hold no merge of their own.
  for (const script of CLI_SCRIPTS) {
    const source = readFileSync(resolve(script), "utf8");
    assert.match(source, /railwayCliAttempts\(process\.env\)/, `🔴 ${script} no longer builds its attempts from scripts/lib/railway-cli-credentials.mjs`);
    assert.doesNotMatch(
      source,
      /RAILWAY_API_TOKEN\?\.trim\(\)\s*\|\|\s*process\.env\.RAILWAY_TOKEN/,
      `🔴 ${script} merges the two Railway secrets into one value again, so the project key is never tried`,
    );
  }

  // 8. Every workflow step that runs a CLI script passes the two secrets separately.
  const workflows = ["secret-drift-check.yml", "sync-railway-production-secrets.yml"];
  let stepsSeen = 0;
  for (const file of workflows) {
    for (const step of cliSteps(file)) {
      stepsSeen += 1;
      assert.doesNotMatch(
        step,
        /secrets\.RAILWAY_API_TOKEN\s*\|\|\s*secrets\.RAILWAY_TOKEN/,
        `🔴 ${file}: a step that runs the Railway CLI merges RAILWAY_API_TOKEN || RAILWAY_TOKEN, so the CLI ` +
          "is handed the workspace key under both names and never the project key. Pass each secret under its own name.",
      );
      assert.match(step, /RAILWAY_API_TOKEN:\s*\$\{\{\s*secrets\.RAILWAY_API_TOKEN\s*\}\}/, `${file}: a CLI step lost RAILWAY_API_TOKEN`);
      assert.match(step, /RAILWAY_TOKEN:\s*\$\{\{\s*secrets\.RAILWAY_TOKEN\s*\}\}/, `${file}: a CLI step lost RAILWAY_TOKEN`);
    }
  }
  // Three steps today: the drift check's validator, and the sync workflow's sync and validator. A
  // count that drops means the step split above stopped finding them, and the clause went dead.
  assert.ok(stepsSeen >= 3, `expected at least 3 workflow steps that run the Railway CLI scripts, found ${stepsSeen}`);
}
