"use client";

import { useEffect, useState } from "react";

import { Card } from "@/components/ui/card";
import type { TerritoryPreviewLink } from "@/lib/territory-management/preview-links";

type Props = { productionUrl: string };

const cairo = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Cairo",
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(new Date(iso))
    : "—";

/**
 * Create and manage passwordless preview links (owner request, 2026-08-14).
 *
 * Styled to THIS module, not to the Direct Orders share panel: the sibling surface a reader has in
 * front of them is the Territory workspace, so it uses the same Card / muted-foreground language.
 * The public page it produces matches the other public share page instead, for the same reason.
 *
 * The copy is blunt about what a link is, because there is no passcode to fall back on: whoever
 * holds the URL is the audience, including whoever it is forwarded to.
 */
export function TerritoryPreviewLinksPanel({ productionUrl }: Props) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<TerritoryPreviewLink[]>([]);
  // Stamped alongside the data, never read during render: Date.now() in a render body is impure
  // (react-hooks/purity) and would let a re-render silently flip a row from active to expired.
  const [loadedAtMs, setLoadedAtMs] = useState(0);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("14");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ areaCount: number; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      const response = await fetch("/api/territory-management/preview-links");
      const body = (await response.json().catch(() => ({}))) as { links?: TerritoryPreviewLink[] };
      setLinks(Array.isArray(body.links) ? body.links : []);
      setLoadedAtMs(Date.now());
    } catch {
      /* the panel is a convenience; a failed list must not break the workspace */
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

  const previewUrl = (token: string) => `${productionUrl}/share/territory/${token}`;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy. Select the link and copy it manually.");
    }
  }

  async function create() {
    setError(null);
    setCreated(null);
    setBusy(true);
    try {
      const response = await fetch("/api/territory-management/preview-links", {
        body: JSON.stringify({ expiresInDays: Number(days) || 14, label: label.trim() || null }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as {
        areaCount?: number;
        message?: string;
        success?: boolean;
        token?: string;
      };
      if (!response.ok || !body.success || !body.token) {
        throw new Error(body.message || "Could not create the link.");
      }
      setCreated({ areaCount: body.areaCount ?? 0, token: body.token });
      setLabel("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(linkId: string) {
    setError(null);
    try {
      const response = await fetch("/api/territory-management/preview-links", {
        body: JSON.stringify({ action: "revoke", linkId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string; success?: boolean };
      if (!response.ok || !body.success) throw new Error(body.message || "Could not switch the link off.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    }
  }

  if (!open) {
    return (
      <button
        className="rounded-md border px-3 py-1.5 text-sm"
        onClick={() => setOpen(true)}
        type="button"
      >
        Preview link
      </button>
    );
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">Preview link</h2>
          <p className="text-muted-foreground text-sm">
            A link anyone can open with no account and no password. They pick a region, then an area,
            and see that area&apos;s bricks on the map.
          </p>
        </div>
        <button
          className="text-muted-foreground text-sm underline"
          onClick={() => setOpen(false)}
          type="button"
        >
          Close
        </button>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Label</span>
          <input
            className="border-input bg-background h-9 min-w-56 rounded-md border px-2"
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Who is this for?"
            value={label}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Stops working after (days)</span>
          <input
            className="border-input bg-background h-9 min-w-32 rounded-md border px-2"
            inputMode="numeric"
            onChange={(event) => setDays(event.target.value)}
            value={days}
          />
        </label>
      </div>

      <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        There is no password on this link. Whoever holds it can open it, including anyone they
        forward it to. It shows only the areas you can see, it stops working on the date below, and
        you can switch it off at any time.
      </p>

      {error ? <p className="text-destructive text-sm font-medium">{error}</p> : null}

      <button
        className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm disabled:opacity-50"
        disabled={busy}
        onClick={() => void create()}
        type="button"
      >
        {busy ? "Creating…" : "Create link"}
      </button>

      {created ? (
        <div className="space-y-2 rounded-md border border-green-300 bg-green-50 p-3">
          <p className="text-sm font-medium text-green-900">
            Ready — this link covers {created.areaCount} areas. Send it to whoever needs it.
          </p>
          <code className="block overflow-x-auto rounded-md border border-green-200 bg-white px-2 py-1.5 text-xs whitespace-nowrap">
            {previewUrl(created.token)}
          </code>
          <button
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs text-white"
            onClick={() => void copy(previewUrl(created.token))}
            type="button"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : null}

      {links.length > 0 ? (
        <div className="overflow-x-auto border-t pt-3">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-muted-foreground text-xs uppercase">
                <th className="px-2 py-1 whitespace-nowrap">Label</th>
                <th className="px-2 py-1 whitespace-nowrap">Areas</th>
                <th className="px-2 py-1 whitespace-nowrap">Stops working</th>
                <th className="px-2 py-1 whitespace-nowrap">Opens</th>
                <th className="px-2 py-1 whitespace-nowrap">Status</th>
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => {
                const dead = Boolean(link.revokedAt) || new Date(link.expiresAt).getTime() < loadedAtMs;
                return (
                  <tr className="border-t" key={link.id}>
                    <td className="px-2 py-1.5 font-medium whitespace-nowrap">{link.label ?? "—"}</td>
                    <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">{link.areaCount}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{cairo(link.expiresAt)}</td>
                    <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">{link.accessCount}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {link.revokedAt ? "switched off" : dead ? "expired" : "active"}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {!dead ? (
                        <button
                          className="text-destructive text-xs underline"
                          onClick={() => void revoke(link.id)}
                          type="button"
                        >
                          Switch off
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
    </Card>
  );
}
