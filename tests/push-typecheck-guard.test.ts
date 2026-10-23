// A `git push` REUSES what remote-check already proved about the pushed commit — and never waits for
// anything.
//
// WHY THIS EXISTS. From 2026-10-04 `.claude/hooks/push-typecheck-guard.mjs` RAN `remote-check typecheck`
// on every push and held the push for up to seven minutes. The 2026-10-08 performance recovery (owner:
// *"the push guard must not start a remote check that blocks a normal push. Previously completed
// verification for the exact commit SHA may be reused, but the PR's required GitHub CI checks must remain
// the authoritative validation gate"*) turned it into a READER of the per-sha verdict record remote-check
// writes (`<git-common-dir>/phx-remote-check/<sha>.json`).
//
// So both halves are pinned:
//   - it NEVER runs the check: the fixture's `scripts/remote-check.mjs` is a stand-in that counts its own
//     runs, and every case asserts the count stays at zero, and that the settings timeout is seconds;
//   - a recorded typecheck FAIL for the EXACT pushed sha still stops the push — and a FAIL recorded for
//     ANY OTHER sha (a parent, a stale record) never does, so an older run cannot speak for this commit.
//
// 🔴 AND THE NEW-TEST-FILE REMINDER IS PINNED AS A NOTE, NEVER A DENY (owner, 2026-10-12: *"make
// remote-check test mandatory before a push that adds a test file"*). A push whose commits add a
// `tests/**.test.ts(x)` file with no recorded `test` PASS for that sha is told the rule, with the files
// and the command — and is ALLOWED. The command it names became `node scripts/check-contracts.mjs` on
// 2026-10-19, when the CI box was retired: GitHub runs only a commit origin already holds, so a pre-push
// suite run no longer exists and the suite is the PR's parallel `unit` jobs. The ruling it respects is also the owner's word: offered a hook that
// REFUSES a push over the suite on 2026-10-04, he answered *"keep the pre-push test as a rule, no
// guard"*. The deny arm stays typecheck-only, and the cases below fail if it ever grows.
//
// 🔴 AND SINCE 2026-10-23 THE REMINDER IS PINNED ON EVERY PUSH (owner, choosing "warn on every push"
// over leaving it narrow and over refusing). A push whose commit has no recorded `check-contracts`
// pass gets one short line; a recorded CLEAN pass for that exact sha silences it; a pass recorded for
// the parent, or one written against a dirty tree, does not. The deny arm is still typecheck-only, and
// the cases below fail if either reminder ever grows into a refusal.
//
// It drives the real hook as a subprocess, exactly as settings.json runs it, and writes both records with
// the real `mergeVerdictRecord` and `writeContractsPass`, so a writer's format and the reader cannot
// drift apart.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { CONTRACTS_DIR_NAME, readContractsPass, writeContractsPass } from "../scripts/lib/check-contracts-record.mjs";
import { VERDICT_DIR_NAME, mergeVerdictRecord } from "../scripts/remote-check-plan.mjs";
import { wiredHookGroups } from "./support/hook-wiring.ts";

const hookPath = resolve(".claude/hooks/push-typecheck-guard.mjs");

type Decision = { decision: "allow" | "deny"; reason: string; context: string; ms: number };

/** A stand-in remote-check that only counts its runs. The hook must never start it. */
const FAKE_REMOTE_CHECK = `
import { appendFileSync } from "node:fs";
if (process.env.FAKE_CALLS_FILE) appendFileSync(process.env.FAKE_CALLS_FILE, "ran\\n");
console.log("remote-check: PASS — 0123456789");
`;

const TSC_LINES = [
  "app/api/example/route.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/lib/example/rules.ts(40,3): error TS2741: Property 'entityType' is missing in type '{}'.",
].join("\n");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

type Fixture = {
  root: string;
  work: string;
  callsFile: string;
  calls: () => number;
  commit: (file: string, text?: string) => string;
  record: (sha: string, stages: Record<string, "PASS" | "FAIL">, excerpt?: string) => void;
  recordRaw: (sha: string, text: string) => void;
  contracts: (sha: string, overrides?: Record<string, unknown>) => void;
};

