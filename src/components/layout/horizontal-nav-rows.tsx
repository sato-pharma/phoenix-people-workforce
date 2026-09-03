"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Phoenix Workforce — the two HORIZONTAL navigation rows (zones 2 and 3)
//
// The shape the owner asked for on 2026-08-28, from
// `Phoenix_God_Mode_Context_OS_V9_Sovereign.html`: a nav row ABOVE the page
// title and another BELOW it, with any tab freely movable between them, the
// utility strip, and the sidebar. His words: "I want to be freely able to
// exchange tabs that appeared either above or either down", and "in all modules
// — I want this to be the shape of the system".
//
// ── Where each row is rendered ──────────────────────────────────────────────
//   Both rows render in ONE place per module, inside a sticky container that
//   also holds that module's header — AppShell for admin and HR, the portal
//   chrome for the employee portal. That container is what freezes them: the
//   rows stay put while the page scrolls, and they sit in the SAME place on
//   every page (owner, 2026-08-29: "I want both new navs to be freezed in every
//   module fixed when ever i change the page they are fixed").
//
//   Zone 3 used to be emitted instead by each shared page-title surface, with a
//   fallback copy in AppShell and a :has() rule in app/globals.css hiding
//   whichever was the duplicate. That is retired. A sticky element is bounded
//   by its containing block, so a row rendered inside a page hero unpins the
//   instant the hero scrolls off — "below the page title" and "frozen" cannot
//   both be true, and the owner asked for frozen.
//
// Both rows render NOTHING at all for an account that has never saved a layout,
// which is all but two accounts today — this stays invisible until somebody
// arranges a tab into a row, either on /admin/sidebar-layout or with the "+".
//
// ── The "+" ─────────────────────────────────────────────────────────────────
// Each row ends in a "+" (2026-08-28, owner: "it have a plus sign at the end. I
// press at the plus sign. The list of modules appear to me. I choose. It is
// embedded like the organogram"). It is a shortcut into the same stored layout
// the editor writes, for the case the editor is clumsy for — arranging one page
// without leaving the page you are on.
//
// It shows on an EMPTY row too, but only for an account that has saved a layout
// at some point. That is the difference between the two failure modes: a lone
// "+" on all 243 pages for 158 people who never asked for any of this would
// break the invisibility promise above, while withholding it from someone who
// emptied their own row leaves them no way back in except the editor — which is
// the exact trip the "+" exists to save.
//
// ── THE PORTAL HAS NO ROWS AT ALL ───────────────────────────────────────────
// This file serves the ADMIN and HR shells only. The employee portal carried
// these rows until 2026-09-03, when the owner removed them outright: "never put
// anything above the identity banner … remove it totally." They had sat
// directly above a person's own signature identity card, and on a phone pushed
// it most of a screen down. Two earlier attempts to give the portal an entry
// point to `pinHrefToRow` went with them — `alwaysOfferAdd`, which rendered two
// dead full-width strips holding nothing but a "+", and the compact header "+"
// that replaced it. Do not reintroduce either, and do not "restore parity" by
// mounting these rows in the portal: admin and HR keep them because AppShell
// has no identity banner. Admin and HR were never touched by any of this and
// keep /admin/sidebar-layout as their entry point, as shipped.
//
// Like the sidebar, this is UX and never the security boundary: the items come
// from `getSections` (already permission- and role-filtered) and are only
// REARRANGED by `applyPersonalLayout`, which cannot introduce an href.
// ─────────────────────────────────────────────────────────────────────────────

import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDndContext,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronsDown,
  ChevronsUp,
  ExternalLink,
  Lock,
  MoreHorizontal,
  Pin,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { isNavItemLockedFor, useLockedModuleKeys } from "@/components/layout/module-lock-context";
import { ApprovalNavBadge } from "@/components/layout/nav-badge";
import { useNavLayoutCommit } from "@/components/layout/nav-layout-commit";
import { NavRowAddButton } from "@/components/layout/nav-row-add-button";
import {
  NavMenuPanel,
  NAV_MENU_PANEL_WIDTH,
  type NavMenuItem,
} from "@/components/layout/nav-tab-menu";
import {
  getNavigationSections,
  type NavigationSection,
  type NavigationSectionItem,
} from "@/config/system-navigation";
import { type NavigationMode, type PhoenixRole } from "@/lib/auth/permissions";
import {
  carriesNavRows,
  getActiveHref,
  getSections,
  normalizePathnameForMode,
  usesAdminChrome,
  type PermissionLookup,
} from "@/lib/navigation/active-path";
import { getHubCardSections, mergeCatalogueSections } from "@/lib/navigation/hub-card-sections";
import {
  applyPersonalLayout,
  pinHrefToRow,
  placeHrefInRow,
  unpinHrefFromRows,
  type PersonalLayoutRowSet,
  type PersonalNavigationLayout,
} from "@/lib/navigation/personal-layout";
import { cn } from "@/lib/utils";

/**
 * Prefix for a ROW's own droppable id, so a drop on the row's empty space is distinguishable from a
 * drop on a tab. A tab's droppable id is its bare href, and an href always starts with "/", so this
 * prefix can never collide with one.
 */
const ROW_DROP_PREFIX = "navrow:";

/**
 * Where a dragged tab lands: the tab under the pointer, else the row under it, else the nearest
 * thing to it.
 *
 * A plain `closestCenter` cannot do this. Each row is itself a droppable — the only way into a row
 * holding no tabs to aim at — and its box CONTAINS its tabs, so "closest centre" would sometimes
 * answer the row while the pointer sat squarely on a tab, appending instead of inserting. Asking
 * `pointerWithin` first makes containment the question rather than distance, which is the one the
 * geometry can answer unambiguously. `closestCenter` is kept as the last resort so a drop into the
 * gap beyond the last tab still lands somewhere rather than silently snapping back.
 */
const navRowCollisions: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  const onTab = within.filter((entry) => !String(entry.id).startsWith(ROW_DROP_PREFIX));
  if (onTab.length > 0) return onTab;
  if (within.length > 0) return within;
  return closestCenter(args);
};

/** `gap-1` between everything in a row, in px. Used to measure, so it has to match the class. */
const ROW_GAP = 4;

/**
 * The rendered width of the overflow "»", in px — `p-1.5` around a 14px icon, same box as the "+".
 *
 * A constant rather than a measurement because it is the one control whose EXISTENCE is the thing
 * being measured for: it cannot be on screen to be measured at the moment the cut is decided.
 */
const OVERFLOW_BUTTON_WIDTH = 26;

