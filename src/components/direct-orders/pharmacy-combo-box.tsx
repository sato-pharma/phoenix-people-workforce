"use client";

import { useEffect, useRef, useState } from "react";

// One hit from /api/direct-orders/pharmacy-search — mirror of the service type.
export type PharmacySearchHit = {
  source: "directory" | "phoenix";
  distributorCode: string | null;
  customerCode: string | null;
  customerName: string | null;
  address: string | null;
  brickId: string | null;
  areaCode: string | null;
  areaName: string;
  regionCode: string | null;
  regionName: string;
  phoenixPharmacyCode: string | null;
  verificationStatus: string | null;
};

type Props = {
  onSelect: (hit: PharmacySearchHit) => void;
  inputClassName: string;
  /** Narrow the search to one distributor's customers (optional). */
  distributorCode?: string | null;
};

/**
 * The pharmacy combo box (spec B1/B2 — docs/specs/direct-orders-v2.md).
 *
 * Type a name (any Arabic spelling) or a customer code off the distributor invoice; pick from
 * the live list. The list is the union of the distributor customer directory and pharmacies
 * Phoenix already holds — searched server-side on every keystroke, so a pharmacy admitted a
 * second ago is already findable and 49k rows never ship to the browser.
 */
export function PharmacyComboBox({ onSelect, inputClassName, distributorCode }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PharmacySearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    // EVERY setState lives inside the scheduled callback, never in the effect body — the repo's
    // react-hooks/set-state-in-effect rule, and the reason the clear path is a 0ms timeout
    // rather than a bare call. `seq` makes stale responses (and stale timeouts) no-ops.
    const q = query.trim();
    const mySeq = ++seq.current;
    const timer = setTimeout(
      async () => {
        if (seq.current !== mySeq) return;
        if (q.length < 2) {
          setHits([]);
          setBusy(false);
          return;
        }
        setBusy(true);
        try {
          const params = new URLSearchParams({ q });
          if (distributorCode) params.set("distributor", distributorCode);
          const res = await fetch(`/api/direct-orders/pharmacy-search?${params.toString()}`);
          const data = (await res.json().catch(() => ({}))) as { hits?: PharmacySearchHit[] };
          // A stale response must never overwrite a newer keystroke's results.
          if (seq.current !== mySeq) return;
          setHits(Array.isArray(data.hits) ? data.hits : []);
          setHighlight(0);
          setOpen(true);
        } catch {
          if (seq.current === mySeq) setHits([]);
        } finally {
          if (seq.current === mySeq) setBusy(false);
        }
      },
      q.length < 2 ? 0 : 250,
    );
    return () => clearTimeout(timer);
  }, [query, distributorCode]);

  // ── Where the list can actually fit ─────────────────────────────────────────
  // It used to open downward at a fixed 320px, always. This input sits low in a long form, so on
  // a phone the list rendered entirely behind the on-screen keyboard: measured on production, with
  // the keyboard up there were ZERO visible pixels of it and no way to scroll to it, because an
  // absolutely-positioned list is not something the page can scroll to reveal when the space
  // simply is not there.
  //
  // `visualViewport` is the load-bearing part. `window.innerHeight` does NOT shrink when a mobile
  // keyboard opens, so measuring against it would compute plenty of room below and place the list
  // straight back under the keyboard — the bug, reproduced by the fix meant to cure it.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ dropUp: boolean; maxHeight: number }>({
    dropUp: false,
    maxHeight: 320,
  });

  useEffect(() => {
    if (!open) return;
    // Same rule as the search effect above: the setState lives in the scheduled callback, never
    // in the effect body.
    const measure = () => {
      const el = wrapRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const below = viewportTop + viewportHeight - box.bottom - 8;
      const above = box.top - viewportTop - 8;
      // Flip up only when it genuinely helps: below is too tight AND above is roomier. A list that
      // flips on every keystroke is worse than one that is merely short.
      const dropUp = below < 176 && above > below;
      const room = dropUp ? above : below;
      setPlacement({ dropUp, maxHeight: Math.max(120, Math.min(320, Math.floor(room))) });
    };
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    // Capture phase: the form may sit inside a scrolling container, whose scroll does not bubble.
    window.addEventListener("scroll", measure, true);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, [open, hits.length]);

  function pick(hit: PharmacySearchHit) {
    setOpen(false);
    setQuery("");
    setHits([]);
    onSelect(hit);
  }

  const nameOf = (hit: PharmacySearchHit) => hit.customerName ?? `${hit.customerCode ?? "?"} — (no name on file)`;

  return (
    <div className="relative" ref={wrapRef}>
      <input
        className={inputClassName}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || hits.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, hits.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const hit = hits[highlight];
            if (hit) pick(hit);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder="Type the venue name or its customer code…"
        dir="auto"
        autoComplete="off"
      />
      {busy ? (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-phx-xs font-semibold text-slate-400">
          searching…
        </span>
      ) : null}

      {open && query.trim().length >= 2 ? (
        <div
          // Height comes from the measurement, never from a fixed max-h class — the whole point is
          // that it fits the room that actually exists. `bottom-full` flips it above the input.
          style={{ maxHeight: `${placement.maxHeight}px` }}
          className={`absolute z-30 w-full overflow-y-auto overscroll-contain border border-slate-300 bg-white shadow-lg ${
            placement.dropUp ? "bottom-full mb-1" : "mt-1"
          }`}
        >
          {hits.length === 0 && !busy ? (
            <p className="px-3 py-3 text-phx-sm font-semibold text-slate-500">
              No match in the master database. Check the customer code on the distributor invoice —
              or submit anyway and the request will wait for pharmacy validation.
            </p>
          ) : (
            hits.map((hit, index) => (
              <button
                key={`${hit.source}:${hit.phoenixPharmacyCode ?? ""}:${hit.distributorCode ?? ""}:${hit.customerCode ?? ""}:${index}`}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(hit)}
                className={`block w-full border-b border-slate-100 px-3 py-2 text-left ${index === highlight ? "bg-orange-50" : "bg-white"} hover:bg-orange-50`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-phx-md font-bold text-slate-900" dir="auto">
                    {nameOf(hit)}
                  </span>
                  {hit.source === "phoenix" ? (
                    <span className="shrink-0 bg-slate-900 px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-wider text-white">
                      {hit.phoenixPharmacyCode}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-phx-xs text-slate-500">
                  {hit.distributorCode ? (
                    <span className="font-semibold text-slate-600">
                      {hit.distributorCode} · {hit.customerCode}
                    </span>
                  ) : null}
                  {hit.areaCode ? <span>{hit.areaName || hit.areaCode}</span> : null}
                  {hit.verificationStatus === "pending_review" ? (
                    <span className="bg-amber-100 px-1 py-0.5 font-bold text-amber-800">awaiting validation</span>
                  ) : null}
                  {/* A rejected pharmacy is deactivated, so it should never reach this list at all —
                      every search path filters on `active`. Labelled anyway: if one ever does
                      appear, the submitter must see WHY rather than a row that looks ordinary. */}
                  {hit.verificationStatus === "rejected" ? (
                    <span className="bg-rose-100 px-1 py-0.5 font-bold text-rose-800">rejected — do not use</span>
                  ) : null}
                </span>
                {hit.address ? (
                  <span className="mt-0.5 block text-phx-xs text-slate-400" dir="auto">
                    {hit.address}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
