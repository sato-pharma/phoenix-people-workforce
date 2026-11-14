// What the secrets sync may write to production, decided BEFORE it writes anything.
//
// WHY THIS EXISTS. Until 14 November 2026 scripts/sync-railway-production-secrets.mjs wrote every
// non-empty GitHub value over Railway's without looking at what Railway held. The workflow fires on
// any push to `main` that touches the workflow or the script, so an unrelated edit to either file was
// enough to run it. On 13 November 2026 such a push (run 43454705003) copied a GitHub secret last
// updated on 4 November over the GitHub dispatch token that had been set on Railway alone on
// 7 November. Production lost its working token, and the workflow watch and the synthetic journeys
// were stranded for nine hours. The same mechanism had already reverted HR_NOTIFICATION_EMAILS
// (13 September to 13 October 2026) and CRON_SECRET (14 August 2026).
//
// THE RULE. The sync can add, and it can confirm, but it cannot replace on its own:
//   - production holds nothing under the name        -> write it (a new variable, or a lost one);
//   - production holds the same value                -> leave it (nothing to do);
//   - production holds a DIFFERENT value             -> HOLD it, write nothing, and say so by name;
//   - a different value whose name a person passed   -> write it (`--overwrite=NAME,NAME`).
//
// A difference has two readings the script cannot tell apart: GitHub was rotated and production is
// behind, or production was fixed by hand and GitHub is behind. Only the first is safe to act on, so
// the choice is a person's, made per name.
//
// Pure on purpose: no process, no network, no logging, and no value ever returned in a message.
// tests/railway-secret-policy.test.ts section 11 drives it directly.

/**
 * Railway's `variable list --json` answer as a name -> value map. The CLI has answered in three
 * shapes over time (a plain object, `{ variables: {...} }`, and a list of `{ name, value }`).
 *
 * @param {unknown} payload
 * @returns {Map<string, string>}
 */
export function railwayValuesByName(payload) {
  /** @type {Array<{ name?: unknown, key?: unknown, value?: unknown, rawValue?: unknown }>} */
  let rows = [];
  if (Array.isArray(payload)) {
    rows = payload;
  } else if (payload && typeof payload === "object") {
    const inner = /** @type {{ variables?: unknown }} */ (payload).variables;
    if (Array.isArray(inner)) rows = inner;
    else if (inner && typeof inner === "object") rows = Object.entries(inner).map(([name, value]) => ({ name, value }));
    else rows = Object.entries(payload).map(([name, value]) => ({ name, value }));
  }
  const values = new Map();
  for (const row of rows) {
    const name = row?.name ?? row?.key;
    const value = row?.value ?? row?.rawValue;
    if (typeof name === "string" && value !== undefined && value !== null) values.set(name, String(value));
  }
  return values;
}

/**
 * The names a person released for overwriting, from `--overwrite=A,B` (repeatable).
 *
 * A bare `--overwrite` with no `=` is refused rather than read as "everything": releasing every
 * held value at once is exactly the unconditional write this module replaced.
 *
 * @param {string[]} argv
 * @returns {{ names: string[], problems: string[] }}
 */
export function parseOverwriteNames(argv) {
  const names = [];
  const problems = [];
  for (const arg of argv) {
    if (arg === "--overwrite") {
      problems.push("--overwrite needs the names it releases: --overwrite=NAME,NAME");
      continue;
    }
    if (!arg.startsWith("--overwrite=")) continue;
    for (const name of arg.slice("--overwrite=".length).split(",")) {
      const trimmed = name.trim();
      if (trimmed && !names.includes(trimmed)) names.push(trimmed);
    }
  }
  return { names, problems };
}

/**
 * @typedef {{ railway: string, github: string[], required: boolean }} SyncEntry
 * @typedef {{ entry: SyncEntry, value: string, reason: "new" | "released" }} PlannedWrite
 */

/**
 * Decide, for every synced variable, whether it is written, left, held or skipped.
 *
 * @param {object} input
 * @param {SyncEntry[]} input.entries          the sync's own variable list
 * @param {(names: string[]) => string} input.githubValueOf  the trimmed GitHub value, "" when none
 * @param {Map<string, string>} input.railwayValues          what production holds now
 * @param {string[]} [input.overwrite]          Railway names a person released for overwriting
 * @returns {{
 *   writes: PlannedWrite[],
 *   unchanged: string[],
 *   held: string[],
 *   skippedEmpty: SyncEntry[],
 *   missingRequired: SyncEntry[],
 *   unknownOverwrite: string[],
 *   unusedOverwrite: string[],
 * }}
 */
export function planSecretSync({ entries, githubValueOf, railwayValues, overwrite = [] }) {
  const known = new Set(entries.map((entry) => entry.railway));
  const released = new Set(overwrite);
  const plan = {
    writes: /** @type {PlannedWrite[]} */ ([]),
    unchanged: /** @type {string[]} */ ([]),
    held: /** @type {string[]} */ ([]),
    skippedEmpty: /** @type {SyncEntry[]} */ ([]),
    missingRequired: /** @type {SyncEntry[]} */ ([]),
    unknownOverwrite: overwrite.filter((name) => !known.has(name)),
    unusedOverwrite: /** @type {string[]} */ ([]),
  };

  for (const entry of entries) {
    const value = githubValueOf(entry.github);
    if (!value) {
      (entry.required ? plan.missingRequired : plan.skippedEmpty).push(entry);
      continue;
    }
    const current = (railwayValues.get(entry.railway) ?? "").trim();
    if (!current) {
      plan.writes.push({ entry, value, reason: "new" });
    } else if (current === value) {
      plan.unchanged.push(entry.railway);
      if (released.has(entry.railway)) plan.unusedOverwrite.push(entry.railway);
    } else if (released.has(entry.railway)) {
      plan.writes.push({ entry, value, reason: "released" });
    } else {
      plan.held.push(entry.railway);
    }
  }
  return plan;
}
