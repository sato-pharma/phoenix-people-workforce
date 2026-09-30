import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The SHARED stripper, not a line filter: `tests/comment-strip-ratchet.test.ts` refuses a hand-rolled
// one by name, because a line judged by how it starts cannot know a block comment is already open.
import { stripComments } from "./support/comment-strip.ts";

// The REAL module, not a copy of its rules. The whole point of `judgeAlerts` living in
// `scripts/dependabot-alerts.mjs` is that the exit decision the CLI takes is the one this test drives.
import {
  AUDIT_FAILING_SEVERITIES,
  KNOWN_SEVERITIES,
  classifyAlerts,
  describeAlert,
  judgeAlerts,
} from "../scripts/dependabot-alerts.mjs";

/**
 * The Dependabot early-warning check must be honest in both directions: it must not call a reading it
 * never obtained a pass, and it must not call a zero it could not have seen clean.
 *
 * WHY IT EXISTS. On 2026-09-30 a HIGH advisory against `@grpc/grpc-js` — reachable in the PRODUCTION
 * tree through `@google-cloud/logging` — landed in the audit feed mid-afternoon. `validate`'s
 * `pnpm audit --audit-level=high --prod` step passed at 16:11 and failed at 16:29 with nothing in the
 * repository having changed, so every open PR went red at once, and by AGENTS.md §2.3 a red check suite
 * on a `main` commit makes Railway mark that production deploy SKIPPED for good. Three consecutive
 * deploys were withheld that evening. The alert had been readable in the API for hours before the audit
 * feed learned it; nobody was reading it.
 *
 * The owner was offered Dependabot auto-merge for patch security updates and chose early warning
 * instead, so this tool warns and never merges — AGENTS.md §2 bans `gh pr merge --auto` outright, and
 * every merge stays his word.
 *
 * WHAT THIS PINS, and clause 0 is the load-bearing one:
 *   0. Every verdict lives in `judgeAlerts`, which is pure — so the CLI has no branch a test cannot
 *      reach. The live API answers whatever is true today (zero open alerts, when this was written),
 *      so a CLI that owned its own exits would have its failing paths verified by nobody, ever.
 *   1. A skip exits 0 AND says it is not a pass.
 *   2. Zero alerts with alerts SWITCHED OFF exits 1 — a zero nobody looked for is not evidence.
 *   3. An unreadable severity is graded urgent, not quiet.
 *   4. HIGH+ exits 1 and names the bump; moderate/low alone exits 0 and says nothing is urgent.
 *   5. The tool is read-only and merges nothing.
 */
