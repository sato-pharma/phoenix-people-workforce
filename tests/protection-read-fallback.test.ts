// The daily required-check alarm must READ the gate, and a run that cannot must reach a human
// (owner, 2026-11-19: "fix the protection drift check that stays green on 403").
//
// WHY THIS EXISTS, MEASURED. secret-drift-check.yml compares AGENTS.md §2's required checks with branch
// protection once a day. The protection endpoint needs repository-administration rights, which no
// workflow token can be granted, so every run read `[required-checks] SKIPPED — protection returned
// 403`, printed a ::warning:: and concluded green with nothing sent (run 44341684217, 18 Nov 2026, and
// every run before it). An alarm that never once read what it guards, looking like a pass.
//
// Two changes, both held here:
//   1. scripts/required-check-names.mjs answers a 403 from `branches/main`, which states the same list
//      (`protection.required_status_checks.contexts`) to anyone who can read the repository. Measured
//      2026-11-19: it answered `validate`, `checks` with no token at all. `protected: false` there is
//      `main` unprotected and comes back as the alarm; a branch with no list on it is a skip, never an
//      invented empty list (an empty list is the reading that makes every open PR look green).
//   2. The workflow's skip branch is a finding — `gate_unread`, an ::error::, exit 1 — so the report
//      step and Telegram carry it. The job itself still concludes success (continue-on-error), as
//      tests/scheduled-alarms-never-withhold.test.ts requires.
//
// The printed lines this test feeds the workflow's matchers are COMPOSED from the scripts' own output
// (the real function's reasons and the CLI's `SKIPPED — <why>.` template), the same way
// tests/secret-drift-404-matcher.test.ts does it, so a reworded reason that slips past a matcher fails.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { readProtectionContexts } from "../scripts/required-check-names.mjs";

const WORKFLOW = ".github/workflows/secret-drift-check.yml";
const CHECK_SCRIPT = "scripts/check-required-checks.mjs";
const STEP = "Check the required-check declaration against the live gate";

type Gh = (args: string[]) => string;

/** A stand-in for `gh`: the protection endpoint answers `protection`, `branches/main` answers `branch`. */
function fakeGh(protection: string | Error, branch?: string | Error): { gh: Gh; calls: string[] } {
  const calls: string[] = [];
  const gh: Gh = (args) => {
    const path = args[1];
    calls.push(path);
    const answer = path.endsWith("/protection/required_status_checks") ? protection : branch;
    if (answer === undefined) throw new Error(`unexpected gh call: ${args.join(" ")}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { gh, calls };
}

/** An error shaped like execFileSync's when `gh api` answers an HTTP error. */
function httpError(status: number, text: string): Error {
  return Object.assign(new Error(`Command failed: gh api`), { stderr: `gh: ${text} (HTTP ${status})\n` });
}

const branchJson = (body: object) => JSON.stringify({ name: "main", commit: { sha: "abc" }, ...body });

/** The line check-required-checks.mjs prints for a skip, from its own template. */
function printedSkip(reason: string): string {
  const prefix = "[required-checks] SKIPPED — ";
  assert.ok(
    readFileSync(resolve(CHECK_SCRIPT), "utf8").includes(`${prefix}\${live.skipped}.`),
    `${CHECK_SCRIPT} no longer prints a skip as \`${prefix}<why>.\`; the workflow's matchers anchor to it.`,
  );
  return `${prefix}${reason}.`;
}

/** The required-check step's block, up to the next step. */
function stepBlock(workflow: string): string {
  const start = workflow.indexOf(`      - name: ${STEP}`);
  assert.notEqual(start, -1, `${WORKFLOW} no longer has the step "${STEP}".`);
  const rest = workflow.slice(start + 1);
  const next = rest.indexOf("\n      - name: ");
  return next === -1 ? rest : rest.slice(0, next);
}

/** The grep pattern nearest above the line that writes `flag`, and the shell from it to the `fi`. */
function branchFor(block: string, flag: string): { pattern: RegExp; body: string } {
  const lines = block.split("\n");
  const at = lines.findIndex((line) => line.includes(`${flag}=true`));
  assert.notEqual(at, -1, `🔴 ${WORKFLOW}'s "${STEP}" no longer writes \`${flag}=true\`.`);
  for (let i = at; i >= 0; i -= 1) {
    const found = /grep\s+-([A-Za-z]*)\s+'([^']+)'/.exec(lines[i]);
    if (!found) continue;
    const end = lines.findIndex((line, j) => j > at && /^\s*fi\s*$/.test(line));
    return {
      pattern: new RegExp(found[2], `m${found[1].includes("i") ? "i" : ""}`),
      body: lines.slice(i, end === -1 ? at + 3 : end + 1).join("\n"),
    };
  }
  return assert.fail(`🔴 ${WORKFLOW}: no \`grep … '<pattern>'\` above \`${flag}=true\`.`);
}

