// repo-doctor must say when git's own maintenance has stopped, and when it is allowed to delete
// what every session shares.
//
// WHY THIS EXISTS. On 2026-09-17 `objects/maintenance.lock` had sat in the common git directory
// since 2026-08-10 18:31 Cairo. While it exists every `git maintenance run` does nothing and exits
// 0, the automatic one and one typed by hand alike (measured on git 2.55.0.windows.3), so 13,456
// loose objects (179 MiB) and 396 loose ref files piled up with nothing reporting it. The repair
// carries its own trap: git 2.55's default automatic run executes `git rerere gc` over the one
// rerere cache every worktree and session shares. The repository pins the data-deleting tasks off,
// and repo-doctor now reads the lock, the pins and the loose-object backlog back.
//
// WHAT IS PINNED HERE is the part that would fail SILENTLY: a lock that reads as "no lock" when it
// could not be checked, a pin list that quietly loses a task, a valueless config key (which git
// reads as TRUE) passing as a pin, and a backlog command that falls back to a strategy which
// expires data. The config parser is also driven through REAL `git config --list -z`, because the
// bug worth catching there is what git prints, not what a hand-written string looks like.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DATA_DELETING_TASKS,
  LOOSE_OBJECT_ALARM,
  STALE_LOCK_MINUTES,
  cairoStamp,
  classifyLooseObjects,
  classifyMaintenanceConfig,
  classifyMaintenanceLock,
  gitConfigBool,
  parseGitConfigList,
  parseLooseObjectCount,
} from "../scripts/repo-doctor-git-maintenance.mjs";

const LOCK = "/repo/.git/objects/maintenance.lock";
/** The incident's own lock: written 2026-08-10 18:31 Cairo (UTC+3 in summer), found 2026-09-17. */
const INCIDENT_LOCK_MS = Date.parse("2026-08-10T15:31:00Z");
const FOUND_MS = Date.parse("2026-09-17T15:01:00Z");

/** The pins this repository set on 2026-09-17, exactly as `git config --list -z` prints them. */
const PINNED_LIST = [
  "core.repositoryformatversion\n0",
  "maintenance.gc.enabled\nfalse",
  "maintenance.geometric-repack.enabled\nfalse",
  "maintenance.rerere-gc.enabled\nfalse",
  "maintenance.reflog-expire.enabled\nfalse",
  "maintenance.worktree-prune.enabled\nfalse",
  "maintenance.prefetch.enabled\nfalse",
  "maintenance.loose-objects.enabled\ntrue",
  "maintenance.commit-graph.enabled\ntrue",
  "maintenance.incremental-repack.enabled\ntrue",
  "maintenance.pack-refs.enabled\ntrue",
]
  .map((entry) => `${entry}\0`)
  .join("");

const ALL_TASKS = ["gc", "geometric-repack", "rerere-gc", "reflog-expire", "worktree-prune"];

const joined = (verdict: { lines: string[] }) => verdict.lines.join("\n");

/** No `.trim()`: `-z` output ends in NUL, and the parser under test must see git's bytes as printed. */
function git(at: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd: at, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
}

