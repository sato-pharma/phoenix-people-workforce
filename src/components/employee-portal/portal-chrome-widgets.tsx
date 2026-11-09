"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import { CheckCheck, CornerDownLeft, Fingerprint, Inbox, Keyboard, Lock, Search, UserCog, X, type LucideIcon } from "lucide-react";

import { alarmGlowRef } from "@/components/layout/alarm-glow";
import { isNavItemLockedFor } from "@/components/layout/module-lock-context";
import { useDismissOnOutsideInteraction } from "@/hooks/use-dismiss-on-outside-interaction";
import {
  PORTAL_PAGES_WITHOUT_A_ROW,
  availableGoShortcuts,
  initialsFor,
  rowMatchesQuery,
  waitingOnYouTotal,
  waitingQueues,
  type PortalNavBadge,
} from "@/lib/employee-portal/portal-chrome";
import { useQueueReadings } from "./portal-chrome-hooks";

/** The sidebar's own section shape, as the widgets read it. */
export type ChromeSection = {
  items: ReadonlyArray<{ href: string; icon: LucideIcon; label: string; navBadge?: PortalNavBadge }>;
  title: string;
};

/** An action the command bar can run — not a page, a thing to do. */
export type ChromeAction = {
  hint: string;
  icon: LucideIcon;
  id: string;
  keywords?: string;
  label: string;
  run: () => void;
};

const EXTRA_PAGE_ICONS: Record<string, LucideIcon> = {
  "/employee-portals/attendance": Fingerprint,
  "/employee-portals/profile": UserCog,
};

// ── The person ───────────────────────────────────────────────────────────────

/**
 * The person's own photo — the uploaded one, else the bundled one — and their initials in an orange
 * square when there is neither or it fails to load. Never the Phoenix logo standing in for a person.
 */
