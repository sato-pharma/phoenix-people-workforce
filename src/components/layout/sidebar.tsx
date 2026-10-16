"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Phoenix Workforce — Admin & Portal navigation sidebar
//
// One component drives two surfaces (decided by `navigationMode`):
//   • "admin"           → deep-navy "command" chrome that matches the CEO hero
//                         identity card gradient (#0B1120 → #111C32 → #0A1A3A),
//                         with a streamlined smart toolkit: module search, grouped
//                         collapsible sections, collapse-to-icon-rail, and
//                         drag-and-drop reordering of sections and modules.
//   • "employee-portal" → a calm, light grouped-navigation list.
//
// Everything visual lives here; the *data* (links, icons, permissions, roles) is the
// single source of truth in `@/config/system-navigation`. Visibility is filtered by
// the same permission/role gating the API enforces — the sidebar is UX, never the
// security boundary. The active-path matcher below intentionally special-cases a few
// query-param routes (tab=/action=) so highlighting stays correct.
// ─────────────────────────────────────────────────────────────────────────────

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowUpRight,
  ChevronRight,
  GripVertical,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Search,
  ShieldCheck,
  Star,
  X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { type CSSProperties, Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { ApprovalNavBadge } from "@/components/layout/nav-badge";
import { useIsNavItemLocked } from "@/components/layout/module-lock-context";
import {
  getNavigationSections,
  navigationHomePathByMode,
  type NavigationSection,
  type NavigationSectionItem,
} from "@/config/system-navigation";
import { systemAssets, systemIdentity, systemUiText } from "@/config/system-settings";
import { domainIdForHref, groupAdminSections, sectionsAsDrawers } from "@/lib/navigation/sidebar-domains";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { type NavigationMode, type PhoenixRole } from "@/lib/auth/permissions";
import {
  getActiveHref,
  getSections,
  normalizePathnameForMode,
  usesAdminChrome,
  usesFlatSidebar,
  usesSectionDrawers,
  type PermissionLookup,
} from "@/lib/navigation/active-path";
import { applyPersonalLayout, type PersonalNavigationLayout } from "@/lib/navigation/personal-layout";
import { cn } from "@/lib/utils";

// ── Shared admin palette — matches the top navigation bar exactly ────────────
const ADMIN_SIDEBAR_BG = "bg-[#000000]";
const ADMIN_SIDEBAR_BORDER = "border-[#1a1a1a]";

// ── Public types ─────────────────────────────────────────────────────────────
export type { PermissionLookup };
const EMPTY_PERMISSION_LOOKUP: PermissionLookup = {};

// localStorage keys
const COLLAPSED_KEY_PREFIX = "phoenix-sidebar-collapsed-v2";
const COLLAPSED_EVENT = "phoenix-sidebar-collapsed-change";
const PREFS_EVENT = "phoenix-sidebar-prefs-change";

const SIDEBAR_WIDTH_EXPANDED = "w-[272px]";
const SIDEBAR_WIDTH_RAIL = "w-[76px]";

// ── Persistence: collapsed-section set (cross-tab synced) ─────────────────────
function collapsedStorageKey(mode: NavigationMode) {
  return `${COLLAPSED_KEY_PREFIX}:${mode}`;
}

function parseCollapsedIds(raw: string, valid: Set<string>) {
  const out = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return out;
    for (const value of parsed) {
      if (typeof value === "string" && valid.has(value)) out.add(value);
    }
  } catch {
    return new Set<string>();
  }
  return out;
}

function readCollapsedSnapshot(key: string) {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function subscribeCollapsed(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(COLLAPSED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(COLLAPSED_EVENT, onChange);
  };
}

function writeCollapsedIds(key: string, ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(ids)));
    window.dispatchEvent(new Event(COLLAPSED_EVENT));
  } catch {
    // Preferences are optional; storage failures must never block navigation.
  }
}

// ── Persistence: boolean pref (rail collapse) ────────────────────────────────
function prefKey(base: string, mode: NavigationMode) {
  return `phoenix-sidebar-${base}:${mode}`;
}

function readPref(key: string) {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function subscribePrefs(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(PREFS_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(PREFS_EVENT, onChange);
  };
}

function writePref(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new Event(PREFS_EVENT));
  } catch {
    // Preferences are optional; storage failures must never block navigation.
  }
}

function useBooleanPref(key: string): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHydrated(true);
  }, []);

  const snapshot = useSyncExternalStore(
    subscribePrefs,
    () => (hydrated ? readPref(key) : ""),
    () => "",
  );
  return snapshot === "true";
}

// ── Persistence: pinned favourites (ordered list of hrefs, cross-tab synced) ──
const PINS_EVENT = "phoenix-sidebar-pins-change";

function pinsStorageKey(mode: NavigationMode) {
  return `phoenix-sidebar-pins:${mode}`;
}

function readPinsSnapshot(key: string) {
  if (typeof window === "undefined") return "[]";
  try {
    return window.localStorage.getItem(key) ?? "[]";
  } catch {
    return "[]";
  }
}

function parsePins(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function subscribePins(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(PINS_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(PINS_EVENT, onChange);
  };
}

function writePins(key: string, hrefs: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(hrefs));
    window.dispatchEvent(new Event(PINS_EVENT));
  } catch {
    // Favourites are optional; storage failures must never block navigation.
  }
}

// ── Persistence: drag-and-drop order (sections + items per section) ──────────
const ORDER_EVENT = "phoenix-sidebar-order-change";

function sectionOrderKey(mode: NavigationMode) {
  return `phoenix-sidebar-section-order:${mode}`;
}

function itemOrderKey(mode: NavigationMode) {
  return `phoenix-sidebar-item-order:${mode}`;
}

function readOrderSnapshot(key: string) {
  if (typeof window === "undefined") return "null";
  try {
    return window.localStorage.getItem(key) ?? "null";
  } catch {
    return "null";
  }
}

function subscribeOrder(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(ORDER_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(ORDER_EVENT, onChange);
  };
}

function writeOrder(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new Event(ORDER_EVENT));
  } catch {
    // Order is optional; storage failures must never block navigation.
  }
}

function clearSidebarOrder(mode: NavigationMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(sectionOrderKey(mode));
    window.localStorage.removeItem(itemOrderKey(mode));
    window.dispatchEvent(new Event(ORDER_EVENT));
  } catch {}
}

// Apply a saved order on top of the live array. Items missing from the saved order
// (newly added sections/modules) are appended at the end so nothing gets lost.
function applyOrder<T>(items: readonly T[], getId: (item: T) => string, savedOrder: string[] | null): T[] {
  if (!savedOrder || savedOrder.length === 0) return [...items];
  const byId = new Map(items.map((item) => [getId(item), item]));
  const ordered: T[] = [];
  for (const id of savedOrder) {
    const item = byId.get(id);
    if (item !== undefined) {
      ordered.push(item);
      byId.delete(id);
    }
  }
  for (const item of byId.values()) ordered.push(item);
  return ordered;
}

function parseSectionOrder(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((v): v is string => typeof v === "string")) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseItemOrder(raw: string): Record<string, string[]> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const result: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(record)) {
      if (Array.isArray(value) && value.every((v): v is string => typeof v === "string")) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return null;
  }
}

// ── A single navigation entry ────────────────────────────────────────────────
/**
 * The single tab that is styled above all others — the SFE Manager's own overview. Everything
 * else in the sidebar renders in one uniform style; this one carries a standing gradient, a warm
 * ring and a heavier label so it reads as the master tab even when you are elsewhere.
 */
const PREMIUM_NAV_HREF = "/admin/sfe-command-center";