function makeFixture(): Fixture {
  // A folder with a space in its name, like every checkout on this machine.
  const root = mkdtempSync(join(tmpdir(), "phx push check "));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "init", "--bare", "-q", origin);
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "clone", "-q", origin, work);
  git(work, "checkout", "-q", "-b", "main");
  mkdirSync(join(work, "scripts"), { recursive: true });
  writeFileSync(join(work, "scripts", "remote-check.mjs"), FAKE_REMOTE_CHECK);
  writeFileSync(join(work, "README.md"), "fixture\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "-u", "origin", "main");
  git(work, "checkout", "-q", "-b", "feat/x");
  const verdictDir = join(work, ".git", VERDICT_DIR_NAME);
  const contractsDir = join(work, ".git", CONTRACTS_DIR_NAME);

  const callsFile = join(root, "calls.log");
  writeFileSync(callsFile, "");
  let n = 0;
  return {
    root,
    work,
    callsFile,
    calls: () => readFileSync(callsFile, "utf8").split("\n").filter(Boolean).length,
    commit: (file, text) => {
      const full = join(work, file);
      mkdirSync(dirname(full), { recursive: true });
      appendFileSync(full, text ?? `change ${++n}\n`);
      git(work, "add", "-A");
      git(work, "commit", "-q", "-m", `change ${n}`);
      return git(work, "rev-parse", "HEAD");
    },
    record: (sha, stages, excerpt) => {
      mkdirSync(verdictDir, { recursive: true });
      const next = mergeVerdictRecord(null, { sha, stages, source: "the box", at: "2026-10-08T12:00:00.000Z", excerpt });
      writeFileSync(join(verdictDir, `${sha}.json`), JSON.stringify(next));
    },
    recordRaw: (sha, text) => {
      mkdirSync(verdictDir, { recursive: true });
      writeFileSync(join(verdictDir, `${sha}.json`), text);
    },
    contracts: (sha, overrides) => {
      mkdirSync(contractsDir, { recursive: true });
      const record = { sha, clean: true, gates: 16, seconds: 8.1, at: "2026-10-23T15:00:00.000Z", ...(overrides ?? {}) };
      writeFileSync(join(contractsDir, `${sha}.json`), JSON.stringify(record));
    },
  };
}

function runHook(fx: Fixture, command: string, opts: { tool?: string; cwd?: string; env?: Record<string, string> } = {}): Decision {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PHX_PUSH_CHECK_OFF;
  env.FAKE_CALLS_FILE = fx.callsFile;
  Object.assign(env, opts.env ?? {});
  const cwd = opts.cwd ?? fx.work;
  const started = Date.now();
  const raw = execFileSync(process.execPath, [hookPath], {
    cwd,
    input: JSON.stringify({ tool_name: opts.tool ?? "Bash", cwd, tool_input: { command } }),
    encoding: "utf8",
    env: env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 20000,
  });
  const ms = Date.now() - started;
  assert.equal(fx.calls(), 0, `the hook must NEVER start remote-check — it ran for:\n${command}`);
  if (!raw.trim()) return { decision: "allow", reason: "", context: "", ms };
  const out = JSON.parse(raw).hookSpecificOutput;
  return {
    decision: out.permissionDecision === "deny" ? "deny" : "allow",
    reason: String(out.permissionDecisionReason ?? ""),
    context: String(out.additionalContext ?? ""),
    ms,
  };
}

function expect(fx: Fixture, command: string, decision: "allow" | "deny", opts: Parameters<typeof runHook>[2] = {}) {
  const result = runHook(fx, command, opts);
  assert.equal(result.decision, decision, `expected ${decision} for:\n${command}\n${result.reason}${result.context}`);
  return result;
}

