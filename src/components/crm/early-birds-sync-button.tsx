"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Loader2, RefreshCcw } from "lucide-react";
import { toast } from "sonner";

// One island, mounted in the header of every board that shows CRM first-visit data.
//
// It sends an EMPTY body on purpose — the server derives scope from the session. Anything the
// client could name here would be something the client could lie about.

export function EarlyBirdsSyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [justChecked, setJustChecked] = useState(false);
  const mounted = useRef(true);

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/crm/early-birds/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        rowsUpserted?: number;
        retryAfterSeconds?: number;
      };

      if (response.status === 429) {
        toast.warning(`Just synced — try again in ${payload.retryAfterSeconds ?? 60}s.`);
        return;
      }
      if (response.status === 503) {
        toast.error("The CRM connection is not configured, so nothing could be fetched.");
        return;
      }
      if (!response.ok) {
        toast.error(payload.message ?? "The sync could not run.");
        return;
      }

      // Two distinct sentences. "No new visits" is the MOST common outcome, and a silent success
      // there is exactly what makes a working button look broken.
      const upserted = payload.rowsUpserted ?? 0;
      toast.success(
        upserted > 0
          ? `Board updated — ${upserted} visit${upserted === 1 ? "" : "s"} mirrored for today.`
          : "Already up to date — no new visits since the last sync.",
      );

      // Move the label in the same tick as the toast, before the server render resolves; the server
      // value wins on the next render.
      setJustChecked(true);
      window.setTimeout(() => {
        if (mounted.current) setJustChecked(false);
      }, 60_000);

      router.refresh();
    } catch {
      toast.error("The sync could not be reached.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {justChecked && (
        <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-emerald-600">
          Checked just now
        </span>
      )}
      <button
        aria-busy={busy}
        className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap border border-slate-300 bg-white px-2 text-[10px] font-bold uppercase tracking-wide text-slate-700 hover:border-orange-300 hover:text-orange-600 disabled:opacity-50"
        disabled={busy}
        onClick={run}
        type="button"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCcw className="h-3 w-3" />}
        {busy ? "Syncing" : "Sync now"}
      </button>
    </span>
  );
}
