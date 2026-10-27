// A PULL REQUEST MAY NOT MOVE A PACKAGE BACKWARD IN pnpm-lock.yaml — AND THE WEEKLY REFRESH MUST NOT CAUSE IT.
//
// WHY THIS EXISTS (owner, 2026-10-27). Dependabot regenerates pnpm-lock.yaml for its own PR and hands pnpm its
// seven-day cooldown as `--config.minimum-release-age`; pnpm then re-resolves EVERY lockfile entry younger than that
// to an older version, transitive ones included. The weekly refresh (#6466, 25 Oct) had adopted versions 1-6 days old,
// so PRs 6486-6488 (26 Oct) and 6580-6582 (27 Oct) each rolled back ~40 packages: puppeteer-core 25.16.0 -> 25.14.0,
// imapflow 2.9.1 -> 2.5.8, nodemailer, openai, supabase, lucide-react, 17 @sentry/*. Only the puppeteer pin's two
// tests went red (infra/runtime-extras must equal the lockfile); the rest would have merged without a sound.
// Each time the PR was REPLACED by hand (#6493, #6595), never repaired. Account: docs/dependency-refresh.md.
//
// Two halves, because either alone leaves the hole:
//   1. THE CAUSE — lockfile.yml's refresh now uses the same seven-day window as dependabot.yml's cooldown, so the
//      refresh stops adopting what Dependabot will roll back. Pinned below against the cooldown itself.
//   2. THE NET — any pull request whose lockfile holds an older version than its base fails here, with the exact
//      route (close it, redo the manifest change on a codex/ branch, run `remote-check.mjs lockfile`). The weekly
//      refresh's own branch is exempt; a rollback somebody MEANT goes in scripts/deps-refresh/allowed-downgrades.txt.
//
// The live comparison runs on a pull_request in CI and against origin/main locally. On a push to main, a dispatch or
// a schedule it does NOT run: a red main would withhold the production deploy (the release gate), and there is no
// "base" to compare against that is not the commit itself.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { compareVersions, downgradeKey, lockDowngrades, lockfileVerdict, parseAllowedDowngrades } from "../scripts/deps-refresh/downgrades.mjs";
import { BRANCH_PREFIX } from "../scripts/deps-refresh/refresh.mjs";
import { stripHashComments } from "./support/comment-strip.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** A minimal lockfile whose `packages:` section holds exactly these `name@version` entries. */
function lock(...entries: string[]): string {
  const blocks = entries.flatMap((entry) => {
    const name = entry.slice(0, entry.lastIndexOf("@"));
    const key = name.startsWith("@") ? `'${entry}'` : entry;
    return [`  ${key}:`, "    resolution: {integrity: sha512-x}", ""];
  });
  return ["lockfileVersion: '9.0'", "", "packages:", "", ...blocks, "snapshots:", ""].join("\n");
}

const downgradesOf = (before: string[], after: string[]) => lockDowngrades(lock(...before), lock(...after)).map(downgradeKey);

/**
 * The lockfile this pull request was cut against, or null when there is nothing to compare with (the reason is
 * the second member). In CI on a pull_request the checkout is the MERGE ref, so its first parent is the base.
 */
function baseLockfile(): { text: string | null; why: string } {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (process.env.GITHUB_ACTIONS === "true") {
    const event = process.env.GITHUB_EVENT_NAME ?? "";
    if (event !== "pull_request") return { text: null, why: `a ${event || "non-pull-request"} run has no base to compare with` };
    // FAIL CLOSED: a pull request whose base cannot be read must not pass for want of looking.
    try {
      const parents = git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(/\s+/);
      assert.equal(parents.length, 3, "the pull_request checkout must be the merge ref (HEAD and two parents) — ci.yml's `unit` job uses fetch-depth: 2 for exactly this");
      return { text: git("show", "HEAD^1:pnpm-lock.yaml").replace(/\r\n/g, "\n"), why: "HEAD^1 of the merge ref" };
    } catch (error) {
      throw new Error(`the pull request's base lockfile could not be read in CI (${error instanceof Error ? error.message : String(error)}) — the downgrade gate fails closed, never open`);
    }
  }
  try {
    const base = git("merge-base", "HEAD", "origin/main").trim();
    return { text: git("show", `${base}:pnpm-lock.yaml`).replace(/\r\n/g, "\n"), why: "the merge-base with origin/main" };
  } catch {
    return { text: null, why: "origin/main is not present in this checkout" };
  }
}

