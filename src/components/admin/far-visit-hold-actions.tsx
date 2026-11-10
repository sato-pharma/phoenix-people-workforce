"use client";

/**
 * Phoenix CRM — the SFE's three presses on a visit held for him (owner, 2026-11-10): Approve (it counts),
 * Refuse (it never counts), and — when the rep's spot looks like the customer's real door — Move the place
 * there, through the same move every other place move uses (`/api/phoenix-crm/list/places/move`, a written
 * reason, the Super Admin and the SFE Manager only).
 *
 * 🔴 It lives under `components/admin`, never `components/phoenix-crm`: that folder is the rep-facing
 * surface the blind half sweeps, and this page is drawn only for the Super Admin and the SFE Manager.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { crmPost } from "@/components/phoenix-crm/api";
import {
  phxButtonApproveClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxFieldMessageClassName,
  phxHintClassName,
  phxLabelClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";

const MOVE_REASON_MIN = 10;

export function FarVisitHoldActions({
  visitId,
  seatId,
  isTest,
  placeId,
  spot,
}: {
  visitId: string;
  seatId: string;
  isTest: boolean;
  placeId: string | null;
  spot: { lat: number; lon: number } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [reason, setReason] = useState("");
  const [moved, setMoved] = useState(false);

  async function decide(decision: "approve" | "refuse") {
    setBusy(true);
    setProblem(null);
    try {
      await crmPost("/api/phoenix-crm/far-visit-holds/decide", { visitId, decision }, "decision");
      router.refresh();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not save the decision.");
    } finally {
      setBusy(false);
    }
  }

  async function movePlace() {
    if (!placeId || !spot) return;
    setBusy(true);
    setProblem(null);
    try {
      await crmPost(
        "/api/phoenix-crm/list/places/move",
        {
          seatId,
          test: isTest,
          placeId,
          target: "coordinates",
          coordinates: `${spot.lat.toFixed(7)}, ${spot.lon.toFixed(7)}`,
          reason: reason.trim(),
        },
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
      <div className="flex flex-wrap gap-2">
        <button className={phxButtonApproveClassName} disabled={busy} onClick={() => void decide("approve")} type="button">
          Approve
        </button>
        <button className={phxButtonDangerClassName} disabled={busy} onClick={() => void decide("refuse")} type="button">
          Refuse
        </button>
        {placeId && spot && !moved ? (
          <button className={phxButtonGhostClassName} disabled={busy} onClick={() => setMoving((open) => !open)} type="button">
            Move the place here
          </button>
        ) : null}
      </div>
      {moved ? <p className="text-xs font-semibold text-slate-700">The place now sits where the rep stood. Their next visit there is measured against it.</p> : null}
      {moving ? (
        <div className="space-y-2">
          <label className={phxLabelClassName} htmlFor={`move-reason-${visitId}`}>
            Why the place moves
          </label>
          <textarea
            className={phxTextareaClassName}
            id={`move-reason-${visitId}`}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            value={reason}
          />
          <span className={phxHintClassName}>At least {MOVE_REASON_MIN} characters. It is kept with the place's history.</span>
          <button className={phxButtonGhostClassName} disabled={busy || reason.trim().length < MOVE_REASON_MIN} onClick={() => void movePlace()} type="button">
            Move it
          </button>
        </div>
      ) : null}
      {problem ? <span className={phxFieldMessageClassName}>{problem}</span> : null}
    </div>
  );
}
