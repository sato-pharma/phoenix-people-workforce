"use client";

import { ExternalLink, ImageOff, MapPinOff, TriangleAlert } from "lucide-react";

import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { formatDateTimeValue } from "@/lib/i18n/format";
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
      {photos.map((photo) => {
        const capturedAt = photo.capturedAt ? formatDateTimeValue(photo.capturedAt) : "";
        const caption = subject ? `${photo.label} · ${subject}` : photo.label;
        return (
          <figure className="m-0 flex min-w-0 flex-col border border-slate-200 bg-white" key={photo.kind}>
            {photo.url ? (
              <ZoomablePhoto
                alt={subject ? `${photo.label} for ${subject}` : photo.label}
                caption={caption}
                className="block max-h-80 w-full bg-slate-900 object-contain"
                src={photo.url}
              />
            ) : (
              <div className="flex min-h-32 items-center justify-center gap-2 bg-slate-50 p-4 text-center text-xs font-semibold text-slate-500">
                <ImageOff className="h-4 w-4 shrink-0" />
                <span>{photo.missingNote}</span>
              </div>
            )}
            <figcaption className="space-y-1.5 border-t border-slate-200 p-3">
              <p className="text-phx-xs font-black uppercase tracking-wide text-slate-600">{photo.label}</p>
              {capturedAt ? <p className="text-xs font-semibold text-slate-900">{capturedAt}</p> : null}
              {photo.locationLabel ? (
                <p className="break-words text-xs text-slate-600" dir="auto">
                  {photo.locationLabel}
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
      })}
    </div>
  );
}
