// bash-guard C12's pre-push secret scan — WHERE it scans, WHETHER it needs to, and a run that can
// never outlast the dispatcher it lives in (`.claude/hooks/lib/secret-scan.mjs`).
//
// On 23 Oct 2026, 08:40–10:13 Cairo, every `git push` from every session spent 30–95s in this scan
// and three crossed the PreToolUse dispatcher's 90s budget; Claude Code then killed the dispatcher
// whole, so those pushes ran with NO guard's answer at all. The gitleaks call had a 120s timeout
// inside that 90s, ran through `shell: true` (a timeout killed cmd.exe and orphaned the scanner), and
// scanned the session's cwd — the primary checkout — while every one of those pushes was
// `cd <worktree> && git push`, so it waited the full time over an empty range and checked nothing.
//
// The end-to-end cases drive the real hook as a subprocess with a FAKE gitleaks first on PATH that
// only records the folder it ran in, so they pass the same on a runner with no gitleaks at all.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  commitsAhead,
  GITLEAKS_ARGS,
  readPushes,
  scanBranchCommits,
  SECRET_SCAN_TIMEOUT_MS,
} from "../.claude/hooks/lib/secret-scan.mjs";

import { commandSegments } from "../.claude/hooks/lib/git-command.mjs";

const guardPath = resolve(".claude/hooks/bash-guard.mjs");
const isWin = process.platform === "win32";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"], timeout: 60000 });
}

