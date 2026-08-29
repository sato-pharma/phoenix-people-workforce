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
//   Zone 2 (upper) — in AppShell, directly under the Topbar. One place, so it
//                    reaches all 243 pages with no per-page edit.
//   Zone 3 (lower) — under the page title. There is no single page-title
//                    component in this app (37 pages write their own <h1>, 206
//                    render one from a client component), so this row is
//                    emitted by the two shared surfaces that DO cover a large
//                    share of them — AdminPageHero and the employee-pages shell
//                    — and AppShell renders a FALLBACK copy for everything else.
//                    `.phx-navrow-scope:has(.phx-navrow--inpage)` in
//                    app/globals.css hides the fallback whenever a page placed
//                    the row itself, so exactly one copy ever renders.
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
// Like the sidebar, this is UX and never the security boundary: the items come
// from `getSections` (already permission- and role-filtered) and are only
// REARRANGED by `applyPersonalLayout`, which cannot introduce an href.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { ApprovalNavBadge } from "@/components/layout/nav-badge";
import { NavRowAddButton } from "@/components/layout/nav-row-add-button";
import { useDarkSurface } from "@/components/ui/surface-context";
import {
  getNavigationSections,
  type NavigationSection,
  type NavigationSectionItem,
} from "@/config/system-navigation";
import { type NavigationMode, type PhoenixRole } from "@/lib/auth/permissions";
import {
  getActiveHref,
  getSections,
  normalizePathnameForMode,
  usesAdminChrome,
  type PermissionLookup,
} from "@/lib/navigation/active-path";
import { applyPersonalLayout, type PersonalNavigationLayout } from "@/lib/navigation/personal-layout";
import { cn } from "@/lib/utils";

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
  /** Whether to render a "+" at all. Admin chrome only, the same restriction as the layout itself. */
  canAdd: boolean;
  /** Has this viewer ever saved a layout? The one case where an EMPTY row still shows its "+". */
  hasSavedLayout: boolean;
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
  isSystemAdministratorWorkspace = false,
  navigationMode = "admin",
  permissionLookup = {},
  personalLayout = null,
}: {
  children: ReactNode;
  currentRole?: PhoenixRole;
  isSystemAdministratorWorkspace?: boolean;
  navigationMode?: NavigationMode;
  permissionLookup?: PermissionLookup;
  personalLayout?: PersonalNavigationLayout | null;
}) {
  const pathname = normalizePathnameForMode(usePathname(), navigationMode);
  const searchParams = useSearchParams();
  const activeTab = searchParams.get("action") ?? searchParams.get("tab");

  const value = useMemo<ResolvedRows>(() => {
    const gated = getSections(
      getNavigationSections(navigationMode),
      navigationMode,
      permissionLookup,
      currentRole,
      isSystemAdministratorWorkspace,
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
    const layout = usesAdminChrome(navigationMode) ? personalLayout : null;
    const applied = applyPersonalLayout(gated, layout, activeModuleId);
    // What each "+" offers: the gated sections with the pages already on THAT row taken out, so the
    // list never proposes a page sitting two centimetres to its left. Deliberately scoped to one
    // row rather than both — a page on the lower row IS offered by the upper "+", and pinning it
    // there releases the lower row, which makes that press a MOVE. That is the owner's "freely able
    // to exchange tabs that appeared either above or either down", reachable without the editor.
    //
    // Built from `gated` for the same reason `activeModuleId` is: it is the permission-filtered
    // set, so the picker inherits the gate rather than re-deciding it, and can no more introduce an
    // href than `applyPersonalLayout` can.
    const addableFor = (row: readonly NavigationSectionItem[]): readonly NavigationSection[] => {
      const onRow = new Set(row.map((entry) => entry.href));
      return gated
        .map((section) => ({
          ...section,
          items: section.items.filter((entry) => !onRow.has(entry.href)),
        }))
        .filter((section) => section.items.length > 0);
    };
    return {
      upperRow: applied.upperRow,
      lowerRow: applied.lowerRow,
      upperAddable: addableFor(applied.upperRow),
      lowerAddable: addableFor(applied.lowerRow),
      canAdd: usesAdminChrome(navigationMode),
      hasSavedLayout: layout !== null,
      // Resolved against the FULL gated set, not just the rows, so a tab stays lit on its child
      // routes and the deepest match still wins over a shallower one sitting in another zone.
      activeHref: active,
      dark: usesAdminChrome(navigationMode),
    };
  }, [
    activeTab,
    currentRole,
    isSystemAdministratorWorkspace,
    navigationMode,
    pathname,
    permissionLookup,
    personalLayout,
  ]);

  return <HorizontalNavContext.Provider value={value}>{children}</HorizontalNavContext.Provider>;
}

/**
 * One horizontal row of tabs.
 *
 * Never wraps and never truncates with an ellipsis (owner's standing rule) — a row longer than the
 * viewport scrolls sideways inside its own container instead, so the page body never scrolls.
 */
function NavRowStrip({
  ariaLabel,
  className,
  dark,
  items,
  activeHref,
  keepWhenEmpty = false,
  trailing,
}: {
  activeHref: string | null;
  ariaLabel: string;
  className?: string;
  dark: boolean;
  items: readonly NavigationSectionItem[];
  /** Render the row even with no tabs in it, so its "+" survives being emptied. See the header. */
  keepWhenEmpty?: boolean;
  /** Rendered after the last tab. The "+" that adds a page to this row. */
  trailing?: ReactNode;
}) {
  // An empty row renders nothing — unless `keepWhenEmpty` says this viewer has a layout of their
  // own, in which case the lone "+" is their way back in. That keeps the promise made at the top of
  // this file: the bar stays invisible for every account that has never arranged anything, rather
  // than a "+" appearing on all 243 pages for everyone.
  if (items.length === 0 && !keepWhenEmpty) return null;

  return (
    <nav aria-label={ariaLabel} className={className}>
      {/* Two nested flex rows, not one. The tabs scroll sideways when they outgrow the viewport,
          but `trailing` has to sit OUTSIDE that scroller: a container with `overflow-x: auto`
          resolves its `overflow-y` to `auto` as well, so the "+" panel would be clipped by the
          row it hangs from. `min-w-0` lets the scroller shrink to its content, which keeps the
          "+" immediately after the last tab on a short row rather than parked at the far right. */}
      <div className="flex items-center gap-1">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto phoenix-navrow-scroll">
          {items.map((item) => {
            const active = item.href === activeHref;
            const Icon = item.icon;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-phx-sm font-semibold tracking-[-0.01em] transition-colors",
                  dark
                    ? active
                      ? "bg-[#1a1a1a] text-[#F8B56B]"
                      : "text-[#D4DDE8] hover:bg-[#141414] hover:text-[#F8B56B]"
                    : active
                      ? "bg-phx-accent-soft text-phx-accent"
                      : "text-phx-ink-soft hover:bg-phx-paper hover:text-phx-ink",
                )}
                href={item.href}
                key={item.href}
              >
                <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span>{item.label}</span>
                {/* The same pending count the sidebar shows on the same page, from the same
                    polling client — a tab pinned up here must not be the one place a queue of 54
                    waiting approvals is invisible. `compact={false}` is the pill; the icon-rail
                    dot would have nothing to sit on here. */}
                <ApprovalNavBadge compact={false} navBadge={item.navBadge} />
              </Link>
            );
          })}
        </div>
        {trailing}
      </div>
    </nav>
  );
}