/** What a rendered row needs. Resolved once by the provider and shared by both rows. */
type ResolvedRows = {
  upperRow: readonly NavigationSectionItem[];
  lowerRow: readonly NavigationSectionItem[];
  activeHref: string | null;
  dark: boolean;
  /** Everything the viewer may reach that is NOT already on the UPPER row — what its "+" offers. */
  upperAddable: readonly NavigationSection[];
  /** The same for the lower row. */
  lowerAddable: readonly NavigationSection[];
  /** Whether to render a "+" at all — every surface that carries rows, which is wider than the chrome. */
  canAdd: boolean;
  /** Has this viewer ever saved a layout? The one case where an EMPTY row still shows its own "+". */
  hasSavedLayout: boolean;
  /**
   * The code-defined section id of the page being rendered — which per-module row override applies.
   *
   * Every WRITE from the bar needs it, not just the read. `placeHrefInRow` edits the row set that is
   * actually on screen, and inside a module carrying its own rows that is the override, not the
   * defaults. Passing null there would reorder a set the viewer is not looking at: a 200 that moves
   * nothing, which is the exact shape of the 2026-08-28 evening documented under THE ONE-ZONE RULE.
   */
  activeModuleId: string | null;
  /**
   * The nav item for the page currently open, when it is one the viewer may reach — what the
   * one-press pin puts on a row. Null on a page that is in no section (so there is nothing to pin).
   */
  currentItem: NavigationSectionItem | null;
  /**
   * Whether this surface gets the RICH interaction model: drag to reorder, the overflow menu, the
   * right-click menu and the one-press pin. Admin and HR only.
   *
   * Deliberately `usesAdminChrome` and NOT `carriesNavRows`. The employee portal carries rows and
   * must keep them exactly as shipped (owner, 2026-08-29: "DONOT TOUCH THE EMPLOYEE PORTAL I AM
   * TALKING ON ADMIN SHELL") — and none of these would be merely cosmetic there. dnd-kit's pointer
   * sensor requires `touch-action: none` on every draggable, which kills the portal's
   * swipe-to-scroll; the overflow menu replaces that sideways scroll outright; and a right-click
   * menu on a touch-first surface is a long-press, which is the same gesture as the scroll it would
   * be fighting. The portal therefore keeps the scroller and the plain tabs.
   *
   * Alt+1…9 is the ONE addition that is not gated on this. It moves no pixel, needs no gesture, and
   * a portal account has the same reason to want it.
   */
  richInteraction: boolean;
};

const EMPTY_ROWS: ResolvedRows = {
  upperRow: [],
  lowerRow: [],
  activeHref: null,
  dark: true,
  upperAddable: [],
  lowerAddable: [],
  canAdd: false,
  hasSavedLayout: false,
  activeModuleId: null,
  currentItem: null,
  richInteraction: false,
};

/**
 * Carries the resolved rows down to whatever renders zone 3 in-page.
 *
 * Context rather than props because the in-page consumer is `AdminPageHero`, buried inside a page's
 * own component tree — threading role/mode/permissionLookup through 67 pages to reach it would be a
 * 67-file change that has to be repeated for every page added afterwards. React context crosses the
 * server/client boundary correctly here: `children` is server-rendered and slotted into the
 * provider's position in the TREE, so client components inside it read this normally.
 */
const HorizontalNavContext = createContext<ResolvedRows>(EMPTY_ROWS);

