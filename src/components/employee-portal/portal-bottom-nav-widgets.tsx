"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarDays,
  CalendarRange,
  Headphones,
  Plus,
  ReceiptText,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Stethoscope,
  X,
  type LucideIcon,
} from "lucide-react";

import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { tapHaptic } from "@/lib/employee-portal/haptics";
import { replaceBottomNavHref } from "@/lib/employee-portal/portal-chrome";
import { portalQuickActions, type PortalQuickActionKey } from "@/lib/employee-portal/portal-quick-actions";
import { MAX_BOTTOM_NAV_CUSTOM, defaultBottomNavHrefs, visiblePortalNavEntries } from "./employee-portal-nav-registry";
import { usePrefersReducedMotion } from "./portal-chrome-hooks";
import { useBottomNavPreference } from "./use-bottom-nav-preference";

/**
 * The glyph for each quick action.
 *
 * The action list itself is React-free (src/lib/employee-portal/portal-quick-actions.ts) so the Node
 * test harness can call it; a lucide import there would break every test that loads it. This map is
 * the React half — one place, so the top bar's "+ New" menu, the command bar and the phone bar's own
 * action button cannot end up showing three different icons for the same action.
 */
export const PORTAL_QUICK_ACTION_ICONS: Record<PortalQuickActionKey, LucideIcon> = {
  "crm-plan": CalendarRange,
  "crm-visit": Stethoscope,
  "direct-order": ReceiptText,
  expense: Send,
  "report-it": ShieldCheck,
  support: Headphones,
  vacation: CalendarDays,
};

/**
 * A sheet that rises from the bottom of a phone screen.
 *
 * Bottom, not centre: the whole point of the thumb zone is that the hand already there can reach
 * what opens, and a centred dialog on a 812px phone puts its rows back at the top of the screen.
 *
 * It brings its own full-screen backdrop, so it does not use `useDismissOnOutsideInteraction` the
 * way the header's little dropdowns do — a press anywhere outside lands ON the backdrop, which is a
 * real button and therefore reachable by a keyboard and readable by a screen reader, where an
 * invisible document-level listener is neither.
 *
 * z-[60]/[61]: above the z-40 bar it opens from, below the z-[90] command bar, which is the one
 * surface allowed to cover everything.
 */
