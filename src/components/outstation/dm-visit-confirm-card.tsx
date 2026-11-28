"use client";

import { CheckCircle2, Loader2, MapPin, Users } from "lucide-react";
import { useState } from "react";

import { usablePosition } from "@/lib/outstation/captured-coordinates";
import { cairoShortTime } from "@/lib/outstation/dm-expense-rules";

export type DmVisitToConfirmRow = {
  capturedAt: string;
  confirmedAt: string | null;
  customerName: string;
  required: boolean;
  repName: string;
  visitId: string;
};

/**
 * Today's double visits for a District Manager to confirm, while a trip claim of his covers today (owner,
 * 28 Nov 2026). The first and the last of the day must be confirmed or the day's allowance is not paid;
 * each press sends where he is. The rep never sees any of it.
 */
export function DmVisitConfirmCard({ onConfirmed, visits }: { onConfirmed?: () => void; visits: DmVisitToConfirmRow[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "error" | "ok"; visitId: string } | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  if (visits.length === 0) return null;
  const requiredOpen = visits.filter((v) => v.required && !v.confirmedAt && !done.has(v.visitId)).length;

  async function confirm(visitId: string) {
    setBusy(visitId);
    setMessage(null);
    try {
      const position = await new Promise<GeolocationPosition | null>((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 12_000,
        });
      });
      const fix = usablePosition(position?.coords.latitude, position?.coords.longitude);
      if (!fix) throw new Error("Your location is required to confirm a double visit. Turn on location and try again.");
      const response = await fetch("/api/outstation/dm-visit-confirmations", {
        body: JSON.stringify({
          accuracyMeters: position?.coords.accuracy ?? null,
          latitude: fix.latitude,
          longitude: fix.longitude,
          visitId,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || `Confirm failed (${response.status})`);
      setDone((prev) => new Set(prev).add(visitId));
      setMessage({ text: "Confirmed, with your location.", tone: "ok", visitId });
      onConfirmed?.();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "The visit could not be confirmed.", tone: "error", visitId });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Confirm your double visits" className="border border-slate-200 bg-white">
      <div className="flex items-start gap-2 border-b border-slate-200 px-3 py-2">
        <Users aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" />
        <div className="min-w-0">
          <p className="text-sm font-black text-slate-900">Confirm your double visits today</p>
          <p className="mt-0.5 text-phx-md leading-relaxed text-slate-600">
            {requiredOpen > 0
              ? "Confirm the first and the last double visit of the day. Without both, today's allowance is not paid. Each confirmation sends your location."
              : "The first and the last double visit of today are confirmed. You can confirm the others too."}
          </p>
        </div>
      </div>
      <ul className="divide-y divide-slate-100">
        {visits.map((visit) => {
          const confirmed = Boolean(visit.confirmedAt) || done.has(visit.visitId);
          const note = message?.visitId === visit.visitId ? message : null;
          return (
            <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" key={visit.visitId}>
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-900">
                  {visit.repName} · {visit.customerName}
                </p>
                <p className="text-phx-md text-slate-600">
                  {cairoShortTime(Date.parse(visit.capturedAt))}
                  {visit.required ? " · first or last of the day, must be confirmed" : ""}
                </p>
                {note ? (
                  <p className={note.tone === "error" ? "text-phx-md text-red-700" : "text-phx-md text-emerald-700"}>{note.text}</p>
                ) : null}
              </div>
              {confirmed ? (
                <span className="inline-flex items-center gap-1 text-phx-md font-bold text-emerald-700">
                  <CheckCircle2 aria-hidden className="h-4 w-4" /> Confirmed
                </span>
              ) : (
                <button
                  className="inline-flex items-center gap-1 bg-slate-900 px-3 py-1.5 text-phx-md font-bold text-white disabled:opacity-60"
                  disabled={busy !== null}
                  onClick={() => void confirm(visit.visitId)}
                  type="button"
                >
                  {busy === visit.visitId ? (
                    <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                  ) : (
                    <MapPin aria-hidden className="h-4 w-4" />
                  )}
                  Confirm
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
