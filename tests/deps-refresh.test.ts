// THE WEEKLY DEPENDENCY REFRESH — the scheduled `pnpm update` the fast-uri floor's note called due.
//
// WHY THIS EXISTS (owner, 2026-10-23: "schedule the recurring pnpm update the fast-uri note says is
// due"). Five advisories on fast-uri, then hono and ip-address on 2026-10-23, all had one shape: the
// range ALLOWED the patched version, the lockfile had resolved the one before it, and nothing ever
// re-resolved it. The refresh re-resolves every package weekly, on GitHub, and opens one PR.
//
// A scheduled job cannot be tested by running it, so this pins every way its pieces go quietly wrong:
//   - lockfile.yml's default changing, so `remote-check.mjs lockfile` silently starts moving every package
//   - the refresh losing `--no-save` (it would rewrite every range in package.json) or `--depth Infinity`
//     (it would stop reaching the transitive packages, which is the whole point)
//   - the version diff reading the wrong lockfile section, so the PR names nothing or names peers twice
//   - a second refresh PR opening while one is still open, or a quarantine exception slipping through
//   - the launcher growing a dependency, parsing flags, or failing without writing its log
//   - the task losing wake/catch-up/no-overlap, or wrapping node in `cmd /c`, which writes no log at all
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import { lockMoves, resolvedVersions, BRANCH_PREFIX } from "../scripts/deps-refresh/refresh.mjs";
import { stripComments, stripHashComments } from "./support/comment-strip.ts";
import { assertFetchRetriesALostLock } from "./support/launcher-fetch-retry.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const LOCK_BEFORE = [
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "  .:",
  "    dependencies:",
  "      hono:",
  "        specifier: ^4.13.5",
  "        version: 4.13.7",
  "",
  "packages:",
  "",
  "  '@hono/node-server@2.0.12':",
  "    resolution: {integrity: sha512-a}",
  "",
  "  hono@4.13.7:",
  "    resolution: {integrity: sha512-b}",
  "",
  "  ip-address@10.7.2:",
  "    resolution: {integrity: sha512-c}",
  "",
  "  left-pad@1.0.0:",
  "    resolution: {integrity: sha512-d}",
  "",
  "snapshots:",
  "",
  "  '@hono/node-server@2.0.12(hono@4.13.7)':",
  "    dependencies:",
  "      hono: 4.13.7",
  "",
  "  hono@4.13.7: {}",
  "",
].join("\n");

const LOCK_AFTER = LOCK_BEFORE.replace(/4\.13\.7/g, "4.13.13")
  .replace("ip-address@10.7.2", "ip-address@10.7.4")
  .replace("  left-pad@1.0.0:\n    resolution: {integrity: sha512-d}\n\n", "  right-pad@2.0.0:\n    resolution: {integrity: sha512-e}\n\n");

