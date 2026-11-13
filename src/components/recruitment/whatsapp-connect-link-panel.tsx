"use client";

import { Check, Copy, Link2, Loader2, MessageCircle } from "lucide-react";
import { useState } from "react";

import { adminControlDepthClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { RecruitmentPanel } from "@/components/recruitment/recruitment-premium";
import { cairoDateTime12h } from "@/lib/format/cairo-datetime";

// THE ONE-TIME WHATSAPP CONNECT LINK (S01, F-PLT-008; owner's choice, 13 Nov 2026). Connecting a
// WhatsApp Business number to the intake happens on the handset, which has no Phoenix session, so the
// page there only finishes the connection for a link made here. Shown to a Super Admin only; the route
// checks the same on the server. The link works once, for 30 minutes.

type MadeLink = { expiresAt: string; url: string };

export function WhatsAppConnectLinkPanel() {
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<MadeLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function makeLink() {
    setError(null);
    setCopied(false);
    setBusy(true);
    try {
      const res = await fetch("/api/recruitment/intake/whatsapp-connect-link", {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as { expiresAt?: string; message?: string; path?: string };
      if (!res.ok || !body.path || !body.expiresAt) throw new Error(body.message || "The link could not be made.");
      setMade({ expiresAt: body.expiresAt, url: `${window.location.origin}${body.path}` });
    } catch (caught) {
      setMade(null);
      setError(caught instanceof Error ? caught.message : "The link could not be made.");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.url);
      setCopied(true);
    } catch {
      setError("Copying was blocked by the browser. Press and hold the link to copy it instead.");
    }
  }

  return (
    <RecruitmentPanel
      description="Open this link on the phone whose WhatsApp Business number should send CVs here. It works once, for 30 minutes."
      icon={<MessageCircle aria-hidden="true" className="h-4 w-4" />}
      title="Connect a WhatsApp number"
    >
      <div className="space-y-3 px-4 py-4 sm:px-5">
        <button
          className={`inline-flex items-center gap-1.5 border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-orange-300 hover:text-orange-700 disabled:opacity-50 ${adminControlDepthClassName} disabled:shadow-none`}
          disabled={busy}
          onClick={makeLink}
          type="button"
        >
          {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Link2 aria-hidden="true" className="h-3.5 w-3.5" />}
          {busy ? "Making the link…" : made ? "Make a new link" : "Make connect link"}
        </button>

        {made ? (
          <div className={`space-y-2 border border-slate-200 bg-slate-50 px-3 py-3 ${adminRecessedDepthClassName}`}>
            <p className="break-all font-mono text-xs text-slate-700">{made.url}</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                className={`inline-flex items-center gap-1.5 border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-orange-300 hover:text-orange-700 ${adminControlDepthClassName}`}
                onClick={copyLink}
                type="button"
              >
                {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy link"}
              </button>
              <span className="text-xs text-slate-500">Works once, until {cairoDateTime12h(made.expiresAt)} Cairo time.</span>
            </div>
          </div>
        ) : null}

        {error ? (
          <p className="break-words text-xs font-bold text-rose-700" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </RecruitmentPanel>
  );
}
