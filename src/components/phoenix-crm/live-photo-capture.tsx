"use client";

/**
 * Phoenix CRM — the live photo of a clinic's sign or door, with the location taken on the spot.
 *
 * The owner's rule for a customer (2026-09-16): a live photo, the location captured at the place,
 * and the timings. The same capture serves every visit. So there is no gallery button — only the
 * camera — and one Start opens the camera and the location together, because a photo without a
 * location proves nothing about a place.
 *
 * Same evidence as every other Phoenix live photo (direct-order storefronts, marketing captures):
 * the time, the street address, the Phoenix brick, area and region and the coordinates are burned
 * into the picture, worded by the shared stamp helpers.
 *
 * The upload slot is asked for when the photo is taken, and the phone's clock is read at that same
 * moment, so the server compares two clocks read seconds apart: a photo taken in a basement with no
 * signal and uploaded twenty minutes later is not marked "phone clock off". A failed upload keeps the
 * photo on the phone and sends it again to the same slot.
 */

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Camera, LoaderCircle, LocateFixed, RotateCcw, UploadCloud, X } from "lucide-react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { CrmButton, CrmNote } from "@/components/phoenix-crm/ui";
import {
  buildEvidenceStampLines,
  fetchEvidenceLocation,
  getCompressedEvidenceCanvasSize,
  readEvidenceLocationStamp,
  wrapWatermarkText,
} from "@/components/outstation/evidence-watermark";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { formatDistance } from "@/lib/phoenix-crm/geo";
import type { PhotoSlot } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/** The bucket takes 2 MB; a 1280-pixel JPEG is usually a few hundred KB. */
const MAX_UPLOAD_BYTES = 1_900_000;
const LOCATION_ENDPOINT = "/api/phoenix-crm/location";
/** A newer reading replaces a sharper one once the sharper one is this old (the person may have moved). */
const FIX_STALE_MS = 15_000;

export type CapturedPhoto = {
  path: string;
  previewUrl: string;
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  /** The phone's clock when the photo was sent, compared by the server with its own. */
  deviceCapturedAt: string;
  /** The street address the location resolved to, when it resolved. */
  address: string | null;
  /** The part of town the address names (e.g. "Faisal"), offered as the place's zone. */
  zone: string | null;
  locationLabel: string;
};

/**
 * Frees the memory a photo's on-phone preview holds. Called by the screen that owns the entry, once
 * the entry is saved or abandoned; the capture itself frees a preview only when the photo is retaken.
 */
export function releaseCapturedPhoto(photo: CapturedPhoto | null | undefined) {
  if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
}

type Fix = { lat: number; lon: number; accuracyMeters: number | null; at: string };

type Shot = {
  blob: Blob;
  previewUrl: string;
  fix: Fix;
  address: string | null;
  zone: string | null;
  locationLabel: string;
  slot: PhotoSlot | null;
  deviceClock: string | null;
};

type Stage = "idle" | "starting" | "live" | "stamping" | "uploading" | "failed";

function canvasJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality));
}

async function jpegUnder(canvas: HTMLCanvasElement, maxBytes: number): Promise<Blob | null> {
  for (const quality of [0.86, 0.74, 0.6]) {
    const blob = await canvasJpeg(canvas, quality);
    if (blob && blob.size <= maxBytes) return blob;
  }
  return null;
}

/** The caption panel, drawn the way the direct-order and marketing captures draw theirs. */
function drawStamp(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, captions: string[]) {
  const fontSize = Math.max(16, Math.round(canvas.width * 0.022));
  const lineHeight = Math.round(fontSize * 1.38);
  const pad = Math.round(fontSize * 0.75);
  context.font = `${fontSize}px Arial, Helvetica, sans-serif`;
  // Wrapped, never cut: a long street address is the caption most worth reading.
  const lines = captions.flatMap((caption) => wrapWatermarkText(context, caption, canvas.width - pad * 2));
  const boxHeight = lines.length * lineHeight + pad * 2;
  context.fillStyle = "rgba(15,23,42,0.72)";
  context.fillRect(0, canvas.height - boxHeight, canvas.width, boxHeight);
  context.fillStyle = "#ffffff";
  lines.forEach((line, index) => {
    context.fillText(line, pad, canvas.height - boxHeight + pad + lineHeight * (index + 1) - Math.round(lineHeight * 0.28));
  });
}

