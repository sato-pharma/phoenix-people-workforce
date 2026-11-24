"use client";

import { useEffect, useState } from "react";

import type { ClosingPharmacyCounts } from "@/lib/sales/closing-pharmacy-counts";

/**
 * The Closing Matrix's Pharmacies column, read beside the matrix (never inside its load).
 *
 * `counts` is null while it loads or when it could not be read — the column then reads "—", never
 * a zero. `note` says in plain words why it is empty when the read failed; null otherwise.
 * Pass a null `url` to read nothing (no line or month on screen yet).
 */
export function useClosingPharmacies(url: string | null): { counts: ClosingPharmacyCounts | null; note: string | null } {
  const [state, setState] = useState<{ url: string | null; counts: ClosingPharmacyCounts | null; note: string | null }>({
    url: null,
    counts: null,
    note: null,
  });

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | { success?: boolean; data?: ClosingPharmacyCounts; error?: string }
          | null;
        if (cancelled) return;
        if (response.ok && payload?.success && payload.data) {
          setState({ url, counts: payload.data, note: null });
        } else {
          setState({ url, counts: null, note: payload?.error ?? "The pharmacy count could not be read." });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ url, counts: null, note: "The pharmacy count could not be read." });
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // A result for an earlier line or month is never shown against this one.
  return state.url === url ? { counts: state.counts, note: state.note } : { counts: null, note: null };
}