/** Same folder, however it was spelled (8.3 names, case, separators). */
function same(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = realpathSync.native(p);
    return isWin ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** A bare origin plus a work repo whose `main` carries `.gitleaks.toml`; `ahead` commits on a branch. */
function repoFixture(root: string, ahead: number): string {
  const origin = join(root, "origin.git");
  const work = join(root, "work tree"); // a space, the way every path on this machine has one
  mkdirSync(origin, { recursive: true });
  git(origin, ["init", "--bare", "-b", "main"]);
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-b", "main"]);
  git(work, ["config", "user.email", "fixture@example.invalid"]);
  git(work, ["config", "user.name", "Fixture"]);
  git(work, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(work, ".gitleaks.toml"), "# identifies the repo\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "base"]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["push", "-u", "origin", "main"]);
  if (ahead > 0) {
    git(work, ["switch", "-c", "codex/probe"]);
    for (let i = 0; i < ahead; i++) {
      writeFileSync(join(work, `change-${i}.txt`), `change ${i}\n`);
      git(work, ["add", "-A"]);
      git(work, ["commit", "-m", `change ${i}`]);
    }
  }
  return work;
}

/** A fake `gitleaks` first on PATH that appends the folder it ran in to `log` and exits 0. */
function fakeGitleaksEnv(root: string, log: string): NodeJS.ProcessEnv {
  const bin = join(root, "fakebin");
  mkdirSync(bin, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, PHX_FAKE_GITLEAKS_LOG: log };
  if (isWin) {
    // A real .exe is needed (the hook spawns with no shell), so node itself stands in, renamed, and
    // a preload that acts only under that name records the folder and exits before any script runs.
    const exe = join(bin, "gitleaks.exe");
    try {
      linkSync(process.execPath, exe);
    } catch {
      copyFileSync(process.execPath, exe);
    }
    const preload = join(root, "fake-gitleaks.cjs");
    writeFileSync(
      preload,
      "const p = require('path');\n" +
        "if (/^gitleaks(\\.exe)?$/i.test(p.basename(process.execPath))) {\n" +
        "  require('fs').appendFileSync(process.env.PHX_FAKE_GITLEAKS_LOG, process.cwd() + '\\n');\n" +
        "  const range = process.argv.find((a) => a.startsWith('--log-opts=')) || '';\n" +
        "  require('fs').appendFileSync(process.env.PHX_FAKE_GITLEAKS_LOG + '.ranges', range.slice(11) + '\\n');\n" +
        "  process.exit(0);\n" +
        "}\n",
    );
    env.NODE_OPTIONS = `--require "${preload.replace(/\\/g, "/")}"`; // NODE_OPTIONS reads a backslash as an escape
  } else {
    const script = join(bin, "gitleaks");
    writeFileSync(
      script,
      '#!/bin/sh\npwd -P >> "$PHX_FAKE_GITLEAKS_LOG"\n' +
        'printf \'%s\\n\' "${3#--log-opts=}" >> "$PHX_FAKE_GITLEAKS_LOG.ranges"\nexit 0\n',
    );
    chmodSync(script, 0o755);
  }
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = `${bin}${isWin ? ";" : ":"}${env[pathKey] ?? ""}`;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PHX_SECRETS_OK;
  return env;
}

function runGuard(cwd: string, command: string, env: NodeJS.ProcessEnv, toolName = "Bash"): string {
  return execFileSync(process.execPath, [guardPath], {
    cwd,
    input: JSON.stringify({ tool_name: toolName, cwd, tool_input: { command } }),
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
  });
}

/** The reason bash-guard refused with, or "" when it let the command through. */
function refusalOf(stdout: string): string {
  const start = stdout.indexOf('{"hookSpecificOutput"');
  if (start < 0) return "";
  const parsed = JSON.parse(stdout.slice(start)) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  return parsed.hookSpecificOutput?.permissionDecision === "deny"
    ? String(parsed.hookSpecificOutput.permissionDecisionReason ?? "")
    : "";
}

function scannedFolders(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean) : [];
}

function scannedRanges(log: string): string[] {
  return scannedFolders(`${log}.ranges`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function runSecretScanPushGuardTests(): void {
  const root = mkdtempSync(join(tmpdir(), "phx-secret-scan-"));
  try {
    // 1. The cap fits inside the dispatcher's 90s budget, with room for every other guard.
    assert.ok(
      SECRET_SCAN_TIMEOUT_MS <= 30000,
      `the scan cap must sit well inside the 90s hook budget; it is ${SECRET_SCAN_TIMEOUT_MS}ms`,
    );

    // 3. commitsAhead: zero on main, the count on a branch, null outside a repo.
    const behind = repoFixture(join(root, "zero"), 0);
    const ahead = repoFixture(join(root, "two"), 2);
    assert.equal(commitsAhead(behind), 0, "a branch at origin/main adds nothing");
    assert.equal(commitsAhead(ahead), 2, "two commits past origin/main");
    const notARepo = join(root, "not a repo");
    mkdirSync(notARepo, { recursive: true });
    assert.equal(commitsAhead(notARepo), null, "not a repository");

    // 4. scanBranchCommits, against a fake scanner run by node.
    const fake = join(root, "fake-scanner.mjs");
    writeFileSync(
      fake,
      "import { writeFileSync } from 'node:fs';\n" +
        "const [log, mode, ...args] = process.argv.slice(2);\n" +
        "writeFileSync(log, JSON.stringify({ cwd: process.cwd(), args, pid: process.pid }));\n" +
        "if (mode === 'sleep') setTimeout(() => {}, 30000);\n" +
        "else if (mode === 'found') { process.stderr.write('Finding: REDACTED\\n'); process.exit(1); }\n" +
        "else process.exit(0);\n",
    );
    const record = join(root, "scanner-record.json");
    const read = () => JSON.parse(readFileSync(record, "utf8")) as { cwd: string; args: string[]; pid: number };

    assert.equal(scanBranchCommits(ahead, { command: [process.execPath, fake, record, "clean"] }).status, "clean");
    assert.deepEqual(read().args, GITLEAKS_ARGS, "the scanner gets exactly the branch-range arguments");
    assert.ok(same(read().cwd, ahead), "the scanner runs in the folder it was given");

    const found = scanBranchCommits(ahead, { command: [process.execPath, fake, record, "found"] });
    assert.equal(found.status, "found");
    assert.match(found.output, /Finding: REDACTED/);

    const t0 = Date.now();
    const slow = scanBranchCommits(ahead, { command: [process.execPath, fake, record, "sleep"], timeoutMs: 1500 });
    const took = Date.now() - t0;
    assert.equal(slow.status, "timed-out", "a scan past its cap reports timed-out, it does not hang");
    assert.ok(took < 10000, `the timeout must return promptly; it took ${took}ms`);
    const pid = read().pid;
    const deadline = Date.now() + 3000;
    while (processAlive(pid) && Date.now() < deadline) execFileSync(process.execPath, ["-e", "setTimeout(()=>{},200)"]);
    assert.ok(!processAlive(pid), "the timed-out scanner must be killed, never left running as an orphan");

    assert.equal(
      scanBranchCommits(ahead, { command: ["phx-no-such-scanner-anywhere"] }).status,
      "missing",
      "a scanner that is not installed reports missing",
    );

    // 5. End to end through bash-guard: a push from another folder scans THAT folder.
    const log = join(root, "fake-gitleaks.log");
    const env = fakeGitleaksEnv(root, log);
    const elsewhere = join(root, "elsewhere"); // the session's cwd: no .gitleaks.toml
    mkdirSync(elsewhere, { recursive: true });

    runGuard(elsewhere, `cd "${ahead}" && git push -u origin codex/probe`, env);
    let seen = scannedFolders(log);
    assert.equal(seen.length, 1, `cd <repo> && git push must scan that repo once; scanned: ${JSON.stringify(seen)}`);
    assert.ok(same(seen[0], ahead), `it must scan the cd target, not the session cwd; scanned ${seen[0]}`);

    rmSync(log, { force: true });
    runGuard(ahead, "git push -u origin codex/probe", env);
    seen = scannedFolders(log);
    assert.equal(seen.length, 1, "a push with no cd still scans the session's own folder");

    // 6. ...and a branch with nothing past origin/main is not scanned at all.
    rmSync(log, { force: true });
    runGuard(elsewhere, `cd "${behind}" && git push`, env);
    assert.deepEqual(scannedFolders(log), [], "a push with no new commits must not run the scanner");

    // 7. The stand-down still skips it.
    rmSync(log, { force: true });
    runGuard(elsewhere, `PHX_SECRETS_OK=1 cd "${ahead}" && git push`, env);
    assert.deepEqual(scannedFolders(log), [], "PHX_SECRETS_OK=1 skips the scan");

    // 8. The gap of 3 Nov 2026: one command that commits AND pushes. The hook runs before any of it,
    // when the new commit does not exist, so the range scan reads zero commits on a fresh branch (the
    // shape that carried a JWT out, and the next push was refused for it) and everything but the new
    // commit on a branch already ahead. `behind` and `ahead` are those two states.
    const exactShape = 'git add leak.ts && git commit -m "add it" && git push -u origin codex/probe';
    for (const [state, repo] of [["a branch with nothing past origin/main", behind], ["a branch already ahead", ahead]]) {
      rmSync(log, { force: true });
      const reason = refusalOf(runGuard(repo, exactShape, env));
      assert.match(reason, /C12/, `git add && git commit && git push must be refused on ${state}`);
      assert.match(reason, /two commands/i, "the refusal must say how to get past it");
      assert.deepEqual(scannedFolders(log), [], "there is nothing worth scanning yet, so it refuses without scanning");
    }

    // ...in every spelling sessions really use. Measured over the Phoenix sessions on 3 Nov 2026.
    const heredocCommit = "git add leak.ts && git commit -q -F - <<'EOF'\nfix: a message\n\nmore words\nEOF\ngit push";
    const refused: Array<[string, string, string?]> = [
      ["a semicolon chain", 'git add leak.ts; git commit -m "add it"; git push'],
      ["one command per line", 'git add leak.ts\ngit commit -m "add it"\ngit push -u origin HEAD'],
      ["a heredoc commit message", heredocCommit],
      ["a substituted commit message", "git commit -m \"$(cat <<'EOF'\nfix: a message\nEOF\n)\" && git push"],
      ["a flag on the commit", 'git -c commit.gpgsign=false commit -m "add it" && git push'],
      ["the push hung up in a timeout", 'git commit -m "add it" && timeout 60 git push -u origin HEAD'],
      ["the push piped on", 'git commit -m "add it" 2>&1 | tail -1 && git push 2>&1 | tail -2'],
      ["an `if` block", 'git commit -m "add it"; if [ $? -eq 0 ]; then git push; fi'],
      ["a commit message naming --help, which stands the scan down", 'git commit -m "document --help" && git push'],
      ["a commit message naming --dry-run", 'git commit -m "add --dry-run" && git push'],
      ["git -C on both", 'git -C "$WT" commit -m "add it" && git -C "$WT" push'],
      ["git -C on a folder with a space", 'git -C "F:/a b" commit -m "add it" && git -C "F:/a b" push'],
      ["a cherry-pick, which also makes the commit", "git cherry-pick abc1234 && git push"],
      ["a merge, which also makes the commit", "git merge --no-edit some-branch && git push"],
      ["PowerShell's here-string message", "git add leak.ts; git commit -q -m @'\nfix: it's a message\n'@; git push", "PowerShell"],
      ["PowerShell's own success chain", 'git add leak.ts; git commit -m "add it"; if ($?) { git push }', "PowerShell"],
      ["PowerShell's try block", 'try { git commit -m "add it"\n git push -u origin HEAD } finally { Pop-Location }', "PowerShell"],
      ["a comment holding an apostrophe, which reads as an open quote", `# don't forget\ngit commit -m "add it"\ngit push`],
    ];
    for (const [label, command, tool] of refused) {
      assert.match(refusalOf(runGuard(ahead, command, env, tool)), /C12/, `commit then push must be refused: ${label}`);
    }

    // A `cd` into the repo counts, because that is where the push runs.
    assert.match(
      refusalOf(runGuard(elsewhere, `cd "${ahead}" && ${exactShape}`, env)),
      /C12/,
      "cd <repo> && git add && git commit && git push must be refused from another folder",
    );

    // 9. Everything that is not a commit followed by a push still goes through.
    const allowed: Array<[string, string, string?]> = [
      ["a commit on its own", 'git add leak.ts && git commit -m "add it"'],
      ["a push on its own", "git push -u origin codex/probe"],
      ["a push before the commit, which carries only what the scan already read", 'git push && git commit -m "next"'],
      ["a commit message that says `git push`", 'git commit -m "then; git push it"'],
      ["a commit message that says `git push` on its own line", 'git commit -m "first\ngit push"'],
      ["a heredoc message that says `git push`", "git commit -q -F - <<'EOF'\nfix: a message\n\ngit push\nEOF"],
      ["a here-string message that says `git push`", "git commit -q -m @'\nfix: a message\ngit push\n'@", "PowerShell"],
      ["a comment that says `git commit` above a push", "# after the git commit landed\ngit push"],
      ["a trailing comment that says `git commit` above a push", "git status # after the git commit\ngit push"],
      ["an echo that says `git push` after the commit", 'git commit -m "add it" && echo "now git push"'],
      ["an echo that says `git commit` before the push", 'echo "after the git commit"; git push'],
      ["a dry-run push", 'git commit -m "add it" && git push --dry-run'],
      ["a push that only deletes a branch", 'git commit -m "add it" && git push origin --delete old-branch'],
      ["a dry-run commit", "git commit --dry-run && git push"],
      ["an abandoned merge, which makes no commit", "git merge --abort; git push"],
      ["fetching and pulling, which bring only what the remote already holds", "git pull --rebase && git push"],
      ["the stand-down", `PHX_SECRETS_OK=1 ${exactShape}`],
      ["the PowerShell stand-down", '$env:PHX_SECRETS_OK=1; git commit -m "add it"; git push', "PowerShell"],
    ];
    for (const [label, command, tool] of allowed) {
      assert.equal(refusalOf(runGuard(ahead, command, env, tool)), "", `must not be refused: ${label}`);
    }
    assert.equal(
      refusalOf(runGuard(ahead, exactShape, { ...env, PHX_SECRETS_OK: "1" })),
      "",
      "the stand-down set in the environment still skips the clause",
    );
    assert.equal(refusalOf(runGuard(elsewhere, exactShape, env)), "", "a repository with no .gitleaks.toml is not ours to refuse");

    // 10–15. The gaps left after 8 and 9, measured on 7,616 real commands on 3 Nov 2026. Every case
    // goes through the real hook, and a failure is collected rather than thrown, so that running
    // these against the old hook lists every case that fails rather than stopping at the first.
    const failures: string[] = [];
    const expectScan = (
      label: string,
      session: string,
      command: string,
      repo: string,
      range = "origin/main..HEAD",
      tool?: string,
    ) => {
      rmSync(log, { force: true });
      rmSync(`${log}.ranges`, { force: true });
      const reason = refusalOf(runGuard(session, command, env, tool));
      const folders = scannedFolders(log);
      if (reason) failures.push(`${label}: must scan, was refused: ${reason.slice(0, 90)}`);
      else if (folders.length !== 1 || !same(folders[0], repo)) {
        failures.push(`${label}: must scan ${repo} once; scanned ${JSON.stringify(folders)}`);
      } else if (scannedRanges(log)[0] !== range) {
        failures.push(`${label}: must read ${range}; read ${scannedRanges(log)[0]}`);
      }
    };
    const expectRefusal = (label: string, session: string, command: string, words: RegExp, tool?: string) => {
      rmSync(log, { force: true });
      const reason = refusalOf(runGuard(session, command, env, tool));
      if (!/C12/.test(reason) || !words.test(reason)) failures.push(`${label}: must be refused with ${words}; got "${reason.slice(0, 90)}"`);
      if (scannedFolders(log).length) failures.push(`${label}: a refusal has nothing to scan`);
    };
    const expectQuiet = (label: string, session: string, command: string, tool?: string, extra?: NodeJS.ProcessEnv) => {
      rmSync(log, { force: true });
      const reason = refusalOf(runGuard(session, command, { ...env, ...extra }, tool));
      if (reason) failures.push(`${label}: must not be refused: ${reason.slice(0, 90)}`);
      if (scannedFolders(log).length) failures.push(`${label}: must not scan; scanned ${scannedFolders(log)}`);
    };

    // A repository sitting on main with a branch past it, so `origin/main..HEAD` is empty and only the
    // named branch holds anything, and a subfolder in the one already ahead.
    const atMain = repoFixture(join(root, "at-main"), 0);
    git(atMain, ["switch", "-c", "other"]);
    writeFileSync(join(atMain, "other.txt"), "other\n");
    git(atMain, ["add", "-A"]);
    git(atMain, ["commit", "-m", "other"]);
    const otherSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: atMain, encoding: "utf8" }).trim();
    git(atMain, ["switch", "main"]);
    const sub = join(ahead, "sub folder");
    mkdirSync(sub, { recursive: true });
    const foreign = join(root, "foreign");
    mkdirSync(foreign, { recursive: true });
    git(foreign, ["init", "-b", "main"]);
    const missing = join(root, "missing");

    // 10. The folder comes from the command, however it is spelled, with the variable set in it.
    const folderCases: Array<[string, string, string?]> = [
      ["git -C", `git -C "${ahead}" push`],
      ["git -C with a refspec", `git -C "${ahead}" push -u origin HEAD`],
      ["git -C then -c", `git -C "${ahead}" -c a.b=c push`],
      ["git -C through a variable, the usual shape", `WT="${ahead}"; git -C "$WT" push`],
      ["git -C through a variable and &&", `WT="${ahead}" && git -C "$WT" push`],
      ["git -C through an exported variable, braced", `export WT="${ahead}"; git -C "\${WT}" push`],
      ["git -C through two variables", `R="${root}"; WT="$R/two/work tree"; git -C "$WT" push`],
      ["git -C under a timeout", `WT="${ahead}"; timeout 90 git -C "$WT" push 2>&1 | tail -8`],
      ["cd through a variable", `WT="${ahead}"; cd "$WT" && git push`],
      ["PowerShell's variable", `$WT = "${ahead}"; git -C $WT push`, "PowerShell"],
      ["PowerShell's variable with no spaces", `$WT="${ahead}"; git -C $WT push`, "PowerShell"],
      ["Set-Location through a variable", `$WT = "${ahead}"; Set-Location $WT; git push`, "PowerShell"],
      ["Push-Location through $env", `$env:WT = "${ahead}"; Push-Location $env:WT; git push`, "PowerShell"],
    ];
    for (const [label, command, tool] of folderCases) expectScan(label, elsewhere, command, ahead, "origin/main..HEAD", tool);
    expectScan("git -C with bash-escaped spaces", elsewhere, `git -C ${ahead.replace(/ /g, "\\ ")} push`, ahead);

    // 11. A lone push the old pattern never recognised, so no scan ran at all.
    const shapeCases: Array<[string, string, string?]> = [
      ["git -c", "git -c http.postBuffer=1 push"],
      ["git -c with a quoted value", 'git -c "a.b=c d" push'],
      ["timeout", "timeout 60 git push"],
      ["timeout, piped on", "timeout 120 git push 2>&1 | tail -2"],
      ["an if condition", "if git push; then echo pushed; fi"],
      ["an until loop", "until git push; do sleep 5; done"],
      ["PowerShell's success chain", "git status; if ($?) { git push }", "PowerShell"],
      ["PowerShell's try block", "try { git push -u origin HEAD } finally { Pop-Location }", "PowerShell"],
      ["PowerShell's call operator on a full path", '& "C:/Program Files/Git/cmd/git.exe" -c a.b=c push', "PowerShell"],
    ];
    for (const [label, command, tool] of shapeCases) expectScan(label, ahead, command, ahead, "origin/main..HEAD", tool);

    // 12. The scan reads what the push sends, not HEAD.
    const other = "origin/main..other";
    expectScan("a named branch", atMain, "git push origin other", atMain, other);
    expectScan("a forced named branch", atMain, "git push origin +other", atMain, other);
    expectScan("a named branch to another name", atMain, "git push origin other:refs/heads/elsewhere", atMain, other);
    expectScan("a full ref name", atMain, "git push origin refs/heads/other:refs/backups/other", atMain, "origin/main..refs/heads/other");
    expectScan("a branch through a variable", atMain, 'BR=other; git push origin "$BR"', atMain, other);
    expectScan("a commit named outright", atMain, `git push origin ${otherSha}:refs/backups/x`, atMain, `origin/main..${otherSha}`);
    expectScan("a commit read by rev-parse", atMain, 'TIP=$(git rev-parse other); git push origin "$TIP:refs/backups/x"', atMain, other);
    expectScan("rev-parse inside the refspec", atMain, 'git push origin "$(git rev-parse other):refs/backups/x"', atMain, other);
    expectScan("two refs at once", atMain, "git push origin other main", atMain, `${other} origin/main..main`);
    expectScan("a move, and the branch named", atMain, "git switch other && git push origin other", atMain, other);
    expectScan("the current branch by substitution", ahead, 'git push -u origin "$(git branch --show-current)"', ahead);
    expectScan("two repositories", atMain, `git -C "${ahead}" push`, ahead);
    rmSync(log, { force: true });
    refusalOf(runGuard(elsewhere, `git -C "${ahead}" push; git -C "${atMain}" push origin other`, env));
    if (scannedFolders(log).length !== 2) failures.push(`two repositories must scan both; scanned ${scannedFolders(log)}`);

    const notReadable = /not a commit/;
    expectRefusal("a move, then HEAD", atMain, "git switch other && git push", /moves HEAD/);
    expectRefusal("a checkout, then HEAD by name", atMain, "git checkout other; git push origin HEAD", /moves HEAD/);
    expectRefusal("a reset, then HEAD", atMain, "git reset --hard other && git push", /moves HEAD/);
    expectRefusal("a branch made in this command", atMain, "git switch -c fresh && git push -u origin fresh", notReadable);
    expectRefusal("a branch that does not exist", atMain, "git push origin no-such-branch", notReadable);
    expectRefusal("a ref no one set", atMain, 'git push origin "$NOT_SET_ANYWHERE"', notReadable);
    expectRefusal("a loop variable", atMain, 'for b in a c; do git push origin "$b"; done', notReadable);
    expectRefusal("a variable that may be empty", atMain, 'T=$(cat f) || T=""; git push origin "$T:refs/backups/x"', notReadable);
    expectRefusal("--all", atMain, "git push --all", /one at a time/);
    expectRefusal("--mirror", atMain, "git push --mirror", /one at a time/);
    expectRefusal("--tags", atMain, "git push origin --tags", /one at a time/);
    expectRefusal(
      "three repositories",
      elsewhere,
      `git -C "${ahead}" push; git -C "${atMain}" push origin other; git -C "${behind}" push`,
      /3 repositories/,
    );

    // 13. A folder it cannot name is refused, not read as the session's.
    expectRefusal("git -C on a variable no one set", ahead, 'git -C "$NOT_SET_ANYWHERE" push', /folder/);
    expectRefusal("cd on a variable no one set", ahead, 'cd "$NOT_SET_ANYWHERE" && git push', /folder/);
    expectRefusal("git -C on a loop variable", ahead, 'for wt in a b; do git -C "$wt" push; done', /folder/);
    expectRefusal("git -C on a substitution", ahead, 'git -C "$(mktemp -d)" push', /folder/);
    expectRefusal("git -C on a folder not there", ahead, `git -C "${missing}" push`, /folder/);
    expectQuiet("an unknown folder from a session outside this repository", elsewhere, 'git -C "$NOT_SET_ANYWHERE" push');
    expectQuiet("a repository with no .gitleaks.toml", elsewhere, `git -C "${foreign}" push`);

    // 14. A subfolder is in the repository, and `.gitleaks.toml` is at the repository's root.
    expectScan("a session in a subfolder", sub, "git push", ahead);
    expectScan("git -C on a subfolder", elsewhere, `git -C "${sub}" push`, ahead);
    expectScan("cd into a subfolder", ahead, 'cd "sub folder" && git push', ahead);
    expectRefusal("commit then push from a subfolder", sub, 'git commit -m "add it" && git push', /both commits and pushes/);

    // 15. What sends nothing, or is not a push at all, costs nothing, and the stand-down is unchanged.
    const quietCases: Array<[string, string, string?, NodeJS.ProcessEnv?]> = [
      ["a delete", "git push origin --delete old"],
      ["a delete by refspec", "git push origin :old"],
      ["a delete by flag", "git push -d origin old"],
      ["a dry run", "git push --dry-run"],
      ["a dry run by flag", "git push -n"],
      ["help", "git push --help"],
      ["git stash push", "git stash push -m wip"],
      ["an echo", 'echo "git push"'],
      ["a log search", "git log --grep push"],
      ["a PR title", 'gh pr create --title "git push"'],
      ["another git command on an unset folder", 'git -C "$NOT_SET_ANYWHERE" log -- push'],
      ["a checkout of one file, which moves nothing", "git checkout other -- a.txt && git status && git push --dry-run"],
      ["the stand-down on a lone push", `PHX_SECRETS_OK=1 git -C "${ahead}" push`],
      ["the stand-down on an unknown folder", 'PHX_SECRETS_OK=1 git -C "$NOT_SET_ANYWHERE" push'],
      ["the stand-down on a move", "PHX_SECRETS_OK=1 git switch other && git push"],
      ["PowerShell's stand-down", "$env:PHX_SECRETS_OK=1; timeout 60 git push", "PowerShell"],
      ["the stand-down from the environment", 'git -C "$NOT_SET_ANYWHERE" push', undefined, { PHX_SECRETS_OK: "1" }],
    ];
    for (const [label, command, tool, extra] of quietCases) expectQuiet(label, ahead, command, tool, extra);
    expectQuiet("HEAD at main, with one file checked out", atMain, "git checkout other -- other.txt && git push");

    // 16. The folder a push runs in, read directly.
    const dirA = join(root, "dir a");
    const dirB = join(dirA, "b");
    mkdirSync(dirB, { recursive: true });
    const folderOf = (command: string) => readPushes(commandSegments(command), root)[0]?.dir;
    const folderReads: Array<[string, string, string | null]> = [
      ["no cd: the session's folder", "git push", root],
      ["double-quoted cd", `cd "${dirA}" && git push`, dirA],
      ["single-quoted cd", `cd '${dirA}'; git push`, dirA],
      ["relative cds chain", "cd 'dir a' && cd b && git push", dirB],
      ["the last cd wins", `cd "${root}" && cd "${dirB}" && git push`, dirB],
      ["PowerShell Set-Location", `Set-Location -LiteralPath "${dirA}"; git push`, dirA],
      ["a folder that is not there", `cd "${missing}" && git push`, null],
    ];
    for (const [label, command, expected] of folderReads) {
      const read = folderOf(command);
      if (expected === null ? read !== null : !read || !same(read, expected)) failures.push(`${label}: read ${read}`);
    }
    if (isWin) {
      const msys = `/${dirA[0].toLowerCase()}/${dirA.slice(3).replace(/\\/g, "/")}`;
      const read = folderOf(`cd "${msys}" && git push`);
      if (!read || !same(read, dirA)) failures.push(`MSYS path ${msys}: read ${read}`);
    }

    assert.deepEqual(failures, [], `${failures.length} C12 case(s) failed:\n${failures.join("\n")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
