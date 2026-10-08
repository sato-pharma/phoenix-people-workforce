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
// It drives the real hook as a subprocess, exactly as settings.json runs it, and writes the record with
// the real `mergeVerdictRecord`, so the writer's format and the reader cannot drift apart.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

  const fx = makeFixture();
  try {
    // ── No record: allowed at once, silently ─────────────────────────────────────────────────────────
    fx.commit("src/lib/example/rules.ts");
    const fresh = expect(fx, "git push -u origin feat/x", "allow");
    assert.equal(fresh.context, "", "with no record there is nothing to say");
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

    // A FAIL in another stage is reported, not used to block — only the typecheck record blocks.
    const testFailSha = fx.commit("src/lib/example/rules.ts");
    fx.record(testFailSha, { typecheck: "PASS", test: "FAIL" });
    const testFail = expect(fx, "git push origin feat/x", "allow");
    assert.match(testFail.context, /FAIL test/, `a recorded test FAIL must be reported.\n${testFail.context}`);

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
}
