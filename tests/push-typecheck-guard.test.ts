// A `git push` must be preceded by a typecheck on the CI box, and only a typecheck that FAILED may stop it.
//
// WHY THIS EXISTS. `buggy_code` is the top friction category in the owner's usage report: a type error
// found by the PR's `checks` job costs a full CI round (~14 billable minutes, twice with the `main` run)
// and the fix costs another. A local `tsc` does not fit this 16 GB laptop (bash-guard C8 refuses it), but
// `node scripts/remote-check.mjs typecheck` does — it runs on the preview box in ~2 minutes. The owner
// asked for it to be the push's own first step (2026-10-04), so a session cannot forget it.
// `.claude/hooks/push-typecheck-guard.mjs` is that step.
//
// Both halves are pinned, and the ALLOW half decides whether this survives. A guard that held up a docs
// push, a delete, a dry run, the same commit twice or a push the box could not check would be switched off
// within the day — and then every type error is back to being found by CI. A guard that let a FAILED
// typecheck through, or let a chained `git commit && git push` through unchecked, would defeat the point.
//
// It drives the real hook as a subprocess, exactly as settings.json runs it, against a throwaway repository
// whose `scripts/remote-check.mjs` is a stand-in that prints what the real one prints (the banner lines the
// hook reads) and counts its own runs. A test that imported the matcher would pass against a hook wired to
// nothing, and a test that ran the real script would need the box.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const hookPath = resolve(".claude/hooks/push-typecheck-guard.mjs");
const settingsPath = resolve(".claude/settings.json");

type Decision = { decision: "allow" | "deny"; reason: string; context: string };

/** What the real remote-check prints for each outcome, minus the SSH. The hook reads these banner lines. */
const FAKE_REMOTE_CHECK = `
import { appendFileSync } from "node:fs";
if (process.env.FAKE_CALLS_FILE) appendFileSync(process.env.FAKE_CALLS_FILE, "ran\\n");
const verdict = process.env.FAKE_VERDICT || "pass";
const sha = "0123456789abcdef";
console.log("remote-check: typecheck  on phx@box");
if (verdict === "hang") await new Promise((done) => setTimeout(done, 60000));
if (verdict === "unreachable") { console.error("remote-check: could not push to the box. Check SSH."); process.exit(2); }
if (verdict === "install-failed") { console.log("install failed"); console.log("remote-check: FAIL — " + sha); process.exit(1); }
console.log("");
console.log("=== typecheck ===");
if (verdict === "fail") {
  console.log("app/api/example/route.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.");
  console.log("src/lib/example/rules.ts(40,3): error TS2741: Property 'entityType' is missing in type '{}'.");
  console.log("--- typecheck FAIL in 97s ---");
  console.log("");
  console.log("remote-check: FAIL — " + sha);
  process.exit(1);
}
if (verdict === "no-verdict") {
  console.log("remote-check: NO VERDICT — the box's tree changed during the run; nothing above is about " + sha);
  process.exit(3);
}
console.log("--- typecheck PASS in 96s ---");
console.log("");
console.log("remote-check: PASS — " + sha);
`;

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
};

/** A repo with an `origin`, `main` pushed, and the fake script committed — on a branch of its own. */
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
  };
}

function runHook(
  fx: Fixture,
  command: string,
  opts: { tool?: string; cwd?: string; verdict?: string; env?: Record<string, string> } = {},
): Decision {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PHX_PUSH_CHECK_OFF;
  env.FAKE_CALLS_FILE = fx.callsFile;
  env.FAKE_VERDICT = opts.verdict ?? "pass";
  Object.assign(env, opts.env ?? {});
  const cwd = opts.cwd ?? fx.work;
  const raw = execFileSync(process.execPath, [hookPath], {
    cwd,
    input: JSON.stringify({ tool_name: opts.tool ?? "Bash", cwd, tool_input: { command } }),
    encoding: "utf8",
    env: env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
  });
  if (!raw.trim()) return { decision: "allow", reason: "", context: "" };
  const out = JSON.parse(raw).hookSpecificOutput;
  return {
    decision: out.permissionDecision === "deny" ? "deny" : "allow",
    reason: String(out.permissionDecisionReason ?? ""),
    context: String(out.additionalContext ?? ""),
  };
}

/** Asserts the hook ran the remote check (calls went up by one) and answered `decision`. */
function expectRun(fx: Fixture, command: string, decision: "allow" | "deny", opts: Parameters<typeof runHook>[2] = {}) {
  const before = fx.calls();
  const result = runHook(fx, command, opts);
  assert.equal(fx.calls(), before + 1, `the remote typecheck must RUN for:\n${command}\n${result.reason}${result.context}`);
  assert.equal(result.decision, decision, `expected ${decision} for:\n${command}\n${result.reason}${result.context}`);
  return result;
}