export function runDepsRefreshTests() {
  // ---- the version diff the PR body is built from ------------------------------------------------
  const before = resolvedVersions(LOCK_BEFORE);
  assert.deepEqual([...before.keys()].sort(), ["@hono/node-server", "hono", "ip-address", "left-pad"], "only the packages: section is read — never importers or snapshots");
  assert.deepEqual([...before.get("hono")!], ["4.13.7"], "a snapshot's peer-suffixed key must not add a second version");
  assert.deepEqual(
    lockMoves(LOCK_BEFORE, LOCK_AFTER),
    [
      { name: "hono", from: "4.13.7", to: "4.13.13" },
      { name: "ip-address", from: "10.7.2", to: "10.7.4" },
      { name: "left-pad", from: "1.0.0", to: "(removed)" },
      { name: "right-pad", from: "(new)", to: "2.0.0" },
    ],
    "every move, sorted by name, with new and removed packages named as such; an unmoved scoped package is not listed",
  );
  assert.deepEqual(lockMoves(LOCK_BEFORE, LOCK_BEFORE.replace(/\n/g, "\r\n")), [], "CRLF on one side is not a move");

  // ---- lockfile.yml: the refresh is an OPT-IN mode, never the default -------------------------------
  const workflow = read(".github/workflows/lockfile.yml");
  const workflowCode = stripHashComments(workflow);
  assert.match(workflowCode, /mode:\n\s+description:[^\n]*\n\s+type: choice\n\s+options: \[regenerate, refresh\]\n\s+default: regenerate/, "mode is a choice whose DEFAULT is regenerate — remote-check.mjs lockfile dispatches without it");
  assert.match(workflowCode, /- name: Regenerate the lockfile\n\s+if: inputs\.mode != 'refresh'\n\s+run: pnpm install --lockfile-only --no-frozen-lockfile/, "the regenerate step runs for every mode but refresh");
  const refreshStep = /- name: Refresh every dependency inside its declared range\n\s+if: inputs\.mode == 'refresh'\n\s+run: ([^\n]+)/.exec(workflowCode);
  assert.ok(refreshStep, "the refresh step must exist and run only for mode=refresh");
  assert.match(refreshStep![1], /^pnpm update\b/, "the refresh is a pnpm update");
  assert.match(refreshStep![1], /--depth Infinity/, "--depth Infinity: without it the transitive packages — the whole point — never move");
  assert.match(refreshStep![1], /--no-save/, "--no-save: without it every range in package.json is rewritten, exact pins included");
  assert.doesNotMatch(refreshStep![1], /--latest|-L\b/, "never --latest: it crosses the declared ranges, majors included");

  // ---- refresh.mjs ---------------------------------------------------------------------------------
  const refresh = stripComments(read("scripts/deps-refresh/refresh.mjs"));
  assert.equal(BRANCH_PREFIX, "codex/weekly-deps-refresh-", "the branch prefix the one-open-PR guard matches on");
  assert.ok(!"codex/deps-refresh-weekly".startsWith(BRANCH_PREFIX), "the prefix must not match the branch that built this feature");
  assert.match(refresh, /headRefName\.startsWith\(BRANCH_PREFIX\)/, "one refresh PR at a time: an open one stops the run");
  assert.ok(refresh.indexOf("headRefName.startsWith(BRANCH_PREFIX)") < refresh.indexOf('"push"'), "the open-PR check comes BEFORE anything is pushed");
  assert.match(refresh, /"workflow", "run", WORKFLOW, "--ref", branch, "-f", "mode=refresh"/, "it dispatches lockfile.yml with mode=refresh on its own branch");
  assert.match(refresh, /changed\.includes\("pnpm-workspace\.yaml"\)[\s\S]{0,200}REFUSED/, "a change to pnpm-workspace.yaml (a quarantine exception) is refused, never opened");
  assert.match(refresh, /if \(dryRun\)[\s\S]{0,300}return;[\s\S]*"pr", "create"/, "a dry run returns before the PR is created");
  assert.match(refresh, /if \(!keepBranch\)[\s\S]{0,120}"--delete", branch/, "every run that opens no PR deletes the branch it pushed");
  assert.match(refresh, /"pr", "create", "--base", "main"/, "the PR targets main");
  assert.doesNotMatch(refresh, /"pr", "merge"|--auto\b/, "the refresh never merges anything — every merge is the owner's own word");

  // ---- the launcher --------------------------------------------------------------------------------
  const launcher = read("scripts/deps-refresh/run-refresh.mjs");
  const launcherCode = stripComments(launcher);
  const imports = [...launcher.matchAll(/^import .*?from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, "the launcher must import something — otherwise the builtins check proves nothing");
  for (const spec of imports) assert.ok(spec.startsWith("node:"), `the launcher may import node builtins only (found "${spec}") — it runs from ~/.claude/scripts with no node_modules`);
  const refusal = launcherCode.indexOf("REFUSED — unknown argument");
  assert.ok(refusal > 0, "the launcher refuses ANY argument — it takes none, so a --dry-run passed to it must not open a real PR in silence");
  assert.match(launcherCode, /if \(REFRESH_ARGS\.length > 0\)[\s\S]{0,300}process\.exit\(2\)/, "the refusal exits 2 before doing anything");
  assert.ok(refusal < launcherCode.indexOf("fetchMain();") && refusal < launcherCode.indexOf('"worktree", "add"'), "the refusal comes BEFORE the fetch and the worktree");
  assert.doesNotMatch(launcherCode, /\.env\.local|mklink/, "no secret and no junction: refresh.mjs reads no database and needs no node_modules");
  assert.match(launcher, /git\(\["worktree", "add", "-q", "--detach", tree, "origin\/main"\]\)/, "it runs refresh.mjs from a throwaway worktree at origin/main");
  assert.match(launcher, /scripts", "deps-refresh", "refresh\.mjs"/, "it runs origin/main's own refresh.mjs");
  assert.match(launcher, /appendFileSync\(LOG/, "it writes its own log — the task runs node directly");
  assert.ok(new RegExp("say\\(" + String.fromCharCode(96) + "FAILED — ").test(launcher), "a failure lands in the log with its reason");
  assert.match(launcher, /timeZone: "Africa\/Cairo"/, "log lines carry Cairo time");
  assertFetchRetriesALostLock(launcherCode, "scripts/deps-refresh/run-refresh.mjs");

  // ---- the Windows task ----------------------------------------------------------------------------
  const installer = read("scripts/deps-refresh/install-task.ps1");
  const installerCode = stripHashComments(installer);
  assert.match(installerCode, /Register-ScheduledTask/, "the comment-free installer must still hold its real commands");
  assert.match(installer, /New-ScheduledTaskAction -Execute \$node\b/, "node runs directly");
  assert.doesNotMatch(installerCode, /cmd\s*\/c|>>|Out-File/i, "no cmd wrapper and no redirection — it returns 0x1 and writes no log");
  assert.match(installer, /Copy-Item -Path \(Join-Path \$scriptRoot "run-refresh\.mjs"\)/, "the launcher is copied out of the repo — the task may not name a file in a working tree");
  assert.match(installerCode, /New-ScheduledTaskTrigger -Weekly -DaysOfWeek \$Day -At \$At/, "one weekly trigger");
  assert.match(installer, /\[string\]\$Day = "Sunday"/, "Sunday by default — the first working morning of the week");
  assert.match(installer, /\[string\]\$At = "10:00"/, "10:00 Cairo by default, clear of the memory fold's 09:00");
  for (const flag of ["-WakeToRun", "-StartWhenAvailable", "-AllowStartIfOnBatteries", "-DontStopIfGoingOnBatteries"]) {
    assert.ok(installerCode.includes(flag), `${flag} must stay: a shut lid would otherwise mean no refresh and no error`);
  }
  assert.match(installerCode, /-MultipleInstances IgnoreNew/, "a slow run is never overlapped by the next one");

  // ---- the floor that asked for it now points here -------------------------------------------------
  assert.match(read("pnpm-workspace.yaml"), /SCHEDULED 2026-10-23[\s\S]{0,200}scripts\/deps-refresh/, "the fast-uri note must say the refresh is scheduled, and where");
}