export function PortalBottomSheet({
  children,
  onClose,
  title,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
}) {
  // Escape closes it, and the page behind it does not scroll while it is open — on a phone a sheet
  // over a scrolling page means the finger moves the wrong layer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <>
      <button
        aria-label="Close"
        className="fixed inset-0 z-[60] bg-slate-900/45 backdrop-blur-[2px] lg:hidden"
        onClick={onClose}
        type="button"
      />
      <div
        aria-label={title}
        aria-modal="true"
        className="fixed inset-x-0 bottom-0 z-[61] max-h-[70dvh] overflow-y-auto border-t-2 border-orange-500 bg-white shadow-[0_-18px_44px_rgba(15,23,42,0.28)] lg:hidden"
        role="dialog"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">{title}</p>
          <button
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center text-slate-500 active:text-slate-800"
            onClick={onClose}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

/**
 * The floating action button above the phone bar, and the sheet it opens.
 *
 * WHY IT FLOATS rather than taking a seventh seat on the bar: it cannot have one. Six tabs is the
 * arithmetic maximum — the pinned word budget for a 360px Android phone is 304px against a 267px
 * worst case, and a seventh element drops the budget below what the six already need. Anything new
 * on this bar has to be out of flow, so this is `fixed` and costs the tabs nothing.
 *
 * It rides the bar's own height variable rather than a second magic number: below `lg`
 * `--phx-portal-bottom-nav-reserve` is already `61px + env(safe-area-inset-bottom)` and from `lg` it
 * is `0px` (app/globals.css), so the button tracks the bar for free and the `lg:hidden` beside it is
 * belt and braces.
 *
 * It only ever NAVIGATES. No action is performed from here — every row is a link to the page that
 * owns that action, which is the same rule the top bar's "+ New" menu obeys.
 */
/**
 * Swapping a tab from the bar itself (owner, 2026-09-29 — he chose this tap route over a long
 * press, which fights scrolling on a real phone).
 *
 * Two steps, not one: pick the SEAT you want to change, then the page that goes in it. A single
 * long list of every page would have to guess which of the four to displace, and guessing wrong on
 * a phone costs a second trip. Home and Profile are not offered — they are the two tabs that never
 * move, and the sheet says so rather than leaving a person hunting for them.
 *
 * It writes through useBottomNavPreference, whose custom event already keeps the bar and the
 * Profile page's own customizer in step within the tab.
 */
function PortalBottomNavTabEditor({
  onDone,
  visibility,
}: {
  onDone: () => void;
  visibility: EmployeePortalNavVisibility;
}) {
  const [selected, setSelected] = useBottomNavPreference();
  const [seat, setSeat] = useState<string | null>(null);

  const entries = visiblePortalNavEntries(visibility);
  const visibleHrefs = new Set(entries.map((entry) => entry.href));
  const pinned = selected.filter((href) => visibleHrefs.has(href));
  const shown = (pinned.length > 0
    ? pinned
    : defaultBottomNavHrefs(visibility).filter((href) => visibleHrefs.has(href))
  ).slice(0, MAX_BOTTOM_NAV_CUSTOM);
  const labelFor = (href: string) => entries.find((entry) => entry.href === href)?.fullLabel ?? href;

  if (seat) {
    return (
      <ul className="divide-y divide-slate-100">
        {entries.map((entry) => {
          const onBar = shown.includes(entry.href);
          return (
            <li key={entry.href}>
              <button
                className="flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-3 text-left active:bg-orange-50"
                onClick={() => {
                  setSelected(replaceBottomNavHref(selected, shown, seat, entry.href));
                  onDone();
                }}
                type="button"
              >
                <span className="min-w-0 text-sm font-bold text-slate-800">{entry.fullLabel}</span>
                {onBar ? (
                  <span className="shrink-0 text-phx-2xs font-black uppercase tracking-[0.1em] text-orange-600">
                    On the bar
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <>
      <p className="px-4 pt-3 text-phx-2xs font-bold uppercase tracking-[0.1em] text-slate-400">
        Choose the tab to change
      </p>
      <ul className="divide-y divide-slate-100">
        {shown.map((href) => (
          <li key={href}>
            <button
              className="flex min-h-[52px] w-full items-center gap-3 px-4 py-3 text-left text-sm font-bold text-slate-800 active:bg-orange-50"
              onClick={() => setSeat(href)}
              type="button"
            >
              {labelFor(href)}
            </button>
          </li>
        ))}
      </ul>
      <p className="border-t border-slate-100 px-4 py-3 text-phx-2xs font-bold text-slate-400">
        Home and Profile always stay.
      </p>
    </>
  );
}

export function PortalBottomNavQuickActions({
  chromeHidden,
  visibility,
}: {
  /** True while the bar has slid away under a downward scroll — the button goes with it. */
  chromeHidden: boolean;
  visibility: EmployeePortalNavVisibility;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const pathname = usePathname();
  const reducedMotion = usePrefersReducedMotion();
  const actions = portalQuickActions(visibility);
  const close = useCallback(() => {
    setOpen(false);
    setEditing(false);
  }, []);

  // Changing page closes it. Without this, a tap that navigates leaves the sheet sitting over the
  // page it just opened.
  //
  // Adjusted DURING RENDER, not in an effect: React's own guidance for resetting state when a prop
  // changes, and the only form the react-hooks/set-state-in-effect rule allows. An effect would
  // paint the stale sheet for one frame over the new page first.
  const [openedOn, setOpenedOn] = useState(pathname);
  if (openedOn !== pathname) {
    setOpenedOn(pathname);
    setOpen(false);
    setEditing(false);
  }

  if (actions.length === 0) return null;

  return (
    <>
      {/* A page with its own sticky Back / Next / Submit bar marks it data-portal-action-bar, and the
          button steps aside — it sat on top of Next on the Submit expense form (2026-10-27). */}
      <button
        aria-expanded={open}
        aria-label="Start something"
        className={`fixed right-3 z-[45] flex h-12 w-12 items-center justify-center bg-[#F05A1A] text-white shadow-[0_10px_26px_rgba(240,90,26,0.45)] transition-[scale,rotate,opacity] duration-200 ease-out active:scale-95 motion-reduce:transition-none lg:hidden [body:has([data-portal-action-bar])_&]:hidden ${
          open ? "rotate-45" : ""
        } ${
          // It goes away with the bar it sits above — but never while its own sheet is open, which
          // cannot happen anyway (the sheet locks the page's scroll) and would look like the sheet
          // had lost its anchor if it did.
          chromeHidden && !open ? "pointer-events-none scale-90 opacity-0" : ""
        }`}
        onClick={() => setOpen((current) => !current)}
        onPointerDown={(event) => {
          if (event.pointerType === "touch") tapHaptic(reducedMotion);
        }}
        style={{ bottom: "calc(var(--phx-portal-bottom-nav-reserve, 0px) + 12px)" }}
        type="button"
      >
        <Plus className="h-6 w-6" />
      </button>
      {open ? (
        <PortalBottomSheet onClose={close} title={editing ? "Edit tabs" : "Start something"}>
          {editing ? (
            <PortalBottomNavTabEditor onDone={close} visibility={visibility} />
          ) : (
            <>
              <ul className="divide-y divide-slate-100">
                {actions.map((action) => {
                  const Icon = PORTAL_QUICK_ACTION_ICONS[action.id];
                  return (
                    <li key={action.id}>
                      <Link
                        className="flex min-h-[52px] items-center gap-3 px-4 py-3 text-slate-800 active:bg-orange-50"
                        href={action.href}
                        onClick={close}
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-orange-50 text-orange-700">
                          <Icon className="h-[18px] w-[18px]" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-black text-slate-900">{action.label}</span>
                          <span className="block text-phx-2xs font-bold uppercase tracking-[0.1em] text-slate-400">
                            {action.hint}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {/* Changing the bar belongs ON the bar. Before this it lived only on the Profile page,
                  which is exactly where a person is NOT when they notice a tab is wrong. */}
              <button
                className="flex min-h-[52px] w-full items-center gap-3 border-t border-slate-200 px-4 py-3 text-left text-sm font-black text-slate-600 active:bg-slate-50"
                onClick={() => setEditing(true)}
                type="button"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-slate-100 text-slate-600">
                  <SlidersHorizontal className="h-[18px] w-[18px]" />
                </span>
                Edit tabs
              </button>
            </>
          )}
        </PortalBottomSheet>
      ) : null}
    </>
  );
}
