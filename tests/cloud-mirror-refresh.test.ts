// THE NIGHTLY CLOUD-MIRROR REFRESH — the job that keeps a cloud session's only memory current.
//
// WHY THIS EXISTS (owner, 2026-10-23: "widen 6337 with an automatic nightly mirror refresh"). A cloud
// session is an isolated clone: it never sees ~/.claude, so `.claude/cloud-context/` IS its memory and
// its copy of the standing rules, and it is only as fresh as its last MERGED refresh. Refreshing it was
// something a person had to remember, and on 2026-10-23 the mirror read 9 files behind the laptop —
// 2 stale, 7 missing — every one a fact a cloud session would have answered with, wrongly and
// confidently.
//
// A scheduled job cannot be tested by running it, so this pins every way its pieces go quietly wrong:
//   - the commit staging the mirror alone, which ships ORPHAN notes and fails the required validate job
//     (it turned main red on three commits on 2026-10-02 and withheld three production deploys)
//   - a second refresh PR opening while one is still open, which hands the owner the same PR twice
//   - a PR opened on an unhealthy module-memory tree, which can never go green and then blocks every
//     later night on the one-open-PR guard
//   - key material riding into a public branch: the laptop's gitleaks guard (bash-guard C12) reads BASH
//     commands, and this job pushes from node, so nothing else stands in front of it
//   - the launcher growing a dependency, parsing flags, or failing without writing its log
//   - the task losing wake/catch-up/no-overlap, or wrapping node in `cmd /c`, which writes no log at all
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { BRANCH_PREFIX, STAGE_PATHS, secretFindings } from "../scripts/cloud-mirror/refresh.mjs";
import { stripComments, stripHashComments } from "./support/comment-strip.ts";
import { assertFetchRetriesALostLock } from "./support/launcher-fetch-retry.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

