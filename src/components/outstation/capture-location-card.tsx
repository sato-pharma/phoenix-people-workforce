"use client";

import { MapPin } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type { OutstationCaptureResult } from "@/lib/outstation/types";

function statusTone(status: string | null | undefined) {
  const normalized = String(status ?? "").toLowerCase();
  if (normalized === "eligible") return "bg-emerald-50 text-emerald-700 ring-emerald-100";
  if (normalized === "not_eligible") return "bg-red-50 text-red-700 ring-red-100";
  return "bg-amber-50 text-amber-700 ring-amber-100";
}

function Info({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}

export function CaptureLocationCard({
  captured,
  isCapturing,
  onCapture,
}: {
  captured: OutstationCaptureResult | null;
  isCapturing: boolean;
  onCapture: () => void;
}) {
  return (
    <Card className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
            Step 1
          </p>
          <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-slate-950">
            Capture Current Location
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-600">
            The system captures your live GPS destination and compares it against your registered residence. You do not type the origin yourself.
          </p>
        </div>
        <Button
          className="min-h-12 rounded-2xl bg-orange-500 px-5 text-white hover:bg-orange-600"
          disabled={isCapturing}
          onClick={onCapture}
          type="button"
        >
          {isCapturing ? <LoadingSpinner className="text-white" /> : <MapPin className="h-4 w-4" />}
          {isCapturing ? "Capturing..." : "Capture My Location"}
        </Button>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Info
          label="Eligibility"
          value={captured ? captured.eligibilityStatus.replace(/_/g, " ") : "Not captured"}
        />
        <Info
          label="Accuracy"
          value={captured ? `${Math.round(captured.capturedAccuracyMeters)} m` : "Not captured"}
        />
        <Info
          label="Distance"
          value={
            captured?.distanceFromResidenceKm != null
              ? `${captured.distanceFromResidenceKm.toFixed(2)} KM`
              : "Not calculated"
          }
        />
        <Info
          label="Destination"
          value={captured?.toLabel ?? "Not captured"}
        />
      </div>

      {captured ? (
        <div className="mt-4">
          <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.14em] ring-1 ${statusTone(captured.eligibilityStatus)}`}>
            {captured.eligibilityStatus.replace(/_/g, " ")}
          </span>
          <p className="mt-3 text-sm leading-6 text-slate-600">{captured.eligibilityReason}</p>
        </div>
      ) : null}
    </Card>
  );
}