function textField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function accuracyText(meters: number | null): string {
  return meters === null ? "accuracy unknown" : `within ${formatDistance(Math.round(meters))}`;
}

async function sendToSlot(slot: PhotoSlot, blob: Blob): Promise<void> {
  let response: Response;
  try {
    response = await fetch(slot.signedUrl, {
      body: blob,
      headers: { "content-type": "image/jpeg", "x-upsert": "false" },
      method: "PUT",
    });
  } catch {
    throw new Error("No connection. The photo is kept on this phone. Press Upload again when you have internet.");
  }
  if (response.ok) return;
  // An earlier try that arrived but whose answer was lost: the slot already holds this photo.
  const body = await response.text().catch(() => "");
  if (response.status === 409 || /already exists|duplicate/i.test(body)) return;
  throw new Error("The photo did not upload. Press Upload again.");
}

export function LivePhotoCapture({
  disabled = false,
  hint,
  onChange,
  purpose,
  seatId,
  test,
  title,
  value,
  weakGpsMeters,
}: {
  disabled?: boolean;
  hint?: ReactNode;
  onChange: (photo: CapturedPhoto | null) => void;
  purpose: "place" | "visit";
  seatId: string;
  test: boolean;
  /** The first line burned into the photo, e.g. "Phoenix CRM visit: Dr Ahmed Samir". */
  title: string;
  value: CapturedPhoto | null;
  weakGpsMeters: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const watchRef = useRef<number | null>(null);

  const [stage, setStage] = useState<Stage>("idle");
  const [cameraReady, setCameraReady] = useState(false);
  const [fix, setFix] = useState<Fix | null>(null);
  const [locationNote, setLocationNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (watchRef.current !== null && typeof navigator !== "undefined") navigator.geolocation?.clearWatch(watchRef.current);
    };
  }, []);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraReady(false);
  }

  function stopLocation() {
    if (watchRef.current !== null) navigator.geolocation?.clearWatch(watchRef.current);
    watchRef.current = null;
  }

  function startLocation(): boolean {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("This phone cannot give a location, so the photo cannot be taken here. Open Phoenix in Chrome or Safari.");
      return false;
    }
    stopLocation();
    setFix(null);
    setLocationNote("Finding your location");
    watchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const reading: Fix = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
          at: new Date(position.timestamp || Date.now()).toISOString(),
        };
        setLocationNote(null);
        setFix((current) => {
          if (!current || current.accuracyMeters === null) return reading;
          if (reading.accuracyMeters !== null && reading.accuracyMeters <= current.accuracyMeters) return reading;
          return Date.parse(reading.at) - Date.parse(current.at) > FIX_STALE_MS ? reading : current;
        });
      },
      (positionError) => {
        if (positionError.code === positionError.PERMISSION_DENIED) {
          stopLocation();
          stopCamera();
          setStage("idle");
          setLocationNote(null);
          setError("Location is blocked for Phoenix. Allow location for this site in the phone's settings, then press Start again.");
          return;
        }
        setLocationNote("Still finding your location. Stand outside or near a window");
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
    return true;
  }

  async function startCamera() {
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("No camera", "NotSupportedError");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, height: { ideal: 1080 }, width: { ideal: 1920 } },
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      setCameraReady(true);
      setStage("live");
    } catch (cameraError) {
      stopCamera();
      stopLocation();
      setStage("idle");
      setLocationNote(null);
      const name = cameraError instanceof DOMException ? cameraError.name : "";
      setError(
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "The camera is blocked for Phoenix. Allow the camera for this site in the phone's settings, then press Start again."
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "No camera was found on this phone."
            : name === "NotSupportedError"
              ? "This browser cannot open the camera. Open Phoenix in Chrome or Safari."
              : "The camera could not start. Close any other app using it, then press Start again.",
      );
    }
  }

  async function start() {
    setError(null);
    if (!startLocation()) return;
    setStage("starting");
    await startCamera();
  }

  function cancel() {
    stopCamera();
    stopLocation();
    setLocationNote(null);
    setStage("idle");
  }

  async function upload(current: Shot) {
    setStage("uploading");
    setError(null);
    let working = current;
    try {
      if (!working.slot) {
        const deviceClock = new Date().toISOString();
        const slot = await crmPost<PhotoSlot>("/api/phoenix-crm/photos/upload-slot", { purpose, seatId, test }, "slot");
        working = { ...working, deviceClock, slot };
        setShot(working);
      }
      await sendToSlot(working.slot as PhotoSlot, working.blob);
      setStage("idle");
      setShot(null);
      onChange({
        path: (working.slot as PhotoSlot).path,
        previewUrl: working.previewUrl,
        lat: working.fix.lat,
        lon: working.fix.lon,
        accuracyMeters: working.fix.accuracyMeters,
        deviceCapturedAt: working.deviceClock ?? new Date().toISOString(),
        address: working.address,
        zone: working.zone,
        locationLabel: working.locationLabel,
      });
    } catch (uploadError) {
      setStage("failed");
      setError(messageOf(uploadError));
    }
  }

  async function takePhoto() {
    const video = videoRef.current;
    if (!cameraReady || !video || video.videoWidth === 0) {
      setError("Wait until the camera shows the picture, then take the photo.");
      return;
    }
    if (!fix) {
      setError("Wait until your location is found, then take the photo.");
      return;
    }
    setError(null);
    const takenAt = new Date().toISOString();
    const usedFix = fix;
    const size = getCompressedEvidenceCanvasSize(video);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) {
      setError("This phone could not prepare the photo. Take it again.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    stopCamera();
    stopLocation();
    setStage("stamping");

    const payload = await fetchEvidenceLocation(LOCATION_ENDPOINT, usedFix.lat, usedFix.lon, usedFix.accuracyMeters);
    const stamp = readEvidenceLocationStamp(payload, usedFix.lat, usedFix.lon, usedFix.accuracyMeters);
    const detail = payload?.location && typeof payload.location === "object" ? (payload.location as Record<string, unknown>) : null;
    const components = detail?.components && typeof detail.components === "object" ? (detail.components as Record<string, unknown>) : null;

    drawStamp(
      context,
      canvas,
      buildEvidenceStampLines({ capturedAt: takenAt, locationCapturedAt: usedFix.at, locationLines: stamp.lines, title }),
    );
    const blob = await jpegUnder(canvas, MAX_UPLOAD_BYTES);
    if (!blob) {
      setStage("idle");
      setError("This phone could not save the photo. Press Start and take it again.");
      return;
    }
    if (shot) URL.revokeObjectURL(shot.previewUrl);
    const next: Shot = {
      blob,
      previewUrl: URL.createObjectURL(blob),
      fix: usedFix,
      address: textField(detail, "address"),
      zone: textField(components, "area"),
      locationLabel: stamp.label,
      slot: null,
      deviceClock: null,
    };
    setShot(next);
    await upload(next);
  }

  function retake() {
    if (value) URL.revokeObjectURL(value.previewUrl);
    if (shot) URL.revokeObjectURL(shot.previewUrl);
    setShot(null);
    onChange(null);
    void start();
  }

  const showVideo = !value && (stage === "starting" || stage === "live");
  const weak = Boolean(fix && fix.accuracyMeters !== null && fix.accuracyMeters > weakGpsMeters);
  const previewUrl = value?.previewUrl ?? shot?.previewUrl ?? null;

  return (
    <div className="grid min-w-0 gap-3">
      {hint && !value ? <p className="text-sm font-medium leading-6 text-slate-600">{hint}</p> : null}

      <div className={cn("relative min-w-0 overflow-hidden rounded-none border border-slate-200 bg-slate-950", showVideo ? "block" : "hidden")}>
        <video autoPlay className="block max-h-[62vh] w-full object-contain" muted playsInline ref={videoRef} />
        {!cameraReady ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm font-bold text-white/80">
            <LoaderCircle aria-hidden className="mr-2 h-4 w-4 animate-spin" />
            Opening the camera
          </div>
        ) : null}
      </div>

      {showVideo ? (
        <div className="grid gap-2">
          {fix ? (
            <p className={cn("flex min-w-0 items-start gap-2 text-sm font-bold", weak ? "text-amber-800" : "text-emerald-700")}>
              <LocateFixed aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">
                {weak
                  ? `Location is rough (${accuracyText(fix.accuracyMeters)}). Wait a few seconds for it to sharpen, or step outside.`
                  : `Location found (${accuracyText(fix.accuracyMeters)}).`}
              </span>
            </p>
          ) : (
            <p className="flex min-w-0 items-start gap-2 text-sm font-bold text-slate-600">
              <LoaderCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              <span className="min-w-0 break-words">{locationNote ?? "Finding your location"}</span>
            </p>
          )}
          {fix && locationNote ? <p className="text-xs font-semibold text-amber-800">{locationNote}</p> : null}
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <CrmButton disabled={disabled || !cameraReady || !fix} onClick={() => void takePhoto()} variant="primary">
              <Camera aria-hidden className="h-4 w-4" />
              Take the photo
            </CrmButton>
            <CrmButton aria-label="Close the camera" onClick={cancel} variant="secondary">
              <X aria-hidden className="h-4 w-4" />
            </CrmButton>
          </div>
        </div>
      ) : null}

      {!value && stage === "idle" ? (
        <CrmButton disabled={disabled} onClick={() => void start()} variant="primary">
          <Camera aria-hidden className="h-4 w-4" />
          Start camera and location
        </CrmButton>
      ) : null}

      {!value && (stage === "stamping" || stage === "uploading" || stage === "failed") ? (
        <div className="grid gap-2">
          {previewUrl ? (
            <span className="block w-full overflow-hidden rounded-none border border-slate-200 bg-slate-950">
              <ZoomablePhoto alt="The photo just taken" className="block max-h-[50vh] w-full object-contain" src={previewUrl} />
            </span>
          ) : null}
          {stage === "failed" ? (
            <div className="grid grid-cols-2 gap-2">
              <CrmButton disabled={disabled} onClick={() => shot && void upload(shot)} variant="primary">
                <UploadCloud aria-hidden className="h-4 w-4" />
                Upload again
              </CrmButton>
              <CrmButton disabled={disabled} onClick={retake} variant="secondary">
                <RotateCcw aria-hidden className="h-4 w-4" />
                Take it again
              </CrmButton>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm font-bold text-slate-600">
              <LoaderCircle aria-hidden className="h-4 w-4 animate-spin" />
              {stage === "stamping" ? "Adding the place and time to the photo" : "Uploading the photo"}
            </p>
          )}
        </div>
      ) : null}

      {value ? (
        <div className="grid gap-2">
          <span className="block w-full overflow-hidden rounded-none border border-slate-200 bg-slate-950">
            <ZoomablePhoto alt="The live photo" className="block max-h-[50vh] w-full object-contain" src={value.previewUrl} />
          </span>
          <p className="break-words text-xs font-semibold leading-5 text-slate-600">
            {value.locationLabel} · {accuracyText(value.accuracyMeters)}
          </p>
          <CrmButton disabled={disabled} onClick={retake} size="sm" variant="secondary">
            <RotateCcw aria-hidden className="h-4 w-4" />
            Take the photo again
          </CrmButton>
        </div>
      ) : null}

      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
    </div>
  );
}