export function HorizontalNavProvider({
  children,
  currentRole,
  navigationMode = "admin",
  permissionLookup = {},
  personalLayout = null,
  sections,
}: {
  children: ReactNode;
  currentRole?: PhoenixRole;
  navigationMode?: NavigationMode;
  permissionLookup?: PermissionLookup;
  personalLayout?: PersonalNavigationLayout | null;
  /**
   * ALREADY-GATED sections, for a surface that builds its own navigation instead of reading
   * system-navigation.ts. The employee portal is the only such surface: it computes its tabs from
   * EmployeePortalNavVisibility, so `getSections` has nothing to gate there and would return the
   * portal's config seeds — a list nothing else in the portal renders.
   *
   * Passing them in rather than teaching this component a second way to build a list is the point:
   * the portal keeps ONE source for its tabs (buildEmployeePortalSections), which is what the row
   * and the sidebar both read. A duplicate list is how Capture Evidence shipped rejecting 59 of the
   * 65 customers it existed for.
   *
   * The safety property is unchanged either way: whatever arrives here is the set the layout can
   * draw from, and `applyPersonalLayout` can emit nothing outside it.
   */
  sections?: readonly NavigationSection[];
}) {
  const pathname = normalizePathnameForMode(usePathname(), navigationMode);
  const searchParams = useSearchParams();
  const activeTab = searchParams.get("action") ?? searchParams.get("tab");

  const value = useMemo<ResolvedRows>(() => {
    // A surface that builds its own navigation hands its list in already gated; everything else
    // reads the shared config and gates it here.
    const gated =
      sections ??
      getSections(
        getNavigationSections(navigationMode),
        navigationMode,
        permissionLookup,
        currentRole,
      );
    // Which module is this page in? Resolved from the GATED sections — the code-defined ones —
    // rather than from the rearranged result, because a page the viewer moved into a row has left
    // its section, and asking the rearranged tree would answer differently once anything was
    // arranged. This is what selects a per-module row override: his ask was for the rows to carry
    // marketing tabs inside Marketing & ROI and a different set inside Sales.
    const active = getActiveHref(pathname, gated, activeTab);
    const activeModuleId =
      gated.find((section) => section.items.some((entry) => entry.href === active))?.id ?? null;
    // ADMIN CHROME ONLY — admin and HR, the two workspaces that share this shell. The employee
    // portal builds its navigation entirely separately, so applying a layout there would let a
    // portal render fight this one. Widened from admin-only on 2026-08-29: `usesAdminChrome` was
    // already what decided the row's palette, so the HR workspace was getting the dark chrome of a
    // surface that carries rows, with no rows and no way to add any.
    //
    // One stored document serves both, and that is safe by construction rather than by luck: an
    // hr-mode `getSections` returns `/hr/...` hrefs, so an `/admin/...` href in the layout matches
    // nothing in `byHref` and `applyPersonalLayout` simply drops it. The two modes cannot collide.
    // WIDENED AGAIN on 2026-08-29, to the employee portal — 116 accounts, 72% of everyone with a
    // login, and until now the only workspace with no arrangeable row at all. `carriesNavRows` is
    // separate from `usesAdminChrome` on purpose: the first asks whether this surface has rows, the
    // second is a PALETTE question, and the portal answers yes to one and no to the other.
    const layout = carriesNavRows(navigationMode) ? personalLayout : null;
    // Every page that is NOT in the rail — the cards on each collapsed hub. The owner opened the
    // "+" and found "some pages are compacted and not appearing… I want all pages to appear",
    // which is exactly this set. A surface passing its own `sections` (the portal) is left alone:
    // it has no hubs, and folding the admin catalogue in there would offer pages it never renders.
    const hubSections = sections
      ? []
      : getHubCardSections(navigationMode, permissionLookup, currentRole, gated);
    const hubItems = hubSections.flatMap((section) => section.items);
    // Handed in as the ZONE-ONLY pool, never merged into `gated`: a hub card must be placeable in a
    // row and must not start appearing in the sidebar. See applyPersonalLayout's own note.
    const applied = applyPersonalLayout(gated, layout, activeModuleId, hubItems);
    // What each "+" offers: the gated sections with the pages already on THAT row taken out, so the
    // list never proposes a page sitting two centimetres to its left. Deliberately scoped to one
    // row rather than both — a page on the lower row IS offered by the upper "+", and pinning it
    // there releases the lower row, which makes that press a MOVE. That is the owner's "freely able
    // to exchange tabs that appeared either above or either down", reachable without the editor.
    //
    // Built from the gated rail sections PLUS the gated hub cards — both permission-filtered, so
    // the picker inherits the gate rather than re-deciding it, and can no more introduce an href
    // than `applyPersonalLayout` can.
    // MERGED by label, not concatenated. A hub group almost always shares its name with the rail
    // row that opens it, so a plain concat put 9 duplicated headings in the panel — measured on the
    // first run of this change. One heading per module: the hub button, then its pages.
    const catalogue: readonly NavigationSection[] = mergeCatalogueSections(gated, hubSections);
    const addableFor = (row: readonly NavigationSectionItem[]): readonly NavigationSection[] => {
      const onRow = new Set(row.map((entry) => entry.href));
      return catalogue
        .map((section) => ({
          ...section,
          items: section.items.filter((entry) => !onRow.has(entry.href)),
        }))
        .filter((section) => section.items.length > 0);
    };
    // Which tab is LIT. Resolved against the rail plus any hub card the viewer has actually PLACED
    // in a zone — never the whole hub catalogue. A hub page sitting on a row is a deeper match than
    // the hub button that owns it and correctly takes the highlight; a hub page the viewer has not
    // placed must not, or every hub tab would go dark the moment you opened one of its cards.
    const hubHrefs = new Set(hubItems.map((item) => item.href));
    const placedHubItems = [...applied.strip, ...applied.upperRow, ...applied.lowerRow].filter(
      (item) => hubHrefs.has(item.href),
    );
    const litHref =
      placedHubItems.length === 0
        ? active
        : getActiveHref(
            pathname,
            [...gated, { id: "zone-hub-cards", items: placedHubItems, label: "" }],
            activeTab,
          );
    // The item for the page currently open, for the one-press pin. Resolved across the WHOLE
    // catalogue rather than the rail alone: until now the pin silently offered nothing on any page
    // living as a hub card, which is most of the admin surface. Still gate-derived, so it can only
    // ever offer a page this viewer already reaches, exactly like the "+" panel does.
    const currentHref = getActiveHref(pathname, catalogue, activeTab);
    const currentItem =
      catalogue.flatMap((section) => section.items).find((entry) => entry.href === currentHref) ??
      null;
    return {
      upperRow: applied.upperRow,
      lowerRow: applied.lowerRow,
      upperAddable: addableFor(applied.upperRow),
      lowerAddable: addableFor(applied.lowerRow),
      canAdd: carriesNavRows(navigationMode),
      hasSavedLayout: layout !== null,
      // Resolved against the FULL gated set, not just the rows, so a tab stays lit on its child
      // routes and the deepest match still wins over a shallower one sitting in another zone.
      activeHref: litHref,
      dark: usesAdminChrome(navigationMode),
      activeModuleId,
      currentItem,
      richInteraction: usesAdminChrome(navigationMode) && carriesNavRows(navigationMode),
    };
  }, [
    activeTab,
    currentRole,
    navigationMode,
    pathname,
    permissionLookup,
    personalLayout,
    sections,
  ]);

  return (
    <HorizontalNavContext.Provider value={value}>
      <NavRowDragScope>{children}</NavRowDragScope>
    </HorizontalNavContext.Provider>
  );
}

/**
 * ONE drag scope spanning BOTH rows, plus the Alt+1…9 jump.
 *
 * It has to wrap `children` rather than sit inside a row, because a tab must be draggable from the
 * upper row to the lower one and dnd-kit can only match a drag to a drop inside a single
 * `DndContext`. The provider already wraps both rows (AppShell renders them as siblings inside it),
 * so this is the one place that spans them without a second context object.
 *
 * A `DragOverlay` renders the tab being dragged. Without it the real tab moves under
 * `overflow: hidden` and is clipped the moment it leaves the row — the drag would look like the tab
 * had been deleted. The overlay is portalled outside that clip by dnd-kit itself.
 */