export function runPushTypecheckGuardTests() {
  assert.ok(existsSync(hookPath), `the hook is not at ${hookPath}`);

  // ── Wired, and with a timeout of SECONDS: it reads a file, it never waits ───────────────────────────
  const wired = wiredHookGroups("PreToolUse").find((entry) =>
    (entry.hooks ?? []).some((h) => String(h.command ?? "").includes("push-typecheck-guard.mjs")),
  );
  assert.ok(wired, "push-typecheck-guard.mjs must be registered under PreToolUse (settings.json or the dispatch table)");
  assert.match(String(wired.matcher), /Bash/, "it must watch the Bash tool");
  assert.match(String(wired.matcher), /PowerShell/, "it must watch the PowerShell tool — sessions push from both");
  const hookEntry = (wired.hooks ?? []).find((h) => String(h.command ?? "").includes("push-typecheck-guard.mjs"));
  assert.ok(
    Number(hookEntry?.timeout) > 0 && Number(hookEntry?.timeout) <= 15,
    `the push guard only reads a record, so its settings timeout must be seconds, not minutes; got ${hookEntry?.timeout}`,
  );
  const hookSource = readFileSync(hookPath, "utf8");
  assert.doesNotMatch(hookSource, /\bspawn(?:Sync)?\(/, "the push guard must not start any process except `git` (execFileSync)");
  assert.doesNotMatch(hookSource, /remote-check\.mjs['"`]\s*,/, "the push guard must not run remote-check");
  const declared = /const VERDICT_DIR_NAME = '([^']+)'/.exec(hookSource)?.[1];
  assert.equal(declared, VERDICT_DIR_NAME, "the hook must read the directory remote-check writes (remote-check-plan.mjs VERDICT_DIR_NAME)");
  const declaredContracts = /const CONTRACTS_DIR_NAME = '([^']+)'/.exec(hookSource)?.[1];
  assert.equal(
    declaredContracts,
    CONTRACTS_DIR_NAME,
    "the hook must read the directory check-contracts writes (check-contracts-record.mjs CONTRACTS_DIR_NAME)",
  );

  const fx = makeFixture();
  try {
    // ── No record: allowed at once, silently ─────────────────────────────────────────────────────────
    fx.commit("src/lib/example/rules.ts");
    const fresh = expect(fx, "git push -u origin feat/x", "allow");
    assert.match(fresh.context, /BEFORE THIS PUSH/, `with nothing recorded, the contracts reminder is what it says.\n${fresh.context}`);
    assert.doesNotMatch(fresh.context, /remote-check already has a verdict/, "there is no verdict to reuse");
    assert.doesNotMatch(fresh.context, /THE RULE/, "and no test file was added");
    assert.ok(fresh.ms < 10000, `an unrecorded push must not wait — it took ${fresh.ms}ms`);

    // ── A recorded typecheck FAIL for THIS sha stops the push, with tsc's own lines ──────────────────
    const failedSha = fx.commit("src/lib/example/rules.ts");
    fx.record(failedSha, { lint: "PASS", typecheck: "FAIL" }, TSC_LINES);
    const failed = expect(fx, "git push -u origin feat/x", "deny");
    assert.match(failed.reason, /PUSH REFUSED/, `the deny must say the push is refused.\n${failed.reason}`);
    assert.match(failed.reason, new RegExp(failedSha.slice(0, 9)), "the deny must name the commit the record is about");
    assert.match(failed.reason, /TS2322/, `the deny must carry the type errors.\n${failed.reason}`);
    assert.match(failed.reason, /TS2741/, `the deny must carry EVERY error.\n${failed.reason}`);
    for (const tool of ["Bash", "PowerShell"]) {
      const denied = runHook(fx, "git push -u origin feat/x", { tool });
      assert.equal(denied.decision, "deny", `${tool}: still a recorded FAIL`);
      const advice = /^ {2}(\$env:PHX_PUSH_CHECK_OFF=1; .+|PHX_PUSH_CHECK_OFF=1 .+)$/m.exec(denied.reason)?.[1];
      assert.ok(advice, `${tool}: the deny must put the stand-down on a line of its own.\n${denied.reason}`);
      assert.equal(advice.startsWith("$env:"), tool === "PowerShell", `the stand-down must match the tool's dialect: ${advice}`);
    }
    expect(fx, "PHX_PUSH_CHECK_OFF=1 git push -u origin feat/x", "allow");
    expect(fx, "$env:PHX_PUSH_CHECK_OFF=1; git push -u origin feat/x", "allow", { tool: "PowerShell" });
    expect(fx, "git push -u origin feat/x", "allow", { env: { PHX_PUSH_CHECK_OFF: "1" } });

    // Every spelling of a push of the checked-out commit is read against the record.
    const sendsHead: Array<{ command: string; tool?: string; cwd?: string }> = [
      { command: "git push" },
      { command: "git push origin HEAD" },
      { command: "git push --force-with-lease origin feat/x" },
      { command: "git push origin HEAD:refs/heads/feat/x" },
      { command: "git push origin feat/x 2>&1 | tail -5" },
      { command: "git.exe push origin HEAD", tool: "PowerShell" },
      { command: 'bash -c "git push origin HEAD"' },
      { command: `cd "${fx.work}" && git push -u origin feat/x`, cwd: fx.root },
      { command: `git -C "${fx.work}" push origin feat/x`, cwd: fx.root },
    ];
    for (const { command, tool, cwd } of sendsHead) expect(fx, command, "deny", { tool, cwd });

    // ── NO STALE VERDICTS: a FAIL recorded for any other sha never speaks for this one ───────────────
    const fixedSha = fx.commit("src/lib/example/rules.ts"); // the parent still carries its FAIL record
    expect(fx, "git push -u origin feat/x", "allow");
    // A record file named for this sha but ABOUT another one is ignored too.
    fx.recordRaw(fixedSha, JSON.stringify({ sha: failedSha, stages: { typecheck: { verdict: "FAIL" } } }));
    expect(fx, "git push -u origin feat/x", "allow");
    // Malformed records are no record.
    for (const junk of ["", "{", "null", '{"sha":"x"}', JSON.stringify({ sha: fixedSha, stages: null })]) {
      fx.recordRaw(fixedSha, junk);
      expect(fx, "git push -u origin feat/x", "allow");
    }

    // ── A recorded PASS is reused and said, nothing re-run ───────────────────────────────────────────
    const passedSha = fx.commit("src/lib/example/rules.ts");
    fx.record(passedSha, { lint: "PASS", typecheck: "PASS", test: "PASS" });
    const passed = expect(fx, "git push origin feat/x", "allow");
    assert.match(passed.context, /PASS lint, typecheck, test/, `a recorded pass must be reported.\n${passed.context}`);
    assert.match(passed.context, new RegExp(passedSha.slice(0, 9)), "a pass must name the commit it proved");
    assert.match(passed.context, /merge gate/, "it must say the PR's checks are still the gate");

    // A FAIL in another stage is reported, not used to block — only the typecheck record blocks. A push
    // that adds no test file hears nothing about the suite beyond that line (the reminder has its own
    // fixture below), because the rule the owner made mandatory is about a push that ADDS one.
    const testFailSha = fx.commit("src/lib/example/rules.ts");
    fx.record(testFailSha, { typecheck: "PASS", test: "FAIL" });
    const testFail = expect(fx, "git push origin feat/x", "allow");
    assert.match(testFail.context, /FAIL test/, `a recorded test FAIL must be reported.\n${testFail.context}`);
    assert.doesNotMatch(testFail.context, /THE RULE/, `no new test file, so no reminder.\n${testFail.context}`);

    // ── A push chained after a HEAD-moving command sends a commit the hook cannot see: allowed ───────
    const chainSha = fx.commit("src/lib/example/rules.ts");
    fx.record(chainSha, { typecheck: "FAIL" }, TSC_LINES);
    for (const chained of [
      'git add -A && git commit -m "fix: types" && git push -u origin feat/x',
      "git rebase origin/main && git push origin feat/x",
      "git reset --soft HEAD~1; git push origin feat/x",
    ]) {
      expect(fx, chained, "allow");
    }

    // ── Pushes that are none of its business ────────────────────────────────────────────────────────
    const heredocPush = ["cat > note.md <<'EOF'", "To ship: git push origin HEAD", "EOF"].join("\n");
    for (const { command, tool } of [
      { command: "git push --dry-run origin feat/x" },
      { command: "git push --delete origin old-branch" },
      { command: "git push origin :old-branch" },
      { command: "git push origin --tags" },
      { command: "git push --all origin" },
      { command: "git push origin some-other-branch" },
      { command: "git push origin HEAD:refs/backups/feat-x" },
      { command: "git status" },
      { command: 'echo "git push origin HEAD"' },
      { command: heredocPush },
      { command: "node scripts/remote-check.mjs typecheck" },
      { command: "git push origin HEAD", tool: "Read" },
    ] as Array<{ command: string; tool?: string }>) {
      expect(fx, command, "allow", { tool });
    }

    // ── Nothing new to send: origin already holds this commit ────────────────────────────────────────
    git(fx.work, "push", "-q", "origin", "feat/x");
    expect(fx, "git push origin feat/x", "allow");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }

  runNewTestFileReminderTests();
  runContractsReminderTests();
}

