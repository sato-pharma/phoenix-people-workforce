"use client";

import { ExternalLink, ImageOff, MapPinOff, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { formatDateTimeValue } from "@/lib/i18n/format";
import { classifyPhotoFrame, measureImageFrame } from "@/lib/outstation/photo-frame";
import { displayPlace } from "@/lib/outstation/place-label";
import type { ApproverTripPhoto } from "@/lib/outstation/trip-evidence-photos";

/**
 * The arrival and departure photos side by side, full width, as the approver decides on them.
 *
 * One component for both approver screens (Expense Approvals and the Expense Center panel), so
 * the two cannot drift. Each photo is fitted, never cropped: the approver needs the whole frame,
 * and a tap opens it full screen to zoom. The departure review is the one stored when the photo
 * was taken (see src/lib/outstation/trip-evidence-photos.ts); a flag asks for a look and never
 * blocks payment, which is the owner's rule and is said on screen.
 */
export function TripEvidencePhotos({
  photos,
  subject,
}: {
  photos: readonly ApproverTripPhoto[];
  /** Whose trip it is, for the full-screen caption. A name, never a code. */
  subject?: string | null;
}) {
  return (
    <div className="grid w-full gap-3 sm:grid-cols-2">
      {photos.map((photo) => (
        <TripEvidencePhoto key={photo.kind} photo={photo} subject={subject} />
      ))}
    </div>
  );
}

/**
 * One photo, with the one thing the stored review cannot tell the approver: whether the frame
 * carries a picture at all.
 *
 * The gate checks a photo EXISTS, never that it shows anything, so a lens-covered capture passes
 * it and the approver is shown a black rectangle with the Phoenix overlay on it — indistinguishable
 * from a genuinely dark room (2 of 60 photos on production, measured 2026-09-29). Measured HERE,
 * from the image the approver is already looking at: no server work, no second fetch, and — THE CRM
 * GOLDEN RULE #1 — nothing whatever reaches the rep, who is never made to feel checked.
 */
function TripEvidencePhoto({
  photo,
  subject,
}: {
  photo: ApproverTripPhoto;
  subject?: string | null;
}) {
  const [frame, setFrame] = useState<{ maxLuminance: number | null; meanLuminance: number | null }>({
    maxLuminance: null,
    meanLuminance: null,
  });
  const blankFrame = classifyPhotoFrame(frame);

  const capturedAt = photo.capturedAt ? formatDateTimeValue(photo.capturedAt) : "";
  const caption = subject ? `${photo.label} · ${subject}` : photo.label;
  return (
          <figure className="m-0 flex min-w-0 flex-col border border-slate-200 bg-white">
            {photo.url ? (
              // ↺ ↻ turn a photo taken sideways, for the view only (owner, 2026-11-07). The stored photo is never changed.
              <div className="relative h-80 w-full bg-slate-900" data-turnable-photo>
                <ZoomablePhoto
                  alt={subject ? `${photo.label} for ${subject}` : photo.label}
                  caption={caption}
                  className="block h-full w-full object-contain"
                  // Measured once, when the browser has the pixels. A failure to read leaves the
                  // nulls in place, which classifies as "unknown" and says nothing.
                  onLoad={(event) => setFrame(measureImageFrame(event.currentTarget))}
                  rotatable
                  src={photo.url}
                />
              </div>
            ) : (
              <div className="flex min-h-32 items-center justify-center gap-2 bg-slate-50 p-4 text-center text-xs font-semibold text-slate-500">
                <ImageOff className="h-4 w-4 shrink-0" />
                <span>{photo.missingNote}</span>
              </div>
            )}
            <figcaption className="space-y-1.5 border-t border-slate-200 p-3">
              <p className="text-phx-xs font-black uppercase tracking-wide text-slate-600">{photo.label}</p>
              {blankFrame.verdict === "no-image" && blankFrame.headline ? (
                <p className="flex items-start gap-1.5 break-words border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5 text-xs font-semibold leading-relaxed text-amber-900">
                  <ImageOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0">{blankFrame.headline}</span>
                </p>
              ) : null}
              {/* Everything the photo carries, each fact labelled (owner, 2026-11-07: "photo
                  captured time at arrival and departure … any information or data you have"). */}
              {capturedAt ? (
                <p className="text-xs font-semibold text-slate-900">
                  <span className="text-phx-3xs font-black uppercase tracking-wide text-slate-400">Captured </span>
                  {capturedAt}
                </p>
              ) : null}
              {photo.url && !photo.sourceNote ? (
                <p className="text-xs text-slate-600">Captured with the live camera.</p>
              ) : null}
              {photo.locationLabel ? (
                <p className="break-words text-xs text-slate-600" dir="auto" title={photo.locationLabel}>
                  {displayPlace(photo.locationLabel)}
                </p>
              ) : null}
              {/* The point itself, one click from Google Maps (owner's review, 2026-11-07). */}
              {photo.latitude !== null && photo.longitude !== null ? (
                <p className="text-xs tabular-nums text-slate-500">
                  <span className="text-phx-3xs font-black uppercase tracking-wide text-slate-400">GPS </span>
                  <a
                    className="text-orange-700 underline-offset-2 hover:underline"
                    data-photo-gps-link
                    href={`https://www.google.com/maps/search/?api=1&query=${photo.latitude.toFixed(6)},${photo.longitude.toFixed(6)}`}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {photo.latitude.toFixed(5)}, {photo.longitude.toFixed(5)}
                  </a>
                </p>
              ) : null}
              {photo.gpsMissingReason ? (
                <p className="flex items-start gap-1.5 break-words text-xs font-semibold leading-relaxed text-amber-800">
                  <MapPinOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0">{photo.gpsMissingReason}</span>
                </p>
              ) : null}
              {photo.refusedTries.map((refusedTry, index) => (
                <p
                  className="flex items-start gap-1.5 break-words text-xs font-semibold leading-relaxed text-amber-800"
                  key={`${index}-${refusedTry.at}`}
                >
                  <MapPinOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0">
                    Tried {formatDateTimeValue(refusedTry.at)}: {refusedTry.text}
                  </span>
                </p>
              ))}
              {photo.sourceNote ? <p className="text-xs font-semibold text-amber-800">{photo.sourceNote}</p> : null}
              {photo.review ? (
                <p
                  className={
                    photo.isFlagged
                      ? "flex items-start gap-1.5 text-xs leading-relaxed text-amber-800"
                      : "text-xs leading-relaxed text-slate-600"
                  }
                >
                  {photo.isFlagged ? <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}
                  <span>{photo.review}</span>
                </p>
              ) : null}
              {photo.isFlagged ? (
                <p className="text-xs font-semibold text-amber-800">Flagged for a look. It never blocks payment.</p>
              ) : null}
              {photo.retakeCount > 0 ? (
                <p className="text-xs text-slate-500">
                  Retaken {photo.retakeCount} {photo.retakeCount === 1 ? "time" : "times"}. Every earlier version is
                  kept on file.
                </p>
              ) : null}
              {photo.url ? (
                <a
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-orange-700 hover:text-orange-800"
                  href={photo.url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open image
                </a>
              ) : null}
            </figcaption>
          </figure>
  );
}
