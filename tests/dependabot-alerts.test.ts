import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// The SHARED stripper, not a line filter: `tests/comment-strip-ratchet.test.ts` refuses a hand-rolled
// one by name, because a line judged by how it starts cannot know a block comment is already open.
import { stripComments } from "./support/comment-strip.ts";

// The REAL module, not a copy of its rules. The whole point of `judgeAlerts` living in
// `scripts/dependabot-alerts.mjs` is that the exit decision the CLI takes is the one this test drives.
import {
  AUDIT_FAILING_SEVERITIES,
  DECISIONS_DOC,
  KNOWN_SEVERITIES,
  classifyAlerts,
  describeAlert,
  judgeAlerts,
  outcomeOfGraphCount,
  outcomeOfGraphFailure,
  outcomeOfReadFailure,
  readRecordedDecisions,
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
 *   2. Zero alerts with alerts SWITCHED OFF, or switched on with GitHub's dependency list still empty,
 *      exits 1 — a zero nobody looked for is not evidence. A zero it could not confirm never reads OK.
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
    scope?: string;
  };
  const alert = (over: AlertOverride = {}) => ({
    security_advisory: {
      severity: over.severity ?? "high",
      ghsa_id: over.ghsa ?? "GHSA-test-0001",
    },
    dependency: {
      package: { name: over.pkg ?? "left-pad" },
      manifest_path: "manifest" in over ? over.manifest : "package.json",
      scope: "scope" in over ? over.scope : "runtime",
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

  const honestZero = judgeAlerts({ alerts: [] }, { enabled: true, graph: { filled: true, packages: 1812 } });
  assert.equal(honestZero.exitCode, 0);
  assert.match(
    honestZero.notes.join("\n"),
    /^OK — no open alerts \(alerts are switched ON and GitHub's dependency list holds 1812 packages, so the zero was looked for\)/,
    "an honest zero must say WHY it counts as evidence, not merely that it is zero",
  );
  assert.match(
    honestZero.notes.join("\n"),
    /can still be early/,
    "the minutes between a filled list and the first alert cannot be read, so the sentence must say so",
  );

  const unknownZero = judgeAlerts({ alerts: [] }, { unknown: "could not tell (403)" });
  assert.equal(unknownZero.exitCode, 0, "an unreadable ON/OFF must not manufacture a failure either");
  assert.match(unknownZero.notes.join("\n"), /though could not tell \(403\)/);

  // 2a. SWITCHED ON IS NOT THE SAME AS LOOKED
  // Measured 2026-11-03: the switch read true at 15:43 and this printed "OK" on a zero, while the
  // dependency list still answered 404 and twenty alerts were yet to appear at 16:11.
  const unscanned = judgeAlerts(
    { alerts: [] },
    { enabled: true, graph: outcomeOfGraphFailure({ stderr: "gh: Not Found (HTTP 404)\n" }) },
  );
  assert.equal(unscanned.exitCode, 1, "a zero before GitHub's first scan must fail, not pass");
  assert.match(unscanned.errors.join("\n"), /dependency list for this repo is empty/);
  assert.doesNotMatch(unscanned.notes.join("\n"), /OK/, "a zero nobody scanned must never read OK");
  const emptyList = judgeAlerts({ alerts: [] }, { enabled: true, graph: outcomeOfGraphCount("0\n") });
  assert.equal(emptyList.exitCode, 1, "a dependency list answering zero packages is the same blind zero");

  // Never read is a skip, exit 0, and never the word OK. Each of these must say it is not a pass,
  // including the bare `{ enabled: true }` a caller gets by not passing the reading to `alertsEnabled`.
  const unreadGraphs = [
    outcomeOfGraphFailure({ message: "Command failed: gh", stderr: "gh: Internal Server Error (HTTP 500)\n" }),
    outcomeOfGraphFailure({ message: "spawnSync gh ETIMEDOUT" }),
    outcomeOfGraphCount(""),
    outcomeOfGraphCount("null"),
    undefined,
  ];
  for (const graph of unreadGraphs) {
    const unread = judgeAlerts({ alerts: [] }, { enabled: true, graph });
    const said = unread.notes.join("\n");
    assert.equal(unread.exitCode, 0, `an unread list must skip, not fail: ${JSON.stringify(graph)}`);
    assert.doesNotMatch(said, /OK/, `an unread list must never read OK: ${JSON.stringify(graph)}`);
    assert.match(said, /not a pass/, `an unread list must say it is not a pass: ${JSON.stringify(graph)}`);
  }
  assert.doesNotMatch(unknownZero.notes.join("\n"), /OK/, "an unread switch must never read OK either");
  assert.match(unknownZero.notes.join("\n"), /not a pass/);
  assert.deepEqual(outcomeOfGraphCount("1812\n"), { filled: true, packages: 1812 });
  assert.equal(
    judgeAlerts({ alerts: [alert({ severity: "low" })] }, { enabled: true }).exitCode,
    0,
    "a listed alert already proves the scan ran, so it needs no dependency-list read",
  );

  // 2b. A 403 THAT SAYS THE ALERTS ARE OFF IS THE BLIND REPO, NOT A BAD TOKEN
  // GitHub's literal answer on 2026-11-03, for a repository moved the day before and a token holding
  // `repo`. It was reported as a token problem and exited 0.
  const offRead = outcomeOfReadFailure({
    stderr: "gh: Dependabot alerts are disabled for this repository. (HTTP 403)\n",
  });
  assert.deepEqual(offRead, { switchedOff: true }, "alerts switched off must not read as a token problem");
  const off = judgeAlerts(offRead, { enabled: false });
  assert.equal(off.exitCode, 1, "alerts switched off must fail, never skip");
  assert.match(off.errors.join("\n"), /SWITCHED OFF/);
  assert.doesNotMatch(off.errors.join("\n"), /zero open alerts/, "GitHub listed nothing, so no count may be quoted");
  assert.equal(
    judgeAlerts(offRead, { unknown: "could not tell" }).exitCode,
    1,
    "the refusal is itself the proof, so a failed ON/OFF read must not turn it back into a pass",
  );
  // A 403 that says nothing about the setting is still the token, and still a skip.
  const tokenRead = outcomeOfReadFailure({
    stderr: "gh: Resource not accessible by personal access token (HTTP 403)\n",
  });
  assert.match("skipped" in tokenRead ? tokenRead.skipped : "", /token lacks/);
  assert.equal(judgeAlerts(tokenRead, { unknown: "not read" }).exitCode, 0);

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
  assert.deepEqual([...KNOWN_SEVERITIES].sort(), ["critical", "high", "low", "medium", "moderate"]);

  // 3b. A LIVE `medium` IS BELOW THE GATE, NOT UNREADABLE
  // The REST endpoint the script reads answers `medium`; GraphQL and `npm audit` answer `moderate`.
  // Only `moderate` was listed, so every MEDIUM alert fell out of KNOWN_SEVERITIES and was graded
  // urgent by the rule above — reported as `N open HIGH+ alert(s)` and `WILL FAIL CI` for something
  // that cannot fail `--audit-level=high` at all. Measured 2026-10-06: postcss-selector-parser
  // (GHSA-rj75-hqrm-r3gf) and sprintf-js (GHSA-hp3w-g68c-fv3c) both answered `medium` and both were
  // reported as gate-blocking while the gate command passed, and sprintf-js has no patch to bump to.
  assert.ok(!AUDIT_FAILING_SEVERITIES.has("medium"), "medium does not fail --audit-level=high either");
  for (const severity of ["medium", "moderate"]) {
    const { failing, other, unreachable } = classifyAlerts([
      alert({ severity, pkg: "sprintf-js", manifest: "pnpm-lock.yaml", scope: "runtime", patched: null }),
    ]);
    assert.equal(
      failing.length,
      0,
      `a ${severity} alert must NOT be graded urgent — both spellings are the same severity, and ` +
        "neither fails the gate",
    );
    assert.equal(unreachable.length, 0, `a ${severity} alert is below the gate, not out of its reach`);
    assert.equal(other.length, 1, `a ${severity} alert belongs in the below-the-audit-level list`);
    assert.doesNotMatch(
      describeAlert(other[0]),
      /UNREADABLE-SEVERITY/,
      `a ${severity} the payload stated plainly must never be reported as one nobody could read — a ` +
        "value the message can PRINT is not a value it could not READ",
    );
  }

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


  // 6. AUDIT REACHABILITY — AND THE FAIL-CLOSED RULE, WHICH IS THE ONLY REASON THIS IS SAFE
  //
  // `static`, behind `checks`, runs `pnpm audit --audit-level=high --prod` at the repository ROOT. Two kinds of open
  // HIGH alert provably cannot turn that red: one whose scope is `development` (the `--prod` filter
  // drops it) and one in a manifest the root audit never reads. Grading those as "WILL FAIL CI" is
  // what this tool did until 2026-10-04 — it printed three such lines and exited 1 while
  // `node scripts/ci-dependency-audit.mjs`, the gate command itself, exited 0 on "No known
  // vulnerabilities found" with all three open. A pre-merge check that cries wolf before every merge
  // is one people learn to wave through.
  //
  // The danger in the other direction is obvious, so every case below pins the SAME rule: an alert
  // leaves `failing` only when the reason is POSITIVELY read. Every absent or unrecognised answer
  // stays failing.

  const reachable = classifyAlerts([
    alert({ severity: "high", pkg: "in-prod-tree", manifest: "pnpm-lock.yaml", scope: "runtime" }),
  ]);
  assert.deepEqual(
    reachable.failing.map((r) => r.package),
    ["in-prod-tree"],
    "a runtime-scope HIGH in the audited lockfile is exactly what fails the gate - it must stay failing",
  );
  assert.deepEqual(reachable.unreachable, [], "and it must not be parked as unreachable");

  const devScope = classifyAlerts([
    alert({ severity: "high", pkg: "dev-only", manifest: "pnpm-lock.yaml", scope: "development" }),
  ]);
  assert.deepEqual(
    devScope.failing,
    [],
    "a development-scope alert cannot fail `--prod`, so calling it WILL FAIL CI is a false alarm",
  );
  assert.deepEqual(
    devScope.unreachable.map((r) => r.package),
    ["dev-only"],
    "it must still be REPORTED - the change is the verdict attached, never whether a reader sees it",
  );
  assert.match(
    String(devScope.unreachable[0].outOfAuditReach),
    /development scope/,
    "and the row must carry the reason, so the report can say WHY rather than asserting it",
  );

  const otherTree = classifyAlerts([
    alert({ severity: "high", pkg: "elsewhere", manifest: "some-other-app/package-lock.json", scope: "runtime" }),
  ]);
  assert.deepEqual(
    otherTree.failing,
    [],
    "a manifest the root audit never walks cannot turn the root audit red",
  );
  assert.deepEqual(
    otherTree.unreachable.map((r) => r.package),
    ["elsewhere"],
    "but it is a real open alert and must be printed",
  );

  // THE FAIL-CLOSED CASES. Each one is an ABSENT answer, and each must stay failing. If any of these
  // four ever flips to `unreachable`, the tool has started quieting alerts on no evidence - which is
  // the 2026-09-30 frozen-afternoon failure with the sign reversed.
  for (const [label, over] of [
    ["an absent scope", { scope: undefined, manifest: "pnpm-lock.yaml" }],
    ["an unrecognised scope", { scope: "whatever", manifest: "pnpm-lock.yaml" }],
    ["an absent manifest", { scope: "runtime", manifest: undefined }],
    ["an empty manifest", { scope: "runtime", manifest: "" }],
    ["an unreadable manifest", { scope: "runtime", manifest: "(unknown manifest)" }],
  ] as const) {
    const closed = classifyAlerts([alert({ severity: "high", pkg: "unknown-shape", ...over })]);
    assert.deepEqual(
      closed.unreachable,
      [],
      `${label} is an absent answer, not a proof of safety - it must NOT be parked as unreachable`,
    );
    assert.deepEqual(
      closed.failing.map((r) => r.package),
      ["unknown-shape"],
      `${label} must stay failing, so a wrong reading can only ever be noisy, never quiet`,
    );
  }

  // An UNREADABLE severity outranks reachability. Reachability answers "can this turn the gate red",
  // which is a weaker question than "is this dangerous"; an alert nobody could grade stays loud
  // whatever tree it sits in. This is the §3 rule above, re-pinned where it could be undone.
  const ungradable = classifyAlerts([
    alert({ severity: "", pkg: "mystery", manifest: "some-other-app/package-lock.json", scope: "runtime" }),
  ]);
  assert.deepEqual(
    ungradable.unreachable,
    [],
    "an unreadable severity must never be quieted by a reachability rule - it could be a CRITICAL",
  );
  assert.deepEqual(
    ungradable.failing.map((r) => r.package),
    ["mystery"],
    "it stays urgent, exactly as it does in the audited tree",
  );

  // THE EXIT CODE IS THE WHOLE POINT: unreachable HIGH alerts must not block a merge.
  const unreachableOnly = judgeAlerts(
    {
      alerts: [
        alert({ severity: "high", pkg: "dev-only", manifest: "pnpm-lock.yaml", scope: "development" }),
        alert({ severity: "high", pkg: "elsewhere", manifest: "some-other-app/package-lock.json", scope: "runtime" }),
      ],
    },
    { enabled: true },
  );
  assert.equal(
    unreachableOnly.exitCode,
    0,
    "open HIGH alerts that provably cannot fail the audit must not fail this check either - that "
      + "mismatch is what sent sessions hunting a bump that does not exist",
  );
  assert.deepEqual(unreachableOnly.errors, [], "and nothing may be reported as an error");
  assert.equal(
    unreachableOnly.notes.filter((n) => /CANNOT fail the gate/.test(n)).length,
    2,
    "both must still be listed - silence here would be the false green this file exists to prevent",
  );
  // 🔴 The all-clear sentence must not contradict the lines above it. It used to read "none of them
  // HIGH or CRITICAL", which would be printed directly beneath two HIGH rows.
  const allClear = unreachableOnly.notes.find((n) => /^OK —/.test(n)) ?? "";
  assert.ok(allClear, "an all-clear line must be printed");
  assert.doesNotMatch(
    allClear,
    /none of them HIGH/i,
    "the all-clear must not claim nothing is HIGH while HIGH rows are listed immediately above it",
  );
  assert.match(
    allClear,
    /cannot reach/i,
    "it must say WHY they are tolerable - a bare OK over a HIGH alert is the shape of a false green",
  );

  // A reachable HIGH beside unreachable ones still fails. The feature must not become an escape hatch.
  const mixed = judgeAlerts(
    {
      alerts: [
        alert({ severity: "high", pkg: "dev-only", manifest: "pnpm-lock.yaml", scope: "development" }),
        alert({ severity: "high", pkg: "real-one", manifest: "pnpm-lock.yaml", scope: "runtime" }),
      ],
    },
    { enabled: true },
  );
  assert.equal(mixed.exitCode, 1, "one reachable HIGH must still fail the check");
  assert.equal(
    mixed.errors.filter((e) => /WILL FAIL CI/.test(e)).length,
    1,
    "and exactly the reachable one is named - the count in the summary drives what a session bumps",
  );
  // What it prints names the check that really goes red. The audit left `validate` on 2026-10-19 for
  // the `static` job behind `checks`, so a session watching `validate` would wait on the wrong one.
  for (const line of [...mixed.errors, ...unreachableOnly.notes]) {
    assert.doesNotMatch(
      line,
      new RegExp("`validate`"),
      "a printed line must not name validate as the check the audit fails",
    );
  }

  // The reachability set is derived from the repo's own shape, not guessed. `pnpm-workspace.yaml`
  // declares no `packages:` list, so the root audit walks exactly one tree; if that ever changes, this
  // assertion is the thing that says the set must change with it.
  const workspace = readFileSync("pnpm-workspace.yaml", "utf8");
  assert.doesNotMatch(
    stripComments(workspace),
    /^packages:/m,
    "AUDITED_MANIFESTS assumes a single-package repo - if a `packages:` list appears, every workspace "
      + "manifest becomes audit-reachable and the set in scripts/dependabot-alerts.mjs must grow to match",
  );

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
  assert.match(doctor, /judgeAlerts\(read, alertsEnabled\(read\)\)/, "the section must use the shared judgement");
  assert.match(
    doctor,
    /skipped \(--no-auth\)\. This check reads the live alerts API\./,
    "the section must honour --no-auth like every other live-reading section there",
  );

  // And the ship skill must name it as a PRE-MERGE read. This is the one place the timing matters: a
  // PR's green says the dependency audit passed WHEN IT RAN, and `main` runs it again after the merge,
  // where a red suite makes Railway mark the production deploy SKIPPED for good. So the read belongs
  // before the merge, not only in a report someone runs on a quiet afternoon.
  const ship = readFileSync(".claude/skills/ship/SKILL.md", "utf8");
  assert.match(
    ship,
    /node scripts\/check-dependabot-alerts\.mjs/,
    "the ship skill must run this check before merging - that is the moment its answer changes what a "
      + "session does",
  );
  assert.match(
    ship,
    /skipped[^\n]*is NOT a pass/i,
    "the ship skill must say a skip is not a pass, or the one degraded reading reads as clear at the "
      + "moment it matters most",
  );

  // And it must carry the unreachable branch too. Without it the skill still says "an open HIGH →
  // bump it first", which is an instruction nobody can follow when no patched version exists — the
  // exact dead end measured on 2026-10-04.
  assert.match(
    ship,
    /CANNOT fail the gate/,
    "the ship skill must tell a session that an unreachable HIGH alert is not a bump to chase, or the "
      + "pre-merge read sends it hunting a version that does not exist",
  );
  assert.match(
    ship,
    /docs\/security\/open-dependency-alerts\.md/,
    "and it must point at the recorded decision, so the reasoning is one click away at the moment the "
      + "session has to act on it",
  );
  assert.ok(
    existsSync("docs/security/open-dependency-alerts.md"),
    "the recorded decision must exist - a skill pointing at a missing file is worse than no pointer. "
      + "existsSync, not readFileSync: a read THROWS ENOENT before the assertion is evaluated, so the "
      + "message never prints and the case proves nothing",
  );

  // ---------------------------------------------------------------------------------------------
  // A RECORDED RISK DECISION RETIRES THE DEMAND FOR ONE — AND NOTHING ELSE RETIRES IT.
  //
  // `describeAlert` ended every unpatched alert with "needs ... a recorded risk decision", including
  // the one whose decision was already written and dated in open-dependency-alerts.md. The ship skill
  // reads this check before every merge, so on 2026-10-05 a session read that line, believed three
  // alerts were unjudged, and put the already-answered question to the owner. A demand that outlives
  // its answer is the same cry-wolf failure as the 2026-10-04 false `WILL FAIL CI`, from the other side.
  const ACCEPTED_DOC = [
    "### `braces` — GHSA-vfj7-8cjw-p6xm · HIGH",
    "",
    "| | |",
    "| --- | --- |",
    "| **Decision** | **Accepted. Not bumped, not overridden.** Recorded 2026-10-04 at the owner's instruction. |",
    "| Alert | #112, opened 2026-10-03, root `pnpm-lock.yaml` |",
    "",
  ].join("\n");

  assert.deepEqual(
    [...readRecordedDecisions(ACCEPTED_DOC).entries()],
    [[112, { recorded: "2026-10-04" }]],
    "a section that positively yields BOTH one alert number and an Accepted decision must be read as "
      + "a recorded decision, keyed on the alert NUMBER",
  );

  // 🔴 THE CASE THE WHOLE KEYING CHOICE EXISTS FOR. One advisory opens one alert PER MANIFEST, and
  // open-dependency-alerts.md says in red that a row for one "is not a precedent for the other open
  // alerts". braces GHSA-vfj7-8cjw-p6xm is open twice here — #112 in the audited root tree and #111
  // in another application's lockfile — and only #112 is decided. Keying on the GHSA would silently
  // accept the undecided one, turning a written refusal to judge it into an automatic acceptance.
  const twoAlertsOneAdvisory = classifyAlerts([
    { number: 112, security_advisory: { severity: "high", ghsa_id: "GHSA-vfj7-8cjw-p6xm" }, dependency: { package: { name: "braces" }, scope: "development", manifest_path: "pnpm-lock.yaml" }, security_vulnerability: { vulnerable_version_range: "<= 3.0.3" } },
    { number: 111, security_advisory: { severity: "high", ghsa_id: "GHSA-vfj7-8cjw-p6xm" }, dependency: { package: { name: "braces" }, scope: "runtime", manifest_path: "other-app/package-lock.json" }, security_vulnerability: { vulnerable_version_range: "<= 3.0.3" } },
  ]).unreachable;
  const decisions = readRecordedDecisions(ACCEPTED_DOC);
  const decided = twoAlertsOneAdvisory.find((r) => r.number === 112);
  const undecided = twoAlertsOneAdvisory.find((r) => r.number === 111);
  assert.ok(decided && undecided, "both alerts of the shared advisory must classify as unreachable");
  assert.match(
    describeAlert(decided, decisions),
    /risk ACCEPTED, recorded 2026-10-04/,
    "the alert whose decision IS recorded must stop demanding one",
  );
  assert.doesNotMatch(
    describeAlert(undecided, decisions),
    /ACCEPTED/,
    "the OTHER alert of the same advisory must keep its demand — open-dependency-alerts.md states in "
      + "red that one row is not a precedent for the others, and keying on the GHSA would make that "
      + "precedent automatic and invisible",
  );
  assert.match(
    describeAlert(undecided, decisions),
    /needs an override, a replacement, or a recorded risk decision/,
    "and it must keep the ORIGINAL wording, not a softened one",
  );

  // 🔴 A PATCHED VERSION AND A RECORDED DECISION TOGETHER — the combination #113 arrived with, and the
  // one the two cases above cannot see. Every decision written in open-dependency-alerts.md before
  // 2026-10-06 was for an alert with NO patched version, so the acceptance note only ever had to
  // replace the "needs a decision" demand. #113 (source-map-js, patched at 1.2.2, in another
  // application's lockfile) has both, and printed as a bare `bump to 1.2.2`: the decision was recorded
  // and invisible, so the next session reads an instruction the owner has already answered — and in
  // this repo the path that bump lives in is one the mobile freeze guard refuses, so acting on it fails
  // twice over. Both halves are now printed, because both are true.
  const DECIDED_113 = [
    "### `source-map-js` — GHSA-68fv-2mgg-jv7q · HIGH",
    "",
    "| | |",
    "| --- | --- |",
    "| **Decision** | **Accepted for this repository's audit gate only.** Recorded 2026-10-06 at the owner's instruction. |",
    "| Alert | #113, opened 2026-10-06, `other-app/package-lock.json` |",
    "",
  ].join("\n");
  const decided113 = readRecordedDecisions(DECIDED_113);
  const patchedAlert = (manifest: string) => ({
    number: 113,
    security_advisory: { severity: "high", ghsa_id: "GHSA-68fv-2mgg-jv7q" },
    dependency: { package: { name: "source-map-js" }, scope: "runtime", manifest_path: manifest },
    security_vulnerability: { vulnerable_version_range: ">= 1.0.0, < 1.2.2", first_patched_version: { identifier: "1.2.2" } },
  });

  const patchedUnreachable = classifyAlerts([patchedAlert("other-app/package-lock.json")]).unreachable[0];
  assert.ok(patchedUnreachable, "a patched HIGH in an unread manifest must still classify as unreachable");
  assert.match(
    describeAlert(patchedUnreachable, decided113),
    /bump to 1\.2\.2 — but risk ACCEPTED, recorded 2026-10-06/,
    "an unreachable alert that HAS a patched version and a recorded decision must print BOTH — the "
      + "version that exists and the decision not to take it here. Printing the bump alone hands the "
      + "next session an instruction the owner has already answered.",
  );

  // 🔴 AND THE REACHABLE ONE KEEPS ITS BARE BUMP. A recorded acceptance must never read as a reason to
  // leave something that will turn `checks` red — which by AGENTS.md §2.3 withholds a production
  // deploy. This is the fail-closed direction of the case above, and the only reason it is safe.
  const patchedReachable = classifyAlerts([patchedAlert("pnpm-lock.yaml")]).failing[0];
  assert.ok(patchedReachable, "a patched runtime HIGH in the audited lockfile must classify as failing");
  assert.doesNotMatch(
    describeAlert(patchedReachable, decided113),
    /ACCEPTED/,
    "a GATE-FAILING alert must keep its bare bump instruction even with a decision recorded against its "
      + "number — an acceptance is about a gate that cannot go red, never about one that will.",
  );

  // FAIL CLOSED in every direction: the worst a misreading can do is leave a demand up, never retire
  // one nobody wrote. Each clause is its own case so a failure names which direction broke.
  for (const [why, doc] of [
    ["a decision worded as something other than Accepted", ACCEPTED_DOC.replace("**Accepted. Not bumped, not overridden.**", "**Deferred for now.**")],
    ["no Recorded date", ACCEPTED_DOC.replace("Recorded 2026-10-04 at the owner's instruction.", "at the owner's instruction.")],
    ["no alert number", ACCEPTED_DOC.replace("| Alert | #112, opened 2026-10-03, root `pnpm-lock.yaml` |", "| Alert | root `pnpm-lock.yaml` |")],
    ["two alert numbers in one section, so which is decided cannot be said", ACCEPTED_DOC.replace("| Alert | #112, opened", "| Alert | #112 and #111, opened")],
    ["an empty file", ""],
    ["an unreadable file (the CLI passes '' when the read throws)", ""],
  ] as Array<[string, string]>) {
    assert.equal(
      readRecordedDecisions(doc).size,
      0,
      `readRecordedDecisions must record NOTHING when there is ${why} — it fails closed, so an alert `
        + "keeps its demand rather than being quietly accepted",
    );
  }
  assert.equal(readRecordedDecisions(undefined as unknown as string).size, 0, "a non-string records nothing");

  // And with no decisions at all, every unpatched alert keeps the original demand — the behaviour
  // before this change, unchanged for everything that has not been judged.
  assert.match(
    describeAlert(undecided, undefined),
    /needs an override, a replacement, or a recorded risk decision/,
    "with no decisions map at all, nothing is downgraded",
  );

  // The doc the CLI reads must be where the constant says, or the read returns '' and every decision
  // silently stops being honoured — quiet in the safe direction, but the feature would be dead.
  assert.ok(
    existsSync(DECISIONS_DOC),
    `DECISIONS_DOC points at ${DECISIONS_DOC}, which does not exist — readRecordedDecisions would get `
      + "'' forever and no recorded decision would ever be honoured",
  );
  assert.ok(
    readRecordedDecisions(readFileSync(DECISIONS_DOC, "utf8")).size > 0,
    `${DECISIONS_DOC} exists but no recorded decision parses out of it. Either the table shape changed `
      + "or a row lost its Decision/Alert cell; the parser and the doc have to move together",
  );
}