export function PortalAvatar({
  className,
  fullName,
  photoSrc,
  size,
}: {
  className?: string;
  fullName: string;
  photoSrc: string | null;
  /** The square's size classes, e.g. "h-7 w-7". */
  size: string;
}) {
  const [failed, setFailed] = useState(false);
  if (photoSrc && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        alt=""
        className={`${size} shrink-0 object-cover ${className ?? ""}`}
        onError={() => setFailed(true)}
        src={photoSrc}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex ${size} shrink-0 items-center justify-center bg-gradient-to-br from-[#F05A1A] to-[#F59E0B] text-phx-sm font-black tracking-[0.04em] text-white ${className ?? ""}`}
    >
      {initialsFor(fullName)}
    </span>
  );
}

// ── Live counts ──────────────────────────────────────────────────────────────

/**
 * The pending number for a group of queues — a rail icon's section, a folded section's header.
 * Hub-aware through waitingOnYouTotal, so a section holding "Other Approvals" and the leave queue it
 * already contains never counts the same request twice. Renders nothing at zero.
 */
export function PortalPendingCount({
  navBadges,
  tone,
}: {
  navBadges: readonly PortalNavBadge[];
  /** "rail": on a navy sidebar icon. "menu": on the phone's white Menu button. "inline": in a row. */
  tone: "rail" | "menu" | "inline";
}) {
  const readings = useQueueReadings(navBadges);
  const { overdue, total } = waitingOnYouTotal(readings);
  if (total <= 0) return null;
  const text = total > 99 ? "99+" : String(total);
  const label = `${total} waiting${overdue ? ", overdue" : ""}`;
  if (tone === "rail" || tone === "menu") {
    return (
      <span
        aria-label={label}
        className={`absolute flex h-4 min-w-4 items-center justify-center px-1 text-phx-xs font-black leading-none tabular-nums text-white ring-2 ${
          tone === "rail" ? "-right-2.5 -top-2 ring-[#101a31]" : "-right-1.5 -top-1.5 ring-white"
        } ${
          overdue ? "bg-red-600 nav-badge-alarm-overdue" : "bg-[#F05A1A] nav-badge-alarm"
        }`}
        ref={alarmGlowRef}
        role="status"
      >
        {text}
      </span>
    );
  }
  return (
    <span
      aria-label={label}
      className={`inline-flex h-4 min-w-4 items-center justify-center px-1 text-phx-xs font-black leading-none tabular-nums text-white ${
        overdue ? "bg-red-600" : "bg-[#F05A1A]"
      }`}
      role="status"
    >
      {text}
    </span>
  );
}

// ── Waiting on you ───────────────────────────────────────────────────────────

/** The queues "Other Approvals" already holds — shown beside it, but never counted twice. */
const COVERED_BY_HUB = new Set<string>(["vacation-approvals-pending", "excuse-approvals-pending", "plan-approvals-pending"]);

/** One queue's count pill in the dropdown. */
function queuePillClass(count: number, overdue: boolean, coveredByShownHub: boolean) {
  if (count === 0) return "bg-slate-100 text-slate-400";
  if (overdue) return "bg-red-600 text-white";
  return coveredByShownHub ? "bg-orange-100 text-orange-700" : "bg-[#F05A1A] text-white";
}

/**
 * ONE live number in the top bar for every queue this person owns, red when any of it is overdue,
 * and a dropdown that opens each queue. It OPENS the screen — it never approves, rejects or holds
 * anything itself; every decision stays the click on that screen.
 *
 * Replaces the "Live Performance" chip, which was a pulsing label with no link and no data behind it.
 * Renders nothing for someone who owns no queue (a Medical Rep), rather than a permanent "0".
 */
export function WaitingOnYouChip({
  onNavigate,
  sections,
}: {
  onNavigate: (href: string) => void;
  sections: readonly ChromeSection[];
}) {
  const queues = useMemo(() => waitingQueues(sections), [sections]);
  const readings = useQueueReadings(queues.map((queue) => queue.navBadge as PortalNavBadge));
  const { overdue, total } = waitingOnYouTotal(readings);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideInteraction(containerRef, open, setOpen);

  if (queues.length === 0) return null;
  const hubShown = queues.some((queue) => queue.navBadge === "approvals-hub-pending");

  return (
    <div className="relative hidden shrink-0 lg:flex" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={total > 0 ? `${total} waiting on you${overdue ? ", some overdue" : ""}` : "Nothing waiting on you"}
        className={`flex items-center gap-1.5 border px-2.5 py-1.5 text-phx-xs font-bold transition ${
          total === 0
            ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
            : overdue
              ? "border-red-300 bg-red-50 text-red-700 hover:bg-red-100"
              : "border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100"
        }`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {total === 0 ? <CheckCheck className="h-3.5 w-3.5" /> : <Inbox className="h-3.5 w-3.5" />}
        <span className="whitespace-nowrap tabular-nums">{total === 0 ? "All clear" : `${total > 99 ? "99+" : total} waiting`}</span>
      </button>
      {open ? (
        <div
          className="absolute right-0 top-full z-50 mt-1.5 w-72 border border-slate-200 bg-white shadow-[0_18px_46px_rgba(15,23,42,0.16)]"
          role="menu"
        >
          <div className="border-b border-slate-100 px-3.5 py-2.5">
            <p className="text-sm font-black text-slate-900">Waiting on you</p>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">Opens the queue. Every decision is made there.</p>
          </div>
          {queues.map((queue, index) => {
            const reading = readings[index];
            const count = reading?.count ?? 0;
            return (
              <Link
                className="flex items-start justify-between gap-3 border-b border-slate-100 px-3.5 py-2.5 text-sm font-semibold text-slate-700 transition last:border-b-0 hover:bg-orange-50 hover:text-orange-700"
                href={queue.href}
                key={queue.href}
                onClick={(event) => {
                  event.preventDefault();
                  setOpen(false);
                  onNavigate(queue.href);
                }}
                role="menuitem"
              >
                <span className="min-w-0">
                  <span className="block">{queue.label}</span>
                  {queue.navBadge === "approvals-hub-pending" && queues.some((other) => COVERED_BY_HUB.has(other.navBadge ?? "")) ? (
                    <span className="mt-0.5 block text-phx-sm font-semibold text-slate-400">
                      Includes the leave, excuse and plan requests listed here
                    </span>
                  ) : null}
                </span>
                <span
                  className={`shrink-0 px-1.5 py-0.5 text-phx-sm font-black tabular-nums ${queuePillClass(
                    count,
                    Boolean(reading?.overdue),
                    hubShown && COVERED_BY_HUB.has(queue.navBadge ?? ""),
                  )}`}
                >
                  {count}
                </span>
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ── The command bar ──────────────────────────────────────────────────────────

type CommandEntry = {
  group: string;
  hint: string;
  icon: LucideIcon;
  id: string;
  label: string;
  locked: boolean;
  run: () => void;
};

/**
 * Ctrl+K (or "/") — go anywhere, do anything, without touching the mouse. Every page on the viewer's
 * own sidebar plus the two every role opens (My Profile, My Attendance), the actions this person can
 * take, their recent pages first and their pins. Nothing here is offered that the sidebar would not
 * offer the same person: it is built from the same sections.
 *
 * Mounted only while open, so every opening starts clean with no effect resetting state.
 */
export function PortalCommandBar({
  actions,
  lockedModuleKeys,
  onClose,
  onNavigate,
  pinnedHrefs,
  recentHrefs,
  sections,
}: {
  actions: readonly ChromeAction[];
  lockedModuleKeys: readonly string[];
  onClose: () => void;
  onNavigate: (href: string) => void;
  pinnedHrefs: readonly string[];
  recentHrefs: readonly string[];
  sections: readonly ChromeSection[];
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // Captured during the first render — before autoFocus moves focus into the bar — so closing the
  // bar hands focus back to wherever it was.
  const [returnFocusTo] = useState<Element | null>(() => (typeof document === "undefined" ? null : document.activeElement));

  useEffect(() => {
    return () => {
      if (returnFocusTo instanceof HTMLElement) returnFocusTo.focus();
    };
  }, [returnFocusTo]);

  const pages = useMemo(() => {
    const byHref = new Map<string, { href: string; icon: LucideIcon; label: string; section: string }>();
    for (const section of sections) {
      for (const item of section.items) {
        if (!byHref.has(item.href)) byHref.set(item.href, { href: item.href, icon: item.icon, label: item.label, section: section.title });
      }
    }
    for (const page of PORTAL_PAGES_WITHOUT_A_ROW) {
      if (!byHref.has(page.href)) {
        byHref.set(page.href, { href: page.href, icon: EXTRA_PAGE_ICONS[page.href] ?? UserCog, label: page.label, section: page.section });
      }
    }
    return byHref;
  }, [sections]);

  const entries = useMemo<CommandEntry[]>(() => {
    const pageEntry = (group: string, href: string): CommandEntry | null => {
      const page = pages.get(href);
      if (!page) return null;
      return {
        group,
        hint: page.section,
        icon: page.icon,
        id: `${group}:${href}`,
        label: page.label,
        locked: isNavItemLockedFor({ href }, lockedModuleKeys),
        run: () => onNavigate(href),
      };
    };
    const actionEntry = (action: ChromeAction): CommandEntry => ({
      group: "Actions",
      hint: action.hint,
      icon: action.icon,
      id: `action:${action.id}`,
      label: action.label,
      locked: false,
      run: action.run,
    });

    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return [
        ...recentHrefs.map((href) => pageEntry("Recent", href)),
        ...pinnedHrefs.map((href) => pageEntry("Pinned", href)),
        ...actions.map(actionEntry),
        ...[...pages.keys()].map((href) => pageEntry(pages.get(href)?.section ?? "Pages", href)),
      ].filter((entry): entry is CommandEntry => entry !== null);
    }

    const matchingPages = [...pages.values()]
      .filter((page) => rowMatchesQuery(page, trimmed))
      .map((page) => pageEntry("Pages", page.href))
      .filter((entry): entry is CommandEntry => entry !== null);
    const matchingActions = actions
      .filter((action) => rowMatchesQuery({ label: `${action.label} ${action.keywords ?? ""}`, section: action.hint }, trimmed))
      .map(actionEntry);
    // A label that STARTS with what was typed ranks first — "leave" puts Leave Approvals above
    // "Vacation Request (leave)".
    const rank = (entry: CommandEntry) => (entry.label.toLowerCase().startsWith(trimmed) ? 0 : 1);
    return [...matchingActions, ...matchingPages].sort((a, b) => rank(a) - rank(b));
  }, [actions, lockedModuleKeys, onNavigate, pages, pinnedHrefs, query, recentHrefs]);

  const safeIndex = entries.length === 0 ? 0 : Math.min(activeIndex, entries.length - 1);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${safeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [safeIndex]);

  const choose = (entry: CommandEntry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (entries.length === 0) return;
      setActiveIndex(
        event.key === "ArrowDown" ? (safeIndex + 1) % entries.length : (safeIndex - 1 + entries.length) % entries.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(entries[safeIndex]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    // Focus stays in the bar: the results are chosen with the arrows, never tabbed to.
    if (event.key === "Tab") event.preventDefault();
  };

  let previousGroup = "";

  return (
    <div
      className="fixed inset-0 z-[90] flex justify-center bg-slate-950/55 px-3 pt-[9vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-label="Command bar"
        aria-modal="true"
        className="flex h-fit max-h-[78vh] w-full max-w-[640px] flex-col border border-white/10 bg-[#0F1930] text-white shadow-[0_40px_120px_rgba(2,6,23,0.65)]"
        role="dialog"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4">
          <Search className="h-5 w-5 shrink-0 text-[#FF8A4C]" />
          <input
            aria-activedescendant={entries.length > 0 ? `portal-command-option-${safeIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls="portal-command-results"
            aria-expanded="true"
            aria-label="Search pages and actions"
            autoFocus
            className="h-14 min-w-0 flex-1 bg-transparent text-base font-semibold text-white outline-none placeholder:text-white/40"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            // Short enough to show whole in a 320px phone's bar — an input cannot wrap its placeholder.
            placeholder="Find a page or action"
            role="combobox"
            type="text"
            value={query}
          />
          <button
            aria-label="Close command bar"
            className="flex h-8 w-8 shrink-0 items-center justify-center text-white/50 transition hover:bg-white/10 hover:text-white"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-2" id="portal-command-results" ref={listRef} role="listbox">
          {entries.length === 0 ? (
            <p className="px-4 py-6 text-sm font-semibold text-white/55">Nothing matches that. Try a page name or a section.</p>
          ) : (
            entries.map((entry, index) => {
              const header = entry.group !== previousGroup ? entry.group : null;
              previousGroup = entry.group;
              const Icon = entry.locked ? Lock : entry.icon;
              const active = index === safeIndex;
              return (
                <div key={entry.id}>
                  {header ? (
                    <p className="px-4 pb-1 pt-3 text-phx-xs font-black uppercase tracking-[0.18em] text-white/40">{header}</p>
                  ) : null}
                  <button
                    aria-label={entry.locked ? `${entry.label} — locked` : undefined}
                    aria-selected={active}
                    className={`flex w-full items-start gap-3 px-4 py-2.5 text-left transition ${
                      active ? "bg-[#F05A1A]/20 shadow-[inset_3px_0_0_#F05A1A]" : "hover:bg-white/[0.06]"
                    }`}
                    data-index={index}
                    id={`portal-command-option-${index}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(entry);
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                    role="option"
                    tabIndex={-1}
                    type="button"
                  >
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${entry.locked ? "text-amber-400" : active ? "text-[#FF8A4C]" : "text-white/55"}`} />
                    <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <span className={`text-sm font-bold ${entry.locked ? "text-white/60" : "text-white"}`}>{entry.label}</span>
                      <span className="text-phx-sm font-semibold uppercase tracking-[0.12em] text-white/40">{entry.hint}</span>
                    </span>
                    {active ? <CornerDownLeft className="mt-0.5 hidden h-4 w-4 shrink-0 text-[#FF8A4C] sm:block" /> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Keyboard help only where there is a keyboard — on a phone these keys do not exist. */}
        <div className="hidden shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/10 px-4 py-2.5 text-phx-sm font-semibold text-white/45 md:flex">
          <span>
            <kbd className="border border-white/15 px-1 font-black text-white/70">↑</kbd>{" "}
            <kbd className="border border-white/15 px-1 font-black text-white/70">↓</kbd> move
          </span>
          <span>
            <kbd className="border border-white/15 px-1 font-black text-white/70">Enter</kbd> open
          </span>
          <span>
            <kbd className="border border-white/15 px-1 font-black text-white/70">Esc</kbd> close
          </span>
          <span>
            <kbd className="border border-white/15 px-1 font-black text-white/70">?</kbd> every shortcut
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Keyboard shortcuts card ──────────────────────────────────────────────────

export function PortalShortcutsCard({ onClose, sections }: { onClose: () => void; sections: readonly ChromeSection[] }) {
  const goShortcuts = availableGoShortcuts(sections);
  const rows: Array<[string, string]> = [
    ["/  or  Ctrl K", "Open the command bar"],
    ["[", "Fold or unfold the sidebar"],
    ["F", "Focus mode: hide the sidebar and top bar"],
    ["Esc", "Leave focus mode, or close what is open"],
    ["?", "This card"],
  ];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-slate-950/55 px-3 py-[8vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div aria-label="Keyboard shortcuts" aria-modal="true" className="w-full max-w-[560px] border border-white/10 bg-[#0F1930] text-white shadow-[0_40px_120px_rgba(2,6,23,0.65)]" role="dialog">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.16em]">
            <Keyboard className="h-4 w-4 text-[#FF8A4C]" />
            Keyboard shortcuts
          </p>
          <button
            aria-label="Close keyboard shortcuts"
            autoFocus
            className="flex h-8 w-8 items-center justify-center text-white/50 transition hover:bg-white/10 hover:text-white"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid gap-x-6 gap-y-2.5 px-5 py-4 sm:grid-cols-2">
          {rows.map(([keys, what]) => (
            <div className="flex items-start gap-3" key={keys}>
              <kbd className="shrink-0 border border-white/20 bg-white/[0.06] px-1.5 py-0.5 text-phx-sm font-black text-[#FFB27F]">{keys}</kbd>
              <span className="text-sm font-semibold text-white/80">{what}</span>
            </div>
          ))}
        </div>
        {goShortcuts.length > 0 ? (
          <div className="border-t border-white/10 px-5 py-4">
            <p className="mb-2.5 text-phx-xs font-black uppercase tracking-[0.18em] text-white/45">Press G, then</p>
            <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {goShortcuts.map((shortcut) => (
                <div className="flex items-start gap-3" key={shortcut.key}>
                  <kbd className="shrink-0 border border-white/20 bg-white/[0.06] px-1.5 py-0.5 text-phx-sm font-black uppercase text-[#FFB27F]">
                    {shortcut.key}
                  </kbd>
                  <span className="text-sm font-semibold text-white/80">{shortcut.label}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