/** Asserts the hook never touched the box and let the command through. */
function expectNoRun(fx: Fixture, command: string, opts: Parameters<typeof runHook>[2] = {}) {
  const before = fx.calls();
  const result = runHook(fx, command, opts);
  assert.equal(fx.calls(), before, `the remote typecheck must NOT run for:\n${command}`);
  assert.equal(result.decision, "allow", `this must be allowed untouched:\n${command}\n${result.reason}`);
  return result;
}

export function runPushTypecheckGuardTests() {
  assert.ok(existsSync(hookPath), `the hook is not at ${hookPath}`);

  // ── Wired in settings.json, with a timeout that outlasts the hook's own wait ────────────────────────────
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const wired = (settings.hooks?.PreToolUse ?? []).find((entry: { hooks?: Array<{ command?: string }> }) =>
    (entry.hooks ?? []).some((h) => String(h.command ?? "").includes("push-typecheck-guard.mjs")),
  );
  assert.ok(wired, "push-typecheck-guard.mjs must be registered under PreToolUse in .claude/settings.json");
  assert.match(String(wired.matcher), /Bash/, "it must watch the Bash tool");
  assert.match(String(wired.matcher), /PowerShell/, "it must watch the PowerShell tool — sessions push from both");
  const hookEntry = wired.hooks.find((h: { command?: string }) => String(h.command ?? "").includes("push-typecheck-guard.mjs"));
  const hookSource = readFileSync(hookPath, "utf8");
  assert.match(hookSource, /7 \* 60 \* 1000/, "the hook's own wait is 7 minutes — if you change it, change the settings timeout with it");
  assert.ok(
    Number(hookEntry.timeout) >= 480,
    `settings.json must give the hook a timeout past its own 7-minute wait (>= 480s) or Claude kills it mid-check; got ${hookEntry.timeout}`,
  );

  const fx = makeFixture();
  try {
    // ── A FAILED typecheck stops the push, and says what failed and how to go on ────────────────────────
    fx.commit("src/lib/example/rules.ts");
    const failed = expectRun(fx, "git push -u origin feat/x", "deny", { verdict: "fail" });
    assert.match(failed.reason, /PUSH REFUSED/, `the deny must say the push is refused.\n${failed.reason}`);
    assert.match(failed.reason, /FAILED/, `the deny must say the typecheck failed.\n${failed.reason}`);
    assert.match(failed.reason, /TS2322/, `the deny must carry the type error tsc printed, not just a verdict.\n${failed.reason}`);
    assert.match(failed.reason, /TS2741/, `the deny must carry EVERY error, not only the first.\n${failed.reason}`);
    assert.doesNotMatch(failed.reason, /--- typecheck FAIL/, "the banner lines are plumbing, not the error list");

    // The stand-down it hands back must itself be allowed, in the dialect of the tool that asked.
    for (const tool of ["Bash", "PowerShell"]) {
      const denied = runHook(fx, "git push -u origin feat/x", { tool, verdict: "fail" });
      assert.equal(denied.decision, "deny", `${tool}: still a failed typecheck`);
      const advice = /^ {2}(\$env:PHX_PUSH_CHECK_OFF=1; .+|PHX_PUSH_CHECK_OFF=1 .+)$/m.exec(denied.reason)?.[1];
      assert.ok(advice, `${tool}: the deny must put the stand-down on a line of its own.\n${denied.reason}`);
      assert.equal(advice.startsWith("$env:"), tool === "PowerShell", `the stand-down must match the tool's dialect: ${advice}`);
    }
    expectNoRun(fx, "PHX_PUSH_CHECK_OFF=1 git push -u origin feat/x", { verdict: "fail" });
    expectNoRun(fx, "$env:PHX_PUSH_CHECK_OFF=1; git push -u origin feat/x", { tool: "PowerShell", verdict: "fail" });
    expectNoRun(fx, "git push -u origin feat/x", { verdict: "fail", env: { PHX_PUSH_CHECK_OFF: "1" } });

    // ── A PASS lets it through, is remembered per commit, and a different commit is checked again ───────
    const passedSha = fx.commit("src/lib/example/rules.ts");
    const passed = expectRun(fx, "git push origin feat/x", "allow", { verdict: "pass" });
    assert.match(passed.context, /PASSED/, `a pass must be reported.\n${passed.context}`);
    assert.match(passed.context, new RegExp(passedSha.slice(0, 9)), "a pass must name the commit it proved");
    expectNoRun(fx, "git push origin feat/x", { verdict: "fail" }); // same commit: remembered, so the failing box is never asked
    fx.commit("src/lib/example/rules.ts");
    expectRun(fx, "git push origin feat/x", "deny", { verdict: "fail" }); // a new commit is a new question

    // ── Every spelling of a push of the checked-out commit runs the check ───────────────────────────────
    const sendsHead: Array<{ command: string; tool?: string; cwd?: string }> = [
      { command: "git push" },
      { command: "git push origin" },
      { command: "git push origin HEAD" },
      { command: "git push -u origin HEAD" },
      { command: "git push --set-upstream origin feat/x" },
      { command: "git push --force-with-lease origin feat/x" },
      { command: "git push --force-with-lease=feat/x:0123456 origin feat/x" },
      { command: "git push origin +feat/x" },
      { command: "git push origin HEAD:refs/heads/feat/x" },
      { command: "git push origin feat/x:feat/x" },
      { command: "git push --no-verify origin feat/x" },
      { command: "git push -o ci.skip origin feat/x" },
      { command: "git push origin feat/x 2>&1 | tail -5" },
      { command: "git push origin feat/x 2>&1", tool: "PowerShell" },
      { command: "git.exe push origin HEAD", tool: "PowerShell" },
      { command: 'bash -c "git push origin HEAD"' },
      { command: "FOO=1 git push origin HEAD" },
      { command: "PHX_SECRETS_OK=1 git push origin HEAD" },
      { command: "$env:PHX_SECRETS_OK=1; git push origin HEAD", tool: "PowerShell" },
      { command: "echo pushing; git push origin HEAD" },
      // From a folder that is not the repository: `cd` and `-C` say where the push really happens.
      { command: `cd "${fx.work}" && git push -u origin feat/x`, cwd: fx.root },
      { command: `git -C "${fx.work}" push origin feat/x`, cwd: fx.root },
      { command: `Set-Location "${fx.work}"; git push origin HEAD`, tool: "PowerShell", cwd: fx.root },
    ];
    for (const { command, tool, cwd } of sendsHead) {
      fx.commit("src/lib/example/rules.ts"); // a fresh commit each time, so the cache and the up-to-date skip never answer
      expectRun(fx, command, "deny", { verdict: "fail", tool, cwd });
    }

    // ── A chained commit-then-push cannot be checked, so it is refused with the way out ─────────────────
    {
      const before = fx.calls();
      const chained = runHook(fx, 'git add -A && git commit -m "feat: x" && git push -u origin feat/x', { verdict: "fail" });
      assert.equal(chained.decision, "deny", "a push chained after a commit must be refused");
      assert.match(chained.reason, /git commit/, `the deny must name the HEAD-moving command.\n${chained.reason}`);
      assert.match(chained.reason, /command of its own/, `the deny must say what to do instead.\n${chained.reason}`);
      assert.match(chained.reason, /before the whole command/, `the deny must say WHY it cannot check.\n${chained.reason}`);
      assert.equal(fx.calls(), before, "a chained push must be refused WITHOUT running the check on a stale HEAD");
      for (const hop of ["git merge origin/main", "git rebase origin/main", "git pull --rebase", "git cherry-pick abc1234", "git reset --soft HEAD~1", "git checkout feat/x", "git switch feat/x"]) {
        assert.equal(
          runHook(fx, `${hop} && git push origin feat/x`, { verdict: "fail" }).decision,
          "deny",
          `a push chained after \`${hop}\` must be refused`,
        );
      }
      assert.equal(
        runHook(fx, "git commit -m x; git push", { tool: "PowerShell", verdict: "fail" }).decision,
        "deny",
        "the PowerShell separator chains too",
      );
      // The way out the deny names must work.
      expectNoRun(fx, 'PHX_PUSH_CHECK_OFF=1 git commit -m x && git push origin feat/x', { verdict: "fail" });
    }

    // ── Pushes that are none of its business are never held up ──────────────────────────────────────────
    fx.commit("src/lib/example/rules.ts");
    const heredocPush = ["cat > note.md <<'EOF'", "To ship: git push origin HEAD", "EOF"].join("\n");
    const hereStringCommit = ["$msg = @'", "docs: never `git push` before the check", "'@", "git commit -m $msg"].join("\n");
    const notAPushOfThisCommit: Array<{ command: string; tool?: string }> = [
      { command: "git push --dry-run origin feat/x" },
      { command: "git push -n origin feat/x" },
      { command: "git push --delete origin old-branch" },
      { command: "git push -d origin old-branch" },
      { command: "git push origin :old-branch" },
      { command: "git push origin --tags" },
      { command: "git push --all origin" },
      { command: "git push --mirror backup" },
      { command: "git push origin some-other-branch" },
      { command: "git push origin refs/heads/some-other-branch:refs/heads/some-other-branch" },
      { command: "git push origin HEAD:refs/backups/feat-x" },
      { command: "git push --help" },
      { command: "git status" },
      { command: "git log --oneline -5" },
      { command: 'git commit -m "docs: say git push origin HEAD runs the check"' },
      { command: 'echo "git push origin HEAD"' },
      { command: "gh pr create --fill" },
      { command: "git fetch origin && git status" },
      { command: heredocPush },
      { command: hereStringCommit, tool: "PowerShell" },
      { command: "node scripts/remote-check.mjs typecheck" },
    ];
    for (const { command, tool } of notAPushOfThisCommit) {
      expectNoRun(fx, command, { verdict: "fail", tool });
    }
    // Other tools are none of this hook's business.
    expectNoRun(fx, "git push origin HEAD", { verdict: "fail", tool: "Read" });

    // ── Nothing new to send: origin already holds this commit ───────────────────────────────────────────
    fx.commit("src/lib/example/rules.ts");
    git(fx.work, "push", "-q", "origin", "feat/x");
    expectNoRun(fx, "git push origin feat/x", { verdict: "fail" });

    // ── A push that changes nothing a typechecker reads is not made to wait ─────────────────────────────
    git(fx.work, "checkout", "-q", "-b", "docs-only", "main");
    fx.commit("docs/guide.md");
    fx.commit("supabase/migrations/20261004000000_example.sql");
    fx.commit("xlsx/report.xlsx");
    expectNoRun(fx, "git push -u origin docs-only", { verdict: "fail" });
    // …and the same holds for a chained commit of docs only: nothing to split for.
    writeFileSync(join(fx.work, "docs", "guide.md"), "more words\n");
    assert.equal(
      runHook(fx, 'git add -A && git commit -m "docs: more" && git push origin docs-only', { verdict: "fail" }).decision,
      "allow",
      "a chained docs-only commit must not be held up",
    );
    git(fx.work, "checkout", "-q", "--", ".");
    // One file a typechecker reads turns it back on.
    fx.commit("src/lib/example/rules.ts");
    expectRun(fx, "git push -u origin docs-only", "deny", { verdict: "fail" });
    // A staged, uncommitted TypeScript file turns a chained push back on too.
    writeFileSync(join(fx.work, "src", "lib", "example", "next.ts"), "export const x = 1;\n");
    git(fx.work, "add", "-A");
    assert.equal(
      runHook(fx, 'git commit -m "feat: next" && git push origin docs-only', { verdict: "fail" }).decision,
      "deny",
      "a chained commit that WILL hold a .ts file must be refused",
    );
    git(fx.work, "reset", "-q", "--hard", "HEAD");
    git(fx.work, "checkout", "-q", "feat/x");

    // ── No verdict never blocks, says so, and is never remembered ───────────────────────────────────────
    const noVerdicts: Array<{ verdict: string; env?: Record<string, string>; says: RegExp }> = [
      { verdict: "unreachable", says: /could not be reached|NO VERDICT/ },
      { verdict: "no-verdict", says: /tree changed/ },
      { verdict: "install-failed", says: /without a typecheck verdict/ },
      { verdict: "hang", env: { PHX_PUSH_CHECK_TIMEOUT_MS: "700" }, says: /did not finish/ },
    ];
    for (const { verdict, env, says } of noVerdicts) {
      fx.commit("src/lib/example/rules.ts");
      const result = expectRun(fx, "git push origin feat/x", "allow", { verdict, env });
      assert.match(result.context, /NO VERDICT/, `${verdict}: it must say the push was not checked.\n${result.context}`);
      assert.match(result.context, says, `${verdict}: it must say why.\n${result.context}`);
      assert.match(result.context, /`checks` job/, `${verdict}: it must say CI is still the gate.\n${result.context}`);
      expectRun(fx, "git push origin feat/x", "allow", { verdict, env }); // not remembered: asked again
    }

    // ── A checkout without the script is not this repository ────────────────────────────────────────────
    const other = join(fx.root, "other");
    mkdirSync(other);
    git(other, "init", "-q");
    writeFileSync(join(other, "a.ts"), "export {};\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "x");
    expectNoRun(fx, "git push origin HEAD", { verdict: "fail", cwd: other });
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}
