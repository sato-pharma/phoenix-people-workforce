"use client";

import { CornerDownLeft, Search as SearchIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import type { PermissionLookup } from "@/components/layout/sidebar";
import { announceRouteTransition } from "@/components/layout/route-transition-provider";
import { getNavigationSections, hubPageItemGroups } from "@/config/system-navigation";
import type { NavigationMode, PhoenixRole } from "@/lib/auth/permissions";
import { getSections, permissionAllowed, roleAllowed, roleNotExcluded } from "@/lib/navigation/active-path";

/** Custom event the topbar (or anything else) can dispatch to open the palette. */
export const COMMAND_PALETTE_EVENT = "phoenix:command-palette";

type PaletteItem = { href: string; icon: LucideIcon; label: string; section: string };

export function CommandPalette({
  navigationMode,
  permissionLookup,
  effectiveModuleIds,
  currentRole,
  isSystemAdministratorWorkspace = false,
}: {
  effectiveModuleIds?: readonly string[] | null;
  navigationMode: NavigationMode;
  permissionLookup: PermissionLookup;
  isSystemAdministratorWorkspace?: boolean;
  currentRole?: PhoenixRole;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(false);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const sidebarItems = getSections(
      getNavigationSections(navigationMode),
      navigationMode,
      permissionLookup,
      currentRole,
      effectiveModuleIds,
      isSystemAdministratorWorkspace,
    ).flatMap((section) =>
      section.items.map((item) => ({ href: item.href, icon: item.icon, label: item.label, section: section.label })),
    );

    // The sidebar collapses most admin sections into a single hub button, so a
    // search bar built only from `sidebarItems` would surface hub buttons but
    // hide every module they lead to. Fold each hub's own card list back in
    // (filtered by the same permission/role gates the hub page itself applies)
    // so Cmd/Ctrl+K can still jump directly to any module, not just what's
    // currently rendered in the collapsed sidebar.
    const seenHrefs = new Set(sidebarItems.map((item) => item.href));
    const hubItems: PaletteItem[] =
      navigationMode === "admin"
        ? hubPageItemGroups.flatMap((group) =>
            group.items
              .filter(
                (item) =>
                  isSystemAdministratorWorkspace ||
                  (permissionAllowed(permissionLookup, item.permissions) &&
                    roleAllowed(currentRole, item.roles) &&
                    roleNotExcluded(currentRole, item.excludedRoles)),
              )
              .filter((item) => !seenHrefs.has(item.href))
              .map((item) => ({ href: item.href, icon: item.icon, label: item.label, section: group.label })),
          )
        : [];

    return [...sidebarItems, ...hubItems];
  }, [currentRole, effectiveModuleIds, isSystemAdministratorWorkspace, navigationMode, permissionLookup]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) => item.label.toLowerCase().includes(q) || item.section.toLowerCase().includes(q),
    );
  }, [items, query]);

  // Mirror `open` into a ref so the keydown handler can read the latest value without re-binding.
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Global open shortcut (Cmd/Ctrl+K) + custom event from the topbar search.
  // setState lives inside the event callbacks (not the effect body), so opening always starts clean.
  useEffect(() => {
    function reveal() {
      previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setActiveIndex(0);
      setOpen(true);
    }
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (openRef.current) setOpen(false);
        else reveal();
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(COMMAND_PALETTE_EVENT, reveal);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(COMMAND_PALETTE_EVENT, reveal);
    };
  }, []);

  // Focus the input once the palette is shown (DOM side-effect only — no state writes).
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(id);
  }, [open]);

  // Restore focus to whatever was focused before the palette opened (DOM side-effect only).
  useEffect(() => {
    if (open) return;
    previouslyFocusedRef.current?.focus?.();
  }, [open]);

  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function go(href: string) {
    setOpen(false);
    announceRouteTransition(href);
    router.push(href);
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[activeIndex];
      if (item) go(item.href);
    }
  }

  // Keep Tab focus inside the dialog while it is open.
  function onTrapKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'input, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  return (
    <div
      aria-label="Command palette"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]"
      role="dialog"
    >
      <button
        aria-label="Close command palette"
        className="absolute inset-0 cursor-default bg-slate-950/55 backdrop-blur-sm"
        onClick={() => setOpen(false)}
        type="button"
      />
      <div
        className="relative z-10 w-full max-w-xl overflow-hidden border border-slate-200 bg-white shadow-[0_30px_80px_rgba(15,23,42,0.35)]"
        onKeyDown={onTrapKeyDown}
        ref={panelRef}
      >
        <div className="flex items-center gap-2 border-b border-slate-100 px-4">
          <SearchIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            className="h-12 w-full bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Jump to a page or module…"
            ref={inputRef}
            value={query}
          />
          <kbd className="hidden shrink-0 border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 sm:block">
            ESC
          </kbd>
        </div>

        <div className="max-h-[55vh] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">No matches for “{query}”.</p>
          ) : (
            <ul ref={listRef}>
              {filtered.map((item, index) => {
                const Icon = item.icon;
                const active = index === activeIndex;
                return (
                  <li key={`${item.href}-${item.label}`}>
                    <button
                      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${active ? "bg-orange-50" : "hover:bg-slate-50"}`}
                      data-active={active ? "true" : undefined}
                      onClick={() => go(item.href)}
                      onMouseEnter={() => setActiveIndex(index)}
                      type="button"
                    >
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center ${active ? "bg-orange-100 text-orange-600" : "bg-slate-100 text-slate-500"}`}>
                        <Icon aria-hidden="true" className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-slate-900">{item.label}</span>
                        <span className="block truncate text-xs text-slate-400">{item.section}</span>
                      </span>
                      {active ? <CornerDownLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-orange-500" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
          <span>
            {filtered.length} result{filtered.length !== 1 ? "s" : ""}
          </span>
          <span className="hidden items-center gap-1.5 sm:flex">
            <kbd className="border border-slate-200 bg-slate-50 px-1.5 py-0.5">↑</kbd>
            <kbd className="border border-slate-200 bg-slate-50 px-1.5 py-0.5">↓</kbd>
            <span className="mr-1">navigate</span>
            <kbd className="border border-slate-200 bg-slate-50 px-1.5 py-0.5">↵</kbd>
            <span>open</span>
          </span>
        </div>
      </div>
    </div>
  );
}
