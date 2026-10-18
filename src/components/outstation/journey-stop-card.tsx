"use client";

import { Camera, CheckCircle2, Loader2, MapPin, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  drawEvidenceWatermark,
  getCompressedEvidenceCanvasSize,
  resolveEvidenceLocationStamp,
} from "@/components/outstation/evidence-watermark";
import { JOURNEY_STOP_LOCATION_REQUIRED_MESSAGE } from "@/lib/outstation/journey-stop-location";
import { usablePosition } from "@/lib/outstation/captured-coordinates";

type CaptureState =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "live" }
  | { kind: "saving" }
  | { kind: "done"; flagged: boolean; message: string }
  | { kind: "error"; message: string };

/**
 * A STOP on a car trip — the next place of a chained journey (owner rule, 2026-10-18: Minya →
 * Fayoum → Beni Suef → Minya is paid drive by drive when each drive crosses into another
 * governorate more than 40 km away; chained-journey.ts prices it).
 *
 * The same camera as the departure photo, deliberately: camera only, no file picker, a fresh GPS
 * fix taken at the shutter (`maximumAge: 0`), the watermark burnt in, and no photo sent without a
 * position. The server enforces every one of those again — this card is the usability layer, never
 * the security boundary. The place, its governorate and every distance come from the photo's
 * position on the server; nothing here is typed.
 */
export function JourneyStopCard({
  employeeHrId,
  nextStopNumber,
  onSaved,
  requestId,
}: {
  employeeHrId: string;
  nextStopNumber: number;
  onSaved?: (requestId: number) => void;
  requestId: number;
}) {
  const [state, setState] = useState<CaptureState>({ kind: "idle" });
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The shutter stays dead until the preview produces frames — a tap before that draws a black
  // 1280x720 JPEG that would upload as valid evidence (the departure card's 2026-08 lesson).
  const [videoReady, setVideoReady] = useState(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setVideoReady(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  // The <video> exists only while live, so the stream is attached after it mounts, never before.
  useEffect(() => {
    if (state.kind !== "live") return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    void video.play().catch(() => undefined);
  }, [state]);

  const openCamera = useCallback(async () => {
    setVideoReady(false);
    setState({ kind: "opening" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
      });
      streamRef.current = stream;
      setState({ kind: "live" });
    } catch {
      setState({
        kind: "error",
        message:
          "Camera access was declined. Allow the camera for this website in your browser settings, reload, and try again.",
      });
    }
  }, []);

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.videoWidth || !video.videoHeight) {
      setState({
        kind: "error",
        message:
          "The camera has not started yet — the preview is still blank. Wait for the picture to appear, then take the photo.",
      });
      return;
    }

    setState({ kind: "saving" });

    try {
      const { height, width } = getCompressedEvidenceCanvasSize(video);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not prepare the photo.");
      context.drawImage(video, 0, 0, width, height);

      // No location, no stop: the place and every distance come from this position.
      const position = await new Promise<GeolocationPosition | null>((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (value) => resolve(value),
          () => resolve(null),
          { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 },
        );
      });
      const fix = usablePosition(position?.coords.latitude, position?.coords.longitude);
      if (!fix) throw new Error(JOURNEY_STOP_LOCATION_REQUIRED_MESSAGE);
      const { latitude, longitude } = fix;
      const accuracyMeters = position?.coords.accuracy ?? null;
      const location = await resolveEvidenceLocationStamp(
        "/api/outstation/reverse-geocode",
        latitude,
        longitude,
        accuracyMeters,
      );

      await drawEvidenceWatermark(context, canvas, {
        capturedAt: new Date().toISOString(),
        employeeHrId,
        label: `Stop ${nextStopNumber}`,
        locationLines: location.lines,
        reference: `Request: ${requestId}`,
      });

      const response = await fetch(`/api/outstation/${requestId}/journey-stop`, {
        body: JSON.stringify({
          accuracyMeters,
          imageDataUrl: canvas.toDataURL("image/jpeg", 0.74),
          latitude,
          locationLabel: location.label,
          longitude,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || `Upload failed (${response.status})`);

      stopCamera();
      const place = typeof payload?.stopGovernorate === "string" ? ` in ${payload.stopGovernorate}` : "";
      setState({
        flagged: payload?.flagged === true,
        kind: "done",
        message: `Stop ${payload?.stopNumber ?? nextStopNumber}${place} saved. ${
          typeof payload?.modeReason === "string" ? payload.modeReason : ""
        }`.trim(),
      });
      onSaved?.(requestId);
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "The stop could not be saved.",
      });
    }
  }, [employeeHrId, nextStopNumber, onSaved, requestId, stopCamera]);

  const busy = state.kind === "opening" || state.kind === "saving";

  return (
    <section className="border border-sky-200 bg-sky-50/60 p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <MapPin className="h-4 w-4 text-sky-700" />
        <span className="bg-sky-100 px-2 py-1 text-phx-2xs font-bold uppercase tracking-wider text-sky-800">
          Add stop {nextStopNumber}
        </span>
      </div>
      <p className="mt-2 max-w-3xl text-phx-md leading-relaxed text-sky-950">
        Moving on to work in another governorate before you go home? Take this photo when you get
        there. A drive into another governorate more than 40 km away is paid one way, and so is the
        drive home from your last stop. A stop in the same governorate is recorded but changes
        nothing.
      </p>

      {state.kind !== "done" ? (
        <button
          className="mt-3 inline-flex min-h-11 items-center gap-2 bg-sky-700 px-4 text-xs font-black text-white hover:bg-sky-800 disabled:opacity-60"
          disabled={busy || (state.kind === "live" && !videoReady)}
          onClick={() => {
            if (state.kind === "live") void capture();
            else void openCamera();
          }}
          type="button"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
          {state.kind === "live"
            ? videoReady
              ? "Take the photo"
              : "Starting the camera…"
            : state.kind === "saving"
              ? "Saving…"
              : state.kind === "opening"
                ? "Opening camera…"
                : "Open camera"}
        </button>
      ) : null}

      {state.kind === "live" ? (
        <div className="mt-3 border border-slate-200 bg-black">
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

      {state.kind === "done" ? (
        <div className="mt-3 space-y-1.5">
          <p className="flex items-start gap-2 text-phx-md leading-relaxed text-emerald-700">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            {state.message}
          </p>
          {state.flagged ? (
            <p className="flex items-start gap-2 text-phx-md leading-relaxed text-amber-800">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              Your approver will review this journey before it is paid.
            </p>
          ) : null}
        </div>
      ) : null}

      {state.kind === "error" ? (
        <p className="mt-2 flex items-start gap-2 text-phx-md leading-relaxed text-rose-700">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {state.message}
        </p>
      ) : null}

      {state.kind === "idle" ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
          <MapPin className="h-3.5 w-3.5" />
          Your location is recorded with the photo. Without it, the stop is refused.
        </p>
      ) : null}
    </section>
  );
}