// `standalone` marks an item that IS its section (a section that collapsed to exactly one visible
// entry — see the single-item branch in SortableSectionBlock below). It skips the redundant
// section-header-plus-one-tab chrome and instead renders directly as a button, with a tinted icon
// box + a small "opens a hub" arrow so it still reads as different from an ordinary
// single-destination link.
//
// Flattened on 2026-08-02 (PR #1625) so every row read as one family — an SFE-only brief that
// silently applied to every admin role, leaving Super Admin and CEO unable to tell a button that
// opens a hub of eight pages from one that opens a single page. Restored 2026-08-08 for every role
// that is not on the flat sidebar; the caller decides via `usesFlatSidebar`, so the SFE Manager
// still gets the uniform look.
function NavRow({
  active,
  dark,
  hideIcon = false,
  item,
  onActivate,
  onHover,
  onHoverEnd,
  pinned = false,
  onTogglePin,
  rail,
  standalone = false,
  tiled = false,
}: {
  active: boolean;
  dark: boolean;
  /** Drop the leading icon box. Set inside a domain, where the rows are already grouped. */
  hideIcon?: boolean;
  item: NavigationSectionItem;
  onActivate: () => void;
  onHover?: (rect: DOMRect) => void;
  onHoverEnd?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  rail: boolean;
  standalone?: boolean;
  /**
   * The HR seats' drawer rail (`usesSectionDrawers`): a 28px bevelled tile on a 40px row. The tile
   * is 4px NARROWER than the 32px box `labelBudgetPx` charges, so no label loses width to it.
   */
  tiled?: boolean;
}) {
  const Icon = item.icon;
  // The one tab that outranks the rest. Keyed on href rather than a nav-config flag so the
  // styling cannot be handed to a second "master" tab by editing a list.
  const premium = item.href === PREMIUM_NAV_HREF;
  // A module this account has temporarily lost. The row STAYS — and stays clickable — because
  // hiding it would read as "removed", and because pressing it is how the person learns why: the
  // shell answers the address with the lock notice rather than the page. The padlock replaces the
  // row's own icon, so no label width is spent on it (sidebar label budgets are pinned by
  // tests/sidebar-label-width.test.ts and this row must not start ellipsising).
  const locked = useIsNavItemLocked(item);
  const LeadingIcon = locked ? Lock : Icon;
  // The icon box was the row's height floor: a 28px tile inside 12px of padding made every row
  // 52px, which is what made the admin rail scroll (811px of content in a 770px box). Inside a
  // domain the rows already sit under a title and a heading, so the tile bought nothing for that
  // cost — dropping it takes rows to 39.5px and the rail stops scrolling. Never in `rail` mode,
  // where the icon is the only thing rendered and hiding it would leave an empty strip.
  const dropIcon = hideIcon && !rail;

  return (
    <div
      className="group relative"
      onMouseEnter={rail && onHover ? (event) => onHover(event.currentTarget.getBoundingClientRect()) : undefined}
      onMouseLeave={rail ? onHoverEnd : undefined}
    >
      <Link
        aria-current={active ? "page" : undefined}
        aria-label={rail ? (locked ? `${item.label} — locked` : item.label) : undefined}
        title={locked ? `${item.label} — locked temporarily by the system administrator` : undefined}
        className={cn(
          "relative flex w-full items-center text-phx-md font-semibold transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/60 focus-visible:ring-offset-2",
          dark ? "focus-visible:ring-offset-slate-900" : "focus-visible:ring-offset-white",
          rail ? "justify-center px-0 py-2.5" : tiled ? "gap-2.5 px-2 py-1.5" : "gap-2 px-2 py-2.5",
          // Premium row: the owner's own overview outranks every other tab, so it carries a
          // standing gradient + ring instead of only lighting up when active. Deliberately warmer
          // and heavier than the active state so it still reads as "the top one" when you are
          // somewhere else in the app.
          premium && (dark
            ? "bg-[linear-gradient(90deg,rgba(249,115,22,0.18)_0%,rgba(249,115,22,0.05)_60%,transparent_100%)] text-white ring-1 ring-phx-accent/45 shadow-[0_6px_20px_rgba(249,115,22,0.16),inset_0_1px_0_rgba(255,255,255,0.08)] hover:ring-phx-accent/70"
            : "bg-[linear-gradient(90deg,#FFF4E9_0%,#FFFBF7_70%,#FFFFFF_100%)] text-phx-ink ring-1 ring-[#F9A85E]/60 shadow-[0_6px_18px_rgba(249,115,22,0.13)] hover:ring-phx-accent/70"),
          // The ACTIVE row is where orange gets spent, and almost nowhere else. The owner reversed
          // orange domain headers on 2026-09-04 as "very noisy", and the reason this row is
          // findable at a glance is that it is the only warm thing in a black column — so the
          // wash falls away to nothing across the row rather than filling it. The ring it used to
          // carry is gone: it drew a box around the row and fought the 3px bar that already marks
          // it, which is the more legible of the two signals.
          //
          // The WEIGHT deliberately does not change. Label widths are pinned against a measured
          // snapshot (tests/fixtures/sidebar-label-widths.json) with about 5px of slack, taken at
          // the row's normal weight — so bolding the active label would overflow the budget in a
          // real browser while the test kept passing against the old measurement, and the overflow
          // lands on `truncate`, i.e. an ellipsis, which is barred.
          !premium && (dark
            ? active
              ? "bg-[linear-gradient(90deg,rgba(249,115,22,0.17)_0%,rgba(249,115,22,0.05)_55%,transparent_100%)] text-white"
              : "text-slate-400 hover:bg-white/[0.05] hover:text-white"
            : active
              ? "bg-[linear-gradient(90deg,#FFF1E4_0%,#FFFBF7_65%,transparent_100%)] text-phx-ink"
              : "text-[#5A6678] hover:bg-[#F7F4EF] hover:text-phx-ink"),
          // A shade brighter at rest on the HR drawer rail: under a tile the label is the second
          // thing read, and slate-400 on black read as disabled beside the lit tile.
          tiled && dark && !active && !premium && "text-slate-300",
        )}
        href={item.href}
        onClick={onActivate}
      >
        {active && <span aria-hidden="true" className="absolute bottom-1.5 left-0 top-1.5 w-[3px] bg-phx-accent" />}
        {!dropIcon && (
        <span
          className={cn(
            "relative flex shrink-0 items-center justify-center transition-colors duration-150",
            tiled ? "h-7 w-7" : "h-8 w-8",
            // `premium` outranks everything; then the active state; then `standalone`, which tints
            // the icon box so a hub button reads as different from a single-destination link.
            premium
              ? "bg-[linear-gradient(180deg,#FDBA74_0%,#F97316_55%,#EA580C_100%)] text-white shadow-[0_10px_22px_rgba(249,115,22,0.45)] ring-1 ring-white/25"
              : dark
                ? active
                  ? "bg-[linear-gradient(180deg,#FB923C_0%,#F97316_100%)] text-white shadow-[0_8px_16px_rgba(249,115,22,0.32)]"
                  : standalone
                    ? "bg-orange-500/15 text-[#F8B56B] ring-1 ring-orange-400/30 group-hover:ring-orange-400/50"
                    : tiled
                      // Bevelled, never orange: a lit top edge over a falling wash gives the tile
                      // depth, and the accent stays spent on the active row alone.
                      ? "bg-[linear-gradient(180deg,rgba(255,255,255,0.085)_0%,rgba(255,255,255,0.025)_100%)] text-slate-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_1px_2px_rgba(0,0,0,0.5)] ring-1 ring-white/[0.08] group-hover:text-[#F8B56B] group-hover:ring-white/20"
                      : "bg-white/5 text-slate-400 ring-1 ring-white/10 group-hover:text-[#F8B56B] group-hover:ring-white/20"
                : active
                  ? "bg-phx-accent text-white shadow-[0_8px_16px_rgba(249,115,22,0.28)]"
                  : standalone
                    ? "bg-orange-50 text-phx-accent ring-1 ring-orange-200 group-hover:ring-orange-300"
                    : "bg-white text-phx-ink-soft ring-1 ring-[#EBE4DA] group-hover:text-phx-accent group-hover:ring-phx-accent-line",
            // Last, so it wins over every state above — including `premium` and `active`. A locked
            // row must never look like a live one, whichever tab it is.
            locked && (dark
              ? "bg-amber-500/10 text-amber-300/90 shadow-none ring-1 ring-amber-400/30"
              : "bg-amber-50 text-amber-600 shadow-none ring-1 ring-amber-200"),
          )}
        >
          <LeadingIcon className={tiled ? "h-[15px] w-[15px]" : "h-4 w-4"} />
          {rail && <ApprovalNavBadge compact dark={dark} navBadge={item.navBadge} />}
        </span>
        )}
        {!rail && (
          <span className={cn("flex min-w-0 flex-1 items-center gap-1.5", onTogglePin && "pr-6")}>
            <span
              className={cn(
                "min-w-0 flex-1 truncate tracking-[-0.01em]",
                premium && "font-black tracking-[0.005em]",
                // Muted, never struck through or greyed to unreadable: the person still has to be
                // able to read which module it is in order to ask for it back.
                locked && "opacity-70",
                // With no icon box there is no amber tile to carry "locked", so the label carries
                // it instead. Losing the padlock entirely would leave a locked module looking
                // merely faint, which reads as a rendering glitch rather than as a lock.
                dropIcon && locked && (dark ? "text-amber-300/90" : "text-amber-600"),
              )}
            >
              {item.label}
            </span>
            {/* Trailing, never leading: the whole point of dropping the icon was to put every
                label on one left edge, so the lock is the one thing allowed back — on the right. */}
            {dropIcon && locked && (
              <Lock
                aria-hidden="true"
                className={cn("h-3 w-3 shrink-0", dark ? "text-amber-300/90" : "text-amber-600")}
              />
            )}
            {/* The ↗ marks a hub row, but it is decorative and the badge is not. On a standalone
                row that also carries a pending count the label is left ~98px, and spending 20px of
                that on both adornments is what forced the ellipsis. The badge wins. */}
            {standalone && !item.navBadge && (
              <ArrowUpRight
                aria-hidden="true"
                className={cn("h-3.5 w-3.5 shrink-0", dark ? "text-orange-400/70" : "text-orange-500/70")}
              />
            )}
            <ApprovalNavBadge compact={false} dark={dark} navBadge={item.navBadge} />
          </span>
        )}
      </Link>
      {!rail && onTogglePin ? (
        <button
          aria-label={pinned ? `Unpin ${item.label}` : `Pin ${item.label} to favourites`}
          className={cn(
            "absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center transition",
            pinned ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
            dark ? "text-slate-400 hover:text-[#F8B56B]" : "text-phx-ink-faint hover:text-phx-accent",
          )}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onTogglePin();
          }}
          title={pinned ? "Unpin" : "Pin to favourites"}
          type="button"
        >
          <Star className={cn("h-3.5 w-3.5", pinned && (dark ? "fill-[#F8B56B] text-[#F8B56B]" : "fill-phx-accent text-phx-accent"))} />
        </button>
      ) : null}
    </div>
  );
}

