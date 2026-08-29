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
// Like the sidebar, this is UX and never the security boundary: the items come
// from `getSections` (already permission- and role-filtered) and are only
// REARRANGED by `applyPersonalLayout`, which cannot introduce an href.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { ApprovalNavBadge } from "@/components/layout/nav-badge";
import { NavRowAddButton } from "@/components/layout/nav-row-add-button";
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
  /** Whether to render a "+" at all — every surface that carries rows, which is wider than the chrome. */
  canAdd: boolean;
  /** Has this viewer ever saved a layout? One of the two cases where an EMPTY row still shows its "+". */
  hasSavedLayout: boolean;
  /** The other: a surface with no layout editor, where the "+" is the only way in. */
  alwaysOfferAdd: boolean;
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
  alwaysOfferAdd: false,
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
  sections,
}: {
  children: ReactNode;
  currentRole?: PhoenixRole;
  isSystemAdministratorWorkspace?: boolean;
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
    // WIDENED AGAIN on 2026-08-29, to the employee portal — 116 accounts, 72% of everyone with a
    // login, and until now the only workspace with no arrangeable row at all. `carriesNavRows` is
    // separate from `usesAdminChrome` on purpose: the first asks whether this surface has rows, the
    // second is a PALETTE question, and the portal answers yes to one and no to the other.
    const layout = carriesNavRows(navigationMode) ? personalLayout : null;
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
      canAdd: carriesNavRows(navigationMode),
      hasSavedLayout: layout !== null,
      // THE PORTAL HAS NO LAYOUT EDITOR. /admin/sidebar-layout is admin-only, and a null layout
      // resolves to empty rows — so without this the portal's "+" would appear only for someone who
      // already had a layout, which in the portal is nobody, ever. The row would be permanently
      // invisible and the feature dead on arrival, with zero usage looking exactly like zero
      // adoption. Admin and HR keep the shipped rule, where the editor page IS the entry point.
      alwaysOfferAdd: navigationMode === "employee-portal",
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
    sections,
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
  const { upperRow, activeHref, upperAddable, alwaysOfferAdd, canAdd, dark, hasSavedLayout } =
    useContext(HorizontalNavContext);
  return (
    <NavRowStrip
      activeHref={activeHref}
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
            dark ? "border-[#1a1a1a] bg-[#000000]" : "border-phx-line bg-white",
          ),
      )}
      dark={dark}
      items={upperRow}
      keepWhenEmpty={canAdd && (hasSavedLayout || alwaysOfferAdd)}
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
  const { lowerRow, activeHref, alwaysOfferAdd, canAdd, dark, hasSavedLayout, lowerAddable } =
    useContext(HorizontalNavContext);
  return (
    <NavRowStrip
      activeHref={activeHref}
      ariaLabel="Lower navigation"
      className={cn(
        className ??
          cn(
            "border-b px-3 py-1.5 sm:px-6",
            dark ? "border-[#1a1a1a] bg-[#050505]" : "border-phx-line bg-white/95",
          ),
      )}
      dark={dark}
      items={lowerRow}
      keepWhenEmpty={canAdd && (hasSavedLayout || alwaysOfferAdd)}
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