export function runDependabotAlertsTests() {
  // Typed rather than `Record<string, any>`: the repo's lint bans `any` outright, and a typed override
  // also means a fixture that misspells a field stops compiling instead of silently testing the default.
  type AlertOverride = {
    severity?: string;
    ghsa?: string;
    pkg?: string;
    manifest?: string;
    range?: string;
    patched?: string | null;
  };
  const alert = (over: AlertOverride = {}) => ({
    security_advisory: {
      severity: over.severity ?? "high",
      ghsa_id: over.ghsa ?? "GHSA-test-0001",
    },
    dependency: {
      package: { name: over.pkg ?? "left-pad" },
      manifest_path: over.manifest ?? "package.json",
    },
    security_vulnerability: {
      vulnerable_version_range: over.range ?? ">= 1.0.0 < 1.0.5",
      first_patched_version: over.patched === null ? null : { identifier: over.patched ?? "1.0.5" },
    },
  });

  // 0. THE CLI MUST OWN NO VERDICT OF ITS OWN
  // If a branch ever regrows inside the CLI, it is a branch the live API will never exercise: on the
  // day this was written the repo had zero open alerts, so every failing path would be unreached and
  // unverified. The exit code must be the one `judgeAlerts` returned, spelled exactly once.
  const cli = readFileSync("scripts/check-dependabot-alerts.mjs", "utf8");
  assert.match(cli, /judgeAlerts/, "the CLI must take its verdict from judgeAlerts");
  const literalExits = cli.match(/process\.exit\(\s*[01]\s*\)/g) ?? [];
  assert.deepEqual(
    literalExits,
    [],
    "the CLI must not exit on a literal 0 or 1 - every verdict belongs to judgeAlerts, which is pinned "
      + "below. A literal exit is a branch no test can reach and the live API will never produce.",
  );
  assert.match(
    cli,
    /process\.exit\(verdict\.exitCode\)/,
    "the CLI must exit with judgeAlerts' own exit code",
  );

  // 1. A SKIP IS EXIT 0, AND SAYS IT IS NOT A PASS
  // Runnable-anywhere is the whole reason this is a script and not a required check (CI has no `gh`
  // auth for `dependabot/alerts`, and a required check that needs auth has to fail open). But a bare
  // "skipped" reads like a pass at 4am, so the second sentence is part of the contract.
  const skipped = judgeAlerts({ skipped: "`gh` is not authenticated here" }, { unknown: "not read" });
  assert.equal(skipped.exitCode, 0, "a skip must exit 0 or the tool becomes unrunnable offline");
  assert.match(skipped.notes.join("\n"), /skipped — `gh` is not authenticated here/);
  assert.match(
    skipped.notes.join("\n"),
    /not a pass/i,
    "a skip must say in words that nothing was judged - otherwise it reads as a clean bill",
  );
  assert.deepEqual(skipped.errors, [], "a skip is a reason, never an error");

  // 2. A ZERO NOBODY LOOKED FOR IS NOT A CLEAN BILL
  // An empty list is byte-identical whether nothing is vulnerable or the feature is switched off. This
  // is the same absent-answer-in-the-shape-of-a-negative-one that cost four separate defects in
  // `rollup-prs.mjs` on the same day, so it is refused here by construction.
  const blind = judgeAlerts({ alerts: [] }, { enabled: false });
  assert.equal(blind.exitCode, 1, "zero alerts with alerts DISABLED must fail, not pass");
  assert.match(blind.errors.join("\n"), /SWITCHED OFF/);
  assert.match(blind.errors.join("\n"), /nobody is looking/);

  const honestZero = judgeAlerts({ alerts: [] }, { enabled: true });
  assert.equal(honestZero.exitCode, 0);
  assert.match(
    honestZero.notes.join("\n"),
    /switched ON, so the zero was looked for/,
    "an honest zero must say WHY it counts as evidence, not merely that it is zero",
  );

  const unknownZero = judgeAlerts({ alerts: [] }, { unknown: "could not tell (403)" });
  assert.equal(unknownZero.exitCode, 0, "an unreadable ON/OFF must not manufacture a failure either");
  assert.match(unknownZero.notes.join("\n"), /though could not tell \(403\)/);

  // 3. AN UNREADABLE SEVERITY IS URGENT, NOT QUIET
  // Routing an ungradeable alert to "below the audit level" would file it as harmless on no evidence.
  assert.ok(AUDIT_FAILING_SEVERITIES.has("high") && AUDIT_FAILING_SEVERITIES.has("critical"));
  assert.ok(!AUDIT_FAILING_SEVERITIES.has("moderate"), "moderate does not fail --audit-level=high");
  for (const severity of ["", "unknown", "severe", "HIGHISH"]) {
    const { failing, other } = classifyAlerts([alert({ severity, pkg: "mystery" })]);
    assert.equal(failing.length, 1, `severity ${JSON.stringify(severity)} must be graded urgent`);
    assert.equal(other.length, 0);
    assert.match(
      describeAlert(failing[0]),
      /UNREADABLE-SEVERITY/,
      "the line must say the severity could not be read, not imply a HIGH the payload never stated",
    );
  }
  assert.deepEqual([...KNOWN_SEVERITIES].sort(), ["critical", "high", "low", "moderate"]);

  // 4. THE TWO REAL OUTCOMES
  const high = judgeAlerts(
    {
      alerts: [
        alert({
          severity: "high",
          pkg: "@grpc/grpc-js",
          range: ">= 1.14.0 < 1.14.5",
          patched: "1.14.5",
          ghsa: "GHSA-m9gg-hp2v-232j",
        }),
        alert({ severity: "low", pkg: "sleepy", patched: "2.0.1" }),
      ],
    },
    { enabled: true },
  );
  assert.equal(high.exitCode, 1, "an open HIGH alert must fail - it will fail CI shortly anyway");
  const highText = high.errors.join("\n");
  assert.match(highText, /@grpc\/grpc-js/);
  assert.match(highText, /bump to 1\.14\.5/, "the line must name the version to bump to");
  assert.match(highText, /GHSA-m9gg-hp2v-232j/);
  assert.match(
    highText,
    /pnpm update --depth Infinity/,
    "a transitive bump needs --depth Infinity: `pnpm up` touches only direct deps and reports "
      + "'Already up to date' for the rest, which is how a no-op bump got mistaken for a real one",
  );
  assert.match(
    high.notes.join("\n"),
    /below the audit level: LOW sleepy/,
    "the quiet ones are still reported",
  );

  const quietOnly = judgeAlerts(
    { alerts: [alert({ severity: "moderate", pkg: "meh" }), alert({ severity: "low", pkg: "shrug" })] },
    { enabled: true },
  );
  assert.equal(
    quietOnly.exitCode,
    0,
    "moderate and low alone must NOT fail - the audit does not fail on them",
  );
  assert.match(quietOnly.notes.join("\n"), /none of them HIGH or CRITICAL/);
  assert.deepEqual(
    quietOnly.errors,
    [],
    "calling a moderate urgent trains a reader to ignore the report",
  );

  // An alert with nothing to bump to must not read as actionable.
  const unpatched = classifyAlerts([alert({ severity: "critical", patched: null, pkg: "orphan" })]);
  assert.match(describeAlert(unpatched.failing[0]), /NO patched version exists yet/);
  assert.doesNotMatch(describeAlert(unpatched.failing[0]), /bump to (null|undefined)/);

  // Deterministic order, so two runs of the same set can be diffed by a human.
  const ordered = classifyAlerts([
    alert({ severity: "high", pkg: "zebra" }),
    alert({ severity: "critical", pkg: "yak" }),
    alert({ severity: "high", pkg: "aardvark" }),
  ]);
  assert.deepEqual(
    ordered.failing.map((row) => row.package),
    ["yak", "aardvark", "zebra"],
    "critical first, then high, then alphabetical",
  );

  // 5. READ-ONLY, AND IT MERGES NOTHING
  // The owner was offered auto-merge and chose warning instead. AGENTS.md §2 bans `gh pr merge --auto`
  // outright, and a tool that reads security alerts must never acquire a write verb by accident.
  const lib = readFileSync("scripts/dependabot-alerts.mjs", "utf8");
  // Judge the CODE, not the prose. Both files EXPLAIN in comments why auto-merge was declined on
  // 2026-09-30 and quote the banned command to do it — an assertion over the raw text fires on that
  // explanation, which would push the next reader to delete the reasoning in order to go green.
  //
  // 🔴 AND THE STRIP IS `stripComments`, NOT A LINE FILTER. The first version of this dropped lines
  // whose trimmed start was `//`, which `tests/comment-strip-ratchet.test.ts` refuses by name and
  // caught here: a line is judged by how it STARTS, so nothing tracks whether a block comment is
  // already open, and a `/* … */` interior is scanned as code while code sharing the opening line is
  // never scanned at all. The shared stripper tracks string and template state instead.
  for (const [name, source] of [["the CLI", stripComments(cli)], ["the module", stripComments(lib)]] as const) {
    assert.doesNotMatch(source, /--auto\b/, `${name} must never enable auto-merge (AGENTS.md 2)`);
    assert.doesNotMatch(
      source,
      /'pr',\s*'merge'|\bpr\s+merge\b/,
      `${name} must not merge anything`,
    );
    assert.doesNotMatch(
      source,
      /'-X'|"-X"|--method\s+(POST|PATCH|PUT|DELETE)/,
      `${name} must stay a read: no write verb against the API`,
    );
  }

  // Discoverability: a tool nobody runs is a tool that does not exist, so repo-doctor reports it.
  const doctor = readFileSync("scripts/repo-doctor.mjs", "utf8");
  // 🔴 THE IMPORT IS NOT THE SECTION. Matching `dependabot-alerts.mjs` anywhere in the file passed
  // while the printed section had been gutted — the import line alone satisfied it, so the assertion
  // certified a report that no longer reported anything. Caught by breaking it. It now requires the
  // heading a reader actually sees, the judgement being called, and `--no-auth` being honoured.
  assert.match(
    doctor,
    /^\s*console\.log\("DEPENDABOT ALERTS \(/m,
    "repo-doctor must PRINT a Dependabot section - it already pages a live API, and an early warning "
      + "nobody runs warns nobody",
  );
  assert.match(doctor, /judgeAlerts\(read, alertsEnabled\(\)\)/, "the section must use the shared judgement");
  assert.match(
    doctor,
    /skipped \(--no-auth\)\. This check reads the live alerts API\./,
    "the section must honour --no-auth like every other live-reading section there",
  );
}