function NavRowDragScope({ children }: { children: ReactNode }) {
  const { activeModuleId, dark, lowerRow, richInteraction, upperRow } = useContext(HorizontalNavContext);
  const { commit } = useNavLayoutCommit();
  const [dragging, setDragging] = useState<NavigationSectionItem | null>(null);
  const router = useRouter();

  // A 6px activation distance is what keeps every tab a working LINK. Below it the gesture is a
  // click and navigates; above it dnd-kit takes over and the click never fires. Same constant the
  // sidebar layout editor uses, so the two boards feel identical.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ── Alt+1…9 — jump to a pinned tab from anywhere ──────────────────────────────────────────────
  // Numbered across BOTH rows in reading order (upper first), because that is how they are read on
  // screen; numbering each row from 1 would give two tabs the same shortcut. Alt is the one modifier
  // free here: Ctrl+N and Cmd+N are the browser's, and a bare digit would fire while typing.
  // `event.code` rather than `event.key`, because Alt+digit emits a symbol on several keyboard
  // layouts (Alt+1 is "¡" on Spanish, a dead key on others) and `key` would then never match.
  const jumpTargets = useMemo(() => [...upperRow, ...lowerRow].slice(0, 9), [lowerRow, upperRow]);
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const match = /^Digit([1-9])$/.exec(event.code);
      if (!match) return;
      const target = jumpTargets[Number(match[1]) - 1];
      if (!target) return;
      event.preventDefault();
      router.push(target.href);
    },
    [jumpTargets, router],
  );

  // Registered through a ref callback on a zero-size anchor rather than in an effect: `setState`
  // inside `useEffect` is a lint error in this repo, and a ref callback gives the same lifecycle —
  // it fires with the node when it mounts and with null when it unmounts, which is exactly when the
  // listener should be added and removed.
  const bindShortcuts = useCallback(
    (node: HTMLSpanElement | null) => {
      const owner = node?.ownerDocument;
      if (!owner) return;
      const handler = onKeyDown as unknown as EventListener;
      owner.addEventListener("keydown", handler);
      return () => owner.removeEventListener("keydown", handler);
    },
    [onKeyDown],
  );

  if (!richInteraction) {
    return (
      <>
        <span aria-hidden className="hidden" ref={bindShortcuts} />
        {children}
      </>
    );
  }

  const rowOf = (href: string): { row: keyof PersonalLayoutRowSet; index: number } | null => {
    const upper = upperRow.findIndex((entry) => entry.href === href);
    if (upper !== -1) return { row: "upperRow", index: upper };
    const lower = lowerRow.findIndex((entry) => entry.href === href);
    if (lower !== -1) return { row: "lowerRow", index: lower };
    return null;
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const href = String(event.active.id);
    const over = event.over;
    if (!over) return;
    const overId = String(over.id);
    // Dropped on the row's own empty space rather than on a tab: append. `Number.MAX_SAFE_INTEGER`
    // is clamped by `placeHrefInRow`, so this needs no length lookup that could disagree with it.
    const target = overId.startsWith(ROW_DROP_PREFIX)
      ? { row: overId.slice(ROW_DROP_PREFIX.length) as keyof PersonalLayoutRowSet, index: Number.MAX_SAFE_INTEGER }
      : rowOf(overId);
    if (!target) return;
    const from = rowOf(href);
    if (from && from.row === target.row && from.index === target.index) return;
    void commit(href, (current) =>
      placeHrefInRow(current, activeModuleId, href, target.row, target.index),
    );
  };

  return (
    <DndContext
      collisionDetection={navRowCollisions}
      onDragCancel={() => setDragging(null)}
      onDragEnd={handleDragEnd}
      onDragStart={(event) => {
        const href = String(event.active.id);
        setDragging([...upperRow, ...lowerRow].find((entry) => entry.href === href) ?? null);
      }}
      sensors={sensors}
    >
      <span aria-hidden className="hidden" ref={bindShortcuts} />
      {children}
      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-phx-sm font-semibold tracking-[-0.01em]",
              dark
                ? "bg-[linear-gradient(180deg,#241a10_0%,#1a1209_55%,#140d06_100%)] text-[#FFC98A] shadow-[inset_0_0_0_1px_rgba(248,181,107,0.4),0_10px_24px_-6px_rgba(0,0,0,0.9)]"
                : "bg-phx-accent-soft text-phx-accent shadow-lg",
            )}
          >
            <dragging.icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span>{dragging.label}</span>
          </span>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * ONE tab.
 *
 * Extracted so the two rows below — the rich admin/HR one and the portal's plain scroller — render
 * the SAME element rather than two copies of a long class string that drift apart. That mattered
 * immediately: every visual change belongs to the `dark` branch only, and a second copy is how the
 * employee portal would quietly acquire one.
 */
function NavRowTab({
  active,
  dark,
  item,
  jumpKey,
  locked,
  onContextMenu,
  tabRef,
}: {
  active: boolean;
  dark: boolean;
  item: NavigationSectionItem;
  /** Its Alt+N number, when it is one of the first nine tabs across both rows. Null past that. */
  jumpKey: number | null;
  locked: boolean;
  onContextMenu?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  tabRef?: (node: HTMLAnchorElement | null) => void;
}) {
  const Icon = locked ? Lock : item.icon;
  return (
    <Link
      aria-current={active ? "page" : undefined}
      // The lock warning outranks the shortcut hint — a padlocked tab has a reason it cannot be
      // opened, and that is the more useful thing to read. The Alt hint is otherwise the ONLY place
      // the keyboard jump is advertised, which is why it is here on every surface rather than only
      // where the rest of the rich interaction lives: the shortcut itself works everywhere.
      title={
        locked
          ? `${item.label} — locked temporarily by the system administrator`
          : jumpKey !== null
            ? `${item.label} — Alt+${jumpKey}`
            : undefined
      }
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-phx-sm font-semibold tracking-[-0.01em] transition-colors",
        // EVERY visual change here sits in the `dark` branch, which is `usesAdminChrome`
        // — admin and HR. The light strings below are the employee portal's and are left
        // byte-identical on purpose (owner, 2026-08-29: "DONOT TOUCH THE EMPLOYEE PORTAL
        // I AM TALKING ON ADMIN SHELL"). The behaviour added above — arrow-key focus and
        // centring the lit tab — is shared, because neither moves a pixel at rest.
        //
        // The active tab was a flat grey chip, which on a black bar reads as a hover
        // state rather than a selection. It now carries the warm accent on a tinted
        // ground with a hairline inset ring, so "where am I" survives a row of twelve
        // tabs. `transition-[…]` replaces the base `transition-colors` through
        // tailwind-merge so the ring animates too; the light branch keeps the original.
        dark
          ? active
            ? "group relative bg-[linear-gradient(180deg,#241a10_0%,#1a1209_55%,#140d06_100%)] text-[#FFC98A] shadow-[inset_0_0_0_1px_rgba(248,181,107,0.26),inset_0_1px_0_rgba(255,214,168,0.16),inset_0_-2px_0_#F8B56B,0_3px_12px_-4px_rgba(248,181,107,0.45)] transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#F8B56B]/70"
            : "group relative text-[#C9D4E2] hover:bg-[#151311] hover:text-[#F0D5B0] hover:shadow-[inset_0_0_0_1px_#241f19,inset_0_1px_0_rgba(255,255,255,0.045)] transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#F8B56B]/70"
          : active
            ? "bg-phx-accent-soft text-phx-accent"
            : "text-phx-ink-soft hover:bg-phx-paper hover:text-phx-ink",
        // Last, so a locked tab never wears the live or active styling.
        locked && (dark ? "text-amber-300/80" : "text-amber-600"),
      )}
      data-navrow-tab=""
      href={item.href}
      onContextMenu={onContextMenu}
      ref={tabRef}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          // An idle icon at full strength competes with its own label. Dark only.
          dark && !active && "opacity-70 transition-opacity group-hover:opacity-100",
          dark && active && "drop-shadow-[0_0_6px_rgba(248,181,107,0.5)]",
        )}
      />
      <span>{item.label}</span>
      {/* The same pending count the sidebar shows on the same page, from the same
          polling client — a tab pinned up here must not be the one place a queue of 54
          waiting approvals is invisible. `compact={false}` is the pill; the icon-rail
          dot would have nothing to sit on here. */}
      <ApprovalNavBadge compact={false} navBadge={item.navBadge} />
    </Link>
  );
}

