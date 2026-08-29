"use client";

// ─────────────────────────────────────────────────────────────────────────────
// The "+" at the end of a horizontal nav row.
//
// Owner's ask, 2026-08-28, verbatim: "it have a plus sign at the end. I press at the plus sign. The
// list of modules appear to me. I choose. It is embedded like the organogram."
//
// So this is a second door into the same layout document that /admin/sidebar-layout edits — the
// quick one, opened from the bar itself rather than by leaving the page you are on. "Embedded like
// the organogram" is the important half: the page is pinned in EVERY module, which is what
// `pinHrefToRow` guarantees. That function, not this component, owns the rule — a client component
// with JSX cannot be imported by the test runner's type stripping, so any logic living here would be
// untestable by construction.
//
// 2026-08-29 — three things the first version could not do, each of them a one-way street:
//   · REMOVE. The pages already on the row are listed at the top with a tick; clicking one takes it
//     off. Without this the only way back out was the editor, which is the trip the "+" exists to
//     save.
//   · SEARCH. The admin panel offers 45 pages across a dozen modules. A filter appears once the list
//     is long enough to need one, and matching a MODULE's name keeps that whole module — so typing
//     "sales" is a way to see the module, not only the pages repeating the word.
//   · Serve the LOWER row too, via `target`. Pinning into one row releases the other, so pressing
//     the lower "+" on a page already sitting up top MOVES it down rather than duplicating it.
//
// It offers only pages already present in the viewer's GATED sections, so like everything else in
// this file's neighbourhood it can rearrange navigation but never introduce an href, and never
// grants access to anything. The route handler's assertPermission remains the only boundary.
// ─────────────────────────────────────────────────────────────────────────────

