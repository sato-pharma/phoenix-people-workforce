"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { systemIdentity } from "@/config/system-settings";
import { getNavigationSections } from "@/config/system-navigation";
import { getActiveHref, normalizePathnameForMode } from "@/lib/navigation/active-path";
import type { NavigationMode } from "@/lib/auth/permissions";

// Sets the browser tab title to the active page's nav label (e.g. "Command Center ·
// Phoenix Workforce"), so the three identical "Phoenix Workforce" tabs become
// distinguishable. Driven by the SAME nav config as the sidebar, so it covers every
// page (incl. nested detail routes, via the longest-prefix match) without per-page edits.
export function DocumentTitleSync({ mode }: { mode: NavigationMode }) {
  const pathname = normalizePathnameForMode(usePathname() ?? "", mode);

  useEffect(() => {
    const brand = systemIdentity.appName;
    const sections = getNavigationSections(mode);
    const activeHref = getActiveHref(pathname, sections, null);
    const label = sections
      .flatMap((section) => section.items)
      .find((item) => item.href === activeHref)?.label;
    document.title = label ? `${label} · ${brand}` : brand;
  }, [mode, pathname]);

  return null;
}