/** The same button the "+" is, so the row's trailing controls read as one set. */
function navRowButtonClass(dark: boolean, lit: boolean): string {
  return cn(
    "inline-flex shrink-0 items-center justify-center rounded-lg p-1.5 transition-colors",
    dark
      ? lit
        ? "text-[#F8B56B] shadow-[inset_0_0_0_1px_rgba(248,181,107,0.26)] transition-[background-color,color,box-shadow] hover:bg-[#151311]"
        : "text-[#7C8DA3] transition-[background-color,color,box-shadow] hover:bg-[#151311] hover:text-[#F8B56B] hover:shadow-[inset_0_0_0_1px_#241f19,inset_0_1px_0_rgba(255,255,255,0.045)]"
      : lit
        ? "text-phx-accent hover:bg-phx-paper"
        : "text-phx-ink-soft hover:bg-phx-paper hover:text-phx-accent",
  );
}

/**
 * A draggable tab, plus the right-click menu that hangs off it.
 *
 * `listeners` go on the WRAPPER and `attributes` are deliberately NOT spread. dnd-kit's attributes
 * turn their host into `role="button"` with its own tab stop, which around a real `<a>` would give
 * every tab two focus stops and two accessible names. Keyboard users lose nothing: the arrow keys
 * still walk the row, and the right-click menu — reachable with the context-menu key — carries the
 * same four moves the pointer can make.
 */
function SortableNavRowTab(tab: Parameters<typeof NavRowTab>[0]) {
  const { isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: tab.item.href,
  });
  return (
    <div
      className={cn("relative shrink-0", isDragging && "opacity-40")}
      // What `measure()` below reads to learn this tab's natural width. It sits on the wrapper
      // rather than the link because the wrapper is the flex item, so it is the box that has to fit.
      data-navrow-slot={tab.item.href}
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // Required by dnd-kit's pointer sensor: without it a touch-drag scrolls the page instead.
        // Safe here and NOT on the portal, which is why the whole rich model is gated — see
        // `richInteraction`. This row has no sideways scroll left to lose.
        touchAction: "none",
      }}
      {...listeners}
    >
      <NavRowTab {...tab} />
    </div>
  );
}

/**
 * The ADMIN/HR row: drag to reorder, a right-click menu on every tab, a one-press pin, and an
 * overflow menu for whatever does not fit.
 *
 * ── Why an overflow menu and not the sideways scroll ────────────────────────────────────────────
 * A scroller obeys the owner's no-horizontal-scroll rule for the PAGE, but it still hides tabs
 * behind a gesture with no affordance — on a hidden scrollbar there is nothing on screen saying
 * more exists. The "»" says so, and names them.
 *
 * ── How the cut is measured ─────────────────────────────────────────────────────────────────────
 * Widths are recorded per href as tabs render and cached, because a tab moved INTO the menu is no
 * longer in the DOM to be measured — without the cache it could never be judged to fit again and
 * the row would only ever shed tabs. The available room is read from the row and its trailing
 * controls, never from the tabs' own container: that container is content-sized, so measuring it
 * would shrink as tabs left it and collapse the row one tab at a time.
 *
 * Measurement runs from ref callbacks and a ResizeObserver rather than an effect — `setState`
 * inside `useEffect` is a lint error in this repo — and `setMeasured` bails out when the answer is
 * unchanged, which is what stops a measure → render → measure loop.
 */