export function runCloudMirrorRefreshTests() {
  // ---- what a refresh commit must carry ------------------------------------------------------------
  assert.deepEqual(
    STAGE_PATHS,
    [".claude/cloud-context", ".claude/rules", "scripts/module-memory/assignments.json"],
    "all three paths or none: sync-cloud-context.mjs files each new slug in assignments.json and rebuilds every module's notes block, and a note no module claims is an orphan that fails the required validate job",
  );

  // ---- the one-open-PR guard ----------------------------------------------------------------------
  assert.equal(BRANCH_PREFIX, "codex/cloud-mirror-refresh", "the branch prefix the one-open-PR guard matches on");
  assert.ok(!"codex/cloud-context-readme".startsWith(BRANCH_PREFIX), "the prefix must not match a neighbouring branch name");

  // ---- the secret scan: real key material, never the prose that discusses it ----------------------
  const KEYS: [string, string][] = [
    ["an OpenAI-style key", "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123"],
    ["a JWT (Supabase anon or service key)", "anon key eyJhbGciOiJIUzI1NiIsInR5cCI6.eyJyb2xlIjoiYW5vbiIsImlhdCI6MH0"],
    ["a GitHub token", "token ghp_0123456789abcdefghijklmnopqrstuvwxyz"],
    ["a Supabase access token", "sbp_0123456789abcdef0123456789abcdef01234567"], // gitleaks:allow — an invented vector the redactor must catch, never a real token
    ["a private key block", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["an AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
  ];
  for (const [name, text] of KEYS) {
    assert.deepEqual(secretFindings(text), [name], `the scan must name ${name} — this is what the laptop's push guard would have caught on a bash push`);
  }
  for (const prose of [
    "most code paths use the service-role client, so visibility is application-scoped not RLS-scoped",
    "SUPABASE_SERVICE_ROLE_KEY stays server-only — never ship it to the browser",
    "the jwt starts eyJ and the guard logs its prefix only",
    "a 40-character string is not a sha: 0123456789abcdef0123456789abcdef01234567",
  ]) {
    assert.deepEqual(secretFindings(prose), [], `prose must not trip the scan, or nobody keeps it: ${prose.slice(0, 48)}`);
  }

  // The emitted artifact, not the source: the mirror this job actually pushes is scanned as it stands.
  const mirrorDir = path.join(ROOT, ".claude", "cloud-context", "memory-mirror");
  const notes = readdirSync(mirrorDir).filter((name) => name.toLowerCase().endsWith(".md"));
  assert.ok(notes.length > 100, `the mirror must hold the laptop's notes — found ${notes.length}`);
  for (const name of notes) {
    const found = secretFindings(readFileSync(path.join(mirrorDir, name), "utf8"));
    assert.deepEqual(found, [], `.claude/cloud-context/memory-mirror/${name} carries ${found.join(" and ")} — redact the note on the laptop; a mirror commit is a public branch`);
  }
  const rules = secretFindings(read(".claude/cloud-context/global-standing-rules.md"));
  assert.deepEqual(rules, [], `the mirrored standing rules carry ${rules.join(" and ")}`);

  // ---- refresh.mjs ---------------------------------------------------------------------------------
  const refresh = stripComments(read("scripts/cloud-mirror/refresh.mjs"));
  const firstPush = refresh.indexOf('git("push"');
  assert.ok(firstPush > 0, "the job must push somewhere — the ordering checks below prove nothing otherwise");
  assert.match(refresh, /openRefreshPr\(open\)/, "one refresh PR at a time: an open one is pushed onto, never duplicated");
  assert.ok(refresh.indexOf("openRefreshPr(open)") < firstPush, "the open-PR check comes BEFORE anything is pushed");
  assert.match(refresh, /module memory: healthy[\s\S]{0,400}process\.exitCode = 1/, "an unhealthy module-memory tree refuses, rather than opening a PR that cannot go green");
  assert.ok(refresh.indexOf("module memory: healthy") < firstPush, "the health gate runs BEFORE the push");
  assert.match(refresh, /secretFindings\(staged\)/, "the staged text is scanned, not the working tree — what is pushed is what is scanned");
  assert.ok(refresh.indexOf("secretFindings(staged)") < firstPush, "the secret scan runs BEFORE the push");
  assert.match(refresh, /NOCHANGE[\s\S]{0,200}return;/, "a night that moved nothing pushes nothing and touches no PR");
  assert.ok(refresh.indexOf("NOCHANGE") < firstPush, "the no-change exit comes before the push, or every quiet night costs a commit");
  assert.match(refresh, /if \(dryRun\)[\s\S]{0,300}return;[\s\S]*git\("commit"/, "a dry run returns before the commit and the push");
  assert.match(refresh, /"pr", "create", "--base", "main"/, "the PR targets main");
  assert.doesNotMatch(refresh, /"pr", "merge"|--auto\b/, "the refresh never merges anything — every merge is the owner's own word");
  assert.match(refresh, /git\("add", "--", \.\.\.STAGE_PATHS\)/, "it stages through STAGE_PATHS, so the three paths cannot drift apart");
  assert.match(refresh, /sync-cloud-context\.mjs/, "the refresh itself is the repo's own mirror script, never a reimplementation of it");

  // ---- the launcher --------------------------------------------------------------------------------
  const launcher = read("scripts/cloud-mirror/run-refresh.mjs");
  const launcherCode = stripComments(launcher);
  const imports = [...launcher.matchAll(/^import .*?from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, "the launcher must import something — otherwise the builtins check proves nothing");
  for (const spec of imports) assert.ok(spec.startsWith("node:"), `the launcher may import node builtins only (found "${spec}") — it runs from ~/.claude/scripts with no node_modules`);
  const refusal = launcherCode.indexOf("REFUSED — unknown argument");
  assert.ok(refusal > 0, "the launcher refuses ANY argument — it takes none, so a --dry-run passed to it must not push for real in silence");
  assert.match(launcherCode, /if \(EXTRA_ARGS\.length > 0\)[\s\S]{0,300}process\.exit\(2\)/, "the refusal exits 2 before doing anything");
  assert.ok(refusal < launcherCode.indexOf("fetchMain();") && refusal < launcherCode.indexOf('"worktree", "add"'), "the refusal comes BEFORE the fetch and the worktree");
  assert.doesNotMatch(launcherCode, /\.env\.local|mklink/, "no secret and no junction: the refresh reads no database and needs no node_modules");
  assert.match(launcher, /git\(\["worktree", "add", "-q", "--detach", tree, "origin\/main"\]\)/, "it runs refresh.mjs from a throwaway worktree at origin/main");
  assert.match(launcher, /scripts", "cloud-mirror", "refresh\.mjs"/, "it runs origin/main's own refresh.mjs — never a stale copy from a working tree");
  assert.match(launcher, /appendFileSync\(LOG/, "it writes its own log — the task runs node directly");
  // stripComments blanks a comment to spaces of the same length, so these windows span the comments too.
  assert.match(launcherCode, /if \(existsSync\(refresh\)\) \{[\s\S]{0,500}\} else \{[\s\S]{0,500}WAITING/, "a main that does not carry refresh.mjs yet is a logged WAITING night, not a FAILED one — the task is installed the day the job is written, and the PR merges later");
  assert.doesNotMatch(launcherCode, /process\.exit\(0\)/, "no early exit past the finally block: it would leave the throwaway worktree registered every night");
  assert.ok(new RegExp("say\\(" + String.fromCharCode(96) + "FAILED — ").test(launcher), "a failure lands in the log with its reason");
  assert.match(launcher, /timeZone: "Africa\/Cairo"/, "log lines carry Cairo time");
  assertFetchRetriesALostLock(launcherCode, "scripts/cloud-mirror/run-refresh.mjs");

  // ---- the Windows task ----------------------------------------------------------------------------
  const installer = read("scripts/cloud-mirror/install-task.ps1");
  const installerCode = stripHashComments(installer);
  assert.match(installerCode, /Register-ScheduledTask/, "the comment-free installer must still hold its real commands");
  assert.match(installer, /New-ScheduledTaskAction -Execute \$node\b/, "node runs directly");
  assert.doesNotMatch(installerCode, /cmd\s*\/c|>>|Out-File/i, "no cmd wrapper and no redirection — it returns 0x1 and writes no log");
  assert.match(installer, /Copy-Item -Path \(Join-Path \$scriptRoot "run-refresh\.mjs"\)/, "the launcher is copied out of the repo — the task may not name a file in a working tree");
  assert.match(installerCode, /New-ScheduledTaskTrigger -Daily -At \$At/, "one daily trigger: nightly means every night, Sunday included");
  assert.match(installer, /\[string\]\$At = "04:07"/, "04:07 Cairo by default — clear of the memory fold, the field day, the dependency refresh and the Needs You digest");
  for (const flag of ["-WakeToRun", "-StartWhenAvailable", "-AllowStartIfOnBatteries", "-DontStopIfGoingOnBatteries"]) {
    assert.ok(installerCode.includes(flag), `${flag} must stay: a shut lid would otherwise mean no refresh and no error`);
  }
  assert.match(installerCode, /-MultipleInstances IgnoreNew/, "a slow run is never overlapped by the next one");

  // ---- the job is reachable from the memory that governs it ---------------------------------------
  const sessions = read(".claude/rules/sessions.md");
  assert.match(sessions.split("---")[1] ?? "", /scripts\/cloud-mirror/, "the sessions module must claim scripts/cloud-mirror/, or its memory never loads for the job that keeps the mirror current");
  assert.match(sessions, /docs\/cloud-mirror-refresh\.md/, "the rule must point at its account");
  assert.match(read("docs/cloud-mirror-refresh.md"), /04:07|install-task\.ps1/, "the account must say when it runs and how it is installed");
}