export function runRepoDoctorGitMaintenanceTests(): void {
  // ── 1. The stale lock: the stall itself ────────────────────────────────────────────────────────
  const stale = classifyMaintenanceLock({
    lockPath: LOCK,
    lockMtimeMs: INCIDENT_LOCK_MS,
    lockError: null,
    nowMs: FOUND_MS,
  });
  assert.equal(
    stale.severity,
    "alarm",
    "a maintenance lock left for weeks must alarm: while it exists every git maintenance run does nothing and exits 0",
  );
  assert.equal(stale.state, "stale-lock");
  assert.match(joined(stale), /2026-08-10 18:31 Cairo/, "the lock's date is reported in Cairo local time");
  assert.match(joined(stale), /\(37 day\(s\)\)/);
  assert.ok(
    stale.lines.some((line) => line.trim() === `rm "${LOCK}"`),
    "the stale-lock verdict prints the removal command for the exact path",
  );
  assert.match(
    joined(stale),
    /Pin the data-deleting tasks off FIRST/,
    "removing the lock is what lets the data-deleting tasks run, so the verdict puts the pins first",
  );

  const atTheEdge = classifyMaintenanceLock({
    lockPath: LOCK,
    lockMtimeMs: FOUND_MS - STALE_LOCK_MINUTES * 60_000,
    lockError: null,
    nowMs: FOUND_MS,
  });
  assert.equal(atTheEdge.severity, "alarm", "a lock exactly two hours old is stale");

  const running = classifyMaintenanceLock({
    lockPath: LOCK,
    lockMtimeMs: FOUND_MS - (STALE_LOCK_MINUTES - 1) * 60_000,
    lockError: null,
    nowMs: FOUND_MS,
  });
  assert.equal(running.severity, "note", "a lock younger than two hours belongs to a run in progress");
  assert.ok(!/\brm "/.test(joined(running)), "a lock a live run may hold is never offered for removal");

  const noLock = classifyMaintenanceLock({ lockPath: LOCK, lockMtimeMs: null, lockError: null, nowMs: FOUND_MS });
  assert.equal(noLock.severity, "ok");

  const couldNotLook = classifyMaintenanceLock({ lockPath: LOCK, lockMtimeMs: null, lockError: "EACCES", nowMs: FOUND_MS });
  assert.equal(couldNotLook.severity, "unknown", "a lock that could not be checked must never read as no lock");
  assert.match(joined(couldNotLook), /Do NOT read this as clean/);

  assert.equal(cairoStamp(Date.parse("2026-01-15T10:05:00Z")), "2026-01-15 12:05 Cairo", "Cairo is UTC+2 in winter");

  // ── 2. The task list never quietly loses a task ────────────────────────────────────────────────
  assert.deepEqual(
    DATA_DELETING_TASKS.map(([task]) => task),
    ALL_TASKS,
    "every maintenance task that deletes data must stay on the pin list: gc, geometric-repack, rerere-gc, reflog-expire, worktree-prune",
  );

  // ── 3. The pins read back ──────────────────────────────────────────────────────────────────────
  const pinned = classifyMaintenanceConfig(parseGitConfigList(PINNED_LIST));
  assert.equal(pinned.severity, "ok", "this repository's own pins must read as pinned");
  assert.deepEqual(pinned.unpinned, []);

  const unpinnedRepo = classifyMaintenanceConfig(parseGitConfigList("core.bare\nfalse\0"));
  assert.equal(
    unpinnedRepo.severity,
    "alarm",
    "no pins at all is git's default, and git 2.55's default automatic run executes git rerere gc",
  );
  assert.deepEqual(unpinnedRepo.unpinned, ALL_TASKS);
  for (const task of ALL_TASKS) {
    assert.ok(
      unpinnedRepo.lines.some((line) => line.trim() === `git config maintenance.${task}.enabled false`),
      `an unpinned ${task} must come with the exact command that pins it`,
    );
  }

  const unreadableConfig = classifyMaintenanceConfig(parseGitConfigList(null));
  assert.equal(unreadableConfig.severity, "unknown", "a config git could not read must never read as pinned");
  assert.match(joined(unreadableConfig), /Do NOT read this as clean/);

  // A key written with no value is TRUE to git, and the last entry for a key wins.
  const valueless = parseGitConfigList(`${PINNED_LIST}maintenance.rerere-gc.enabled\0`);
  assert.equal(valueless?.get("maintenance.rerere-gc.enabled"), null);
  assert.deepEqual(
    classifyMaintenanceConfig(valueless).unpinned,
    ["rerere-gc"],
    "a later key with no value re-enables the task, because git reads it as true",
  );

  // Section and variable names are case-insensitive; the task name is a subsection and is not.
  const shouted = parseGitConfigList(
    PINNED_LIST.replace("maintenance.reflog-expire.enabled\nfalse", "MAINTENANCE.reflog-expire.ENABLED\nOFF"),
  );
  assert.deepEqual(classifyMaintenanceConfig(shouted).unpinned, []);
  const wrongTaskCase = parseGitConfigList(PINNED_LIST.replace("maintenance.gc.enabled\nfalse", "maintenance.GC.enabled\nfalse"));
  assert.deepEqual(
    classifyMaintenanceConfig(wrongTaskCase).unpinned,
    ["gc"],
    "git never reads maintenance.GC.enabled for the gc task, so it pins nothing",
  );

  const notABoolean = parseGitConfigList(
    PINNED_LIST.replace("maintenance.worktree-prune.enabled\nfalse", "maintenance.worktree-prune.enabled\nmaybe"),
  );
  assert.deepEqual(classifyMaintenanceConfig(notABoolean).unpinned, ["worktree-prune"], "a value git cannot read as a boolean is not a pin");

  for (const [value, expected] of [
    ["false", false],
    ["no", false],
    ["off", false],
    ["0", false],
    ["", false],
    ["true", true],
    ["Yes", true],
    ["on", true],
    ["1", true],
  ] as const) {
    assert.equal(gitConfigBool(value), expected, `git reads "${value}" as ${expected}`);
  }
  assert.equal(gitConfigBool(null), true, "a key with no value is true");
  assert.equal(gitConfigBool("maybe"), undefined);

  const nothingPacks = classifyMaintenanceConfig(parseGitConfigList(PINNED_LIST.replace("maintenance.loose-objects.enabled\ntrue\0", "")));
  assert.equal(nothingPacks.severity, "note");
  assert.match(joined(nothingPacks), /nothing packs loose objects on its own/);

  const autoOff = classifyMaintenanceConfig(parseGitConfigList(`${PINNED_LIST}maintenance.auto\nfalse\0`));
  assert.equal(autoOff.severity, "note");
  assert.match(joined(autoOff), /maintenance\.auto is false/);

  // ── 4. The loose-object backlog ────────────────────────────────────────────────────────────────
  const incidentCountObjects =
    "count: 13456\nsize: 179.08 MiB\nin-pack: 85474\npacks: 5\nsize-pack: 186.85 MiB\nprune-packable: 204\ngarbage: 0\nsize-garbage: 0 bytes";
  assert.equal(parseLooseObjectCount(incidentCountObjects), 13456);

  const backlog = classifyLooseObjects(13456);
  assert.equal(backlog.severity, "warn", "13,456 loose objects is far past git's own gc.auto threshold");
  assert.deepEqual(
    backlog.lines.map((line) => line.trim()).filter((line) => line.startsWith("git ")),
    ["git maintenance run --task=loose-objects", "git maintenance run --task=loose-objects"],
    "the backlog is packed by NAMING the task, twice; a bare git maintenance run falls back to a strategy that expires data",
  );

  assert.equal(classifyLooseObjects(LOOSE_OBJECT_ALARM).severity, "ok");
  assert.equal(classifyLooseObjects(LOOSE_OBJECT_ALARM + 1).severity, "warn");
  assert.equal(classifyLooseObjects(parseLooseObjectCount(null)).severity, "unknown", "git failing must never read as zero loose objects");
  assert.equal(
    classifyLooseObjects(parseLooseObjectCount("size: 0 bytes")).severity,
    "unknown",
    "output with no count line is unreadable, never zero",
  );

  // ── 5. Real git: the parser reads what `git config --list -z` actually prints ────────────────
  const dir = mkdtempSync(join(tmpdir(), "phx-git-maintenance-"));
  // The machine's own global and system config must not leak into the answer.
  const emptyGlobal = join(dir, "empty-global-gitconfig");
  writeFileSync(emptyGlobal, "");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: "1" };
  const repo = join(dir, "repo");
  try {
    git(dir, ["init", "--quiet", repo], env);
    const readBack = () => classifyMaintenanceConfig(parseGitConfigList(git(repo, ["config", "--list", "-z"], env)));

    assert.deepEqual(readBack().unpinned, ALL_TASKS, "a fresh repository pins nothing");

    for (const task of ALL_TASKS) git(repo, ["config", `maintenance.${task}.enabled`, "false"], env);
    git(repo, ["config", "maintenance.loose-objects.enabled", "true"], env);
    assert.equal(readBack().severity, "ok", "the pins the report prints must read back as pinned from real git");

    // A hand edit that writes the key with no value: git prints it with no newline and reads it as true.
    appendFileSync(join(repo, ".git", "config"), '[maintenance "rerere-gc"]\n\tenabled\n');
    assert.deepEqual(readBack().unpinned, ["rerere-gc"], "a valueless key from real git must read as enabled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // ── 6. The report actually runs the check, read-only ──────────────────────────────────────────
  const doctor = readFileSync(fileURLToPath(new URL("../scripts/repo-doctor.mjs", import.meta.url)), "utf8");
  const start = doctor.indexOf('console.log("GIT MAINTENANCE (');
  assert.ok(start !== -1, "repo-doctor must print the GIT MAINTENANCE section");
  const end = doctor.indexOf("// ── mutating modes", start);
  assert.ok(end > start, "the GIT MAINTENANCE section must sit in the read-only report, before the mutating modes");
  const section = doctor.slice(start, end);
  for (const call of ["classifyMaintenanceLock(", "classifyMaintenanceConfig(", "classifyLooseObjects("]) {
    assert.ok(section.includes(call), `the GIT MAINTENANCE section must call ${call.slice(0, -1)}`);
  }
  assert.ok(
    section.includes('git(["config", "--list", "-z"])'),
    "the pins must be read with config --list -z: --get-regexp exits 1 on no match, which git() cannot tell from a failure",
  );
  assert.ok(!/process\.exit|exitCode/.test(section), "the section is read-only and never touches the exit code");
}