// ── Sortable wrapper for a single nav item (adds drag handle) ─────────────────
function SortableNavRow({
  item,
  active,
  dark,
  dragDisabled,
  hideIcon,
  onActivate,
  onTogglePin,
  pinned,
  tiled,
}: {
  item: NavigationSectionItem;
  active: boolean;
  dark: boolean;
  dragDisabled: boolean;
  hideIcon: boolean;
  onActivate: () => void;
  onTogglePin: () => void;
  pinned: boolean;
  tiled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.href,
    disabled: dragDisabled,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform) ?? undefined,
    transition: transition ?? undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("group/dnd-row relative", isDragging && "opacity-40")}
    >
      {/* Grip handle: appears on hover, overlays the icon box */}
      {!dragDisabled && (
        <button
          aria-label={`Drag to reorder ${item.label}`}
          className={cn(
            "absolute top-1/2 z-20 flex h-8 -translate-y-1/2 cursor-grab items-center justify-center bg-[#000000] text-slate-600 opacity-0 transition hover:text-slate-300 focus-visible:opacity-100 active:cursor-grabbing group-hover/dnd-row:opacity-100",
            // The grip used to overlay the icon box. With no box it would cover the first letters
            // of the label, so it narrows and moves flush to the edge.
            hideIcon ? "left-0 w-5" : tiled ? "left-[8px] w-7" : "left-[8px] w-8",
          )}
          type="button"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}
      <NavRow
        active={active}
        dark={dark}
        hideIcon={hideIcon}
        item={item}
        onActivate={onActivate}
        onTogglePin={onTogglePin}
        pinned={pinned}
        rail={false}
        tiled={tiled}
      />
    </div>
  );
}

