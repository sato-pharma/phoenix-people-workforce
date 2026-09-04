"use client";

import { useCallback, useEffect, useState } from "react";

import {
  assessCvLifecycleLinkExpiry,
  CV_LIFECYCLE_LINK_EXPIRY_WARNING_DAYS,
} from "@/lib/recruitment/cv-lifecycle-link-expiry";
import type { CvLifecycleShareLink } from "@/lib/recruitment/cv-lifecycle-share-links";

type Props = { productionUrl: string };

const ENDPOINT = "/api/recruitment/cv-lifecycle/share-links";

/**
 * Manage the bearer links behind the owner's live CV-lifecycle Google Sheet.
 *
 * WHY THIS SCREEN EXISTS. The backend shipped complete on 2026-09-04 (#3102) with no UI at all, so
 * the first token was minted by hand in SQL against production. Nothing in Phoenix could list,
 * revoke or renew it, and on 2027-09-04 it would simply have started answering 403 — with the sheet
 * showing yesterday's numbers rather than an error, which is the one failure mode nobody notices.
 *
 * TWO RULES GOVERN EVERY DECISION BELOW, and both are about the same fact: this token reads every
 * candidate's NAME and PHONE NUMBER, for people who are not employees and never consented to a
 * spreadsheet.
 *
 *   1. THE TOKEN IS SHOWN ONCE, AT MINT, AND NEVER AGAIN. Not in the list, not behind a "reveal"
 *      button, not in a tooltip. It is not merely hidden here — `listCvLifecycleShareLinks` does
 *      not return it at all, so it is absent from the JSON, from the React tree and from devtools.
 *      Lost a token? Revoke it and mint another. That is cheaper than a screen that can leak the
 *      candidate pool to whoever is standing behind you.
 *   2. THE EXPIRY WARNING IS THE POINT OF THE SCREEN, so it sits above everything else and reads
 *      the SAME judgement the daily alarm reads (`assessCvLifecycleLinkExpiry`). One function, two
 *      surfaces — a badge and an alert firing on different thresholds would be two answers to one
 *      question, and the first disagreement would cost the reader's trust in both.
 *
 * LAYOUT: the owner's fits-the-screen golden rule. No horizontal scroll at any width. Desktop gets
 * a `table-fixed` with a `<colgroup>` (never `PortalDesktopTable`, never `overflow-x-auto` over a
 * min-width floor); mobile gets cards, which is the admin shell's own rule. Columns are MERGED to
 * fit — creator and creation date ride with the label, the read count with the last read — rather
 * than shrunk, and long values WRAP. Nothing is ever cut with an ellipsis. Square corners
 * throughout: no `rounded-*` anywhere in this file.
 */
