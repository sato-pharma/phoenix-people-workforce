"use client";

import { useEffect, useState } from "react";

import { Switch } from "@/components/ui/switch";

type TrackingState = { trackDirectSales: boolean; canManage: boolean };

/**
 * Phase D — Super-Admin-only toggle to include approved Direct Order Request sales at
 * this campaign's own target pharmacies + products in its ROI actuals. Self-contained:
 * it reads its own state and renders nothing unless the viewer is a Super Admin.
 */
export function DirectTrackingToggle({ requestId }: { requestId: string }) {
  const [state, setState] = useState<TrackingState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/marketing-requests/${requestId}/track-direct-sales`, { cache: "no-store" });
        if (!res.ok) return;
        const payload = (await res.json()) as Partial<TrackingState>;
        if (!cancelled) {
          setState({ trackDirectSales: Boolean(payload.trackDirectSales), canManage: Boolean(payload.canManage) });
        }
      } catch {
        /* optional chrome — stay silent if the state can't be read */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  if (!state || !state.canManage) return null;

  async function toggle(next: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/marketing-requests/${requestId}/track-direct-sales`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const payload = (await res.json()) as { trackDirectSales?: boolean; success?: boolean; message?: string };
      if (!res.ok || payload.success === false) {
        setError(payload.message ?? "Could not update direct-sales tracking.");
        return;
      }
      setState((prev) => (prev ? { ...prev, trackDirectSales: Boolean(payload.trackDirectSales) } : prev));
    } catch {
      setError("Could not update direct-sales tracking.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-phx-line bg-phx-paper px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink">Track direct-order sales</p>
        <p className="mt-0.5 text-phx-xs font-semibold text-phx-ink-soft">
          On by default — approved Direct Order sales at this campaign&apos;s pharmacies count in its ROI. Only a Super Admin can switch it off.
        </p>
        {error ? <p className="mt-1 text-phx-xs font-semibold text-[#DC2626]">{error}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-phx-xs font-bold text-phx-ink-2">{state.trackDirectSales ? "On" : "Off"}</span>
        <Switch
          checked={state.trackDirectSales}
          label="Track direct-order sales in ROI"
          onChange={(next) => void toggle(next)}
        />
      </div>
    </div>
  );
}
