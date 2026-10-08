import { readFileSync } from "node:fs";

/**
 * Where a project hook is WIRED. Since 2026-10-08 the PreToolUse hooks live in the dispatch table
 * `.claude/hooks/dispatch.json` (same shape as a settings.json hooks block), and settings.json holds
 * one entry that runs `.claude/hooks/hook-dispatch.mjs` for them all. A test asking "is this guard
 * registered, on which matcher, with which timeout" must read both, or it reads a guard that is wired
 * through the dispatcher as unwired — or, worse, one deleted from the table as still wired.
 */
export const SETTINGS_FILE = ".claude/settings.json";
export const DISPATCH_TABLE_FILE = ".claude/hooks/dispatch.json";
export const DISPATCHER_SCRIPT = "hook-dispatch.mjs";

export type WiredHook = { type?: string; command?: string; timeout?: number; run?: string; shell?: string; statusMessage?: string };
export type WiredGroup = { matcher?: string; hooks?: WiredHook[] };
type HooksFile = { hooks?: Record<string, WiredGroup[]> };

const read = (file: string): HooksFile => JSON.parse(readFileSync(file, "utf8")) as HooksFile;

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
