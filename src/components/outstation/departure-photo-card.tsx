"use client";

import { Camera, CheckCircle2, Loader2, MapPin, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  drawEvidenceWatermark,
  getCompressedEvidenceCanvasSize,
  resolveEvidenceLocationStamp,
} from "@/components/outstation/evidence-watermark";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { usablePosition } from "@/lib/outstation/captured-coordinates";
import {
  departureRefusalReasonFromBrowserErrorCode,
  type DepartureLocationRefusalReason,
} from "@/lib/outstation/departure-location-refusals";
import { DEPARTURE_PHOTO_LOCATION_REQUIRED_MESSAGE } from "@/lib/outstation/departure-photo-location";

/** One request still owing its departure photo. */
export type DeparturePhotoPendingRequest = {
  destination: string;
  id: number;
  tripEndDate: string;
  tripStartDate: string;
};

/**
 * Tell Phoenix a departure photo was refused for having no location, and why, so the approver sees
 * the try (owner, 2026-09-18: "Record refused tries"). Best effort: the employee is reading the
 * refusal either way, and a failed report must never replace it with another error.
 */
async function reportRefusedTry(requestId: number, reason: DepartureLocationRefusalReason) {
  try {
    await fetch(`/api/outstation/${requestId}/departure-photo/location-refusal`, {
      body: JSON.stringify({ reason }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  } catch {
    // Nothing to do: the refusal below is what the employee needs.
  }
}

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
  mode = "capture",
  onCaptured,
  requests,
}: {
  employeeHrId: string;
  /**
   * "retake" changes the WORDS only. The capture, the watermark, the location refusal and the
   * server contract stay identical — a retake is a capture — because the moment the two paths
   * diverge is the moment one of them stops matching what the server actually accepts.
   */
  mode?: "capture" | "retake";
  onCaptured?: (requestId: number) => void;
  requests: DeparturePhotoPendingRequest[];
}) {
  const isRetake = mode === "retake";
  const [state, setState] = useState<CaptureState>({ kind: "idle" });
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /**
   * True only once the element is actually producing frames.
   *
   * Without this the shutter is live the instant the preview mounts, and a tap in that window
   * draws a video with videoWidth 0 — which getCompressedEvidenceCanvasSize falls back to 1280x720
   * for, producing a perfectly valid, perfectly black 1280x720 JPEG. A black photo that uploads
   * successfully is worse than an error: it satisfies the gate and nobody looks again.
   */
  const [videoReady, setVideoReady] = useState(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setVideoReady(false);
  }, []);

  // Releasing the camera on unmount is not tidiness: a live MediaStream keeps the phone's camera
  // light on and drains the battery long after the employee has navigated away.
  useEffect(() => stopCamera, [stopCamera]);

  // Attaching the stream must happen HERE, not in openCamera.
  //
  // The <video> is only rendered while state.kind === "live", so at the moment openCamera has the
  // MediaStream in hand the element does not exist yet and videoRef.current is null. The old code
  // guarded that with `if (videoRef.current)` and silently skipped the assignment, so the element
  // mounted a frame later with no source — a black rectangle, which capture() then drew onto the
  // canvas and uploaded as a black photo. The guard hid the bug instead of reporting it.
  //
  // This effect runs after the element is in the DOM, which is the only point at which the stream
  // can be attached at all.
  useEffect(() => {
    if (state.kind !== "live") return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    // Autoplay can still be refused; the readiness gate below keeps a refused play from being
    // captured as a black frame rather than letting it through silently.
    void video.play().catch(() => undefined);
  }, [state]);

  const openCamera = useCallback(
    async (requestId: number) => {
      setVideoReady(false);
      setState({ kind: "opening", requestId });
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
        });
        streamRef.current = stream;
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

      // Refuses rather than captures. A zero-sized video is a preview that has not produced a
      // frame yet, and capturing it yields a black JPEG that passes every check downstream — the
      // gate is satisfied, the money moves, and the evidence is a black rectangle.
      if (!video.videoWidth || !video.videoHeight) {
        setState({
          kind: "error",
          message:
            "The camera has not started yet — the preview is still blank. Wait for the picture to appear, then take the photo.",
          requestId: request.id,
        });
        return;
      }

      setState({ kind: "saving", requestId: request.id });

      try {
        const { height, width } = getCompressedEvidenceCanvasSize(video);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This browser could not prepare the photo.");
        context.drawImage(video, 0, 0, width, height);

        // No location, no photo (owner ruling, 2026-09-18). A denied permission, location switched
        // off and a fix that does not arrive in 12 seconds all end here, before anything is stamped
        // or sent. The server refuses the same photo (departure-photo-location.ts); saying so first
        // saves an upload the employee would only see refused. A far or fuzzy fix is still sent,
        // and flagged rather than blocked.
        // The browser's own error code is the cause the approver reads for a refused try.
        const located = await new Promise<{
          position: GeolocationPosition | null;
          reason: DepartureLocationRefusalReason | null;
        }>((resolve) => {
          if (!navigator.geolocation) return resolve({ position: null, reason: "unsupported" });
          navigator.geolocation.getCurrentPosition(
            (value) => resolve({ position: value, reason: null }),
            (error) => resolve({ position: null, reason: departureRefusalReasonFromBrowserErrorCode(error.code) }),
            { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 },
          );
        });
        const position = located.position;

        const fix = usablePosition(position?.coords.latitude, position?.coords.longitude);
        if (!fix) await reportRefusedTry(request.id, located.reason ?? "position_unavailable");
        if (!fix) throw new Error(DEPARTURE_PHOTO_LOCATION_REQUIRED_MESSAGE);
        const { latitude, longitude } = fix;
        const location = await resolveEvidenceLocationStamp(
          "/api/outstation/reverse-geocode",
          latitude,
          longitude,
          position?.coords.accuracy ?? null,
        );
        const capturedLocationLabel = location.label;
        const capturedAt = new Date().toISOString();

        await drawEvidenceWatermark(context, canvas, {
          capturedAt,
          employeeHrId,
          label: "Departure photo",
          locationLines: location.lines,
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
    <section className="overflow-hidden border border-orange-200 bg-orange-50/60 p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <Camera className="h-4 w-4 text-orange-600" />
        <span className="bg-orange-100 px-2 py-1 text-phx-2xs font-bold uppercase tracking-wider text-orange-700">
          {isRetake ? "Retake the departure photo" : "Departure photo needed"}
        </span>
      </div>
      <p className="mt-2 max-w-3xl text-phx-md leading-relaxed text-orange-900">
        {isRetake
          ? "Take it again while you are still at the destination. The photo you replace is kept and stays visible to your approver, so a retake never hides anything — it just corrects it."
          : `${requests.length === 1 ? "One expense request is" : `${requests.length} expense requests are`} waiting for a departure photo. Capture it before you leave the destination — the request does not reach payroll until it is taken.`}
      </p>

      <div className="mt-4 space-y-3">
        {requests.map((request) => {
          const isActive = state.kind !== "idle" && state.requestId === request.id;
          const done = isActive && state.kind === "done";

          return (
            <div className="border border-orange-200 bg-white p-3 sm:p-4" key={request.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900">{request.destination}</p>
                  <p className="mt-0.5 text-xs font-semibold text-slate-500">
                    {formatPhoenixLongDate(request.tripStartDate)} – {formatPhoenixLongDate(request.tripEndDate)}
                  </p>
                </div>
                {!done ? (
                  <button
                    className="inline-flex min-h-11 items-center gap-2 bg-orange-500 px-4 text-xs font-black text-white hover:bg-orange-600 disabled:opacity-60"
                    disabled={
                      (isActive && (state.kind === "opening" || state.kind === "saving")) ||
                      // The shutter stays dead until the preview is genuinely producing frames.
                      // Disabling it is the difference between a retake and a black photo that
                      // quietly satisfies the evidence gate.
                      (isActive && state.kind === "live" && !videoReady)
                    }
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
                      ? videoReady
                        ? "Take the photo"
                        : "Starting the camera…"
                      : isActive && state.kind === "saving"
                        ? "Saving…"
                        : isActive && state.kind === "opening"
                          ? "Opening camera…"
                          : isRetake
                            ? "Retake photo"
                            : "Open camera"}
                  </button>
                ) : null}
              </div>

              {isActive && state.kind === "live" ? (
                <div className="mt-3 overflow-hidden border border-slate-200 bg-black">
                  {/* muted is required, not cosmetic: some browsers refuse to autoplay an
                      unmuted element, and a refused play is exactly how this ends up black. */}
                  <video
                    className="max-h-[320px] w-full object-contain"
                    muted
                    onCanPlay={() => setVideoReady(true)}
                    onLoadedMetadata={() => setVideoReady(true)}
                    onPlaying={() => setVideoReady(true)}
                    playsInline
                    ref={videoRef}
                  />
                  {!videoReady ? (
                    <p className="bg-slate-900 px-3 py-2 text-center text-phx-xs font-bold text-white">
                      Starting the camera…
                    </p>
                  ) : null}
                </div>
              ) : null}

              {isActive && state.kind === "done" ? (
                <p className="mt-2 flex items-start gap-2 text-phx-md leading-relaxed text-emerald-700">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  {state.message}
                </p>
              ) : null}

              {isActive && state.kind === "error" ? (
                <p className="mt-2 flex items-start gap-2 text-phx-md leading-relaxed text-rose-700">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  {state.message}
                </p>
              ) : null}

              {!isActive ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
                  <MapPin className="h-3.5 w-3.5" />
                  Your location is recorded with the photo. Without it, the photo is refused.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
