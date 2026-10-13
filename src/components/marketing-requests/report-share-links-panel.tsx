"use client";

import { useEffect, useState } from "react";

import type { MarketingShareLink } from "@/lib/marketing-requests/report-share-links";
import { assessLiveFeedAmbiguity } from "@/lib/share-links/live-feed-ambiguity";
import { LiveFeedAmbiguityBanner } from "@/components/share-links/live-feed-ambiguity-banner";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { CheckTile } from "@/components/ui/form-kit";
import { phxFieldClassName, phxLabelClassName } from "@/components/ui/form-tokens";
import { adminPanelClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";

const ENDPOINT = "/api/marketing-requests/report/share-links";

const cairo = (iso: string | null) =>
  iso
    ? stableEnGbFormatter({ timeZone: "Africa/Cairo", day: "2-digit", month: "short", year: "numeric" }).format(
        new Date(iso),
      )
    : "—";

/**
 * Create and manage the links behind the owner's live Marketing Requests Google Sheet.
 *
 * Until this panel existed the Marketing links were API-only (`SHARE_LINK_FEEDS` recorded
 * `screen: null`), so a second live feed link could be minted by hand and the weekly token rotation
 * would then refuse for as long as it stood, with nothing on any screen saying so. The rotation
 * banner is the reason this exists; the mint and revoke controls are what make it actionable.
 *
 * FEED ONLY, BY DESIGN. The service can also mint a `live` human link, but no route or page serves
 * one for Marketing (only `/api/share/marketing-requests/[token]/feed` and `/file` exist), so
 * offering it would hand out a URL that opens nothing. The Direct Orders panel's second surface is
 * deliberately absent here.
 *
 * THE SHEET TAKES THE BARE TOKEN, NOT A URL. `docs/marketing-request-live-sheet.gs` reads a
 * `FEED_TOKEN` script property and builds the address itself, so the minted value is shown for
 * that property, once. The list never carries a token — only `tokenPreview` exists on its rows, and
 * the one whole token this file may read is `created.token`, from the mint response.
 *
 * LAYOUT: the owner's fits-the-screen golden rule. Desktop is a `table-fixed` with a `<colgroup>`
 * (declared widths, so a sideways scroll is impossible rather than unlikely), mobile gets cards,
 * long values wrap with `break-all`/`break-words`, and nothing is cut with an ellipsis. Square
 * corners throughout — no `rounded-*` in this file.
 */
export function MarketingReportShareLinksPanel() {
  const [links, setLinks] = useState<MarketingShareLink[]>([]);
  // Stamped when the list is fetched, never read in a render body (`Date.now()` there is impure).
  const [loadedAtMs, setLoadedAtMs] = useState(0);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("90");
  const [allowFiles, setAllowFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ expiresAt: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);

  async function load() {
    try {
      const res = await fetch(ENDPOINT);
      const data = (await res.json().catch(() => ({}))) as { links?: MarketingShareLink[] };
      setLinks(Array.isArray(data.links) ? data.links : []);
      setLoadedAtMs(Date.now());
    } catch {
      /* the panel is a convenience; a failed list must not break the register page */
    }
  }

  // Loaded ON MOUNT, not on open: the state it exists to show — a second live feed link, so the
  // weekly rotation is refusing — must be visible without anyone clicking anything.
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

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy. Select the text and copy manually.");
    }
  }

  async function create() {
    setError(null);
    setCreated(null);
    setBusy(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowFiles,
          expiresInDays: Number(days) || 90,
          label: label.trim() || null,
          surface: "feed",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        expiresAt?: string;
        message?: string;
        success?: boolean;
        token?: string;
      };
      if (!res.ok || !data.success || !data.token) throw new Error(data.message || "Could not create the link.");
      setCreated({ expiresAt: data.expiresAt ?? "", token: data.token });
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
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke", linkId }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; success?: boolean };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not revoke.");
      await load();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Something went wrong.");
    }
  }

  const inputClass = `${phxFieldClassName} mt-1`;
  const ambiguity = assessLiveFeedAmbiguity(links);

  if (!open) {
    return (
      <div className="space-y-3">
        {/* Shown with the panel CLOSED: a paused rotation is something the reader has to be told,
            not something they came here to do. */}
        <LiveFeedAmbiguityBanner sheet="Marketing Requests" verdict={ambiguity} />
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="border border-slate-300 px-3 py-1.5 text-phx-sm font-bold text-slate-700 hover:bg-slate-50"
        >
          Live Google Sheet links
        </button>
      </div>
    );
  }

  return (
    <section className={adminPanelClassName}>
      <header className={`${adminPanelHeaderClassName} flex items-center justify-between px-4 py-2.5`}>
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Live Google Sheet links</h3>
        <button type="button" className="text-phx-sm font-bold text-slate-300 hover:text-white" onClick={() => setOpen(false)}>
          Close
        </button>
      </header>

      <div className="space-y-3 px-4 py-4">
        {/* And again inside the open panel — the reader minting a replacement is the one person who
            must not add a second live feed link. */}
        <LiveFeedAmbiguityBanner sheet="Marketing Requests" verdict={ambiguity} />

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className={phxLabelClassName}>Label</label>
            <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Owner live marketing sheet" />
          </div>
          <div>
            <label className={phxLabelClassName}>Expires in (days)</label>
            <input className={inputClass} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </div>
        </div>

        <CheckTile checked={allowFiles} onChange={setAllowFiles}>
          <span className="break-words text-phx-sm font-semibold text-slate-800">
            Let the sheet open evidence photos, invoices and transfer proofs
          </span>
        </CheckTile>

        <p className="border border-amber-300 bg-amber-50 px-3 py-2 text-phx-sm font-semibold text-amber-900">
          This publishes requester names, pharmacies, amounts and approval history to whoever holds the
          link. It shows only what YOU can see, expires on the date above, and you can revoke it at any
          time. Keep exactly ONE live link per sheet: a second one pauses the weekly token rotation.
        </p>

        {error ? <p className="break-words text-sm font-semibold text-rose-600">{error}</p> : null}

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
            <p className="text-phx-sm font-black text-emerald-900">
              Copy this now — it is shown once and cannot be retrieved afterwards.
            </p>
            {/* `break-all`, not a scroll container: no horizontal scroll, and no ellipsis. */}
            <code className="block break-all border border-emerald-200 bg-white px-2 py-1.5 text-phx-xs text-slate-900">
              {created.token}
            </code>
            <button
              type="button"
              onClick={() => copy(created.token)}
              className="bg-slate-900 px-3 py-1.5 text-phx-xs font-bold text-white hover:bg-slate-700"
            >
              {copied ? "Copied" : "Copy token"}
            </button>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-phx-xs text-slate-700">
              <li>Open the sheet, then Extensions ▸ Apps Script</li>
              <li>Project Settings ▸ Script Properties</li>
              <li>
                Set <span className="font-black">FEED_TOKEN</span> to the value above, and save
              </li>
              <li>Run refreshMarketingRequests once to confirm the sheet fills</li>
              <li>Come back here and revoke the link it replaced</li>
            </ol>
            <p className="text-phx-xs font-semibold text-emerald-800">
              {created.expiresAt ? `Expires ${cairo(created.expiresAt)}. ` : ""}Share the SHEET, never the token.
            </p>
          </div>
        ) : null}

        {links.length > 0 ? (
          <div className="border-t border-[#eef1f3] pt-3">
            {/* Desktop. `table-fixed` + `<colgroup>`: widths are declared, so a horizontal scroll is
                impossible. Merged columns, not shrunk type: the kind rides under the label and the
                status chip above the expiry date. */}
            <div className="hidden md:block">
              <table className="w-full table-fixed text-left text-phx-sm">
                <colgroup>
                  <col className="w-[40%]" />
                  <col className="w-[24%]" />
                  <col className="w-[18%]" />
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
                          <span className="mt-0.5 block break-words text-phx-xs text-slate-500">{kindOf(link)}</span>
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

            {/* Mobile: cards, never a table — the admin shell's own rule. */}
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
                      {kindOf(link)} · expires {cairo(link.expiresAt)}
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

type LinkState = "active" | "expired" | "revoked";

/** Revoked outranks expired: a link somebody killed is not a link that lapsed. */
function linkState(link: MarketingShareLink, nowMs: number): LinkState {
  if (link.revokedAt) return "revoked";
  // `nowMs` is 0 before the first load, so an unloaded list shows nothing as expired.
  return new Date(link.expiresAt).getTime() < nowMs ? "expired" : "active";
}

function kindOf(link: MarketingShareLink): string {
  const surface = link.surface === "feed" ? "Sheets feed" : "Live link";
  return link.allowFiles ? `${surface} · photos and files on` : surface;
}

function StatusChip({ state }: { state: LinkState }) {
  const tone = state === "active" ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-600";
  return <span className={`inline-block px-1.5 py-0.5 text-phx-xs font-black ${tone}`}>{state}</span>;
}
