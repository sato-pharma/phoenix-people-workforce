// Whether git's own maintenance runs in this repository, and whether it is allowed to delete state
// that every session shares.
//
// WHY THIS EXISTS. On 2026-09-17 an audit found `objects/maintenance.lock` in the common git
// directory, empty and dated 2026-08-10 18:31 Cairo: the leftover of a maintenance run that never
// finished cleanly. While that file exists, every `git maintenance run` does NOTHING and exits 0
// without printing a word. Measured the same day on git 2.55.0.windows.3, in a throwaway
// repository, for the automatic run that commits start AND for a run typed by hand with an explicit
// `--task`. Thirty-eight days of skipped maintenance had left 13,456 loose objects (179 MiB) and
// 396 loose ref files, and the commit-graph was five days stale. Nothing reported any of it: no
// error, no gc.log, no failing exit code. A hygiene report is the only place the stall can surface.
//
// THE OTHER HALF IS WHAT REMOVING THE LOCK LETS RUN. git 2.55's DEFAULT automatic run, measured in
// that throwaway repository, executes `git rerere gc`, which prunes the rerere cache by age. There
// is ONE cache for every worktree and session, which is why the trap index says never to run it.
// The default for a run typed by hand is the geometric strategy, which also expires reflog entries,
// removes worktrees it cannot locate and, on an all-into-one repack, expires unreachable objects.
// This repository therefore pins each of those tasks off by name, and the classifier below reads
// that pin back.
//
// Pure functions over already-read strings and numbers, so a test drives every branch without a
// repository, a lock or a clock. repo-doctor.mjs executes on import and cannot be tested directly.

/** The only staleness window this repo uses for anything left behind by a process (session locks too). */
export const STALE_LOCK_MINUTES = 120;

/**
 * git's own `gc.auto` default: past this many loose objects, stock git would have packed them long
 * ago. A count above it means maintenance has not been running, whatever the reason.
 */
export const LOOSE_OBJECT_ALARM = 6700;

/**
 * The maintenance tasks that delete data, each with what it would take from THIS repository.
 * `git config maintenance.<task>.enabled false` is the pin; an explicit value beats any strategy.
 */
export const DATA_DELETING_TASKS = Object.freeze([
  ["gc", "runs every task below in one go, then prunes unreachable objects"],
  ["geometric-repack", "an all-into-one repack expires unreachable objects already in a cruft pack"],
  ["rerere-gc", "prunes the rerere cache by age, and every worktree and session shares that one cache"],
  ["reflog-expire", "deletes old reflog entries, the record a bad reset or a lost branch tip is recovered from"],
  ["worktree-prune", "removes the registration of any worktree whose folder it cannot find at that moment"],
]);

const NAME_WIDTH = Math.max(...DATA_DELETING_TASKS.map(([task]) => task.length));

const count = (n) => n.toLocaleString("en-US");