function RichNavRow({
  activeHref,
  activeModuleId,
  dark,
  items,
  jumpBase,
  lockedModuleKeys,
  pinnable,
  target,
  trailing,
}: {
  activeHref: string | null;
  activeModuleId: string | null;
  dark: boolean;
  items: readonly NavigationSectionItem[];
  jumpBase: number;
  lockedModuleKeys: ReturnType<typeof useLockedModuleKeys>;
  pinnable: NavigationSectionItem | null;
  target: keyof PersonalLayoutRowSet;
  trailing?: ReactNode;
}) {
  const router = useRouter();
  const { active } = useDndContext();
  const { clearError, commit, error, pending } = useNavLayoutCommit();
  // The tab whose right-click menu is open, plus where along the row to put the panel — see
  // `offsetLeft` on NavMenuPanel for why the panel cannot simply hang off the tab itself.
  const [menuFor, setMenuFor] = useState<{ href: string; left: number } | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [measured, setMeasured] = useState<{ signature: string; cut: number } | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const widthsRef = useRef(new Map<string, number>());
  // Dropping on the row's own empty space appends, which is the only way to move a tab to the end
  // of a row that is not full — there is no tab out there to drop onto.
  const { setNodeRef: setRowDropRef } = useDroppable({ id: `${ROW_DROP_PREFIX}${target}` });

  const signature = items.map((entry) => entry.href).join("|");

  const measure = useCallback(() => {
    const row = rowRef.current;
    const tabs = tabsRef.current;
    if (!row || !tabs) return;
    // A row with no width has not been laid out yet — during a client-side remount, or before the
    // first paint of a viewport change. Measuring it answers "nothing fits" and stores that, and
    // the row then sits with every tab in the menu until something else happens to re-measure.
    if (row.clientWidth === 0) return;
    for (const node of Array.from(tabs.querySelectorAll<HTMLElement>("[data-navrow-slot]"))) {
      const href = node.dataset.navrowSlot;
      if (href) widthsRef.current.set(href, node.offsetWidth);
    }
    const controls = controlsRef.current?.offsetWidth ?? 0;
    const room = row.clientWidth - (controls > 0 ? controls + ROW_GAP : 0);
    const fits = (space: number): number => {
      let used = 0;
      for (let index = 0; index < items.length; index += 1) {
        const width = widthsRef.current.get(items[index]!.href);
        // Never measured — it has not been on screen yet. Showing everything is the safe answer,
        // because that is what puts it on screen and makes the next pass able to judge it.
        if (width === undefined) return items.length;
        used += (index > 0 ? ROW_GAP : 0) + width;
        if (used > space) return index;
      }
      return items.length;
    };
    // Two passes: the "»" only costs room when it exists, and whether it exists is what is being
    // decided. One pass with the button always reserved would hide a tab that actually fits.
    const loose = fits(room);
    const cut = loose === items.length ? loose : fits(room - OVERFLOW_BUTTON_WIDTH - ROW_GAP);
    setMeasured((current) =>
      current && current.signature === signature && current.cut === cut
        ? current
        : { signature, cut },
    );
  }, [items, signature]);

  const bindRow = useCallback(
    (node: HTMLDivElement | null) => {
      rowRef.current = node;
      if (!node) return;
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => {
        observer.disconnect();
        rowRef.current = null;
      };
    },
    [measure],
  );

  // Memoized, so the droppable is registered once and not torn down and rebuilt under an in-flight
  // drag. It re-attaches when `measure` changes identity, which is whenever `items` does.
  const bindTabs = useCallback(
    (node: HTMLDivElement | null) => {
      tabsRef.current = node;
      setRowDropRef(node);
      if (node) measure();
    },
    [measure, setRowDropRef],
  );

  // A stale measurement belongs to a different row — show everything until this one is measured,
  // never a cut computed for tabs that are no longer here.
  const cut = measured && measured.signature === signature ? measured.cut : items.length;
  const visible = items.slice(0, cut);
  const overflowed = items.slice(cut);
  const activeIsHidden = overflowed.some((entry) => entry.href === activeHref);

  const move = (href: string, row: keyof PersonalLayoutRowSet, index: number) =>
    void commit(href, (current) => placeHrefInRow(current, activeModuleId, href, row, index));

  const otherRow: keyof PersonalLayoutRowSet = target === "upperRow" ? "lowerRow" : "upperRow";

  const tabMenu = (item: NavigationSectionItem, index: number): NavMenuItem[] => [
    {
      disabled: index === 0,
      icon: ArrowLeftToLine,
      id: "start",
      label: "Move to the start",
      onSelect: () => move(item.href, target, 0),
    },
    {
      disabled: index === items.length - 1,
      icon: ArrowRightToLine,
      id: "end",
      label: "Move to the end",
      onSelect: () => move(item.href, target, Number.MAX_SAFE_INTEGER),
    },
    {
      icon: target === "upperRow" ? ChevronsDown : ChevronsUp,
      id: "other-row",
      label: target === "upperRow" ? "Move to the lower row" : "Move to the upper row",
      onSelect: () => move(item.href, otherRow, Number.MAX_SAFE_INTEGER),
    },
    {
      icon: ExternalLink,
      id: "new-tab",
      label: "Open in a new tab",
      onSelect: () => window.open(item.href, "_blank", "noopener,noreferrer"),
    },
    {
      icon: X,
      id: "remove",
      label: "Remove from the row",
      // `unpinHrefFromRows`, not a row edit: removal has to reach every module override too, or the
      // tab stays stuck inside each module the viewer has arranged. See its own doc comment.
      onSelect: () => void commit(item.href, (current) => unpinHrefFromRows(current, item.href)),
    },
  ];

  const openMenuFor = (item: NavigationSectionItem, event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    clearError();
    const row = rowRef.current;
    if (!row) return;
    // Measured against the ROW, because that is what the panel hangs from, and clamped so a
    // right-click on the last tab does not open a panel half off the screen.
    const offset = event.currentTarget.getBoundingClientRect().left - row.getBoundingClientRect().left;
    const left = Math.max(0, Math.min(offset, row.clientWidth - NAV_MENU_PANEL_WIDTH));
    setMenuFor((was) => (was?.href === item.href ? null : { href: item.href, left }));
  };

  const menuItem = menuFor ? items.find((entry) => entry.href === menuFor.href) : undefined;
  const menuIndex = menuItem ? items.indexOf(menuItem) : -1;

  return (
    <div className="relative flex items-center gap-1" ref={bindRow}>
      <div
        className={cn(
          "flex min-w-0 items-center gap-1 overflow-hidden",
          // An EMPTY row has no tab to aim at, so while a tab is in flight it grows into a drop
          // target of its own. Only during a drag: at rest this would move the row's "+" from
          // beside the left edge out to the far right, which is where it has always been.
          items.length === 0 &&
            active &&
            cn(
              "h-7 flex-1 rounded-lg border border-dashed",
              dark ? "border-[#3a3128]" : "border-phx-line",
            ),
        )}
        ref={bindTabs}
      >
        <SortableContext
          items={visible.map((entry) => entry.href)}
          strategy={horizontalListSortingStrategy}
        >
          {visible.map((item, index) => {
            const jump = jumpBase + index + 1;
            return (
              <SortableNavRowTab
                active={item.href === activeHref}
                dark={dark}
                item={item}
                jumpKey={jump <= 9 ? jump : null}
                key={item.href}
                locked={isNavItemLockedFor(item, lockedModuleKeys)}
                onContextMenu={(event) => openMenuFor(item, event)}
              />
            );
          })}
        </SortableContext>
      </div>

      {overflowed.length > 0 ? (
        <div className="relative shrink-0">
          <button
            aria-label={`${overflowed.length} more ${overflowed.length === 1 ? "page" : "pages"} on this row`}
            // Lit when the page you are ON is one of the hidden ones — otherwise the row would show
            // no active tab at all and read as "you are nowhere".
            className={navRowButtonClass(dark, activeIsHidden)}
            onClick={() => setOverflowOpen((was) => !was)}
            title={`${overflowed.length} more`}
            type="button"
          >
            <MoreHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
          {overflowOpen ? (
            <NavMenuPanel
              align="right"
              dark={dark}
              items={overflowed.map((item) => ({
                hint: item.href === activeHref ? "Current" : undefined,
                icon: isNavItemLockedFor(item, lockedModuleKeys) ? Lock : item.icon,
                id: item.href,
                label: item.label,
                onSelect: () => router.push(item.href),
              }))}
              onClose={() => setOverflowOpen(false)}
              title="More pages"
            />
          ) : null}
        </div>
      ) : null}

      {/* The trailing controls, measured as one box. `trailing` (the "+") sits OUTSIDE the tab
          container on purpose: `overflow-hidden` there would clip the panel it opens.

          Its ref is deliberately NOT memoized, which makes it the one thing that re-measures on
          every render. The ResizeObserver above only answers a change of ROW width; a tab's own
          width can change under it — an approval badge arriving from the poll, a font settling —
          and each of those is a render. Safe to run every time because `setMeasured` bails out when
          the answer has not moved, and safe HERE rather than on the tab container because this box
          holds no droppable to churn. */}
      <div
        className="flex shrink-0 items-center gap-1"
        ref={(node) => {
          controlsRef.current = node;
          if (node) measure();
        }}
      >
        {error ? (
          <button
            className={cn(
              "shrink-0 rounded-lg px-2 py-1 text-[11px] font-semibold",
              dark ? "text-rose-300 hover:bg-[#151311]" : "text-rose-600 hover:bg-phx-paper",
            )}
            onClick={clearError}
            title={`${error} Press to dismiss.`}
            type="button"
          >
            Not saved
          </button>
        ) : null}
        {pinnable ? (
          <button
            aria-label={`Pin ${pinnable.label} to this row`}
            className={navRowButtonClass(dark, false)}
            disabled={pending === pinnable.href}
            onClick={() =>
              void commit(pinnable.href, (current) =>
                pinHrefToRow(current, pinnable.href, target),
              )
            }
            title={`Pin ${pinnable.label} to this row`}
            type="button"
          >
            <Pin aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {trailing}
      </div>

      {/* Outside the tab container on purpose — see `offsetLeft`. Rendered last so it stacks over
          the controls rather than under them. */}
      {menuFor && menuItem ? (
        <NavMenuPanel
          dark={dark}
          items={tabMenu(menuItem, menuIndex)}
          offsetLeft={menuFor.left}
          onClose={() => setMenuFor(null)}
          title={menuItem.label}
        />
      ) : null}
    </div>
  );
}

/**
 * One horizontal row of tabs.
 *
 * Never wraps and never truncates with an ellipsis (owner's standing rule). Admin and HR shed the
 * tabs that do not fit into an overflow menu; the employee portal keeps the sideways scroller it
 * shipped with, so the page body never scrolls on either.
 */
function NavRowStrip({
  activeHref,
  activeModuleId,
  ariaLabel,
  className,
  dark,
  items,
  jumpBase,
  keepWhenEmpty = false,
  pinnable,
  rich,
  target,
  trailing,
}: {
  activeHref: string | null;
  activeModuleId: string | null;
  ariaLabel: string;
  className?: string;
  dark: boolean;
  items: readonly NavigationSectionItem[];
  /** How many tabs are numbered before this row, so Alt+1…9 runs across both in reading order. */
  jumpBase: number;
  /** Render the row even with no tabs in it, so its "+" survives being emptied. See the header. */
  keepWhenEmpty?: boolean;
  /** The current page when it is on NEITHER row — what this row's one-press pin would add. */
  pinnable: NavigationSectionItem | null;
  /** Drag, overflow menu, right-click menu and the pin. Admin and HR only — see `richInteraction`. */
  rich: boolean;
  target: keyof PersonalLayoutRowSet;
  /** Rendered after the last tab. The "+" that adds a page to this row. */
  trailing?: ReactNode;
}) {
  // Read BEFORE the early return below — a hook after a conditional return is a rules-of-hooks
  // violation. A pinned tab whose module is temporarily locked carries the same padlock the sidebar
  // shows; a row pinned by the viewer is the one place they are most likely to look first.
  const lockedModuleKeys = useLockedModuleKeys();

  // An empty row renders nothing — unless `keepWhenEmpty` says this viewer has a layout of their
  // own, in which case the lone "+" is their way back in. That keeps the promise made at the top of
  // this file: the bar stays invisible for every account that has never arranged anything, rather
  // than a "+" appearing on all 243 pages for everyone.
  if (items.length === 0 && !keepWhenEmpty) return null;

  // Bring the LIT tab into view when the row is wider than the space it has. A ref callback rather
  // than an effect, for two reasons: `setState` inside `useEffect` is a lint error in this repo, and
  // this needs no state at all — the callback fires with the node the moment it is in the DOM, which
  // is exactly when the measurement becomes possible. It re-fires on navigation for free, because a
  // DIFFERENT node receives the ref when the active href changes; nothing has to watch the pathname.
  //
  // It moves the SCROLLER and never the page. `scrollIntoView` would walk up to the document and
  // scroll the whole shell to reach a tab sitting inside frozen chrome, which is the one thing this
  // bar must never do. It also returns early when the tab is already fully visible, so it cannot
  // fight a viewer who has just dragged the row sideways by hand.
  //
  // Only the plain row needs it: the rich one has no scroller to move, and an off-screen tab there
  // is in the overflow menu rather than out of reach.
  const centreActiveTab = (node: HTMLAnchorElement | null) => {
    if (!node) return;
    const scroller = node.parentElement;
    if (!scroller) return;
    const overflow = scroller.scrollWidth - scroller.clientWidth;
    if (overflow <= 0) return;
    const left = node.offsetLeft;
    if (left >= scroller.scrollLeft && left + node.offsetWidth <= scroller.scrollLeft + scroller.clientWidth) {
      return;
    }
    const centred = left - (scroller.clientWidth - node.offsetWidth) / 2;
    scroller.scrollLeft = Math.max(0, Math.min(centred, overflow));
  };

  // Arrow keys walk the row; Home and End jump to its ends. Without this a tab that has scrolled out
  // of sight is unreachable without a mouse — the row is a horizontal strip with a hidden scrollbar,
  // so there is nothing else to grab. Focus MOVES and nothing is activated, so it can never navigate
  // by accident. The tabs are read from the DOM at press time rather than from `items`, which keeps
  // it correct whatever else a host decides to render into the row.
  const moveFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") {
      return;
    }
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLAnchorElement>("a[data-navrow-tab]"));
    const current = tabs.indexOf(document.activeElement as HTMLAnchorElement);
    if (tabs.length === 0 || current === -1) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : event.key === "ArrowLeft"
            ? (current - 1 + tabs.length) % tabs.length
            : (current + 1) % tabs.length;
    tabs[next]?.focus();
  };

  return (
    <nav aria-label={ariaLabel} className={className} onKeyDown={moveFocus}>
      {rich ? (
        <RichNavRow
          activeHref={activeHref}
          activeModuleId={activeModuleId}
          dark={dark}
          items={items}
          jumpBase={jumpBase}
          lockedModuleKeys={lockedModuleKeys}
          pinnable={pinnable}
          target={target}
          trailing={trailing}
        />
      ) : (
        // Two nested flex rows, not one. The tabs scroll sideways when they outgrow the viewport,
        // but `trailing` has to sit OUTSIDE that scroller: a container with `overflow-x: auto`
        // resolves its `overflow-y` to `auto` as well, so the "+" panel would be clipped by the
        // row it hangs from. `min-w-0` lets the scroller shrink to its content, which keeps the
        // "+" immediately after the last tab on a short row rather than parked at the far right.
        <div className="flex items-center gap-1">
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto phoenix-navrow-scroll">
            {items.map((item, index) => {
              const active = item.href === activeHref;
              const jump = jumpBase + index + 1;
              return (
                <NavRowTab
                  active={active}
                  dark={dark}
                  item={item}
                  jumpKey={jump <= 9 ? jump : null}
                  key={item.href}
                  locked={isNavItemLockedFor(item, lockedModuleKeys)}
                  // Only the ACTIVE tab carries the ref, so exactly one node per row asks to be
                  // centred and the callback re-fires when that identity changes. See above.
                  tabRef={active ? centreActiveTab : undefined}
                />
              );
            })}
          </div>
          {trailing}
        </div>
      )}
    </nav>
  );
}

