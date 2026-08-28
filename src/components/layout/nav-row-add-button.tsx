"use client";

// ─────────────────────────────────────────────────────────────────────────────
// The "+" at the end of the Upper nav row.
//
// Owner's ask, 2026-08-28, verbatim: "it have a plus sign at the end. I press at the plus sign. The
// list of modules appear to me. I choose. It is embedded like the organogram."
//
// So this is a second door into the same layout document that /admin/sidebar-layout edits — the
// quick one, opened from the bar itself rather than by leaving the page you are on. "Embedded like
// the organogram" is the important half: the page is pinned in EVERY module, which is what
// `pinHrefToUpperRow` guarantees. That function, not this component, owns the rule — a client
// component with JSX cannot be imported by the test runner's type stripping, so any logic living
// here would be untestable by construction.
//
// It offers only pages already present in the viewer's GATED sections, so like everything else in
// this file's neighbourhood it can rearrange navigation but never introduce an href, and never
// grants access to anything. The route handler's assertPermission remains the only boundary.
// ─────────────────────────────────────────────────────────────────────────────

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import type { NavigationSection } from "@/config/system-navigation";
import { pinHrefToUpperRow, type PersonalNavigationLayout } from "@/lib/navigation/personal-layout";
import { cn } from "@/lib/utils";

export function NavRowAddButton({
  dark,
  sections,
}: {
  dark: boolean;
  /** Gated sections with the already-pinned pages removed. Empty means there is nothing left to add. */
  sections: readonly NavigationSection[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = useCallback(
    async (href: string) => {
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
        const write = await fetch("/api/navigation/personal-layout", {
          body: JSON.stringify({ layout: pinHrefToUpperRow(body?.data ?? null, href) }),
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          method: "PUT",
        });
        if (!write.ok) throw new Error("write");
        setOpen(false);
        // The row is server-rendered from the stored layout, so a refresh is what makes the new tab
        // appear — without it the save is correct and the screen is unchanged, which is exactly the
        // failure this whole feature was born out of.
        router.refresh();
      } catch {
        setError("That did not save. Try again.");
      } finally {
        setPending(null);
      }
    },
    [router],
  );

  const panelSurface = dark
    ? "border-[#1a1a1a] bg-[#0a0a0a] text-[#D4DDE8]"
    : "border-phx-line bg-white text-phx-ink";

  return (
    <div className="relative shrink-0">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Add a page to this row"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-lg p-1.5 transition-colors",
          dark
            ? "text-[#7C8DA3] hover:bg-[#141414] hover:text-[#F8B56B]"
            : "text-phx-ink-soft hover:bg-phx-paper hover:text-phx-accent",
        )}
        onClick={() => setOpen((was) => !was)}
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
            className={cn(
              "absolute left-0 top-full z-50 mt-1 max-h-[70vh] w-64 overflow-y-auto rounded-xl border p-1.5 shadow-xl",
              panelSurface,
            )}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
            role="menu"
          >
            {error ? (
              <p className="px-2 py-1.5 text-[12px] font-semibold text-[#E5484D]">{error}</p>
            ) : null}

            {sections.length === 0 ? (
              <p
                className={cn(
                  "px-2 py-1.5 text-[12px]",
                  dark ? "text-[#7C8DA3]" : "text-phx-ink-soft",
                )}
              >
                Every page you can reach is already on this row.
              </p>
            ) : (
              sections.map((section) => (
                <div className="mb-1 last:mb-0" key={section.id}>
                  <p
                    className={cn(
                      "px-2 pb-0.5 pt-1.5 text-[10px] font-bold uppercase tracking-[0.08em]",
                      dark ? "text-[#5A6B80]" : "text-phx-ink-soft",
                    )}
                  >
                    {section.label}
                  </p>
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        className={cn(
                          "flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-2 py-1.5 text-left text-[13px] font-semibold transition-colors disabled:opacity-50",
                          dark
                            ? "hover:bg-[#141414] hover:text-[#F8B56B]"
                            : "hover:bg-phx-paper hover:text-phx-accent",
                        )}
                        disabled={pending !== null}
                        key={item.href}
                        onClick={() => void add(item.href)}
                        role="menuitem"
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