import { Check, Plus, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import type { NavigationSection, NavigationSectionItem } from "@/config/system-navigation";
import {
  pinHrefToRow,
  unpinHrefFromRows,
  type PersonalLayoutRowSet,
  type PersonalNavigationLayout,
} from "@/lib/navigation/personal-layout";
import { cn } from "@/lib/utils";

/** Past this many entries the panel is long enough that scanning it beats reading it. */
const SEARCH_THRESHOLD = 8;

export function NavRowAddButton({
  dark,
  pinned,
  sections,
  target,
}: {
  dark: boolean;
  /** The pages already on THIS row, in row order — what the panel offers to take off. */
  pinned: readonly NavigationSectionItem[];
  /** Gated sections with the pages already on this row removed — what the panel offers to add. */
  sections: readonly NavigationSection[];
  /** Which of the two rows this "+" belongs to. */
  target: keyof PersonalLayoutRowSet;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const commit = useCallback(
    async (href: string, mode: "add" | "remove") => {
      setPending(href);
      setError(null);
      try {
        // Read-modify-write against the stored document rather than the rendered rows: the rows are
        // the RESOLVED view (module override applied, unknown pages appended), so saving them back
        // would flatten an arrangement the viewer never asked to change.
        const read = await fetch("/api/navigation/personal-layout", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!read.ok) throw new Error("read");
        // Nullable on purpose: the GET answers { data: null } for an account that has never saved
        // a layout, and a JSON body of literal `null` parses to null outright.
        const body = (await read.json()) as { data?: PersonalNavigationLayout | null } | null;
        const current = body?.data ?? null;
        const layout =
          mode === "add" ? pinHrefToRow(current, href, target) : unpinHrefFromRows(current, href);
        const write = await fetch("/api/navigation/personal-layout", {
          body: JSON.stringify({ layout }),
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          method: "PUT",
        });
        if (!write.ok) throw new Error("write");
        setOpen(false);
        // The row is server-rendered from the stored layout, so a refresh is what makes the change
        // appear — without it the save is correct and the screen is unchanged, which is exactly the
        // failure this whole feature was born out of.
        router.refresh();
      } catch {
        setError("That did not save. Try again.");
      } finally {
        setPending(null);
      }
    },
    [router, target],
  );

  const total = useMemo(
    () => pinned.length + sections.reduce((count, section) => count + section.items.length, 0),
    [pinned, sections],
  );

  const { visiblePinned, visibleSections } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return { visiblePinned: pinned, visibleSections: sections };
    const hit = (label: string) => label.toLowerCase().includes(needle);
    return {
      visiblePinned: pinned.filter((item) => hit(item.label)),
      // A section whose own name matches keeps ALL of its pages: "sales" should surface the Sales
      // module, not only the pages that happen to repeat the word.
      visibleSections: sections
        .map((section) =>
          hit(section.label)
            ? section
            : { ...section, items: section.items.filter((item) => hit(item.label)) },
        )
        .filter((section) => section.items.length > 0),
    };
  }, [pinned, query, sections]);

  const panelSurface = dark
    ? "border-[#1a1a1a] bg-[#0a0a0a] text-[#D4DDE8]"
    : "border-phx-line bg-white text-phx-ink";
  const mutedText = dark ? "text-[#7C8DA3]" : "text-phx-ink-soft";
  const rowClass = cn(
    "flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-2 py-1.5 text-left text-[13px] font-semibold transition-colors disabled:opacity-50",
    dark ? "hover:bg-[#141414] hover:text-[#F8B56B]" : "hover:bg-phx-paper hover:text-phx-accent",
  );
  const headingClass = cn(
    "px-2 pb-0.5 pt-1.5 text-[10px] font-bold uppercase tracking-[0.08em]",
    dark ? "text-[#5A6B80]" : "text-phx-ink-soft",
  );

  return (
    <div className="relative shrink-0">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Add or remove pages on this row"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-lg p-1.5 transition-colors",
          dark
            ? "text-[#7C8DA3] hover:bg-[#141414] hover:text-[#F8B56B]"
            : "text-phx-ink-soft hover:bg-phx-paper hover:text-phx-accent",
        )}
        onClick={() => {
          setOpen((was) => !was);
          setQuery("");
          setError(null);
        }}
        type="button"
      >
        <Plus aria-hidden="true" className="h-3.5 w-3.5" />
      </button>

      {open ? (
        <>
          {/* Closes on any outside click. A backdrop button rather than a document listener in an
              effect, because setState inside useEffect is a lint error in this repo. */}
          <button
            aria-label="Close the page list"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
            tabIndex={-1}
            type="button"
          />
          <div
            aria-label="Pages on this row"
            className={cn(
              // Scrolls in BOTH directions on purpose: a long page name must neither wrap nor be
              // cut off with an ellipsis (the owner's standing rule), so the panel scrolls sideways
              // rather than truncating the label.
              "absolute left-0 top-full z-50 mt-1 max-h-[70vh] w-72 overflow-auto rounded-xl border p-1.5 shadow-xl",
              panelSurface,
            )}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
            role="dialog"
          >
            {error ? (
              <p className="px-2 py-1.5 text-[12px] font-semibold text-[#E5484D]">{error}</p>
            ) : null}

            {total > SEARCH_THRESHOLD ? (
              <div className="relative mb-1">
                <Search
                  aria-hidden="true"
                  className={cn("pointer-events-none absolute left-2 top-2 h-3.5 w-3.5", mutedText)}
                />
                <input
                  aria-label="Filter pages"
                  autoFocus
                  className={cn(
                    "w-full rounded-lg border bg-transparent py-1.5 pl-7 pr-2 text-[13px] font-semibold outline-none",
                    dark
                      ? "border-[#1a1a1a] placeholder:text-[#5A6B80] focus:border-[#F8B56B]"
                      : "border-phx-line placeholder:text-phx-ink-soft focus:border-phx-accent",
                  )}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search pages"
                  type="search"
                  value={query}
                />
              </div>
            ) : null}

            {visiblePinned.length > 0 ? (
              <div className="mb-1">
                <p className={headingClass}>On this row</p>
                {visiblePinned.map((item) => (
                  <button
                    className={rowClass}
                    disabled={pending !== null}
                    key={item.href}
                    onClick={() => void commit(item.href, "remove")}
                    title="Remove from this row"
                    type="button"
                  >
                    <Check
                      aria-hidden="true"
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        dark ? "text-[#F8B56B]" : "text-phx-accent",
                      )}
                    />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            ) : null}

            {visibleSections.length === 0 && visiblePinned.length === 0 ? (
              <p className={cn("px-2 py-1.5 text-[12px]", mutedText)}>
                {query.trim() === ""
                  ? "There is nothing to add to this row."
                  : "No page matches that."}
              </p>
            ) : (
              visibleSections.map((section) => (
                <div className="mb-1 last:mb-0" key={section.id}>
                  <p className={headingClass}>{section.label}</p>
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        className={rowClass}
                        disabled={pending !== null}
                        key={item.href}
                        onClick={() => void commit(item.href, "add")}
                        type="button"
                      >
                        <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