/** ZONE 2 — the horizontal bar above the page title. Rendered once, by AppShell. */
export function UpperNavRow() {
  const { upperRow, activeHref, upperAddable, canAdd, dark, hasSavedLayout } =
    useContext(HorizontalNavContext);
  return (
    <NavRowStrip
      activeHref={activeHref}
      ariaLabel="Upper navigation"
      // Deliberately NOT sticky. The Topbar above it is `sticky top-0 z-20`; a second sticky at
      // top-0 does not stack under it, it slides to the same offset and the two overlap. Pinning
      // this row would mean hard-coding the Topbar's rendered height, which changes with the
      // viewport — so the row scrolls with the page instead.
      className={cn(
        "border-b px-3 py-1.5 sm:px-6",
        dark ? "border-[#1a1a1a] bg-[#000000]" : "border-phx-line bg-white",
      )}
      dark={dark}
      items={upperRow}
      keepWhenEmpty={canAdd && hasSavedLayout}
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
 * ZONE 3 — the horizontal row below the page title.
 *
 * `placement="in-page"` is what a page (or a shared page surface such as AdminPageHero) renders
 * directly under its own title. `placement="fallback"` is AppShell's copy for the pages that have
 * no shared title surface; the CSS in app/globals.css hides it whenever an in-page copy exists, so
 * the two can never both appear.
 */
export function LowerNavRow({
  className,
  placement,
}: {
  /** The host's own frame for the row (padding, divider). Only the in-page copy uses this: each
   *  host sits on a different surface, and the row must vanish WITH its frame when the viewer has
   *  put nothing in it — which is why the frame is these classes rather than a wrapping element. */
  className?: string;
  placement: "in-page" | "fallback";
}) {
  const { lowerRow, activeHref, canAdd, dark, hasSavedLayout, lowerAddable } =
    useContext(HorizontalNavContext);
  // The in-page copy takes its palette from the surface it was dropped onto, not from the shell:
  // inside AdminPageHero that surface is black (AdminHeroFrame provides `true`), while a page that
  // places the row on its own light header gets the light palette. The fallback follows the shell.
  const onDarkSurface = useDarkSurface();
  const inPage = placement === "in-page";
  const rowDark = inPage ? onDarkSurface : dark;
  return (
    <NavRowStrip
      activeHref={activeHref}
      ariaLabel="Lower navigation"
      className={cn(
        inPage
          ? cn("phx-navrow--inpage", className ?? "mt-3")
          : cn(
              "phx-navrow--fallback border-b px-3 py-1.5 sm:px-6",
              dark ? "border-[#1a1a1a] bg-[#050505]" : "border-phx-line bg-white/95",
            ),
      )}
      dark={rowDark}
      items={lowerRow}
      keepWhenEmpty={canAdd && hasSavedLayout}
      trailing={
        canAdd ? (
          <NavRowAddButton
            dark={rowDark}
            pinned={lowerRow}
            sections={lowerAddable}
            target="lowerRow"
          />
        ) : null
      }
    />
  );
}