/** "2026-08-10 18:31 Cairo". The owner reads times in Cairo local, never UTC. */
export function cairoStamp(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} Cairo`;
}

/**
 * @param {{ lockPath: string, lockMtimeMs: number | null, lockError: string | null, nowMs: number }} input
 *   `lockMtimeMs` null with no `lockError` means the lock does not exist, which is the healthy state.
 *   `lockError` is any stat failure OTHER than "not found", and must never read as "no lock".
 * @returns {{ severity: "ok" | "note" | "alarm" | "unknown", state: string, lines: string[] }}
 */
export function classifyMaintenanceLock({ lockPath, lockMtimeMs, lockError, nowMs }) {
  if (lockError) {
    return {
      severity: "unknown",
      state: "unreadable",
      lines: [`  -> COULD NOT CHECK ${lockPath} (${lockError}). Do NOT read this as clean.`],
    };
  }

  if (lockMtimeMs === null || lockMtimeMs === undefined) {
    return {
      severity: "ok",
      state: "no-lock",
      lines: ["  no maintenance lock: git maintenance is free to run."],
    };
  }

  const ageMinutes = Math.max(0, Math.floor((nowMs - lockMtimeMs) / 60_000));
  if (ageMinutes < STALE_LOCK_MINUTES) {
    return {
      severity: "note",
      state: "running",
      lines: [
        `  a maintenance run holds ${lockPath} (${ageMinutes} min old), which is normal while it runs.`,
        `  -> still there ${STALE_LOCK_MINUTES / 60} hours after it appeared means it is stale: run this report again then.`,
      ],
    };
  }

  const days = Math.floor(ageMinutes / 1440);
  const age = days >= 1 ? `${days} day(s)` : `${Math.floor(ageMinutes / 60)} hour(s)`;
  return {
    severity: "alarm",
    state: "stale-lock",
    lines: [
      `  !! STALE LOCK: git maintenance has done nothing since ${cairoStamp(lockMtimeMs)} (${age}).`,
      `     ${lockPath} is left over from a run that never finished cleanly.`,
      "  -> while it exists EVERY `git maintenance run` does nothing and exits 0, the automatic one",
      "     that commits start and one typed by hand alike, so nothing else will ever report it.",
      "     Pin the data-deleting tasks off FIRST (next check): removing the lock is what lets them",
      "     run. Then confirm no git maintenance or gc process is running, and remove it:",
      `       rm "${lockPath}"`,
    ],
  };
}

/**
 * Parse `git config --list -z`. Entries end in NUL; key and value are split at the FIRST newline,
 * and an entry with no newline is a key written with no value, which git reads as boolean true.
 * Section and variable names are case-insensitive and come back lower-cased here; a subsection
 * (the `<task>` in `maintenance.<task>.enabled`) is case-sensitive and is kept as written. git
 * prints system, then global, then local config, so a later entry for the same key wins.
 *
 * @param {string | null} output
 * @returns {Map<string, string | null> | null} null when the config could not be read at all
 */
export function parseGitConfigList(output) {
  if (typeof output !== "string") return null;
  const config = new Map();
  for (const entry of output.split("\0")) {
    if (entry.trim() === "") continue;
    const newline = entry.indexOf("\n");
    const rawKey = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? null : entry.slice(newline + 1);
    const first = rawKey.indexOf(".");
    const last = rawKey.lastIndexOf(".");
    const key =
      first === last
        ? rawKey.toLowerCase()
        : `${rawKey.slice(0, first).toLowerCase()}${rawKey.slice(first, last)}${rawKey.slice(last).toLowerCase()}`;
    config.set(key, value);
  }
  return config;
}

/**
 * git's boolean reading of a config value: true/yes/on and any non-zero integer are true;
 * false/no/off, 0 and the empty string are false; a key with no value at all (null) is true.
 * Anything else is not a boolean git accepts, and answers undefined so it cannot pass as `false`.
 */
export function gitConfigBool(value) {
  if (value === null) return true;
  if (typeof value !== "string") return undefined;
  const v = value.toLowerCase();
  if (v === "true" || v === "yes" || v === "on") return true;
  if (v === "" || v === "false" || v === "no" || v === "off") return false;
  if (/^[-+]?\d+$/.test(v)) return Number(v) !== 0;
  return undefined;
}

/**
 * @param {Map<string, string | null> | null} config from parseGitConfigList
 * @returns {{ severity: "ok" | "note" | "alarm" | "unknown", state: string, lines: string[], unpinned: string[] }}
 */
export function classifyMaintenanceConfig(config) {
  if (!(config instanceof Map)) {
    return {
      severity: "unknown",
      state: "unreadable",
      unpinned: [],
      lines: ["  -> COULD NOT READ git config, so the maintenance task pins are unknown. Do NOT read this as clean."],
    };
  }

  const unpinned = [];
  for (const [task, why] of DATA_DELETING_TASKS) {
    const key = `maintenance.${task}.enabled`;
    const raw = config.has(key) ? config.get(key) : undefined;
    const enabled = raw === undefined ? undefined : gitConfigBool(raw);
    if (enabled === false) continue;
    const state =
      raw === undefined ? "not set, so git's default decides" : enabled === true ? "enabled" : `not a boolean ("${raw}")`;
    unpinned.push({ task, why, state });
  }

  const notes = [];
  // `has`, never `get(...) ?? "false"`: a key written with no value parses to null, which git reads as TRUE.
  const looseObjectsEnabled = config.has("maintenance.loose-objects.enabled")
    ? gitConfigBool(config.get("maintenance.loose-objects.enabled"))
    : false;
  if (looseObjectsEnabled !== true) {
    notes.push(
      "  note: maintenance.loose-objects.enabled is not true, so nothing packs loose objects on its own:",
      "       git config maintenance.loose-objects.enabled true",
    );
  }
  if (config.has("maintenance.auto") && gitConfigBool(config.get("maintenance.auto")) === false) {
    notes.push(
      "  note: maintenance.auto is false, so no command ever starts maintenance; loose objects pile up",
      "       until someone runs `git maintenance run --task=loose-objects` by hand.",
    );
  }

  if (unpinned.length === 0) {
    return {
      severity: notes.length > 0 ? "note" : "ok",
      state: "pinned",
      unpinned: [],
      lines: [
        `  the ${DATA_DELETING_TASKS.length} data-deleting tasks (${DATA_DELETING_TASKS.map(([task]) => task).join(", ")}) are pinned off.`,
        ...notes,
      ],
    };
  }

  return {
    severity: "alarm",
    state: "unpinned",
    unpinned: unpinned.map((entry) => entry.task),
    lines: [
      `  !! ${unpinned.length} data-deleting maintenance task(s) NOT pinned off:`,
      ...unpinned.flatMap((entry) => [
        `     ${entry.task.padEnd(NAME_WIDTH)}  ${entry.state}`,
        `     ${" ".repeat(NAME_WIDTH)}  ${entry.why}`,
      ]),
      "  -> git 2.55's default automatic run executes `git rerere gc` (measured 2026-09-17). Pin each",
      "     one off. Setting a pin is additive and reversible, and it deletes nothing:",
      ...unpinned.map((entry) => `       git config maintenance.${entry.task}.enabled false`),
      ...notes,
    ],
  };
}

/** The `count:` line of `git count-objects -v`, which is the number of loose objects; null if unreadable. */
export function parseLooseObjectCount(output) {
  if (typeof output !== "string") return null;
  const match = /^count:\s*(\d+)\s*$/m.exec(output);
  return match ? Number(match[1]) : null;
}

/**
 * @param {number | null} looseObjects from parseLooseObjectCount
 * @returns {{ severity: "ok" | "warn" | "unknown", state: string, lines: string[] }}
 */
export function classifyLooseObjects(looseObjects) {
  if (!Number.isInteger(looseObjects) || looseObjects < 0) {
    return {
      severity: "unknown",
      state: "unreadable",
      lines: ["  -> COULD NOT READ `git count-objects -v`. Do NOT read this as clean."],
    };
  }

  if (looseObjects <= LOOSE_OBJECT_ALARM) {
    return {
      severity: "ok",
      state: "within-threshold",
      lines: [`  ${count(looseObjects)} loose object(s), within git's own gc.auto threshold of ${count(LOOSE_OBJECT_ALARM)}.`],
    };
  }

  return {
    severity: "warn",
    state: "backlog",
    lines: [
      `  ! ${count(looseObjects)} loose objects, past git's own gc.auto threshold of ${count(LOOSE_OBJECT_ALARM)}: maintenance`,
      "    has not packed anything for a long time. Check the lock above first.",
      "  -> with the lock gone and the tasks above pinned, pack them by NAMING the task. For any task",
      "     not pinned, a bare `git maintenance run` falls back to git's default for a run typed by",
      "     hand, the geometric strategy, which expires data:",
      "       git maintenance run --task=loose-objects",
      "       git maintenance run --task=loose-objects",
      "     Twice on purpose: the first pass packs them, the second deletes the loose copies it packed.",
    ],
  };
}
