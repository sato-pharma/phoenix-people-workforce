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
  ChevronRight,
  GripVertical,
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
import type { ReactNode } from "react";

import {
  getNavigationSections,
  navigationHomePathByMode,
  type NavigationSection,
  type NavigationSectionItem,
} from "@/config/system-navigation";
import { systemAssets, systemIdentity, systemUiText } from "@/config/system-settings";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { type NavigationMode, type PhoenixRole } from "@/lib/auth/permissions";
import { getActiveHref, getSections, type PermissionLookup } from "@/lib/navigation/active-path";
import { subscribeNavBadge } from "@/lib/nav-badge-store";
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

const SIDEBAR_WIDTH_EXPANDED = "w-[280px]";
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

// ── Pending-count badge for the Action Center nav item ───────────────────────
function NavBadge({ src }: { src: string }): ReactNode {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => subscribeNavBadge(src, setCount), [src]);
  if (!count) return null;
  return (
    <span className="ml-auto min-w-[20px] rounded-full bg-orange-500 px-1.5 py-0.5 text-center text-[10px] font-black leading-none text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}

// ── A single navigation entry ────────────────────────────────────────────────
function NavRow({
  active,
  dark,
  item,
  onActivate,
  onHover,
  onHoverEnd,
  pinned = false,
  onTogglePin,
  rail,
}: {
  active: boolean;
  dark: boolean;
  item: NavigationSectionItem;
  onActivate: () => void;
  onHover?: (rect: DOMRect) => void;
  onHoverEnd?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  rail: boolean;
}) {
  const Icon = item.icon;

  return (
    <div
      className="group relative"
      onMouseEnter={rail && onHover ? (event) => onHover(event.currentTarget.getBoundingClientRect()) : undefined}
      onMouseLeave={rail ? onHoverEnd : undefined}
    >
      <Link
        aria-current={active ? "page" : undefined}
        aria-label={rail ? item.label : undefined}
        className={cn(
          "relative flex w-full items-center text-[13px] font-semibold transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/60 focus-visible:ring-offset-2",
          dark ? "focus-visible:ring-offset-slate-900" : "focus-visible:ring-offset-white",
          rail ? "justify-center px-0 py-2.5" : "gap-3 px-2.5 py-2.5",
          dark
            ? active
              ? "bg-white/[0.08] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] ring-1 ring-[#F97316]/30"
              : "text-slate-400 hover:bg-white/[0.06] hover:text-white"
            : active
              ? "bg-white text-[#0F172A] shadow-[0_1px_2px_rgba(15,23,42,0.06)] ring-1 ring-[#F4D9BE]"
              : "text-[#5A6678] hover:bg-white hover:text-[#0F172A] hover:shadow-[0_1px_2px_rgba(15,23,42,0.05)]",
        )}
        href={item.href}
        onClick={onActivate}
      >
        {active && <span className={cn("absolute left-0 w-[3px] bg-[#F97316]", rail ? "top-1.5 bottom-1.5" : "top-1.5 bottom-1.5")} />}
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center transition-colors duration-150",
            dark
              ? active
                ? "bg-[linear-gradient(180deg,#FB923C_0%,#F97316_100%)] text-white shadow-[0_8px_16px_rgba(249,115,22,0.32)]"
                : "bg-white/5 text-slate-400 ring-1 ring-white/10 group-hover:text-[#F8B56B] group-hover:ring-white/20"
              : active
                ? "bg-[#F97316] text-white shadow-[0_8px_16px_rgba(249,115,22,0.28)]"
                : "bg-white text-[#64748B] ring-1 ring-[#EBE4DA] group-hover:text-[#F97316] group-hover:ring-[#FDBA74]",
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        {!rail && (
          <span className={cn("flex min-w-0 flex-1 items-center gap-1.5", onTogglePin && "pr-6")}>
            <span className="min-w-0 flex-1 truncate tracking-[-0.01em]">{item.label}</span>
            {item.navBadge === "approvals-hub-pending" && <NavBadge src="/api/approvals-hub/pending-count" />}
          </span>
        )}
      </Link>
      {!rail && onTogglePin ? (
        <button
          aria-label={pinned ? `Unpin ${item.label}` : `Pin ${item.label} to favourites`}
          className={cn(
            "absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded transition",
            pinned ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
            dark ? "text-slate-400 hover:text-[#F8B56B]" : "text-[#94A3B8] hover:text-[#F97316]",
          )}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onTogglePin();
          }}
          title={pinned ? "Unpin" : "Pin to favourites"}
          type="button"
        >
          <Star className={cn("h-3.5 w-3.5", pinned && (dark ? "fill-[#F8B56B] text-[#F8B56B]" : "fill-[#F97316] text-[#F97316]"))} />
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
  onActivate,
  onTogglePin,
  pinned,
}: {
  item: NavigationSectionItem;
  active: boolean;
  dark: boolean;
  dragDisabled: boolean;
  onActivate: () => void;
  onTogglePin: () => void;
  pinned: boolean;
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
          className="absolute left-[10px] top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 cursor-grab items-center justify-center bg-[#000000] text-slate-600 opacity-0 transition hover:text-slate-300 focus-visible:opacity-100 active:cursor-grabbing group-hover/dnd-row:opacity-100"
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
        item={item}
        onActivate={onActivate}
        onTogglePin={onTogglePin}
        pinned={pinned}
        rail={false}
      />
    </div>
  );
}

// ── Sortable wrapper for an entire section (header + items) ───────────────────
function SortableSectionBlock({
  activeHref,
  collapsedSectionIds,
  dragDisabled,
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
  transitionsReady,
}: {
  activeHref: string | null;
  collapsedSectionIds: Set<string>;
  dragDisabled: boolean;
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
  const collapsed = !query && collapsedSectionIds.has(section.id) && !hasActive;
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
        <div className="group/sec-hdr flex items-center">
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
              "group/sec flex flex-1 items-center gap-1.5 pb-1.5 pt-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/60 focus-visible:ring-offset-2",
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
                isAdmin ? "text-slate-400 group-hover/sec:text-slate-200" : "text-[#64748B] group-hover/sec:text-[#334155]",
                !collapsed && "rotate-90",
              )}
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13px] font-bold tracking-[-0.01em]",
                isAdmin ? "text-white" : "text-[#0F172A]",
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
                    key={item.href}
                    active={item.href === activeHref}
                    dark={isAdmin}
                    dragDisabled={dragDisabled || !isAdmin}
                    item={item}
                    onActivate={() => onActivate(item)}
                    onTogglePin={() => onTogglePin(item.href)}
                    pinned={pinnedSet.has(item.href)}
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
  effectiveModuleIds,
  isSystemAdministratorWorkspace = false,
  currentRole,
  rail = false,
  scrollable = true,
}: {
  currentRole?: PhoenixRole;
  effectiveModuleIds?: readonly string[] | null;
  isSystemAdministratorWorkspace?: boolean;
  mode?: NavigationMode;
  onNavigate?: () => void;
  permissionLookup?: PermissionLookup;
  rail?: boolean;
  scrollable?: boolean;
}) {
  const isAdmin = mode === "admin";
  const [isClientReady, setIsClientReady] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsClientReady(true);
  }, []);

  const sections = useMemo(
    () =>
      getSections(
        getNavigationSections(mode),
        mode,
        permissionLookup,
        currentRole,
        effectiveModuleIds,
        isSystemAdministratorWorkspace,
      ),
    [currentRole, effectiveModuleIds, isSystemAdministratorWorkspace, mode, permissionLookup],
  );
  const pathname = usePathname();
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

  // Apply saved section order on top of the visible (permission-filtered) sections.
  // During search, order is bypassed so results are stable.
  const orderedSections = useMemo(
    () => (query ? visibleSections : applyOrder(visibleSections, (s) => s.id, savedSectionOrder)),
    [query, visibleSections, savedSectionOrder],
  );
  const orderedSectionIds = useMemo(() => orderedSections.map((s) => s.id), [orderedSections]);

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
            className="pointer-events-none fixed z-[70] -translate-y-1/2 whitespace-nowrap border border-white/10 bg-slate-900 px-2.5 py-1.5 text-[12px] font-semibold text-white shadow-[0_10px_28px_rgba(2,6,23,0.6)]"
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
              className="h-9 w-full border border-white/10 bg-white/5 pl-9 pr-8 text-[13px] font-semibold text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-[#FDBA74] focus:bg-white/[0.08] focus:ring-2 focus:ring-[#F97316]/25"
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
        className={cn("flex-1 px-3 py-4", scrollable && "overflow-auto", scrollable && isAdmin && "phoenix-admin-sidebar-scroll")}
        onScroll={handleNavScroll}
      >
        {/* Favourites section — fixed position, never draggable */}
        {!query && pinnedItems.length > 0 && (
          <Fragment>
            <div className={cn("sticky top-0 z-20 -mx-3 px-3", isAdmin ? "bg-[#000000]" : "bg-white")}>
              <div className="flex w-full items-center gap-1.5 px-1.5 pb-1.5 pt-3">
                <Star className={cn("h-3.5 w-3.5 shrink-0", isAdmin ? "fill-[#F8B56B] text-[#F8B56B]" : "fill-[#F97316] text-[#F97316]")} />
                <span className={cn("min-w-0 flex-1 truncate text-[13px] font-bold tracking-[-0.01em]", isAdmin ? "text-white" : "text-[#0F172A]")}>
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
          <SortableContext items={orderedSectionIds} strategy={verticalListSortingStrategy}>
            {orderedSections.map((section) => (
              <SortableSectionBlock
                key={section.id}
                activeHref={activeHref}
                collapsedSectionIds={collapsedSectionIds}
                dragDisabled={dragDisabled}
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
            ))}
          </SortableContext>
        </DndContext>

        {isAdmin && query && visibleSections.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
            <span className="flex h-12 w-12 items-center justify-center bg-[#F97316]/10 text-[#F97316] ring-1 ring-[#F97316]/25">
              <Search className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[13px] font-semibold text-slate-100">No modules match</p>
              <p className="mt-1 text-[11px] text-slate-500">Try a different search term.</p>
            </div>
          </div>
        )}

        {/* Reset order button — visible only when user has a custom order saved */}
        {isAdmin && !query && hasCustomOrder && (
          <div className="mt-4 px-1">
            <button
              className="flex w-full items-center gap-2 px-1.5 py-1.5 text-[11px] font-semibold text-slate-600 transition hover:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/60"
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
  const homePath = currentRole === "CEO" ? resolveLandingPathForRole(currentRole) : navigationHomePathByMode[mode];
  const isAdmin = mode === "admin";
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
        className="mx-auto mt-3 flex h-12 w-12 items-center justify-center overflow-hidden border border-[#E7DECF] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition hover:border-[#FDBA74]"
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
        <p className={cn("whitespace-nowrap text-[15px] font-black tracking-[0.22em]", isAdmin ? "text-white" : "text-[#0F172A]")}>
          {systemIdentity.brandName.slice(0, -1).toUpperCase()}
          <span className="text-[#F97316]">{systemIdentity.brandName.slice(-1).toUpperCase()}</span>
        </p>
        <p className={cn("mt-0.5 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.22em]", isAdmin ? "text-slate-400" : "text-[#64748B]")}>
          {subtitle}
        </p>
      </div>
    </Link>
  );
}

// ── Employee-portal-only intro + footer ──────────────────────────────────────
function SidebarIntro({ mode = "admin" }: { mode?: NavigationMode }) {
  if (mode === "admin") return null;
  return (
    <div className="mx-3 mt-3 border border-[#E2E8F0] bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-4">
      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#F97316]">{systemUiText.sidebar.employeePortalKicker}</p>
      <p className="mt-2 text-lg font-black tracking-[-0.03em] text-[#0F172A]">{systemUiText.sidebar.employeePortalTitle}</p>
      <p className="mt-2 text-sm leading-6 text-[#64748B]">{systemUiText.sidebar.employeePortalDescription}</p>
    </div>
  );
}

function SidebarFooter({ mode = "admin" }: { mode?: NavigationMode }) {
  if (mode === "admin") return null;
  return (
    <div className="p-3">
      <div className="overflow-hidden border border-[#E2E8F0] bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_100%)] p-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-[#F97316]/10 text-[#F97316]">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-[#0F172A]">{systemUiText.sidebar.employeePortalFooterTitle}</p>
            <p className="mt-1 text-xs leading-5 text-[#64748B]">{systemUiText.sidebar.employeePortalFooterDescription}</p>
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
  effectiveModuleIds,
  isSystemAdministratorWorkspace = false,
  currentRole,
}: {
  currentRole?: PhoenixRole;
  effectiveModuleIds?: readonly string[] | null;
  isSystemAdministratorWorkspace?: boolean;
  navigationMode?: NavigationMode;
  permissionLookup?: PermissionLookup;
}) {
  const isAdmin = navigationMode === "admin";
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
      className={cn(
        "sticky top-0 z-30 hidden h-screen shrink-0 flex-col lg:flex",
        transitionsReady && "transition-[width] duration-200",
        isAdmin
          ? cn("border-r text-slate-100", ADMIN_SIDEBAR_BORDER, ADMIN_SIDEBAR_BG)
          : "border-r border-[#E2E8F0] bg-white",
        railActive ? SIDEBAR_WIDTH_RAIL : SIDEBAR_WIDTH_EXPANDED,
      )}
    >
      {isAdmin && (
        <button
          aria-label={railActive ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={railActive}
          className="absolute -right-3 top-[86px] z-40 flex h-7 w-7 items-center justify-center rounded-full border border-[#333333] bg-[#111111] text-slate-300 shadow-[0_6px_16px_rgba(0,0,0,0.6)] transition hover:border-[#FDBA74] hover:text-[#F8B56B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/60"
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
          isSystemAdministratorWorkspace={isSystemAdministratorWorkspace}
          effectiveModuleIds={effectiveModuleIds}
          mode={navigationMode}
          permissionLookup={permissionLookup}
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
  isSystemAdministratorWorkspace = false,
  effectiveModuleIds,
  currentRole,
}: {
  currentRole?: PhoenixRole;
  isSystemAdministratorWorkspace?: boolean;
  effectiveModuleIds?: readonly string[] | null;
  onClose: () => void;
  open: boolean;
  navigationMode?: NavigationMode;
  permissionLookup?: PermissionLookup;
}) {
  const isAdmin = navigationMode === "admin";

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
          isAdmin ? cn("border-r text-slate-100", ADMIN_SIDEBAR_BORDER, ADMIN_SIDEBAR_BG) : "border-r border-[#E2E8F0] bg-white",
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
                  : "bg-white text-[#64748B] ring-1 ring-[#EBE4DA] hover:bg-[#F1EBE1] hover:text-[#0F172A]",
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
            isSystemAdministratorWorkspace={isSystemAdministratorWorkspace}
            effectiveModuleIds={effectiveModuleIds}
            mode={navigationMode}
            onNavigate={onClose}
            permissionLookup={permissionLookup}
            rail={false}
          />
          <SidebarFooter mode={navigationMode} />
        </div>
      </aside>
    </div>
  );
}