export function runProtectionReadFallbackTests(): void {
  // 1. A readable protection endpoint is used as before, and `branches/main` is never asked.
  {
    const { gh, calls } = fakeGh('["validate","checks"]');
    const live = readProtectionContexts({ gh });
    assert.deepEqual(live, { contexts: ["validate", "checks"] });
    assert.equal(calls.length, 1, "a readable protection endpoint must not trigger the branch read");
  }

  // 2. THE FIX. A 403 is answered from `branches/main`, and says where it read the list.
  {
    const { gh, calls } = fakeGh(
      httpError(403, "Resource not accessible by integration"),
      branchJson({
        protected: true,
        protection: { enabled: true, required_status_checks: { enforcement_level: "everyone", contexts: ["validate", "checks"] } },
      }),
    );
    const live = readProtectionContexts({ gh }) as { contexts?: string[]; via?: string; skipped?: string };
    assert.deepEqual(
      live.contexts,
      ["validate", "checks"],
      `🔴 a 403 from the protection endpoint no longer reads the list from branches/main (got ${JSON.stringify(live)}). ` +
        "That is the daily drift check skipping green again, on every run, proving nothing.",
    );
    assert.equal(live.via, "branches/main", "a list read from branches/main must say so, so the CLI can print where it came from");
    assert.equal(calls[1], "repos/sato-pharma/phoenix-people-workforce/branches/main");
  }

  const workflow = readFileSync(resolve(WORKFLOW), "utf8").replace(/\r\n/g, "\n");
  const block = stepBlock(workflow);
  const missing = branchFor(block, "gate_missing");
  const unread = branchFor(block, "gate_unread");

  // 3. `protected: false` behind a 403 is `main` unprotected: the ALARM, never a list, and the
  //    workflow escalates it as `gate_missing`, not as a routine unread.
  {
    const { gh } = fakeGh(httpError(403, "Upgrade to GitHub Pro"), branchJson({ protected: false }));
    const live = readProtectionContexts({ gh }) as { contexts?: string[]; skipped?: string };
    assert.equal(live.contexts, undefined, "an unprotected main must never be returned as a list of required checks");
    assert.ok(live.skipped, "an unprotected main must come back as a skip the workflow escalates");
    assert.match(
      printedSkip(live.skipped!),
      missing.pattern,
      `🔴 ${WORKFLOW}'s gate_missing matcher does not catch "${live.skipped}". main could be unprotected ` +
        "and the alarm would file it as a routine could-not-read instead of MERGE NOTHING.",
    );
  }

  // 4. A 403 the branch read cannot answer either, or a branch with no list, is a skip — and never an
  //    invented empty list, which downstream makes every open PR read green.
  const unreadable: { what: string; branch: string | Error }[] = [
    { what: "branch read fails", branch: httpError(500, "Server Error") },
    { what: "branch carries no list", branch: branchJson({ protected: true, protection: { enabled: true } }) },
  ];
  for (const { what, branch } of unreadable) {
    const { gh } = fakeGh(httpError(403, "Resource not accessible by integration"), branch);
    const live = readProtectionContexts({ gh }) as { contexts?: string[]; skipped?: string };
    assert.equal(live.contexts, undefined, `${what}: a list was returned (${JSON.stringify(live.contexts)}) — never invent one`);
    assert.match(live.skipped ?? "", /^protection returned 403/, `${what}: the skip must still name the 403`);
    const line = printedSkip(live.skipped!);
    assert.doesNotMatch(line, missing.pattern, `${what}: an unreadable gate is not a missing gate — the alarm would say MERGE NOTHING wrongly`);
    assert.match(
      line,
      unread.pattern,
      `🔴 ${what}: ${WORKFLOW}'s gate_unread matcher does not catch "${line}", so a blind alarm would ` +
        "conclude quietly again.",
    );
  }

  // 5. A 404 keeps its own meaning and its own escalation; it is not re-read from the branch.
  {
    const { gh, calls } = fakeGh(httpError(404, "Branch not protected"));
    const live = readProtectionContexts({ gh }) as { skipped?: string };
    assert.equal(calls.length, 1, "a 404 must not fall through to the branch read");
    assert.match(printedSkip(live.skipped ?? ""), missing.pattern, "a 404 must still escalate as gate_missing");
  }

  // 6. THE OTHER HALF OF THE DEFECT: a run that could not read the gate is a FINDING. It was
  //    `::warning::` and `exit 0`, which is why every 403 run was green with nothing sent.
  assert.match(unread.body, /::error::/, `🔴 ${WORKFLOW}'s could-not-read branch no longer raises an ::error::.`);
  assert.match(
    unread.body,
    /^\s*exit 1\s*$/m,
    `🔴 ${WORKFLOW}'s could-not-read branch no longer exits 1. The step is continue-on-error, so exit 1 is ` +
      "what makes steps.required_checks.outcome read failure — the only thing that reaches the report and Telegram.",
  );
  assert.doesNotMatch(
    unread.body,
    /^\s*exit 0\s*$/m,
    `🔴 ${WORKFLOW}'s could-not-read branch exits 0 again: a blind alarm concluding green, the defect fixed on 2026-11-19.`,
  );
  assert.doesNotMatch(unread.body, /::warning::/, "a run that could not read the gate is a finding, not a warning");

  // 7. The token the step reads with can read branches/main whether the repository is public or
  //    private: the workflow's own, with `contents: read`. The dispatch PAT answered 403 and expires.
  const token = /^\s*GH_TOKEN:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
  assert.equal(
    token,
    "${{ secrets.GITHUB_TOKEN }}",
    `${WORKFLOW}'s "${STEP}" must read with secrets.GITHUB_TOKEN (found: ${token || "no GH_TOKEN"}), which ` +
      "always has the contents: read this workflow grants; the dispatch PAT answered 403 on every run.",
  );
  assert.match(workflow, /^permissions:\n(?:\s+#.*\n|\s+[a-z-]+:\s*\w+.*\n)*?\s+contents:\s*read/m, "the workflow must grant contents: read");

  // 8. The finding is carried by name all the way to the message, so it never reads as a rotation.
  const report = workflow.slice(workflow.indexOf("- name: Report a required-check rotation"));
  assert.match(report.slice(0, 4000), /steps\.required_checks\.outputs\.gate_unread/, "the report step must say when the gate could not be read");
  const notify = workflow.slice(workflow.indexOf("- name: Notify Telegram on failure"));
  assert.match(notify, /GATE_UNREAD:\s*\$\{\{\s*steps\.required_checks\.outputs\.gate_unread\s*\}\}/, "Telegram must be told the gate could not be read");
  assert.match(notify, /\[ "\$GATE_UNREAD" = "true" \]/, "Telegram must word an unread gate apart from a rotation");
}
