"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormError } from "@/components/ui/form-kit";
import { phxButtonDangerClassName, phxButtonGhostClassName } from "@/components/ui/form-tokens";

/** Close one careers card: two presses, because it takes a live job off the public page at once. */
export function JobPostCloseCardButton({ cardId, title }: { cardId: string; title: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function close() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/recruitment/job-posts/close", {
        body: JSON.stringify({ cardId, title }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? "The card could not be closed.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The card could not be closed.");
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button className={phxButtonGhostClassName} onClick={() => setConfirming(true)} type="button">
        Close card
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-xs font-semibold text-slate-700">Take this off the careers page now?</span>
      <button className={phxButtonDangerClassName} disabled={busy} onClick={close} type="button">
        {busy ? "Closing…" : "Yes, close it"}
      </button>
      <button className={phxButtonGhostClassName} disabled={busy} onClick={() => setConfirming(false)} type="button">
        Keep it
      </button>
      <FormError>{error}</FormError>
    </span>
  );
}