/**
 * The 2026-10-12 rule, in its own fixture because an unpushed branch's whole history is new to the
 * remote — so one added test file would otherwise ride along in every later case.
 */
function runNewTestFileReminderTests() {
  const fx = makeFixture();
  try {
    // ── A push that adds no test file says nothing about the suite ───────────────────────────────────
    fx.commit("src/lib/example/rules.ts");
    const plain = expect(fx, "git push -u origin feat/x", "allow");
    assert.doesNotMatch(plain.context, /THE RULE/, `a push adding no test file gets no test-file rule.\n${plain.context}`);
    assert.match(plain.context, /BEFORE THIS PUSH/, `but it does get the contracts line.\n${plain.context}`);
    assert.match(plain.context, /node scripts\/check-contracts\.mjs/, "which names the command");
    assert.match(plain.context, /note, not a gate/, "and says plainly that it does not refuse");

    // ── A push that ADDS one is told the rule — and is ALLOWED, because a guard over the suite is
    //    the one thing the owner ruled out (2026-10-04, "keep the pre-push test as a rule, no guard") ─
    const addedSha = fx.commit("tests/door-caps.test.ts");
    const reminded = expect(fx, "git push -u origin feat/x", "allow");
    assert.match(reminded.context, /THE RULE \(owner, 2026-10-12;/, `the rule must be said.\n${reminded.context}`);
    assert.match(reminded.context, /node scripts\/check-contracts\.mjs/, "it must name the command to run");
    assert.match(reminded.context, /parallel `unit` jobs/, "it must say where the suite itself runs now that the CI box is retired");
    assert.doesNotMatch(reminded.context, /remote-check\.mjs test|CI box answers/, "it must not send a session to a pre-push suite run GitHub cannot do");
    assert.match(reminded.context, /tests\/door-caps\.test\.ts/, "it must name the test file that was added");
    assert.match(reminded.context, /adds 1 test file\b/, `one file reads in the singular.\n${reminded.context}`);
    assert.match(reminded.context, /no `test` verdict is recorded/, "it must say why it is reminding");
    assert.match(reminded.context, new RegExp(addedSha.slice(0, 9)), "it must name the sha the verdict must be about");
    assert.doesNotMatch(reminded.context, /BEFORE THIS PUSH/, `the short line must not repeat the same command.\n${reminded.context}`);
    // Every spelling of that push reminds, and NONE of them refuses.
    for (const command of ["git push", "git push origin HEAD", "git push --force-with-lease origin feat/x"]) {
      const spelled = expect(fx, command, "allow");
      assert.match(spelled.context, /THE RULE/, `the reminder must not depend on the spelling: ${command}`);
    }

    // ── A recorded `test` PASS for this exact sha IS the rule satisfied: no reminder ─────────────────
    fx.record(addedSha, { test: "PASS" });
    const satisfied = expect(fx, "git push -u origin feat/x", "allow");
    assert.match(satisfied.context, /PASS test/, `the reused verdict must still be reported.\n${satisfied.context}`);
    assert.doesNotMatch(satisfied.context, /THE RULE/, `a test PASS must silence the reminder.\n${satisfied.context}`);

    // A PASS recorded for the PARENT never satisfies this commit — the record is per sha, always.
    const secondSha = fx.commit("tests/fold-name.test.ts");
    const stale = expect(fx, "git push -u origin feat/x", "allow");
    assert.match(stale.context, /THE RULE/, `a parent's PASS cannot speak for this commit.\n${stale.context}`);
    assert.match(stale.context, /adds 2 test files/, `both unpushed added files count.\n${stale.context}`);

    // ── A recorded `test` FAIL is named as what it is, and still does not refuse ─────────────────────
    fx.record(secondSha, { test: "FAIL" });
    const failed = expect(fx, "git push -u origin feat/x", "allow");
    assert.match(failed.context, /the record holds `test` FAIL/, `a FAIL must be named.\n${failed.context}`);
    assert.match(failed.context, /THE RULE/, "a FAIL is the rule unmet, so the reminder stands");

    // ── A recorded typecheck FAIL still wins: the deny arm is unchanged by the reminder ──────────────
    fx.record(secondSha, { typecheck: "FAIL", test: "FAIL" }, TSC_LINES);
    const denied = expect(fx, "git push -u origin feat/x", "deny");
    assert.match(denied.reason, /PUSH REFUSED/, "a recorded typecheck FAIL is still a deny");
    assert.match(denied.reason, /TS2322/, "and still carries tsc's lines");

    // ── Once the branch is pushed, only what is NEW to the remote counts ─────────────────────────────
    git(fx.work, "push", "-q", "-u", "origin", "feat/x");
    fx.commit("tests/fold-name.test.ts"); // a MODIFIED test file is not an added one
    const modified = expect(fx, "git push origin feat/x", "allow");
    assert.doesNotMatch(modified.context, /THE RULE/, `editing an existing test file is not adding one.\n${modified.context}`);
    assert.match(modified.context, /BEFORE THIS PUSH/, "the contracts line still applies to every push");
    fx.commit("src/lib/example/rules.ts");
    const after = expect(fx, "git push origin feat/x", "allow");
    assert.doesNotMatch(after.context, /THE RULE/, `and neither is a push with no test file at all.\n${after.context}`);
    // A new test file after the branch is known to the remote still reminds.
    fx.commit("tests/venue-picker.test.tsx"); // .tsx counts too
    const tsx = expect(fx, "git push origin feat/x", "allow");
    assert.match(tsx.context, /tests\/venue-picker\.test\.tsx/, `a .tsx test file counts.\n${tsx.context}`);
    assert.match(tsx.context, /adds 1 test file\b/, `only what is new to the remote counts.\n${tsx.context}`);

    // ── A file that merely LOOKS like a test is not one ──────────────────────────────────────────────
    git(fx.work, "push", "-q", "origin", "feat/x");
    for (const near of ["tests/support/comment-strip.ts", "src/lib/example/rules.test.helper.ts", "docs/tests.md"]) {
      fx.commit(near);
      const quiet = expect(fx, "git push origin feat/x", "allow");
      assert.doesNotMatch(quiet.context, /THE RULE/, `${near} is not a test file of this repo.\n${quiet.context}`);
      git(fx.work, "push", "-q", "origin", "feat/x");
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}
/**
 * The 2026-10-23 widening, in its own fixture: EVERY push is reminded about `check-contracts` unless
 * this exact commit has a recorded clean pass. It is a note on every path below — the owner chose
 * "warn on every push" over refusing, and his 2026-10-04 ruling against a guard over the suite stands.
 */
function runContractsReminderTests() {
  const fx = makeFixture();
  try {
    const sha = fx.commit("src/lib/example/rules.ts");

    // ── Nothing recorded: the line, naming the command and this commit ───────────────────────────────
    const reminded = expect(fx, "git push -u origin feat/x", "allow");
    assert.match(reminded.context, /BEFORE THIS PUSH/, `an unproved commit is reminded.\n${reminded.context}`);
    assert.match(reminded.context, new RegExp(sha.slice(0, 9)), "the line names the commit nothing is recorded for");
    assert.match(reminded.context, /8 seconds/, "and says what it costs");
    assert.match(reminded.context, /PHX_PUSH_CHECK_OFF=1/, "and how to silence it for one push");
    assert.ok(reminded.ms < 10000, `a reminded push must not wait — it took ${reminded.ms}ms`);

    // The stand-down the line itself offers must work, in both dialects.
    const stoodDown = expect(fx, "git push -u origin feat/x", "allow", { env: { PHX_PUSH_CHECK_OFF: "1" } });
    assert.equal(stoodDown.context, "", `the stand-down must silence it completely.\n${stoodDown.context}`);
    const inline = expect(fx, "PHX_PUSH_CHECK_OFF=1 git push -u origin feat/x", "allow");
    assert.equal(inline.context, "", `and so must the inline spelling.\n${inline.context}`);
    const ps = expect(fx, "$env:PHX_PUSH_CHECK_OFF=1; git push -u origin feat/x", "allow", { tool: "PowerShell" });
    assert.equal(ps.context, "", `and the PowerShell spelling.\n${ps.context}`);
    assert.match(
      expect(fx, "git push -u origin feat/x", "allow", { tool: "PowerShell" }).context,
      /[$]env:PHX_PUSH_CHECK_OFF=1;/,
      "the stand-down it offers is in the dialect that asked",
    );

    // ── A recorded CLEAN pass for this exact sha silences it, with nothing else to say ───────────────
    fx.contracts(sha);
    const quiet = expect(fx, "git push -u origin feat/x", "allow");
    assert.equal(quiet.context, "", `a recorded clean pass is the reminder satisfied.\n${quiet.context}`);

    // ── A pass recorded for the PARENT never speaks for this commit ──────────────────────────────────
    const second = fx.commit("src/lib/example/rules.ts");
    const moved = expect(fx, "git push -u origin feat/x", "allow");
    assert.match(moved.context, /BEFORE THIS PUSH/, `the parent's pass cannot speak for this one.\n${moved.context}`);
    assert.match(moved.context, new RegExp(second.slice(0, 9)), "and the line names the new commit");

    // ── A pass recorded against a DIRTY tree is not a pass for the commit ────────────────────────────
    fx.contracts(second, { clean: false });
    assert.match(
      expect(fx, "git push -u origin feat/x", "allow").context,
      /BEFORE THIS PUSH/,
      "a record written against a dirty tree proves nothing about the commit",
    );
    // ── Neither is a record naming a different sha, or an unreadable one ─────────────────────────────
    fx.contracts(second, { sha: "0".repeat(40) });
    assert.match(expect(fx, "git push -u origin feat/x", "allow").context, /BEFORE THIS PUSH/, "a record must name this sha");
    mkdirSync(join(fx.work, ".git", CONTRACTS_DIR_NAME), { recursive: true });
    writeFileSync(join(fx.work, ".git", CONTRACTS_DIR_NAME, `${second}.json`), "{ not json");
    assert.match(expect(fx, "git push -u origin feat/x", "allow").context, /BEFORE THIS PUSH/, "a malformed record reminds, never throws");

    // ── A recorded typecheck FAIL still refuses, and the widening did not add a second deny arm ──────
    fx.record(second, { typecheck: "FAIL" }, TSC_LINES);
    const denied = expect(fx, "git push -u origin feat/x", "deny");
    assert.match(denied.reason, /PUSH REFUSED/, "the deny arm is unchanged");
    assert.doesNotMatch(denied.reason, /BEFORE THIS PUSH/, "and the contracts line is never a refusal");

    // ── The record the real writer produces is the record the hook reads ─────────────────────────────
    // Pinned against `scripts/lib/check-contracts-record.mjs` itself, so the two cannot drift apart.
    const third = fx.commit("src/lib/example/rules.ts");
    writeFileSync(join(fx.work, "untracked.txt"), "an untracked file is not a dirty tree\n");
    const written = writeContractsPass(fx.work, { gates: 16, seconds: 8.2 });
    assert.ok(written, "a clean checkout must record, and an untracked file must not stop it");
    assert.equal(written?.sha, third, "the record is about HEAD");
    assert.deepEqual(readContractsPass(fx.work, third)?.sha, third, "and reads back for that sha");
    assert.equal(expect(fx, "git push -u origin feat/x", "allow").context, "", "so the hook goes quiet");

    // A tracked edit IS a dirty tree: nothing is recorded, and what HEAD held is cleared.
    appendFileSync(join(fx.work, "src/lib/example/rules.ts"), "// edited after the gates ran\n");
    assert.equal(writeContractsPass(fx.work, { gates: 16, seconds: 8.2 }), null, "a dirty tree records nothing");
    assert.equal(readContractsPass(fx.work, third), null, "and the earlier pass is cleared, not left standing");
    assert.match(
      expect(fx, "git push -u origin feat/x", "allow").context,
      /BEFORE THIS PUSH/,
      "so the push is reminded again",
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}