// ── Sortable wrapper for an entire section (header + items) ───────────────────
function SortableSectionBlock({
  activeHref,
  collapsedSectionIds,
  dragDisabled,
  flatSidebar,
  hideIcon,
  isAdmin,
  itemOrder,
  navInstanceId,
  onActivate,
  onItemReorder,
  onTogglePin,
  onToggleSection,
  pinnedSet,
  query,
  section,
  sensors,
  sectionDragging,
  tiled,
  transitionsReady,
}: {
  activeHref: string | null;
  collapsedSectionIds: Set<string>;
  dragDisabled: boolean;
  /** True for roles on the flat sidebar (SFE Manager): no headings, no hub-button styling. */
  flatSidebar: boolean;
  /** Drop the leading icon box on every row in this section. True inside a domain. */
  hideIcon: boolean;
  isAdmin: boolean;
  itemOrder: string[] | null;
  navInstanceId: string;
  onActivate: (item: NavigationSectionItem) => void;
  onItemReorder: (newHrefs: string[]) => void;
  onTogglePin: (href: string) => void;
  onToggleSection: (id: string) => void;
  pinnedSet: Set<string>;
  query: string;
  section: NavigationSection;
  sensors: ReturnType<typeof useSensors>;
  sectionDragging: boolean;
  /** The HR seats' drawer rail — every row carries its tile (see NavRow `tiled`). */
  tiled: boolean;
  transitionsReady: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
    disabled: dragDisabled,
  });

  const sectionStyle: CSSProperties = {
    transform: CSS.Transform.toString(transform) ?? undefined,
    transition: transition ?? undefined,
  };

  const hasActive = section.items.some((item) => item.href === activeHref);
  // `section.label &&` — a headerless section has no toggle to reopen it, so a collapsed flag
  // left in localStorage from before the label was removed would hide its items permanently.
  const collapsed = Boolean(section.label) && !query && collapsedSectionIds.has(section.id) && !hasActive;
  const sectionContentId = `${navInstanceId}-${section.id}-items`;

  const orderedItems = useMemo(
    () => applyOrder(section.items, (item) => item.href, itemOrder),
    [section.items, itemOrder],
  );
  const itemHrefs = useMemo(() => orderedItems.map((item) => item.href), [orderedItems]);

  function handleItemDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = itemHrefs.findIndex((h) => h === active.id);
    const newIndex = itemHrefs.findIndex((h) => h === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onItemReorder(arrayMove(itemHrefs, oldIndex, newIndex));
  }

  // A section that resolves to exactly one visible item (e.g. a module hub like
  // "Admin Tools") IS that item — a collapsible header repeating the same label
  // above a single tab reads as a redundant extra click. Skip the header/collapse
  // chrome entirely and render just the item, styled via NavRow's `standalone`
  // treatment so it still reads as different from an ordinary single-destination
  // link. Section-level drag-to-reorder still works via the same overlay-on-hover
  // grip handle SortableNavRow uses for items.
  if (orderedItems.length === 1) {
    const soleItem = orderedItems[0];
    return (
      <div ref={setNodeRef} style={sectionStyle} className={cn("group/single relative mt-4 px-1", isDragging && "opacity-40")}>
        {isAdmin && !dragDisabled && (
          <button
            aria-label={`Drag to reorder ${section.label} section`}
            className={cn(
              "absolute top-1/2 z-20 flex h-8 -translate-y-1/2 cursor-grab items-center justify-center bg-[#000000] text-slate-600 opacity-0 transition hover:text-slate-300 focus-visible:opacity-100 active:cursor-grabbing group-hover/single:opacity-100",
              hideIcon ? "left-0 w-5" : "left-[8px] w-8",
            )}
            type="button"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        )}
        <NavRow
          active={soleItem.href === activeHref}
          dark={isAdmin}
          hideIcon={hideIcon}
          item={soleItem}
          onActivate={() => onActivate(soleItem)}
          onTogglePin={() => onTogglePin(soleItem.href)}
          pinned={pinnedSet.has(soleItem.href)}
          rail={false}
          standalone={!flatSidebar && !tiled}
          tiled={tiled}
        />
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={sectionStyle} className={cn(isDragging && "opacity-40")}>
      {/* Section header — sticky removed while section drag is live to avoid transform+sticky conflict */}
      <div
        className={cn(
          "-mx-3 px-3",
          sectionDragging ? "z-20" : "sticky top-0 z-20",
          isAdmin ? "bg-[#000000]" : "bg-white",
        )}
      >
        {/* A section with no label renders no header at all. An empty label would otherwise
            leave a blank heading bar — a chevron and a drag grip above nothing — which reads
            worse than the title it replaced. The items still render below. */}
        <div className={cn("group/sec-hdr flex items-center", !section.label && "hidden")}>
          {/* Section drag handle (admin only) */}
          {isAdmin && !dragDisabled && (
            <button
              aria-label={`Drag to reorder ${section.label} section`}
              className="flex h-10 w-5 shrink-0 cursor-grab items-center justify-center pl-0.5 text-slate-700 opacity-0 transition hover:text-slate-300 focus-visible:opacity-100 active:cursor-grabbing group-hover/sec-hdr:opacity-100"
              type="button"
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            aria-controls={sectionContentId}
            aria-expanded={!collapsed}
            className={cn(
              "group/sec flex flex-1 items-center gap-1.5 pb-1.5 pt-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/60 focus-visible:ring-offset-2",
              isAdmin && !dragDisabled ? "px-1" : "px-1.5",
              isAdmin ? "focus-visible:ring-offset-slate-900" : "focus-visible:ring-offset-white",
            )}
            onClick={() => onToggleSection(section.id)}
            type="button"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 ease-out",
                transitionsReady && "transition-transform duration-300",
                isAdmin ? "text-slate-400 group-hover/sec:text-slate-200" : "text-phx-ink-soft group-hover/sec:text-phx-ink-2",
                !collapsed && "rotate-90",
              )}
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-phx-md font-bold tracking-[-0.01em]",
                isAdmin ? "text-white" : "text-phx-ink",
              )}
            >
              {section.label}
            </span>
          </button>
        </div>
      </div>

      {/* Items list with its own inner DndContext for item reordering */}
      <div
        aria-hidden={collapsed}
        className={cn(
          "grid ease-[cubic-bezier(0.22,1,0.36,1)]",
          transitionsReady && "transition-[grid-template-rows,opacity] duration-300",
          collapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
        )}
        id={sectionContentId}
      >
        <div className="min-h-0 overflow-hidden">
          <DndContext
            collisionDetection={closestCenter}
            id={`${navInstanceId}-items-${section.id}`}
            sensors={sensors}
            onDragEnd={handleItemDragEnd}
          >
            <SortableContext items={itemHrefs} strategy={verticalListSortingStrategy}>
              <div className="mt-1.5 space-y-1 px-1">
                {orderedItems.map((item) => (
                  <SortableNavRow
                    hideIcon={hideIcon}
                    key={item.href}
                    active={item.href === activeHref}
                    dark={isAdmin}
                    dragDisabled={dragDisabled || !isAdmin}
                    item={item}
                    onActivate={() => onActivate(item)}
                    onTogglePin={() => onTogglePin(item.href)}
                    pinned={pinnedSet.has(item.href)}
                    tiled={tiled}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      </div>
    </div>
  );
}

// ── The navigation brain (search / collapse / rail / drag-and-drop) ───────────
function SidebarNav({
  mode = "admin",
  onNavigate,
  permissionLookup = EMPTY_PERMISSION_LOOKUP,
  currentRole,
  personalLayout = null,
  rail = false,
  scrollable = true,
}: {
  currentRole?: PhoenixRole;
  mode?: NavigationMode;
  onNavigate?: () => void;
  permissionLookup?: PermissionLookup;
  /** This viewer's own saved arrangement, loaded server-side. Null = the code-defined sidebar. */
  personalLayout?: PersonalNavigationLayout | null;
  rail?: boolean;
  scrollable?: boolean;
}) {
  const isAdmin = usesAdminChrome(mode);
  // The SFE Manager keeps the flat sidebar built for him on 2026-08-02 — no section headings and
  // no hub-button styling. Every other role had both restored on 2026-08-08 (owner instruction).
  const flatSidebar = usesFlatSidebar(currentRole);
  const [isClientReady, setIsClientReady] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsClientReady(true);
  }, []);

  // The viewer's own arrangement is applied STRICTLY AFTER getSections, never instead of it.
  // getSections is what does permission and role filtering; applyPersonalLayout only rearranges
  // what came out of it and cannot introduce an href, so a saved layout can never widen access.
  // With no layout saved this is a passthrough and the sidebar is exactly what the code defines.
  //
  // ADMIN MODE ONLY, deliberately. A layout is stored once per person, but this shell also renders
  // in "employee-portal" mode — an employee opening /payslips or /overview resolves to that mode —
  // so applying one document to both navs would let a portal render overwrite the admin
  // arrangement. Nothing is lost by the restriction: the employee portal builds its own sidebar
  // entirely (buildEmployeePortalSections), and system-navigation.ts does not drive it.
  const applied = useMemo(
    () =>
      applyPersonalLayout(
        getSections(
          getNavigationSections(mode),
          mode,
          permissionLookup,
          currentRole,
        ),
        mode === "admin" ? personalLayout : null,
      ),
    [currentRole, mode, permissionLookup, personalLayout],
  );
  const sections = applied.sections;
  // Layer 1 — the pages promoted out of the modules entirely. Rendered above Favourites.
  const stripItems = applied.strip;
  // Normalised to the shell's own URL form: in `hr` mode the nav hrefs are authored under /hr, and
  // whether usePathname() reports the browser path or the middleware-rewritten one is a Next.js
  // detail that has changed between releases. See normalizePathnameForMode.
  const pathname = normalizePathnameForMode(usePathname(), mode);
  const searchParams = useSearchParams();
  const navInstanceId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Derived straight from the URL (not click-only state) so tab-scoped items
  // (e.g. ?tab=queue&action=create-manager-expense) stay highlighted correctly
  // across a page refresh or browser back/forward, not just after a click.
  const activeTab = searchParams.get("action") ?? searchParams.get("tab");
  const [searchQuery, setSearchQuery] = useState("");
  const [railTip, setRailTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const [sectionDragging, setSectionDragging] = useState(false);

  const query = isAdmin && !rail ? searchQuery.trim().toLowerCase() : "";

  const activeHref = getActiveHref(pathname, sections, activeTab);

  const sectionIds = useMemo(() => sections.map((section) => section.id), [sections]);
  const activeSectionId = sections.find((section) => section.items.some((item) => item.href === activeHref))?.id ?? null;

  const collapsedKey = collapsedStorageKey(mode);
  const collapsedSnapshot = useSyncExternalStore(
    subscribeCollapsed,
    () => (isClientReady ? readCollapsedSnapshot(collapsedKey) : ""),
    () => "",
  );
  const collapsedSectionIds = useMemo(() => {
    const next = parseCollapsedIds(collapsedSnapshot, new Set(sectionIds));
    if (activeSectionId) next.delete(activeSectionId);
    return next;
  }, [activeSectionId, collapsedSnapshot, sectionIds]);

  function toggleSection(sectionId: string) {
    const next = new Set(collapsedSectionIds);
    if (next.has(sectionId)) next.delete(sectionId);
    else next.add(sectionId);
    if (activeSectionId) next.delete(activeSectionId);
    writeCollapsedIds(collapsedKey, next);
  }

  // ── Pinned favourites ──────────────────────────────────────────────────────
  const pinsKey = pinsStorageKey(mode);
  const pinsSnapshot = useSyncExternalStore(
    subscribePins,
    () => (isClientReady ? readPinsSnapshot(pinsKey) : "[]"),
    () => "[]",
  );
  const pinnedHrefs = useMemo(() => parsePins(pinsSnapshot), [pinsSnapshot]);
  const pinnedSet = useMemo(() => new Set(pinnedHrefs), [pinnedHrefs]);
  const itemByHref = useMemo(() => {
    const map = new Map<string, NavigationSectionItem>();
    for (const section of sections) for (const item of section.items) map.set(item.href, item);
    return map;
  }, [sections]);
  const pinnedItems = useMemo(
    () => pinnedHrefs.map((href) => itemByHref.get(href)).filter((item): item is NavigationSectionItem => Boolean(item)),
    [pinnedHrefs, itemByHref],
  );
  function togglePin(href: string) {
    const next = pinnedSet.has(href) ? pinnedHrefs.filter((value) => value !== href) : [...pinnedHrefs, href];
    writePins(pinsKey, next);
  }

  function handleActivate(_item: NavigationSectionItem) {
    // Close any active search filter so the just-navigated-to item isn't hidden
    // behind a stale query (the sidebar no longer remounts on navigation, so this
    // state must be cleared explicitly instead of relying on a fresh mount).
    setSearchQuery("");
    onNavigate?.();
  }

  // ── Drag-and-drop order ────────────────────────────────────────────────────
  const secOrderKey = sectionOrderKey(mode);
  const itemOrdKey = itemOrderKey(mode);
  const secOrderSnapshot = useSyncExternalStore(
    subscribeOrder,
    () => (isClientReady ? readOrderSnapshot(secOrderKey) : "null"),
    () => "null",
  );
  const itemOrdSnapshot = useSyncExternalStore(
    subscribeOrder,
    () => (isClientReady ? readOrderSnapshot(itemOrdKey) : "null"),
    () => "null",
  );

  const savedSectionOrder = useMemo(() => parseSectionOrder(secOrderSnapshot), [secOrderSnapshot]);
  const savedItemOrder = useMemo(() => parseItemOrder(itemOrdSnapshot), [itemOrdSnapshot]);

  const hasCustomOrder = savedSectionOrder !== null || savedItemOrder !== null;

  // Drag is disabled during search (filtered view doesn't make sense to reorder)
  // and in rail mode. Non-admin surfaces never get drag.
  // Keep drag interactions off until the client hydrates localStorage-driven prefs.
  const dragDisabled = !isClientReady || !isAdmin || !!query || rail;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const visibleSections = query
    ? sections
        .map((section) => ({ ...section, items: section.items.filter((item) => item.label.toLowerCase().includes(query)) }))
        .filter((section) => section.items.length > 0)
    : sections;

  // A promoted page is no longer in `sections`, so the filter above cannot find it. Searching the
  // strip by the same query is what keeps it reachable — without this, promoting a page to layer 1
  // would quietly make it unsearchable, which is the sort of silent loss nobody reports as a bug.
  const visibleStripItems = query
    ? stripItems.filter((item) => item.label.toLowerCase().includes(query))
    : stripItems;

  // Apply saved section order on top of the visible (permission-filtered) sections.
  // During search, order is bypassed so results are stable.
  const orderedSections = useMemo(
    () => (query ? visibleSections : applyOrder(visibleSections, (s) => s.id, savedSectionOrder)),
    [query, visibleSections, savedSectionOrder],
  );
  const orderedSectionIds = useMemo(() => orderedSections.map((s) => s.id), [orderedSections]);

  // ── Domains ────────────────────────────────────────────────────────────────
  // The admin rail draws its 14 headings inside 7 domains (src/config/sidebar-domains.ts). Off
  // for everything else, and OFF WHILE SEARCHING: a query should sweep every module the viewer
  // has, and an accordion that hides two thirds of the results behind a closed domain would make
  // search quietly worse than the flat list it replaced.
  //
  // The SFE Manager keeps the flat, headless rail (`usesFlatSidebar`) — a domain layer over a
  // deliberately headingless sidebar would reintroduce exactly the chrome that was subtracted.
  const useDomains = isAdmin && !flatSidebar && !rail && !query;
  // The two HR seats draw each SECTION as its own drawer, rows tiled (usesSectionDrawers). The
  // admin domain map knows only admin section ids, so on /hr every section used to fall through to
  // one "More" drawer. Every other role, and the admin rail itself, takes the branch below as before.
  const sectionDrawers = useDomains && usesSectionDrawers(mode, currentRole);
  const domains = useMemo(() => {
    if (!useDomains) return [];
    if (sectionDrawers) {
      return sectionsAsDrawers(applyOrder(visibleSections, (section) => section.id, savedSectionOrder));
    }
    // Grouped from the VISIBLE sections rather than the ordered ones, so a group's rows read in
    // the order sidebar-domains.ts lists them. A saved user order is then applied within each
    // group, which leaves the default untouched (applyOrder returns the input unchanged when
    // nothing is saved) while still honouring a drag the viewer actually made.
    return groupAdminSections(visibleSections).map((domain) => ({
      ...domain,
      groups: domain.groups.map((group) => ({
        ...group,
        sections: applyOrder(group.sections, (section) => section.id, savedSectionOrder),
      })),
    }));
  }, [useDomains, sectionDrawers, visibleSections, savedSectionOrder]);

  const activeDomainId = useMemo(() => domainIdForHref(domains, activeHref), [domains, activeHref]);
  // What the viewer last clicked, REMEMBERED WITH the page it was clicked on. Storing `forActive`
  // is what lets a navigation hand control back to the active page without an effect: once the
  // active domain moves, the stored pick no longer matches and is simply ignored. The obvious
  // alternative — a `useEffect` that resets the pick — is a lint error in this repo (cascading
  // renders), and this needs no reset because nothing is ever out of sync to begin with.
  //
  // `domainId: ""` is a real value and means "the viewer closed it", which is why the fallback
  // reads it with a length check rather than `||`: closing the open domain must leave the rail
  // closed rather than snapping straight back open.
  const [picked, setPicked] = useState<{ domainId: string; forActive: string | null } | null>(null);
  const pickIsCurrent = picked !== null && picked.forActive === activeDomainId;
  // One open at a time. Falls back to the domain holding the current page, then to the first —
  // never to nothing, because a rail showing seven closed buttons and no rows reads as broken.
  const openDomainId = pickIsCurrent
    ? picked.domainId || null
    : (activeDomainId ?? (domains.length > 0 ? domains[0].id : null));

  // One definition, rendered by both paths. Two copies of an 18-prop element is how the grouped
  // rail and the flat one would drift apart without anyone noticing.
  function renderSectionBlock(section: NavigationSection) {
    return (
      <SortableSectionBlock
        hideIcon={useDomains && !sectionDrawers}
        tiled={sectionDrawers}
        key={section.id}
        activeHref={activeHref}
        collapsedSectionIds={collapsedSectionIds}
        dragDisabled={dragDisabled}
        flatSidebar={flatSidebar}
        isAdmin={isAdmin}
        itemOrder={savedItemOrder?.[section.id] ?? null}
        navInstanceId={navInstanceId}
        onActivate={handleActivate}
        onItemReorder={(newHrefs) => handleItemReorder(section.id, newHrefs)}
        onTogglePin={togglePin}
        onToggleSection={toggleSection}
        pinnedSet={pinnedSet}
        query={query}
        section={section}
        sectionDragging={sectionDragging}
        sensors={sensors}
        transitionsReady={isClientReady}
      />
    );
  }

  function handleSectionDragEnd(event: DragEndEvent) {
    setSectionDragging(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = orderedSectionIds.indexOf(active.id as string);
    const newIndex = orderedSectionIds.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    const newOrder = arrayMove(orderedSectionIds, oldIndex, newIndex);
    writeOrder(secOrderKey, newOrder);
  }

  function handleItemReorder(sectionId: string, newHrefs: string[]) {
    const next = { ...(savedItemOrder ?? {}), [sectionId]: newHrefs };
    writeOrder(itemOrdKey, next);
  }

  // ── Scroll comfort: edge fades, auto-scroll to active, remembered position ──
  const navRef = useRef<HTMLElement | null>(null);
  const didRestoreScroll = useRef(false);
  const skipInitialActiveScroll = useRef(true);
  const scrollPersistKey = rail ? null : prefKey("scrollpos", mode);

  const updateFades = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    el.toggleAttribute("data-fade-top", el.scrollTop > 1);
    el.toggleAttribute("data-fade-bottom", el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);

  const handleNavScroll = useCallback(() => {
    updateFades();
    const el = navRef.current;
    if (!el || !scrollPersistKey) return;
    try {
      window.localStorage.setItem(scrollPersistKey, String(Math.round(el.scrollTop)));
    } catch {
      // Persisting scroll is best-effort; never block navigation.
    }
  }, [scrollPersistKey, updateFades]);

  useEffect(() => {
    const el = navRef.current;
    if (!el || didRestoreScroll.current) return;
    didRestoreScroll.current = true;
    let restored = false;
    if (scrollPersistKey) {
      try {
        const saved = Number(window.localStorage.getItem(scrollPersistKey));
        if (Number.isFinite(saved) && saved > 0) {
          el.scrollTop = saved;
          restored = true;
        }
      } catch {
        // ignore unreadable storage
      }
    }
    if (!restored) {
      el.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
    }
    updateFades();
  }, [scrollPersistKey, updateFades]);

  useEffect(() => {
    if (skipInitialActiveScroll.current) {
      skipInitialActiveScroll.current = false;
      return;
    }
    navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
    updateFades();
  }, [activeHref, updateFades]);

  useEffect(() => {
    updateFades();
    window.addEventListener("resize", updateFades);
    return () => window.removeEventListener("resize", updateFades);
  }, [updateFades, visibleSections, collapsedSectionIds]);

  // ── Collapsed icon-rail (admin only) ──────────────────────────────────────
  if (rail) {
    const railItems = sections.flatMap((section) => section.items);
    const showTip = (label: string) => (rect: DOMRect) =>
      setRailTip({ label, top: rect.top + rect.height / 2, left: rect.right + 12 });
    const hideTip = () => setRailTip(null);

    return (
      <>
        <nav ref={navRef} onScroll={handleNavScroll} className={cn("flex-1 px-2 py-4", scrollable && "overflow-auto", scrollable && isAdmin && "phoenix-admin-sidebar-scroll")}>
          <div className="flex flex-col items-center gap-1.5">
            {railItems.map((item) => (
              <NavRow
                active={item.href === activeHref}
                dark
                item={item}
                key={`rail-${item.href}`}
                onActivate={() => handleActivate(item)}
                onHover={showTip(item.label)}
                onHoverEnd={hideTip}
                rail
              />
            ))}
          </div>
        </nav>
        {railTip && (
          <div
            className="pointer-events-none fixed z-[70] -translate-y-1/2 whitespace-nowrap border border-white/10 bg-slate-900 px-2.5 py-1.5 text-phx-sm font-semibold text-white shadow-[0_10px_28px_rgba(2,6,23,0.6)]"
            style={{ left: railTip.left, top: railTip.top }}
          >
            {railTip.label}
          </div>
        )}
      </>
    );
  }

  // ── Expanded sidebar ──────────────────────────────────────────────────────
  return (
    <>
      {isAdmin && (
        <div className="px-3 pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              ref={searchInputRef}
              aria-label="Search modules"
              // 🔴 HIS RULING, 2026-10-06: "keep the dark menus and bands out of the form
              // design too". The admin sidebar is a bare `bg-[#000000]`, so the light form token
              // made this a lit white box in the chrome of every admin page. Dark, verbatim.
              className="h-9 w-full border border-white/10 bg-white/5 pl-9 pr-8 text-phx-md font-semibold text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-phx-accent-line focus:bg-white/[0.08] focus:ring-2 focus:ring-phx-accent/25"
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearchQuery("");
                  event.currentTarget.blur();
                }
              }}
              placeholder={systemUiText.sidebarSearchPlaceholder}
              type="search"
              value={searchQuery}
            />
            {searchQuery && (
              <button
                aria-label="Clear search"
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center text-slate-500 transition hover:text-[#F8B56B]"
                onClick={() => {
                  setSearchQuery("");
                  searchInputRef.current?.focus();
                }}
                type="button"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      <nav
        ref={navRef}
        className={cn("flex-1 px-2 py-4", scrollable && "overflow-auto", scrollable && isAdmin && "phoenix-admin-sidebar-scroll")}
        onScroll={handleNavScroll}
      >
        {/* Layer 1 — pages the viewer promoted out of the modules. Rendered before Favourites and
            never draggable here: the arrangement is edited on its own page, not by dragging the
            live sidebar. This block is what stops a promoted page vanishing — applyPersonalLayout
            removes it from its section, so if nothing rendered `strip` it would be unreachable. */}
        {visibleStripItems.length > 0 && (
          <div className="mb-2 space-y-1 px-1 pt-1">
            {visibleStripItems.map((item) => (
              <NavRow
                active={item.href === activeHref}
                dark={isAdmin}
                item={item}
                key={`strip-${item.href}`}
                onActivate={() => handleActivate(item)}
                onTogglePin={() => togglePin(item.href)}
                pinned={pinnedSet.has(item.href)}
                rail={rail}
              />
            ))}
          </div>
        )}

        {/* Favourites section — fixed position, never draggable */}
        {!query && pinnedItems.length > 0 && (
          <Fragment>
            <div className={cn("sticky top-0 z-20 -mx-3 px-3", isAdmin ? "bg-[#000000]" : "bg-white")}>
              <div className="flex w-full items-center gap-1.5 px-1.5 pb-1.5 pt-3">
                <Star className={cn("h-3.5 w-3.5 shrink-0", isAdmin ? "fill-[#F8B56B] text-[#F8B56B]" : "fill-phx-accent text-phx-accent")} />
                <span className={cn("min-w-0 flex-1 truncate text-phx-md font-bold tracking-[-0.01em]", isAdmin ? "text-white" : "text-phx-ink")}>
                  Favourites
                </span>
              </div>
            </div>
            <div className="mb-2 mt-1.5 space-y-1 px-1">
              {pinnedItems.map((item) => (
                <NavRow
                  active={item.href === activeHref}
                  dark={isAdmin}
                  item={item}
                  key={`fav-${item.href}`}
                  onActivate={() => handleActivate(item)}
                  onTogglePin={() => togglePin(item.href)}
                  pinned
                  rail={false}
                />
              ))}
            </div>
          </Fragment>
        )}

        {/* Sections — wrapped in DndContext for section-level reordering */}
        <DndContext
          collisionDetection={closestCenter}
          id={`${navInstanceId}-sections`}
          sensors={sensors}
          onDragEnd={handleSectionDragEnd}
          onDragStart={() => setSectionDragging(true)}
          onDragCancel={() => setSectionDragging(false)}
        >
          {useDomains ? (
            domains.map((domain) => {
              const open = openDomainId === domain.id;
              const DomainIcon = domain.icon;
              // A one-row section on the HR drawer rail IS its row: a drawer that opens onto a
              // single link is an extra click that says nothing, so the row stands on its own.
              const soleRow = sectionDrawers && domain.rowCount === 1 ? domain.groups[0]?.sections[0]?.items[0] : undefined;
              if (soleRow) {
                return (
                  <div key={domain.id} className="border-b border-white/[0.06] px-1 py-1.5 last:border-b-0">
                    <NavRow
                      active={soleRow.href === activeHref}
                      dark
                      item={soleRow}
                      onActivate={() => handleActivate(soleRow)}
                      onTogglePin={() => togglePin(soleRow.href)}
                      pinned={pinnedSet.has(soleRow.href)}
                      rail={false}
                      tiled
                    />
                  </div>
                );
              }
              return (
                // The open domain reads as a raised container rather than as a header that
                // happened to expand: a barely-there wash, a 2px edge, and its own hairline
                // suppressed so the block runs into the rows it owns. All of it is absolute or a
                // background, so it costs ZERO height — every row keeps its 39.5px.
                //
                // The edge is NEUTRAL, not orange, and that is the whole point of it. Orange is
                // spent on the active row alone — that is what makes one row findable in a black
                // column. An orange edge here runs down the very same 3px gutter the active row's
                // bar uses, so the two collide and the bar stops reading as "this one": measured
                // in the harness, the domain edge drew a continuous orange line past every row in
                // the open domain. White at 12% gives the container its edge and costs nothing.
                <div
                  key={domain.id}
                  className={cn(
                    "relative border-b border-white/[0.06] transition-colors last:border-b-0",
                    open && "border-b-transparent bg-white/[0.022]",
                  )}
                >
                  {open && (
                    <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-white/[0.12]" />
                  )}
                  <button
                    aria-expanded={open}
                    className="group/dom flex w-full items-center gap-2 px-1.5 py-2.5 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                    onClick={() =>
                      setPicked({ domainId: open ? "" : domain.id, forActive: activeDomainId })
                    }
                    type="button"
                  >
                    <span
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center border transition-colors",
                        open
                          ? "border-phx-accent/45 bg-phx-accent/[0.18] text-phx-accent"
                          : "border-white/[0.07] bg-white/[0.04] text-slate-400 group-hover/dom:border-white/[0.16] group-hover/dom:text-slate-200",
                        // The HR drawer rail: the same tile, bevelled like its rows. No glow — the
                        // open tile's accent fill is already the one warm mark a closed rail carries.
                        sectionDrawers && "shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_1px_2px_rgba(0,0,0,0.5)]",
                      )}
                    >
                      <DomainIcon className="h-4 w-4" />
                    </span>
                    {/* Wraps rather than truncating: the owner's rule is no ellipsis, and a domain
                        name is the one label a viewer cannot look up anywhere else.

                        One line, not two. The kicker above the name ("Company" over Overview,
                        "Decisions" over Requests) was a second vocabulary for the same thing, and
                        the less useful of the two words. Measured on the running rail, the seven
                        headers cost 381.5px against 312px for the six rows they exist to serve —
                        the chrome outweighed the content and the rail still scrolled. Dropping the
                        kicker takes each header from 54.5px to roughly 36px.

                        COLOURED, on all seven, open or closed (owner, 2026-09-05: "those big titles,
                        I want them to be coloured — a different colour than the subtitles that appear
                        when I expand the big titles").

                        THE ACCENT, matching the icon tile beside it (owner, 2026-09-05: "make the
                        colour of the big titles the same colour of the box beside it, which is I
                        don't know maroon or what" — the box is that tile, `bg-phx-accent/[0.18]`,
                        which is what 18% of #f97316 over this near-black reads as). A champagne
                        title was tried first and this replaced it on his instruction.

                        It goes against the 2026-09-04 reversal, where an orange header lasted an
                        hour before he called it "very noisy" — but that was the whole header block
                        in orange, and this is the name alone. He asked for it after seeing the
                        alternative, so it stands until he says otherwise.

                        The rail is three levels and each reads as a different colour — title accent
                        at 13px bold, group heading the dimmest grey at 10px caps, rows a mid grey at
                        13px. Open state is carried by the tile fill and the chevron, so the title
                        colour is free to be constant across all seven. */}
                    <span className="min-w-0 flex-1 text-phx-md font-bold tracking-[-0.01em] text-phx-accent">
                      {domain.name}
                    </span>
                    <span className="shrink-0 border border-white/[0.07] bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none text-slate-400">
                      {domain.rowCount}
                    </span>
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-slate-500 ease-out",
                        isClientReady && "transition-transform duration-300",
                        open && "rotate-90",
                      )}
                    />
                  </button>

                  {open &&
                    domain.groups.map((group) => (
                      <SortableContext
                        // Keyed on the first section, not the heading: a heading that repeats a
                        // row is blanked, and two blanks in one domain would collide.
                        key={group.sections[0]?.id ?? group.heading}
                        items={group.sections.map((section) => section.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {group.heading !== "" && (
                          <div className="flex items-center gap-2 px-1.5 pb-1 pt-3">
                            <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-500">
                              {group.heading}
                            </p>
                            <span aria-hidden="true" className="h-px flex-1 bg-white/[0.07]" />
                          </div>
                        )}
                        {group.sections.map((section) =>
                          renderSectionBlock(
                            // The GROUP owns the heading now, so the section drops its own. This
                            // is the whole point of the merge: 24 of the 37 admin sections held a
                            // single row whose label repeated the heading right above it.
                            { ...section, label: "" },
                          ),
                        )}
                      </SortableContext>
                    ))}
                </div>
              );
            })
          ) : (
            <SortableContext items={orderedSectionIds} strategy={verticalListSortingStrategy}>
              {orderedSections.map((section) => renderSectionBlock(section))}
            </SortableContext>
          )}
        </DndContext>

        {isAdmin && query && visibleSections.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
            <span className="flex h-12 w-12 items-center justify-center bg-phx-accent/10 text-phx-accent ring-1 ring-phx-accent/25">
              <Search className="h-5 w-5" />
            </span>
            <div>
              <p className="text-phx-md font-semibold text-slate-100">No modules match</p>
              <p className="mt-1 text-phx-xs text-slate-500">Try a different search term.</p>
            </div>
          </div>
        )}

        {/* Reset order button — visible only when user has a custom order saved */}
        {isAdmin && !query && hasCustomOrder && (
          <div className="mt-4 px-1">
            <button
              className="flex w-full items-center gap-2 px-1.5 py-1.5 text-phx-xs font-semibold text-slate-600 transition hover:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/60"
              onClick={() => clearSidebarOrder(mode)}
              title="Reset sidebar to default order"
              type="button"
            >
              <RotateCcw className="h-3 w-3" />
              Reset sidebar order
            </button>
          </div>
        )}
      </nav>
    </>
  );
}

