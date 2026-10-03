"use client";

/**
 * Phoenix CRM — the Capture location button: the place's location read by GPS on its own, apart from
 * the photo.
 *
 * Owner, 2026-09-30: "a live capture photo with its own location and a capture location button to
 * capture the same location twice, once by photo and the other by GPS". The photo carries the reading
 * its camera took; this button takes the second one, fresh (`maximumAge: 0`, never the reading the
 * camera already holds). The server keeps both and fixes the place on the photo's, falling back to
 * this one only when the photo has none.
 *
 * The rep reads "Location captured" and nothing else — no accuracy, no distance between the two
 * readings, nothing that says one is judged against the other (Golden Rule #1). The measurements are
 * the Super Admin's and the SFE Manager's, on the place-move screen.
 */

import { useState } from "react";
import { BROWSER_PLACEHOLDER } from "@/lib/phoenix-crm/browser-name";
import { LocateFixed, RotateCcw } from "lucide-react";

import { CrmButton, CrmNote } from "@/components/phoenix-crm/ui";

/** The Capture-location reading: the place's pin, as the server's `lat`/`lon`/`accuracyMeters` read it. */
export type CapturedPin = {
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  capturedAt: string;
};

export function CaptureLocation({
  disabled = false,
  onChange,
  value,
}: {
  disabled?: boolean;
  onChange: (pin: CapturedPin | null) => void;
  value: CapturedPin | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function capture() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("This phone cannot give a location. Open Phoenix in Chrome or Safari.");
      return;
    }
    setError(null);
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setBusy(false);
        onChange({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
          capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
        });
      },
      (positionError) => {
        setBusy(false);
        setError(
          positionError.code === positionError.PERMISSION_DENIED
            ? `Location is blocked for ${BROWSER_PLACEHOLDER}. Allow location for this site in its settings, then press Capture location again.`
            : "The location did not come. Stand outside or near a window, then press Capture location again.",
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
  }

  return (
    <div className="grid min-w-0 gap-2">
      {value ? (
        <>
          <p className="flex min-w-0 items-start gap-2 text-sm font-bold text-emerald-700">
            <LocateFixed aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">Location captured</span>
          </p>
          <CrmButton busy={busy} disabled={disabled} onClick={capture} size="sm" variant="secondary">
            {busy ? null : <RotateCcw aria-hidden className="h-4 w-4" />}
            Capture again
          </CrmButton>
        </>
      ) : (
        <>
          <p className="text-sm font-medium leading-6 text-slate-600">Stand at the clinic and press Capture location.</p>
          <CrmButton busy={busy} disabled={disabled} onClick={capture} variant="primary">
            {busy ? null : <LocateFixed aria-hidden className="h-4 w-4" />}
            {busy ? "Capturing the location" : "Capture location"}
          </CrmButton>
        </>
      )}
      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
    </div>
  );
}
