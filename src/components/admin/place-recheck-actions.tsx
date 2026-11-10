"use client";

/**
 * Phoenix CRM — the one press on a place worth a second look (owner, 2026-11-11): Move the place to the
 * spot the readings point at, through the same move every other place move uses
 * (`/api/phoenix-crm/list/places/move`, a written reason, the Super Admin and the SFE Manager only). The
 * route and the service check who is asking; this only offers the press.
 *
 * 🔴 It lives under `components/admin`, never `components/phoenix-crm`: that folder is the rep-facing
 * surface the blind half sweeps, and this list is drawn only for the Super Admin and the SFE Manager.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { crmPost } from "@/components/phoenix-crm/api";
import { phxButtonGhostClassName, phxFieldMessageClassName, phxHintClassName, phxLabelClassName, phxTextareaClassName } from "@/components/ui/form-tokens";

const MOVE_REASON_MIN = 10;

export function PlaceRecheckActions({ placeId, seatId, spot }: { placeId: string; seatId: string; spot: { lat: number; lon: number } | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [reason, setReason] = useState("");
  const [moved, setMoved] = useState(false);

  if (!spot) {
    return <p className="text-xs leading-5 text-slate-500">The readings do not point at one spot. Open the customer in the List and move the place from there if it is wrong.</p>;
  }

  async function movePlace() {
    if (!spot) return;
    setBusy(true);
    setProblem(null);
    try {
      await crmPost(
        "/api/phoenix-crm/list/places/move",
        // `test: false` by construction: the list reads real places only (`is_test = false`, places-to-recheck.ts).
        { seatId, test: false, placeId, target: "coordinates", coordinates: `${spot.lat.toFixed(7)}, ${spot.lon.toFixed(7)}`, reason: reason.trim() },
        "moved",
      );
      setMoved(true);
      setMoving(false);
      router.refresh();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not move the place.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {moved ? (
        <p className="text-xs font-semibold text-slate-700">The place now sits at marker 1. Every visit to this customer is measured against it.</p>
      ) : (
        <button className={phxButtonGhostClassName} disabled={busy} onClick={() => setMoving((open) => !open)} type="button">
          Move the place to marker 1
        </button>
      )}
      {moving ? (
        <div className="space-y-2">
          <label className={phxLabelClassName} htmlFor={`recheck-reason-${placeId}`}>
            Why the place moves
          </label>
          <textarea
            className={phxTextareaClassName}
            id={`recheck-reason-${placeId}`}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            value={reason}
          />
          <span className={phxHintClassName}>At least {MOVE_REASON_MIN} characters. It is kept with the place&apos;s history.</span>
          <button className={phxButtonGhostClassName} disabled={busy || reason.trim().length < MOVE_REASON_MIN} onClick={() => void movePlace()} type="button">
            Move it
          </button>
        </div>
      ) : null}
      {problem ? <span className={phxFieldMessageClassName}>{problem}</span> : null}
    </div>
  );
}