/**
 * The current page when it is on NEITHER row — what a one-press pin would add.
 *
 * Null once it sits on a row, because from there the "+" panel's tick, the right-click menu and a
 * drag all move it and a pin beside them would only be a fourth way to do the same thing. Null too
 * for an account that has never saved a layout: the rows are invisible for those 158 people
 * (see the header), and a pin is exactly the control that would make itself visible on all 243
 * pages for all of them.
 *
 * Both rows offer it, each pinning to itself — the same shape as the two "+" buttons, and the only
 * way for one press to mean "put it up top" as opposed to "put it down below".
 */
function pinnableCurrentPage(rows: ResolvedRows): NavigationSectionItem | null {
  const current = rows.currentItem;
  if (!current || !rows.hasSavedLayout) return null;
  const alreadyOnARow = [...rows.upperRow, ...rows.lowerRow].some(
    (entry) => entry.href === current.href,
  );
  return alreadyOnARow ? null : current;
}

/**
 * ZONE 2 — the horizontal bar above the page title. Rendered once per shell.
 *
 * `className` REPLACES the default frame rather than adding to it, because the two shells that
 * mount this row sit on surfaces with nothing in common: the admin chrome is a flat black bar
 * flush against the topbar, and the employee portal is a light card layout where a full-bleed bar
 * with a hard bottom border would read as someone else's component. The owner's standing rule is
 * that new UI matches the design identity of the module it lands in, so the host supplies the
 * frame. Omitting it keeps the admin/HR frame exactly as shipped.
 */