export function CvLifecycleShareLinksView({ productionUrl }: Props) {
  const [links, setLinks] = useState<CvLifecycleShareLink[]>([]);
  // Stamped when the list is fetched, never read during render. `Date.now()` in a render body is
  // impure (react-hooks/purity) and a re-render could flip a row from live to expired mid-paint;
  // capturing it beside the data keeps the verdict and the rows one fact. Same trap the direct-
  // orders panel next door records.
  const [loadedAtMs, setLoadedAtMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("365");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ expiresAt: string; token: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(ENDPOINT);
      const data = (await res.json().catch(() => ({}))) as {
        links?: CvLifecycleShareLink[];
        message?: string;
      };
      if (!res.ok) throw new Error(data.message || "Could not load the sheet links.");
      setLinks(Array.isArray(data.links) ? data.links : []);
      setLoadedAtMs(Date.now());
      setError(null);
    } catch (loadError) {
      // Said out loud rather than swallowed. Unlike the direct-orders panel — a convenience bolted
      // onto a report page that must still render — an empty list IS this page, and showing one
      // silently would read as "no links exist", which is the opposite of "I could not look".
      setError(loadError instanceof Error ? loadError.message : "Could not load the sheet links.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Deferred by a zero-delay timer, NOT called straight from the effect body — and this is load
  // bearing, not a style. `react-hooks/set-state-in-effect` is an ERROR in this repo's config
  // (eslint-config-next/core-web-vitals, React 19.2), and it reads the setState calls inside
  // `load` as synchronous within the effect. The direct form fails `pnpm run lint`, which is a
  // required check. The direct-orders panel next door carries the same timer for the same reason
  // without saying so — do not "simplify" either of them back.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) void load();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);

  const feedUrl = (token: string) => `${productionUrl}/api/share/cv-lifecycle/${token}/feed`;

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Could not copy. Select the text and copy it manually.");
    }
  }

  async function create() {
    setError(null);
    setCreated(null);
    const requestedDays = Number(days);
    if (!Number.isFinite(requestedDays) || requestedDays <= 0) {
      setError("Set an expiry of at least one day.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresInDays: requestedDays, label: label.trim() || null }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        expiresAt?: string;
        message?: string;
        success?: boolean;
        token?: string;
      };
      if (!res.ok || !data.success || !data.token) {
        throw new Error(data.message || "Could not create the link.");
      }
      setCreated({ expiresAt: String(data.expiresAt ?? ""), token: data.token });
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
    setConfirmingRevoke(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke", linkId }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; success?: boolean };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not revoke the link.");
      await load();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Something went wrong.");
    }
  }

  // ONE judgement, shared with the daily alarm. `loadedAtMs` rather than `Date.now()` — see above.
  const verdict = assessCvLifecycleLinkExpiry(links, loadedAtMs || 0);
  const expiringIds = new Set(verdict.expiringSoon.map((link) => link.id));

  const inputClass =
    "mt-1 w-full border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-orange-500 focus:outline-none";
  const fieldLabelClass = "block text-phx-xs font-black uppercase tracking-wider text-slate-500";

  return (
    <div className="space-y-4">
      {loadedAtMs > 0 ? <ExpiryBanner verdict={verdict} /> : null}

      {/* ── Mint ───────────────────────────────────────────────────────────── */}
      <section className="border border-phx-line bg-white">
        <header className="border-b border-phx-line bg-slate-900 px-4 py-2.5">
          <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Create a link</h2>
        </header>
        <div className="space-y-3 px-4 py-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className={fieldLabelClass} htmlFor="cv-sheet-link-label">
                Label
              </label>
              <input
                className={inputClass}
                id="cv-sheet-link-label"
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Owner live CV lifecycle Google Sheet"
                value={label}
              />
            </div>
            <div>
              <label className={fieldLabelClass} htmlFor="cv-sheet-link-days">
                Expires in (days, max 365)
              </label>
              <input
                className={inputClass}
                id="cv-sheet-link-days"
                inputMode="numeric"
                onChange={(event) => setDays(event.target.value)}
                value={days}
              />
            </div>
          </div>

          <p className="border border-amber-300 bg-amber-50 px-3 py-2 text-phx-sm font-semibold text-amber-900">
            This link reads every candidate&apos;s name and phone number, with no Phoenix login. Put it in
            the sheet&apos;s Apps Script — never in a cell, never in a message — and keep the sheet private:
            the sheet&apos;s own Google sharing is the real access control. You will see the token once, on
            this screen, and never again.
          </p>

          {error ? (
            <p className="border border-rose-300 bg-rose-50 px-3 py-2 text-phx-sm font-semibold text-rose-700">
              {error}
            </p>
          ) : null}

          <button
            className="bg-orange-500 px-4 py-2 text-phx-sm font-black uppercase tracking-wider text-white hover:bg-orange-600 disabled:bg-slate-300"
            disabled={busy}
            onClick={create}
            type="button"
          >
            {busy ? "Creating…" : "Create link"}
          </button>

          {created ? (
            <div className="space-y-2 border border-emerald-300 bg-emerald-50 px-3 py-3">
              <p className="text-phx-sm font-black text-emerald-900">
                Copy this now — it is shown once and cannot be retrieved afterwards.
              </p>
              {/* `break-all`, not `overflow-x-auto`: the golden rule forbids a horizontal scroll,
                  and the ellipsis ban forbids cutting it. A long URL wraps. */}
              <code className="block break-all border border-emerald-200 bg-white px-2 py-1.5 text-phx-xs text-slate-900">
                {feedUrl(created.token)}
              </code>
              <button
                className="bg-slate-900 px-3 py-1.5 text-phx-xs font-bold text-white hover:bg-slate-700"
                onClick={() => copy(feedUrl(created.token), "url")}
                type="button"
              >
                {copied === "url" ? "Copied" : "Copy feed URL"}
              </button>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-phx-xs text-slate-700">
                <li>Open the sheet, then Extensions ▸ Apps Script</li>
                <li>Project Settings ▸ Script Properties</li>
                <li>
                  Set <span className="font-black">FEED_URL</span> to the address above, and save
                </li>
                <li>Run refreshCvLifecycle once to confirm the sheet fills</li>
                <li>Come back here and revoke the link it replaced</li>
              </ol>
              <p className="text-phx-xs font-semibold text-emerald-800">
                Expires {cairoDate(created.expiresAt)}. Nothing warns the sheet — this screen and the daily
                check are what warn you.
              </p>
            </div>
          ) : null}
        </div>
      </section>

      {/* ── The links ──────────────────────────────────────────────────────── */}
      <section className="border border-phx-line bg-white">
        <header className="border-b border-phx-line bg-slate-900 px-4 py-2.5">
          <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Existing links</h2>
        </header>

        {loading ? (
          <p className="px-4 py-6 text-phx-sm text-slate-500">Loading…</p>
        ) : links.length === 0 ? (
          <p className="px-4 py-6 text-phx-sm text-slate-500">
            No link has ever been created. The sheet is not being fed.
          </p>
        ) : (
          <>
            {/* Desktop. `table-fixed` + `<colgroup>` so the widths are declared rather than
                negotiated by content — which is what makes a horizontal scroll impossible. */}
            <div className="hidden md:block">
              <table className="w-full table-fixed text-left text-phx-sm">
                <colgroup>
                  <col className="w-[38%]" />
                  <col className="w-[24%]" />
                  <col className="w-[22%]" />
                  <col className="w-[16%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-phx-line text-phx-xs font-black uppercase tracking-wider text-slate-500">
                    <th className="px-4 py-2">Link</th>
                    <th className="px-4 py-2">Expires</th>
                    <th className="px-4 py-2">Reads</th>
                    <th className="px-4 py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {links.map((link) => {
                    const state = linkState(link, loadedAtMs);
                    return (
                      <tr className="border-b border-[#f1f4f6] align-top" key={link.id}>
                        <td className="px-4 py-3">
                          <span className="block break-words font-black text-slate-900">
                            {link.label ?? "Unlabelled link"}
                          </span>
                          <span className="mt-0.5 block break-words text-phx-xs text-slate-500">
                            {link.createdByName} · {cairoDate(link.createdAt)} · id {link.tokenPreview}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <StatusChip expiring={expiringIds.has(link.id)} state={state} />
                          <span className="mt-1 block break-words text-slate-700">{cairoDate(link.expiresAt)}</span>
                          <span className="block break-words text-phx-xs text-slate-500">
                            {remaining(link, state, loadedAtMs)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="block tabular-nums text-slate-700">{link.accessCount}</span>
                          <span className="block break-words text-phx-xs text-slate-500">
                            {link.lastAccessedAt ? `last ${cairoDate(link.lastAccessedAt)}` : "never read"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <RevokeControl
                            confirming={confirmingRevoke === link.id}
                            link={link}
                            onCancel={() => setConfirmingRevoke(null)}
                            onConfirm={() => revoke(link.id)}
                            onStart={() => setConfirmingRevoke(link.id)}
                            state={state}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: cards, never a table — the admin shell's own rule, and the only honest way
                to show eight facts on a 375px screen without shrinking type or cutting text. */}
            <ul className="divide-y divide-[#f1f4f6] md:hidden">
              {links.map((link) => {
                const state = linkState(link, loadedAtMs);
                return (
                  <li className="space-y-1.5 px-4 py-3" key={link.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip expiring={expiringIds.has(link.id)} state={state} />
                      <span className="break-words text-phx-sm font-black text-slate-900">
                        {link.label ?? "Unlabelled link"}
                      </span>
                    </div>
                    <p className="break-words text-phx-xs text-slate-500">
                      {link.createdByName} · created {cairoDate(link.createdAt)} · id {link.tokenPreview}
                    </p>
                    <p className="break-words text-phx-sm text-slate-700">
                      Expires {cairoDate(link.expiresAt)} — {remaining(link, state, loadedAtMs)}
                    </p>
                    <p className="break-words text-phx-xs text-slate-500">
                      {link.accessCount} read{link.accessCount === 1 ? "" : "s"}
                      {link.lastAccessedAt ? `, last ${cairoDate(link.lastAccessedAt)}` : ", never read"}
                    </p>
                    <RevokeControl
                      confirming={confirmingRevoke === link.id}
                      link={link}
                      onCancel={() => setConfirmingRevoke(null)}
                      onConfirm={() => revoke(link.id)}
                      onStart={() => setConfirmingRevoke(link.id)}
                      state={state}
                    />
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation helpers
// ─────────────────────────────────────────────────────────────────────────────

type LinkState = "active" | "expired" | "revoked";

/** Revoked outranks expired: a link someone killed is not a link that lapsed. */
function linkState(link: CvLifecycleShareLink, nowMs: number): LinkState {
  if (link.revokedAt) return "revoked";
  const expiresMs = new Date(link.expiresAt).getTime();
  if (Number.isFinite(expiresMs) && expiresMs <= nowMs) return "expired";
  return "active";
}

/** Cairo, always — the owner reads every time in Cairo local time, never raw UTC. */
function cairoDate(iso: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(at);
}

function remaining(link: CvLifecycleShareLink, state: LinkState, nowMs: number): string {
  if (state === "revoked") return `revoked ${cairoDate(link.revokedAt)}`;
  const expiresMs = new Date(link.expiresAt).getTime();
  if (!Number.isFinite(expiresMs) || !nowMs) return "";
  const days = Math.floor((expiresMs - nowMs) / (24 * 60 * 60 * 1000));
  if (state === "expired") return days === 0 ? "expired today" : `expired ${Math.abs(days)} days ago`;
  return days === 0 ? "less than a day left" : `${days} days left`;
}

function StatusChip({ expiring, state }: { expiring: boolean; state: LinkState }) {
  const tone =
    state === "revoked"
      ? "bg-slate-200 text-slate-600"
      : state === "expired"
        ? "bg-rose-100 text-rose-800"
        : expiring
          ? "bg-amber-100 text-amber-900"
          : "bg-emerald-100 text-emerald-800";
  const text = state === "revoked" ? "Revoked" : state === "expired" ? "Expired" : expiring ? "Expiring" : "Active";
  return <span className={`inline-block px-1.5 py-0.5 text-phx-xs font-black ${tone}`}>{text}</span>;
}

/**
 * Revoke, behind one confirmation.
 *
 * Two clicks rather than one because revoking is instant, silent and unrecoverable from this
 * screen: the sheet stops filling on the next pull and the only repair is minting a token and
 * editing the Apps Script — which is exactly the outage this page was built to prevent. A revoked
 * or already-expired link offers no control at all; there is nothing left to do to it.
 */
function RevokeControl({
  confirming,
  link,
  onCancel,
  onConfirm,
  onStart,
  state,
}: {
  confirming: boolean;
  link: CvLifecycleShareLink;
  onCancel: () => void;
  onConfirm: () => void;
  onStart: () => void;
  state: LinkState;
}) {
  if (state !== "active") return <span className="text-phx-xs text-slate-400">—</span>;
  if (!confirming) {
    return (
      <button
        className="border border-rose-300 px-2 py-1 text-phx-xs font-bold text-rose-600 hover:bg-rose-50"
        onClick={onStart}
        type="button"
      >
        Revoke
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="block w-full text-phx-xs font-semibold text-rose-700">
        The sheet stops filling. Sure?
      </span>
      <button
        className="bg-rose-600 px-2 py-1 text-phx-xs font-black text-white hover:bg-rose-700"
        onClick={onConfirm}
        type="button"
      >
        Revoke {link.tokenPreview}
      </button>
      <button
        className="border border-slate-300 px-2 py-1 text-phx-xs font-bold text-slate-600 hover:bg-slate-50"
        onClick={onCancel}
        type="button"
      >
        Cancel
      </button>
    </span>
  );
}

/**
 * The reason the screen exists, at the top of it.
 *
 * Three states, and the quiet one is deliberately loud enough to read: NO LIVE LINK AT ALL is the
 * state the sheet is dead in, and it is also what a brand-new installation looks like, so it says
 * which. A healthy banner is still shown — "nothing expiring" is the answer somebody came here to
 * check, and a screen that renders nothing when all is well cannot be distinguished from one that
 * failed to load.
 */
function ExpiryBanner({ verdict }: { verdict: ReturnType<typeof assessCvLifecycleLinkExpiry> }) {
  if (verdict.expired.length > 0 || verdict.liveCount === 0) {
    return (
      <section className="border-2 border-rose-500 bg-rose-50 px-4 py-3">
        <h2 className="text-phx-sm font-black uppercase tracking-wider text-rose-800">
          {verdict.liveCount === 0 ? "The sheet is not being fed" : "A link has expired"}
        </h2>
        <p className="mt-1 text-phx-sm font-semibold text-rose-900">
          {verdict.liveCount === 0
            ? "No live link remains, so the Google Sheet is showing numbers that have stopped moving rather than an error. Create a link below and paste it into the sheet's Apps Script."
            : `${verdict.expired.length} link(s) lapsed without being replaced. A live link still feeds the sheet, but tidy these away.`}
        </p>
      </section>
    );
  }

  if (verdict.expiringSoon.length > 0) {
    const soonest = verdict.expiringSoon[0]!;
    return (
      <section className="border-2 border-amber-500 bg-amber-50 px-4 py-3">
        <h2 className="text-phx-sm font-black uppercase tracking-wider text-amber-900">
          A link expires in {soonest.daysLeft === 0 ? "less than a day" : `${soonest.daysLeft} days`}
        </h2>
        <p className="mt-1 text-phx-sm font-semibold text-amber-900">
          When it lapses the sheet keeps showing yesterday&apos;s numbers instead of an error, so nothing
          else will tell you. Create the replacement below, paste it into the sheet&apos;s Apps Script, then
          revoke the old one.
        </p>
      </section>
    );
  }

  return (
    <section className="border border-emerald-300 bg-emerald-50 px-4 py-2.5">
      <p className="text-phx-sm font-semibold text-emerald-900">
        {verdict.liveCount} live link
        {verdict.liveCount === 1 ? "" : "s"}, none expiring within {CV_LIFECYCLE_LINK_EXPIRY_WARNING_DAYS} days.
      </p>
    </section>
  );
}