// ── Brand / logo header ──────────────────────────────────────────────────────
/**
 * Roles whose sidebar logo returns them to their own command center rather than the admin
 * shell's generic home. `navigationHomePathByMode.admin` is `/admin/access`, and that page
 * hard-asserts `admin_access:read` — a grant neither of these roles holds — so sending them
 * there renders an error card instead of a home page. Their landing page IS their home.
 * Keep this list in sync with the dedicated command-center entries in resolveLandingPathForRole.
 */
const commandCenterHomeRoles = new Set<PhoenixRole>(["CEO", "SFE Manager"]);

function SidebarBrand({
  currentRole,
  mode = "admin",
  onNavigate,
  rail = false,
}: {
  currentRole?: PhoenixRole;
  mode?: NavigationMode;
  onNavigate?: () => void;
  rail?: boolean;
}) {
  const homePath = commandCenterHomeRoles.has(currentRole as PhoenixRole)
    ? resolveLandingPathForRole(currentRole)
    : navigationHomePathByMode[mode];
  const isAdmin = usesAdminChrome(mode);
  const subtitle = isAdmin ? `${systemIdentity.productName} · Admin` : systemUiText.sidebar.employeeLogoSubtitle;

  if (rail) {
    if (isAdmin) {
      return (
        <Link
          aria-label={`${systemIdentity.brandName} Admin`}
          className="mx-auto mt-3 flex h-12 w-12 items-center justify-center"
          href={homePath}
          onClick={onNavigate}
        >
          <Image alt={`${systemIdentity.brandName} Admin`} className="h-11 w-11 object-contain" height={44} src={systemAssets.adminRailMark} width={44} />
        </Link>
      );
    }
    return (
      <Link
        aria-label={`${systemIdentity.brandName} Portal`}
        className="mx-auto mt-3 flex h-12 w-12 items-center justify-center overflow-hidden border border-[#E7DECF] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition hover:border-phx-accent-line"
        href={homePath}
        onClick={onNavigate}
      >
        <Image alt={systemIdentity.brandName} className="h-7 w-7 object-contain" height={28} src={systemAssets.iconLogo} width={28} />
      </Link>
    );
  }

  if (isAdmin) {
    return (
      <Link
        aria-label={`${systemIdentity.brandName} Admin`}
        className="mx-3 mt-3 block px-1 py-1.5"
        href={homePath}
        onClick={onNavigate}
      >
        <Image
          alt={`${systemIdentity.brandName} Admin`}
          className="h-auto w-full object-contain"
          height={288}
          priority
          src={systemAssets.adminSidebarLockup}
          width={640}
        />
      </Link>
    );
  }

  return (
    <Link className="mx-3 mt-3 flex items-center gap-3 px-2 py-3" href={homePath} onClick={onNavigate}>
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center bg-white",
          isAdmin ? "ring-1 ring-white/15" : "shadow-[0_1px_3px_rgba(15,23,42,0.06)] ring-1 ring-[#EBE4DA]",
        )}
      >
        <Image
          alt={systemIdentity.brandName}
          className="h-8 w-8 object-contain drop-shadow-[0_0_12px_rgba(249,115,22,0.35)]"
          height={32}
          src={systemAssets.iconLogo}
          width={32}
        />
      </span>
      <div className="min-w-0">
        <p className={cn("whitespace-nowrap text-phx-lg font-black tracking-[0.22em]", isAdmin ? "text-white" : "text-phx-ink")}>
          {systemIdentity.brandName.slice(0, -1).toUpperCase()}
          <span className="text-phx-accent">{systemIdentity.brandName.slice(-1).toUpperCase()}</span>
        </p>
        <p className={cn("mt-0.5 whitespace-nowrap text-phx-2xs font-semibold uppercase tracking-[0.22em]", isAdmin ? "text-slate-400" : "text-phx-ink-soft")}>
          {subtitle}
        </p>
      </div>
    </Link>
  );
}

