"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import type { NavigationMode, PhoenixRole } from "@/lib/auth/permissions";
import { resolveDocumentTitle } from "@/lib/navigation/module-title";

// Renames the browser tab to the active module on in-app navigation.
//
// The CLIENT half only. A tab's name on FIRST paint comes from `generateMetadata` in
// the shell layout, which resolves the same address through the same resolver — see
// src/lib/navigation/module-title.ts. Both halves are needed: a client effect cannot
// name a tab that has not run our script yet (a new tab, a bookmark, the history
// list), and a parent layout's `generateMetadata` does not run again on a client
// navigation. They share one resolver so the name never changes as a page settles.
//
// Renders inside a Suspense boundary at both mount sites: `useSearchParams` demands
// one, and `?tab=`/`?action=` is load-bearing here — two sidebar rows can share a
// path and only the query says which of them is lit.
export function DocumentTitleSync({ mode, role }: { mode: NavigationMode; role?: PhoenixRole }) {
  const pathname = usePathname() ?? "";
  const query = useSearchParams()?.toString() ?? "";

  useEffect(() => {
    document.title = resolveDocumentTitle(query ? `${pathname}?${query}` : pathname, mode, role);
  }, [mode, pathname, query, role]);

  return null;
}