export function runLockfileDowngradeGateTests() {
  // ---- compareVersions: semver precedence, and "not comparable" never means "older" -----------------------------
  assert.ok(compareVersions("25.14.0", "25.16.0")! < 0, "25.14.0 is below 25.16.0");
  assert.ok(compareVersions("25.16.0", "25.14.0")! > 0, "25.16.0 is above 25.14.0");
  assert.ok(compareVersions("2.0.0", "1.99.99")! > 0, "the major outranks everything after it");
  assert.ok(compareVersions("1.0.10", "1.0.9")! > 0, "numbers compare as numbers, not as text");
  assert.equal(compareVersions("3.1.4", "3.1.4"), 0, "equal versions compare equal");
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.0")! < 0, "a prerelease is below its release");
  assert.ok(compareVersions("1.0.0", "1.0.0-rc.1")! > 0, "a release is above its prerelease");
  assert.ok(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")! < 0, "numeric prerelease identifiers compare as numbers");
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-beta")! < 0, "alphanumeric prerelease identifiers compare as text");
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.0-rc.1.1")! < 0, "a longer prerelease outranks its prefix");
  assert.ok(compareVersions("1.0.0-1", "1.0.0-alpha")! < 0, "a numeric identifier is below an alphanumeric one");
  assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0, "build metadata is ignored");
  for (const odd of ["link:../packages/x", "https://codeload.github.com/o/r/tar.gz/abc123", "1.0", "latest"]) {
    assert.equal(compareVersions(odd, "1.0.0"), null, `"${odd}" is not a plain semver, so it is never compared — and so never called a downgrade`);
    assert.equal(compareVersions("1.0.0", odd), null, `"${odd}" on the right-hand side is just as incomparable`);
  }

  // ---- lockDowngrades: what IS a downgrade, and what is not -----------------------------------------------------
  assert.deepEqual(downgradesOf(["puppeteer-core@25.16.0"], ["puppeteer-core@25.14.0"]), ["puppeteer-core 25.16.0 -> 25.14.0"], "the incident: puppeteer-core 25.16.0 -> 25.14.0");
  assert.deepEqual(downgradesOf(["@sentry/core@11.9.0"], ["@sentry/core@11.8.0"]), ["@sentry/core 11.9.0 -> 11.8.0"], "a scoped package is read whole, scope included");
  assert.deepEqual(downgradesOf(["foo@1.2.0"], ["foo@1.3.0"]), [], "an upgrade is not a downgrade");
  assert.deepEqual(downgradesOf(["foo@1.2.0"], ["foo@1.2.0"]), [], "no move is no downgrade");
  assert.deepEqual(downgradesOf(["foo@1.2.0"], []), [], "a package removed is not a downgrade");
  assert.deepEqual(downgradesOf([], ["foo@1.2.0"]), [], "a package added is not a downgrade");
  assert.deepEqual(downgradesOf(["foo@3.0.0"], ["foo@2.9.0"]), [], "a major change is a decision, not a cooldown rollback — it is never this gate's business");
  assert.deepEqual(downgradesOf(["foo@2.9.0"], ["foo@3.0.0"]), [], "a major upgrade is an upgrade");
  assert.deepEqual(
    downgradesOf(["@babel/parser@7.29.11"], ["@babel/parser@7.29.11", "@babel/parser@7.29.9"]),
    [],
    "an OLDER copy added BESIDE the one that stays is a second range in the graph, not a rollback (@babel/parser holds two)",
  );
  assert.deepEqual(
    downgradesOf(["foo@1.2.0", "foo@2.0.0"], ["foo@1.1.0", "foo@2.0.0"]),
    ["foo 1.2.0 -> 1.1.0"],
    "a package held at two majors is judged per major: only the version that went backward is named",
  );
  assert.deepEqual(downgradesOf(["foo@1.2.0", "foo@2.0.0"], ["foo@1.2.0", "foo@2.0.0"]), [], "two majors untouched are untouched");
  assert.deepEqual(downgradesOf(["foo@2.0.0"], ["foo@2.0.0-rc.1"]), ["foo 2.0.0 -> 2.0.0-rc.1"], "a release replaced by its own prerelease is a rollback");
  assert.deepEqual(downgradesOf(["foo@2.0.0-rc.2"], ["foo@2.0.0-rc.1"]), ["foo 2.0.0-rc.2 -> 2.0.0-rc.1"], "so is one prerelease replaced by an earlier one");
  assert.deepEqual(downgradesOf(["foo@2.0.0-rc.1"], ["foo@2.0.0"]), [], "a prerelease replaced by its release is an upgrade");
  assert.deepEqual(
    downgradesOf(["zeta@1.0.1", "alpha@2.0.1", "alpha@1.0.1"], ["zeta@1.0.0", "alpha@2.0.0", "alpha@1.0.0"]),
    ["alpha 1.0.1 -> 1.0.0", "alpha 2.0.1 -> 2.0.0", "zeta 1.0.1 -> 1.0.0"],
    "sorted by name, then by the version it left — a stable message for a stable failure",
  );
  assert.deepEqual(
    downgradesOf(["foo@1.0.1", "foo@1.1.1"], ["foo@1.0.0", "foo@1.1.0"]),
    ["foo 1.1.1 -> 1.1.0"],
    "within ONE major only the highest copy is judged (a lower copy cannot be told from an unrelated older range added beside it) — a rollback of the lot still fails on the highest",
  );
  assert.deepEqual(lockDowngrades(lock("foo@1.2.0"), lock("foo@1.1.0").replace(/\n/g, "\r\n")), [{ name: "foo", from: "1.2.0", to: "1.1.0" }], "CRLF on one side does not hide a downgrade");
  assert.deepEqual(lockDowngrades(lock("foo@1.2.0"), lock("foo@1.2.0").replace(/\n/g, "\r\n")), [], "and does not invent one");

  // ---- the allowlist file -----------------------------------------------------------------------------------------
  assert.equal(downgradeKey({ name: "left-pad", from: "1.3.0", to: "1.2.0" }), "left-pad 1.3.0 -> 1.2.0", "the line a failure prints is the line the allowlist takes");
  const allowed = parseAllowedDowngrades(
    ["# a comment", "", "left-pad 1.3.0 -> 1.2.0", "  @sentry/core   11.9.0  ->  11.8.0  # backed out: the 11.9.0 release breaks replay", "# commented 1.0.0 -> 0.9.0", "\r"].join("\r\n"),
  );
  assert.deepEqual([...allowed].sort(), ["@sentry/core 11.9.0 -> 11.8.0", "left-pad 1.3.0 -> 1.2.0"], "comments, blanks and CRLF are ignored; inner spacing and a trailing comment do not matter");
  assert.equal(parseAllowedDowngrades("").size, 0, "an empty file allows nothing");
  const shipped = read("scripts/deps-refresh/allowed-downgrades.txt");
  for (const line of parseAllowedDowngrades(shipped)) {
    assert.match(line, /^(?:@[^\s/]+\/)?[^\s@/]+ \S+ -> \S+$/, `allowed-downgrades.txt line "${line}" must read exactly "name from -> to" (as a failure prints it) — a misspelt line clears nothing and would look like a gate that works`);
  }

  // ---- lockfileVerdict: what a failing pull request is told --------------------------------------------------------
  const BEFORE = lock("puppeteer-core@25.16.0", "imapflow@2.9.1", "left-pad@1.3.0");
  const AFTER = lock("puppeteer-core@25.14.0", "imapflow@2.5.8", "left-pad@1.3.0");
  const dependabot = lockfileVerdict({ before: BEFORE, after: AFTER, headRef: "dependabot/npm_and_yarn/openai-7.45.1", allowedText: "" });
  assert.equal(dependabot.exempt, false, "a Dependabot pull request is not exempt");
  assert.deepEqual(dependabot.downgrades.map(downgradeKey), ["imapflow 2.9.1 -> 2.5.8", "puppeteer-core 25.16.0 -> 25.14.0"], "it names every package that went backward");
  for (const must of [
    "moves 2 package versions BACKWARD",
    "  puppeteer-core 25.16.0 -> 25.14.0",
    "  imapflow 2.9.1 -> 2.5.8",
    "This is a Dependabot pull request",
    "Do not merge it",
    "REPLACE the pull request, never repair it",
    "close it",
    "codex/ branch cut from main",
    "node scripts/remote-check.mjs lockfile",
    "PR 6493 and PR 6595",
    "scripts/deps-refresh/allowed-downgrades.txt",
    'docs/dependency-refresh.md, "Why a Dependabot PR is replaced, never merged"',
  ]) {
    assert.ok(dependabot.message.includes(must), `a Dependabot pull request's failure must say: ${must}`);
  }
  const single = lockfileVerdict({ before: lock("foo@1.2.0"), after: lock("foo@1.1.0"), headRef: "codex/some-task", allowedText: "" });
  assert.ok(single.message.includes("moves 1 package version BACKWARD"), "one package reads in the singular");
  assert.ok(!single.message.includes("This is a Dependabot pull request"), "the Dependabot paragraph belongs to Dependabot branches only");
  assert.ok(single.message.includes("node scripts/remote-check.mjs lockfile"), "every other branch gets the replacement route too");
  const clean = lockfileVerdict({ before: BEFORE, after: BEFORE, headRef: "dependabot/npm_and_yarn/x", allowedText: "" });
  assert.deepEqual({ exempt: clean.exempt, n: clean.downgrades.length, message: clean.message }, { exempt: false, n: 0, message: "" }, "an unchanged lockfile has nothing to say");
  const upgrade = lockfileVerdict({ before: AFTER, after: BEFORE, headRef: "dependabot/npm_and_yarn/x", allowedText: "" });
  assert.equal(upgrade.message, "", "a lockfile that only moves forward passes");
  const part = lockfileVerdict({ before: BEFORE, after: AFTER, headRef: "codex/x", allowedText: "puppeteer-core 25.16.0 -> 25.14.0" });
  assert.deepEqual(part.downgrades.map(downgradeKey), ["imapflow 2.9.1 -> 2.5.8"], "an allowlist line clears exactly the package it names — the rest still fail");
  const all = lockfileVerdict({ before: BEFORE, after: AFTER, headRef: "codex/x", allowedText: "puppeteer-core 25.16.0 -> 25.14.0\nimapflow 2.9.1 -> 2.5.8" });
  assert.equal(all.message, "", "every rollback listed means nothing to report");
  const wrongVersion = lockfileVerdict({ before: BEFORE, after: AFTER, headRef: "codex/x", allowedText: "puppeteer-core 25.16.0 -> 25.13.0\nimapflow 2.9.1 -> 2.5.8" });
  assert.deepEqual(wrongVersion.downgrades.map(downgradeKey), ["puppeteer-core 25.16.0 -> 25.14.0"], "an entry for a different target version clears nothing: the rollback is judged exactly");

  // The weekly refresh is exempt, and ONLY by its own branch prefix (refresh.mjs's BRANCH_PREFIX, the one-open-PR guard).
  const refreshBranch = lockfileVerdict({ before: BEFORE, after: AFTER, headRef: `${BRANCH_PREFIX}2026-11-01`, allowedText: "" });
  assert.deepEqual({ exempt: refreshBranch.exempt, message: refreshBranch.message }, { exempt: true, message: "" }, "the weekly refresh's branch is exempt — its PR body lists what the seven-day window rolled back");
  const lookalike = lockfileVerdict({ before: BEFORE, after: AFTER, headRef: "codex/deps-refresh-weekly", allowedText: "" });
  assert.equal(lookalike.exempt, false, "a branch that merely talks about a refresh is not exempt");
  const lookalike2 = lockfileVerdict({ before: BEFORE, after: AFTER, headRef: `x/${BRANCH_PREFIX}1`, allowedText: "" });
  assert.equal(lookalike2.exempt, false, "the prefix must START the branch name");
  const noRef = lockfileVerdict({ before: BEFORE, after: AFTER, headRef: "", allowedText: "" });
  assert.equal(noRef.exempt, false, "no head ref (a local run) is never exempt");

  // ---- the CAUSE: lockfile.yml's refresh uses the same window as Dependabot's cooldown ---------------------------------
  const dependabotYml = stripHashComments(read(".github/dependabot.yml"));
  const npmBlock = dependabotYml.split(/^ {2}- package-ecosystem:/m).find((block) => block.trimStart().startsWith("npm"));
  assert.ok(npmBlock, "dependabot.yml must keep its npm ecosystem — the cooldown below is read from it");
  const cooldown = /cooldown:\s*\n\s+default-days:\s*(\d+)/.exec(npmBlock!);
  assert.ok(cooldown, "dependabot.yml's npm ecosystem must keep a cooldown with default-days — the refresh's window is held to it");
  const cooldownMinutes = Number(cooldown![1]) * 1440;
  assert.ok(cooldownMinutes >= 7 * 1440, `the npm cooldown is ${cooldown![1]} days; it was 7 on 27 Oct 2026 and the refresh window is held to it — lowering it needs a conscious look at docs/dependency-refresh.md`);

  const workflow = stripHashComments(read(".github/workflows/lockfile.yml"));
  const refreshStep = /- name: Refresh every dependency inside its declared range\n\s+if: inputs\.mode == 'refresh'\n\s+run: ([^\n]+)/.exec(workflow);
  assert.ok(refreshStep, "lockfile.yml must keep its refresh step");
  const command = refreshStep![1];
  const window = /--config\.minimum-release-age=(\d+)(?=\s|$)/.exec(command);
  assert.ok(window, "the refresh must pass --config.minimum-release-age=<minutes> (kebab-case, the spelling Dependabot itself uses) — pnpm's default of ONE day is what let Dependabot roll the refresh back");
  assert.ok(
    Number(window![1]) >= cooldownMinutes,
    `the refresh window (${window![1]} minutes) must be at least Dependabot's cooldown (${cooldownMinutes} minutes): anything younger is rolled back by the next Dependabot lockfile`,
  );
  assert.equal(command.match(/--config\.minimum-release-age=/g)!.length, 1, "the window is set once");
  assert.match(
    command,
    /--config\.trust-lockfile=true(?=\s|$)/,
    "without trustLockfile pnpm re-applies the window to the lockfile it LOADS — main's own, 90 entries 3-6 days old — and dies with ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION before it resolves anything (run 40536015873)",
  );
  assert.match(
    command,
    /--config\.minimum-release-age-strict=false(?=\s|$)/,
    "setting the age explicitly turns strict mode on, and strict refuses --no-save with ERR_PNPM_STRICT_MIN_RELEASE_AGE_REQUIRES_SAVE (run 40536363067)",
  );
  assert.match(command, /--no-save/, "the seven-day window must not cost the refresh its --no-save");
  assert.match(command, /--depth Infinity/, "nor its --depth Infinity");
  const regenerate = /- name: Regenerate the lockfile\n\s+if: inputs\.mode != 'refresh'\n\s+run: ([^\n]+)/.exec(workflow);
  assert.ok(regenerate, "lockfile.yml must keep its regenerate step");
  assert.ok(
    !/minimum-release-age|trust-lockfile/.test(regenerate![1]),
    "regenerate mode (remote-check.mjs lockfile) must NOT apply a release-age window: it brings a branch's changed manifests into the lockfile and moves nothing else — a window would roll back every young bump a person made on purpose",
  );

  // ---- the NET: THIS pull request's lockfile against its base --------------------------------------------------------
  const base = baseLockfile();
  if (base.text === null) {
    // Skipped, and the reason is part of the run: a gate that silently does nothing is the failure this file exists for.
    process.stdout.write(`lockfile downgrade gate: live comparison skipped — ${base.why}\n`);
    return;
  }
  const verdict = lockfileVerdict({
    before: base.text,
    after: read("pnpm-lock.yaml"),
    headRef: process.env.GITHUB_HEAD_REF ?? "",
    allowedText: shipped,
  });
  assert.equal(verdict.message, "", `\n${verdict.message}\n(compared with ${base.why})\n`);
}