// ── Employee-portal-only intro + footer ──────────────────────────────────────
function SidebarIntro({ mode = "admin" }: { mode?: NavigationMode }) {
  if (usesAdminChrome(mode)) return null;
  return (
    <div className="mx-3 mt-3 border border-phx-line bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-4">
      <p className="text-phx-2xs font-black uppercase tracking-[0.22em] text-phx-accent">{systemUiText.sidebar.employeePortalKicker}</p>
      <p className="mt-2 text-lg font-black tracking-[-0.03em] text-phx-ink">{systemUiText.sidebar.employeePortalTitle}</p>
      <p className="mt-2 text-sm leading-6 text-phx-ink-soft">{systemUiText.sidebar.employeePortalDescription}</p>
    </div>
  );
}

function SidebarFooter({ mode = "admin" }: { mode?: NavigationMode }) {
  if (usesAdminChrome(mode)) return null;
  return (
    <div className="p-3">
      <div className="overflow-hidden border border-phx-line bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_100%)] p-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-phx-accent/10 text-phx-accent">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-phx-ink">{systemUiText.sidebar.employeePortalFooterTitle}</p>
            <p className="mt-1 text-xs leading-5 text-phx-ink-soft">{systemUiText.sidebar.employeePortalFooterDescription}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function useSidebarRail(mode: NavigationMode) {
  const key = prefKey("rail", mode);
  const collapsed = useBooleanPref(key);
  const toggle = () => writePref(key, !collapsed);
  return [collapsed, toggle] as const;
}

// ── Desktop sidebar ──────────────────────────────────────────────────────────
export function Sidebar({
  navigationMode = "admin",
  permissionLookup = EMPTY_PERMISSION_LOOKUP,
  currentRole,
  personalLayout = null,
}: {
  currentRole?: PhoenixRole;
  navigationMode?: NavigationMode;
  permissionLookup?: PermissionLookup;
  /** This viewer's own saved arrangement, resolved server-side in AppShell. */
  personalLayout?: PersonalNavigationLayout | null;
}) {
  const isAdmin = usesAdminChrome(navigationMode);
  const [rail, toggleRail] = useSidebarRail(navigationMode);
  const railActive = isAdmin && rail;
  const [transitionsReady, setTransitionsReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setTransitionsReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Same hydration-flash issue as the collapsed sections below: the rail preference
  // comes from localStorage, so the very first client render can briefly show the
  // wrong width and then animate to the real one. Suppress that one transition.

  return (
    <aside
      // z-40, ABOVE the shell's frozen chrome at z-30. Not cosmetic: the rail toggle below hangs
      // 12px past this element's right edge (`-right-3`) and the rail tooltips are `fixed`, so both
      // cross into the column the nav rows occupy. `position: sticky` with a z-index creates a
      // stacking context, which traps those children at the ASIDE's level however high their own
      // z-index climbs — the toggle's z-40 and the tooltip's z-[70] both resolve to 30 from outside.
      // At an equal 30 the tie broke on DOM order, and the nav block is written after the sidebar,
      // so it won: measured in a browser, the toggle's outer 11px were painted over by the row.
      // Raising the whole aside is what lifts its children with it. Safe in the other direction
      // because the two never overlap anywhere else — the sidebar ends exactly where the nav column
      // begins — and the surfaces that must still cover the sidebar are all above 40: the mobile
      // drawer at z-50 and the command palette at z-[60].
      className={cn(
        "sticky top-0 z-40 hidden h-screen shrink-0 flex-col lg:flex",
        transitionsReady && "transition-[width] duration-200",
        isAdmin
          ? cn("border-r text-slate-100", ADMIN_SIDEBAR_BORDER, ADMIN_SIDEBAR_BG)
          : "border-r border-phx-line bg-white",
        railActive ? SIDEBAR_WIDTH_RAIL : SIDEBAR_WIDTH_EXPANDED,
      )}
    >
      {isAdmin && (
        <button
          aria-label={railActive ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={railActive}
          className="absolute -right-3 top-[86px] z-40 flex h-7 w-7 items-center justify-center border border-[#333333] bg-[#111111] text-slate-300 shadow-[0_6px_16px_rgba(0,0,0,0.6)] transition hover:border-phx-accent-line hover:bg-[#1c1c1c] hover:text-[#F8B56B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/60"
          onClick={toggleRail}
          type="button"
        >
          {railActive ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      )}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <SidebarBrand currentRole={currentRole} mode={navigationMode} rail={railActive} />
        <SidebarIntro mode={navigationMode} />
        <SidebarNav
          currentRole={currentRole}
          mode={navigationMode}
          permissionLookup={permissionLookup}
          personalLayout={personalLayout}
          rail={railActive}
        />
        <SidebarFooter mode={navigationMode} />
      </div>
    </aside>
  );
}

// ── Mobile drawer ────────────────────────────────────────────────────────────
export function MobileSidebar({
  onClose,
  open,
  navigationMode = "admin",
  permissionLookup = EMPTY_PERMISSION_LOOKUP,
  currentRole,
  personalLayout = null,
}: {
  currentRole?: PhoenixRole;
  onClose: () => void;
  open: boolean;
  navigationMode?: NavigationMode;
  permissionLookup?: PermissionLookup;
  /** Same arrangement as the desktop sidebar — the two must not disagree about where a page is. */
  personalLayout?: PersonalNavigationLayout | null;
}) {
  const isAdmin = usesAdminChrome(navigationMode);

  return (
    <div
      aria-hidden={!open}
      className={cn("fixed inset-0 z-50 lg:hidden", open ? "pointer-events-auto" : "pointer-events-none")}
      inert={!open}
    >
      <button
        aria-label="Close menu"
        className={cn("absolute inset-0 bg-slate-950/55 backdrop-blur-sm transition-opacity", open ? "opacity-100" : "opacity-0")}
        onClick={onClose}
        type="button"
      />
      <aside
        className={cn(
          "absolute inset-y-0 left-0 flex w-[min(90vw,320px)] flex-col shadow-2xl transition-transform duration-200",
          isAdmin ? cn("border-r text-slate-100", ADMIN_SIDEBAR_BORDER, ADMIN_SIDEBAR_BG) : "border-r border-phx-line bg-white",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-3">
            <SidebarBrand currentRole={currentRole} mode={navigationMode} onNavigate={onClose} />
            <button
              aria-label="Close menu"
              className={cn(
                "mr-3 mt-4 flex h-9 w-9 shrink-0 items-center justify-center transition",
                isAdmin
                  ? "bg-white/[0.06] text-slate-300 ring-1 ring-white/10 hover:text-[#F8B56B]"
                  : "bg-white text-phx-ink-soft ring-1 ring-[#EBE4DA] hover:bg-[#F1EBE1] hover:text-phx-ink",
              )}
              onClick={onClose}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <SidebarIntro mode={navigationMode} />
          <SidebarNav
            currentRole={currentRole}
              mode={navigationMode}
            onNavigate={onClose}
            permissionLookup={permissionLookup}
            personalLayout={personalLayout}
            rail={false}
          />
          <SidebarFooter mode={navigationMode} />
        </div>
      </aside>
    </div>
  );
}
