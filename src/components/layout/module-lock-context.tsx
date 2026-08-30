"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { NavigationPermission } from "@/config/system-navigation";
import { isNavItemLockedFor } from "@/lib/navigation/module-catalog";

/**
 * Which modules are locked for THIS viewer, shared with every navigation surface at once.
 *
 * A context rather than a prop because the same answer is needed in four places that do not share a
 * parent below the shell: the sidebar, the mobile drawer (rendered from the Topbar), the two
 * horizontal nav rows, and the command palette. Threading a prop through each would mean four
 * chances for a surface to be forgotten, and a forgotten surface here does not look broken — it
 * looks like an unlocked module, which is the one thing this feature must never show.
 *
 * The value is resolved ONCE per render in AppShell (a server component) and handed down, so no
 * navigation surface fetches anything.
 */

const EMPTY: readonly string[] = [];

const LockedModulesContext = createContext<readonly string[]>(EMPTY);

export function ModuleLockProvider({
  children,
  lockedModuleKeys,
}: {
  children: ReactNode;
  lockedModuleKeys?: readonly string[];
}) {
  const value = useMemo(() => lockedModuleKeys ?? EMPTY, [lockedModuleKeys]);
  return <LockedModulesContext.Provider value={value}>{children}</LockedModulesContext.Provider>;
}

export function useLockedModuleKeys(): readonly string[] {
  return useContext(LockedModulesContext);
}

/**
 * The padlock rule itself lives in `@/lib/navigation/module-catalog` — a React-free `.ts` file, so
 * the Node test harness can exercise it. Re-exported here because every navigation surface reaches
 * for it alongside the hook, and a second import line is a second thing to forget.
 */
export { isNavItemLockedFor };

export function useIsNavItemLocked(item: {
  href?: string;
  permissions?: readonly NavigationPermission[];
}): boolean {
  const lockedModuleKeys = useLockedModuleKeys();
  const permissions = item.permissions;
  const href = item.href;
  return useMemo(
    () => isNavItemLockedFor({ href, permissions }, lockedModuleKeys),
    [href, lockedModuleKeys, permissions],
  );
}
