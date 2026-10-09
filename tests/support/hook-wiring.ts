import { readFileSync } from "node:fs";

/**
 * Where a project hook is WIRED. Since 2026-10-08 the PreToolUse hooks live in the dispatch table
 * `.claude/hooks/dispatch.json` (same shape as a settings.json hooks block), and settings.json holds
 * one entry that runs `.claude/hooks/hook-dispatch.mjs` for them all. A test asking "is this guard
 * registered, on which matcher, with which timeout" must read both, or it reads a guard that is wired
 * through the dispatcher as unwired — or, worse, one deleted from the table as still wired.
 *
 * TWO SPELLINGS OF ONE ENTRY (2026-10-09, hook speed fixes). settings.json now runs its node hooks in
 * exec form — `"command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/x.mjs", "start"]` —
 * which Claude Code spawns with no shell, instead of `node "${CLAUDE_PROJECT_DIR}/…" start` through Git
 * Bash (52 ms against 109 ms a call, measured; more under load). Every test below asks "which hook does
 * this entry run", so the helpers hand back ONE string for either spelling — `commandOf`, the same
 * fold the dispatcher applies to an `args` entry in its own table — and keep the raw `command` /
 * `args` alongside for the tests that check the spelling itself.
 */
export const SETTINGS_FILE = ".claude/settings.json";
export const DISPATCH_TABLE_FILE = ".claude/hooks/dispatch.json";
export const DISPATCHER_SCRIPT = "hook-dispatch.mjs";

export type WiredHook = {
  type?: string;
  /** The folded command line: `node "<script>" arg …` for an exec-form entry, the string as written otherwise. */
  command?: string;
  /** The `command` field exactly as written (`"node"` for an exec-form entry). */
  rawCommand?: string;
  args?: string[];
  async?: boolean;
  timeout?: number;
  run?: string;
  shell?: string;
  statusMessage?: string;
};
export type WiredGroup = { matcher?: string; hooks?: WiredHook[] };
type HooksFile = { hooks?: Record<string, WiredGroup[]> };

/**
 * One command line for either spelling. Mirrors `commandOf` in `.claude/hooks/hook-dispatch.mjs`, so
 * an entry reads the same here as it does to the dispatcher.
 */
export function commandOf(hook: { command?: string; args?: unknown[] }): string | undefined {
  if (!Array.isArray(hook?.args) || !hook.args.length) return hook?.command;
  const quote = (a: string) => (/^[\w./:-]+$/.test(a) ? a : JSON.stringify(a));
  const [first, ...rest] = hook.args.map(String);
  if (hook.command === "node" && /\.mjs$/.test(first)) return [`node "${first}"`, ...rest.map(quote)].join(" ");
  return [hook.command, ...hook.args.map((a) => quote(String(a)))].join(" ");
}

const read = (file: string): HooksFile => {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as HooksFile;
  for (const groups of Object.values(parsed.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const hook of group.hooks ?? []) {
        hook.rawCommand = hook.command;
        hook.command = commandOf(hook);
      }
    }
  }
  return parsed;
};

/** settings.json's own groups for `event`, the dispatcher's entry included. */
export function settingsHookGroups(event: string): WiredGroup[] {
  return read(SETTINGS_FILE).hooks?.[event] ?? [];
}

/** The dispatch table's groups for `event`. */
export function dispatchedHookGroups(event: string): WiredGroup[] {
  return read(DISPATCH_TABLE_FILE).hooks?.[event] ?? [];
}

/**
 * Every group that names a real hook for `event`: settings.json's own (minus the dispatcher's
 * entry, which runs the table rather than a guard) plus the dispatch table's.
 */
export function wiredHookGroups(event: string): WiredGroup[] {
  const own = settingsHookGroups(event).filter(
    (group) => !(group.hooks ?? []).some((hook) => (hook.command ?? "").includes(DISPATCHER_SCRIPT)),
  );
  return [...own, ...dispatchedHookGroups(event)];
}

/** Every event in either file. */
export function wiredHookEvents(): string[] {
  return [...new Set([...Object.keys(read(SETTINGS_FILE).hooks ?? {}), ...Object.keys(read(DISPATCH_TABLE_FILE).hooks ?? {})])];
}
