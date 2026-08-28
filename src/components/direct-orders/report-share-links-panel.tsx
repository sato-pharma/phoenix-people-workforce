"use client";

import { useEffect, useState } from "react";

import type { DirectOrderShareLink } from "@/lib/direct-orders/report-share-links";

type Props = {
  /** The reader's current filter slice, captured into the link so it matches their screen. */
  filters?: Record<string, unknown> | null;
  productionUrl: string;
};

const cairo = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", day: "2-digit", month: "short", year: "numeric" }).format(
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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) void load();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open]);

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

  const inputClass = "mt-1 w-full border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none";
  const labelClass = "block text-[11px] font-black uppercase tracking-wider text-slate-500";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border border-slate-300 px-3 py-1.5 text-[12px] font-bold text-slate-700 hover:bg-slate-50"
      >
        Live link / Google Sheet
      </button>
    );
  }

  return (
    <section className="border border-phx-line bg-white">
      <header className="flex items-center justify-between border-b border-phx-line bg-slate-900 px-4 py-2.5">
        <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">Live link / Google Sheet</h3>
        <button type="button" className="text-[12px] font-bold text-slate-300 hover:text-white" onClick={() => setOpen(false)}>
          Close
        </button>
      </header>

      <div className="space-y-3 px-4 py-4">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setSurface("feed")}
            className={`flex-1 border px-3 py-2 text-left text-[12px] ${surface === "feed" ? "border-orange-500 bg-orange-50" : "border-slate-300 bg-white"}`}
          >
            <span className="block font-black text-slate-900">Google Sheets feed</span>
            <span className="block text-slate-500">A live sheet that refreshes itself. Share the SHEET, not the link.</span>
          </button>
          <button
            type="button"
            onClick={() => setSurface("live")}
            className={`flex-1 border px-3 py-2 text-left text-[12px] ${surface === "live" ? "border-orange-500 bg-orange-50" : "border-slate-300 bg-white"}`}
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

        <p className="border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-900">
          This publishes requester names, pharmacies, quantities, prices and sales values to whoever
          holds the link. It shows only what YOU can see, expires on the date above, and you can
          revoke it at any time.
        </p>

        {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}

        <button
          type="button"
          onClick={create}
          disabled={busy}
          className="bg-orange-500 px-4 py-2 text-[12px] font-black uppercase tracking-wider text-white hover:bg-orange-600 disabled:bg-slate-300"
        >
          {busy ? "Creating…" : "Create link"}
        </button>

        {created ? (
          <div className="space-y-2 border border-emerald-300 bg-emerald-50 px-3 py-3">
            {created.surface === "feed" ? (
              <>
                <p className="text-[12px] font-black text-emerald-900">
                  Paste this into cell A1 of a new Google Sheet:
                </p>
                <code className="block overflow-x-auto whitespace-nowrap border border-emerald-200 bg-white px-2 py-1.5 text-[11px]">
                  {formula(created.token)}
                </code>
                <button type="button" onClick={() => copy(formula(created.token), "formula")} className="bg-slate-900 px-3 py-1.5 text-[11px] font-bold text-white">
                  {copied === "formula" ? "Copied" : "Copy formula"}
                </button>
                <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[11px] text-slate-700">
                  <li>Open sheets.new</li>
                  <li>Click cell A1 and paste, then press Enter</li>
                  <li>File &rarr; Rename, then Share with whoever needs it</li>
                </ol>
                <p className="text-[11px] font-semibold text-emerald-800">
                  Google refreshes it about once an hour. Share the SHEET — never this URL.
                </p>
              </>
            ) : (
              <>
                <p className="text-[12px] font-black text-emerald-900">Send this link, and the passcode separately:</p>
                <code className="block overflow-x-auto whitespace-nowrap border border-emerald-200 bg-white px-2 py-1.5 text-[11px]">
                  {liveUrl(created.token)}
                </code>
                <button type="button" onClick={() => copy(liveUrl(created.token), "link")} className="bg-slate-900 px-3 py-1.5 text-[11px] font-bold text-white">
                  {copied === "link" ? "Copied" : "Copy link"}
                </button>
              </>
            )}
          </div>
        ) : null}

        {links.length > 0 ? (
          <div className="overflow-x-auto border-t border-[#eef1f3] pt-3">
            <table className="w-full text-left text-[12px]">
              <thead>
                <tr className="text-[11px] font-black uppercase tracking-wider text-slate-500">
                  <th className="px-2 py-1">Label</th>
                  <th className="px-2 py-1">Type</th>
                  <th className="px-2 py-1">Expires</th>
                  <th className="px-2 py-1">Opens</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => {
                  const dead = Boolean(link.revokedAt) || new Date(link.expiresAt).getTime() < loadedAtMs;
                  return (
                    <tr key={link.id} className="border-t border-[#f1f4f6]">
                      <td className="px-2 py-1.5 font-semibold text-slate-800">{link.label ?? "—"}</td>
                      <td className="px-2 py-1.5 text-slate-600">{link.surface === "feed" ? "Sheets feed" : "Live link"}</td>
                      <td className="px-2 py-1.5 text-slate-600">{cairo(link.expiresAt)}</td>
                      <td className="px-2 py-1.5 tabular-nums text-slate-700">{link.accessCount}</td>
                      <td className="px-2 py-1.5">
                        <span className={`px-1.5 py-0.5 text-[11px] font-black ${dead ? "bg-slate-200 text-slate-600" : "bg-emerald-100 text-emerald-800"}`}>
                          {link.revokedAt ? "revoked" : dead ? "expired" : "active"}
                        </span>
                      </td>
                      <td className="px-2 py-1.5">
                        {!dead ? (
                          <button type="button" onClick={() => revoke(link.id)} className="text-[11px] font-bold text-rose-600 hover:underline">
                            Revoke
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}
