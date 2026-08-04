"use client";

import { Camera, CheckCircle2, Loader2, MapPin, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  drawEvidenceWatermark,
  getCompressedEvidenceCanvasSize,
  resolveReadableLocation,
} from "@/components/outstation/evidence-watermark";
import { formatPhoenixLongDate } from "@/lib/i18n/format";

/** One request still owing its departure photo. */
export type DeparturePhotoPendingRequest = {
  destination: string;
  id: number;
  tripEndDate: string;
  tripStartDate: string;
};

type CaptureState =
  | { kind: "idle" }
  | { kind: "opening"; requestId: number }
  | { kind: "live"; requestId: number }
  | { kind: "saving"; requestId: number }
  | { kind: "done"; message: string; requestId: number }
  | { kind: "error"; message: string; requestId: number };

/**
 * The DEPARTURE photo an employee must capture before leaving the destination (owner request
 * 2026-08-04). Lives on the portal rather than in the submit wizard, because by the time it is
 * taken the request already exists — the employee comes BACK to the app for it.
 *
 * Camera-only. There is deliberately no file picker: the whole value of this photo is that it was
 * taken at the destination, and a gallery upload proves nothing. The server enforces the same
 * rule (the JPEG parser rejects anything that is not a live capture), so removing the button here
 * is a usability choice, not the security boundary.
 */
export function DeparturePhotoCard({
  employeeHrId,
  onCaptured,
  requests,
}: {
  employeeHrId: string;
  onCaptured?: (requestId: number) => void;
  requests: DeparturePhotoPendingRequest[];
}) {
  const [state, setState] = useState<CaptureState>({ kind: "idle" });
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // Releasing the camera on unmount is not tidiness: a live MediaStream keeps the phone's camera
  // light on and drains the battery long after the employee has navigated away.
  useEffect(() => stopCamera, [stopCamera]);

  const openCamera = useCallback(
    async (requestId: number) => {
      setState({ kind: "opening", requestId });
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setState({ kind: "live", requestId });
      } catch {
        setState({
          kind: "error",
          message:
            "Camera access was declined. Allow the camera for this website in your browser settings, reload, and try again.",
          requestId,
        });
      }
    },
    [],
  );

  const capture = useCallback(
    async (request: DeparturePhotoPendingRequest) => {
      const video = videoRef.current;
      if (!video) return;
      setState({ kind: "saving", requestId: request.id });

      try {
        const { height, width } = getCompressedEvidenceCanvasSize(video);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This browser could not prepare the photo.");
        context.drawImage(video, 0, 0, width, height);

        // Position is best-effort, exactly as the server expects: the owner chose to FLAG a
        // departure photo taken far from the trip rather than refuse it, so a device that cannot
        // get a fix must still be able to submit. A failed lookup sends nulls, and the review
        // then records the distance as unknown instead of as zero.
        const position = await new Promise<GeolocationPosition | null>((resolve) => {
          if (!navigator.geolocation) return resolve(null);
          navigator.geolocation.getCurrentPosition(
            (value) => resolve(value),
            () => resolve(null),
            { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 },
          );
        });

        const latitude = position?.coords.latitude ?? null;
        const longitude = position?.coords.longitude ?? null;
        const capturedLocationLabel =
          latitude != null && longitude != null
            ? await resolveReadableLocation(latitude, longitude)
            : "Location unavailable";
        const capturedAt = new Date().toISOString();

        await drawEvidenceWatermark(context, canvas, {
          capturedAt,
          capturedLatitude: latitude ?? 0,
          capturedLocationLabel,
          capturedLongitude: longitude ?? 0,
          employeeHrId,
          label: "Departure photo",
          reference: `Request: ${request.id}`,
        });

        const response = await fetch(`/api/outstation/${request.id}/departure-photo`, {
          body: JSON.stringify({
            imageDataUrl: canvas.toDataURL("image/jpeg", 0.74),
            latitude,
            locationLabel: capturedLocationLabel,
            longitude,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.message || `Upload failed (${response.status})`);

        stopCamera();
        setState({
          kind: "done",
          message:
            typeof payload?.review?.summary === "string"
              ? payload.review.summary
              : "Departure photo saved.",
          requestId: request.id,
        });
        onCaptured?.(request.id);
      } catch (error) {
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "The departure photo could not be saved.",
          requestId: request.id,
        });
      }
    },
    [employeeHrId, onCaptured, stopCamera],
  );

  if (requests.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-lg border border-orange-200 bg-orange-50/60 p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
      <div className="flex items-center gap-2">
        <Camera className="h-4 w-4 text-orange-600" />
        <span className="rounded-md bg-orange-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-700">
          Departure photo needed
        </span>
      </div>
      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-orange-900">
        {requests.length === 1 ? "One expense request is" : `${requests.length} expense requests are`} waiting
        for a departure photo. Capture it before you leave the destination — the request does not reach
        payroll until it is taken.
      </p>

      <div className="mt-4 space-y-3">
        {requests.map((request) => {
          const isActive = state.kind !== "idle" && state.requestId === request.id;
          const done = isActive && state.kind === "done";

          return (
            <div className="rounded-md border border-orange-200 bg-white p-3 sm:p-4" key={request.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900">{request.destination}</p>
                  <p className="mt-0.5 text-xs font-semibold text-slate-500">
                    {formatPhoenixLongDate(request.tripStartDate)} – {formatPhoenixLongDate(request.tripEndDate)}
                  </p>
                </div>
                {!done ? (
                  <button
                    className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-orange-500 px-4 text-xs font-black text-white hover:bg-orange-600 disabled:opacity-60"
                    disabled={isActive && (state.kind === "opening" || state.kind === "saving")}
                    onClick={() => {
                      if (isActive && state.kind === "live") void capture(request);
                      else void openCamera(request.id);
                    }}
                    type="button"
                  >
                    {isActive && (state.kind === "opening" || state.kind === "saving") ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Camera className="h-4 w-4" />
                    )}
                    {isActive && state.kind === "live"
                      ? "Take the photo"
                      : isActive && state.kind === "saving"
                        ? "Saving…"
                        : isActive && state.kind === "opening"
                          ? "Opening camera…"
                          : "Open camera"}
                  </button>
                ) : null}
              </div>

              {isActive && state.kind === "live" ? (
                <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-black">
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a live camera preview has no audio track to caption. */}
                  <video className="max-h-[320px] w-full object-contain" playsInline ref={videoRef} />
                </div>
              ) : null}

              {isActive && state.kind === "done" ? (
                <p className="mt-2 flex items-start gap-2 text-[13px] leading-relaxed text-emerald-700">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  {state.message}
                </p>
              ) : null}

              {isActive && state.kind === "error" ? (
                <p className="mt-2 flex items-start gap-2 text-[13px] leading-relaxed text-rose-700">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  {state.message}
                </p>
              ) : null}

              {!isActive ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
                  <MapPin className="h-3.5 w-3.5" />
                  Your location is recorded with the photo.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
