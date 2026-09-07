"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Finance's sales-month control.
 *
 * The month decides which month's sales this order lands in — it is NOT the approval date.
 * Only Finance (Ahmed El Maraghy) and Super Admin see the editable form; everyone else sees the
 * chosen month read-only, so the CEO and SFE Manager can check it without being able to move it.
 */
export function DirectOrderSalesMonthControl({
  requestId,
  salesMonth,
  canEdit,
  status,
}: {
  requestId: string;
  salesMonth: string | null;
  canEdit: boolean;
  status: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(salesMonth ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function save(next: string | null) {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(`/api/direct-orders/${encodeURIComponent(requestId)}/sales-month`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salesMonth: next }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        requestedMonth?: string | null;
        salesMonth?: string | null;
        shifted?: boolean;
        success?: boolean;
      };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not set the sales month.");

      // Report the month the SERVER saved, never the one this form sent. A booking aimed at a
      // published closing is carried forward to the first open month, so those two differ exactly
      // when it matters most — and "Booked into 2026-08" over an order that actually landed in
      // September is the confident-and-wrong message this whole rule exists to prevent.
      const saved = data.salesMonth ?? null;
      setValue(saved ?? "");
      setOk(
        data.shifted
          ? `${data.requestedMonth} is a published closing and cannot change, so this order was booked into ${saved} instead.`
          : saved
            ? `Booked into ${saved}.`
            : "Sales month cleared — this order counts in no month.",
      );
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const isApproved = status === "approved";

  return (
    <div className="border-t border-[#eef1f3] px-4 py-3">
      <p className="text-phx-2xs font-black uppercase tracking-wider text-slate-400">Sales month (Finance)</p>

      {!canEdit ? (
        <p className="mt-0.5 text-sm font-semibold text-slate-900">
          {salesMonth ?? "— not booked into any month yet"}
        </p>
      ) : (
        <div className="mt-1.5 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="month"
              className="border border-slate-300 px-2 py-1 text-sm"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              disabled={busy || !value || value === salesMonth}
              className="bg-slate-800 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-900 disabled:opacity-50"
              onClick={() => save(value)}
            >
              {salesMonth ? "Change month" : "Book into month"}
            </button>
            {salesMonth ? (
              <button
                type="button"
                disabled={busy}
                className="px-2 py-1.5 text-sm font-bold text-rose-600 hover:text-rose-700 disabled:opacity-50"
                onClick={() => {
                  setValue("");
                  void save(null);
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
          <p className="text-phx-xs text-slate-500">
            {isApproved
              ? "Changing this moves the sales out of the old month and into the new one."
              : "You can set this now — the sales land once the order is fully approved."}
          </p>
        </div>
      )}

      {error ? <p className="mt-1.5 text-phx-sm font-semibold text-rose-600">{error}</p> : null}
      {ok ? <p className="mt-1.5 text-phx-sm font-semibold text-emerald-600">{ok}</p> : null}
    </div>
  );
}