export function UpperNavRow({ className }: { className?: string } = {}) {
  const rows = useContext(HorizontalNavContext);
  const { upperRow, activeHref, upperAddable, canAdd, dark, hasSavedLayout } = rows;
  return (
    <NavRowStrip
      activeHref={activeHref}
      activeModuleId={rows.activeModuleId}
      ariaLabel="Upper navigation"
      // Never `sticky` on its own — the HOST pins it. AppShell wraps the Topbar and both rows in
      // one sticky container so the whole block travels as a unit, which is what lets it freeze
      // without anyone hard-coding the Topbar's rendered height. Two separate stickies at top-0
      // would not stack: they slide to the same offset and overlap. That is why the pinning lives
      // in the host and this row only ever describes its own frame.
      className={cn(
        className ??
          cn(
            "border-b px-3 py-1.5 sm:px-6",
            // `phx-navrow-upper` only tells the stylesheet what colour this row's ground is, so the
            // scroll-shadow gradients in app/globals.css can mask themselves against it. It is not
            // a `--` marker of the retired in-page/fallback kind and nothing keys a `:has()` on it.
            //
            // The ground is a shallow vertical gradient rather than flat #000000 — a lit surface
            // instead of a void. Keep the range under ~12/255: the mask that hides the scroll glow
            // is a SOLID colour (`--phx-navrow-ground`), so it can only match a gradient this
            // subtle. Widening the gradient here without teaching that mask about it puts a visible
            // seam at both ends of the row.
            dark
              ? "phx-navrow-upper border-[#241f19] bg-[linear-gradient(180deg,#0b0a08_0%,#050505_60%,#000000_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]"
              : "border-phx-line bg-white",
          ),
      )}
      dark={dark}
      items={upperRow}
      // The upper row is read first, so it holds Alt+1 onwards and the lower row carries on from
      // wherever it stops. Numbering each row from 1 would give two tabs the same shortcut.
      jumpBase={0}
      keepWhenEmpty={canAdd && hasSavedLayout}
      pinnable={pinnableCurrentPage(rows)}
      rich={rows.richInteraction}
      target="upperRow"
      trailing={
        canAdd ? (
          <NavRowAddButton
            dark={dark}
            pinned={upperRow}
            sections={upperAddable}
            target="upperRow"
          />
        ) : null
      }
    />
  );
}

/**
 * ZONE 3 — the second horizontal row, pinned directly beneath ZONE 2.
 *
 * It used to have two placements: an `in-page` copy that a page's own title surface rendered, and
 * a `fallback` copy in AppShell for pages with no such surface, deduped by a `:has()` rule in
 * app/globals.css. Both are gone. The owner asked for the rows to be FROZEN in every module, and a
 * row rendered inside a page's hero can never be: `position: sticky` is bounded by its containing
 * block, so a row inside a short hero unpins the moment that hero scrolls away, whatever classes
 * it carries. The shell's sticky header is the only place a row CAN be frozen from — and putting
 * it there also lands the row in the same spot on every page, which the two placements never did.
 *
 * `className` replaces the row's whole frame, so each host dresses it for its own surface: the
 * admin chrome gives it a full-bleed dark bar, the employee portal a rounded translucent card.
 */
export function LowerNavRow({ className }: { className?: string } = {}) {
  const rows = useContext(HorizontalNavContext);
  const { lowerRow, activeHref, canAdd, dark, hasSavedLayout, lowerAddable } = rows;
  return (
    <NavRowStrip
      activeHref={activeHref}
      activeModuleId={rows.activeModuleId}
      ariaLabel="Lower navigation"
      className={cn(
        className ??
          cn(
            "border-b px-3 py-1.5 sm:px-6",
            // #050505 against the upper row's #000000 was a 5/255 step — invisible, so the two rows
            // read as one tall slab and neither looked deliberate. A slightly lifted gradient plus
            // a WARM top hairline separates them at a glance while staying unmistakably black; the
            // amber tint is what makes the seam read as intended rather than as a rendering edge.
            // Same masking role for `phx-navrow-lower` as its sibling above, and the same ceiling on
            // how far the gradient may travel.
            dark
              ? "phx-navrow-lower border-[#241f19] bg-[linear-gradient(180deg,#0d0b09_0%,#080706_55%,#040404_100%)] shadow-[inset_0_1px_0_rgba(248,181,107,0.08)]"
              : "border-phx-line bg-white/95",
          ),
      )}
      dark={dark}
      items={lowerRow}
      // Carries on from the upper row's last number — see its own `jumpBase`.
      jumpBase={rows.upperRow.length}
      keepWhenEmpty={canAdd && hasSavedLayout}
      pinnable={pinnableCurrentPage(rows)}
      rich={rows.richInteraction}
      target="lowerRow"
      trailing={
        canAdd ? (
          <NavRowAddButton
            dark={dark}
            pinned={lowerRow}
            sections={lowerAddable}
            target="lowerRow"
          />
        ) : null
      }
    />
  );
}

