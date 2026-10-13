"use client";

import { useEffect, useState } from "react";

import type { DirectOrderShareLink } from "@/lib/direct-orders/report-share-links";
import { assessLiveFeedAmbiguity } from "@/lib/share-links/live-feed-ambiguity";
import { LiveFeedAmbiguityBanner } from "@/components/share-links/live-feed-ambiguity-banner";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import {
  phxFieldClassName,
  phxLabelClassName,
} from "@/components/ui/form-tokens";
import { adminPanelClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";

type Props = {
  /** The reader's current filter slice, captured into the link so it matches their screen. */
  filters?: Record<string, unknown> | null;
  productionUrl: string;
};

const cairo = (iso: string | null) =>
  iso
    ? stableEnGbFormatter({ timeZone: "Africa/Cairo", day: "2-digit", month: "short", year: "numeric" }).format(
        new Date(iso),
      )
    : "—";

/**
 * Create and manage live report links (owner request, 2026-08-05).
 *
 * Two surfaces with genuinely different handling, and the copy says so rather than leaving the
 * reader to guess: the LIVE link is for a person and carries a passcode; the FEED url is for a
 * Google Sheet formula and cannot, so it must never be handed to a human — the sheet's own Google
 * sharing becomes the access control.
 *
 * LAYOUT: the owner's fits-the-screen golden rule (AGENTS.md §4). No horizontal scroll at any
 * width. This panel broke it in three places until 2026-10-13, and the sibling CV-lifecycle screen
 * (`recruitment/cv-lifecycle-share-links-view.tsx`) is the worked example each fix follows:
 *
 *   1. THE LIST WAS A SCROLL CONTAINER over a content-sized six-column table. The rule names that
 *      shape as the bug itself, so the desktop list is now a `table-fixed` with a `<colgroup>`:
 *      the widths are DECLARED rather than negotiated by content, which is what makes a sideways
 *      scroll impossible instead of merely unlikely.
 *   2. SIX COLUMNS AT 375px. Mobile gets cards — the admin shell's own rule — and the six columns
 *      are MERGED down to four rather than shrunk: the link's type rides under its label, and the
 *      status chip rides above its expiry date. Nothing here is smaller than it was.
 *   3. THE TWO `<code>` BLOCKS SCROLLED SIDEWAYS. A long feed URL and a long IMPORTDATA formula
 *      now WRAP (`break-all`), which is the permitted answer; the ellipsis ban rules out cutting
 *      them, and a scroll inside a panel hides the tail of the one string the reader came to copy.
 *
 * Square corners throughout, no `rounded-*` anywhere in this file, and the panel keeps the module's
 * own ground: `adminPanelClassName` plus `adminPanelHeaderClassName` for the dark band, which is
 * direct-orders' depth rule and must not be swapped for a hand-written header.
 */
export function ReportShareLinksPanel({ filters, productionUrl }: Props) {
  const [links, setLinks] = useState<DirectOrderShareLink[]>([]);
  // Captured when the list is fetched, never read during render: `Date.now()` in a render body is
  // impure (react-hooks/purity) — a re-render could silently flip a link from active to expired
  // mid-paint. Stamping it alongside the data keeps the row's verdict and the data one fact.
  const [loadedAtMs, setLoadedAtMs] = useState(0);
  const [surface, setSurface] = useState<"live" | "feed">("feed");
  const [label, setLabel] = useState("");
  const [passcode, setPasscode] = useState("");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string; surface: "live" | "feed" } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/direct-orders/report/share-links");
      const data = (await res.json().catch(() => ({}))) as { links?: DirectOrderShareLink[] };
      setLinks(Array.isArray(data.links) ? data.links : []);
      setLoadedAtMs(Date.now());
    } catch {
      /* the panel is a convenience; a failed list must not break the report page */
    }
  }

  // Loaded ON MOUNT, not on open — and that change is the point of the rotation banner below.
  //
  // This panel used to fetch nothing until somebody clicked it open, which is fine for a convenience
  // that mints links on demand and wrong for a warning: the state it has to show is "a second live
  // feed link exists, so the weekly token rotation has been refusing ever since", and a warning
  // behind a closed button is the silence that let the CV-lifecycle sheet sit unrotated for four
  // days in October 2026. One list read on a page the reader already has permission to publish from
  // is the whole cost. A failed read is still swallowed: the report page must render regardless.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) void load();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const feedUrl = (token: string) => `${productionUrl}/api/share/direct-orders/${token}/feed`;
  const liveUrl = (token: string) => `${productionUrl}/share/direct-orders/${token}`;
  const formula = (token: string) => `=IMPORTDATA("${feedUrl(token)}")`;

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Could not copy. Select the text and copy manually.");
    }
  }

  async function create() {
    setError(null);
    setCreated(null);
    if (surface === "live" && passcode.trim().length < 4) {
      setError("Set a passcode of at least 4 characters — the live link is for a person.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/direct-orders/report/share-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          surface,
          label: label.trim() || null,
          passcode: surface === "live" ? passcode.trim() : null,
          expiresInDays: Number(days) || 30,
          filters: filters ?? null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; token?: string };
      if (!res.ok || !data.success || !data.token) throw new Error(data.message || "Could not create the link.");
      setCreated({ token: data.token, surface });
      setPasscode("");
      setLabel("");
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(linkId: string) {
    setError(null);
    try {
      const res = await fetch("/api/direct-orders/report/share-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke", linkId }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not revoke.");
      await load();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Something went wrong.");
    }
  }

  const inputClass = `${phxFieldClassName} mt-1`;
  const labelClass = phxLabelClassName;

  // The same judgement the CV-lifecycle screen reads, over the same shape. `surface` is carried on
  // these rows, so the 'live' human links are filtered out here exactly as the rotation guard
  // filters them: only unrevoked FEED links can make the rotation ambiguous.
  const ambiguity = assessLiveFeedAmbiguity(links);

  if (!open) {
    return (
      <div className="space-y-3">
        {/* Shown with the panel CLOSED. A paused rotation is not a thing the reader came here to do
            — it is a thing they have to be told, and it arrived because somebody minted the second
            link on this very button. */}
        <LiveFeedAmbiguityBanner sheet="Direct Orders" verdict={ambiguity} />
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="border border-slate-300 px-3 py-1.5 text-phx-sm font-bold text-slate-700 hover:bg-slate-50"
        >
          Live link / Google Sheet
        </button>
      </div>
    );
  }

  return (
    <section className={adminPanelClassName}>
      <header className={`${adminPanelHeaderClassName} flex items-center justify-between px-4 py-2.5`}>
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Live link / Google Sheet</h3>
        <button type="button" className="text-phx-sm font-bold text-slate-300 hover:text-white" onClick={() => setOpen(false)}>
          Close
        </button>
      </header>

      <div className="space-y-3 px-4 py-4">
        {/* And again at the top of the open panel, above the surface picker — the reader who opens
            this to mint a replacement is the one person who must not add a third live feed link. */}
        <LiveFeedAmbiguityBanner sheet="Direct Orders" verdict={ambiguity} />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setSurface("feed")}
            className={`flex-1 border px-3 py-2 text-left text-phx-sm ${surface === "feed" ? "border-orange-500 bg-orange-50" : "border-slate-300 bg-white"}`}
          >
            <span className="block font-black text-slate-900">Google Sheets feed</span>
            <span className="block text-slate-500">A live sheet that refreshes itself. Share the SHEET, not the link.</span>
          </button>
          <button
            type="button"
            onClick={() => setSurface("live")}
            className={`flex-1 border px-3 py-2 text-left text-phx-sm ${surface === "live" ? "border-orange-500 bg-orange-50" : "border-slate-300 bg-white"}`}
          >
            <span className="block font-black text-slate-900">Live web link</span>
            <span className="block text-slate-500">For a person with no Phoenix account. Passcode required.</span>
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <label className={labelClass}>Label</label>
            <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="CEO monthly view" />
          </div>
          <div>
            <label className={labelClass}>Expires in (days)</label>
            <input className={inputClass} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </div>
          {surface === "live" ? (
            <div>
              <label className={labelClass}>Passcode *</label>
              <input className={inputClass} value={passcode} onChange={(e) => setPasscode(e.target.value)} placeholder="Share this separately" />
            </div>
          ) : null}
        </div>

        <p className="border border-amber-300 bg-amber-50 px-3 py-2 text-phx-sm font-semibold text-amber-900">
          This publishes requester names, pharmacies, quantities, prices and sales values to whoever
          holds the link. It shows only what YOU can see, expires on the date above, and you can
          revoke it at any time.
        </p>

        {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}

        <button
          type="button"
          onClick={create}
          disabled={busy}
          className="bg-orange-500 px-4 py-2 text-phx-sm font-black uppercase tracking-wider text-white hover:bg-orange-600 disabled:bg-slate-300"
        >
          {busy ? "Creating…" : "Create link"}
        </button>

        {created ? (
          <div className="space-y-2 border border-emerald-300 bg-emerald-50 px-3 py-3">
            {created.surface === "feed" ? (
              <>
                <p className="text-phx-sm font-black text-emerald-900">
                  Paste this into cell A1 of a new Google Sheet:
                </p>
                {/* `break-all`, not a scroll container: the golden rule forbids a horizontal
                    scroll and the ellipsis ban forbids cutting it, so a long formula wraps. */}
                <code className="block break-all border border-emerald-200 bg-white px-2 py-1.5 text-phx-xs">
                  {formula(created.token)}
                </code>
                <button type="button" onClick={() => copy(formula(created.token), "formula")} className="bg-slate-900 px-3 py-1.5 text-phx-xs font-bold text-white">
                  {copied === "formula" ? "Copied" : "Copy formula"}
                </button>
                <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-phx-xs text-slate-700">
                  <li>Open sheets.new</li>
                  <li>Click cell A1 and paste, then press Enter</li>
                  <li>File &rarr; Rename, then Share with whoever needs it</li>
                </ol>
                <p className="text-phx-xs font-semibold text-emerald-800">
                  Google refreshes it about once an hour. Share the SHEET — never this URL.
                </p>
              </>
            ) : (
              <>
                <p className="text-phx-sm font-black text-emerald-900">Send this link, and the passcode separately:</p>
                {/* Same reason as the formula above — a long share URL wraps, never scrolls. */}
                <code className="block break-all border border-emerald-200 bg-white px-2 py-1.5 text-phx-xs">
                  {liveUrl(created.token)}
                </code>
                <button type="button" onClick={() => copy(liveUrl(created.token), "link")} className="bg-slate-900 px-3 py-1.5 text-phx-xs font-bold text-white">
                  {copied === "link" ? "Copied" : "Copy link"}
                </button>
              </>
            )}
          </div>
        ) : null}

        {links.length > 0 ? (
          <div className="border-t border-[#eef1f3] pt-3">
            {/* Desktop. `table-fixed` + `<colgroup>` so the widths are DECLARED rather than
                negotiated by content — which is what makes a horizontal scroll impossible. Six
                columns became four by MERGING: the type rides under the label, the status chip
                above the expiry date. Nothing was made smaller to fit. */}
            <div className="hidden md:block">
              <table className="w-full table-fixed text-left text-phx-sm">
                <colgroup>
                  <col className="w-[42%]" />
                  <col className="w-[26%]" />
                  <col className="w-[14%]" />
                  <col className="w-[18%]" />
                </colgroup>
                <thead>
                  <tr className="text-phx-xs font-black uppercase tracking-wider text-slate-500">
                    <th className="px-2 py-1">Link</th>
                    <th className="px-2 py-1">Expires</th>
                    <th className="px-2 py-1">Opens</th>
                    <th className="px-2 py-1">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {links.map((link) => {
                    const state = linkState(link, loadedAtMs);
                    return (
                      <tr key={link.id} className="border-t border-[#f1f4f6] align-top">
                        <td className="px-2 py-1.5">
                          <span className="block break-words font-semibold text-slate-800">
                            {link.label ?? "Unlabelled link"}
                          </span>
                          <span className="mt-0.5 block break-words text-phx-xs text-slate-500">
                            {surfaceName(link.surface)}
                          </span>
                        </td>
                        <td className="px-2 py-1.5">
                          <StatusChip state={state} />
                          <span className="mt-0.5 block break-words text-slate-600">{cairo(link.expiresAt)}</span>
                        </td>
                        <td className="px-2 py-1.5 tabular-nums text-slate-700">{link.accessCount}</td>
                        <td className="px-2 py-1.5">
                          {state === "active" ? (
                            <button type="button" onClick={() => revoke(link.id)} className="text-phx-xs font-bold text-rose-600 hover:underline">
                              Revoke
                            </button>
                          ) : (
                            <span className="text-phx-xs text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: cards, never a table — the admin shell's own rule, and the only honest way
                to show five facts on a 375px screen without shrinking type or cutting text. */}
            <ul className="divide-y divide-[#f1f4f6] md:hidden">
              {links.map((link) => {
                const state = linkState(link, loadedAtMs);
                return (
                  <li key={link.id} className="space-y-1.5 py-2.5 first:pt-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip state={state} />
                      <span className="break-words text-phx-sm font-semibold text-slate-800">
                        {link.label ?? "Unlabelled link"}
                      </span>
                    </div>
                    <p className="break-words text-phx-xs text-slate-500">
                      {surfaceName(link.surface)} · expires {cairo(link.expiresAt)}
                    </p>
                    <p className="break-words text-phx-xs text-slate-500">
                      {link.accessCount} open{link.accessCount === 1 ? "" : "s"}
                    </p>
                    {state === "active" ? (
                      <button type="button" onClick={() => revoke(link.id)} className="border border-rose-300 px-2 py-1 text-phx-xs font-bold text-rose-600 hover:bg-rose-50">
                        Revoke
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation helpers
//
// Shared by the desktop row and the mobile card deliberately: the two layouts show the SAME link,
// so a verdict computed twice is two answers to one question, and the first disagreement between
// them would be invisible — nobody opens both widths at once.
// ─────────────────────────────────────────────────────────────────────────────

type LinkState = "active" | "expired" | "revoked";

/** Revoked outranks expired: a link somebody killed is not a link that lapsed. */
function linkState(link: DirectOrderShareLink, nowMs: number): LinkState {
  if (link.revokedAt) return "revoked";
  // `nowMs` is the stamp captured alongside the fetch, so it is 0 before the first load — and
  // `expiresAt < 0` is false, which is why an unloaded list shows nothing as expired.
  return new Date(link.expiresAt).getTime() < nowMs ? "expired" : "active";
}

function surfaceName(surface: DirectOrderShareLink["surface"]): string {
  return surface === "feed" ? "Sheets feed" : "Live link";
}

function StatusChip({ state }: { state: LinkState }) {
  const tone = state === "active" ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-600";
  return <span className={`inline-block px-1.5 py-0.5 text-phx-xs font-black ${tone}`}>{state}</span>;
}
